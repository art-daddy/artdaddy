// Summarise every QA run found under reports/qa/exporter. Run it from the root of the checkout the runs were made in (it reads that checkout's
// scripts/qa/exporterPromiseCases.json): node <this file>
// It reads the harness's own result files and judges nothing the harness did not record. A copy of windows/qa-summary.mjs of the private QA
// results branch, kept byte-for-byte after this comment so a run summarised in CI reads exactly like one summarised on a device.
import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const MIB = 2 ** 20;
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
/** Why an export job stopped, read from the job ledger the product keeps in the run's temp folder (the harness leaves it behind on failure). */
function ledgerReason(root) {
  const ledger = root ? path.join(root, "compiled-project", "internals", "jobs.json") : null;
  if (!ledger || !existsSync(ledger)) return null;
  let job;
  try {
    job = JSON.parse(readFileSync(ledger, "utf8")).jobs.find((entry) => String(entry.label).includes("promise"));
  } catch {
    return null;
  }
  if (!job) return null;
  const text = String(job.error ?? "");
  const parts = [`job ${job.status} after ${round((job.ended_at - job.started_at) / 1000)}s`];
  const malloc = /malloc of size (\d+) failed/.exec(text);
  if (malloc) parts.push(`an allocation of ${round(Number(malloc[1]) / MIB)} MiB failed`);
  const commit = /configured_commit=(\d+), reported_peak=(\d+)/.exec(text);
  if (commit) parts.push(`commit peak ${round(Number(commit[2]) / 2 ** 30, 2)} of ${round(Number(commit[1]) / 2 ** 30, 2)} GiB`);
  const resident = /"sampled_peak":(\d+)/.exec(text);
  if (resident) parts.push(`resident peak ${round(Number(resident[1]) / 2 ** 30, 2)} GiB`);
  if (/resident memory budget exceeded/.test(text)) parts.push("RESIDENT BUDGET EXCEEDED");
  if (parts.length === 1) parts.push(text.replace(/\s+/g, " ").slice(0, 200) || "no error text");
  return parts.join("; ");
}

const directory = path.resolve("reports/qa/exporter");
const library = JSON.parse(await readFile("scripts/qa/exporterPromiseCases.json", "utf8"));
const load = async (file) => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
};
const seconds = (ms) => (Number.isFinite(ms) ? Math.round(ms / 1000) : null);
const gib = (bytes) => (Number.isFinite(bytes) ? (bytes / 2 ** 30).toFixed(2) : "-");
const folders = (await readdir(directory, { withFileTypes: true }).catch(() => []))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const rows = [];
let hardware = null;
for (const folder of folders) {
  const result = await load(path.join(directory, folder, "promise-library.json"));
  if (!result?.caseId) continue;
  const report = await load(path.join(directory, folder, "report.json"));
  hardware ??= report?.hardware ?? null;
  const definition = library.cases.find((entry) => entry.id === result.caseId);
  const length = definition?.durationSeconds;
  const times = (s) => (s === null ? "-" : length ? `${s}s (${(s / length).toFixed(2)}x video length)` : `${s}s`);

  // A finished promise line holds two passes: the cold one nested, the repeat one at the top level. A pilot or measurement has one.
  // A run that stopped has none: its elapsedMs is the WHOLE run (set-up, recovery and every export that finished), not an export.
  const passes = result.coldPass ? [["cold", result.coldPass], ["repeat", result]] : result.pass ? [["only", result]] : [];
  const limit = result.profile === "16gb" ? (definition?.speedFactor16gb ?? null) : null;
  const error = String(result.error ?? report?.error ?? "").replace(/\s+/g, " ").slice(0, 400);

  let verdict;
  if (result.status === "blocked-source") verdict = "BLOCKED (source)";
  else if (report && report.ok === false)
    verdict = /cold pass is not cold/.test(error) ? "VOID (an earlier run's history reached this run)" : "ERROR";
  else if (result.kind === "promise") verdict = result.passed ? "PASS" : "NOT PASSED";
  else verdict = result.artifactVerified ? "OK (not a pass/fail line)" : "FAILED";

  const why = [];
  if (verdict === "NOT PASSED") {
    if (!result.artifactVerified) why.push("output not verified");
    if (!result.profileEnforced) why.push("this machine's memory does not match the memory class (informational only)");
    if (result.timingQualified === false) why.push("slower than the speed limit");
    if (result.temporarySpaceQualified === false)
      why.push(`temporary space: ${(result.temporarySpaceFailures ?? []).join("; ") || "not qualified"}`);
    if (result.estimateProvided === false)
      why.push(`time estimate: ${(result.estimateFailures ?? []).join("; ") || "missing"}`);
  }
  const detail = passes.map(([name, pass]) => {
    const kill = pass.resources?.budgets?.memoryBytes;
    const peak = pass.localCalibration?.memoryBytes;
    return {
      name,
      time: times(seconds(pass.elapsedMs)),
      asked: Array.isArray(pass.preflight) ? pass.preflight.length : "?",
      history: pass.historySamples ?? "?",
      estimate: Number.isFinite(pass.estimateSeconds) ? `${Math.round(pass.estimateSeconds)}s` : "none",
      peak: gib(peak),
      killShare: Number.isFinite(peak) && Number.isFinite(kill) ? `${Math.round((peak / kill) * 100)}%` : "-",
      available: gib(pass.resources?.available_memory_bytes),
      engine: pass.selection?.backend ?? "-",
      origin: pass.pageOrigin ?? null,
    };
  });
  rows.push({
    folder,
    id: result.caseId,
    profile: result.profile ?? "-",
    verdict,
    detail,
    stopped: passes.length ? null : seconds(result.elapsedMs ?? report?.elapsedMs),
    limit: limit === null ? "none" : `${limit}x video length`,
    frames: result.encodedVideo?.frames ?? "-",
    why: why.join(" | "),
    reason: passes.length ? null : ledgerReason(report?.root),
    error,
  });
}

