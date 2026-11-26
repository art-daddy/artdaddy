// The export lane: what a person does with Export in the REAL app, judged on the screen and on the delivered
// file, with every wait they feel timed.
//
//   node --experimental-websocket e2e/desktop/export/run.mjs [filter]
//
// `filter` picks scenarios by name or group, comma-separated (for example `cancel,queue` or `heavy`). Without
// one, every scenario runs except the heavy ones (a 4K and a ten-minute export), which run only when named.
//
// What a run needs and does:
// - One real-app run at a time on a shared PC: when ARTDADDY_LAB_DIR names a lab folder, the run takes
//   `<lab>/locks/real-app.lock` and removes it at the end. If the caller already holds it, set
//   ARTDADDY_QA_LOCK_HELD=1; ARTDADDY_QA_LOCK_WAIT_MIN=<minutes> waits for another run, looking every 20 s.
//   ARTDADDY_LAB_READY=<script> names a readiness check (a PowerShell script whose output says READY or NOT READY,
//   for power and free memory): the run does not start, nor start its next scenario, while it says NOT READY
//   (before a scenario it waits up to ARTDADDY_QA_READY_WAIT_MIN minutes, default 10, then leaves it not run).
// - The heavy scenarios time exports, so they first wait for a quiet PC (no other test run, build or encoder, and
//   the PC under ARTDADDY_QA_QUIET_PERCENT percent busy, default 25) for up to ARTDADDY_QA_QUIET_WAIT_MIN minutes
//   (default 30), and are not run if it never gets quiet; ARTDADDY_QA_ALLOW_BUSY=1 times them anyway, marked busy.
// - Windows, this worktree's node_modules, and the generated Tauri folders (src-tauri/binaries: the shipped
//   ffmpeg and ffprobe). CARGO_TARGET_DIR, if set, is where the shell is built.
// - Its own identity (app.mjs): the shell is built under `com.artdaddy.qa.export` with its own link scheme, its
//   web view keeps its storage in the run folder, and the page talks to a stand-in server (backend.mjs) that
//   answers the compatibility check and refuses everything else. No request can reach a model or a vendor.
//   The projects folder cannot be isolated (the app has no working override for it), so projects are named
//   `sweep_qa-export …` and removed at the end through the app's own project removal. What earlier runs left in
//   this identity's native export journal is set aside into the run folder first, so no earlier export comes back.
// - Save As is the native Windows dialog, answered by nativeDialog.ps1 (UI Automation and window messages:
//   no mouse, no keyboard, no focus change). The app has no test hook for it.
//
// Output: reports/qa/export/run-<stamp>/ (report.json with every check and time, timings.json, screenshots,
// the delivered files of the last run kept for inspection). Exit code 1 when a check failed that is not a
// known bug.
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { App, buildShell, clearJournal, IDENTIFIER, LINK_SCHEME, otherAppsRunning, root, signInLinkTarget, startPage } from "./app.mjs";
import { startBackend } from "./backend.mjs";
import { nativeDialog, newProject, openMenu, removeProjects, sleep } from "./journey.mjs";
import { cpuSampler, describeLoad, machineLoad, otherHeavyWork } from "./machine.mjs";
import { busyClip, colourClip } from "./media.mjs";

const filter = process.argv[2] ?? "";
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runDir = path.join(root, "reports", "qa", "export", `run-${stamp}`);
mkdirSync(runDir, { recursive: true });
const LOCK = process.env.ARTDADDY_LAB_DIR ? path.join(process.env.ARTDADDY_LAB_DIR, "locks", "real-app.lock") : null;

function git(...args) {
  return spawnSync("git", ["-C", root, ...args], { encoding: "utf8" }).stdout.trim();
}

function processCommandLine(pid) {
  const r = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: "utf8" });
  return r.stdout.trim();
}

