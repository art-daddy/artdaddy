// The shared timing helper (e2e/lib/timing) and the budget check (scripts/qa/timingBudgets.mjs): what they write and
// what they decide. The nightly run trusts both, so each test asserts an outcome a person would act on: the line in
// the results file, the verdict, the exit code, the budget written.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as typedEntry from "../../e2e/lib/timing.ts";
import {
  BUILD_ENV,
  TIMING_FILE_ENV,
  measure,
  record,
  startTimer,
  timingFile,
} from "../../e2e/lib/timing.mjs";
import {
  BUDGETS_FILE,
  ROOT,
  calibrateBudgets,
  compareTimings,
  discoverTimedTests,
  formatBudgets,
  formatComparison,
  importsTiming,
  median,
  parseBudgets,
  parseResults,
  runTimedTests,
  verdictOf,
} from "./timingBudgets.mjs";

const SCRIPT = path.join(ROOT, "scripts", "qa", "timingBudgets.mjs");
const HELPER_URL = pathToFileURL(path.join(ROOT, "e2e", "lib", "timing.mjs")).href;

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "artdaddy-timing-test-"));
  file = path.join(dir, "results.jsonl");
  vi.stubEnv(TIMING_FILE_ENV, file);
  vi.stubEnv(BUILD_ENV, "");
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const written = () =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

const at = "2026-11-26T20:00:00.000Z";
const entry = (scenario: string, ms: number, machine = "LAB") => ({
  scenario,
  ms,
  machine,
  build: "abc",
  at,
});
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n");
const budgetsOf = (o: Record<string, number>) => new Map(Object.entries(o));

