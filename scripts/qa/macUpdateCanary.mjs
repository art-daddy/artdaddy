// In-place update canary for macOS. Installs a PUBLIC release's .app on a disposable CI runner, starts it,
// and updates it through the LIVE updater manifest the way a user's app would be: the signed tarball is
// downloaded, verified against the key committed in tauri.conf.json and installed over the running bundle.
// It reads the public release and the public manifest only; nothing is published or changed.
//
// What differs from the Windows and Linux canaries, and why. Those call the app's own updater commands
// through the webview. WKWebView has no remote debugging port, tauri-driver has no macOS backend, and a
// signed-out app never mounts the update banner, so on macOS nothing outside the app can reach them. The
// updater half therefore runs as a Rust test (src-tauri/tests/update_canary.rs): the SAME updater plugin
// the app ships, at the locked version, with the endpoint and public key read from tauri.conf.json,
// pointed at the installed bundle. It is not the app's own command wrappers, and it does not restart the
// app: this script does what a restart would, by starting the bundle that is left.
//
// The proof is what is on disk and running afterwards, not what the updater says: every file of the
// installed bundle (path, SHA-256, mode, link target) equals the published tarball's, the bundle's
// signature verifies if the published one does, and the updated app starts and stays running.
//
// A window that exists is not a window that shows anything, so both apps are also looked at: a screen
// capture is kept. It is evidence only: a runner without screen-recording permission cannot take one.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describeTree, diffTrees, manifestOffer, parseCanaryOutput } from "../updateCanaryChecks.mjs";

if (process.platform !== "darwin" || process.arch !== "arm64" || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("The update canary runs only on a disposable GitHub-hosted Apple Silicon runner");
}

const REPOSITORY = process.env.GITHUB_REPOSITORY;
const FROM = process.env.FROM_VERSION;
const TEMP = process.env.RUNNER_TEMP;
const MANIFEST_URL = "https://artdaddy.app/updates/latest.json";
const PLATFORM = "darwin-aarch64";
const DMG = "ArtDaddy-macos-arm64.dmg";
const STAY_ALIVE_SECONDS = 20;
const OUT = path.resolve("reports/qa/updater-canary");
if (!REPOSITORY || !/^\d+\.\d+\.\d+$/.test(FROM ?? "") || !TEMP) {
  throw new Error("GITHUB_REPOSITORY, RUNNER_TEMP and FROM_VERSION (x.y.z) are required");
}
mkdirSync(OUT, { recursive: true });

// A request that never answers must fail the step, not hold the runner until its job timeout.
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) =>
  originalFetch(input, {
    ...init,
    signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(60_000)]),
  });

