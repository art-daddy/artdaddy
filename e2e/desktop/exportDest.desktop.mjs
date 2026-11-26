// Export destination, in the REAL app. The Save As dialog itself cannot be scripted (it is a
// native OS window), so the mocked component test proves only the wiring. This proves the part
// that actually writes: the path the menu would hand the tool is the path ffmpeg writes to,
// outside the app's fs scope, and a bad one is refused rather than silently redirected.
//
// Timed (e2e/lib/timing.mjs): "export: 1 s timeline to a finished mp4 (dev build)", from asking for the export to the
// finished file at the chosen path. The destination is written only once the render has succeeded (a rename), so the
// file's arrival is the end of the user's wait. A question the app asks first (the export looks slow, space or memory)
// is answered "Continue" at once, as a person going ahead would, so the time is the app's and not a reader's.
//
// It works in its own throwaway project (sweep_expdest<n>) and deletes it after, and it refuses to start while another
// app holds the MCP port: its calls would reach that app's projects instead.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { startTimer } from "../lib/timing.mjs";
import {
  MCP_PORT,
  appBinary,
  mcpPortTaken,
  newSession,
  projectsRoot,
  sleep,
  startDriver,
  waitFor,
  waitInApp,
} from "./webdriver.mjs";

const STAMP = Date.now().toString().slice(-5);
const NAME = `sweep_expdest${STAMP}`;
// New file names on every run. An app closed moments after an export lands can leave that destination "reserved" on
// the next launch ("export destination is already reserved"), which is not what this lane checks.
const DEST_NAME = `hero cut ${STAMP}.mp4`;
const WORK = path.join(process.env.USERPROFILE, "_artdaddy-export-dest");
const URL_MCP = `http://127.0.0.1:${MCP_PORT}/mcp`;
const failures = [];
const check = (label, cond, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures.push(label);
};

let rpcId = 0;
let sessionId = null;
async function rpc(method, params) {
  const headers = { "content-type": "application/json" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(URL_MCP, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const a = res.headers.get("mcp-session-id");
  if (a) sessionId = a;
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}
async function call(name, args = {}) {
  const out = await rpc("tools/call", { name, arguments: args });
  const b = out?.result?.content?.[0]?.text ?? "";
  try {
    return JSON.parse(b);
  } catch {
    return b;
  }
}

// The export tool returns as soon as the render is QUEUED, so the deliverable appears later. Polled every 100 ms: the
// arrival ends a timed wait, and a coarser poll would add up to its whole interval to the time.
async function waitForFile(p, ms = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (existsSync(p) && statSync(p).size > 0) return true;
    await sleep(100);
  }
  return false;
}

// A refusal must write NOTHING — and "not yet" looks identical to "never" at the instant the
// call returns, so give a queued render time to betray itself before believing it.
async function stayedAbsent(p, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (existsSync(p)) return false;
    await sleep(250);
  }
  return true;
}

// An export the app thinks slow, long or short of space asks the person in the window first ("This export will take
// a while"), and the MCP reply waits for that answer: press Continue, as the person would, until the reply comes.
async function exportAnswering(args) {
  const reply = call("export", args);
  let answered = false;
  reply.then(
    () => (answered = true),
    () => (answered = true),
  );
  while (!answered) {
    await s
      .exec(
        "const d = document.querySelector('[role=dialog]'); const b = d && [...d.querySelectorAll('button')].find((e) => e.textContent.trim() === 'Continue'); if (b) b.click(); return !!b;",
      )
      .catch(() => false);
    await sleep(100);
  }
  return reply;
}

if (await mcpPortTaken()) {
  console.error(
    `MCP port ${MCP_PORT} is already taken: another ArtDaddy is running. This lane drives only the app it starts; ` +
      "close the other one and run it again.",
  );
  process.exit(1);
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const driver = await startDriver();
let s;
try {
  s = await newSession(appBinary());
  await waitInApp(s, "return [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'File');", {
    label: "the app to boot",
  });
  await waitFor(async () => !!(await rpc("ping", {})), { label: "the MCP port" });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "expdest", version: "1" } });

  await call("manage_project", { action: "create", name: NAME });
  const media = await call("import_media", { source: { path: path.join(process.cwd(), "public", "test-clip.mp4") } });
  await call("add_clips", { entries: [{ media_ref: media.media_ref, timeline_in: 0, timeline_out: 30 }] });

  const dest = path.join(WORK, DEST_NAME);
  const exportWait = startTimer("export: 1 s timeline to a finished mp4 (dev build)");
  const r = await exportAnswering({ output_path: dest });
  check("the export was accepted", r?.ok === true, r?.error ?? "");
  // The OUTCOME: a real mp4 where we asked, not in Downloads.
  const landed = await waitForFile(dest);
  // Only an export that delivered its file is a measured wait; a refused or lost one records nothing.
  if (r?.ok === true && landed) exportWait.stop();
  check("the file is at the chosen path", landed, dest);
  check("it has real bytes", landed && statSync(dest).size > 10_000, landed ? `${statSync(dest).size} B` : "missing");
  check("only the filename is reported back", r?.saved_to === DEST_NAME, String(r?.saved_to));
  // The Downloads note is a lie once a destination was chosen. (Other notes, such as the end card's length, are fine.)
  check("no 'saved to Downloads' note", !/download/i.test(r?.note ?? ""), String(r?.note));

  const bad = await call("export", { output_path: "relative/out.mp4" });
  check("a relative destination is refused", bad?.ok === false && /absolute/i.test(bad?.error ?? ""), bad?.error ?? "");
  const wrongExt = await call("export", { output_path: path.join(WORK, "out.mov") });
  check("a non-mp4 extension is refused", wrongExt?.ok === false, wrongExt?.error ?? "");
  check("the refusal wrote nothing", await stayedAbsent(path.join(WORK, "out.mov")));

  // OUTSIDE the Tauri fs scope ($DATA/ArtDaddy, $DOWNLOAD, $HOME/**). ffmpeg is a sidecar and
  // writes here fine, but store.exists() THROWS on the scope violation — which the old code
  // read as "the file is missing" and reported as a failed render for a video that is
  // sitting right where the user asked. WORK above is under $HOME, so it cannot see this.
  const OUT = "C:\\ProgramData\\ArtDaddyExportScopeTest";
  rmSync(OUT, { recursive: true, force: true });
  try {
    mkdirSync(OUT, { recursive: true });
    const far = path.join(OUT, `outside scope ${STAMP}.mp4`);
    const r2 = await exportAnswering({ output_path: far });
    check("an export outside the fs scope reports success", r2?.ok === true, r2?.error ?? "");
    const there = await waitForFile(far);
    check("and the file really is there", there, there ? `${statSync(far).size} B` : "missing");
    rmSync(OUT, { recursive: true, force: true });
  } catch (e) {
    console.log(`  info skipped the out-of-scope check — ${OUT} is not writable (${e.message})`);
  }

  console.log(failures.length ? `\n${failures.length} failure(s): ${failures.join(", ")}` : "\nall checks passed");
} finally {
  try {
    await s?.quit();
  } catch {
    /* gone */
  }
  driver.kill();
  await sleep(300);
  try {
    for (const dir of readdirSync(projectsRoot()).filter((d) => d.startsWith(NAME))) {
      // The app may still be letting go of its files for a moment after it closes.
      rmSync(path.join(projectsRoot(), dir), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  } catch (e) {
    console.log(`  info could not remove the project ${NAME} (${e.message})`);
  }
  rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
process.exit(failures.length ? 1 : 0);