describe("the timing helper", () => {
  it("writes one line per wait: its name, whole milliseconds, the machine, the build and when it began", async () => {
    const before = Date.now();
    const value = await measure("export: 1 s timeline", async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return "the file";
    });
    const after = Date.now();

    expect(value).toBe("the file");
    const lines = written();
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(Object.keys(line).sort()).toEqual(["at", "build", "machine", "ms", "scenario"]);
    expect(line.scenario).toBe("export: 1 s timeline");
    expect(Number.isInteger(line.ms)).toBe(true);
    expect(line.ms).toBeGreaterThanOrEqual(20);
    expect(line.ms).toBeLessThan(10_000);
    expect(line.machine).toBe(os.hostname());
    expect(line.build).toMatch(/^([0-9a-f]{40}(\+dirty)?|unknown)$/);
    const began = Date.parse(line.at);
    expect(began).toBeGreaterThanOrEqual(before - 5);
    expect(began).toBeLessThanOrEqual(after);
    // What the helper writes is what the check reads: no line of its own is ever malformed.
    expect(parseResults(readFileSync(file, "utf8")).problems).toEqual([]);
  });

  it("records nothing for a wait that failed, and the failure still reaches the test", async () => {
    await expect(
      measure("export: 1 s timeline", async () => {
        throw new Error("the file never arrived");
      }),
    ).rejects.toThrow("the file never arrived");
    expect(written()).toEqual([]);
  });

  it("names the build from ARTDADDY_BUILD when it is set", () => {
    vi.stubEnv(BUILD_ENV, "0.29.1 installed");
    record("app start", 10);
    expect(written()[0].build).toBe("0.29.1 installed");
  });

  it("a timer records once when stopped, and never when it is not", () => {
    const forgotten = startTimer("never stopped");
    void forgotten;
    const wait = startTimer("import: one clip");
    expect(written()).toEqual([]);
    const line = wait.stop();
    expect(written()).toEqual([line]);
    expect(() => wait.stop()).toThrow(/already stopped/);
    expect(written()).toHaveLength(1);
    expect(written()[0].scenario).toBe("import: one clip");
  });

  it("keeps a wait timed by the app's own clock, dated from when it began", () => {
    const now = Date.now();
    record("app start: launch to usable", 1234.4);
    const [line] = written();
    expect(line.ms).toBe(1234);
    expect(Math.abs(Date.parse(line.at) - (now - 1234))).toBeLessThan(1000);
  });

  it("refuses a duration or a name that is not one, and writes nothing", async () => {
    for (const ms of [-1, Number.NaN, Number.POSITIVE_INFINITY, "12", null]) {
      expect(() => record("app start", ms as number)).toThrow(TypeError);
    }
    for (const name of ["", "   ", "two\nlines", 42, undefined]) {
      expect(() => record(name as string, 5)).toThrow(TypeError);
      expect(() => startTimer(name as string)).toThrow(TypeError);
    }
    await expect(measure("x", "not a function" as unknown as () => void)).rejects.toThrow(
      TypeError,
    );
    expect(written()).toEqual([]);
  });

  it("without ARTDADDY_TIMING_FILE writes one file per day under the system temp folder", () => {
    expect(timingFile({}, new Date(2026, 10, 26, 23, 59))).toBe(
      path.join(os.tmpdir(), "artdaddy-timing", "timing-2026-11-26.jsonl"),
    );
    expect(timingFile({ [TIMING_FILE_ENV]: "  " }, new Date(2026, 0, 5))).toBe(
      path.join(os.tmpdir(), "artdaddy-timing", "timing-2026-01-05.jsonl"),
    );
    expect(timingFile({ [TIMING_FILE_ENV]: "out/run.jsonl" })).toBe(path.resolve("out/run.jsonl"));
  });

  it("the TypeScript entry for Playwright specs is the same helper", () => {
    expect(typedEntry.measure).toBe(measure);
    expect(typedEntry.startTimer).toBe(startTimer);
    expect(typedEntry.record).toBe(record);
    expect(typedEntry.timingFile).toBe(timingFile);
  });

  it("several processes writing to one file at once leave only whole lines", async () => {
    const child = (tag: string) =>
      new Promise<number>((resolve) => {
        const p = spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `const { record } = await import(${JSON.stringify(HELPER_URL)});
             for (let i = 0; i < 40; i++) record(${JSON.stringify(tag)} + " wait", i);`,
          ],
          {
            env: { ...process.env, [TIMING_FILE_ENV]: file, [BUILD_ENV]: "concurrent" },
            stdio: "ignore",
          },
        );
        p.on("exit", (code) => resolve(code ?? 1));
      });
    expect(await Promise.all(["a", "b", "c"].map(child))).toEqual([0, 0, 0]);
    const { entries, problems } = parseResults(readFileSync(file, "utf8"));
    expect(problems).toEqual([]);
    expect(entries).toHaveLength(120);
    for (const tag of ["a", "b", "c"]) {
      expect(entries.filter((e) => e.scenario === `${tag} wait`).map((e) => e.ms)).toEqual([
        ...Array(40).keys(),
      ]);
    }
  });
});

