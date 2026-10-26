// In-place update canary for Linux. Installs a PUBLIC release's AppImage on a disposable CI runner and
// lets the app update itself through the LIVE updater manifest, the way a user's app does: the app checks,
// downloads and verifies the signed AppImage, replaces the file it was started from, and relaunches it.
// It reads the public release and the public manifest only; nothing is published or changed.
//
// The updater commands (check_for_update, download_update, install_update) are called through the
// webview's own invoke, over the Tauri WebDriver bridge the Linux QA lane already uses (scripts/qa/
// linuxNative.mjs), because a signed-out app shows the sign-in screen and never mounts the update banner.
// The AppImage is extracted once and its AppRun started with APPIMAGE pointing at the real file: that
// variable is all the updater reads to know what to replace and what to relaunch, and extracting avoids
// asking a CI runner for FUSE. The proof is what is on disk and running afterwards: the published bytes in
// place of the file, and a new process running the published payload's binary, byte for byte.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { appProcessName, newSession, sleep, waitFor } from "../../e2e/desktop/webdriver.mjs";

if (process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("The update canary runs only on a disposable GitHub-hosted Linux runner");
}

const REPOSITORY = process.env.GITHUB_REPOSITORY;
const FROM = process.env.FROM_VERSION;
const TEMP = process.env.RUNNER_TEMP;
const ASSET = "ArtDaddy-linux-x86_64.AppImage";
const MANIFEST_URL = "https://artdaddy.app/updates/latest.json";
const MAIN_BINARY = appProcessName();
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

const evidence = { repository: REPOSITORY, from: FROM, startedAt: new Date().toISOString(), steps: [] };
const note = (name, data = {}) => {
  evidence.steps.push({ at: new Date().toISOString(), name, ...data });
  console.log(`[canary] ${name} ${Object.keys(data).length ? JSON.stringify(data) : ""}`);
};
const save = () => writeFileSync(path.join(OUT, "evidence.json"), JSON.stringify(evidence, null, 2));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

const sha256 = (file) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });

const newer = (a, b) => {
  const [x, y] = [a, b].map((version) => version.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

/** Every running copy of the app's own binary, with the tick it started on (a pid alone can be reused). */
function appProcesses() {
  const found = [];
  for (const entry of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      const exe = realpathSync(`/proc/${entry}/exe`);
      if (path.basename(exe) !== MAIN_BINARY) continue;
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19]; // field 22, after the (name)
      found.push({ id: Number(entry), start, exe });
    } catch {
      /* gone, or not ours to read */
    }
  }
  return found;
}
const sameProcess = (a, b) => a.id === b.id && a.start === b.start;

function screenshot(file) {
  const shot = spawnSync("import", ["-window", "root", path.join(OUT, file)], { encoding: "utf8" });
  return shot.status === 0;
}

function extract(appImage, into) {
  mkdirSync(into, { recursive: true });
  // The extractor prints every file it writes; capturing that would overflow the buffer and look like a failure.
  const done = spawnSync(appImage, ["--appimage-extract"], {
    cwd: into,
    env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1" },
    stdio: "ignore",
  });
  if (done.status !== 0) throw new Error(`${appImage} --appimage-extract exited ${done.status}`);
  const appRun = path.join(into, "squashfs-root", "AppRun");
  if (!existsSync(appRun)) throw new Error(`no AppRun in ${into}`);
  return appRun;
}

