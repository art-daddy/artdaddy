import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { Instrumenter } from "@stryker-mutator/instrumenter";
import { describe, expect, it } from "vitest";

import base from "../../stryker.config.mjs";
import {
  PLAN,
  SHARD_NAMES,
  assignShards,
  candidateFiles,
  fileParts,
  globToRegExp,
  parsePlanKey,
  selectedBy,
  shardMutate,
  shardsToRun,
} from "../../stryker.ci.mjs";

const ts = createRequire(import.meta.url)("typescript");

/** The files `npm run mutation` mutates: what the shards together must cover, every line once. */
const scope = selectedBy(base.mutate, candidateFiles(base.mutate));
/** Every key of the plan (a file, or a part `file@anchor`), with its folder, shard and planned hours. */
const planned = Object.entries(PLAN.folders).flatMap(([folder, { shards }]) =>
  Object.entries(shards).flatMap(([shard, keys]) =>
    Object.entries(keys).map(([key, hours]) => ({
      folder,
      shard,
      key,
      hours,
      ...parsePlanKey(key),
    })),
  ),
);
/** What each shard hands to Stryker, read back: a whole file, or a file with its first and last line. */
const given = SHARD_NAMES.flatMap((shard) =>
  shardMutate(shard).map((entry) => {
    const range = /^(.*):(\d+)-(\d+)$/.exec(entry);
    return range
      ? { shard, file: range[1], first: Number(range[2]), last: Number(range[3]) }
      : { shard, file: entry, first: null, last: null };
  }),
);
const splitFiles = [...new Set(planned.filter((p) => p.anchor !== null).map((p) => p.file))];

