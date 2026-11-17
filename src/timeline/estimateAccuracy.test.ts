// The accuracy bar of the dialog's estimate, and the proof that the compare which judges it can fail. The new estimator's coefficients are placeholders until they are fitted, so
// nothing here says the bar is met: it says the rule (at least 90 % within 2 times, the shown range holding the real time, no silent 4 times) is enforced, that 0.27.0's recorded estimates fail it at the
// recorded figure, that a perfect predictor passes and one that is always 3 times off fails, and that any table of recorded cells can be replayed through an estimate and judged.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import recorded from "./__fixtures__/e1RecordedLines.json";
import { BAR, compare, within, type AccuracyCell } from "../test/estimateAccuracy";

interface Line {
  row: string;
  variant: string;
  profile: string;
  frames: number;
  videoS: number;
  estimate: number;
  measured: number;
  suspect: boolean;
}
const LINES = recorded.lines as unknown as Line[];

const PROFILES = ["STRONG", "OK8", "WEAK4"];
/** What an estimate that never shows a range (0.27.0's own) is judged by: the range measure has nothing to read, so it is waived; the weak profiles never are. */
const noRange = { rangeNotShown: true } as const;
/** A table of `n` long cells whose estimate is `factor` times the measured time. */
const table = (n: number, factor: number | ((i: number) => number)): AccuracyCell[] =>
  Array.from({ length: n }, (_, i) => {
    const measured = 100 + i * 10;
    const f = typeof factor === "function" ? factor(i) : factor;
    return {
      row: `R${i}`,
      profile: PROFILES[i % PROFILES.length],
      videoS: 60,
      estimate: measured * f,
      measured,
    };
  });

