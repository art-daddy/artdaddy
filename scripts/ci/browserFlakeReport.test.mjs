import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  annotations,
  escapeData,
  escapeProperty,
  flakyTests,
  reportFlakyTests,
  summaryMarkdown,
} from "./browserFlakeReport.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// Both are real macOS CI reports (run 40679950578), trimmed; see each file's _provenance.
const real = (name) => JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
const hookTimeout = () => real("browser-report-hook-timeout.json");
const pixelFailure = () => real("browser-report-pixel-failure.json");

const tests = (report) => {
  const found = [];
  const walk = (suites) => {
    for (const suite of suites) {
      for (const spec of suite.specs) for (const test of spec.tests) found.push({ spec, test });
      walk(suite.suites);
    }
  };
  walk(report.suites);
  return found;
};

/** What Playwright records when a failed attempt is followed by a passing one: the failed attempt(s) as
 *  they were, then a pass, and the test marked "flaky". Built FROM a real failing test, so every other
 *  field is the real schema's. */
function passedOnRetry(test, retries = 1) {
  const failed = test.results.filter((r) => r.status === "failed" || r.status === "timedOut");
  const pass = { ...structuredClone(failed[0]), status: "passed", retry: failed.length, duration: 1234 };
  delete pass.error;
  test.results = [...test.results, ...Array.from({ length: retries - 1 }, (_, i) => ({ ...structuredClone(failed[0]), retry: failed.length + i })), pass];
  test.status = "flaky";
}
const unexpectedTests = (report) => tests(report).filter(({ test }) => test.status === "unexpected");

function flakyHookReport() {
  const report = hookTimeout();
  for (const { test } of unexpectedTests(report)) passedOnRetry(test);
  // The hook's siblings were skipped on the first attempt and passed once the group re-ran.
  for (const { test } of tests(report).filter(({ test }) => test.status === "skipped" && test.expectedStatus === "passed")) {
    test.results.push({ ...structuredClone(test.results[0]), status: "passed", retry: 1 });
    test.status = "expected";
  }
  for (const project of report.config.projects) project.retries = 2;
  return report;
}

const memoryIo = (files = {}) => {
  const lines = [];
  const summaries = [];
  return {
    lines,
    summaries,
    exists: (path) => path in files,
    read: (path) => files[path],
    log: (line) => lines.push(line),
    summary: (file, text) => summaries.push({ file, text }),
  };
};

