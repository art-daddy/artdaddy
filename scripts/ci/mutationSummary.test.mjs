import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";

import {
  MIN_MUTANTS_TO_RANK,
  WEAKEST,
  folderOf,
  parseShards,
  reportMutation,
  shardOfReport,
  summarize,
  summaryMarkdown,
} from "./mutationSummary.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "mutationSummary.mjs");

/** A Stryker mutant as the JSON report writes it: only `status` matters to the summary. */
const mutant = (status) => ({
  id: "1",
  mutatorName: "ArithmeticOperator",
  replacement: "-",
  location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
  status,
});
const fileOf = (counts) => ({
  language: "typescript",
  source: "",
  mutants: Object.entries(counts).flatMap(([status, n]) =>
    Array.from({ length: n }, () => mutant(status)),
  ),
});
const reportOf = (files) => ({ schemaVersion: "2", thresholds: { high: 80, low: 60 }, files });

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "mutation-summary-"));
  dirs.push(d);
  return d;
};

describe("the score", () => {
  it("counts Killed and Timeout as caught and Survived and NoCoverage as misses, and leaves the rest out", () => {
    const s = summarize(
      reportOf({
        "src/timeline/a.ts": fileOf({
          Killed: 6,
          Timeout: 2,
          Survived: 3,
          NoCoverage: 1,
          CompileError: 2,
          RuntimeError: 1,
          Ignored: 1,
        }),
      }),
    );
    expect(s.total).toMatchObject({
      detected: 8,
      survived: 3,
      noCoverage: 1,
      excluded: 4,
      total: 16,
      valid: 12,
    });
    expect(s.total.score).toBeCloseTo((100 * 8) / 12, 10);
  });

  it("has no score, not 0 and not 100, when nothing in the run was valid", () => {
    const s = summarize(reportOf({ "src/a.ts": fileOf({ CompileError: 3, Ignored: 2 }) }));
    expect(s.total.score).toBeNull();
    expect(summaryMarkdown(s)).toContain("n/a");
  });

  it("is never above 100 or below 0, always adds up, and never rises when a survivor is added", () => {
    const counts = fc.record({
      Killed: fc.nat(40),
      Timeout: fc.nat(10),
      Survived: fc.nat(40),
      NoCoverage: fc.nat(40),
      CompileError: fc.nat(10),
      Ignored: fc.nat(10),
    });
    fc.assert(
      fc.property(counts, (c) => {
        const before = summarize(reportOf({ "src/a.ts": fileOf(c) })).total;
        const after = summarize(
          reportOf({ "src/a.ts": fileOf({ ...c, Survived: c.Survived + 1 }) }),
        ).total;
        expect(before.detected + before.survived + before.noCoverage + before.excluded).toBe(
          before.total,
        );
        if (before.score !== null) {
          expect(before.score).toBeGreaterThanOrEqual(0);
          expect(before.score).toBeLessThanOrEqual(100);
          expect(after.score).toBeLessThanOrEqual(before.score);
        }
      }),
    );
  });
});

