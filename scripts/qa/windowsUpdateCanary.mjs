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
//
// GitHub's Windows runners are elevated, and an elevated WebView2 host ignores the WEBVIEW2_* environment
// overrides, so the port is requested through HKLM policy. If it still does not open, the installer step
// alone is rehearsed (started the way the updater starts it) and the result says the app did not drive it.
//
// TO_VERSION (optional) judges that release's installer directly instead of the live manifest's: the old app
// is replaced the way the updater replaces it, so a release can be tested without offering it to anyone.
// Whenever the new version does not land, state-*.txt/png record who ran, where Windows says the app is
// installed, what the installer left behind, what Defender and the Application log said, and the screen.
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
// Optional: judge THIS release's installer directly (installer-only mode) instead of whatever the live
// manifest offers, so a release can be tested before, or without, offering it to anyone.
const TO = process.env.TO_VERSION ?? "";
const MANIFEST_URL = "https://artdaddy.app/updates/latest.json";
const PORT = 18877;
const CDP = `http://127.0.0.1:${PORT}`;
const TEMP = process.env.RUNNER_TEMP;
const OUT = path.resolve("reports/qa/updater-canary");
if (!REPOSITORY || !/^\d+\.\d+\.\d+$/.test(FROM ?? "") || !TEMP) {
  throw new Error("GITHUB_REPOSITORY, RUNNER_TEMP and FROM_VERSION (x.y.z) are required");
}
if (TO && !/^\d+\.\d+\.\d+$/.test(TO)) throw new Error("TO_VERSION must be x.y.z when given");
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

/** Every running artdaddy.exe that is THIS install's, with the moment it started and its window title. */
function runningApps(exe) {
  const json = powershell(
    `ConvertTo-Json -InputObject @(Get-Process artdaddy -ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.Path -eq '${exe}' } | ` +
      `ForEach-Object { @{ id = $_.Id; started = $_.StartTime.ToString('o'); title = $_.MainWindowTitle } }) -Compress`,
  );
  return JSON.parse(json || "[]");
}
const sameProcess = (a, b) => a.id === b.id && a.started === b.started;

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

const POLICY_KEY = "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments";

/** Ask WebView2 for a debugging port the one way an elevated host honours: HKLM policy, named for the exe. */
function allowDebuggingPort() {
  const args =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required " +
    `--remote-debugging-port=${PORT} --remote-allow-origins=*`;
  const added = spawnSync("reg.exe", ["add", POLICY_KEY, "/v", "artdaddy.exe", "/t", "REG_SZ", "/d", args, "/f"], {
    encoding: "utf8",
    windowsHide: true,
  });
  note("debugging port policy", { status: added.status, output: `${added.stdout}${added.stderr}`.trim() });
  const stored = spawnSync("reg.exe", ["query", POLICY_KEY, "/v", "artdaddy.exe"], { encoding: "utf8", windowsHide: true });
  note("debugging port policy as stored", { value: stored.stdout.split(/\r?\n/).find((line) => line.includes("artdaddy.exe")) });
}

function removeDebuggingPortPolicy() {
  spawnSync("reg.exe", ["delete", POLICY_KEY, "/v", "artdaddy.exe", "/f"], { windowsHide: true });
}

/** What a person would look at when no port opened: who runs, with which arguments, who listens, how privileged. */
function diagnose(label) {
  const ask = (script) => {
    try {
      return powershell(script);
    } catch (error) {
      return `error: ${error.message}`;
    }
  };
  const text = [
    "== artdaddy and webview processes ==",
    ask(
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'artdaddy|msedgewebview2' } | " +
        "ForEach-Object { '{0} {1} parent={2} {3}' -f $_.ProcessId, $_.Name, $_.ParentProcessId, $_.CommandLine } | Out-String -Width 4000",
    ),
    "== loopback listeners ==",
    ask(
      "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' } | " +
        "Sort-Object LocalPort | ForEach-Object { '{0}:{1} pid={2}' -f $_.LocalAddress, $_.LocalPort, $_.OwningProcess } | Out-String",
    ),
    "== integrity level of this shell ==",
    ask("whoami /groups | Select-String 'Mandatory Label' | Out-String"),
    "== policy ==",
    ask(`reg query '${POLICY_KEY}' | Out-String`),
  ].join("\n");
  writeFileSync(path.join(OUT, `diagnostics-${label}.txt`), text);
}

/**
 * Everything worth knowing when an update did not land: the installed file and its version, who runs (the
 * installer and its children included), where Windows says the app is installed, what the installer left in
 * the temp folders, what Defender and the Application log said, and the screen. Written as state-<label>.*.
 */
