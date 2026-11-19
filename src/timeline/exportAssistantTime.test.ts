// What an assistant may be told of how long an export is expected to take (decision of 19 Nov 2026): a time worked out from this PC's own earlier exports, in the
// card's words, and never a time the app marks as a guess (said aloud, a guess reads as a promise).
//
//  1. A drift alarm over the likely ways a time reaches an assistant. It reads the app's own source (no tests, no kits, no fixtures) and pins who may say an expectation
//     that is a guess (the card, the Export dialog's line), who may write `expected_s`, who may put a time into words and who may name the expectation itself. It is
//     syntactic: it cannot see a time formatted by hand, and it fails for any legitimate new place until that place is classified. What an assistant reads goes through
//     `expectationForAssistant` (exportWords.ts), which the three producers share; the producers themselves are walked through the real tool and queue in
//     exportItems.test.ts (separate files and the whole timeline, from every door), exportReply.test.ts (the whole timeline) and exportQueue.test.ts (the list), and the
//     export guard (exportFullGuard.test.ts) checks the rule on every call of its table.
//  2. The live facts of the export list (time left, how far, how long, the stage) do not read the basis of the expectation: a guessed export and a measured one
//     move alike, and only the measured one has a number of what was expected. The slow banner's facts of a guessed export are as they were.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __setHeldOffByBuild } from "../api/exportFlags";
import { startRun, steady, useKit } from "../test/exportRunKit";
import { __resetFacts3c } from "./exportFacts3c";
import { listExportOutcomes, listExportRecords } from "./exportQueue";

vi.mock("../api/exportEvents", () => ({ reportExport: vi.fn(async () => undefined) }));

useKit(__resetFacts3c);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const SRC = join(process.cwd(), "src");

interface Source {
  /** The path under src, with forward slashes. */
  name: string;
  /** The lines of code: the comment lines are left out. */
  code: string[];
}
let sources: Source[] | null = null;

/** The app's own source files (no test, no kit, no fixture), read once. */
function appSources(): Source[] {
  if (sources) return sources;
  const found: Source[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__fixtures__") walk(path);
        continue;
      }
      const name = relative(SRC, path).split(sep).join("/");
      if (!/\.tsx?$/.test(entry.name) || /\.(test|spec|e2e)\.tsx?$/.test(entry.name)) continue;
      if (name.startsWith("test/")) continue;
      const code = readFileSync(path, "utf8")
        .split(/\r?\n/)
        .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line));
      found.push({ name, code });
    }
  };
  walk(SRC);
  sources = found;
  return found;
}

/** The app's own source files with a line of code, not of comment, that names `pattern`. */
const filesNaming = (pattern: RegExp): string[] =>
  appSources()
    .filter((file) => file.code.some((line) => pattern.test(line)))
    .map((file) => file.name)
    .sort();

