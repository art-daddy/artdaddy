// Does importing a very large file freeze the window?
//
// Reported by the owner: dragging a 1.75 GB video made the app go "Not Responding" for ~20s.
// The earlier heap measurement could not see this — it proved memory was not consumed, not
// that the UI thread stayed alive. Cause: probe_media_file was a SYNC #[tauri::command], and
// Tauri runs those on the MAIN thread, so SHA-256 over the file blocked the window.
//
// Measured with Windows' own definition of the symptom, IsHungAppWindow.
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

import { appBinary, appProcessName, newSession, root, sleep, startDriver, waitFor } from "./webdriver.mjs";

const BIG = path.join(process.env.USERPROFILE, "Downloads", "Screen-Recording (2).mp4");
const URL_MCP = "http://127.0.0.1:19787/mcp";
// A freeze long enough to show the OS "Not Responding" title is the bug; a couple of
// sampling blips while the window is created are not.
const MAX_HANG_SEC = 2;

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

if (!existsSync(BIG)) {
  console.log(`  FAIL fixture missing — ${BIG}`);
  process.exit(1);
}
const mb = (statSync(BIG).size / 1e6).toFixed(0);

const driver = await startDriver();
let s;
try {
  s = await newSession(appBinary());
  await waitFor(
    () => s.exec("return [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'File');"),
    { label: "the app to boot" },
  );
  await waitFor(async () => !!(await rpc("ping", {})), { label: "the MCP port" });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "hang", version: "1" } });
  await call("manage_project", { action: "create", name: `hang${Date.now().toString().slice(-5)}` });
  await sleep(1500); // let start-up settle so window creation is not counted as a hang

  // Watch the window while the import runs.
  const watchFile = path.join(process.env.TEMP, `artdaddy-hang-${Date.now()}.txt`);
  const watcher = spawn(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "e2e", "desktop", "hangWatch.ps1"),
      "-Process", appProcessName(), "-Seconds", "300", "-Out", watchFile],
    { encoding: "utf8" },
  );

  const t0 = Date.now();
  const r = await call("import_media", { source: { path: BIG } });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  check("the large file imported", r?.ok !== false, `${mb} MB in ${secs}s — ${r?.media_ref ?? r?.error}`);

  // Give the watcher a moment past the import, then stop it.
  await sleep(1500);
  watcher.kill("SIGTERM");
  await sleep(800);
  const line = existsSync(watchFile) ? readFileSync(watchFile, "utf8").trim() : "";
  console.log(`  info window watch: ${line}`);
  const longest = Number(/longestHangSec=([\d.]+)/.exec(line)?.[1] ?? "NaN");
  check("the window watcher produced a reading", Number.isFinite(longest), line);
  // THE ASSERTION: the window kept pumping messages while a 1.75 GB file was hashed.
  check(
    "the window never went Not Responding during the import",
    Number.isFinite(longest) && longest <= MAX_HANG_SEC,
    `longest hang ${longest}s (limit ${MAX_HANG_SEC}s)`,
  );

  console.log(failures.length ? `\n${failures.length} failure(s): ${failures.join(", ")}` : "\nall checks passed");
} finally {
  try {
    await s?.quit();
  } catch {
    /* gone */
  }
  driver.kill();
  await sleep(300);
}
process.exit(failures.length ? 1 : 0);