function snapshot(label, exe) {
  // Every query ends with `exit 0`: "no matching events" is an answer here, not a failure.
  const run = (script) => {
    try {
      return powershell(`${script}; exit 0`);
    } catch (error) {
      return `error: ${error.message}`;
    }
  };
  const destination = path.dirname(exe);
  const text = [
    `== ${new Date().toISOString()} (${label}) ==`,
    "== installed exe ==",
    run(
      `$f = Get-Item -LiteralPath '${exe}' -ErrorAction SilentlyContinue; if ($f) { ` +
        "'{0} bytes, written {1}, ProductVersion {2}' -f $f.Length, $f.LastWriteTime.ToString('o'), $f.VersionInfo.ProductVersion " +
        "} else { 'MISSING' }",
    ),
    "== processes: artdaddy, installers, webview ==",
    run(
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'artdaddy|setup|nsis|install|msedgewebview2|ffmpeg|yt-dlp' } | " +
        "ForEach-Object { '{0} {1} parent={2} created={3} path={4} cmd={5}' -f $_.ProcessId, $_.Name, $_.ParentProcessId, " +
        "$_.CreationDate, $_.ExecutablePath, $_.CommandLine } | Out-String -Width 4000",
    ),
    "== where Windows says the app is installed ==",
    run(
      "Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' " +
        "-ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -match 'artdaddy' } | " +
        "Select-Object DisplayName, DisplayVersion, InstallLocation, UninstallString | Format-List | Out-String -Width 4000",
    ),
    "== install folder, newest first ==",
    run(
      `Get-ChildItem -LiteralPath '${destination}' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | ` +
        "Select-Object -First 20 | ForEach-Object { '{0} {1,12} {2}' -f $_.LastWriteTime.ToString('o'), $_.Length, $_.Name } | Out-String",
    ),
    "== what updaters and installers left in the temp folders ==",
    run(
      "Get-ChildItem $env:TEMP, $env:RUNNER_TEMP -Recurse -Depth 2 -ErrorAction SilentlyContinue | " +
        "Where-Object { $_.Name -match 'updater|setup|nsis' } | Select-Object -First 40 | " +
        "ForEach-Object { '{0} {1,12} {2}' -f $_.LastWriteTime.ToString('o'), $_.Length, $_.FullName } | Out-String -Width 4000",
    ),
    "== Defender state and recent events ==",
    run(
      "Get-MpComputerStatus -ErrorAction SilentlyContinue | Select-Object AMServiceEnabled, AntivirusEnabled, " +
        "RealTimeProtectionEnabled, BehaviorMonitorEnabled, IoavProtectionEnabled | Format-List | Out-String",
    ),
    run("Get-MpThreatDetection -ErrorAction SilentlyContinue | Select-Object -First 10 | Format-List | Out-String -Width 4000"),
    run(
      "Get-WinEvent -LogName 'Microsoft-Windows-Windows Defender/Operational' -MaxEvents 30 -ErrorAction SilentlyContinue | " +
        "ForEach-Object { '{0} id={1} {2}' -f $_.TimeCreated.ToString('o'), $_.Id, (($_.Message -split \"`n\")[0]) } | Out-String -Width 4000",
    ),
    "== Application log: errors and warnings of the last 15 minutes ==",
    run(
      "Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Level = 2,3; StartTime = (Get-Date).AddMinutes(-15) } -MaxEvents 40 " +
        "-ErrorAction SilentlyContinue | ForEach-Object { '{0} {1} id={2} {3}' -f $_.TimeCreated.ToString('o'), $_.ProviderName, " +
        "$_.Id, (($_.Message -split \"`n\")[0]) } | Out-String -Width 4000",
    ),
    "== windows with a title ==",
    run("Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { '{0} {1} {2}' -f $_.Id, $_.ProcessName, $_.MainWindowTitle } | Out-String -Width 4000"),
  ].join("\n");
  writeFileSync(path.join(OUT, `state-${label}.txt`), text);
  try {
    screenshot(`state-${label}.png`);
  } catch {
    /* no desktop to capture */
  }
}