describe("the browser tests that passed only on a retry are listed", () => {
  it("lists a test whose beforeAll hook failed once and passed after the group re-ran, and nothing else", () => {
    const flaky = flakyTests(flakyHookReport());
    expect(flaky).toEqual([
      {
        project: "chromium",
        location: "rotation.spec.ts:192",
        title: "failed calibration selects normalization without waiting for stalled original decoders",
        failedAttempts: 1,
        firstError: '"beforeAll" hook timeout of 480000ms exceeded.',
      },
    ]);
  });

  it("does not list a test that failed on every attempt: that is a failure, and the run is red for it", () => {
    for (const make of [hookTimeout, pixelFailure]) {
      expect(flakyTests(make())).toEqual([]);
      const allFailed = make();
      for (const { test } of unexpectedTests(allFailed)) {
        // Three attempts, all failed: Playwright calls that "unexpected", never "flaky".
        test.results = [0, 1, 2].map((retry) => ({ ...structuredClone(test.results[0]), retry }));
      }
      expect(flakyTests(allFailed)).toEqual([]);
    }
  });

  it("does not list what passed first time, what was skipped, or the siblings a hook failure skipped and a retry then ran", () => {
    // The hook failed, the group re-ran in a fresh worker and EVERYTHING passed on that second try: only
    // the test the hook failure was blamed on is "flaky"; its siblings (skipped, then passed) are not.
    const report = flakyHookReport();
    for (const { test } of tests(report).filter(({ test }) => test.status === "flaky")) test.status = "expected";
    // A test the spec itself skips (test.skip): skipped on every run, expected to be.
    const { spec, test: sibling } = tests(report).find(({ test }) => test.results.map((r) => r.status).join() === "skipped,passed");
    spec.tests.push({ ...structuredClone(sibling), expectedStatus: "skipped", results: [{ ...structuredClone(sibling.results[0]), status: "skipped" }], status: "skipped" });
    expect(flakyTests(report)).toEqual([]);
    const siblings = tests(report).filter(({ test }) => test.results.map((r) => r.status).join() === "skipped,passed");
    expect(siblings.length).toBeGreaterThan(5);
    expect(tests(report).some(({ test }) => test.status === "skipped")).toBe(true);
  });

  it("names the describe a test sits in and the engine it ran in, so two engines are two lines", () => {
    const report = pixelFailure();
    const chosen = unexpectedTests(report);
    expect(chosen.length).toBeGreaterThan(0);
    const { spec, test } = chosen[0];
    passedOnRetry(test);
    // The same spec in a second project (the report holds one test per project in spec.tests).
    const other = structuredClone(test);
    other.projectName = other.projectId = "webkit";
    spec.tests.push(other);
    const flaky = flakyTests(report);
    expect(flaky.map((t) => t.project)).toEqual(["chromium", "webkit"]);
    expect(flaky[0].title).toBe("preview compositor (real WebGL2) › clips the overlay to its layout box");
    expect(flaky[0].location).toBe("preview.spec.ts:88");
  });

  it("keeps the numbers of an assertion and drops the colour codes around them", () => {
    const report = pixelFailure();
    for (const { test } of unexpectedTests(report)) passedOnRetry(test);
    const [first] = flakyTests(report);
    expect(first.firstError).toBe("Error: expect(received).toBeGreaterThan(expected) | Expected: > 150 | Received: 0");
    expect(first.firstError).not.toMatch(/\u001b/);
  });

  it("counts the failed attempts, whatever failed them", () => {
    const report = pixelFailure();
    for (const { test } of unexpectedTests(report)) {
      test.results.push({ ...structuredClone(test.results[0]), status: "timedOut", retry: 1 });
      passedOnRetry(test);
    }
    expect(flakyTests(report)[0].failedAttempts).toBe(2);
  });

  it("finds every flaky test of any report: any nesting, any number of files and projects", () => {
    const specArb = fc.record({
      title: fc.string({ maxLength: 12 }),
      file: fc.string({ minLength: 1, maxLength: 8 }),
      line: fc.integer({ min: 1, max: 900 }),
      tests: fc.array(
        fc.record({
          projectName: fc.constantFrom("chromium", "webkit"),
          status: fc.constantFrom("expected", "unexpected", "flaky", "skipped"),
          results: fc.array(
            fc.record({
              status: fc.constantFrom("passed", "failed", "timedOut", "skipped"),
              error: fc.option(fc.record({ message: fc.string({ maxLength: 40 }) }), { nil: undefined }),
            }),
            { maxLength: 4 },
          ),
        }),
        { maxLength: 3 },
      ),
    });
    const suiteArb = fc.memo((depth) =>
      fc.record({
        title: fc.string({ minLength: 1, maxLength: 8 }),
        file: fc.string({ minLength: 1, maxLength: 8 }),
        specs: fc.array(specArb, { maxLength: 3 }),
        suites: depth <= 0 ? fc.constant([]) : fc.array(suiteArb(depth - 1), { maxLength: 2 }),
      }),
    );
    fc.assert(
      fc.property(fc.array(suiteArb(2), { maxLength: 3 }), (suites) => {
        const expected = [];
        const count = (list) => {
          for (const suite of list) {
            for (const spec of suite.specs) for (const test of spec.tests) if (test.status === "flaky") expected.push(test);
            count(suite.suites);
          }
        };
        count(suites);
        const flaky = flakyTests({ suites });
        expect(flaky).toHaveLength(expected.length);
        const failures = expected.map((t) => t.results.filter((r) => r.status === "failed" || r.status === "timedOut").length);
        expect(flaky.map((t) => t.failedAttempts).sort()).toEqual([...failures].sort());
      }),
      { numRuns: 80 },
    );
  });
});

