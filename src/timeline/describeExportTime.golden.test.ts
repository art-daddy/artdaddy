// The words for a time (`describeExportTime`), frozen as the tree before the live time-left wiring ran them.
//
// The function is shared by the `export` tool's reply note, the preflight questions, the estimate words and the Export dialog, and the live
// time-left rule says its figures through it too. `__fixtures__/describeExportTime.golden.json` is its answer for 208 inputs (seconds, the
// edge of "under a minute", every half-minute rounding edge, the minutes-to-hours edge, every figure the live rule can say, a fixed spread of
// the rest, and the inputs that are not a time), captured ONCE from the untouched function and never regenerated. A row that moves means the
// words moved: find out why, do not bless it. The file's hash is pinned below so it cannot be regenerated without this file saying so.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { describeExportTime } from "./exportOptions";
import { roundTimeLeft } from "./exportTimeLeft";

const GOLDEN = "src/timeline/__fixtures__/describeExportTime.golden.json";
const GOLDEN_SHA256 = "e676a060d12d624dc83ccdac85d2a9cc210fc5e76340ce069e847623a8718c72";

type Input = number | string | null;

const text = readFileSync(GOLDEN, "utf8").replace(/\r\n/g, "\n");
const golden = JSON.parse(text) as { rows: Array<[Input, string]> };

/** "NaN", "Infinity" and "-Infinity" stand for those numbers (JSON has none). */
const timeOf = (input: Input): number | null =>
  input === null ? null : typeof input === "string" ? Number(input) : input;

describe("the words for a time, as they were before the live time-left wiring", () => {
  it("reads the file that was captured", () => {
    expect(createHash("sha256").update(text).digest("hex")).toBe(GOLDEN_SHA256);
    expect(golden.rows.length).toBeGreaterThanOrEqual(200);
  });

  it("says the same words for every frozen input", () => {
    const moved = golden.rows
      .map(([input, words]) => ({ input, words, now: describeExportTime(timeOf(input)) }))
      .filter((row) => row.now !== row.words);
    expect(moved).toEqual([]);
  });

  it("has a frozen word for every figure the live rule can say, up to twelve hours", () => {
    const frozen = new Set(
      golden.rows.map(([input]) => timeOf(input)).filter((n): n is number => n !== null),
    );
    const missing = new Set<number>();
    for (let raw = 0; raw <= 12 * 3600; raw += 7) {
      const figure = roundTimeLeft(raw);
      if (!frozen.has(figure)) missing.add(figure);
    }
    expect([...missing]).toEqual([]);
  });
});
