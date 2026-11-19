// The chip is used whenever it passed its test for the picture's size, so no shipped file may still say that it is used only for long exports or only where it saves time. Two claims are retired: the note
// 0.28.0 drew for a chip that passed ("Auto: used for long exports where it saves time. ...") and the first words of the Quality / Fast view's note ("Auto: used when it saves time. ..."). A person reads
// one of them before the start and the export no longer does it. The scan reads the text of every shipped file, comments included (a comment that still states the old rule misleads the next reader), with
// runs of white space read as one space so that a claim broken over two lines is still found. The test files are not shipped: they write the retired sentences out on purpose, to hold the live words against them.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CHIP_ROW_NOTES } from "./chipRow";
import { D2_WORDS } from "./exportChoiceWords";

const SRC = path.resolve(__dirname, "..");
const rel = (file: string): string => path.relative(SRC, file).replace(/\\/g, "/");

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full);
    return [full];
  });

/** The shipped sources: not a test, not a smoke or end-to-end run, not test data, not a declaration file. */
const shipped = (): string[] =>
  walk(SRC).filter(
    (file) =>
      /\.(tsx?|json)$/.test(file) &&
      !/\.d\.ts$/.test(file) &&
      !/\.(test|spec|e2e)\.(tsx?|json)$/.test(file) &&
      !/[\\/](test|__e2e|__fixtures__)[\\/]/.test(file) &&
      !/__e2e\.ts$/.test(file),
  );

/** The retired claims: a kind of export, or a saving, named as the condition for the chip's use. */
const RETIRED_CLAIMS = ["used for long exports", "where it saves time", "when it saves time"];

/** Every retired claim in every file of a map of file name to text. Pure, so it can be tried on a small project of its own. */
function retiredClaimsIn(files: Record<string, string>): { file: string; claim: string }[] {
  return Object.entries(files).flatMap(([file, text]) => {
    const flat = text.replace(/\s+/g, " ").toLowerCase();
    return RETIRED_CLAIMS.filter((claim) => flat.includes(claim)).map((claim) => ({
      file,
      claim,
    }));
  });
}

describe("no shipped file still says the chip is used only for long exports or where it saves time", () => {
  it("scans the real sources, and finds none of the retired claims in any of them", () => {
    const files = shipped();
    // not an empty scan: the sources that carry the live words are among those read
    const names = files.map(rel);
    expect(names).toEqual(
      expect.arrayContaining([
        "timeline/chipRow.ts",
        "timeline/exportChoiceWords.ts",
        "timeline/exportWords.ts",
        "components/ChipRow.tsx",
      ]),
    );
    expect(files.length).toBeGreaterThan(100);
    const text = Object.fromEntries(files.map((file) => [rel(file), readFileSync(file, "utf8")]));
    expect(retiredClaimsIn(text)).toEqual([]);
  });

  it("does see a retired claim where one is, however the white space falls and whatever the case", () => {
    expect(
      retiredClaimsIn({
        "a.ts": 'const note = "Auto: used for long exports where it saves time. When it is used";',
        "b.tsx": "<p>Auto: used when it\n  saves time. The file is usually larger</p>",
        "c.ts": "/* the chip is Used   For Long\n   Exports */ export const fine = 1;",
        "d.ts": 'const ok = "Auto: used on this PC. The file is usually larger.";',
      }),
    ).toEqual([
      { file: "a.ts", claim: "used for long exports" },
      { file: "a.ts", claim: "where it saves time" },
      { file: "b.tsx", claim: "when it saves time" },
      { file: "c.ts", claim: "used for long exports" },
    ]);
  });

  // The live words, held beside the scan: the claim is gone and what stands in its place is there, in the row of the 0.28.0-style dialog and in both notes of the Quality / Fast view.
  it("says in every live note for a chip that passed that it is used on this PC", () => {
    for (const note of [
      CHIP_ROW_NOTES.auto_passed,
      D2_WORDS.chipNotePassed,
      D2_WORDS.chipNotePassedFast,
    ]) {
      expect(note).toMatch(/^Auto: used on this PC\. /);
      expect(retiredClaimsIn({ note })).toEqual([]);
    }
  });
});