describe("what lands on the run page", () => {
  const some = (n) =>
    Array.from({ length: n }, (_, i) => ({
      project: "chromium",
      location: `preview.spec.ts:${i + 1}`,
      title: `test ${i}`,
      failedAttempts: 1,
      firstError: "Error: expect(received).toBeGreaterThan(expected) | Received: 0",
    }));

  it("annotates each flaky test once, as a warning, and says which runner it was", () => {
    const lines = annotations(some(3), "macOS");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.startsWith("::warning title=Flaky browser test (macOS)::")).toBe(true);
      expect(line).toContain("failed 1 attempt, then passed.");
    }
  });

  it("annotates only as many as GitHub shows (10 per step), and counts the rest in a notice", () => {
    // 10 is GitHub's own limit on warning annotations per step, not this module's choice: a literal here
    // so that raising the constant cannot make the test agree with itself.
    const lines = annotations(some(14), "macOS");
    expect(lines.filter((l) => l.startsWith("::warning "))).toHaveLength(10);
    expect(lines.at(-1)).toBe("::notice title=Flaky browser test (macOS)::4 more are in the job summary");
    expect(summaryMarkdown(some(14), "macOS").match(/^\| chromium \|/gm)).toHaveLength(14);
    expect(annotations(some(10), "macOS").filter((l) => l.startsWith("::notice"))).toEqual([]);
  });

  it("is always ONE command GitHub parses back to exactly what was meant, whatever the test or the error says", () => {
    // How the runner reads a command: `::name props::message`, properties split on `,`, none holding `:`.
    const unescapeData = (s) => s.replace(/%0D/g, "\r").replace(/%0A/g, "\n").replace(/%25/g, "%");
    const parse = (line) => {
      const m = /^::([a-z-]+) ([^:]*)::(.*)$/s.exec(line);
      if (!m) return null;
      const props = Object.fromEntries(
        m[2].split(",").map((kv) => [kv.slice(0, kv.indexOf("=")), unescapeData(kv.slice(kv.indexOf("=") + 1).replace(/%3A/g, ":").replace(/%2C/g, ","))]),
      );
      return { command: m[1], props, message: unescapeData(m[3]) };
    };
    const text = fc.string({ maxLength: 60 });
    fc.assert(
      fc.property(text, text, text, text, (project, title, error, os) => {
        const [line] = annotations([{ project, location: "a.spec.ts:1", title, failedAttempts: 2, firstError: error }], os);
        expect(line).not.toMatch(/[\r\n]/);
        const command = parse(line);
        expect(command, line).not.toBeNull();
        expect(command.command).toBe("warning");
        expect(command.props).toEqual({ title: `Flaky browser test${os ? ` (${os})` : ""}` });
        expect(command.message).toBe(
          `${project} › a.spec.ts:1 › ${title}: failed 2 attempts, then passed.${error ? ` First error: ${error}` : ""}`,
        );
      }),
      { numRuns: 200 },
    );
  });

  it("escapes and unescapes losslessly, so nothing an error said is lost or turned into a command", () => {
    const unescape = (s) => s.replace(/%0A/g, "\n").replace(/%0D/g, "\r").replace(/%25/g, "%");
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (s) => {
        expect(unescape(escapeData(s))).toBe(s);
        expect(escapeData(s)).not.toMatch(/[\r\n]/);
        expect(escapeProperty(s)).not.toMatch(/[\r\n:,]/);
      }),
      { numRuns: 200 },
    );
    expect(escapeData("100%\r\nnext")).toBe("100%25%0D%0Anext");
    expect(escapeProperty("a:b,c")).toBe("a%3Ab%2Cc");
  });

  it("builds a table whose rows a pipe or a newline in a test name cannot break", () => {
    const md = summaryMarkdown(
      [{ project: "webkit", location: "a|b.spec.ts:7", title: "x | y\nz", failedAttempts: 2, firstError: "bad | worse\nline two" }],
      "macOS",
    );
    const rows = md.split("\n").filter((l) => l.startsWith("| webkit"));
    expect(rows).toHaveLength(1);
    // 4 columns = 5 unescaped pipes; an escaped one (\|) is cell text
    expect(rows[0].replace(/\\\|/g, "").match(/\|/g)).toHaveLength(5);
    expect(md).toContain("### Browser tests that passed only on a retry (macOS)");
  });
});

