// Is this staged file REALLY whisper?
//
// Two ways whisper-cli ships broken, and neither is visible from "the process started":
//   1. whisper.cpp's release zip ships DEPRECATION SHIMS beside the real binary — 27 KB
//      stubs that start fine, print "is deprecated", and exit 1. One was staged once;
//      transcription returned NOTHING for every user, indistinguishable from silent
//      footage.
//   2. The binary can't load its runtime libraries (Windows: STATUS_DLL_NOT_FOUND from a
//      missing ggml*.dll; macOS/Linux: a dylib/so that isn't on the machine).
//
// Lives in its own module because BOTH callers need the same verdict: fetch-sidecars.mjs
// after staging, and the macOS build workflow after compiling. Two copies of this check
// would drift, and the copy that drifts is the one that stops catching a shim.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Windows exit codes for "the loader could not find a DLL", signed and unsigned. */
const DLL_NOT_FOUND = [3221225781, -1073741515];

/**
 * @param {string} exe  path to the staged whisper-cli
 * @param {{ cwd?: string }} [opts]  cwd only matters for the dynamic Windows build,
 *   whose DLLs sit beside it; ignored when the directory does not exist.
 * @returns {{ ok: true, output: string } | { ok: false, reason: string, output: string }}
 */
export function checkWhisper(exe, opts = {}) {
  if (!existsSync(exe)) return { ok: false, reason: `not found: ${exe}`, output: "" };
  // Absolute: Windows will not spawn a relative path with forward slashes.
  const bin = resolve(exe);

  // spawnSync, not execSync: whisper prints its usage to STDERR and exits 0, and execSync
  // returns only stdout on success — which false-rejected a perfectly good binary once.
  // Judge stdout + stderr together, regardless of exit status.
  const cwd = opts.cwd && existsSync(opts.cwd) ? resolve(opts.cwd) : undefined;
  const res = spawnSync(bin, ["--help"], { cwd, timeout: 20000, encoding: "utf8" });
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;

  if (res.error) return { ok: false, reason: `could not run it: ${res.error.message}`, output };
  if (DLL_NOT_FOUND.includes(res.status)) {
    return { ok: false, reason: "it could not load its runtime libraries", output };
  }
  if (/is deprecated/i.test(output)) {
    return { ok: false, reason: "this is a whisper.cpp DEPRECATION SHIM, not whisper", output };
  }
  // The positive assertion is the point: a stub that says nothing must FAIL, so absence of
  // an error is not enough — the help text has to look like whisper's.
  if (!(/--model\b/.test(output) || /-m\s+FNAME/.test(output))) {
    return { ok: false, reason: "its --help output is not whisper's", output };
  }
  return { ok: true, output };
}

/** CLI: `node scripts/smoke-whisper.mjs <exe> [cwd]` — exits non-zero on a bad binary. */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const [exe, cwd] = process.argv.slice(2);
  if (!exe) {
    console.error("usage: node scripts/smoke-whisper.mjs <whisper-cli> [cwd]");
    process.exit(2);
  }
  const r = checkWhisper(exe, { cwd });
  if (!r.ok) {
    console.error(`[smoke-whisper] REJECTED ${exe}: ${r.reason}`);
    console.error(`  first line of output: ${r.output.trim().split(/\r?\n/)[0] || "(none)"}`);
    process.exit(1);
  }
  console.log(`[smoke-whisper] OK — ${exe} is real whisper and its libraries load.`);
}