describe("reading a results file", () => {
  it("names every line that is not a measurement, with its number and why, and keeps the good ones", () => {
    const text = [
      JSON.stringify(entry("a", 100)),
      '{"scenario":"cut off","ms":1',
      "",
      JSON.stringify([1, 2]),
      JSON.stringify({ ...entry("b", 1), scenario: "  " }),
      JSON.stringify({ ...entry("c", 1), ms: "12" }),
      JSON.stringify({ ...entry("d", 1), ms: -3 }),
      JSON.stringify({ scenario: "e", ms: 1, machine: "LAB", at }),
      JSON.stringify({ scenario: "f", ms: 1, build: "abc", at }),
      JSON.stringify({ ...entry("g", 1), at: "yesterday" }),
      "   ",
      "null",
      "42",
      '"a line"',
      JSON.stringify({ ...entry("i", 1), scenario: 42 }),
      JSON.stringify({ ...entry("j", 1), machine: "  " }),
      JSON.stringify({ ...entry("k", 1), at: 1764190800000 }),
      JSON.stringify({ scenario: "l", machine: "LAB", build: "abc", at }),
      JSON.stringify({ ...entry("m", 1), at: 2026 }),
      JSON.stringify({ scenario: "n", ms: 1, machine: "LAB", build: "abc" }),
      JSON.stringify(entry("h", 200)),
    ].join("\r\n");
    const { entries, problems } = parseResults(text);
    expect(entries.map((e) => e.scenario)).toEqual(["a", "h"]);
    expect(problems.map((p) => [p.line, p.reason])).toEqual([
      [2, "not JSON"],
      [4, "not a JSON object"],
      [5, "no scenario name"],
      [6, '"ms" is not a duration: "12"'],
      [7, '"ms" is not a duration: -3'],
      [8, 'no "build"'],
      [9, 'no "machine"'],
      [10, '"at" is not a time: "yesterday"'],
      [12, "not a JSON object"],
      [13, "not a JSON object"],
      [14, "not a JSON object"],
      [15, "no scenario name"],
      [16, 'no "machine"'],
      [17, '"at" is not a time: 1764190800000'],
      [18, '"ms" is not a duration: missing'],
      [19, '"at" is not a time: 2026'],
      [20, '"at" is not a time: missing'],
    ]);
    expect(problems[0].text).toBe('{"scenario":"cut off","ms":1');
  });

  it("reads back exactly what was written, whatever the names and numbers", () => {
    const valid = fc.record({
      scenario: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
      ms: fc.nat(10_000_000),
      machine: fc.constantFrom("LAB", "runner-1"),
      build: fc.stringMatching(/^[0-9a-f]{40}$/),
      at: fc
        .date({ min: new Date(2020, 0, 1), max: new Date(2040, 0, 1), noInvalidDate: true })
        .map((d) => d.toISOString()),
    });
    fc.assert(
      fc.property(fc.array(valid, { maxLength: 30 }), (rows) => {
        const { entries, problems } = parseResults(jsonl(rows));
        expect(problems).toEqual([]);
        expect(entries).toEqual(rows);
      }),
    );
  });
});