describe("the compare can fail, and passes what is right", () => {
  it("passes a predictor that is the measured time itself, and one that is always 1.9 times off either way", () => {
    expect(compare(table(30, 1), noRange).verdict).toBe("pass");
    expect(compare(table(30, 1.9), noRange).verdict).toBe("pass");
    expect(compare(table(30, 1 / 1.9), noRange).verdict).toBe("pass");
  });

  it("fails a predictor that is always 3 times off, in either direction, and says why", () => {
    for (const factor of [3, 1 / 3]) {
      const out = compare(table(30, factor));
      expect(out.verdict, String(factor)).toBe("fail");
      expect(out.reasons.join(" ")).toMatch(/within 2 times, all judged cells: 0 %/);
    }
  });

  it("fails when one in five cells is more than 2 times off, and passes at one in ten (the bar is 90 %)", () => {
    const off = (every: number) => table(40, (i) => (i % every === 0 ? 3 : 1));
    expect(compare(off(5)).verdict).toBe("fail");
    expect(compare(off(10), noRange).verdict).toBe("pass");
    expect(compare(off(11), noRange).verdict).toBe("pass");
  });

  it("holds the weak profiles to the bar on their own: a good average cannot hide them", () => {
    const cells = table(60, (i) => (PROFILES[i % PROFILES.length] === "WEAK4" ? 3 : 1));
    const out = compare(cells);
    expect(out.verdict).toBe("fail");
    expect(out.reasons.join(" ")).toMatch(/weak profiles/);
    expect(out.measures.within2Weak.share).toBe(0);
  });

  it("fails an export under-estimated by 4 times that did not say it could take much longer, and lets one that said so through", () => {
    const quiet = table(30, 1);
    quiet[3] = { ...quiet[3], estimate: quiet[3].measured / 5 };
    const silent = compare(quiet);
    expect(silent.verdict).toBe("fail");
    expect(silent.measures.silentUnder4).toBe(1);
    const warned = quiet.map((c, i) => (i === 3 ? { ...c, couldTakeMuchLonger: true } : c));
    expect(compare(warned).measures.silentUnder4).toBe(0);
    expect(compare(warned, noRange).verdict).toBe("pass"); // one miss in 30 is inside the 90 %
  });

  it("holds a shown range to the bar: the real time must lie inside it in 90 % of the cells that show one", () => {
    const ranged = (inside: (i: number) => boolean) =>
      table(30, 1).map((c, i) => ({
        ...c,
        low: inside(i) ? c.measured * 0.5 : c.measured * 1.2,
        high: inside(i) ? c.measured * 1.5 : c.measured * 2,
      }));
    expect(compare(ranged(() => true)).verdict).toBe("pass");
    const bad = compare(ranged((i) => i % 2 === 0));
    expect(bad.verdict).toBe("fail");
    expect(bad.reasons.join(" ")).toMatch(/inside the shown range/);
  });

  it("is not a pass with too few cells to stand on", () => {
    expect(compare(table(BAR.minCells - 1, 1)).verdict).toBe("insufficient");
    expect(compare([]).verdict).toBe("insufficient");
  });

  it("does not pass what it has not judged: no weak profile, or no shown range, is insufficient and names the measure; the range alone can be waived for an estimate that shows none", () => {
    // ten long cells and every one of them strong: judged on the average, never on the weak PCs
    const strong = table(BAR.minCells, 1).map((c) => ({ ...c, profile: "STRONG" }));
    const noWeak = compare(strong, noRange);
    expect(noWeak.verdict).toBe("insufficient");
    expect(noWeak.thin.join(" ")).toMatch(/weak profiles: 0 cells/);
    // plenty of weak cells, but nothing shows a range
    const plain = table(30, 1);
    const unranged = compare(plain);
    expect(unranged.verdict).toBe("insufficient");
    expect(unranged.thin.join(" ")).toMatch(/inside the shown range: 0 cells/);
    expect(compare(plain, noRange).verdict).toBe("pass");
    // with weak cells present and a range shown, no waiver is needed (and the first case above shows that waiving the range never waives the weak profiles)
    expect(
      compare(
        plain.map((c) => ({ ...c, low: c.measured * 0.5, high: c.measured * 2 })),
        {},
      ).verdict,
    ).toBe("pass");
  });

  it("counts an estimate that is not a positive number as a miss, never drops the cell", () => {
    const cells = table(30, 1);
    [0, -5, Number.NaN, null, undefined].forEach((bad, i) => {
      cells[i] = { ...cells[i], estimate: bad as never };
    });
    const out = compare(cells);
    expect(out.judged).toBe(30);
    expect(out.measures.within2.ok).toBe(25);
    expect(out.verdict).toBe("fail");
  });

  it("judges only projects of 20 seconds or more by default (the field's own measure), and all of them when told", () => {
    const short = table(30, 3).map((c) => ({ ...c, videoS: 6 }));
    expect(compare(short).judged).toBe(0);
    expect(compare(short).verdict).toBe("insufficient");
    expect(compare(short, { minVideoS: 0 }).verdict).toBe("fail");
  });

  it("passes any table whose every cell is within 2 times, and fails any table where more than 10 % are not (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0.51, max: 1.99, noNaN: true }), {
          minLength: 30,
          maxLength: 60,
        }),
        (factors) => {
          const cells = table(factors.length, (i) => factors[i]);
          expect(within(cells).share).toBe(1);
          expect(compare(cells, noRange).verdict).toBe("pass");
        },
      ),
      { numRuns: 100 },
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 30, max: 60 }),
        fc.double({ min: 2.1, max: 20, noNaN: true }),
        (n, factor) => {
          // more than a tenth of the cells over-estimated by more than 2 times (an over-estimate is never a silent one)
          const misses = Math.floor(n * 0.11) + 1;
          const cells = table(n, (i) => (i < misses ? factor : 1));
          expect(within(cells).share!).toBeLessThan(0.9);
          expect(compare(cells).verdict).toBe("fail");
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("0.27.0's own recorded estimates, through the same compare (the RED figure)", () => {
  const cells = (minVideoS: number) =>
    compare(
      LINES.map((l) => ({
        row: l.row,
        profile: l.profile,
        videoS: l.videoS,
        estimate: l.estimate,
        measured: l.measured,
      })),
      { minVideoS },
    );

  it("are within 2 times on about 31 % of the 55 recorded lines, and more than 2 times too low on 28 of them (the lane's recorded figure)", () => {
    expect(LINES).toHaveLength(55);
    const all = cells(0);
    expect(all.judged).toBe(55);
    expect(all.measures.within2.ok / all.measures.within2.n).toBeGreaterThan(0.3);
    expect(all.measures.within2.ok / all.measures.within2.n).toBeLessThan(0.32);
    expect(LINES.filter((l) => l.measured / l.estimate > 2)).toHaveLength(28);
    expect(all.verdict).toBe("fail");
  });

  it("fail the bar on the lines of 20 seconds of video or more too: one of them is under-estimated by 6 times and says nothing", () => {
    const long = cells(20);
    expect(long.verdict).toBe("fail");
    expect(long.measures.silentUnder4).toBeGreaterThan(0);
  });
});

describe("replaying recorded cells through an estimate", () => {
  /** What a replay does: asks an estimate for each recorded line and judges the answers against what the export really took. */
  const replay = (estimateOf: (line: Line) => number | null) =>
    compare(
      LINES.map((l) => ({
        row: l.row,
        profile: l.profile,
        videoS: l.videoS,
        estimate: estimateOf(l),
        measured: l.measured,
      })),
      { minVideoS: 0 },
    );

  it("passes an estimate that knows the real time (as far as the lines allow: only seven of them are weak profiles, too few for that measure to stand on), fails one that is always 3 times off, and fails one that says nothing", () => {
    const perfect = replay((l) => l.measured);
    expect(perfect.reasons).toEqual([]);
    expect(perfect.measures.within2.share).toBe(1);
    expect(perfect.verdict).not.toBe("fail");
    expect(replay((l) => l.measured * 3).verdict).toBe("fail");
    expect(replay(() => null).verdict).toBe("fail");
  });

  it("fails 0.27.0's own estimate over the same lines, which is what the new estimator has to beat", () => {
    expect(replay((l) => l.estimate).verdict).toBe("fail");
  });
});
