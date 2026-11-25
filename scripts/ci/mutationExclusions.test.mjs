import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import base from "../../vitest.config";
import mutation, { EXCLUDED_FILES, SKIPPED_TESTS } from "../../vitest.mutation.config";
import { skipReason } from "./mutationSkipSetup.mjs";

const SETUP = "./scripts/ci/mutationSkipSetup.mjs";

/** A test as vitest hands it to a hook: its own name, inside the describes named before it (outermost first). */
const testNamed = (...names) => names.reduce((suite, name) => ({ name, suite }), undefined);

/** Whether a file still gives a test or describe this name: as a literal, or as the "%s" template of an `it.each` or
 *  `describe.each` whose case is itself a literal in the file. */
function written(text, name) {
  const quoted = (part) => ['"', "'", "`"].some((q) => text.includes(`${q}${part}${q}`));
  if (quoted(name)) return true;
  const escape = (part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const [, template] of text.matchAll(/["'`]([^"'`\n]*%s[^"'`\n]*)["'`]/g)) {
    const filled = new RegExp(`^${template.split("%s").map(escape).join("(.+)")}$`).exec(name);
    if (filled && filled.slice(1).every(quoted)) return true;
  }
  return false;
}

describe("what the mutation run leaves out (vitest.mutation.config.ts)", () => {
  it("names test files that exist, each entry one file and never a pattern", () => {
    for (const file of [...Object.keys(EXCLUDED_FILES), ...Object.keys(SKIPPED_TESTS)]) {
      expect(file, `${file} is not a test file`).toMatch(/\.test\.(ts|tsx|mjs)$/);
      expect(file, `${file} is a pattern: an entry names one file`).not.toMatch(/[*?[\]{}!]/);
      expect(existsSync(file), `${file} no longer exists: remove its entry`).toBe(true);
    }
  });

  it("names each skipped test by the names its file still gives it", () => {
    for (const [file, tests] of Object.entries(SKIPPED_TESTS)) {
      const text = readFileSync(file, "utf8");
      for (const part of Object.keys(tests).flatMap((name) => name.split(" > ")))
        expect(written(text, part), `${file} names no test or describe "${part}" any more`).toBe(
          true,
        );
    }
  });

  it("reads a generated name only when its template and its case are both in the file", () => {
    const text = 'it.each([["blank lines", "\\n"]])("is read in time: %s", () => {});';
    expect(written(text, "is read in time: blank lines")).toBe(true);
    expect(written(text, "is read in time: blank line")).toBe(false);
    expect(written(text, "is read in a moment: blank lines")).toBe(false);
    expect(written(text, "is read in time: ")).toBe(false);
  });

  it("leaves out the listed files and nothing else", () => {
    expect(mutation.test.exclude).toEqual([...base.test.exclude, ...Object.keys(EXCLUDED_FILES)]);
  });

  it("hands the skip list to the setup file that applies it, after the suite's own setup", () => {
    expect(mutation.test.setupFiles).toEqual([...base.test.setupFiles, SETUP]);
    expect(existsSync(SETUP)).toBe(true);
    expect(mutation.test.provide.mutationSkips).toEqual(SKIPPED_TESTS);
  });

  it("says why for every entry", () => {
    const reasons = [
      ...Object.values(EXCLUDED_FILES),
      ...Object.values(SKIPPED_TESTS).flatMap((tests) => Object.values(tests)),
    ];
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) expect(reason.length).toBeGreaterThan(30);
  });

  it("skips a test only by its whole name, in its own file", () => {
    const skips = { "src/a.test.ts": { "outer > inner > the test": "why" } };
    expect(skipReason(skips, "src/a.test.ts", testNamed("outer", "inner", "the test"))).toBe("why");
    // Not the same name under another describe, nor a part of the name, nor a longer one, nor in another file.
    for (const [file, test] of [
      ["src/a.test.ts", testNamed("other", "inner", "the test")],
      ["src/a.test.ts", testNamed("inner", "the test")],
      ["src/a.test.ts", testNamed("outer", "inner")],
      ["src/a.test.ts", testNamed("outer", "inner", "the test", "more")],
      ["src/a.test.ts", testNamed("outer", "inner", "the test (2)")],
      ["src/b.test.ts", testNamed("outer", "inner", "the test")],
      ["src/a.test.ts", testNamed("toString")],
    ])
      expect(skipReason(skips, file, test), `${file} ${JSON.stringify(test)}`).toBeUndefined();
    expect(
      skipReason(undefined, "src/a.test.ts", testNamed("outer", "inner", "the test")),
    ).toBeUndefined();
    // The file a test sits in is not one of its names.
    const file = { name: "src/a.test.ts" };
    file.file = file;
    const inFile = {
      name: "the test",
      suite: { name: "inner", suite: { name: "outer", suite: file } },
    };
    expect(skipReason(skips, "src/a.test.ts", inFile)).toBe("why");
  });
});
