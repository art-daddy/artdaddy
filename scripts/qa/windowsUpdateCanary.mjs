// In-place update canary for Windows. Installs a PUBLIC release on a disposable CI runner and updates
// it through the live updater manifest the way a user's app does: the app itself checks, downloads
// and verifies the signed installer, runs it over itself and is relaunched. It reads the public
// release and the public manifest only; nothing is published or changed.
//
// The updater commands (check_for_update, download_update, install_update) are called through the
// webview's own invoke, over a WebView2 remote-debugging port, because a signed-out app shows the
// sign-in screen and never mounts the update banner. The banner's click path is covered by the unit
// tests and by the macOS canary; what only a Windows machine can show is the Rust updater, the NSIS
// installer replacing a running app, and the relaunch.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("The update canary runs only on a disposable GitHub-hosted Windows runner");
}

const REPOSITORY = process.env.GITHUB_REPOSITORY;
const FROM = process.env.FROM_VERSION;
const MANIFEST_URL = "https://artdaddy.app/updates/latest.json";
const PORT = 18877;
const CDP = `http://127.0.0.1:${PORT}`;
const TEMP = process.env.RUNNER_TEMP;
const OUT = path.resolve("reports/qa/updater-canary");
if (!REPOSITORY || !/^\d+\.\d+\.\d+$/.test(FROM ?? "") || !TEMP) {
  throw new Error("GITHUB_REPOSITORY, RUNNER_TEMP and FROM_VERSION (x.y.z) are required");
}
mkdirSync(OUT, { recursive: true });

// playwright-core is installed beside this run, not into the project: the canary needs only its
// CDP client, and the project's own dependencies are irrelevant to an installed app.
const { chromium } = createRequire(path.join(process.env.CDP_CLIENT_DIR, "package.json"))(
  "playwright-core",
);

const evidence = { repository: REPOSITORY, from: FROM, startedAt: new Date().toISOString(), steps: [] };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const note = (name, data = {}) => {
  evidence.steps.push({ at: new Date().toISOString(), name, ...data });
  console.log(`[canary] ${name} ${Object.keys(data).length ? JSON.stringify(data) : ""}`);
};
const save = () => writeFileSync(path.join(OUT, "evidence.json"), JSON.stringify(evidence, null, 2));

function powershell(script) {
  const run = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", windowsHide: true },
  );
  if (run.status !== 0) throw new Error(`powershell exited ${run.status}: ${run.stderr || run.stdout}`);
  return run.stdout.trim();
}

const productVersion = (exe) =>
  powershell(`(Get-Item -LiteralPath '${exe}').VersionInfo.ProductVersion`).replace(/\.0$/, "");

/** Every running artdaddy.exe that is THIS install's, with the moment it started. */
function runningApps(exe) {
  const json = powershell(
    `ConvertTo-Json -InputObject @(Get-Process artdaddy -ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.Path -eq '${exe}' } | ` +
      `ForEach-Object { @{ id = $_.Id; started = $_.StartTime.ToString('o') } }) -Compress`,
  );
  return JSON.parse(json || "[]");
}

function screenshot(file) {
  powershell(
    `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ` +
      `$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ` +
      `$bitmap = New-Object System.Drawing.Bitmap($b.Width, $b.Height); ` +
      `$g = [System.Drawing.Graphics]::FromImage($bitmap); ` +
      `$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); ` +
      `$bitmap.Save('${path.join(OUT, file)}', [System.Drawing.Imaging.ImageFormat]::Png); ` +
      `$g.Dispose(); $bitmap.Dispose()`,
  );
}

const newer = (a, b) => {
  const [x, y] = [a, b].map((version) => version.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

async function pageOf(browser, waitMs = 60_000) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((candidate) => !candidate.url().startsWith("devtools:"));
    if (page) return page;
    await sleep(500);
  }
  throw new Error("the app showed no page over the debugging port");
}

