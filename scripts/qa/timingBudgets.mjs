// Timing budgets: how long each user-facing wait may take on the lab PC, and the check of a run against them.
//
//   node scripts/qa/timingBudgets.mjs compare <results.jsonl> [--budgets <file>] [--report-only] [--report <file>]
//   node scripts/qa/timingBudgets.mjs run [--runs 3] [--lanes browser,desktop] [--results <file>] [--timeout-min 15]
//   node scripts/qa/timingBudgets.mjs calibrate [--runs 5] [--lanes browser,desktop] [--from <results.jsonl>]
//
// THE BUDGETS (e2e/timing-budgets.json) map a scenario name (e2e/lib/timing.ts says how to name one) to the most
// milliseconds that wait may take on the lab PC. The owner's rule: today's time plus 20%, unless he sets a number. So
// calibrate gives a wait that has NO budget the median of its runs plus 20%, and never changes a budget that exists: his
// number stays, and a wait that got slower cannot raise its own budget. To measure one again, delete its line first.
// It needs at least 3 measurements of a wait from this machine, and ignores the measurements of a test that failed.
//
// COMPARE judges the median of each wait's measurements in a results file:
//   PASS       the median is within the budget
//   SLOW       the median is over the budget, by how much
//   NEW        measured, with no budget yet (calibrate on the lab PC to give it one)
//   MISSING    has a budget, but nothing measured it in this file (its test did not run, or stopped timing it)
//   MALFORMED  a line that is not a measurement, named by its number: never skipped in silence
// On the lab PC it is the check: exit 1 on any SLOW, MISSING or MALFORMED line, or when nothing was measured. In CI (the
// CI variable is set) or with --report-only it only reports and exits 0: GitHub's machines are too uneven to block on.
//
// RUN finds the timed tests, the Playwright specs under e2e/ui and the node lanes `*.desktop.mjs` under e2e/desktop that
// import e2e/lib/timing, and runs each of them --runs times, round by round, into one results file. A test that fails,
// times out or passes without recording a timing is a failed run (exit 1). The browser specs need @playwright/test
// installed (playwright.config.ts says how); the desktop lanes need what their headers say (a dev build under the lanes'
// own identity, vite serving where it points, tauri-driver, msedgedriver). scripts/qa/nightlyTiming.ps1 sets all of it
// up on the lab PC.
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { TIMING_FILE_ENV } from "../../e2e/lib/timing.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BUDGETS_FILE = path.join(ROOT, "e2e", "timing-budgets.json");
/** The owner's rule: today's time plus 20%. */
export const HEADROOM = 0.2;
/** Fewer measurements than this cannot set a budget. */
export const MIN_SAMPLES = 3;

// ---- pure: reading results and budgets -------------------------------------------------------------------------

/** Why a parsed line is not a measurement, or null when it is one. */
export function entryProblem(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return "not a JSON object";
  if (typeof value.scenario !== "string" || !value.scenario.trim()) return "no scenario name";
  if (!Number.isFinite(value.ms) || value.ms < 0)
    return `"ms" is not a duration: ${JSON.stringify(value.ms) ?? "missing"}`;
  for (const field of ["machine", "build"]) {
    if (typeof value[field] !== "string" || !value[field].trim()) return `no "${field}"`;
  }
  if (typeof value.at !== "string" || Number.isNaN(Date.parse(value.at))) {
    return `"at" is not a time: ${JSON.stringify(value.at) ?? "missing"}`;
  }
  return null;
}

/** A results file's measurements, and each line that is not one (1-based line number, reason, text). */
export function parseResults(text) {
  const entries = [];
  const problems = [];
  String(text)
    .split(/\r?\n/)
    .forEach((raw, index) => {
      if (!raw.trim()) return;
      const line = index + 1;
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        problems.push({ line, reason: "not JSON", text: raw });
        return;
      }
      const reason = entryProblem(value);
      if (reason) problems.push({ line, reason, text: raw });
      else {
        const { scenario, ms, machine, build, at } = value;
        entries.push({ scenario, ms, machine, build, at });
      }
    });
  return { entries, problems };
}

/** The budgets file as a Map of scenario -> milliseconds, and what is wrong with it. */
export function parseBudgets(text) {
  const budgets = new Map();
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { budgets, problems: [`not JSON (${error.message})`] };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { budgets, problems: ["not an object of scenario name -> milliseconds"] };
  }
  const problems = [];
  for (const [scenario, ms] of Object.entries(value)) {
    if (!scenario.trim()) problems.push("a budget with no scenario name");
    else if (!Number.isFinite(ms) || ms <= 0) {
      problems.push(
        `"${scenario}": the budget is not a positive number of milliseconds (${JSON.stringify(ms)})`,
      );
    } else budgets.set(scenario, ms);
  }
  return { budgets, problems };
}