describe("the step that runs it", () => {
  const flaky = JSON.stringify(flakyHookReport());

  it("lists the flaky test, exits 0 and writes the summary where GitHub asked", () => {
    const io = memoryIo({ "r.json": flaky });
    const code = reportFlakyTests("r.json", { RUNNER_OS: "macOS", GITHUB_STEP_SUMMARY: "S.md" }, io);
    expect(code).toBe(0);
    expect(io.lines.some((l) => l.startsWith("::warning title=Flaky browser test (macOS)::chromium › rotation.spec.ts:192"))).toBe(true);
    expect(io.summaries).toHaveLength(1);
    expect(io.summaries[0].file).toBe("S.md");
    expect(io.summaries[0].text).toContain("rotation.spec.ts:192");
  });

  it("writes no summary when there is nowhere to write it", () => {
    const io = memoryIo({ "r.json": flaky });
    expect(reportFlakyTests("r.json", {}, io)).toBe(0);
    expect(io.summaries).toEqual([]);
    expect(io.lines.some((l) => l.startsWith("::warning"))).toBe(true);
  });

  it("says plainly that nothing needed a retry, with the retry setting the run had", () => {
    const clean = hookTimeout();
    for (const { test } of unexpectedTests(clean)) test.status = "expected";
    const io = memoryIo({ "r.json": JSON.stringify(clean) });
    expect(reportFlakyTests("r.json", { RUNNER_OS: "macOS", GITHUB_STEP_SUMMARY: "S.md" }, io)).toBe(0);
    expect(io.lines).toHaveLength(1);
    expect(io.lines[0]).toMatch(/0 passed only on a retry/);
    expect(io.lines[0]).toMatch(/retries per failed test: 0\./);
    expect(io.summaries).toEqual([]);
  });

  it("stays quiet about, and does not fail on, a report whose tests failed for good: the browser step is red for that", () => {
    for (const make of [hookTimeout, pixelFailure]) {
      const io = memoryIo({ "r.json": JSON.stringify(make()) });
      expect(reportFlakyTests("r.json", { RUNNER_OS: "macOS" }, io)).toBe(0);
      expect(io.lines.filter((l) => l.startsWith("::"))).toEqual([]);
      expect(io.lines[0]).toMatch(/1 failed/);
    }
  });

  it("does nothing, successfully, when the browser step never wrote a report", () => {
    const io = memoryIo();
    expect(reportFlakyTests("nope.json", {}, io)).toBe(0);
    expect(io.lines).toHaveLength(1);
    expect(io.lines[0]).toMatch(/No browser report at nope\.json/);
  });

  it("fails loudly on a report it cannot read, instead of reporting an empty run", () => {
    for (const body of ["{ not json", "{}", "[]", "null", '{"suites":"x"}']) {
      const io = memoryIo({ "r.json": body });
      expect(reportFlakyTests("r.json", {}, io), body).toBe(1);
      expect(io.lines[0], body).toMatch(/^::error title=Browser flake report::/);
    }
  });
});