describe("where it is weakest", () => {
  it("ranks the weakest files first, by score and then by how many misses they have", () => {
    const report = reportOf({
      "src/timeline/strong.ts": fileOf({ Killed: 19, Survived: 1 }),
      "src/timeline/weak.ts": fileOf({ Killed: 5, Survived: 15 }),
      "src/timeline/weaker.ts": fileOf({ Killed: 2, Survived: 10, NoCoverage: 8 }),
      "src/timeline/same-score-fewer-misses.ts": fileOf({ Killed: 2, Survived: 8 }),
    });
    expect(summarize(report).weakest.map((f) => f.path)).toEqual([
      "src/timeline/weaker.ts",
      "src/timeline/same-score-fewer-misses.ts",
      "src/timeline/weak.ts",
      "src/timeline/strong.ts",
    ]);
  });

  it("does not rank a file that has too few mutants to mean anything", () => {
    const few = { Survived: MIN_MUTANTS_TO_RANK - 1 };
    const enough = { Survived: MIN_MUTANTS_TO_RANK };
    const s = summarize(reportOf({ "src/a.ts": fileOf(few), "src/b.ts": fileOf(enough) }));
    expect(s.weakest.map((f) => f.path)).toEqual(["src/b.ts"]);
  });

  it(`lists at most ${WEAKEST} files`, () => {
    const files = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [
        `src/lib/f${i}.ts`,
        fileOf({ Killed: i, Survived: 12 }),
      ]),
    );
    expect(summarize(reportOf(files)).weakest).toHaveLength(WEAKEST);
  });

  it("groups files by their first two path segments and puts the weakest folder first", () => {
    const s = summarize(
      reportOf({
        "src/tools/x.ts": fileOf({ Killed: 1, Survived: 9 }),
        "src/tools/deep/y.ts": fileOf({ Killed: 1, Survived: 9 }),
        "src/timeline/z.ts": fileOf({ Killed: 9, Survived: 1 }),
      }),
    );
    expect(s.byFolder.map((f) => f.folder)).toEqual(["src/tools", "src/timeline"]);
    expect(s.byFolder[0]).toMatchObject({ detected: 2, survived: 18 });
    expect(folderOf("src/contract/clamp.ts")).toBe("src/contract");
    expect(folderOf("vite.config.ts")).toBe("vite.config");
  });

  it("says the score, each folder and each weak file in the page it writes", () => {
    const md = summaryMarkdown(
      summarize(reportOf({ "src/timeline/weak.ts": fileOf({ Killed: 5, Survived: 15 }) })),
    );
    expect(md).toContain("Mutation score 25.0%");
    expect(md).toContain("| src/timeline | 25.0% | 5 | 15 | 0 |");
    expect(md).toContain("| src/timeline/weak.ts | 25.0% | 15 | 0 |");
  });
});