const evidence = { repository: REPOSITORY, from: FROM, startedAt: new Date().toISOString(), steps: [], passed: false };
const note = (name, data = {}) => {
  evidence.steps.push({ at: new Date().toISOString(), name, ...data });
  console.log(`[canary] ${name} ${Object.keys(data).length ? JSON.stringify(data) : ""}`);
};
const save = () => writeFileSync(path.join(OUT, "evidence.json"), JSON.stringify(evidence, null, 2));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}: ${(result.stderr || result.stdout || "").trim().slice(0, 2000)}`);
  }
  return result.stdout.trim();
}
const download = (url, file) => run("curl", ["-fsSL", "--retry", "3", "--retry-delay", "5", "-o", file, url]);
const plist = (app, key) => run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, path.join(app, "Contents/Info.plist")]);
const only = (dir, suffix) => {
  const found = readdirSync(dir).filter((name) => name.endsWith(suffix));
  if (found.length !== 1) throw new Error(`expected exactly one ${suffix} in ${dir}, found ${JSON.stringify(readdirSync(dir))}`);
  return path.join(dir, found[0]);
};

const started = [];
/** Start the bundle's executable the way the release workflow's "Launch it" step does. */
function launch(executable, label) {
  const out = openSync(path.join(OUT, `${label}.out`), "w");
  const err = openSync(path.join(OUT, `${label}.err`), "w");
  const child = spawn(executable, [], { stdio: ["ignore", out, err], detached: true });
  closeSync(out);
  closeSync(err);
  child.unref();
  started.push(child);
  return child;
}
const exited = (child) => child.exitCode !== null || child.signalCode !== null;

async function stayAlive(child, seconds) {
  for (let second = 1; second <= seconds; second++) {
    await sleep(1000);
    if (exited(child)) return { alive: false, afterSeconds: second, exitCode: child.exitCode, signal: child.signalCode };
  }
  return { alive: true, afterSeconds: seconds };
}

async function stop(child) {
  if (!child || exited(child)) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 10 && !exited(child); i++) await sleep(500);
  if (!exited(child)) child.kill("SIGKILL");
}

/** The command line macOS reports for a pid: which executable is really running. */
const commandOf = (pid) => spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();

function screenshot(file) {
  const shot = spawnSync("screencapture", ["-x", path.join(OUT, file)], { encoding: "utf8" });
  return shot.status === 0;
}

const work = path.join(TEMP, "mac-canary");
const mount = path.join(work, "mount");

async function main() {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(mount, { recursive: true });
  const applications = path.join(work, "Applications");
  mkdirSync(applications);

  // 1. What the live manifest offers, and that it is something an app of this version could take.
  const manifest = await (await fetch(MANIFEST_URL, { headers: { "cache-control": "no-cache" } })).json();
  const offer = manifestOffer(manifest, PLATFORM, FROM, REPOSITORY);
  note("live manifest", { version: offer.version, url: offer.url, problems: offer.problems });
  if (!offer.ok) throw new Error(`the live manifest is not an offer to ${FROM}: ${offer.problems.join("; ")}`);

  // 2. Install the previous release as a user does: the dmg's app copied to a folder the user owns.
  const dmgFile = path.join(work, DMG);
  download(`https://github.com/${REPOSITORY}/releases/download/v${FROM}/${DMG}`, dmgFile);
  note("downloaded the previous release", { version: FROM, bytes: statSync(dmgFile).size });
  let installedApp;
  run("hdiutil", ["attach", dmgFile, "-mountpoint", mount, "-nobrowse", "-readonly", "-quiet"]);
  try {
    const source = only(mount, ".app");
    installedApp = path.join(applications, path.basename(source));
    run("ditto", [source, installedApp]);
  } finally {
    spawnSync("hdiutil", ["detach", mount, "-quiet"]);
  }
  const executable = path.join(installedApp, "Contents/MacOS", plist(installedApp, "CFBundleExecutable"));
  const before = plist(installedApp, "CFBundleShortVersionString");
  note("installed", { app: installedApp, executable, version: before });
  if (before !== FROM) throw new Error(`the v${FROM} dmg holds an app that says it is ${before}`);

  // 3. Run it. The update is applied while it runs, as it would be for a user.
  const old = launch(executable, "previous-release");
  const oldRun = await stayAlive(old, STAY_ALIVE_SECONDS);
  note("the previous release is running", { ...oldRun, pid: old.pid, screenshot: oldRun.alive && screenshot("previous-release.png") });

  // 4. The updater: check, download, verify, install, with the real plugin against that bundle.
  const harness = spawnSync(
    "cargo",
    ["test", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--test", "update_canary", "--", "--ignored", "--nocapture"],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
      env: { ...process.env, ARTDADDY_CANARY_EXECUTABLE: executable, ARTDADDY_CANARY_FROM: FROM },
    },
  );
  const harnessText = `${harness.stdout ?? ""}\n${harness.stderr ?? ""}`;
  writeFileSync(path.join(OUT, "updater-harness.log"), harnessText);
  const result = parseCanaryOutput(harnessText);
  note("the updater harness", { exit: harness.status, ...result });
  if (harness.status !== 0 || !result.installed) throw new Error("the updater did not install the update: see updater-harness.log");
  if (result.offered?.version !== offer.version) throw new Error(`the updater was offered ${result.offered?.version}, the manifest says ${offer.version}`);
  if (!(result.downloadedBytes > 0)) throw new Error("the updater downloaded nothing");

  // 5. What the old process did when its bundle was replaced under it: evidence, then it is stopped.
  note("the previous release's process after its bundle was replaced", { stillRunning: !exited(old) });
  await stop(old);

  // 6. What is on disk. First the version and signature of the bundle that is left.
  const after = plist(installedApp, "CFBundleShortVersionString");
  note("installed bundle after the update", { version: after });
  if (after !== offer.version) throw new Error(`the bundle still says ${after} after an update to ${offer.version}`);

  // 7. Then the bundle against the published tarball, which is verified here as the app would verify it.
  const tarball = path.join(work, "published.app.tar.gz");
  const signature = path.join(work, "published.app.tar.gz.sig");
  download(offer.url, tarball);
  writeFileSync(signature, offer.signature);
  note("published tarball signature", { output: run("node", ["scripts/verify-release-signature.mjs", tarball, signature]).split("\n").map((l) => l.trim()) });
  const published = path.join(work, "published");
  mkdirSync(published);
  run("tar", ["-xzf", tarball, "-C", published]);
  const publishedApp = only(published, ".app");
  const [publishedTree, installedTree] = [await describeTree(publishedApp), await describeTree(installedApp)];
  const differences = diffTrees(publishedTree, installedTree);
  note("installed bundle against the published tarball", { entries: installedTree.size, differences });
  if (differences.length) throw new Error(`the installed bundle is not the published one: ${differences.slice(0, 5).join("; ")}`);

  // 8. A bundle that is byte-identical can still be refused by macOS: Apple Silicon kills a binary whose
  // signature does not verify. The published one is the reference, so the update is only blamed when it
  // made a valid bundle invalid.
  const verify = (app) => spawnSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { encoding: "utf8" });
  const [installedSignature, publishedSignature] = [verify(installedApp), verify(publishedApp)];
  note("codesign --verify", {
    installed: installedSignature.status === 0,
    published: publishedSignature.status === 0,
    detail: (installedSignature.stderr || "").trim().split("\n").slice(-3),
  });
  if (installedSignature.status !== 0 && publishedSignature.status === 0) throw new Error("the update left a bundle whose signature no longer verifies");

  // 9. The updated app starts and stays up: the restart the app itself would have done.
  const fresh = launch(executable, "updated");
  const freshRun = await stayAlive(fresh, STAY_ALIVE_SECONDS);
  const command = freshRun.alive ? commandOf(fresh.pid) : "";
  note("the updated app is running", { ...freshRun, pid: fresh.pid, command, screenshot: freshRun.alive && screenshot("updated.png") });
  if (!freshRun.alive) throw new Error(`the updated app exited after ${freshRun.afterSeconds}s (${freshRun.signal ?? `exit ${freshRun.exitCode}`}): see updated.err`);
  if (!command.includes(installedApp)) throw new Error(`the running process is not the installed bundle: ${command}`);
  await stop(fresh);

  evidence.passed = true;
  note("PASSED", { from: FROM, to: offer.version });
}

try {
  await main();
} catch (error) {
  note("FAILED", { error: String(error?.message ?? error) });
  process.exitCode = 1;
} finally {
  for (const child of started) await stop(child);
  spawnSync("hdiutil", ["detach", mount, "-quiet", "-force"]);
  evidence.finishedAt = new Date().toISOString();
  save();
}
