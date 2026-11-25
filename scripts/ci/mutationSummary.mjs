// Say what a Stryker run found: the score, where it is weakest, and the files to look at first.
//
// The weekly mutation job (.github/workflows/mutation-weekly.yml) runs Stryker with a JSON report. This reads that
// report and puts three things on the run page, so nobody has to open the HTML to know how the week went:
//   - the total score and the counts behind it,
//   - the score of each folder (src/timeline, src/tools, ...),
//   - the ten weakest files (the places where a test would not notice a bug).
//
//   node scripts/ci/mutationSummary.mjs reports/mutation/mutation.json
//   node scripts/ci/mutationSummary.mjs --shards '["tools-01","rest"]' reports/shards/*/mutation.json
//
// The second form is the last job of the run: it puts the shards' reports together, and names every shard the run
// started that sent no report.
//
// A report job, not a gate: it exits 0 whatever the score is. A report it cannot read, or one with no mutants in
// it, is an error: an empty result must never look like a clean one. So is a shard that sent no report.
//
// The score is Stryker's own: detected (killed or timed out) over valid (detected plus survived plus no coverage).
// Mutants that did not compile, crashed the runner, or were ignored are not valid and are left out.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DETECTED = new Set(["Killed", "Timeout"]);

/** A file needs at least this many valid mutants to be ranked: a file with two mutants scores 0 or 50 by luck. */
export const MIN_MUTANTS_TO_RANK = 10;
export const WEAKEST = 10;

const percent = (detected, valid) => (valid === 0 ? null : (100 * detected) / valid);

function tally(mutants) {
  const t = { detected: 0, survived: 0, noCoverage: 0, excluded: 0, total: 0 };
  for (const m of mutants) {
    t.total += 1;
    if (DETECTED.has(m.status)) t.detected += 1;
    else if (m.status === "Survived") t.survived += 1;
    else if (m.status === "NoCoverage") t.noCoverage += 1;
    else t.excluded += 1;
  }
  t.valid = t.detected + t.survived + t.noCoverage;
  t.score = percent(t.detected, t.valid);
  return t;
}

/** The folder a file is reported under: its first two path segments (src/timeline), or the first when it has one. */
export const folderOf = (path) =>
  path
    .split("/")
    .slice(0, 2)
    .join("/")
    .replace(/\.[a-z]+$/i, "");

/** Everything the summary says, as data. `report` is a Stryker JSON report (mutation-testing-report-schema). */
export function summarize(report) {
  const entries = Object.entries(report?.files ?? {}).map(([path, f]) => ({
    path,
    mutants: f?.mutants ?? [],
  }));
  const files = entries.map(({ path, mutants }) => ({ path, ...tally(mutants) }));
  const total = tally(entries.flatMap((e) => e.mutants));
  const folders = new Map();
  for (const { path, mutants } of entries) {
    const key = folderOf(path);
    folders.set(key, (folders.get(key) ?? []).concat(mutants));
  }
  const byFolder = [...folders]
    .map(([folder, mutants]) => ({ folder, ...tally(mutants) }))
    .sort((a, b) => (a.score ?? 101) - (b.score ?? 101) || a.folder.localeCompare(b.folder));
  const weakest = files
    .filter((f) => f.valid >= MIN_MUTANTS_TO_RANK)
    .sort(
      (a, b) =>
        a.score - b.score ||
        b.survived + b.noCoverage - (a.survived + a.noCoverage) ||
        a.path.localeCompare(b.path),
    )
    .slice(0, WEAKEST);
  return { total, byFolder, weakest, fileCount: files.length };
}

const fmt = (score) => (score === null ? "n/a" : `${score.toFixed(1)}%`);