describe("reading a report", () => {
  const run = (path, summaryFile, shards = []) => {
    let said = "";
    const code = reportMutation(path, {
      out: (t) => (said += t),
      summaryFile,
      shards,
    });
    return { code, said };
  };

  it("is an error when there is no report, it is not JSON, or it holds no mutants: an empty result must not look clean", () => {
    const d = tmp();
    writeFileSync(join(d, "broken.json"), "{ not json");
    writeFileSync(join(d, "empty.json"), JSON.stringify(reportOf({})));
    writeFileSync(join(d, "no-mutants.json"), JSON.stringify(reportOf({ "src/a.ts": fileOf({}) })));
    expect(run(join(d, "missing.json")).code).toBe(1);
    expect(run(join(d, "broken.json")).code).toBe(1);
    expect(run(join(d, "empty.json")).code).toBe(1);
    expect(run(join(d, "no-mutants.json")).code).toBe(1);
    expect(run(undefined).code).toBe(1);
  });

  it("is not an error however low the score is, and appends the page to the job summary", () => {
    const d = tmp();
    writeFileSync(
      join(d, "r.json"),
      JSON.stringify(reportOf({ "src/a.ts": fileOf({ Survived: 50 }) })),
    );
    const summaryFile = join(d, "step-summary.md");
    writeFileSync(summaryFile, "earlier text\n");
    const { code, said } = run(join(d, "r.json"), summaryFile);
    expect(code).toBe(0);
    expect(said).toContain("Mutation score 0.0%");
    const page = readFileSync(summaryFile, "utf8");
    expect(page.startsWith("earlier text\n")).toBe(true);
    expect(page).toContain("Mutation score 0.0%");
  });

  it("works as a command: exit 1 with no report, exit 0 with one", () => {
    const d = tmp();
    writeFileSync(
      join(d, "r.json"),
      JSON.stringify(reportOf({ "src/a.ts": fileOf({ Killed: 4, Survived: 1 }) })),
    );
    const env = { ...process.env, GITHUB_STEP_SUMMARY: "" };
    const none = spawnSync(process.execPath, [script, join(d, "nope.json")], {
      env,
      encoding: "utf8",
    });
    const some = spawnSync(process.execPath, [script, join(d, "r.json")], {
      env,
      encoding: "utf8",
    });
    expect(none.status).toBe(1);
    expect(some.status).toBe(0);
    expect(some.stdout).toContain("Mutation score 80.0%");
  });

  it("merges the reports of several shards into one score", () => {
    const d = tmp();
    writeFileSync(
      join(d, "a.json"),
      JSON.stringify(reportOf({ "src/timeline/a.ts": fileOf({ Killed: 9, Survived: 1 }) })),
    );
    writeFileSync(
      join(d, "b.json"),
      JSON.stringify(reportOf({ "src/tools/b.ts": fileOf({ Killed: 1, Survived: 9 }) })),
    );
    const { code, said } = run([join(d, "a.json"), join(d, "b.json")]);
    expect(code).toBe(0);
    expect(said).toContain("Mutation score 50.0%");
    expect(said).toContain("| src/timeline | 90.0% |");
    expect(said).toContain("| src/tools | 10.0% |");
  });

  it("names every shard the run started that sent no report, is an error, and still shows what arrived", () => {
    const d = tmp();
    const shardReport = (shard, files) => {
      const path = join(d, `mutation-${shard}`, "mutation.json");
      mkdirSync(dirname(path));
      writeFileSync(path, JSON.stringify(reportOf(files)));
      return path;
    };
    const timeline = shardReport("timeline-01", {
      "src/timeline/a.ts": fileOf({ Killed: 9, Survived: 1 }),
    });
    const rest = shardReport("rest", { "src/lib/b.ts": fileOf({ Killed: 1, Survived: 1 }) });
    const started = ["timeline-01", "timeline-02", "tools-1", "rest"];
    const lost = run([timeline, rest], undefined, started);
    expect(lost.code).toBe(1);
    expect(lost.said).toContain("2 of 4 shards sent no report: timeline-02, tools-1");
    expect(lost.said).toContain("Mutation score 83.3%");
    const all = run([timeline, rest], undefined, ["timeline-01", "rest"]);
    expect(all.code).toBe(0);
    expect(all.said).not.toContain("sent no report");
  });

  it("names the shards even when no report arrived at all", () => {
    const d = tmp();
    const { code, said } = run([join(d, "mutation-tools-1", "mutation.json")], undefined, [
      "tools-1",
      "rest",
    ]);
    expect(code).toBe(1);
    expect(said).toContain("no report from tools-1, rest");
  });

  it("takes a report as its shard's by the folder the workflow downloads it into", () => {
    expect(shardOfReport("reports/shards/mutation-timeline-01/mutation.json")).toBe("timeline-01");
    expect(shardOfReport("reports\\shards\\mutation-rest\\mutation.json")).toBe("rest");
    expect(parseShards('["tools-1","rest"]')).toEqual(["tools-1", "rest"]);
    for (const wrong of ["", "[]", '"rest"', "[1]", '[""]'])
      expect(() => parseShards(wrong), wrong).toThrow();
  });

  it("works as a command with the list of shards, and refuses a list it cannot read", () => {
    const d = tmp();
    const path = join(d, "mutation-rest", "mutation.json");
    mkdirSync(dirname(path));
    writeFileSync(
      path,
      JSON.stringify(reportOf({ "src/a.ts": fileOf({ Killed: 4, Survived: 1 }) })),
    );
    const env = { ...process.env, GITHUB_STEP_SUMMARY: "" };
    const cmd = (...args) =>
      spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8" });
    const fine = cmd("--shards", '["rest"]', path);
    expect(fine.status).toBe(0);
    expect(fine.stdout).toContain("Mutation score 80.0%");
    const short = cmd("--shards", '["rest","tools-1"]', path);
    expect(short.status).toBe(1);
    expect(short.stdout).toContain("1 of 2 shards sent no report: tools-1");
    const garbled = cmd("--shards", "", path);
    expect(garbled.status).toBe(1);
    expect(garbled.stdout).toContain("the list of shards the run started is missing or wrong");
  });

  it("is an error when one of several reports is missing, and still summarises the others", () => {
    const d = tmp();
    writeFileSync(
      join(d, "a.json"),
      JSON.stringify(reportOf({ "src/a.ts": fileOf({ Killed: 4, Survived: 1 }) })),
    );
    const { code, said } = run([join(d, "a.json"), join(d, "gone.json")]);
    expect(code).toBe(1);
    expect(said).toContain("Mutation score 80.0%");
    expect(said).toContain("no report at");
  });
});
