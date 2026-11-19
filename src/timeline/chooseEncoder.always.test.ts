// What the rule "the graphics chip is used whenever it passed" changed, measured against the table of the rule it replaced, and the rule's own
// properties over the whole input space.
//
// `__fixtures__/chooseEncoder.golden.json` is 0.27.0's answer for every combination of the axes. It stays as it was (it is pinned by hash here
// too), and the rows of the new table are pinned in `chooseEncoder.golden.test.ts`. This file asks the function the same questions as the old
// table and says exactly which answers moved: the cells where an automatic request (or the person's Fast) now gets the chip. For each cell the
// question "must this one move?" is worked out from the cell's inputs and the OLD answer alone, never from the new function.
import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { EXPORT_MODE_REASONS } from "../api/exportVocabulary";
import newTable from "./__fixtures__/chooseEncoder.always.golden.json";
import oldTable from "./__fixtures__/chooseEncoder.golden.json";
import {
  combinations,
  readTable,
  showable,
  signature,
  type Table,
  type TableAnswer,
} from "./__fixtures__/chooseEncoderTable";
import {
  CHIP_MAKERS,
  chooseEncoder,
  type ChoiceInput,
  type ChipMaker,
  type ModeRequest,
} from "./exportEncoder";

const OLD_ROWS_SHA256 = "b695117f9b34c1251a4b0cf3cb5c0dc7db83dc9da61fd6be35b9376a80c39bcc";
const old: Table = oldTable;
const now: Table = newTable;
const oldRead = readTable(old);

describe("0.27.0's table is still 0.27.0's table", () => {
  it("has the rows it was pinned with, and the new table says it was derived from exactly those", () => {
    expect(oldTable.rowsSha256).toBe(OLD_ROWS_SHA256);
    expect(createHash("sha256").update(oldTable.blocks.join("\n")).digest("hex")).toBe(
      OLD_ROWS_SHA256,
    );
    expect(newTable.generatedFrom.fixtureRowsSha256).toBe(OLD_ROWS_SHA256);
    // The two tables describe the same questions: one answer per combination, in the same order.
    expect(newTable.order).toEqual(oldTable.order);
    expect(newTable.axes).toEqual(oldTable.axes);
    expect(newTable.rows).toBe(oldTable.rows);
  });
});

const sameEncoder = (a: TableAnswer, b: TableAnswer): boolean =>
  a.encoder === b.encoder && a.preset === b.preset;

/** Whether the rule moved this cell's encoder: someone asked for the chip (the automatic request with the switch on, or the person's Fast), a
 *  chip passed for the picture, and the old answer was not that chip. Worked out from the inputs and the old answer only. */
function mustMove(input: ChoiceInput, before: TableAnswer): boolean {
  const asked = input.request === "fast" || (input.request === "auto" && input.chipDefaultOn);
  return asked && input.chip !== null && before.encoder !== input.chip;
}