describe("the places that say how long an export is expected to take are pinned", () => {
  it("lets only the person's own surfaces say an expectation that is a guess, however the words are imported", () => {
    // The sentence that says "A rough guess: ...": the card (which leaves a guess out itself), the Export dialog's line, and the definition. An alias of the function
    // (`import { describeExpected as ... }`) is caught as the name is. A new place that says it fails here. An assistant's own words are `describeExpectedForAssistant`,
    // which says nothing for a guess.
    expect(filesNaming(/\bdescribeExpected\b/)).toEqual([
      "components/ExportCard.tsx",
      "timeline/dialogEstimate.ts",
      "timeline/exportWords.ts",
    ]);
  });

  it("lets only the person's own surfaces say the honest estimate's words, which name a rough guess too", () => {
    expect(filesNaming(/\bdescribeEstimateLine\b/)).toEqual([
      "components/ExportCard.tsx",
      "timeline/dialogEstimate.ts",
      "timeline/estimateWords.ts",
    ]);
  });

  it("writes what was expected into the export list in one place, and never a flag that calls it a guess", () => {
    expect(filesNaming(/\bexpected_s\b/)).toEqual(["timeline/exportQueue.ts"]);
    expect(filesNaming(/expected_guessed/)).toEqual([]);
  });

  it("names the expectation itself only where it is made, kept and told", () => {
    // Made (exportOptions), totalled and told for separate files (exportItems), kept on the record and put in the list (exportQueue).
    expect(filesNaming(/\bExpectation\b|\btotalExpectation\b/)).toEqual([
      "timeline/exportItems.ts",
      "timeline/exportOptions.ts",
      "timeline/exportQueue.ts",
    ]);
  });

  it("puts a time into words only in the files whose words are the person's own", () => {
    // The dialog's line and the card's (estimateWords), the definition (exportOptions), the questions asked before an export starts (exportQuestions), the words of the
    // time left and of what was expected (exportWords), and the question and banners about the route (routeWords). A new place that says a time fails here until it is
    // classified: an assistant is told a time only through the rule of exportWords.ts.
    expect(filesNaming(/\bdescribeExportTime\s*\(/)).toEqual([
      "timeline/estimateWords.ts",
      "timeline/exportOptions.ts",
      "timeline/exportQuestions.ts",
      "timeline/exportWords.ts",
      "timeline/routeWords.ts",
    ]);
  });
});

describe.each([
  ["as the build ships", true],
  ["with the held-off estimate lifted", null],
] as const)("the export list, %s", (_state, heldOff) => {
  beforeEach(() => __setHeldOffByBuild(heldOff));
  afterEach(() => __setHeldOffByBuild(null));

  it("has a number of what was expected for an export measured on this PC and none for a guess, and every live fact says the same for both", async () => {
    const rows = {} as Record<"measured" | "guessed", Any>;
    for (const basis of ["measured", "guessed"] as const) {
      const run = await startRun(
        basis === "measured"
          ? { history: 400, dest: "C:/out/measured.mp4" }
          : { dest: "C:/out/guessed.mp4" },
      );
      // The premise: the two were admitted with an expectation, from earlier exports and from the size of the export. It is the list that leaves the guess out.
      expect(listExportRecords().find((r) => r.job_id === run.id)?.expected?.guessed).toBe(
        basis === "guessed",
      );
      await run.to(100, steady(400));
      rows[basis] = listExportOutcomes().find((r) => r.job_id === run.id);
      await run.end("finish");
    }
    expect(rows.measured.expected_s).toEqual(expect.any(Number));
    expect(rows.measured).not.toHaveProperty("expected_guessed");
    expect(Object.keys(rows.guessed).filter((key) => key.startsWith("expected"))).toEqual([]);
    const live = (row: Any) => ({
      state: row.state,
      stage: row.stage,
      elapsed_s: row.elapsed_s,
      progress_percent: row.progress_percent,
      time_left_s: row.time_left_s,
    });
    expect(live(rows.guessed)).toEqual(live(rows.measured));
    expect(live(rows.guessed).time_left_s).toEqual(expect.any(Number));
    // Nothing but the number of what was expected is missing from the guessed row.
    const without = (row: Any) =>
      Object.keys(row)
        .filter((key) => !key.startsWith("expected") && key !== "filename" && key !== "job_id")
        .sort();
    expect(without(rows.guessed)).toEqual(without(rows.measured));
  });

  it("keeps the slow banner's facts for an export whose time was a guess, which has no number of what was expected", async () => {
    // A guess is held to the 30 minutes of a projection, where an estimate this PC measured is held to three times itself (exportHelp.ts): a render of 4000 s in all is over it.
    const run = await startRun({ dest: "C:/out/slow-guess.mp4" });
    expect(listExportRecords().find((r) => r.job_id === run.id)?.expected?.guessed).toBe(true);
    await run.to(150, steady(4000));
    const row = listExportOutcomes().find((r) => r.job_id === run.id) as Any;
    expect(row.slower_than_expected).toBe(true);
    expect(row.projected_total_s).toBeGreaterThan(30 * 60);
    expect(String(row.note)).toMatch(/running slower than expected/);
    expect(row.time_left_s).toEqual(expect.any(Number));
    expect(row.progress_percent).toEqual(expect.any(Number));
    expect(Object.keys(row).filter((key) => key.startsWith("expected"))).toEqual([]);
    await run.end("finish");
  });
});
