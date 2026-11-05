import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  CEILING_CAP_BYTES,
  CEILING_SHARE,
  CONVERT,
  GIB,
  RUNG_NAMES,
  UNMEASURED_RESERVE_BYTES,
  ceilingBytes,
  planRung,
  predictPeak,
  retryRung,
  type PeakSample,
  type Rung,
} from "./exportPlan";

const rung = fc.constantFrom<Rung>(0, 1, 2);
const sample = fc.record({
  rung,
  bytes: fc.double({ min: 1e6, max: 40 * GIB, noNaN: true }),
});
const samples = fc.array(sample, { minLength: 0, maxLength: 6 });
const free = fc.double({ min: 0, max: 128 * GIB, noNaN: true });

describe("the ceiling", () => {
  it("is three quarters of the free memory, never more than the cap the native watcher shares", () => {
    expect(ceilingBytes(8 * GIB)).toBe(6 * GIB);
    expect(ceilingBytes(2 * GIB)).toBe(1.5 * GIB);
    expect(ceilingBytes(100 * GIB)).toBe(CEILING_CAP_BYTES);
    expect(CEILING_CAP_BYTES).toBe(8 * GIB); // the native resident cap (budget.rs RENDER_RESIDENT_CEILING)
    expect(CEILING_SHARE).toBe(0.75);
  });

  it("only ever grows with free memory", () => {
    fc.assert(
      fc.property(free, free, (a, b) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        expect(ceilingBytes(low)).toBeLessThanOrEqual(ceilingBytes(high));
        expect(ceilingBytes(low)).toBeLessThanOrEqual(low);
      }),
    );
  });
});

describe("what a measurement at one rung says about another", () => {
  // What the lab measured, working set in GiB at the normal, gentle and gentlest rungs (exporter
  // document 8.2): 8K HEVC to 1080x1920 (3.52, 0.83, 0.76); a typical 1080x1920 phone clip (1.2 at
  // the normal rung, and it ran inside a 0.5 GiB wall at the gentle one, so at most 0.5).
  const lab: ReadonlyArray<readonly [string, readonly [number, number, number]]> = [
    ["8K HEVC", [3.52, 0.83, 0.76]],
    ["1080p phone clip", [1.2, 0.5, 0.5]],
  ];

  it("never predicts less than what the lab measured, whichever rung was measured", () => {
    for (const [name, peaks] of lab)
      for (const from of [0, 1, 2] as const)
        for (const to of [0, 1, 2] as const) {
          const predicted = predictPeak([{ rung: from, bytes: peaks[from] * GIB }], to);
          expect(predicted, `${name}: rung ${from} to ${to}`).toBeGreaterThanOrEqual(
            peaks[to] * GIB,
          );
        }
  });

  it("never lets a round trip make an export look smaller than it was", () => {
    for (const a of [0, 1, 2] as const)
      for (const b of [0, 1, 2] as const)
        expect(CONVERT[a][b] * CONVERT[b][a]).toBeGreaterThanOrEqual(1);
    for (const r of [0, 1, 2] as const) expect(CONVERT[r][r]).toBe(1);
  });

  it("converts from the measured rung that needs the least extrapolation, not the loosest one", () => {
    // 3.52 GiB was measured at the normal rung and 0.76 GiB at the gentlest: for the gentle rung in
    // between, the near neighbour is the better witness (the lab measured 0.83), not 3.52 times 0.6.
    const predicted = predictPeak(
      [
        { rung: 0, bytes: 3.52 * GIB },
        { rung: 2, bytes: 0.76 * GIB },
      ],
      1,
    )!;
    expect(predicted).toBeGreaterThanOrEqual(0.83 * GIB);
    expect(predicted).toBeLessThan(1 * GIB);
  });

  it("trusts a measurement at the rung itself over a conversion from another", () => {
    const predicted = predictPeak(
      [
        { rung: 0, bytes: 1.2 * GIB },
        { rung: 1, bytes: 0.4 * GIB },
      ],
      1,
    );
    expect(predicted).toBe(0.4 * GIB); // not 1.2 * 0.6
  });

  it("is the largest of several measurements at one rung, and ignores what is not a measurement", () => {
    const predicted = predictPeak(
      [
        { rung: 0, bytes: 1 * GIB },
        { rung: 0, bytes: 2 * GIB },
        { rung: 0, bytes: Number.NaN },
        { rung: 0, bytes: -5 },
        { rung: 0, bytes: 0 },
        { rung: 7 as Rung, bytes: 50 * GIB },
      ],
      0,
    );
    expect(predicted).toBe(2 * GIB);
    expect(predictPeak([], 0)).toBeNull();
    expect(predictPeak([{ rung: 0, bytes: Number.POSITIVE_INFINITY }], 1)).toBeNull();
  });
});

