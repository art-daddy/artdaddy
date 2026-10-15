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
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Windows exit codes for "the loader could not find a DLL", signed and unsigned. */
const DLL_NOT_FOUND = [3221225781, -1073741515];

export function verifyWhisperUnicodeProof(exe, library, proofFile) {
  const proof = JSON.parse(readFileSync(proofFile, "utf8"));
  const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const names = ["ascii", "model", "audio", "output", "all"];
  if (proof.version !== 1 || proof.inputsUnchanged !== true ||
      !names.every((name) => proof.results?.some((test) => test.name === name && test.ok === true && test.jsonVerified === true && test.code === 0 && test.transcript)) ||
      proof.executableSha256 !== hash(exe) || proof.librarySha256 !== hash(library))
    throw new Error("whisper Unicode-path proof does not match the staged native artifact");
}

export function patchWhisperModelPaths(sourceDir) {
  const source = join(resolve(sourceDir), "src", "whisper.cpp");
  const text = readFileSync(source, "utf8");
  const old = "std::codecvt_utf8<wchar_t>";
  const fixed = "std::codecvt_utf8_utf16<wchar_t>";
  const count = text.split(old).length - 1;
  if (count === 0 && text.split(fixed).length - 1 === 2) return;
  if (count !== 2) throw new Error("pinned whisper model/VAD path conversions changed; refusing an unverified source patch");
  writeFileSync(source, text.replaceAll(old, fixed));
}

export function ensureWhisperUtf8(exe) {
  if (process.platform !== "win32") throw new Error("Windows whisper staging requires the Windows SDK manifest tool");
  const sdk = join(process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)", "Windows Kits", "10", "bin");
  const versions = existsSync(sdk)
    ? readdirSync(sdk, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    : [];
  const mt = versions.map((version) => join(sdk, version, "x64", "mt.exe")).find(existsSync);
  if (!mt) throw new Error("Windows SDK mt.exe is required to stage whisper with Unicode path support");
  const manifest = fileURLToPath(new URL("./whisper-utf8.manifest", import.meta.url));
  const bin = resolve(exe);
  const temp = mkdtempSync(join(tmpdir(), "whisper-manifest-"));
  const extracted = join(temp, "embedded.manifest");
  const run = (args) => {
    const result = spawnSync(mt, ["-nologo", ...args], { encoding: "utf8", timeout: 30000 });
    if (result.error || result.status !== 0)
      throw new Error(`whisper manifest staging failed: ${result.error?.message ?? ""} ${result.stdout ?? ""} ${result.stderr ?? ""}`);
  };
  try {
    run([`-inputresource:${bin};#1`, "-manifest", manifest, `-outputresource:${bin};#1`]);
    run([`-inputresource:${bin};#1`, `-out:${extracted}`]);
    const verify = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$xml = [xml](Get-Content -LiteralPath $env:WHISPER_MANIFEST_CHECK -Raw); " +
      "$nodes = $xml.SelectNodes(\"//*[local-name()='activeCodePage' and namespace-uri()='http://schemas.microsoft.com/SMI/2019/WindowsSettings']\"); " +
      "if ($nodes.Count -ne 1 -or $nodes[0].InnerText -ne 'UTF-8') { exit 1 }"],
      { env: { ...process.env, WHISPER_MANIFEST_CHECK: extracted }, encoding: "utf8", timeout: 30000 });
    if (verify.error || verify.status !== 0) throw new Error(`staged whisper did not retain its UTF-8 manifest: ${verify.stderr ?? ""}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

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
  const args = process.argv.slice(2);
  if (args[0] === "--patch-model-paths") {
    if (!args[1]) throw new Error("--patch-model-paths requires the pinned source directory");
    patchWhisperModelPaths(args[1]);
    process.exit(0);
  }
  const utf8 = args[0] === "--utf8";
  const [exe, cwd] = utf8 ? args.slice(1) : args;
  if (!exe) {
    console.error("usage: node scripts/smoke-whisper.mjs <whisper-cli> [cwd]");
    process.exit(2);
  }
  if (utf8) ensureWhisperUtf8(exe);
  const r = checkWhisper(exe, { cwd });
  if (!r.ok) {
    console.error(`[smoke-whisper] REJECTED ${exe}: ${r.reason}`);
    console.error(`  first line of output: ${r.output.trim().split(/\r?\n/)[0] || "(none)"}`);
    process.exit(1);
  }
  console.log(`[smoke-whisper] OK — ${exe} is real whisper and its libraries load.`);
}