describe("what the rule moved against 0.27.0, cell by cell", () => {
  interface Report {
    cells: number;
    moved: { auto: number; fast: number };
    alreadyOnChip: { auto: number; fast: number };
    keptCore: number;
    wrong: string[];
  }

  function compare(): Report {
    const report: Report = {
      cells: 0,
      moved: { auto: 0, fast: 0 },
      alreadyOnChip: { auto: 0, fast: 0 },
      keptCore: 0,
      wrong: [],
    };
    const complain = (row: number, input: ChoiceInput, what: string, got: object): void => {
      if (report.wrong.length < 8)
        report.wrong.push(
          `row ${row} ${showable(input)}: ${what}; 0.27.0 gave ${JSON.stringify(oldRead.answerAt(row))}, now ${JSON.stringify(got)}`,
        );
    };
    let row = 0;
    for (const input of combinations(old)) {
      const before = oldRead.answerAt(row);
      const after = chooseEncoder(input);
      report.cells += 1;
      const chipIsThere = input.chip !== null;
      const moved = !sameEncoder(before, after);
      if (moved !== mustMove(input, before))
        complain(
          row,
          input,
          moved ? "moved and should not have" : "did not move and should have",
          after,
        );
      // The word for why changes exactly where the encoder moved, and where 0.27.0 said over_minute (the same chip, now chip_default).
      if ((before.reason !== after.reason) !== (moved || before.reason === "over_minute"))
        complain(
          row,
          input,
          "a reason changed where nothing moved, or did not where it should",
          after,
        );
      if (moved) {
        // Only ever from the processor with no reason in particular to the chip that was asked for, the reason the request gives.
        const kind = input.request === "fast" ? "fast" : "auto";
        report.moved[kind] += 1;
        if (!(before.encoder === "x264" && before.reason === "none" && before.preset === undefined))
          complain(row, input, "an answer that was not the plain processor moved", after);
        const wantedReason = input.request === "fast" ? "person" : "chip_default";
        if (
          after.encoder !== input.chip ||
          after.reason !== wantedReason ||
          after.preset !== undefined
        )
          complain(
            row,
            input,
            `moved to something other than the chip with ${wantedReason}`,
            after,
          );
      } else {
        report.keptCore += 1;
        if (
          chipIsThere &&
          after.encoder === input.chip &&
          (input.request === "auto" || input.request === "fast")
        ) {
          report.alreadyOnChip[input.request] += 1;
          // A cell that already ran on the chip keeps its chip; only the word for why changes.
          const wantedReason = input.request === "fast" ? "person" : "chip_default";
          if (after.reason !== wantedReason)
            complain(
              row,
              input,
              "an answer that was already the chip changed more than its word",
              after,
            );
        }
      }
      // Nothing that used a chip before stops using it.
      if (
        before.encoder !== "x264" &&
        before.encoder !== "x264_fast" &&
        after.encoder !== before.encoder
      )
        complain(row, input, "a chip choice of 0.27.0 was taken away", after);
      // The old word for "the chip, because the export is long" is gone and its cells carry the new word.
      if (
        before.reason === "over_minute" &&
        !(after.reason === "chip_default" && after.encoder === before.encoder)
      )
        complain(row, input, "an over_minute cell is not the same chip with chip_default", after);
      if (after.reason === "over_minute")
        complain(row, input, "over_minute is still an answer", after);
      // A PC with no chip is not touched at all, in any of the five fields.
      if (!chipIsThere && signature(after) !== signature(before))
        complain(row, input, "an answer with no chip changed", after);
      // The Mode row is a statement about the chip: offered where one is usable, started on Fast where the app chooses it for the person.
      if (after.showRow !== chipIsThere)
        complain(row, input, "showRow is not 'a chip is usable'", after);
      if (after.defaultMode !== (chipIsThere && input.chipDefaultOn ? "fast" : "quality"))
        complain(
          row,
          input,
          "defaultMode is not 'Fast exactly where the chip is chosen for the person'",
          after,
        );
      row += 1;
    }
    return report;
  }

  const report = compare();

  it("moves exactly the cells where an automatic request, or the person's Fast, now gets the chip, and nothing else", () => {
    expect(report.wrong).toEqual([]);
    expect(report.cells).toBe(oldTable.rows);
    // The two kinds of moved cell, counted: the cells the rule changes in the table (printed here so a change of the table shows).
    expect(report.moved, `cells moved: ${JSON.stringify(report.moved)} of ${report.cells}`).toEqual(
      {
        auto: 29_376,
        fast: 52_992,
      },
    );
    expect(report.keptCore + report.moved.auto + report.moved.fast).toBe(report.cells);
  });

  it("leaves every cell that already ran on the chip on the same chip, and every cell for a PC with no chip as it was", () => {
    // Automatic with the switch on: every cell with a chip ends on it, those that moved and those that already did.
    let autoWithChipOn = 0;
    let fastWithChip = 0;
    for (const input of combinations(old)) {
      if (input.chip === null) continue;
      if (input.request === "auto" && input.chipDefaultOn) autoWithChipOn += 1;
      if (input.request === "fast") fastWithChip += 1;
    }
    expect(report.moved.auto + report.alreadyOnChip.auto).toBe(autoWithChipOn);
    expect(report.moved.fast + report.alreadyOnChip.fast).toBe(fastWithChip);
  });

  it("moves the Mode row's fields in more cells than the encoder: the row says a chip is usable, whatever the estimate", () => {
    let rows = 0;
    let rowFieldsChanged = 0;
    let coreChanged = 0;
    for (const input of combinations(old)) {
      const before = oldRead.answerAt(rows);
      const after = chooseEncoder(input);
      if (before.showRow !== after.showRow || before.defaultMode !== after.defaultMode)
        rowFieldsChanged += 1;
      if (!sameEncoder(before, after)) coreChanged += 1;
      rows += 1;
    }
    // The row semantics moved cells that did not move their encoder (a chip that does not save a quarter, the switch off, Full with a chip).
    expect(rowFieldsChanged).toBeGreaterThan(coreChanged);
    expect(coreChanged).toBe(report.moved.auto + report.moved.fast);
  });
});