describe("judging against the budgets", () => {
  it("a wait over its budget is SLOW, and says by how much", () => {
    const rows = compareTimings([entry("export", 1200)], budgetsOf({ export: 1000 }));
    expect(rows).toEqual([
      {
        scenario: "export",
        verdict: "SLOW",
        ms: 1200,
        budget: 1000,
        runs: 1,
        overMs: 200,
        overPct: 20,
      },
    ]);
    const text = formatComparison(rows, [], { entries: [entry("export", 1200)] }).join("\n");
    expect(text).toContain(
      "SLOW      export: 1200 ms, 200 ms (20%) over its 1000 ms budget (1 run)",
    );
    expect(text).toMatch(/Verdict: FAIL \(1 slow\)$/);
    expect(verdictOf(rows, []).ok).toBe(false);
  });

  it("a wait at or under its budget passes; one ms over does not", () => {
    const budgets = budgetsOf({ start: 1000 });
    expect(compareTimings([entry("start", 1000)], budgets)[0].verdict).toBe("PASS");
    expect(compareTimings([entry("start", 999)], budgets)[0].verdict).toBe("PASS");
    expect(compareTimings([entry("start", 1001)], budgets)[0].verdict).toBe("SLOW");
  });

  it("a wait with no budget is NEW, and does not fail the check on its own", () => {
    const rows = compareTimings([entry("import", 300)], new Map());
    expect(rows).toEqual([{ scenario: "import", verdict: "NEW", ms: 300, runs: 1 }]);
    expect(verdictOf(rows, [])).toMatchObject({ ok: true, new: 1 });
    expect(formatComparison(rows, []).join("\n")).toContain(
      "NEW       import: 300 ms (1 run), no budget yet",
    );
  });

  it("a budget nothing measured is MISSING and fails the check: its test did not run or stopped timing", () => {
    const rows = compareTimings([entry("start", 900)], budgetsOf({ start: 1000, export: 5000 }));
    expect(rows.map((r) => [r.scenario, r.verdict])).toEqual([
      ["export", "MISSING"],
      ["start", "PASS"],
    ]);
    expect(verdictOf(rows, [])).toMatchObject({ ok: false, missing: 1 });
  });

  it("a malformed line fails the check even when every wait passes", () => {
    const { entries, problems } = parseResults(
      `${JSON.stringify(entry("start", 900))}\nnot a line`,
    );
    const rows = compareTimings(entries, budgetsOf({ start: 1000 }));
    expect(verdictOf(rows, problems)).toMatchObject({ ok: false, malformed: 1, pass: 1 });
    expect(formatComparison(rows, problems, { entries }).join("\n")).toContain(
      "MALFORMED line 2: not JSON: not a line",
    );
  });

  it("nothing measured fails the check", () => {
    expect(verdictOf([], [])).toMatchObject({ ok: false, measured: 0 });
    expect(formatComparison([], []).at(-1)).toBe("Verdict: FAIL (nothing was measured)");
  });

  it("judges the median of the runs: one slow run of three is noise, two are not", () => {
    const budgets = budgetsOf({ export: 1000 });
    const runs = (...ms: number[]) => ms.map((m) => entry("export", m));
    expect(compareTimings(runs(900, 950, 4000), budgets)[0]).toMatchObject({
      verdict: "PASS",
      ms: 950,
      runs: 3,
    });
    expect(compareTimings(runs(900, 1500, 4000), budgets)[0]).toMatchObject({
      verdict: "SLOW",
      ms: 1500,
    });
  });

  it("SLOW exactly when the median is over the budget", () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat(100_000), { minLength: 1, maxLength: 9 }),
        fc.integer({ min: 1, max: 100_000 }),
        (ms, budget) => {
          const [row] = compareTimings(
            ms.map((m) => entry("w", m)),
            budgetsOf({ w: budget }),
          );
          expect(row.verdict).toBe(median(ms) > budget ? "SLOW" : "PASS");
        },
      ),
    );
  });

  it("the median lies between the fastest and the slowest run, in any order", () => {
    fc.assert(
      fc.property(fc.array(fc.nat(1_000_000), { minLength: 1, maxLength: 15 }), (values) => {
        const m = median(values);
        expect(m).toBeGreaterThanOrEqual(Math.min(...values));
        expect(m).toBeLessThanOrEqual(Math.max(...values));
        expect(median([...values].reverse())).toBe(m);
      }),
    );
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(() => median([])).toThrow(new RangeError("the median of no values"));
  });

  it("lists the worst first: SLOW, MISSING, NEW, PASS, then by name", () => {
    const rows = compareTimings(
      [
        entry("z pass", 10),
        entry("a pass", 10),
        entry("e slow", 30),
        entry("y new", 5),
        entry("b slow", 20),
        entry("c new", 5),
        entry("m slow", 40),
      ],
      budgetsOf({
        "z pass": 100,
        "a pass": 100,
        "e slow": 10,
        "x missing": 50,
        "b slow": 10,
        "d missing": 50,
        "m slow": 1,
      }),
    );
    expect(rows.map((r) => `${r.verdict} ${r.scenario}`)).toEqual([
      "SLOW b slow",
      "SLOW e slow",
      "SLOW m slow",
      "MISSING d missing",
      "MISSING x missing",
      "NEW c new",
      "NEW y new",
      "PASS a pass",
      "PASS z pass",
    ]);
    expect(verdictOf(rows, [])).toEqual({
      ok: false,
      measured: 7,
      malformed: 0,
      pass: 2,
      slow: 3,
      new: 2,
      missing: 2,
    });
  });

  it("writes the report a person reads: who measured, each wait, each bad line, and why it fails", () => {
    const entries = [
      { ...entry("start", 900), build: "ce2f1195fa89de0a2a4d47c77313b756ed0d5b94+dirty" },
      entry("start", 1000, "LAPTOP"),
      entry("start", 1100),
      entry("export", 1300),
      entry("import", 70),
    ];
    const long = `{"scenario":"${"x".repeat(200)}"`;
    const problems = [{ line: 9, reason: "not JSON", text: long }];
    const rows = compareTimings(
      entries,
      budgetsOf({ start: 1000, export: 1000, transcribe: 9000 }),
    );
    expect(formatComparison(rows, problems, { entries, source: "nightly.jsonl" })).toEqual([
      "Timing: 5 measurement(s) of 3 wait(s) on LAB, LAPTOP, build ce2f1195fa89+dirty, abc (nightly.jsonl)",
      "  note: measurements from 2 machines; the budgets are for one PC",
      "  SLOW      export: 1300 ms, 300 ms (30%) over its 1000 ms budget (1 run)",
      "  MISSING   transcribe: budget 9000 ms, not measured in this run",
      "  NEW       import: 70 ms (1 run), no budget yet",
      "  PASS      start: 1000 ms, budget 1000 ms (3 runs)",
      `  MALFORMED line 9: not JSON: ${long.slice(0, 160)}...`,
      "Verdict: FAIL (1 slow, 1 missing, 1 malformed); 1 new wait(s) with no budget",
    ]);
    expect(
      formatComparison(compareTimings([entry("start", 999)], budgetsOf({ start: 1000 })), [], {
        entries: [{ ...entry("start", 999), build: "debug build 0.29.1" }],
        reportOnly: true,
      }),
    ).toEqual([
      "Timing: 1 measurement(s) of 1 wait(s) on LAB, build debug build 0.29.1",
      "  PASS      start: 999 ms, budget 1000 ms (1 run)",
      "Verdict (report only, never fails here): PASS",
    ]);
    const tagged = `release-${"a".repeat(40)}`;
    expect(
      formatComparison([], [], { entries: [{ ...entry("start", 1), build: tagged }] })[0],
    ).toBe(`Timing: 1 measurement(s) of 1 wait(s) on LAB, build ${tagged}`);
  });

  it("shows a bad line whole up to 160 characters, and cuts a longer one", () => {
    const at160 = "y".repeat(160);
    const lines = formatComparison(
      [],
      [
        { line: 3, reason: "not JSON", text: "not a line" },
        { line: 4, reason: "not JSON", text: at160 },
        { line: 5, reason: "not JSON", text: `${at160}z` },
      ],
    );
    expect(lines.slice(1, 4)).toEqual([
      "  MALFORMED line 3: not JSON: not a line",
      `  MALFORMED line 4: not JSON: ${at160}`,
      `  MALFORMED line 5: not JSON: ${at160}...`,
    ]);
  });
});

