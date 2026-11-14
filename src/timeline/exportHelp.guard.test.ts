// One help view-model, one advice function, one place for each sentence: this fails when a second copy of any of them appears. The banner's state is read from the exporter's one watch (exportHelpWatch.ts), which is
// the only place that asks the pure view-model (exportHelp.ts); the sentences of the advice are written in one module (lowerWords.ts) and the banner's in another (routeWords.ts).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full);
    return [full];
  });
}

/** The shipped sources: not a test, not a smoke or end-to-end run, not a test fixture. */
const sources = (): string[] =>
  walk(SRC).filter(
    (file) =>
      /\.tsx?$/.test(file) &&
      !/\.(test|spec|e2e)\.tsx?$/.test(file) &&
      !/[\\/](test|__e2e)[\\/.]/.test(file) &&
      !/__e2e\.ts$/.test(file),
  );
const rel = (file: string): string => path.relative(SRC, file).replace(/\\/g, "/");
/** A source with its comments taken out, so a sentence that names a function is not a use of it. */
const code = (file: string): string =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
const filesWith = (pattern: RegExp): string[] =>
  sources()
    .filter((file) => pattern.test(code(file)))
    .map(rel)
    .sort();

describe("the one help view-model and the one advice function", () => {
  it("asks the view-model in one place: the watch that keeps each export's banner state", () => {
    // its own definition and the one watch that calls it; the other files that name it import a type
    expect(filesWith(/\bexportHelp\(/)).toEqual([
      "timeline/exportHelp.ts",
      "timeline/exportHelpWatch.ts",
    ]);
  });

  it("writes the sentences of what to lower after a failure in one place", () => {
    expect(filesWith(/To use less memory, lower the picture size/)).toEqual([
      "timeline/lowerWords.ts",
    ]);
    expect(filesWith(/On this PC a lower picture size or frame rate/)).toEqual([
      "timeline/lowerWords.ts",
    ]);
    expect(filesWith(/To make that shorter, lower the picture size/)).toEqual([
      "timeline/lowerWords.ts",
    ]);
  });

  it("writes the banner's own sentences in one place, and the assistant's notes about it", () => {
    expect(filesWith(/This PC is slower than expected/)).toEqual(["timeline/routeWords.ts"]);
    expect(filesWith(/This export has stopped moving/)).toEqual(["timeline/routeWords.ts"]);
    expect(filesWith(/running slower than expected/)).toEqual(["timeline/routeWords.ts"]);
  });

  it("reads the exporter's remote switch for the help in one place, at every look: not a copy made when an export began", () => {
    expect(filesWith(/exportFlag\(\s*"export_help"\s*\)/)).toEqual(["timeline/exportHelpWatch.ts"]);
  });

  it("is reached by the card, the dialog and the assistant's list only through the watch", () => {
    for (const file of [
      "components/ExportCard.tsx",
      "components/ExportDialog.tsx",
      "timeline/exportQueue.ts",
    ])
      expect(code(path.join(SRC, file))).not.toMatch(/\bexportHelp\(/);
  });
});