let driver = null;
let driverLog = "";
async function startDriver() {
  const native = run("which", ["WebKitWebDriver"]);
  driver = spawn("tauri-driver", ["--native-driver", native], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  for (const stream of [driver.stdout, driver.stderr]) {
    stream.on("data", (chunk) => (driverLog = (driverLog + chunk).slice(-30_000)));
  }
  await waitFor(
    async () => {
      const response = await fetch("http://127.0.0.1:4444/status");
      return response.ok && (await response.json()).value?.ready === true;
    },
    { timeout: 30_000, label: "tauri-driver ready" },
  );
}
async function stopDriver() {
  const stopped = driver;
  driver = null;
  if (stopped && stopped.exitCode === null) {
    await new Promise((resolve) => {
      stopped.once("exit", resolve);
      stopped.kill();
      setTimeout(resolve, 5_000).unref();
    });
  }
  // The bridge need not take its native driver down with it, and that one holds the next session's port.
  spawnSync("pkill", ["-f", "WebKitWebDriver"]);
  await sleep(1_000);
}

/** Call a native command from the page and wait for its answer (the page script cannot be awaited). */
async function invoke(session, command, { timeout = 120_000 } = {}) {
  await session.exec(
    "globalThis.__canary={done:false};" +
      "window.__TAURI_INTERNALS__.invoke(arguments[0])" +
      ".then(v=>{globalThis.__canary={done:true,ok:true,value:v}})" +
      ".catch(e=>{globalThis.__canary={done:true,ok:false,error:String(e)}});return true;",
    [command],
  );
  const result = await waitFor(() => session.exec("return globalThis.__canary?.done?globalThis.__canary:null;"), {
    timeout,
    interval: 500,
    label: command,
  });
  if (!result.ok) throw new Error(`${command} failed: ${result.error}`);
  return result.value;
}

async function appSession(appRun, appImage) {
  process.env.APPIMAGE = appImage;
  process.env.APPDIR = path.dirname(appRun);
  await startDriver();
  const session = await newSession(appRun);
  await waitFor(() => session.exec("return Boolean(window.__TAURI_INTERNALS__)&&document.readyState==='complete'"), {
    timeout: 60_000,
    label: "the app's window",
  });
  return session;
}

/** Who is running and how they were started: the one thing a hang cannot be diagnosed without. */
function listProcesses(label) {
  const ps = spawnSync("ps", ["-eo", "pid,ppid,etimes,args", "--sort=start_time"], { encoding: "utf8" });
  const lines = (ps.stdout ?? "").split("\n").filter((line) => /PID|artdaddy|WebKit|tauri-driver|AppRun|Xvfb/.test(line));
  writeFileSync(path.join(OUT, `processes-${label}.txt`), lines.join("\n"));
}

/** The app's own binary inside an extracted AppImage. */
function payloadBinary(squashfsRoot) {
  const direct = path.join(squashfsRoot, "usr", "bin", MAIN_BINARY);
  if (existsSync(direct)) return direct;
  const found = readdirSync(squashfsRoot, { recursive: true }).find((entry) => path.basename(String(entry)) === MAIN_BINARY);
  if (!found) throw new Error(`no ${MAIN_BINARY} in ${squashfsRoot}`);
  return path.join(squashfsRoot, String(found));
}

/** The largest window the app has on the virtual display, once one is big enough to be its real window. */
async function waitForWindow(ms) {
  const end = Date.now() + ms;
  let best = null;
  while (Date.now() < end) {
    const tree = spawnSync("xwininfo", ["-root", "-tree"], { encoding: "utf8" });
    for (const line of tree.status === 0 ? tree.stdout.split("\n") : []) {
      const match = line.match(/artdaddy.*?\s(\d+)x(\d+)\+/i);
      if (!match) continue;
      const size = { width: Number(match[1]), height: Number(match[2]) };
      if (!best || size.width * size.height > best.width * best.height) best = size;
    }
    if (best && best.width >= 640 && best.height >= 400) return best;
    await sleep(2_000);
  }
  return best;
}

async function killApp() {
  for (const app of appProcesses()) {
    try {
      process.kill(app.id, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  spawnSync("pkill", ["-9", "-f", "WebKitWebProcess|WebKitNetworkProcess|WebKitGPUProcess"]);
  for (let i = 0; i < 20 && appProcesses().length; i++) await sleep(500);
}

/** Ask the updated app itself, in a fresh session. Extra evidence: a failure here is recorded, not fatal. */
async function verifyWithWebDriver(appRun, appImage, expectedVersion) {
  try {
    await stopDriver();
    await killApp();
    const attempt = appSession(appRun, appImage);
    attempt.catch(() => undefined); // if the clock wins, this one's later failure must not crash the run
    const timer = sleep(40_000).then(() => {
      throw new Error("no WebDriver session within 40 s");
    });
    timer.catch(() => undefined);
    const session = await Promise.race([attempt, timer]);
    const next = await invoke(session, "check_for_update", { timeout: 30_000 });
    const version = await invoke(session, "plugin:app|version", { timeout: 15_000 }).catch(
      (error) => `unavailable: ${error.message}`,
    );
    // An app still on the old version would be offered the new one; null means nothing newer than itself exists.
    const sure = /^\d+\.\d+\.\d+$/.test(version);
    return { ok: next === null && (!sure || version === expectedVersion), version, offeredNext: next };
  } catch (error) {
    listProcesses("verification-failed");
    return { ok: false, error: String(error?.message ?? error) };
  }
}

let failure = null;
try {
  // 1. What the live manifest offers, and the bytes the finished update must be.
  const manifest = await (await fetch(MANIFEST_URL, { headers: { "cache-control": "no-cache" } })).json();
  const offered = manifest.platforms?.["linux-x86_64"];
  note("live manifest", { version: manifest.version, linuxUrl: offered?.url });
  if (!offered?.url || !offered?.signature) throw new Error("the live manifest has no Linux entry");
  if (!newer(manifest.version, FROM)) {
    throw new Error(`the live manifest (${manifest.version}) is not newer than ${FROM}; nothing to update to`);
  }
  const digest = run("gh", [
    "api",
    `repos/${REPOSITORY}/releases/tags/v${manifest.version}`,
    "--jq",
    `.assets[] | select(.name=="${ASSET}") | .digest`,
  ]);
  const expected = digest.replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error(`the release shows no sha256 for ${ASSET}: ${digest}`);
  note("expected AppImage", { version: manifest.version, sha256: expected });

  // 2. The old release, as a user has it, started from the file they would have.
  const home = path.join(TEMP, "canary");
  mkdirSync(home, { recursive: true });
  run("gh", ["release", "download", `v${FROM}`, "--repo", REPOSITORY, "--pattern", ASSET, "--dir", home, "--clobber"]);
  const appImage = path.join(home, "ArtDaddy.AppImage");
  run("mv", [path.join(home, ASSET), appImage]);
  chmodSync(appImage, 0o755);
  const oldHash = await sha256(appImage);
  note("old AppImage", { bytes: statSync(appImage).size, sha256: oldHash });
  if (oldHash === expected) throw new Error("the old and the offered AppImage are the same file");
  const appRun = extract(appImage, path.join(home, "old"));
  for (const name of ["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) {
    process.env[name] = path.join(home, "xdg", name);
    mkdirSync(process.env[name], { recursive: true });
  }
  process.env.APPIMAGE_EXTRACT_AND_RUN = "1";
  process.env.TAURI_AUTOMATION = "1";

  // 3. Let the app itself check, download and verify the update.
  const session = await appSession(appRun, appImage);
  await sleep(5_000); // the app's own start-up work first
  const running = appProcesses();
  note("old app running", { processes: running });
  if (!running.length) throw new Error("the old app is not running");
  screenshot("before-update.png");
  const available = await invoke(session, "check_for_update");
  note("check_for_update", { available });
  if (available?.version !== manifest.version) {
    throw new Error(`the app was offered ${available?.version ?? "nothing"}, the manifest says ${manifest.version}`);
  }
  if (available.current_version !== FROM) throw new Error(`the app reports it is ${available.current_version}`);
  const staged = await invoke(session, "download_update", { timeout: 300_000 });
  note("download_update", { staged });

  // 4. Install: the app replaces the file it was started from and relaunches it.
  const installStarted = Date.now();
  const before = statSync(appImage);
  void session
    .exec("window.__TAURI_INTERNALS__.invoke('install_update').catch(()=>{});return true;")
    .catch(() => undefined);
  note("install_update requested");

  // 5. Wait for exactly the published bytes on disk, and a NEW process running them.
  let outcome = null;
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await sleep(4_000);
    let now;
    try {
      now = statSync(appImage);
    } catch {
      continue; // the updater moves the old file aside before writing the new one
    }
    const changed = now.size !== before.size || now.mtimeMs !== before.mtimeMs;
    const hash = changed ? await sha256(appImage) : oldHash;
    const fresh = appProcesses().filter((app) => !running.some((was) => sameProcess(app, was)));
    const seconds = Math.round((Date.now() - installStarted) / 1000);
    if (hash === expected && fresh.length) {
      outcome = { replaced: true, relaunched: true, processes: fresh, seconds };
      break;
    }
    if (hash === expected && seconds > 180) {
      outcome = { replaced: true, relaunched: false, processes: [], seconds };
      break;
    }
  }
  if (!outcome) throw new Error("the AppImage never became the offered file, with a new process running it");
  note("after update", outcome);
  if (!outcome.relaunched) throw new Error("the AppImage was replaced but the app was not relaunched by itself");
  listProcesses("after-update");

  // 6. What came back is the published app: the very same binary, running from the new file.
  const publishedRun = extract(appImage, path.join(home, "new"));
  const runningHash = await sha256(outcome.processes[0].exe);
  const publishedHash = await sha256(payloadBinary(path.dirname(publishedRun)));
  const replacedHash = await sha256(payloadBinary(path.dirname(appRun)));
  note("relaunched payload", { running: runningHash, published: publishedHash, replaced: replacedHash });
  if (runningHash !== publishedHash) throw new Error("the relaunched app is not the published payload");
  if (runningHash === replacedHash) throw new Error("the relaunched app is still the old payload");

  // Its window. A relaunch inherits the WebDriver environment it was started under, so it can take a while.
  const shown = await waitForWindow(60_000);
  screenshot("after-update.png");
  const tree = spawnSync("xwininfo", ["-root", "-tree"], { encoding: "utf8" });
  if (tree.status === 0) writeFileSync(path.join(OUT, "windows-after-update.txt"), tree.stdout);
  note("relaunched app window", { shown });

  // Best effort and never the verdict: ask the updated app itself, in a fresh session, once nothing else runs.
  evidence.verification = await verifyWithWebDriver(publishedRun, appImage, manifest.version);
  note("fresh session on the updated app", evidence.verification);
  if (!evidence.verification.ok) {
    console.log("::warning::The updated app was replaced, relaunched and shown to be the published payload, but a fresh WebDriver session on it was not possible; see evidence.json.");
  }
  evidence.passed = true;
} catch (error) {
  failure = error;
  evidence.passed = false;
  evidence.error = String(error?.stack ?? error);
  console.error(`[canary] FAILED: ${evidence.error}`);
  listProcesses("failure");
  screenshot("failure.png");
} finally {
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(path.join(OUT, "driver.log"), driverLog);
  save();
  await stopDriver();
  await killApp();
}
process.exit(failure ? 1 : 0);