/** The budgets as the committed file: one key per wait, sorted, two-space indent, final newline. */
export function formatBudgets(budgets) {
  const sorted = [...budgets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${JSON.stringify(Object.fromEntries(sorted), null, 2)}\n`;
}

// ---- pure: judging ---------------------------------------------------------------------------------------------

export function median(values) {
  if (!values.length) throw new RangeError("the median of no values");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function byScenario(entries) {
  const groups = new Map();
  for (const { scenario, ms } of entries) {
    if (!groups.has(scenario)) groups.set(scenario, []);
    groups.get(scenario).push(ms);
  }
  return groups;
}

const SEVERITY = ["SLOW", "MISSING", "NEW", "PASS"];

/** One row per wait, worst first: PASS, SLOW (with overMs and overPct), NEW or MISSING. */
export function compareTimings(entries, budgets) {
  const rows = [];
  const measured = byScenario(entries);
  for (const [scenario, values] of measured) {
    const ms = median(values);
    const runs = values.length;
    if (!budgets.has(scenario)) rows.push({ scenario, verdict: "NEW", ms, runs });
    else {
      const budget = budgets.get(scenario);
      if (ms > budget) {
        rows.push({
          scenario,
          verdict: "SLOW",
          ms,
          budget,
          runs,
          overMs: ms - budget,
          overPct: ((ms - budget) / budget) * 100,
        });
      } else rows.push({ scenario, verdict: "PASS", ms, budget, runs });
    }
  }
  for (const [scenario, budget] of budgets) {
    if (!measured.has(scenario)) rows.push({ scenario, verdict: "MISSING", budget, runs: 0 });
  }
  return rows.sort(
    (a, b) =>
      SEVERITY.indexOf(a.verdict) - SEVERITY.indexOf(b.verdict) ||
      (a.scenario < b.scenario ? -1 : a.scenario > b.scenario ? 1 : 0),
  );
}

/** Whether the run passes the lab check, with the counts behind it. */
export function verdictOf(rows, problems) {
  const count = (verdict) => rows.filter((row) => row.verdict === verdict).length;
  const tally = {
    pass: count("PASS"),
    slow: count("SLOW"),
    new: count("NEW"),
    missing: count("MISSING"),
  };
  const measured = tally.pass + tally.slow + tally.new;
  const ok = measured > 0 && tally.slow === 0 && tally.missing === 0 && problems.length === 0;
  return { ok, measured, malformed: problems.length, ...tally };
}

const whole = (ms) => `${Math.round(ms)} ms`;
const percent = (p) => `${Math.round(p * 10) / 10}%`;
const runsOf = (n) => `${n} run${n === 1 ? "" : "s"}`;
const clip = (text, max = 160) => (text.length > max ? `${text.slice(0, max)}...` : text);

/** The comparison as plain lines: a header, one line per wait and per malformed line, and the verdict. */
export function formatComparison(
  rows,
  problems,
  { entries = [], reportOnly = false, source = "" } = {},
) {
  const machines = [...new Set(entries.map((e) => e.machine))];
  const builds = [...new Set(entries.map((e) => e.build))].map((b) =>
    /^[0-9a-f]{40}/.test(b) ? b.slice(0, 12) + b.slice(40) : b,
  );
  const lines = [
    `Timing: ${entries.length} measurement(s) of ${new Set(entries.map((e) => e.scenario)).size} wait(s)` +
      (machines.length ? ` on ${machines.join(", ")}, build ${builds.join(", ")}` : "") +
      (source ? ` (${source})` : ""),
  ];
  if (machines.length > 1)
    lines.push(`  note: measurements from ${machines.length} machines; the budgets are for one PC`);
  for (const row of rows) {
    const tag = row.verdict.padEnd(9);
    if (row.verdict === "PASS") {
      lines.push(
        `  ${tag} ${row.scenario}: ${whole(row.ms)}, budget ${whole(row.budget)} (${runsOf(row.runs)})`,
      );
    } else if (row.verdict === "SLOW") {
      lines.push(
        `  ${tag} ${row.scenario}: ${whole(row.ms)}, ${whole(row.overMs)} (${percent(row.overPct)}) over its ` +
          `${whole(row.budget)} budget (${runsOf(row.runs)})`,
      );
    } else if (row.verdict === "NEW") {
      lines.push(`  ${tag} ${row.scenario}: ${whole(row.ms)} (${runsOf(row.runs)}), no budget yet`);
    } else
      lines.push(`  ${tag} ${row.scenario}: budget ${whole(row.budget)}, not measured in this run`);
  }
  for (const problem of problems) {
    lines.push(`  MALFORMED line ${problem.line}: ${problem.reason}: ${clip(problem.text)}`);
  }
  const v = verdictOf(rows, problems);
  const why = [
    v.slow && `${v.slow} slow`,
    v.missing && `${v.missing} missing`,
    v.malformed && `${v.malformed} malformed`,
    !v.measured && "nothing was measured",
  ].filter(Boolean);
  const label = reportOnly ? "Verdict (report only, never fails here)" : "Verdict";
  lines.push(
    `${label}: ${v.ok ? "PASS" : `FAIL (${why.join(", ")})`}${v.new ? `; ${v.new} new wait(s) with no budget` : ""}`,
  );
  return lines;
}

// ---- pure: calibration -----------------------------------------------------------------------------------------

/** A budget for each wait that has none: the median of its runs on `machine` plus HEADROOM, in whole ms (at least 1).
 *  A wait that already has a budget keeps it, whatever it measured. */
export function calibrateBudgets(
  entries,
  budgets,
  { machine = null, minSamples = MIN_SAMPLES } = {},
) {
  const mine = machine === null ? entries : entries.filter((entry) => entry.machine === machine);
  const next = new Map(budgets);
  const added = [];
  const kept = [];
  const tooFew = [];
  for (const [scenario, values] of byScenario(mine)) {
    const ms = median(values);
    if (budgets.has(scenario))
      kept.push({ scenario, budget: budgets.get(scenario), ms, runs: values.length });
    else if (values.length < minSamples) tooFew.push({ scenario, runs: values.length });
    else {
      // The epsilon keeps a float product such as 5 * 1.2 = 6.000000000000001 from rounding up a whole millisecond.
      const budget = Math.max(1, Math.ceil(ms * (1 + HEADROOM) - 1e-9));
      next.set(scenario, budget);
      added.push({ scenario, ms, budget, runs: values.length });
    }
  }
  return { budgets: next, added, kept, tooFew, otherMachines: entries.length - mine.length };
}

// ---- finding and running the timed tests -------------------------------------------------------------------------

const TIMING_IMPORT =
  /\bfrom\s+["'](?:\.{1,2}\/)+(?:[\w-][\w.-]*\/)*lib\/timing(?:\.mjs|\.ts)?["']/;

/** Whether a test's source imports the shared timing helper (e2e/lib/timing). */
export function importsTiming(source) {
  return TIMING_IMPORT.test(source);
}

function filesUnder(dir, keep) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(full, keep));
    else if (keep(entry.name)) found.push(full);
  }
  return found.sort();
}

/** The timed tests: Playwright specs under e2e/ui and node lanes under e2e/desktop that import e2e/lib/timing. */
export function discoverTimedTests(root = ROOT) {
  const timed = (file) => importsTiming(readFileSync(file, "utf8"));
  return {
    browser: filesUnder(path.join(root, "e2e", "ui"), (name) => name.endsWith(".spec.ts")).filter(
      timed,
    ),
    desktop: filesUnder(path.join(root, "e2e", "desktop"), (name) =>
      name.endsWith(".desktop.mjs"),
    ).filter(timed),
  };
}

const sizeOf = (file) => (existsSync(file) ? statSync(file).size : 0);
function textFrom(file, offset) {
  const size = sizeOf(file);
  if (size <= offset) return "";
  const buffer = Buffer.alloc(size - offset);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buffer, 0, buffer.length, offset);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("utf8");
}

function killTree(pid) {
  if (process.platform === "win32")
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function runChild(command, args, { cwd, env, timeoutMs, stdio }) {
  return new Promise((resolve) => {
    const began = Date.now();
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, { cwd, env, stdio });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    const done = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, timedOut, error, seconds: Math.round((Date.now() - began) / 100) / 10 });
    };
    child.on("error", (error) => done(1, error.message));
    child.on("exit", (code) => done(code ?? 1));
  });
}

/** Runs every timed test `runs` times, round by round, appending to `results`. Returns each step's outcome and the
 *  measurements it wrote, and the lanes that could not run. */
export async function runTimedTests({
  root = ROOT,
  runs = 3,
  lanes = ["browser", "desktop"],
  results,
  timeoutMs = 15 * 60_000,
  log = console.log,
  stdio = "inherit",
}) {
  const found = discoverTimedTests(root);
  const rel = (file) => path.relative(root, file).split(path.sep).join("/");
  const steps = [];
  const notRun = [];
  if (lanes.includes("browser")) {
    const cli = path.join(root, "node_modules", "@playwright", "test", "cli.js");
    if (!found.browser.length) log("browser lane: no timed spec under e2e/ui yet");
    else if (!existsSync(cli)) {
      notRun.push(
        `browser lane: @playwright/test is not installed in ${root} (see playwright.config.ts)`,
      );
    } else {
      steps.push({
        name: `browser: ${found.browser.map(rel).join(", ")}`,
        command: process.execPath,
        args: [cli, "test", ...found.browser.map(rel), "--reporter=list"],
      });
    }
  }
  if (lanes.includes("desktop")) {
    if (!found.desktop.length) log("desktop lane: no timed lane under e2e/desktop yet");
    for (const file of found.desktop)
      steps.push({ name: `desktop: ${rel(file)}`, command: process.execPath, args: [file] });
  }
  mkdirSync(path.dirname(results), { recursive: true });
  const env = { ...process.env, [TIMING_FILE_ENV]: results };
  const outcomes = [];
  for (let round = 1; round <= runs; round += 1) {
    for (const step of steps) {
      log(`\n=== round ${round}/${runs}: ${step.name}`);
      const offset = sizeOf(results);
      const run = await runChild(step.command, step.args, { cwd: root, env, timeoutMs, stdio });
      const written = parseResults(textFrom(results, offset));
      const ok =
        run.code === 0 && !run.timedOut && written.entries.length > 0 && !written.problems.length;
      const why = run.timedOut
        ? `timed out after ${timeoutMs / 60_000} min`
        : run.code !== 0
          ? `exit ${run.code}${run.error ? ` (${run.error})` : ""}`
          : !written.entries.length
            ? "passed but recorded no timing"
            : written.problems.length
              ? `wrote ${written.problems.length} malformed line(s)`
              : "";
      outcomes.push({
        round,
        name: step.name,
        ok,
        why,
        seconds: run.seconds,
        entries: written.entries,
      });
      log(
        `=== ${ok ? "ok" : "FAILED"}: ${step.name}, ${written.entries.length} timing(s), ${run.seconds} s${why ? `: ${why}` : ""}`,
      );
    }
  }
  return { results, outcomes, notRun };
}

// ---- command line ----------------------------------------------------------------------------------------------

const FLAGS = new Set(["report-only"]);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) positional.push(arg);
    else if (arg.includes("="))
      flags[arg.slice(2, arg.indexOf("="))] = arg.slice(arg.indexOf("=") + 1);
    else if (FLAGS.has(arg.slice(2))) flags[arg.slice(2)] = true;
    else if (i + 1 < argv.length) flags[arg.slice(2)] = argv[(i += 1)];
    else throw new Error(`${arg} needs a value`);
  }
  return { flags, positional };
}

const isCI = (env) => !!env.CI && env.CI !== "false" && env.CI !== "0";
const positiveInt = (value, name) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`--${name} must be a whole number of 1 or more, not ${value}`);
  return n;
};
const lanesOf = (value = "browser,desktop") => {
  const lanes = value
    .split(",")
    .map((lane) => lane.trim())
    .filter(Boolean);
  const unknown = lanes.filter((lane) => lane !== "browser" && lane !== "desktop");
  if (!lanes.length || unknown.length)
    throw new Error(`--lanes takes browser and/or desktop, not ${value}`);
  return lanes;
};
const freshResults = () =>
  path.join(
    os.tmpdir(),
    "artdaddy-timing",
    `run-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
  );

function readBudgets(file) {
  if (!existsSync(file)) return { budgets: new Map(), problems: [] };
  return parseBudgets(readFileSync(file, "utf8"));
}

function compareCommand(flags, positional) {
  const source = positional[0];
  if (!source) throw new Error("compare needs a results file");
  const reportOnly = flags["report-only"] === true || isCI(process.env);
  const budgetsFile = path.resolve(flags.budgets ?? BUDGETS_FILE);
  const { budgets, problems: budgetProblems } = readBudgets(budgetsFile);
  if (budgetProblems.length) {
    console.error(
      `The budgets file ${budgetsFile} is malformed:\n  ${budgetProblems.join("\n  ")}`,
    );
    return 2;
  }
  let lines;
  let ok;
  if (!existsSync(source)) {
    lines = [
      `Timing: no results file at ${source}: nothing was measured`,
      `Verdict${reportOnly ? " (report only)" : ""}: FAIL (nothing was measured)`,
    ];
    ok = false;
  } else {
    const { entries, problems } = parseResults(readFileSync(source, "utf8"));
    const rows = compareTimings(entries, budgets);
    lines = formatComparison(rows, problems, { entries, reportOnly, source });
    ok = verdictOf(rows, problems).ok;
  }
  console.log(lines.join("\n"));
  if (flags.report) {
    const report = path.resolve(flags.report);
    mkdirSync(path.dirname(report), { recursive: true });
    writeFileSync(report, `${lines.join("\n")}\n`, "utf8");
  }
  return reportOnly || ok ? 0 : 1;
}

async function runCommand(flags) {
  const results = path.resolve(flags.results ?? process.env[TIMING_FILE_ENV] ?? freshResults());
  const out = await runTimedTests({
    runs: positiveInt(flags.runs ?? 3, "runs"),
    lanes: lanesOf(flags.lanes),
    results,
    timeoutMs: positiveInt(flags["timeout-min"] ?? 15, "timeout-min") * 60_000,
  });
  return summarise(out);
}

function summarise({ results, outcomes, notRun }) {
  const failed = outcomes.filter((outcome) => !outcome.ok);
  console.log(
    `\nTimed runs: ${outcomes.length - failed.length} of ${outcomes.length} ok. Results: ${results}`,
  );
  for (const outcome of failed)
    console.log(`  FAILED round ${outcome.round}: ${outcome.name}: ${outcome.why}`);
  for (const line of notRun) console.log(`  NOT RUN ${line}`);
  return failed.length || notRun.length ? 1 : 0;
}

async function calibrateCommand(flags) {
  const budgetsFile = path.resolve(flags.budgets ?? BUDGETS_FILE);
  const { budgets, problems: budgetProblems } = readBudgets(budgetsFile);
  if (budgetProblems.length) {
    console.error(
      `The budgets file ${budgetsFile} is malformed:\n  ${budgetProblems.join("\n  ")}`,
    );
    return 2;
  }
  let entries;
  let status = 0;
  if (flags.from) {
    const parsed = parseResults(readFileSync(path.resolve(flags.from), "utf8"));
    if (parsed.problems.length) {
      for (const p of parsed.problems)
        console.error(`  MALFORMED line ${p.line}: ${p.reason}: ${clip(p.text)}`);
      console.error(
        `Not calibrating from ${flags.from}: fix or remove the malformed line(s) first.`,
      );
      return 1;
    }
    entries = parsed.entries;
  } else {
    const out = await runTimedTests({
      runs: positiveInt(flags.runs ?? 5, "runs"),
      lanes: lanesOf(flags.lanes),
      results: path.resolve(flags.results ?? freshResults()),
      timeoutMs: positiveInt(flags["timeout-min"] ?? 15, "timeout-min") * 60_000,
    });
    status = summarise(out);
    entries = out.outcomes.filter((outcome) => outcome.ok).flatMap((outcome) => outcome.entries);
  }
  const result = calibrateBudgets(entries, budgets, { machine: os.hostname() });
  console.log(
    `\nCalibration on ${os.hostname()} (median + ${HEADROOM * 100}%, from ${MIN_SAMPLES}+ ` +
      `${flags.from ? `measurements in ${flags.from}` : "runs of a test that passed"}):`,
  );
  for (const a of result.added)
    console.log(
      `  ADDED  ${a.scenario}: ${a.budget} ms (median ${whole(a.ms)} of ${runsOf(a.runs)})`,
    );
  for (const k of result.kept)
    console.log(
      `  KEPT   ${k.scenario}: ${k.budget} ms (measured ${whole(k.ms)} now; delete its line to measure it again)`,
    );
  for (const t of result.tooFew)
    console.log(`  SKIPPED ${t.scenario}: ${runsOf(t.runs)}, needs ${MIN_SAMPLES}`);
  if (result.otherMachines)
    console.log(`  ignored ${result.otherMachines} measurement(s) from other machines`);
  if (result.added.length) {
    writeFileSync(budgetsFile, formatBudgets(result.budgets), "utf8");
    console.log(`Wrote ${budgetsFile}`);
  } else console.log("No budget added.");
  return status;
}

async function main(argv) {
  const [command, ...rest] = argv;
  const { flags, positional } = parseArgs(rest);
  if (command === "compare") return compareCommand(flags, positional);
  if (command === "run") return runCommand(flags);
  if (command === "calibrate") return calibrateCommand(flags);
  console.error(
    "usage: node scripts/qa/timingBudgets.mjs compare <results.jsonl> | run | calibrate (see the header)",
  );
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(2);
    },
  );
}