describe("the new table is the answer of the rule, row by row", () => {
  it("has, for every cell, the answer the function gives (its own test pins the rows by hash)", () => {
    const answers = readTable(now);
    let row = 0;
    const wrong: string[] = [];
    for (const input of combinations(now)) {
      const want = answers.answerAt(row);
      const got = chooseEncoder(input);
      if (signature(got) !== signature(want) && wrong.length < 5)
        wrong.push(
          `row ${row} ${showable(input)}: ${JSON.stringify(got)} against ${JSON.stringify(want)}`,
        );
      row += 1;
    }
    expect(wrong).toEqual([]);
    expect(row).toBe(newTable.rows);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The rule over the whole input space, not only the table's axes
// ---------------------------------------------------------------------------------------------------------------------

/** A number the estimates could be (or not): any double, NaN and the infinities included, and the edges the old rule cared about. */
const estimate = fc.oneof(
  fc.constant(null),
  fc.double(),
  fc.constantFrom(
    0,
    -0,
    -1,
    1,
    59.999,
    60,
    60.001,
    61,
    3600,
    1e308,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ),
);
const estimates = fc.record({
  fullSeconds: estimate,
  fastSeconds: estimate,
  fasterSeconds: fc.option(estimate, { nil: undefined }),
  fullMeasured: fc.boolean(),
  durationSeconds: fc.oneof(fc.double(), fc.constantFrom(0, 1, 2, 30, 60, 3600)),
  promiseMultiple: fc.oneof(fc.double(), fc.constantFrom(0, 1, 2, 4)),
});
const request = fc.constantFrom<ModeRequest>("auto", "full", "fast", "quick");
const maker = fc.constantFrom<ChipMaker>(...CHIP_MAKERS);
const anyChip = fc.option(maker, { nil: null });
const facts = fc
  .tuple(request, anyChip, fc.boolean(), fc.boolean(), estimates)
  .map(([asked, chip, chipDefaultOn, fasterX264On, rest]): ChoiceInput => ({
    request: asked,
    chip,
    chipDefaultOn,
    fasterX264On,
    ...rest,
  }));
const RUNS = { numRuns: 600 };
const isChipEncoder = (encoder: string): boolean =>
  (CHIP_MAKERS as readonly string[]).includes(encoder);

describe("the rule, over every input it can be given", () => {
  it("never gives a chip encoder where there is no chip, for any request, estimate or length", () => {
    fc.assert(
      fc.property(facts, (input) => {
        fc.pre(input.chip === null);
        expect(isChipEncoder(chooseEncoder(input).encoder)).toBe(false);
      }),
      RUNS,
    );
  });

  it("gives the automatic request the chip, with chip_default, whatever the estimates and the length say", () => {
    fc.assert(
      fc.property(facts, maker, estimates, (input, chip, other) => {
        const asked: ChoiceInput = { ...input, request: "auto", chip, chipDefaultOn: true };
        const answer = chooseEncoder(asked);
        expect(answer).toMatchObject({ encoder: chip, reason: "chip_default" });
        expect(answer.preset).toBeUndefined();
        // Metamorphic: change every estimate and the length at random and the answer is the same.
        expect(chooseEncoder({ ...asked, ...other })).toEqual(answer);
      }),
      RUNS,
    );
  });

  it("keeps the automatic request on the processor, with nothing special to say, where the chip's switch is off", () => {
    fc.assert(
      fc.property(facts, maker, (input, chip) => {
        const answer = chooseEncoder({ ...input, request: "auto", chip, chipDefaultOn: false });
        expect(answer).toMatchObject({ encoder: "x264", reason: "none" });
        expect(answer.preset).toBeUndefined();
      }),
      RUNS,
    );
  });

  it("gives Full the processor's normal setting for the person's own pick, whatever else is true", () => {
    fc.assert(
      fc.property(facts, (input) => {
        const answer = chooseEncoder({ ...input, request: "full" });
        expect(answer).toMatchObject({ encoder: "x264", reason: "person" });
        expect(answer.preset).toBeUndefined();
      }),
      RUNS,
    );
  });

  it("gives Fast the chip where there is one, whatever the estimates, and the processor, with nothing to say, where there is not", () => {
    fc.assert(
      fc.property(facts, (input) => {
        const answer = chooseEncoder({ ...input, request: "fast" });
        if (input.chip === null) expect(answer).toMatchObject({ encoder: "x264", reason: "none" });
        else expect(answer).toMatchObject({ encoder: input.chip, reason: "person" });
        expect(answer.preset).toBeUndefined();
      }),
      RUNS,
    );
  });

  it("gives Quick the chip where there is one, whatever the switches say", () => {
    fc.assert(
      fc.property(facts, (input) => {
        fc.pre(input.chip !== null);
        expect(chooseEncoder({ ...input, request: "quick" })).toMatchObject({
          encoder: input.chip,
          reason: "person",
        });
      }),
      RUNS,
    );
  });

  it("never says over_minute, and says only words the report accepts", () => {
    fc.assert(
      fc.property(facts, (input) => {
        const { reason } = chooseEncoder(input);
        expect(reason).not.toBe("over_minute");
        expect(EXPORT_MODE_REASONS as readonly string[]).toContain(reason);
      }),
      RUNS,
    );
  });

  it("offers the Mode row where a chip is usable, and starts it on Fast exactly where the app chooses the chip for the person", () => {
    fc.assert(
      fc.property(facts, (input) => {
        const answer = chooseEncoder(input);
        expect(answer.showRow).toBe(input.chip !== null);
        expect(answer.defaultMode).toBe(
          input.chip !== null && input.chipDefaultOn ? "fast" : "quality",
        );
      }),
      RUNS,
    );
  });

  it("answers the same twice and does not change what it is given", () => {
    fc.assert(
      fc.property(facts, (input) => {
        const frozen = structuredClone(input);
        const once = chooseEncoder(Object.freeze({ ...input }));
        expect(input).toEqual(frozen);
        expect(chooseEncoder(input)).toEqual(once);
      }),
      RUNS,
    );
  });
});
