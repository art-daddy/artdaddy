// Say, on the run itself, which browser tests passed only because they were run again.
//
// macOS CI runs a failed test again on a fresh page (src/test/browserRunPolicy.ts). That keeps one
// stumble of a GPU-less VM from turning the whole run red, but a run that is green BECAUSE of a retry
// has to say so, or the retry becomes a place for a real intermittent bug to hide. Playwright's own
// report already marks such a test "flaky"; nothing printed it. This reads that report and puts every
// one of them on the run page:
//   - a ::warning:: annotation per test (the first 10: GitHub shows no more than that per step),
//   - a table in the job summary,
//   - one plain line in the log either way, so a clean run is visibly a clean one.
//
//   node scripts/ci/browserFlakeReport.mjs reports/qa/browser/results.json
//
// Advisory: it exits 0 whatever it finds. Only a report it cannot read at all is an error.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ANSI = /\u001b\[[0-9;]*m/g;
const FAILED = new Set(["failed", "timedOut"]);

/** GitHub shows at most this many warning annotations for one step. */
export const MAX_ANNOTATIONS = 10;

/** The start of an error, enough to tell what it was without opening a trace: Playwright puts the verdict
 *  on the first line and the numbers ("Expected: > 150", "Received: 0") on the next two. */
const errorExcerpt = (message) =>
  String(message ?? "")
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .slice(0, 3)
    .join(" | ")
    .slice(0, 240);

/** Every test of a Playwright JSON report that failed and then passed. Playwright calls it "flaky" and
 *  puts that in `status`; a test whose every attempt failed is "unexpected" and is NOT listed here: that
 *  one is a failure, and the run is red for it. */
export function flakyTests(playwrightReport) {
  const found = [];
  const walk = (suites, trail) => {
    for (const suite of suites ?? []) {
      // The top suite of a file is titled with the file name, which `location` already says.
      const here = suite.title && suite.title !== suite.file ? [...trail, suite.title] : trail;
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          if (test.status !== "flaky") continue;
          const failed = (test.results ?? []).filter((r) => FAILED.has(r.status));
          found.push({
            project: test.projectName ?? "",
            location: `${spec.file ?? "?"}:${spec.line ?? 0}`,
            title: [...here, spec.title ?? ""].join(" › "),
            failedAttempts: failed.length,
            firstError: errorExcerpt(failed.find((r) => r.error?.message)?.error?.message),
          });
        }
      }
      walk(suite.suites, here);
    }
  };
  walk(playwrightReport?.suites, []);
  return found;
}

/** A value for a workflow command's message: `%`, CR and LF would end or corrupt the command. */
export const escapeData = (text) => String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
/** A value for a workflow command's property (title=...): also `:` and `,`, which delimit properties. */
export const escapeProperty = (text) => escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The workflow commands that put `flaky` on the run page. */
export function annotations(flaky, os = "") {
  const title = escapeProperty(`Flaky browser test${os ? ` (${os})` : ""}`);
  const lines = flaky
    .slice(0, MAX_ANNOTATIONS)
    .map(
      (t) =>
        `::warning title=${title}::${escapeData(
          `${t.project} › ${t.location} › ${t.title}: failed ${plural(t.failedAttempts, "attempt")}, then passed.${t.firstError ? ` First error: ${t.firstError}` : ""}`,
        )}`,
    );
  if (flaky.length > MAX_ANNOTATIONS)
    lines.push(`::notice title=${title}::${flaky.length - MAX_ANNOTATIONS} more are in the job summary`);
  return lines;
}

const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** The job-summary section for `flaky`. */
export function summaryMarkdown(flaky, os = "") {
  const rows = flaky.map(
    (t) => `| ${cell(t.project)} | \`${cell(t.location)}\` ${cell(t.title)} | ${t.failedAttempts} | ${cell(t.firstError)} |`,
  );
  return [
    `### Browser tests that passed only on a retry${os ? ` (${os})` : ""}`,
    "",
    `${plural(flaky.length, "test")} failed and then passed on a fresh page, so this run is green because of the retry. A test that keeps showing up here is a real intermittent failure, not runner noise.`,
    "",
    "| project | test | failed attempts | first error |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

/** Reads the report at `path`, writes what it finds through `io`, and returns the exit code. */
export function reportFlakyTests(path, env, io) {
  if (!io.exists(path)) {
    io.log(`No browser report at ${path}: the browser step ended before it wrote one, so there is nothing to list.`);
    return 0;
  }
  let parsed;
  try {
    parsed = JSON.parse(io.read(path));
  } catch (error) {
    io.log(`::error title=Browser flake report::${escapeData(`${path} is not readable JSON: ${error.message}`)}`);
    return 1;
  }
  if (!Array.isArray(parsed?.suites)) {
    io.log(`::error title=Browser flake report::${escapeData(`${path} is not a Playwright JSON report (it has no suites)`)}`);
    return 1;
  }
  const os = env.RUNNER_OS ?? "";
  const flaky = flakyTests(parsed);
  const stats = parsed.stats ?? {};
  const retries = parsed.config?.projects?.[0]?.retries ?? 0;
  io.log(
    `Browser tests: ${stats.expected ?? 0} passed, ${stats.flaky ?? 0} passed only on a retry, ${stats.unexpected ?? 0} failed, ${stats.skipped ?? 0} skipped; retries per failed test: ${retries}.`,
  );
  if (!flaky.length) return 0;
  for (const line of annotations(flaky, os)) io.log(line);
  if (env.GITHUB_STEP_SUMMARY) io.summary(env.GITHUB_STEP_SUMMARY, summaryMarkdown(flaky, os));
  return 0;
}

const realIo = {
  exists: existsSync,
  read: (path) => readFileSync(path, "utf8"),
  log: (line) => console.log(line),
  summary: (file, text) => appendFileSync(file, `${text}\n`),
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node scripts/ci/browserFlakeReport.mjs <path to Playwright results.json>");
    process.exit(2);
  }
  process.exit(reportFlakyTests(path, process.env, realIo));
}
