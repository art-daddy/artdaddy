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

interface Answer {
  encoder: string;
  reason: string;
  showRow: boolean;
  defaultMode: string;
  preset?: string;
}
const answerAt = (row: number): Answer => legend[codeAt(row)] as Answer;
const sameAnswer = (a: Answer, b: Answer): boolean =>
  a.encoder === b.encoder &&
  a.reason === b.reason &&
  a.showRow === b.showRow &&
  a.defaultMode === b.defaultMode &&
  a.preset === b.preset &&
  Object.keys(a).length === Object.keys(b).length;

// A PC with no chip and an export well over the promise line: 0.27.0 puts it on the faster setting.
const slow: ChoiceInput = {
  request: "auto",
  chip: null,
  chipDefaultOn: true,
  fasterX264On: true,
  fullSeconds: 500,
  fullMeasured: true,
  fastSeconds: null,
  durationSeconds: 100,
  promiseMultiple: 2,
};
const FASTER = {
  encoder: "x264_fast",
  preset: "veryfast",
  reason: "promise_line",
  showRow: false,
  defaultMode: "quality",
};
const WITHHELD = { encoder: "x264", reason: "none", showRow: false, defaultMode: "quality" };

describe("fasterSeconds: once the honest estimate is given, the faster setting needs a real saving", () => {
  it("is 0.27.0's rule while the input is absent", () => {
    expect(chooseEncoder(slow)).toEqual(FASTER);
    expect(chooseEncoder({ ...slow, fasterSeconds: undefined })).toEqual(FASTER);
  });

  it("chooses the faster setting only where it saves at least a quarter of the full time", () => {
    // A quarter of 500 s is 125 s, so the faster setting must take 375 s or less.
    for (const fasterSeconds of [0, 100, 374, 375])
      expect(chooseEncoder({ ...slow, fasterSeconds })).toEqual(FASTER);
    for (const fasterSeconds of [375.5, 376, 499, 500, 1000])
      expect(chooseEncoder({ ...slow, fasterSeconds })).toEqual(WITHHELD);
  });

  it("shows no saving without a usable number, so it keeps the picture", () => {
    for (const fasterSeconds of [null, Number.NaN, Number.POSITIVE_INFINITY, -1])
      expect(chooseEncoder({ ...slow, fasterSeconds })).toEqual(WITHHELD);
  });

  it("changes nothing outside the faster-setting branch: a chip, a person's pick and a short export answer as before", () => {
    const withheldEverywhere = { fasterSeconds: 500 };
    for (const over of [
      { chip: "amd" as const },
      { request: "full" as const },
      { request: "fast" as const, chip: "intel" as const, fastSeconds: 100 },
      { fullSeconds: 55, durationSeconds: 2 },
      { fasterX264On: false },
    ])
      expect(chooseEncoder({ ...slow, ...over, ...withheldEverywhere })).toEqual(
        chooseEncoder({ ...slow, ...over }),
      );
  });

  it("only ever withholds the faster setting: across the golden axes nothing else about an answer moves", () => {
    const values = (full: number | null): (number | null | undefined)[] => {
      const f = full !== null && Number.isFinite(full) && full > 0 ? full : 100;
      return [
        undefined,
        null,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        -1,
        0,
        f / 2,
        f * 0.75,
        f * 0.76,
        f,
        f * 2,
      ];
    };
    const quarterSaved = (value: number | null | undefined, full: number | null): boolean =>
      value !== null &&
      value !== undefined &&
      full !== null &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= full * 0.75;
    let row = 0;
    let checked = 0;
    let withheld = 0;
    let kept = 0;
    const moved: string[] = [];
    for (const input of combinations()) {
      // The faster setting is only ever asked about for the automatic request on a PC with no chip: every one of
      // those rows, and one row in twenty-nine of the rest, where the new input must change nothing.
      const inBranch = input.request === "auto" && input.chip === null;
      if (inBranch || row % 29 === 0) {
        const base = answerAt(row);
        for (const value of values(input.fullSeconds)) {
          const answer = chooseEncoder(
            value === undefined ? input : { ...input, fasterSeconds: value },
          );
          const keeps =
            base.encoder !== "x264_fast" ||
            value === undefined ||
            quarterSaved(value, input.fullSeconds);
          const wanted = keeps
            ? base
            : {
                encoder: "x264",
                reason: "none",
                showRow: base.showRow,
                defaultMode: base.defaultMode,
              };
          checked += 1;
          if (base.encoder === "x264_fast" && value !== undefined) {
            if (keeps) kept += 1;
            else withheld += 1;
          }
          if (!sameAnswer(answer, wanted) && moved.length < 5)
            moved.push(
              `row ${row} ${showable(input)} with ${String(value)}: ${JSON.stringify(answer)}`,
            );
        }
      }
      row += 1;
    }
    expect(moved).toEqual([]);
    // The sweep reached the branch both ways: it withheld some, and kept some.
    expect(checked).toBeGreaterThan(200_000);
    expect(withheld).toBeGreaterThan(1000);
    expect(kept).toBeGreaterThan(1000);
  });
});

describe("the quick request: the chip where there is one, else the faster setting, else the normal setting", () => {
  const quick = (over: Partial<ChoiceInput> = {}) =>
    chooseEncoder({ ...slow, request: "quick", ...over });

  it("answers with the chip that is there, whatever the estimates and the switches say", () => {
    for (const chip of ["amd", "nvidia", "intel"] as const)
      for (const chipDefaultOn of [true, false])
        for (const fasterX264On of [true, false])
          for (const [fullSeconds, fastSeconds] of [
            [500, 100],
            [30, 29],
            [500, 500],
            [null, null],
            [Number.NaN, Number.NaN],
          ] as const) {
            const answer = quick({ chip, chipDefaultOn, fasterX264On, fullSeconds, fastSeconds });
            expect(answer).toMatchObject({ encoder: chip, reason: "person" });
            expect(answer.preset).toBeUndefined();
          }
  });

  it("answers with the processor's faster setting where there is no chip and that switch is on", () => {
    expect(quick()).toEqual({ ...FASTER, reason: "person" });
    // The faster setting's own saving test is for the automatic choice: Quick is the person's pick.
    expect(quick({ fasterSeconds: 9999 })).toEqual({ ...FASTER, reason: "person" });
    expect(quick({ fasterSeconds: null, fullSeconds: null })).toMatchObject({
      encoder: "x264_fast",
      reason: "person",
    });
  });

  it("answers with the processor's normal setting where there is neither, and says it was asked for", () => {
    const answer = quick({ fasterX264On: false });
    expect(answer).toEqual({ ...WITHHELD, reason: "person" });
    expect(answer.preset).toBeUndefined();
  });

  it("holds for every combination of facts, and the Mode row it leaves behind is the automatic request's", () => {
    let rows = 0;
    const wrong: string[] = [];
    for (const input of combinations()) {
      if (input.request !== "auto") continue;
      const answer = chooseEncoder({ ...input, request: "quick" });
      const auto = chooseEncoder(input);
      const encoder = input.chip ?? (input.fasterX264On ? "x264_fast" : "x264");
      const ok =
        answer.encoder === encoder &&
        answer.reason === "person" &&
        (answer.preset === "veryfast") === (encoder === "x264_fast") &&
        answer.showRow === auto.showRow &&
        answer.defaultMode === auto.defaultMode;
      if (!ok && wrong.length < 5) wrong.push(`${showable(input)}: ${JSON.stringify(answer)}`);
      rows += 1;
    }
    expect(wrong).toEqual([]);
    expect(rows).toBe(golden.rows / 3);
  });
});