if (hardware)
  console.log(
    `Machine: ${hardware.platform} ${hardware.arch}, ${String(hardware.cpu ?? "").trim()}, ${hardware.logicalCpus ?? "?"} logical processors, ${Math.round((hardware.totalMemoryBytes ?? 0) / 2 ** 30)} GB memory\n`,
  );
if (!rows.length) console.log("No QA results found under reports/qa/exporter");
for (const row of rows) {
  console.log(`${row.id} [${row.profile}] -> ${row.verdict}`);
  if (row.detail.length) {
    console.log(`    ${row.detail.map((d) => `${d.name} export: ${d.time}`).join("; ")}; speed limit: ${row.limit}; frames: ${row.frames}`);
    for (const d of row.detail)
      console.log(
        `    ${d.name}: engine ${d.engine}, confirmations shown ${d.asked}, comparable history at start ${d.history}, estimate ${d.estimate}; worker memory peak ${d.peak} GiB (${d.killShare} of the cutoff); machine "available" memory at start ${d.available} GiB${d.origin ? `; page ${d.origin}` : ""}`,
      );
  } else if (row.stopped !== null) console.log(`    stopped after ${row.stopped}s (the whole run, setup and finished exports included; not an export time)`);
  if (row.why) console.log(`    why not passed: ${row.why}`);
  if (row.reason) console.log(`    why it stopped (the app's own job ledger): ${row.reason}`);
  if (row.error) console.log(`    error: ${row.error}`);
  console.log(`    folder: reports/qa/exporter/${row.folder}`);
}
const counts = {};
for (const row of rows) counts[row.verdict] = (counts[row.verdict] ?? 0) + 1;
const describe = (tally) => Object.entries(tally).map(([name, n]) => `${name}=${n}`).join(", ") || "none";
// Folder names carry the run's start time, so the last row of a line is its newest attempt; an older failure it replaced is history.
const newest = new Map();
for (const row of rows) newest.set(`${row.id}|${row.profile}`, row);
const latest = {};
for (const row of newest.values()) latest[row.verdict] = (latest[row.verdict] ?? 0) + 1;
console.log(`\nNewest run of each line: ${newest.size} lines; ${describe(latest)}`);
console.log(`Totals (every attempt still in reports/): ${rows.length} runs; ${describe(counts)}`);