describe("the compare command", () => {
  const run = (args: string[], env: Record<string, string | undefined> = {}) => {
    const base: Record<string, string | undefined> = { ...process.env };
    delete base.CI;
    return spawnSync(process.execPath, [SCRIPT, "compare", ...args], {
      env: { ...base, ...env },
      encoding: "utf8",
    });
  };
  const write = (name: string, text: string) => {
    const p = path.join(dir, name);
    writeFileSync(p, text);
    return p;
  };

  it("fails on the lab PC when a wait is SLOW, and only reports it in CI or with --report-only", () => {
    const results = write("r.jsonl", jsonl([entry("export", 1300)]));
    const budgets = write("b.json", JSON.stringify({ export: 1000 }));

    const lab = run([results, "--budgets", budgets]);
    expect(lab.status).toBe(1);
    expect(lab.stdout).toContain("SLOW      export: 1300 ms, 300 ms (30%) over its 1000 ms budget");

    for (const quiet of [
      run([results, "--budgets", budgets, "--report-only"]),
      run([results, "--budgets", budgets], { CI: "true" }),
    ]) {
      expect(quiet.status).toBe(0);
      expect(quiet.stdout).toContain("SLOW      export: 1300 ms");
      expect(quiet.stdout).toContain("Verdict (report only, never fails here): FAIL (1 slow)");
    }
  });

  it("passes when every budgeted wait is within budget, and writes the report it printed", () => {
    const results = write(
      "r.jsonl",
      jsonl([entry("export", 900), entry("start", 2000), entry("import", 5)]),
    );
    const budgets = write("b.json", JSON.stringify({ export: 1000, start: 2000 }));
    const report = path.join(dir, "report.txt");
    const out = run([results, "--budgets", budgets, "--report", report]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("Verdict: PASS; 1 new wait(s) with no budget");
    expect(readFileSync(report, "utf8").trim()).toBe(out.stdout.trim());
  });

  it("fails on a malformed line and names it", () => {
    const results = write(
      "r.jsonl",
      `${JSON.stringify(entry("export", 900))}\n{"scenario":"export","ms":"fast"}\n`,
    );
    const budgets = write("b.json", JSON.stringify({ export: 1000 }));
    const out = run([results, "--budgets", budgets]);
    expect(out.status).toBe(1);
    expect(out.stdout).toContain(`MALFORMED line 2: "ms" is not a duration: "fast"`);
  });

  it("fails when there is no results file at all, and refuses a malformed budgets file", () => {
    const budgets = write("b.json", JSON.stringify({ export: 1000 }));
    const none = run([path.join(dir, "missing.jsonl"), "--budgets", budgets]);
    expect(none.status).toBe(1);
    expect(none.stdout).toContain("nothing was measured");

    const results = write("r.jsonl", jsonl([entry("export", 900)]));
    const bad = run([
      results,
      "--budgets",
      write("bad.json", JSON.stringify({ export: "1s", start: 0 })),
    ]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain(
      '"export": the budget is not a positive number of milliseconds ("1s")',
    );
    expect(bad.stderr).toContain(
      '"start": the budget is not a positive number of milliseconds (0)',
    );
  });
});

describe("calibrating budgets", () => {
  it("reads a budgets file strictly, naming each wrong budget", () => {
    expect(parseBudgets('{"start": 1000, "export": 2500.5}')).toEqual({
      budgets: budgetsOf({ start: 1000, export: 2500.5 }),
      problems: [],
    });
    expect(parseBudgets("{start: 1000}").problems).toEqual([expect.stringMatching(/^not JSON \(/)]);
    for (const text of ["[]", "null", "42", '"text"']) {
      expect(parseBudgets(text)).toEqual({
        budgets: new Map(),
        problems: ["not an object of scenario name -> milliseconds"],
      });
    }
    const { budgets, problems } = parseBudgets(
      JSON.stringify({ "  ": 5, zero: 0, minus: -5, text: "5", none: null, ok: 7 }),
    );
    expect([...budgets]).toEqual([["ok", 7]]);
    expect(problems).toEqual([
      "a budget with no scenario name",
      '"zero": the budget is not a positive number of milliseconds (0)',
      '"minus": the budget is not a positive number of milliseconds (-5)',
      '"text": the budget is not a positive number of milliseconds ("5")',
      '"none": the budget is not a positive number of milliseconds (null)',
    ]);
  });

  it("writes the budgets file sorted by name, whatever order the waits came in", () => {
    expect(
      formatBudgets(
        new Map([
          ["a wait", 1],
          ["C wait", 3],
          ["b wait", 2],
        ]),
      ),
    ).toBe('{\n  "C wait": 3,\n  "a wait": 1,\n  "b wait": 2\n}\n');
  });

  it("gives a new wait the median of its runs plus 20%, in whole milliseconds", () => {
    const { budgets, added } = calibrateBudgets(
      [entry("export", 100), entry("export", 110), entry("export", 1000)],
      new Map(),
    );
    expect(budgets.get("export")).toBe(132);
    expect(added).toEqual([{ scenario: "export", ms: 110, budget: 132, runs: 3 }]);
    // 5 x 1.2 is 6.000000000000001 in floating point: still 6.
    expect(
      calibrateBudgets(
        [5, 5, 5].map((ms) => entry("tiny", ms)),
        new Map(),
      ).budgets.get("tiny"),
    ).toBe(6);
    expect(
      calibrateBudgets(
        [0, 0, 0].map((ms) => entry("instant", ms)),
        new Map(),
      ).budgets.get("instant"),
    ).toBe(1);
  });

  it("never changes a budget that exists, however the wait measures now", () => {
    const owners = budgetsOf({ export: 500 });
    const { budgets, kept, added } = calibrateBudgets(
      [900, 950, 1000].map((ms) => entry("export", ms)),
      owners,
    );
    expect(budgets.get("export")).toBe(500);
    expect(added).toEqual([]);
    expect(kept).toEqual([{ scenario: "export", budget: 500, ms: 950, runs: 3 }]);
  });

  it("needs three runs of a wait, and only this machine's", () => {
    const result = calibrateBudgets(
      [
        entry("a", 100),
        entry("a", 100),
        entry("b", 100, "OTHER"),
        entry("b", 100, "OTHER"),
        entry("b", 100, "OTHER"),
      ],
      new Map(),
      { machine: "LAB" },
    );
    expect([...result.budgets.keys()]).toEqual([]);
    expect(result.tooFew).toEqual([{ scenario: "a", runs: 2 }]);
    expect(result.otherMachines).toBe(3);
  });

  it("a fresh budget is 20% over the median, never less, and passes the runs it came from", () => {
    fc.assert(
      fc.property(fc.array(fc.nat(600_000), { minLength: 3, maxLength: 9 }), (ms) => {
        const entries = ms.map((m) => entry("w", m));
        const { budgets } = calibrateBudgets(entries, new Map());
        const budget = budgets.get("w")!;
        const m = median(ms);
        expect(Number.isInteger(budget)).toBe(true);
        expect(budget).toBeGreaterThanOrEqual(Math.max(1, m * 1.2 - 1e-6));
        expect(budget).toBeLessThan(Math.max(1, m * 1.2) + 1);
        expect(compareTimings(entries, budgets)[0].verdict).toBe("PASS");
        expect(parseBudgets(formatBudgets(budgets))).toEqual({ budgets, problems: [] });
      }),
    );
  });

  it("the committed budgets file is valid: a positive whole number of milliseconds per wait", () => {
    const text = readFileSync(BUDGETS_FILE, "utf8");
    const { budgets, problems } = parseBudgets(text);
    expect(problems).toEqual([]);
    for (const [scenario, ms] of budgets) expect(Number.isInteger(ms), scenario).toBe(true);
    expect(formatBudgets(budgets)).toBe(text.replace(/\r\n/g, "\n"));
  });
});

describe("finding and running the timed tests", () => {
  it("knows a test is timed by its import of the shared helper", () => {
    expect(importsTiming(`import { measure } from "../lib/timing";`)).toBe(true);
    expect(importsTiming(`import { record } from "../../lib/timing.mjs";`)).toBe(true);
    expect(importsTiming(`import { startTimer } from '../lib/timing.ts';`)).toBe(true);
    expect(importsTiming(`import {\n  measure,\n} from  "./lib/timing.mjs";`)).toBe(true);
    expect(importsTiming(`import { measure } from "../../../e2e/lib/timing";`)).toBe(true);
    expect(importsTiming(`import { measure } from "../lib/timingHelpers";`)).toBe(false);
    expect(importsTiming(`import { measure } from "../lib/timing.js";`)).toBe(false);
    expect(importsTiming(`import { measure } from "lib/timing";`)).toBe(false);
    expect(importsTiming(`import { measure } from "../lib/timing/index";`)).toBe(false);
    expect(importsTiming(`import { performance } from "node:perf_hooks";`)).toBe(false);
  });

  it("finds the two worked examples, so the nightly run cannot silently stop running them", () => {
    const { desktop } = discoverTimedTests(ROOT);
    const names = desktop.map((f) => path.basename(f));
    expect(names).toContain("previewColdStart.desktop.mjs");
    expect(names).toContain("exportDest.desktop.mjs");
  });

  it("a test that fails, records nothing or hangs is a failed run, and only good runs' times count", async () => {
    const root = path.join(dir, "repo");
    const lanes = path.join(root, "e2e", "desktop");
    mkdirSync(lanes, { recursive: true });
    mkdirSync(path.join(root, "e2e", "lib"), { recursive: true });
    writeFileSync(
      path.join(root, "e2e", "lib", "timing.mjs"),
      `export * from ${JSON.stringify(HELPER_URL)};\n`,
    );
    const lane = (name: string, body: string) =>
      writeFileSync(
        path.join(lanes, name),
        `import { record } from "../lib/timing.mjs";\n${body}\n`,
      );
    lane("a-good.desktop.mjs", `record("good wait", 100);`);
    lane("b-fails.desktop.mjs", `record("failing wait", 100); process.exit(1);`);
    lane("c-silent.desktop.mjs", `void record;`);
    lane("d-hangs.desktop.mjs", `setInterval(() => {}, 1000);`);
    writeFileSync(path.join(lanes, "e-untimed.desktop.mjs"), `process.exit(1);\n`);

    const results = path.join(dir, "run.jsonl");
    // A named build spares each lane two git calls, so a busy machine cannot push a good lane past the timeout.
    vi.stubEnv(BUILD_ENV, "test");
    const out = await runTimedTests({
      root,
      runs: 2,
      lanes: ["desktop"],
      results,
      timeoutMs: 8000,
      log: () => {},
      stdio: "ignore",
    });

    const byName = (n: string) => out.outcomes.filter((o) => o.name.endsWith(n));
    expect(out.outcomes).toHaveLength(8);
    expect(byName("a-good.desktop.mjs").map((o) => o.ok)).toEqual([true, true]);
    expect(byName("b-fails.desktop.mjs").map((o) => o.why)).toEqual(["exit 1", "exit 1"]);
    expect(byName("c-silent.desktop.mjs").map((o) => o.why)).toEqual([
      "passed but recorded no timing",
      "passed but recorded no timing",
    ]);
    expect(byName("d-hangs.desktop.mjs").every((o) => !o.ok && o.why.startsWith("timed out"))).toBe(
      true,
    );
    expect(out.outcomes.some((o) => o.name.includes("e-untimed"))).toBe(false);
    // Rounds go across the tests, not one test N times in a row.
    expect(out.outcomes.map((o) => o.round)).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
    const counted = out.outcomes
      .filter((o) => o.ok)
      .flatMap((o) => o.entries.map((e) => e.scenario));
    expect(counted).toEqual(["good wait", "good wait"]);
    expect(
      parseResults(readFileSync(results, "utf8"))
        .entries.map((e) => e.scenario)
        .sort(),
    ).toEqual(["failing wait", "failing wait", "good wait", "good wait"]);
  }, 60_000);

  it("says when the browser lane cannot run instead of passing it by", async () => {
    const root = path.join(dir, "repo");
    mkdirSync(path.join(root, "e2e", "ui"), { recursive: true });
    writeFileSync(
      path.join(root, "e2e", "ui", "a.spec.ts"),
      `import { measure } from "../lib/timing";\n`,
    );
    const out = await runTimedTests({
      root,
      runs: 1,
      lanes: ["browser"],
      results: path.join(dir, "r.jsonl"),
      log: () => {},
    });
    expect(out.outcomes).toEqual([]);
    expect(out.notRun).toEqual([expect.stringContaining("@playwright/test is not installed")]);
  });
});
