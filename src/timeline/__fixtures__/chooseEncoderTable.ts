// How the two chooseEncoder tables are laid out, and how to read one: `chooseEncoder.golden.json` (0.27.0's rule) and
// `chooseEncoder.always.golden.json` (the rule that uses the graphics chip whenever it passed). Both have the same axes. A table is its
// `axes` (named in `order`, outermost first) and its `blocks`: one string per combination of the first six axes, one character per
// combination of the last three, each character a key of `legend`.
import type { ChipMaker, ChoiceInput, ModeRequest } from "../exportEncoder";

export type FastSpec = string | number | { x: number } | null;

export interface TableAnswer {
  encoder: string;
  reason: string;
  showRow: boolean;
  defaultMode: string;
  preset?: string;
}

export interface Table {
  order: string[];
  axes: {
    request: string[];
    chip: (string | null)[];
    chipDefaultOn: boolean[];
    fasterX264On: boolean[];
    fullSeconds: (string | number | null)[];
    fullMeasured: boolean[];
    fastSeconds: unknown[];
    durationSeconds: number[];
    promiseMultiple: number[];
  };
  rows: number;
  rowsSha256: string;
  legend: Record<string, TableAnswer>;
  blocks: string[];
}

/** "NaN" and "Infinity" stand for the numbers (JSON has neither). */
export const numberOf = (value: string | number): number =>
  typeof value === "string" ? Number(value) : value;

/** A `{ x }` is `full * x`, or `100 * x` where `full` is not a usable time. */
export const fastOf = (spec: FastSpec, full: number | null): number | null => {
  if (spec === null) return null;
  if (typeof spec === "string" || typeof spec === "number") return numberOf(spec);
  const base = full !== null && Number.isFinite(full) && full > 0 ? full : 100;
  return base * spec.x;
};

/** Every combination, outermost axis first, in the order the table's rows are in. */
export function* combinations(table: Table): Generator<ChoiceInput> {
  const axes = table.axes;
  for (const request of axes.request as ModeRequest[])
    for (const chip of axes.chip as (ChipMaker | null)[])
      for (const chipDefaultOn of axes.chipDefaultOn)
        for (const fasterX264On of axes.fasterX264On)
          for (const fullSpec of axes.fullSeconds) {
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
export const signature = (answer: object): string =>
  JSON.stringify(Object.entries(answer).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** An input as text, with the numbers JSON has no word for spelled out. */
export const showable = (input: ChoiceInput): string =>
  JSON.stringify(input, (_key, value) =>
    typeof value === "number" && !Number.isFinite(value) ? String(value) : value,
  );

/** The characters of one block, and the answer of any row by its position in the table. */
export function readTable(table: Table): {
  blockSize: number;
  codeAt: (row: number) => string;
  answerAt: (row: number) => TableAnswer;
} {
  const blockSize =
    table.axes.fastSeconds.length *
    table.axes.durationSeconds.length *
    table.axes.promiseMultiple.length;
  const codeAt = (row: number): string =>
    table.blocks[Math.floor(row / blockSize)].charAt(row % blockSize);
  return { blockSize, codeAt, answerAt: (row) => table.legend[codeAt(row)] };
}