async function cdpUp(waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${CDP}/json/version`);
      if (response.ok) return true;
    } catch {
      /* not listening yet */
    }
    await sleep(1000);
  }
  return false;
}

let failure = null;
try {
  // 1. The live manifest says what the app should be offered.
  const manifest = await (await fetch(MANIFEST_URL, { headers: { "cache-control": "no-cache" } })).json();
  const offered = manifest.platforms?.["windows-x86_64"];
  note("live manifest", { version: manifest.version, windowsUrl: offered?.url });
  if (!offered?.url || !offered?.signature) throw new Error("the live manifest has no Windows entry");
  if (!newer(manifest.version, FROM)) {
    throw new Error(`the live manifest (${manifest.version}) is not newer than ${FROM}; nothing to update to`);
  }

  // 2. The old release, as a user would have it.
  const download = spawnSync(
    "gh",
    ["release", "download", `v${FROM}`, "--repo", REPOSITORY, "--pattern", "ArtDaddy-windows-x64-setup.exe",
      "--dir", path.join(TEMP, "old-release"), "--clobber"],
    { encoding: "utf8" },
  );
  if (download.status !== 0) throw new Error(`could not download v${FROM}: ${download.stderr}`);
  const installer = path.join(TEMP, "old-release", "ArtDaddy-windows-x64-setup.exe");
  const bytes = readFileSync(installer);
  note("old installer", { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });

  // 3. Install it silently into a known folder, then check it is the old version.
  const destination = path.join(TEMP, "ArtDaddyCanary");
  const installed = spawnSync(installer, ["/S", `/D=${destination}`], { windowsHide: true });
  if (installed.status !== 0) throw new Error(`the old installer exited ${installed.status}`);
  const exe = path.join(destination, "artdaddy.exe");
  const before = productVersion(exe);
  note("installed", { exe, version: before });
  if (before !== FROM) throw new Error(`installed ${before}, expected ${FROM}`);

  // 4. Start it with a debugging port. The installer the app later runs inherits this environment,
  // so the relaunched app listens on the same port.
  process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${PORT}`;
  process.env.WEBVIEW2_USER_DATA_FOLDER = path.join(TEMP, "ArtDaddyCanaryWebView");
  const log = (name) => openSync(path.join(OUT, name), "w");
  const stdout = log("app-before.out.log");
  const stderr = log("app-before.err.log");
  const child = spawn(exe, [], { detached: true, stdio: ["ignore", stdout, stderr], env: process.env });
  child.unref();
  closeSync(stdout);
  closeSync(stderr);
  if (!(await cdpUp(90_000))) throw new Error("the old app never opened its debugging port");
  const old = runningApps(exe);
  note("old app running", { processes: old });
  if (!old.length) throw new Error("the old app is not running");

  // 5. Let the app itself check, download and verify the update.
  const browser = await chromium.connectOverCDP(CDP);
  const page = await pageOf(browser);
  await page.waitForFunction(() => Boolean(window.__TAURI_INTERNALS__?.invoke), undefined, { timeout: 30_000 });
  const invoke = (command) =>
    page.evaluate((name) => window.__TAURI_INTERNALS__.invoke(name), command);
  await sleep(5_000); // the app's own start-up work first
  screenshot("before-update.png");
  const available = await invoke("check_for_update");
  note("check_for_update", { available });
  if (available?.version !== manifest.version) {
    throw new Error(`the app was offered ${available?.version ?? "nothing"}, the manifest says ${manifest.version}`);
  }
  if (available.current_version !== FROM) throw new Error(`the app reports it is ${available.current_version}`);
  const staged = await invoke("download_update");
  note("download_update", { staged });

  // 6. Install: the installer replaces the running app, which does not answer again.
  const installStarted = Date.now();
  void page.evaluate(() => window.__TAURI_INTERNALS__.invoke("install_update")).catch(() => undefined);
  await sleep(3_000); // let the request reach the page before the connection is let go
  await browser.close().catch(() => undefined);
  note("install_update requested");

  // 7. Wait for the new version on disk and a NEW process running it.
  let outcome = null;
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await sleep(3_000);
    let version = null;
    try {
      version = productVersion(exe);
    } catch {
      /* the installer is replacing the file */
    }
    const apps = runningApps(exe);
    const fresh = apps.filter((app) => !old.some((was) => was.id === app.id));
    if (version === manifest.version && fresh.length) {
      outcome = { version, processes: apps, relaunched: true, seconds: Math.round((Date.now() - installStarted) / 1000) };
      break;
    }
    if (version === manifest.version && !apps.length && Date.now() - installStarted > 120_000) {
      outcome = { version, processes: apps, relaunched: false, seconds: Math.round((Date.now() - installStarted) / 1000) };
      break;
    }
  }
  if (!outcome) throw new Error("the installed version never became the offered one, with a new process");
  note("after update", outcome);
  await sleep(10_000);
  screenshot("after-update.png");

  // 8. The relaunched app must actually be alive: ask it, over the same port.
  if (outcome.relaunched && (await cdpUp(60_000))) {
    const reconnected = await chromium.connectOverCDP(CDP);
    const afterPage = await pageOf(reconnected);
    await afterPage.waitForFunction(() => document.body?.innerText?.trim().length > 20, undefined, { timeout: 60_000 });
    const seen = await afterPage.evaluate(() => ({
      title: document.title,
      text: document.body.innerText.slice(0, 300),
    }));
    note("relaunched app answers", seen);
    await reconnected.close().catch(() => undefined);
  } else if (outcome.relaunched) {
    note("relaunched app has no debugging port; judged by process and window only");
  }
  if (!outcome.relaunched) throw new Error("the app was updated but not relaunched");
  evidence.passed = true;
} catch (error) {
  failure = error;
  evidence.passed = false;
  evidence.error = String(error?.stack ?? error);
  console.error(`[canary] FAILED: ${evidence.error}`);
  try {
    screenshot("failure.png");
  } catch {
    /* no desktop to capture */
  }
} finally {
  evidence.finishedAt = new Date().toISOString();
  save();
  spawnSync("taskkill", ["/F", "/IM", "artdaddy.exe", "/T"], { windowsHide: true });
}
process.exit(failure ? 1 : 0);
