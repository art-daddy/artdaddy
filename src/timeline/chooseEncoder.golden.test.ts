// The one rule that decides the encoder (`chooseEncoder`), frozen as 0.27.0 ran it.
//
// `__fixtures__/chooseEncoder.golden.json` is the answer of the UNTOUCHED function of release 0.27.0 for every combination of the axes
// it lists, generated once and never regenerated. A row that moves means the rule changed: find out why, do not bless it. The rows are
// pinned by the hash below, so the data file cannot be regenerated without this file saying so in the same diff.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import golden from "./__fixtures__/chooseEncoder.golden.json";
import { chooseEncoder, type ChipMaker, type ChoiceInput, type ModeRequest } from "./exportEncoder";

const GOLDEN_ROWS_SHA256 = "b695117f9b34c1251a4b0cf3cb5c0dc7db83dc9da61fd6be35b9376a80c39bcc";

type FastSpec = string | number | { x: number } | null;

/** "NaN" and "Infinity" stand for the numbers (JSON has neither). */
const numberOf = (value: string | number): number =>
  typeof value === "string" ? Number(value) : value;

/** A `{ x }` is `full * x`, or `100 * x` where `full` is not a usable time. */
const fastOf = (spec: FastSpec, full: number | null): number | null => {
  if (spec === null) return null;
  if (typeof spec === "string" || typeof spec === "number") return numberOf(spec);
  const base = full !== null && Number.isFinite(full) && full > 0 ? full : 100;
  return base * spec.x;
};

/** Every combination, outermost axis first, in the order the file's rows are in. */
function* combinations(): Generator<ChoiceInput> {
  const axes = golden.axes;
  for (const request of axes.request as ModeRequest[])
    for (const chip of axes.chip as (ChipMaker | null)[])
      for (const chipDefaultOn of axes.chipDefaultOn)
        for (const fasterX264On of axes.fasterX264On)
          for (const fullSpec of axes.fullSeconds as (string | number | null)[]) {
            const fullSeconds = fullSpec === null ? null : numberOf(fullSpec);
            for (const fullMeasured of axes.fullMeasured)
              for (const fastSpec of axes.fastSeconds as FastSpec[]) {
                const fastSeconds = fastOf(fastSpec, fullSeconds);
                for (const durationSeconds of axes.durationSeconds)
                  for (const promiseMultiple of axes.promiseMultiple)
                    yield {
                      request,
                      chip,
                      chipDefaultOn,
                      fasterX264On,
                      fullSeconds,
                      fullMeasured,
                      fastSeconds,
                      durationSeconds,
                      promiseMultiple,
                    };
              }
          }
}

/** An answer with its keys in one order, so two answers are equal exactly when they hold the same keys and values. */
const signature = (answer: object): string =>
  JSON.stringify(Object.entries(answer).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const blockSize =
  golden.axes.fastSeconds.length *
  golden.axes.durationSeconds.length *
  golden.axes.promiseMultiple.length;
const codeAt = (row: number): string =>
  golden.blocks[Math.floor(row / blockSize)].charAt(row % blockSize);
const legend: Record<string, object> = golden.legend;
const wanted = new Map(Object.entries(legend).map(([code, answer]) => [code, signature(answer)]));
const showable = (input: ChoiceInput): string =>
  JSON.stringify(input, (_key, value) =>
    typeof value === "number" && !Number.isFinite(value) ? String(value) : value,
  );

describe("chooseEncoder as 0.27.0 ran it (the golden table)", () => {
  it("is the table generated from the untouched 0.27.0 function, and is the one that is pinned", () => {
    expect(golden.generatedFrom).toMatchObject({
      release: "0.27.0",
      file: "src/timeline/exportEncoder.ts",
      function: "chooseEncoder",
    });
    expect(golden.generatedFrom.commit.startsWith("30c35253")).toBe(true);
    expect(golden.rowsSha256).toBe(GOLDEN_ROWS_SHA256);
    expect(createHash("sha256").update(golden.blocks.join("\n")).digest("hex")).toBe(
      GOLDEN_ROWS_SHA256,
    );
  });

  it("has a row for every combination of its axes", () => {
    const axes = golden.axes as Record<string, unknown[]>;
    const product = golden.order.reduce((n, axis) => n * axes[axis].length, 1);
    expect(golden.rows).toBe(product);
    expect(golden.blocks.length * blockSize).toBe(product);
    for (const block of golden.blocks) expect(block).toHaveLength(blockSize);
  });

  it("gives every row the answer 0.27.0 gave", () => {
    let rows = 0;
    let moved = 0;
    const first: string[] = [];
    for (const input of combinations()) {
      const answer = chooseEncoder(input);
      if (signature(answer) !== wanted.get(codeAt(rows))) {
        moved += 1;
        if (first.length < 5)
          first.push(
            `row ${rows} ${showable(input)} gave ${JSON.stringify(answer)}, 0.27.0 gave ${JSON.stringify(legend[codeAt(rows)])}`,
          );
      }
      rows += 1;
    }
    expect(rows).toBe(golden.rows);
    expect({ moved, first }).toEqual({ moved: 0, first: [] });
  });

  it("is not a degenerate table: every kind of answer the rule can give is in it, and each is used", () => {
    const used = new Set(golden.blocks.join("").split(""));
    expect([...used].sort()).toEqual(Object.keys(legend).sort());
    const answers = Object.values(golden.legend);
    expect(new Set(answers.map((answer) => answer.encoder))).toEqual(
      new Set(["x264", "x264_fast", "amd", "nvidia", "intel"]),
    );
    expect(new Set(answers.map((answer) => answer.reason))).toEqual(
      new Set(["none", "person", "over_minute", "promise_line"]),
    );
  });
});
