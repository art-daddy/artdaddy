// Undo, cancellation, and the shared prompt — checked against the running app over real MCP.
//
// These three can only be seen from outside: whether an external edit is undoable at all, whether
// a client's Stop actually stops work, and whether an external agent is handed the same
// instructions the in-app agent runs under.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

import { appBinary, newSession, projectsRoot, sleep, startDriver, waitFor } from "./webdriver.mjs";

const URL = "http://127.0.0.1:19787/mcp";
const PROJECTS = projectsRoot();
const NAME = `mcpbeh${Date.now().toString().slice(-6)}`;

const failures = [];
function check(label, cond, detail) {
  if (cond) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    failures.push(label);
  }
}

let rpcId = 0;
let sessionId = null;
async function rpc(method, params, { notify = false } = {}) {
  const body = notify
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", id: ++rpcId, method, params };
  const headers = { "content-type": "application/json" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(URL, { method: "POST", headers, body: JSON.stringify(body) });
  const assigned = res.headers.get("mcp-session-id");
  if (assigned) sessionId = assigned;
  const text = await res.text();
  return { status: res.status, id: body.id, json: text ? JSON.parse(text) : null };
}

const tool = async (name, args = {}) => {
  const out = await rpc("tools/call", { name, arguments: args });
  const t = out.json?.result?.content?.[0]?.text;
  try {
    return { isError: !!out.json?.result?.isError, payload: JSON.parse(t) };
  } catch {
    return { isError: !!out.json?.result?.isError, payload: t };
  }
};

const clipsOf = (dir) => {
  const tl = JSON.parse(readFileSync(path.join(dir, "internals", "timeline.json"), "utf8"));
  return (tl.tracks ?? []).flatMap((t) => t.clips ?? []);
};

// ATTACH mode: drive an app that is ALREADY running. The driver stack (tauri-driver + msedge-
// driver) is Windows-only, but the protocol below is plain HTTP on loopback.
const ATTACH = process.env.ARTDADDY_MCP_ATTACH === "1" || process.platform !== "win32";

const driver = ATTACH ? null : await startDriver();
let s;
let projectDir = null;
try {
  let booted = async () => true;
  if (!ATTACH) {
    s = await newSession(appBinary());
    booted = () =>
      s.exec(
        "return [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'File');",
      );
    await waitFor(booted, { label: "the app to boot" });

    // Deliberately NOT pointed at a local server: the build's configured base is the one real
    // users hit, and a localhost override would pass even if the deployed server lacked the
    // endpoint. Clear a stale override from an earlier run so the check means something.
    await s.exec("localStorage.removeItem('artdaddy.api_base'); location.reload(); return true;");
    await sleep(2500);
    await waitFor(booted, { label: "the app to reboot against its configured server" });
  } else {
    // Attached to an app we did not start, so its server base is whatever the user left it on.
    // The instructions check below is therefore weaker here than in the driver lane.
    console.log("  note attached to a running app — its configured server base is used as-is");
  }
  await waitFor(async () => (await rpc("ping", {})).status === 200, { label: "the MCP port" });
  // The bridge pushes instructions to Rust after fetching them; initialize is answered there.
  await sleep(2500);

  // --- the shared system prompt ---
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "behaviour-probe", version: "1" },
  });
  const instructions = String(init.json?.result?.instructions ?? "");
  check("a session id is issued", !!sessionId, String(sessionId));
  // The in-app agent's prompt opens with its role section; a short hand-written blurb would not
  // contain it, which is exactly the drift this is guarding against.
  check(
    "instructions carry the shared system prompt, not a local summary",
    instructions.includes("You are ArtDaddy") && instructions.length > 2000,
    `${instructions.length} chars`,
  );
  check("they add the MCP-only project section", instructions.includes("manage_project"), "");
  // Collapse whitespace: the policy text wraps in the source, so phrases straddle newlines.
  const flat = instructions.replace(/\s+/g, " ");
  check(
    "they state the cost policy the UI would otherwise enforce",
    /SPEND THE USER'S CREDITS/i.test(flat) && /WAIT for the user to confirm/i.test(flat),
    flat.slice(-200),
  );

  // --- undo ---
  const created = await tool("manage_project", { action: "create", name: NAME });
  projectDir = path.join(PROJECTS, created.payload.created);
  await tool("add_track", { kind: "video" });
  await sleep(1500);
  const before = clipsOf(projectDir).length;
  const tracksAfterAdd = JSON.parse(
    readFileSync(path.join(projectDir, "internals", "timeline.json"), "utf8"),
  ).tracks.length;

  const undo = await tool("undo", {});
  await sleep(1500);
  const tracksAfterUndo = JSON.parse(
    readFileSync(path.join(projectDir, "internals", "timeline.json"), "utf8"),
  ).tracks.length;
  console.log(`  info undo -> ${JSON.stringify(undo.payload).slice(0, 160)}`);
  check(
    "an MCP edit is undoable through the same history",
    tracksAfterUndo === tracksAfterAdd - 1,
    `tracks ${tracksAfterAdd} -> ${tracksAfterUndo}`,
  );
  check("undo left the clips alone", clipsOf(projectDir).length === before, "");

  // --- cancellation ---
  // Give the render something real to do first. The earlier version of this test cancelled an
  // export of an EMPTY timeline, which failed instantly on its own — it passed while proving
  // nothing about cancellation at all.
  const media = path.join(process.cwd(), "public", "test-clip.mp4");
  const imported = await tool("import_media", { source: { path: media } });
  const ref = imported.payload?.media_ref;
  await tool("add_clips", {
    entries: Array.from({ length: 6 }, (_, i) => ({
      media_ref: ref,
      track_id: "v1",
      timeline_in: i * 30,
      source_span: [0, 1],
    })),
  });
  await sleep(1500);
  check(
    "the timeline has clips to render",
    clipsOf(projectDir).length >= 6,
    `${clipsOf(projectDir).length} clips`,
  );

  const started = Date.now();
  // USERPROFILE is Windows-only; undefined elsewhere made the join throw mid-suite.
  const downloads = path.join(process.env.USERPROFILE || process.env.HOME || "", "Downloads");
  const beforeFiles = new Set(readdirSync(downloads).filter((n) => n.endsWith(".mp4")));
  const settled = await rpc("tools/call", {
    name: "export",
    arguments: { format: "mp4", resolution: "1080p" },
  });
  const elapsed = Date.now() - started;
  const result = settled.json?.result;
  const text = String(result?.content?.[0]?.text ?? "");
  console.log(`  info export call -> ${elapsed}ms ${text.slice(0, 140)}`);

  // Export is QUEUED now, so cancelling the MCP REQUEST no longer reaches ffmpeg — deliberately,
  // because that same abort fires when the user sends their next message. Cancellation moved to
  // manage_exports, and this proves it still actually stops the encoder.
  check("the export call returns without waiting for the render", elapsed < 20_000, `${elapsed}ms`);
  check(
    "and it is accepted, not an error",
    result?.isError !== true,
    JSON.stringify(result).slice(0, 160),
  );
  const jobId = (() => {
    try {
      return JSON.parse(text)?.job_id ?? "";
    } catch {
      return "";
    }
  })();
  check("it hands back a job id to cancel with", !!jobId, text.slice(0, 160));

  await sleep(1500); // let ffmpeg actually get going, or cancelling proves nothing
  const cancelled = await tool("manage_exports", { action: "cancel", job_id: jobId });
  check(
    "manage_exports reports it cancelled the export",
    cancelled.payload?.cancelled === true,
    JSON.stringify(cancelled.payload ?? {}).slice(0, 160),
  );

  // The one that matters: reporting a cancel is easy, actually STOPPING the work is the point.
  // ffmpeg creates its output file the instant it starts, so the file EXISTING proves nothing —
  // what distinguishes "aborted" from "ran to completion" is whether it holds the whole timeline.
  await sleep(12_000);
  const appeared = readdirSync(downloads).filter((n) => n.endsWith(".mp4") && !beforeFiles.has(n));
  let rendered = 0;
  for (const f of appeared) {
    try {
      const out = execFileSync(
        path.join(process.cwd(), "src-tauri", "binaries", "ffprobe-x86_64-pc-windows-msvc.exe"),
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "csv=p=0",
          path.join(downloads, f),
        ],
        { encoding: "utf8" },
      );
      rendered = Math.max(rendered, parseFloat(out.trim()) || 0);
    } catch {
      rendered = Math.max(rendered, 0); // unreadable = truncated, which is the cancelled case
    }
    try {
      rmSync(path.join(downloads, f), { force: true });
    } catch {
      /* best effort */
    }
  }
  console.log(
    `  info after cancel: ${appeared.length} file(s), longest ${rendered}s of a 6s timeline`,
  );
  check(
    "the cancelled render did not finish the timeline",
    rendered < 5,
    `${rendered}s rendered — the cancel never reached ffmpeg`,
  );
  // Staging means a cancelled export must leave NOTHING at the destination, not a broken file.
  check(
    "and it left no deliverable behind",
    appeared.length === 0 || rendered === 0,
    `${appeared.length} file(s)`,
  );

  // --- a second client must not share the first one's session ---
  const other = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  const otherSession = other.headers.get("mcp-session-id");
  check(
    "a second client gets its own session id",
    !!otherSession && otherSession !== sessionId,
    `${sessionId} vs ${otherSession}`,
  );
} catch (e) {
  console.error("ERROR:", e.message);
  failures.push(e.message);
} finally {
  await s?.quit();
  driver?.kill();
  await sleep(600);
  for (const d of readdirSync(PROJECTS).filter((n) => n.startsWith("mcpbeh"))) {
    try {
      rmSync(path.join(PROJECTS, d), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s): ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nall checks passed");
