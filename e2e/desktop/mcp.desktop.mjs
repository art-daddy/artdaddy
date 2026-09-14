// A REAL MCP client, over HTTP, against the running desktop app.
//
// Everything else about this feature can pass while an external agent still cannot connect: the
// unit tests never open a socket, and the Rust tests never cross the bridge into the webview.
// This speaks the actual protocol to 127.0.0.1 the way Claude Code and Cursor do — initialize,
// tools/list, tools/call — and then checks the PERSISTED project document, so "the call returned
// 200" cannot be mistaken for "the edit happened".
//
// PREREQUISITES: as drag.desktop.mjs (tauri-driver, msedgedriver, a built app + `npm run dev`).
//
//   node e2e/desktop/mcp.desktop.mjs
import { mkdirSync, copyFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";

import {
  appBinary,
  newSession,
  root,
  projectsRoot,
  sleep,
  startDriver,
  waitFor,
} from "./webdriver.mjs";

const NAME = `mcpspec${Date.now().toString().slice(-6)}`;
const MEDIA_DIR = path.join(root, "..", "_artdaddy-mcp-media");
const MEDIA = path.join(MEDIA_DIR, "mcp-clip.mp4");
const PROJECTS = projectsRoot();
const ENDPOINT = "http://127.0.0.1:19787/mcp";
// The name the app announces over MCP is the crate name (src-tauri/src/mcp.rs SERVER_NAME).
const SERVER_NAME = JSON.parse(
  readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
).productName;

const failures = [];
function check(label, cond, detail) {
  if (cond) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    failures.push(label);
  }
}

let rpcId = 0;
async function rpc(method, params, extraHeaders = {}) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function projectDir() {
  const hit = readdirSync(PROJECTS).filter((d) => d.startsWith(NAME));
  if (hit.length !== 1) throw new Error(`expected 1 project dir for ${NAME}, saw ${hit.length}`);
  return path.join(PROJECTS, hit[0]);
}
const timeline = () =>
  JSON.parse(readFileSync(path.join(projectDir(), "internals", "timeline.json"), "utf8"));
const clipsOf = (t) =>
  (t.tracks ?? []).flatMap((tr) => (tr.clips ?? []).map((c) => ({ ...c, track: tr.id })));

mkdirSync(MEDIA_DIR, { recursive: true });
copyFileSync(path.join(root, "public", "test-clip.mp4"), MEDIA);

// ATTACH mode: drive an app that is ALREADY running. The driver stack (tauri-driver + msedge-
// driver) is Windows-only, but the protocol below is plain HTTP on loopback.
const ATTACH = process.env.ARTDADDY_MCP_ATTACH === "1" || process.platform !== "win32";