describe("the mutation shards (stryker.ci.mjs, scripts/ci/mutationShards.json)", () => {
  it("mutate every line of every file of the scope in exactly one shard", () => {
    expect(scope.length, "the scan found the app, not nothing").toBeGreaterThan(200);
    expect(
      given.filter((g) => !scope.includes(g.file)).map((g) => g.file),
      "not in the scope",
    ).toEqual([]);
    for (const file of scope) {
      const entries = given.filter((g) => g.file === file).sort((a, b) => a.first - b.first);
      expect(entries.length, `${file} is in no shard`).toBeGreaterThan(0);
      if (entries.some((g) => g.first === null)) {
        expect(
          entries.map((g) => g.shard),
          `${file} is whole in one shard only`,
        ).toHaveLength(1);
        continue;
      }
      const lines = readFileSync(file, "utf8").split("\n").length;
      expect(entries[0].first, `${file} from its first line`).toBe(1);
      expect(entries.at(-1).last, `${file} to its last line`).toBe(lines);
      for (let i = 1; i < entries.length; i++)
        expect(entries[i].first, `${file}: no gap or overlap before ${entries[i].shard}`).toBe(
          entries[i - 1].last + 1,
        );
    }
    expect(splitFiles.length, "the plan cuts the biggest files into parts").toBeGreaterThan(0);
  });

  it("lose no mutant at a cut but the empty body of a function cut inside, by Stryker's own instrumenter", async () => {
    const quiet = Object.fromEntries(
      ["trace", "debug", "info", "warn", "error", "fatal"].flatMap((level) => [
        [level, () => {}],
        [`is${level[0].toUpperCase()}${level.slice(1)}Enabled`, () => false],
      ]),
    );
    const options = { plugins: null, excludedMutations: [], ignorers: [] };
    const mutantsOf = async (file, mutate) => {
      const { mutants } = await new Instrumenter(quiet).instrument(
        [{ name: file, content: readFileSync(file, "utf8"), mutate }],
        options,
      );
      return mutants.map((m) => {
        const { start, end } = m.location;
        return `${m.mutatorName} ${start.line + 1}:${start.column}-${end.line + 1}:${end.column} ${m.replacement}`;
      });
    };
    for (const file of splitFiles) {
      const whole = await mutantsOf(file, true);
      const tested = [];
      // Stryker's reading of `file:first-last`: whole lines, counted from 1 (from 0 inside Stryker)
      for (const g of given.filter((x) => x.file === file))
        tested.push(
          ...(await mutantsOf(file, [
            {
              start: { line: g.first - 1, column: 0 },
              end: { line: g.last - 1, column: Number.MAX_SAFE_INTEGER },
            },
          ])),
        );
      expect(
        tested.filter((m, i) => tested.indexOf(m) !== i),
        `${file}: tested twice`,
      ).toEqual([]);
      expect(
        tested.filter((m) => !whole.includes(m)),
        `${file}: not a mutant of the whole file`,
      ).toEqual([]);
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const cutInside = new Set(
        planned
          .filter((p) => p.file === file && p.anchor.includes("/"))
          .map((p) => p.anchor.split("/")[0]),
      );
      const emptied = source.statements
        .filter((s) => ts.isFunctionDeclaration(s) && s.body && cutInside.has(s.name.text))
        .map(
          (s) =>
            `BlockStatement ${source.getLineAndCharacterOfPosition(s.body.getStart(source)).line + 1}`,
        );
      const lost = whole.filter((m) => !tested.includes(m)).map((m) => m.split(":")[0]);
      expect(lost, `${file}: lost at a cut`).toEqual(emptied);
      expect(whole.length, `${file} has mutants`).toBeGreaterThan(100);
    }
  }, 120_000);

  it("name in the plan only files of the scope, each once, in a shard of their own folder", () => {
    expect(
      planned.filter((p) => !scope.includes(p.file)).map((p) => p.key),
      "no longer mutated: re-plan",
    ).toEqual([]);
    const keys = planned.map((p) => p.key);
    expect(
      keys.filter((k, i) => keys.indexOf(k) !== i),
      "planned twice",
    ).toEqual([]);
    expect(planned.filter((p) => !p.file.startsWith(p.folder)).map((p) => p.key)).toEqual([]);
    expect(
      splitFiles.filter((f) => keys.includes(f)),
      "planned whole and in parts",
    ).toEqual([]);
  });

  it("plan each shard at no more than the budget, and send new files to a shard of their folder", () => {
    expect(PLAN.budgetHours).toBeLessThanOrEqual(4);
    for (const [folder, { shards, newFilesGoTo }] of Object.entries(PLAN.folders)) {
      expect(Object.keys(shards), `${folder} sends new files to a shard of its own`).toContain(
        newFilesGoTo,
      );
      for (const [shard, keys] of Object.entries(shards)) {
        const hours = Object.values(keys).reduce((a, h) => a + h, 0);
        expect(hours, `${shard} is planned at ${hours.toFixed(2)} h`).toBeLessThanOrEqual(
          PLAN.budgetHours,
        );
        expect(Object.keys(keys).length, `${shard} has files`).toBeGreaterThan(0);
      }
    }
  });

  it("put a file the plan does not name in its folder's shard for new files, and any other file in rest", () => {
    const [folder, { newFilesGoTo }] = Object.entries(PLAN.folders)[0];
    const shardOf = assignShards([
      `${folder}brandNew.ts`,
      `${folder}deep/newer.ts`,
      "src/elsewhere/x.ts",
    ]);
    expect(shardOf.get(`${folder}brandNew.ts`)).toBe(newFilesGoTo);
    expect(shardOf.get(`${folder}deep/newer.ts`)).toBe(newFilesGoTo);
    expect(shardOf.get("src/elsewhere/x.ts")).toBe("rest");
    const whole = planned.find((p) => p.anchor === null);
    expect(assignShards([whole.file]).get(whole.file)).toBe(whole.shard);
  });

  it("refuse a plan that names a file in two shards, or both whole and in parts", () => {
    const plan = (shards) => ({
      budgetHours: 4,
      folders: { "src/x/": { newFilesGoTo: "x-1", shards } },
    });
    expect(() =>
      assignShards(
        ["src/x/a.ts"],
        plan({ "x-1": { "src/x/a.ts": 1 }, "x-2": { "src/x/a.ts": 1 } }),
      ),
    ).toThrow(/in two shards: x-1 and x-2/);
    expect(() =>
      assignShards(["src/x/a.ts"], plan({ "x-1": { "src/x/a.ts": 1, "src/x/a.ts@^": 1 } })),
    ).toThrow(/both whole and in parts/);
    const parts = assignShards(
      ["src/x/a.ts"],
      plan({ "x-1": { "src/x/a.ts@^": 1 }, "x-2": { "src/x/a.ts@b": 1 } }),
    );
    expect([...parts]).toEqual([
      ["src/x/a.ts@^", "x-1"],
      ["src/x/a.ts@b", "x-2"],
    ]);
  });

  it("cut a file only where a statement starts on a line of its own, and stop on an anchor it cannot find", () => {
    const text = [
      "import { x } from './x';", // 1
      "function f(a: number): number;", // 2
      "function f(a: string): string;", // 3
      "function f(a: unknown) {", // 4
      "  const one = 1;", // 5
      "  const two = 2; let three = 3;", // 6
      "  return [one, two, three, a];", // 7
      "}", // 8
      "export const g = 1, h = 2; type T = 1;", // 9
      "export class K {}", // 10
    ].join("\n");
    expect([...fileParts("a.ts", ["^", "f", "f/two", "K"], text)]).toEqual([
      ["^", { start: 1, end: 1 }],
      ["f", { start: 2, end: 5 }],
      ["f/two", { start: 6, end: 9 }],
      ["K", { start: 10, end: 10 }],
    ]);
    expect(() => fileParts("a.ts", ["^", "gone"], text)).toThrow(
      /declares no "gone".*rename its anchor/,
    );
    expect(() => fileParts("a.ts", ["^", "T"], text)).toThrow(/shares line 9/);
    expect(() => fileParts("a.ts", ["^", "f/three"], text)).toThrow(/shares line 6/);
    expect(() => fileParts("a.ts", ["f", "K"], text)).toThrow(/exactly one part from line 1/);
    expect(() => fileParts("a.ts", ["^", "g", "h"], text)).toThrow(
      /starts on line 9, as a.ts@g does/,
    );
    expect(() => fileParts("a.ts", ["^", "x/one"], text)).toThrow(/no top-level function "x"/);
    expect(() => fileParts("a.ts", ["^", "f/"], text)).toThrow(/not an anchor/);
  });

  it("start every shard, or the one asked for, and refuse a name that is not a shard", () => {
    expect(shardsToRun("all")).toEqual(SHARD_NAMES);
    expect(shardsToRun("")).toEqual(SHARD_NAMES);
    expect(shardsToRun(undefined)).toEqual(SHARD_NAMES);
    expect(shardsToRun("rest")).toEqual(["rest"]);
    expect(new Set(SHARD_NAMES).size).toBe(SHARD_NAMES.length);
    for (const wrong of ["timeline", "tools", "tool-1", "Rest"])
      expect(() => shardsToRun(wrong), wrong).toThrow(/not "all" or one of/);
    expect(() => shardMutate("tools")).toThrow(/not one of/);
  });

  it("read a glob of the scope the way Stryker does", () => {
    const re = globToRegExp("src/timeline/**/*.ts");
    for (const yes of ["src/timeline/a.ts", "src/timeline/x/y/a.ts"])
      expect(re.test(yes), yes).toBe(true);
    for (const no of [
      "src/timelines/a.ts",
      "src/timeline/a.tsx",
      "xsrc/timeline/a.ts",
      "src/timeline/a.ts/b",
    ])
      expect(re.test(no), no).toBe(false);
    expect(globToRegExp("src/**/*.test.ts").test("src/a.test.ts")).toBe(true);
    expect(globToRegExp("src/preview/scene.ts").test("src/preview/sceneXts")).toBe(false);
    for (const glob of base.mutate)
      expect(glob, "a pattern the reader does not know").not.toMatch(/[{}[\]]/);
    // what it selects is what the base list names: tests and the e2e harness stay out, the folders' code is in
    expect(scope.some((f) => /\.(test|e2e)\.ts$/.test(f) || f === "src/tools/__e2e.ts")).toBe(
      false,
    );
    expect(scope).toContain("src/preview/scene.ts");
    expect(scope.every((f) => existsSync(f))).toBe(true);
  });
});