describe("choosing the rung", () => {
  const plan = (s: PeakSample[], f: number | null, min?: Rung, max?: Rung) =>
    planRung({ samples: s, freeBytes: f, minRung: min, maxRung: max });

  it("runs the 8K case gentle on a PC that cannot give the normal rung its peak, and says so", () => {
    // History: this shape peaked at 3.52 GiB at the normal rung. 4 GiB free gives a 3.0 GiB ceiling.
    const p = plan([{ rung: 0, bytes: 3.52 * GIB }], 4 * GIB);
    expect(p.rung).toBe(1);
    expect(p.fits).toBe(true);
    expect(p.basis).toBe("derived");
    expect(p.predictedBytes).toBeLessThanOrEqual(3 * GIB);
    expect(plan([{ rung: 0, bytes: 3.52 * GIB }], 40 * GIB).rung).toBe(0); // room: the fastest rung
  });

  it("never goes past the gentlest rung an engine has: the streamed engine has only the normal one", () => {
    const only = plan([{ rung: 0, bytes: 3.52 * GIB }], 2 * GIB, 0, 0);
    expect(only).toMatchObject({ rung: 0, fits: false });
    expect(only.neededFreeBytes).toBeCloseTo((3.52 * GIB) / 0.75, 0); // what THIS engine needs
    expect(plan([{ rung: 0, bytes: 3.52 * GIB }], 40 * GIB, 0, 0)).toMatchObject({
      rung: 0,
      fits: true,
    });
    fc.assert(
      fc.property(samples, fc.option(free, { nil: null }), rung, rung, (s, f, min, max) => {
        const p = planRung({ samples: s, freeBytes: f, minRung: min, maxRung: max });
        expect(p.rung).toBeLessThanOrEqual(Math.max(min, max));
      }),
      { numRuns: 300 },
    );
  });

  it("learns from the first gentle run: a tight PC asks once, and runs gentle after that", () => {
    // 2 GiB free (a 1.5 GiB ceiling). The first time only the normal rung is known, so the plan is
    // cautious and asks (and the person may start anyway, which runs the gentlest rung). The run leaves
    // a measurement at that rung, and the next export of the shape no longer needs to ask.
    const first = plan([{ rung: 0, bytes: 3.52 * GIB }], 2 * GIB);
    expect(first).toMatchObject({ rung: 2, fits: false });
    const second = plan(
      [
        { rung: 0, bytes: 3.52 * GIB },
        { rung: 2, bytes: 0.76 * GIB },
      ],
      2 * GIB,
    );
    expect(second).toMatchObject({ rung: 1, fits: true, basis: "derived" });
  });

  it("with nothing measured, runs the fastest rung, and the gentlest when less than the reserve is free (XR-28)", () => {
    // The reserve is what the GENTLEST rung needs (exporter document 19.4): a PC with less than that free asks
    // before it starts, and whoever answers Continue or Start anyway must be given the rung that needs least.
    for (const f of [0, 1e9, UNMEASURED_RESERVE_BYTES - 1]) {
      const p = plan([], f);
      expect(p).toMatchObject({ rung: 2, fits: false, basis: "unmeasured" });
      expect(p.neededFreeBytes).toBe(UNMEASURED_RESERVE_BYTES);
    }
    for (const f of [UNMEASURED_RESERVE_BYTES, 8 * GIB, 100 * GIB])
      expect(plan([], f)).toMatchObject({ rung: 0, fits: true, basis: "unmeasured" });
  });

  it("with nothing measured and a tight PC, goes only as gentle as the engine can, and never below what was asked", () => {
    expect(plan([], 1e9, 0, 0)).toMatchObject({ rung: 0, fits: false }); // the streamed engine: one rung
    expect(plan([], 1e9, 0, 1)).toMatchObject({ rung: 1, fits: false }); // two rungs are the same command
    expect(plan([], 1e9, 1)).toMatchObject({ rung: 2, fits: false });
    expect(plan([], 1e9, 2)).toMatchObject({ rung: 2, fits: false });
    // The question's own re-check is about the rung the command was captured at, so asking again never moves it.
    expect(plan([], 1e9, 2, 2)).toMatchObject({ rung: 2, fits: false });
    expect(plan([], 1e9, 0, 0).neededFreeBytes).toBe(UNMEASURED_RESERVE_BYTES);
  });

  it("with the PC unmeasured too, takes the rung it was given and refuses nothing", () => {
    expect(plan([], null)).toMatchObject({ rung: 0, fits: true, basis: "unknown_pc" });
    expect(plan([{ rung: 0, bytes: 9 * GIB }], null)).toMatchObject({ rung: 0, fits: true });
    expect(plan([], null, 2)).toMatchObject({ rung: 2, fits: true });
  });

  it("when even the gentlest rung does not fit, says how much free memory it would need", () => {
    const p = plan([{ rung: 0, bytes: 3.52 * GIB }], 0.5 * GIB);
    expect(p).toMatchObject({ rung: 2, fits: false });
    expect(p.neededFreeBytes).toBeGreaterThan(0.5 * GIB); // the numbers never contradict the verdict
  });

  it("holds for any history, any PC and any starting rung", () => {
    fc.assert(
      fc.property(samples, fc.option(free, { nil: null }), rung, (s, f, min) => {
        const p = planRung({ samples: s, freeBytes: f, minRung: min });
        expect(p.rung).toBeGreaterThanOrEqual(min);
        expect(p.rung).toBeLessThanOrEqual(2);
        const known = s.filter((x) => Number.isFinite(x.bytes) && x.bytes > 0);
        if (known.length === 0) {
          // With nothing measured the export is asked for as it is, unless the PC has less than the reserve
          // free: the reserve is what the gentlest rung needs, so then it runs the gentlest (XR-28).
          expect(p.rung).toBe(f !== null && f < UNMEASURED_RESERVE_BYTES ? 2 : min);
          expect(p.fits).toBe(f === null || f >= UNMEASURED_RESERVE_BYTES);
          return;
        }
        if (f === null) {
          expect(p.rung).toBe(min);
          expect(p.fits).toBe(true);
          return;
        }
        const ceiling = ceilingBytes(f);
        const peak = (r: Rung) => predictPeak(known, r)!;
        if (p.fits) {
          expect(peak(p.rung)).toBeLessThanOrEqual(ceiling); // it fits...
          for (let r = min; r < p.rung; r++) expect(peak(r as Rung)).toBeGreaterThan(ceiling); // ...and is the fastest that does
        } else {
          expect(p.rung).toBe(2);
          for (let r = min; r <= 2; r++) expect(peak(r as Rung)).toBeGreaterThan(ceiling);
          if (p.neededFreeBytes !== null) expect(p.neededFreeBytes).toBeGreaterThan(f);
        }
      }),
      { numRuns: 600 },
    );
  });

  it("is never gentler when there is more free memory", () => {
    fc.assert(
      fc.property(samples, free, free, rung, (s, a, b, min) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        const gentle = planRung({ samples: s, freeBytes: low, minRung: min }).rung;
        const quick = planRung({ samples: s, freeBytes: high, minRung: min }).rung;
        expect(quick).toBeLessThanOrEqual(gentle);
      }),
      { numRuns: 400 },
    );
  });

  it("does not change what it is given, and answers the same twice", () => {
    const s: PeakSample[] = [{ rung: 0, bytes: 3 * GIB }];
    const copy = structuredClone(s);
    const a = planRung({ samples: s, freeBytes: 3 * GIB });
    expect(s).toEqual(copy);
    expect(planRung({ samples: s, freeBytes: 3 * GIB })).toEqual(a);
  });

  it("names every rung", () => {
    expect(RUNG_NAMES).toEqual(["normal", "gentle", "gentlest"]);
  });
});