export function summaryMarkdown(s, { title = "Mutation report" } = {}) {
  const t = s.total;
  const lines = [
    `### ${title}`,
    "",
    `**Mutation score ${fmt(t.score)}** over ${s.fileCount} files: ${t.detected} caught, ${t.survived} survived, ${t.noCoverage} not covered by any test` +
      (t.excluded
        ? `, ${t.excluded} left out (did not compile, crashed the runner or ignored).`
        : "."),
    "",
    "| Folder | Score | Caught | Survived | Not covered |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...s.byFolder.map(
      (f) => `| ${f.folder} | ${fmt(f.score)} | ${f.detected} | ${f.survived} | ${f.noCoverage} |`,
    ),
    "",
    `**The ${s.weakest.length} weakest files** (at least ${MIN_MUTANTS_TO_RANK} mutants each; a survivor is a bug the tests would not notice):`,
    "",
    "| File | Score | Survived | Not covered |",
    "| --- | ---: | ---: | ---: |",
    ...s.weakest.map((f) => `| ${f.path} | ${fmt(f.score)} | ${f.survived} | ${f.noCoverage} |`),
  ];
  return lines.join("\n") + "\n";
}

/** Several Stryker reports as one: the shards of a run write one report each, over files that do not overlap. */
export function mergeReports(reports) {
  return { files: Object.assign({}, ...reports.map((r) => r?.files ?? {})) };
}

/** The shard a report came from: the workflow downloads each shard's report into a folder `mutation-<shard>`. */
export const shardOfReport = (path) =>
  String(path)
    .split(/[\\/]/)
    .slice(-2, -1)[0]
    ?.replace(/^mutation-/, "");

/**
 * Read the report file(s) and put their summary on the page. Returns the exit code: 0, or 1 when a report is
 * missing, unreadable or empty, or when one of the `shards` the run started sent no report (a shard that hits its
 * time limit writes none): those are named. Whatever did arrive is still summarised, so a partial week is visible
 * and not silent.
 */
export function reportMutation(
  paths,
  {
    out = (text) => process.stdout.write(text),
    summaryFile = process.env.GITHUB_STEP_SUMMARY,
    shards = [],
  } = {},
) {
  const list = [].concat(paths ?? []).filter(Boolean);
  const reports = [];
  const arrived = new Set();
  const problems = list.length === 0 ? ["no report path was given"] : [];
  for (const path of list) {
    if (!existsSync(path)) {
      problems.push(`no report at ${path}`);
      continue;
    }
    try {
      reports.push(JSON.parse(readFileSync(path, "utf8")));
      arrived.add(shardOfReport(path));
    } catch (e) {
      problems.push(`${path} is not readable JSON (${e.message})`);
    }
  }
  const missing = shards.filter((shard) => !arrived.has(shard));
  const s = summarize(mergeReports(reports));
  if (s.total.total === 0) {
    const lines = [
      ...problems,
      ...(missing.length ? [`no report from ${missing.join(", ")}`] : []),
      "the reports hold no mutants, so the run tested nothing",
    ];
    out(lines.map((p) => `mutationSummary: ${p}\n`).join(""));
    return 1;
  }
  let md = summaryMarkdown(s);
  if (missing.length) {
    md += `\n**${missing.length} of ${shards.length} shards sent no report: ${missing.join(", ")}** (a shard that hits its time limit or crashes writes none), so this covers part of the scope.\n`;
  }
  out(md + problems.map((p) => `mutationSummary: ${p}\n`).join(""));
  if (summaryFile) appendFileSync(summaryFile, md + "\n");
  return missing.length || problems.length ? 1 : 0;
}

/** The shards a run started, as the workflow hands them over: a JSON list of names. Anything else is an error. */
export function parseShards(text) {
  const shards = JSON.parse(text);
  if (
    !Array.isArray(shards) ||
    shards.length === 0 ||
    !shards.every((s) => typeof s === "string" && s)
  ) {
    throw new Error(`--shards needs a JSON list of shard names, not ${text}`);
  }
  return shards;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let shards = [];
  const at = args.indexOf("--shards");
  if (at >= 0) {
    try {
      shards = parseShards(args[at + 1]);
    } catch (e) {
      process.stdout.write(
        `mutationSummary: the list of shards the run started is missing or wrong (${e.message})\n`,
      );
      process.exit(1);
    }
    args.splice(at, 2);
  }
  process.exit(reportMutation(args, { shards }));
}