const driver = ATTACH ? null : await startDriver();
let s;
try {
  if (!ATTACH) {
    s = await newSession(appBinary());
    await waitFor(
      () =>
        s.exec(
          "return [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'File');",
        ),
      { label: "the app to boot" },
    );
  }
  // The server starts with the app; give the bridge a moment to attach.
  await waitFor(async () => (await rpc("ping", {}).catch(() => null))?.status === 200, {
    label: "the MCP server to accept connections",
  });

  // --- handshake ---
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "artdaddy-e2e", version: "1.0.0" },
  });
  check(
    "initialize succeeds",
    init.status === 200 && !!init.body?.result,
    JSON.stringify(init.body).slice(0, 200),
  );
  check(
    "it advertises the tools capability",
    !!init.body?.result?.capabilities?.tools,
    JSON.stringify(init.body?.result?.capabilities),
  );
  check(
    `it identifies itself as ${SERVER_NAME}`,
    init.body?.result?.serverInfo?.name === SERVER_NAME,
    init.body?.result?.serverInfo?.name,
  );

  // --- discovery: the list must come from the contract, with usable descriptions ---
  const list = await rpc("tools/list", {});
  const tools = list.body?.result?.tools ?? [];
  console.log(`  info ${tools.length} tools advertised`);
  check("tools/list returns the catalog", tools.length > 20, `${tools.length} tools`);
  check(
    "manage_project is present",
    tools.some((t) => t.name === "manage_project"),
  );
  check(
    "timeline tools are present",
    tools.some((t) => t.name === "add_clips"),
  );
  const undescribed = tools
    .filter((t) => !t.description || !t.description.length)
    .map((t) => t.name);
  check(
    "every tool carries a description",
    undescribed.length === 0,
    undescribed.slice(0, 5).join(", "),
  );
  const badSchema = tools.filter((t) => t.inputSchema?.type !== "object").map((t) => t.name);
  check(
    "every tool exposes an object inputSchema",
    badSchema.length === 0,
    badSchema.slice(0, 5).join(", "),
  );

  // --- a session that starts with nothing open must be able to say so and recover ---
  const current = await rpc("tools/call", {
    name: "manage_project",
    arguments: { action: "current" },
  });
  console.log(
    `  info current: ${JSON.stringify(current.body?.result?.content?.[0]?.text ?? "").slice(0, 120)}`,
  );
  check(
    "manage_project current answers",
    !!current.body?.result,
    JSON.stringify(current.body).slice(0, 200),
  );

  const created = await rpc("tools/call", {
    name: "manage_project",
    arguments: { action: "create", name: NAME, aspect: "16:9", fps: 30 },
  });
  check(
    "an external agent can create a project",
    created.body?.result?.isError !== true,
    JSON.stringify(created.body?.result).slice(0, 200),
  );
  await sleep(3000);
  check("the project exists on disk", existsSync(projectDir()));

  // --- the real thing: import + place, asserted against the persisted document ---
  const imported = await rpc("tools/call", {
    name: "import_media",
    arguments: { source: { path: MEDIA } },
  });
  const importText = imported.body?.result?.content?.[0]?.text ?? "";
  console.log(`  info import: ${importText.slice(0, 160)}`);
  check(
    "import_media runs through the bridge",
    imported.body?.result?.isError !== true,
    importText.slice(0, 200),
  );

  const mediaRef = (importText.match(/media_[0-9a-f]{12}/) ?? [])[0];
  check("the import returned a media ref", !!mediaRef, importText.slice(0, 200));

  if (mediaRef) {
    const before = clipsOf(timeline()).length;
    const added = await rpc("tools/call", {
      name: "add_clips",
      arguments: { entries: [{ media_ref: mediaRef, track_id: "v1", timeline_in: 0 }] },
    });
    const addText = added.body?.result?.content?.[0]?.text ?? "";
    console.log(`  info add_clips: ${addText.slice(0, 200)}`);
    await sleep(2500);
    const after = clipsOf(timeline());
    check(
      "the clip an external agent added is in the PERSISTED timeline",
      after.length === before + 1,
      `${after.length} vs ${before}: ${addText.slice(0, 200)}`,
    );
  }

  // --- failure directions ---
  const unknown = await rpc("tools/call", { name: "no_such_tool_at_all", arguments: {} });
  check(
    "an unknown tool is reported as an error, not a success",
    unknown.body?.result?.isError === true,
    JSON.stringify(unknown.body?.result).slice(0, 200),
  );

  const badMethod = await rpc("this/does/not/exist", {});
  check(
    "an unknown JSON-RPC method returns an error object",
    !!badMethod.body?.error,
    JSON.stringify(badMethod.body).slice(0, 200),
  );

  // A browser can reach 127.0.0.1; only the Origin check stops a web page driving the editor.
  const evil = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example.com" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 999, method: "tools/list", params: {} }),
  });
  check("a non-loopback Origin is refused", evil.status === 403, `HTTP ${evil.status}`);

  const spoof = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1.evil.example.com" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 998, method: "tools/list", params: {} }),
  });
  check("a look-alike loopback Origin is refused", spoof.status === 403, `HTTP ${spoof.status}`);
} catch (e) {
  console.error("ERROR:", e.message);
  failures.push(e.message);
} finally {
  await s?.quit();
  driver?.kill();
  await sleep(600);
  try {
    rmSync(projectDir(), { recursive: true, force: true });
  } catch {
    /* may never have been created */
  }
  rmSync(MEDIA_DIR, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s): ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nall checks passed");