let failure = null;
try {
  // 1. The live manifest says what the app should be offered.
  const manifest = await (await fetch(MANIFEST_URL, { headers: { "cache-control": "no-cache" } })).json();
  const offered = manifest.platforms?.["windows-x86_64"];
  note("live manifest", { version: manifest.version, windowsUrl: offered?.url, judging: TO ? `${TO} directly, not through the manifest` : undefined });
  const target = TO || manifest.version;
  if (!TO && (!offered?.url || !offered?.signature)) throw new Error("the live manifest has no Windows entry");
  if (!newer(target, FROM)) {
    throw new Error(`${TO ? "the release" : "the live manifest"} (${target}) is not newer than ${FROM}; nothing to update to`);
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

  // 4. Start it with a debugging port. GitHub's Windows runners are ELEVATED, and an elevated WebView2
  // host ignores WEBVIEW2_* environment overrides and HKCU policy but honours HKLM policy, so the port
  // is asked for there (the variable stays for a standard-user machine). The app's own window config
  // sets browser arguments, which that policy replaces, so they are repeated. An app the installer
  // started on its own has no port and a second launch only hands over to it: clear any first.
  spawnSync("taskkill", ["/F", "/IM", "artdaddy.exe", "/T"], { windowsHide: true });
  allowDebuggingPort();
  process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${PORT}`;
  process.env.WEBVIEW2_USER_DATA_FOLDER = path.join(TEMP, "ArtDaddyCanaryWebView");
  const log = (name) => openSync(path.join(OUT, name), "w");
  const stdout = log("app-before.out.log");
  const stderr = log("app-before.err.log");
  const child = spawn(exe, [], { detached: true, stdio: ["ignore", stdout, stderr], env: process.env });
  child.unref();
  closeSync(stdout);
  closeSync(stderr);
  const portOpened = await cdpUp(90_000);
  const old = runningApps(exe);
  note("old app running", { processes: old, debuggingPort: portOpened });
  if (!old.length) throw new Error("the old app is not running");
  await sleep(5_000); // the app's own start-up work first
  screenshot("before-update.png");
  const installStarted = Date.now();

  if (portOpened && !TO) {
    // 5. Let the app itself check, download and verify the update.
    const browser = await chromium.connectOverCDP(CDP);
    const page = await pageOf(browser);
    await page.waitForFunction(() => Boolean(window.__TAURI_INTERNALS__?.invoke), undefined, { timeout: 30_000 });
    const invoke = (command) =>
      page.evaluate((name) => window.__TAURI_INTERNALS__.invoke(name), command);
    const available = await invoke("check_for_update");
    note("check_for_update", { available });
    if (available?.version !== manifest.version) {
      throw new Error(`the app was offered ${available?.version ?? "nothing"}, the manifest says ${manifest.version}`);
    }
    if (available.current_version !== FROM) throw new Error(`the app reports it is ${available.current_version}`);
    const staged = await invoke("download_update");
    note("download_update", { staged });

    // 6. Install: the updater runs the installer and ends the app itself (it ignores whether the installer
    // started, then exits), so the call never comes back on success. An error that DOES come back is the one
    // outcome that must not be swallowed: the app would be left exactly as it was.
    const installCall = page
      .evaluate(() => window.__TAURI_INTERNALS__.invoke("install_update"))
      .then(
        () => ({ settled: "resolved" }),
        (error) => ({ settled: "rejected", message: String(error?.message ?? error).slice(0, 400) }),
      );
    const settled = await Promise.race([installCall, sleep(6_000).then(() => ({ settled: "pending" }))]);
    await browser.close().catch(() => undefined);
    note("install_update requested", settled);
    if (settled.settled === "rejected" && !/closed|disconnected|target|navigat|context|session|destroyed/i.test(settled.message)) {
      throw new Error(`install_update answered with an error instead of ending the app: ${settled.message}`);
    }
  } else {
    // No page to ask: say why, then rehearse the part only a Windows machine can show, with the
    // installer started the way the updater starts it. The app did NOT drive this, and the result
    // says so.
    if (!TO) diagnose("no-port");
    evidence.mode = "installer-only";
    note(
      TO
        ? `judging ${TO}'s installer directly: the running old app is replaced the way the updater replaces it`
        : "the old app opened no debugging port; rehearsing the installer step without the app driving it",
    );
    const fetched = path.join(TEMP, "new-release");
    const got = spawnSync(
      "gh",
      ["release", "download", `v${target}`, "--repo", REPOSITORY, "--pattern", "ArtDaddy-windows-x64-setup.exe*",
        "--dir", fetched, "--clobber"],
      { encoding: "utf8" },
    );
    if (got.status !== 0) throw new Error(`could not download v${target}: ${got.stderr}`);
    const update = path.join(fetched, "ArtDaddy-windows-x64-setup.exe");
    const signature = TO ? path.join(fetched, "ArtDaddy-windows-x64-setup.exe.sig") : path.join(fetched, "manifest.sig");
    if (!TO) writeFileSync(signature, offered.signature);
    const verified = spawnSync("node", ["scripts/verify-release-signature.mjs", update, signature], { encoding: "utf8" });
    note(TO ? "release signature against the committed key" : "live manifest signature against the published installer", {
      status: verified.status,
      output: `${verified.stdout}${verified.stderr}`.trim().slice(-300),
    });
    if (verified.status !== 0) throw new Error("the live manifest's signature does not verify against the published installer");
    spawn(update, ["/P", "/R", "/UPDATE", "/ARGS"], { detached: true, stdio: "ignore" }).unref();
    await sleep(1_000);
    for (const app of old) spawnSync("taskkill", ["/F", "/PID", String(app.id), "/T"], { windowsHide: true });
    note("installer started the way the updater starts it; the old app ended");
  }

  // 7. Wait for the new version on disk and a NEW process running it.
  let outcome = null;
  let lastVersion = null;
  let lastApps = [];
  let snapshots = 0;
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await sleep(3_000);
    if (snapshots === 0 && Date.now() - installStarted > 20_000) {
      snapshots = 1;
      snapshot("after-20s", exe);
    } else if (snapshots === 1 && Date.now() - installStarted > 90_000) {
      snapshots = 2;
      snapshot("after-90s", exe);
    }
    let version = null;
    try {
      version = productVersion(exe);
    } catch {
      /* the installer is replacing the file */
    }
    let apps = [];
    try {
      apps = runningApps(exe);
    } catch {
      /* a process went away while it was being read */
    }
    lastVersion = version;
    lastApps = apps;
    const fresh = apps.filter((app) => !old.some((was) => sameProcess(app, was)));
    if (version === target && fresh.length) {
      outcome = { version, processes: apps, relaunched: true, seconds: Math.round((Date.now() - installStarted) / 1000) };
      break;
    }
    if (version === target && !apps.length && Date.now() - installStarted > 120_000) {
      outcome = { version, processes: apps, relaunched: false, seconds: Math.round((Date.now() - installStarted) / 1000) };
      break;
    }
  }
  if (!outcome) {
    snapshot("timeout", exe);
    throw new Error(
      `the installed version never became the offered one (${target}), with a new process; last read: ` +
        `version ${lastVersion}, processes ${JSON.stringify(lastApps)} (see state-timeout.txt)`,
    );
  }
  note("after update", outcome);
  await sleep(10_000);
  screenshot("after-update.png");

  // 8. The relaunched app must actually be alive: ask it over the same port, or, when the installer's
  // relaunch did not carry the port, require a process that owns a window.
  if (outcome.relaunched && (await cdpUp(60_000))) {
    const reconnected = await chromium.connectOverCDP(CDP);
    const afterPage = await pageOf(reconnected);
    await afterPage.waitForFunction(() => document.body?.innerText?.trim().length > 20, undefined, { timeout: 60_000 });
    const seen = await afterPage.evaluate(async () => ({
      title: document.title,
      text: document.body.innerText.slice(0, 300),
      version: await window.__TAURI_INTERNALS__.invoke("plugin:app|version").catch(() => null),
      offeredNext: await window.__TAURI_INTERNALS__.invoke("check_for_update").catch((error) => `error: ${error}`),
    }));
    note("relaunched app answers", seen);
    await reconnected.close().catch(() => undefined);
    if (seen.version !== null && seen.version !== target) {
      throw new Error(`the relaunched app says it is ${seen.version}, expected ${target}`);
    }
    if (seen.offeredNext !== null && !String(seen.offeredNext).startsWith("error:")) {
      throw new Error(`the relaunched app is still offered ${seen.offeredNext?.version}`);
    }
  } else if (outcome.relaunched) {
    let titled = [];
    const windowDeadline = Date.now() + 60_000;
    while (!titled.length && Date.now() < windowDeadline) {
      titled = runningApps(exe).filter((app) => app.title && !old.some((was) => sameProcess(app, was)));
      if (!titled.length) await sleep(2_000);
    }
    note("relaunched app has no debugging port; judged by process and window", { titled });
    if (!titled.length) throw new Error("the relaunched app has no window");
  }
  if (!outcome.relaunched) throw new Error("the app was updated but not relaunched");
  evidence.passed = true;
  if (evidence.mode === "installer-only") {
    console.log(
      TO
        ? `::warning::TO_VERSION=${TO} was given, so only the installer step (replace the running app, relaunch it) was judged; ` +
            "the app's own updater did not drive this update."
        : "::warning::The old app opened no debugging port, so it did not drive this update: only the installer " +
            "step (replace the running app, relaunch it) was rehearsed. See diagnostics-no-port.txt.",
    );
  }
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
  removeDebuggingPortPolicy();
  spawnSync("taskkill", ["/F", "/IM", "artdaddy.exe", "/T"], { windowsHide: true });
}
process.exit(failure ? 1 : 0);