describe("trying again", () => {
  const forLack = ["memory_limit", "time_limit"];
  const otherwise = [
    "none",
    "source_unavailable",
    "storage_unavailable",
    "storage_full",
    "verification_failed",
    "render_failed",
    "interrupted",
    "cancelled",
    "declined",
    "unknown",
  ];

  it("asks one rung gentler after a failure for lack of memory or time, and never past the gentlest", () => {
    for (const reason of forLack) {
      expect(retryRung(0, reason)).toBe(1);
      expect(retryRung(1, reason)).toBe(2);
      expect(retryRung(2, reason)).toBe(2);
    }
  });

  it("lets the plan decide afresh after a failure that says nothing about how the work was done", () => {
    for (const reason of otherwise)
      for (const failed of [0, 1, 2] as Rung[]) expect(retryRung(failed, reason)).toBe(0);
  });

  it("is a rung that exists, and never below the one that failed when the failure was for lack", () => {
    fc.assert(
      fc.property(rung, fc.constantFrom(...forLack, ...otherwise), (failed, reason) => {
        const next = retryRung(failed, reason);
        expect([0, 1, 2]).toContain(next);
        if (forLack.includes(reason)) expect(next).toBeGreaterThanOrEqual(failed);
      }),
    );
  });

  // Found by review: an export that has no gentler command (the streamed engine, or thirteen video clips where the
  // two gentler rungs are the same command) must not be promised one.
  it("never asks for a rung the export does not have, whatever failed", () => {
    fc.assert(
      fc.property(rung, rung, fc.constantFrom(...forLack, ...otherwise), (failed, last, reason) => {
        const next = retryRung(failed, reason, last);
        expect(next).toBeLessThanOrEqual(Math.max(last, 0));
        if (forLack.includes(reason) && failed <= last)
          expect(next).toBe(Math.min(last, failed + 1));
      }),
    );
    expect(retryRung(0, "memory_limit", 0)).toBe(0); // the streamed engine: nothing gentler
    expect(retryRung(0, "memory_limit", 1)).toBe(1);
    expect(retryRung(1, "memory_limit", 1)).toBe(1);
    expect(retryRung(2, "time_limit", 1)).toBe(1);
  });
});