function mcpPortHolder() {
  const r = spawnSync("powershell", ["-NoProfile", "-Command",
    "(Get-NetTCPConnection -LocalPort 19787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"], { encoding: "utf8" });
  const pid = Number(r.stdout.trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function linkKeyExists() {
  return spawnSync("reg", ["query", `HKCU\\Software\\Classes\\${LINK_SCHEME}`], { encoding: "utf8" }).status === 0;
}

const report = {
  lane: "e2e/desktop/export",
  started: new Date().toISOString(),
  filter,
  build: {},
  machine: { cpus: os.cpus().length, cpu: os.cpus()[0]?.model, totalMemoryGb: Math.round(os.totalmem() / 1e9) },
  scenarios: [],
  projectsRemoved: [],
  standIn: [],
};
const timings = [];

const READY_SCRIPT = process.env.ARTDADDY_LAB_READY || null;
/** The PC's readiness verdict (ARTDADDY_LAB_READY): null when none is configured, else whether it says READY and
 *  its line. A run is a heavy step: it does not start, and does not start its next scenario, while it says NOT READY. */
function labVerdict() {
  if (!READY_SCRIPT || !existsSync(READY_SCRIPT)) return null;
  const out = spawnSync("powershell", ["-NoProfile", "-File", READY_SCRIPT], { encoding: "utf8" }).stdout?.trim() ?? "";
  return { ready: !/^NOT READY/m.test(out), line: out.split(/\r?\n/).filter(Boolean).find((l) => /READY/.test(l)) ?? out.split(/\r?\n/).pop() };
}

async function main() {
  const modelVars = Object.keys(process.env).filter((k) => /AZURE|GOOGLE|OPENAI|VERTEX/i.test(k));
  if (modelVars.length) throw new Error(`refusing to run with model variables set: ${modelVars.join(", ")}`);
  if (process.platform !== "win32") throw new Error("the export lane drives the Windows app (Save As is the Windows dialog)");

  let lock = null;
  // A shared PC's lock (ARTDADDY_LAB_DIR); without one (a CI runner) there is no other run to share with. Another
  // run is waited for, looking every 20 s, for up to ARTDADDY_QA_LOCK_WAIT_MIN minutes (default 0).
  const takeLock = async () => {
    if (!LOCK || process.env.ARTDADDY_QA_LOCK_HELD === "1" || !existsSync(path.dirname(LOCK))) return;
    const give = Date.now() + Number(process.env.ARTDADDY_QA_LOCK_WAIT_MIN || 0) * 60_000;
    for (;;) {
      try {
        lock = openSync(LOCK, "wx");
        writeSync(lock, `e2e/desktop/export run ${stamp} (pid ${process.pid})\n`);
        closeSync(lock);
        return;
      } catch {
        let holder = "";
        try {
          holder = readFileSync(LOCK, "utf8").trim();
        } catch {
          /* released meanwhile */
        }
        if (Date.now() >= give) throw new Error(`another real-app run holds ${LOCK} (${holder}); wait and try again`);
        console.log(`waiting for the real-app lock (${holder})`);
        await sleep(20_000);
      }
    }
  };
  // Checked once the lock is ours, not before the wait: the PC may have gone onto battery meanwhile. NOT READY lets
  // the lock go and tries again every 30 s for up to ARTDADDY_QA_READY_WAIT_MIN minutes (default 10).
  const readyBy = Date.now() + Number(process.env.ARTDADDY_QA_READY_WAIT_MIN ?? 10) * 60_000;
  for (;;) {
    await takeLock();
    const verdict = labVerdict();
    report.labReady = verdict?.line ?? "no readiness check configured";
    if (!verdict || verdict.ready) break;
    if (lock !== null) rmSync(LOCK, { force: true });
    lock = null;
    if (Date.now() >= readyBy) throw new Error(`the PC is not ready: ${verdict.line}`);
    console.log(`the PC is not ready (${verdict.line}); trying again in 30 s`);
    await sleep(30_000);
  }

  const linkBefore = signInLinkTarget();
  const linkKeyBefore = linkKeyExists();
  const others = otherAppsRunning();
  report.othersAtStart = others;

  const shell = buildShell(path.join(runDir, "cargo.log"));
  const status = git("status", "--short").split(/\r?\n/).filter(Boolean);
  report.build = {
    worktree: root,
    head: git("rev-parse", "HEAD"),
    clean: status.length === 0,
    // Untracked or changed files, so a reader can tell a dirty app from this lane's own files being new.
    status,
    appSourceChanged: status.some((line) => !/e2e\/(desktop|byhand)\/export\//.test(line.replaceAll("\\", "/"))),
    identifier: IDENTIFIER,
    exe: shell.exe,
    exeBuiltAt: shell.builtAt,
    shellBuildMs: shell.ms,
  };

  const backend = await startBackend();
  const page = await startPage(backend.url);
  const app = new App(runDir);
  const scenarios = await loadScenarios();
  const created = [];
  // What earlier runs left in this identity's export journal, set aside (and kept in the run folder).
  report.journalSetAside = clearJournal(path.join(runDir, "journal-before"));
  try {
    const boot = await app.launch("first launch");
    timings.push({ scenario: "start", name: "app.launch.to-menu", ms: boot.ms, cold: true });
    report.build.version = await app.d.eval("window.__TAURI_INTERNALS__.invoke('plugin:app|version')");
    report.build.identifierReported = await app.d.eval("window.__TAURI_INTERNALS__.invoke('plugin:app|identifier')");
    report.build.commandLine = processCommandLine(app.pid);
    if (report.build.identifierReported !== IDENTIFIER)
      throw new Error(`the app reports ${report.build.identifierReported}, not ${IDENTIFIER}: stale or foreign build`);
    console.log(`build ${report.build.head.slice(0, 10)}${report.build.clean ? "" : report.build.appSourceChanged ? " (app source changed!)" : " (only this lane's files are new)"} · v${report.build.version} · ${shell.exe}`);
    console.log(`app up in ${boot.ms} ms (pid ${app.pid}); run folder ${runDir}`);
    // What an interrupted earlier run left (it is stopped by process id, so it cannot clean up): this lane's own
    // projects only, removed through the app like this run's.
    const leftovers = (await app.d.eval(`import('/src/store/projects.ts').then(async ({ useProjects }) => {
        await useProjects.getState().refresh();
        return useProjects.getState().projects.map((p) => p.id).filter((id) => /^sweep_qa_export_/.test(id));
      }, () => [])`).catch(() => [])) ?? [];
    if (leftovers.length) {
      report.leftoversRemoved = await removeProjects(app.d, leftovers);
      console.log(`removed ${leftovers.length} project(s) an earlier run left: ${leftovers.join(", ")}`);
    }

    const fixturesDir = path.join(root, "reports", "qa", "export", "fixtures");
    const fixtures = {
      red: () => colourClip(fixturesDir, { colour: "red", seconds: 3 }),
      blue: () => colourClip(fixturesDir, { colour: "blue", seconds: 3, tone: 660 }),
      green: () => colourClip(fixturesDir, { colour: "green", seconds: 3, tone: 330 }),
      busy: (seconds = 40) => busyClip(fixturesDir, { seconds }),
      busy4k: (seconds = 20) => busyClip(fixturesDir, { seconds, width: 3840, height: 2160 }),
    };

    for (const s of scenarios) {
      const t = context(s, app, fixtures, created);
      const t0 = performance.now();
      console.log(`\n▶ ${s.name}`);
      // A moment of NOT READY (the sign-in broker over its cap until the guard resets it) passes within minutes:
      // wait for READY for up to ARTDADDY_QA_READY_WAIT_MIN minutes (default 10) before giving the scenario up.
      let now = labVerdict();
      const readyBy = Date.now() + Number(process.env.ARTDADDY_QA_READY_WAIT_MIN ?? 10) * 60_000;
      while (now && !now.ready && Date.now() < readyBy) {
        console.log(`  waiting for the PC to be ready: ${now.line}`);
        await sleep(30_000);
        now = labVerdict();
      }
      if (now && !now.ready) {
        t.notRun(`the PC is not ready: ${now.line}`);
        t.result.status = "not run";
        report.scenarios.push(t.result);
        continue;
      }
      try {
        if (!app.running()) await app.launch(`before ${s.name}`);
        if (s.needsMcp) {
          const holder = mcpPortHolder();
          if (holder !== app.pid) {
            t.notRun(`MCP port 19787 is held by ${holder ?? "nobody"}, not this run's app (pid ${app.pid})`);
            throw new NotRun();
          }
        }
        await s.run(t);
      } catch (e) {
        if (!(e instanceof NotRun)) {
          t.result.error = String(e?.stack ?? e);
          console.log(`  threw: ${String(e?.message ?? e).split("\n")[0]}`);
          await t.shot("error").catch(() => {});
        }
      }
      // A native dialog that appeared after its step stopped waiting would hold the app for every later scenario.
      if (app.running()) {
        await sleep(2000);
        const swept = nativeDialog(app.pid, ["-Kind", "sweep"]);
        if (swept.closed?.length) t.note(`closed a dialog left open: ${swept.closed.join(", ")}`);
      }
      t.result.ms = Math.round(performance.now() - t0);
      t.result.status = t.result.notRun
        ? "not run"
        : t.result.error || t.result.checks.some((c) => !c.ok && !c.knownBug)
          ? "fail"
          : t.result.checks.some((c) => !c.ok && c.knownBug)
            ? "expected failure"
            : "pass";
      report.scenarios.push(t.result);
      console.log(`  ${t.result.status.toUpperCase()} (${(t.result.ms / 1000).toFixed(1)} s)`);
    }
  } finally {
    // Put it back: the projects this run made, the app, the page, the stand-in, the link key, the lock.
    try {
      if (!app.running()) await app.launch("clean-up");
      // What this PC's export history holds now (the time and size estimates are made from it), for the report.
      report.calibrations = await app.d
        .eval(`(() => { try { return JSON.parse(localStorage.getItem('artdaddy-export-calibration-v4') ?? '[]').map((c) => ({
            seconds: c.workload?.durationSeconds, size: c.output ? c.output.width + 'x' + c.output.height : null, encoder: c.encoder ?? null,
            elapsedSeconds: c.elapsedSeconds, finalBytes: c.finalBytes, temporaryBytes: c.temporaryBytes ?? null, memoryBytes: c.memoryBytes ?? null })); }
          catch (e) { return String(e); } })()`)
        .catch((e) => String(e));
      await app.d.key("Escape");
      if (await app.d.eval("location.pathname.startsWith('/p/')")) {
        await openMenu(app.d, "File", "Close Project");
        await app.d.waitFor("!location.pathname.startsWith('/p/')", 20_000).catch(() => {});
      }
      report.projectsRemoved = await removeProjects(app.d, created);
    } catch (e) {
      report.cleanupError = String(e?.message ?? e);
    }
    await app.stop();
    await page.close();
    report.standIn = backend.seen;
    await backend.close();
    if (!linkKeyBefore && linkKeyExists())
      spawnSync("reg", ["delete", `HKCU\\Software\\Classes\\${LINK_SCHEME}`, "/f"], { encoding: "utf8" });
    report.signInLink = { before: linkBefore, after: signInLinkTarget() };
    report.launches = app.launches;
    if (lock !== null) rmSync(LOCK, { force: true });
  }
}

class NotRun extends Error {}

function context(s, app, fixtures, created) {
  const dir = path.join(runDir, s.name);
  mkdirSync(dir, { recursive: true });
  const result = { name: s.name, group: s.group, checks: [], times: [], notes: [] };
  const t = {
    result,
    app,
    dir,
    fixtures,
    get d() {
      return app.d;
    },
    get pid() {
      return app.pid;
    },
    check(label, ok, detail = "") {
      result.checks.push({ label, ok: !!ok, detail: String(detail ?? "") });
      console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail !== "" ? ` — ${detail}` : ""}`);
      return !!ok;
    },
    /** A check that fails today because the app is wrong: CI stays green, and it turns into a failure-to-review
     *  ("unexpected pass") the day the bug is fixed. */
    knownBug(title, label, ok, detail = "") {
      result.checks.push({ label, ok: !!ok, detail: String(detail ?? ""), knownBug: title });
      console.log(`  ${ok ? "PASS (known bug fixed? remove the mark)" : "xfail"} ${label}${detail !== "" ? ` — ${detail}` : ""} [${title}]`);
      return !!ok;
    },
    time(name, ms, extra = {}) {
      const entry = { scenario: s.name, name, ms: Math.round(ms), ...extra };
      result.times.push(entry);
      timings.push(entry);
      console.log(`  time ${name}: ${(ms / 1000).toFixed(2)} s${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ""}`);
    },
    note(text) {
      result.notes.push(text);
      console.log(`  note ${text}`);
    },
    notRun(reason) {
      result.notRun = reason;
      console.log(`  not run: ${reason}`);
    },
    async project(label) {
      const t0 = performance.now();
      const p = await newProject(app.d, label);
      created.push(p.id);
      t.time("project.new.to-editor", performance.now() - t0);
      return p;
    },
    shot(name) {
      return app.d.screenshot(path.join(dir, `${name}.png`));
    },
    /** The PC's state, for a time that depends on it: the readiness check's verdict (power, memory), whether it is on
     *  mains, and the processor's load. */
    async machine() {
      const verdict = labVerdict()?.line ?? "no readiness check configured";
      const load = spawnSync("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average"], { encoding: "utf8" }).stdout?.trim();
      const mains = spawnSync("powershell", ["-NoProfile", "-Command", "$b = Get-CimInstance Win32_Battery; if ($b) { if ($b.BatteryStatus -eq 2) { 'on mains' } else { 'on battery' } } else { 'no battery' }"], { encoding: "utf8" }).stdout?.trim();
      return `${verdict}; ${mains}; processor load ${load}%`;
    },
    /** Wait for a PC quiet enough to time an export on: no other test run, build or encoder, and the whole PC under
     *  ARTDADDY_QA_QUIET_PERCENT (default 25) percent busy, looking every minute for up to ARTDADDY_QA_QUIET_WAIT_MIN
     *  (default 30) minutes. Resolves with whether it got quiet and what it saw last. */
    async waitQuiet() {
      const limit = Number(process.env.ARTDADDY_QA_QUIET_PERCENT || 25);
      const give = Date.now() + Number(process.env.ARTDADDY_QA_QUIET_WAIT_MIN ?? 30) * 60_000;
      for (;;) {
        const load = machineLoad(10);
        const heavy = otherHeavyWork(app.pid);
        const said = `${describeLoad(load)}${heavy.length ? `; other heavy work: ${heavy.join(", ")}` : ""}`;
        if (load.busyPercent <= limit && heavy.length === 0) return { quiet: true, said };
        if (Date.now() >= give) return { quiet: false, said };
        console.log(`  waiting for a quiet PC: ${said}`);
        await sleep(60_000);
      }
    },
    /** Where the processor's time goes from now until `stop()` (machine.mjs). */
    cpuSampler() {
      return cpuSampler(app.pid);
    },
    sleep,
  };
  return t;
}

async function loadScenarios() {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "scenarios");
  const files = readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort();
  const all = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    for (const s of mod.scenarios ?? []) all.push(s);
  }
  const wanted = filter.split(",").map((f) => f.trim()).filter(Boolean);
  return all.filter((s) =>
    wanted.length ? wanted.some((f) => s.name.includes(f) || (s.group ?? "").includes(f)) : !s.heavy && !s.named,
  );
}

let failed = false;
try {
  await main();
} catch (e) {
  report.error = String(e?.stack ?? e);
  console.error(`\nrun failed: ${String(e?.message ?? e)}`);
  failed = true;
}
report.ended = new Date().toISOString();
writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
writeFileSync(path.join(runDir, "timings.json"), JSON.stringify(timings, null, 2));
const counts = {};
for (const s of report.scenarios) counts[s.status] = (counts[s.status] ?? 0) + 1;
console.log(`\n${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "no scenarios ran"}`);
console.log(`report: ${path.join(runDir, "report.json")}`);
if (report.signInLink && report.signInLink.before !== report.signInLink.after) {
  console.error(`the artdaddy:// link changed during the run: ${report.signInLink.before} -> ${report.signInLink.after}`);
  failed = true;
}
process.exit(failed || report.scenarios.some((s) => s.status === "fail") ? 1 : 0);
