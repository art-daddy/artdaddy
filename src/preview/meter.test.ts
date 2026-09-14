// Meter ballistics. A new pure module, so these are properties over its invariants rather than a
// handful of examples — and the invariants are the ones that make a meter trustworthy:
// it never reads below the floor, it rises instantly, it falls at a fixed rate per SECOND
// regardless of how often it is stepped, and a clip indicator never un-latches by itself.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  CEILING_DB,
  CLIP_THRESHOLD,
  FLOOR_DB,
  LEVEL_DECAY_DB_PER_SEC,
  PEAK_DECAY_DB_PER_SEC,
  PEAK_HOLD_SEC,
  SILENT,
  dbOf,
  meterFraction,
  peakOf,
  stepMeter,
} from "./meter";

const amp = () => fc.double({ min: 0, max: 4, noNaN: true });
const dt = () => fc.double({ min: 0, max: 0.5, noNaN: true });

describe("peakOf", () => {
  it("is the largest magnitude, sign-blind", () => {
    expect(peakOf([0.1, -0.9, 0.3])).toBe(0.9);
    expect(peakOf([])).toBe(0);
  });

  it("never reports less than any sample it was given (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: -2, max: 2, noNaN: true })), (xs) => {
        const p = peakOf(xs);
        for (const x of xs) expect(p).toBeGreaterThanOrEqual(Math.abs(x));
      }),
    );
  });
});

describe("dbOf", () => {
  it("puts full scale at 0dB and silence at the floor", () => {
    expect(dbOf(1)).toBeCloseTo(0, 9);
    expect(dbOf(0)).toBe(FLOOR_DB);
    expect(dbOf(-0)).toBe(FLOOR_DB);
  });

  it("halving amplitude drops about 6dB", () => {
    expect(dbOf(0.5)).toBeCloseTo(-6.02, 1);
  });

  it("never returns -Infinity or NaN, for any amplitude (property)", () => {
    fc.assert(
      fc.property(fc.double({ min: -10, max: 10, noNaN: true }), (a) => {
        const d = dbOf(a);
        expect(Number.isFinite(d)).toBe(true);
        expect(d).toBeGreaterThanOrEqual(FLOOR_DB);
      }),
    );
  });
});

describe("meterFraction", () => {
  it("spans 0 at the floor to 1 at full scale", () => {
    expect(meterFraction(FLOOR_DB)).toBe(0);
    expect(meterFraction(CEILING_DB)).toBe(1);
    expect(meterFraction(FLOOR_DB / 2)).toBeCloseTo(0.5, 9);
  });

  it("stays in 0..1 and never decreases as the level rises (property)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -120, max: 20, noNaN: true }),
        fc.double({ min: 0, max: 40, noNaN: true }),
        (a, up) => {
          const lo = meterFraction(a);
          const hi = meterFraction(a + up);
          expect(lo).toBeGreaterThanOrEqual(0);
          expect(hi).toBeLessThanOrEqual(1);
          expect(hi).toBeGreaterThanOrEqual(lo);
        },
      ),
    );
  });
});

describe("stepMeter", () => {
  it("rises to a transient IMMEDIATELY — the reason a peak meter exists", () => {
    const s = stepMeter(SILENT, 1, 1 / 60);
    expect(s.db).toBeCloseTo(0, 6);
    expect(s.peakDb).toBeCloseTo(0, 6);
  });

  it("falls at the stated rate per second, not per step", () => {
    // The same one second of silence, delivered in 1 step or 100, must land in the same place.
    const loud = stepMeter(SILENT, 1, 0.016);
    const oneStep = stepMeter(loud, 0, 1);
    let many = loud;
    for (let i = 0; i < 100; i++) many = stepMeter(many, 0, 0.01);
    expect(many.db).toBeCloseTo(oneStep.db, 6);
    expect(oneStep.db).toBeCloseTo(-LEVEL_DECAY_DB_PER_SEC, 6);
  });

  it("holds the peak marker, then lets it fall", () => {
    const loud = stepMeter(SILENT, 1, 0.016);
    let s = loud;
    for (let i = 0; i < 10; i++) s = stepMeter(s, 0, 0.1); // 1.0s of silence: inside the hold
    expect(s.heldSec).toBeLessThanOrEqual(PEAK_HOLD_SEC);
    expect(s.peakDb).toBeCloseTo(0, 6); // still held
  });

  // Mutation found these: "peakDb < -1" passed even when the marker collapsed straight to the
  // -60 floor, and when the decay divided by dt instead of multiplying. Assert WHERE it lands.
  it("drops the peak marker at exactly the stated rate once the hold expires", () => {
    let s = stepMeter(SILENT, 1, 0.016); // peak at 0dB
    // Run out the hold without a new peak, in steps small enough to stay above the floor.
    while (s.heldSec <= PEAK_HOLD_SEC) s = stepMeter(s, 0, 0.05);
    const before = s.peakDb;
    s = stepMeter(s, 0, 0.1);
    expect(s.peakDb).toBeCloseTo(before - PEAK_DECAY_DB_PER_SEC * 0.1, 6);
    expect(s.peakDb).toBeGreaterThan(FLOOR_DB); // it decays, it does not collapse
  });

  it("never lets the peak marker fall BELOW the live level", () => {
    // With Math.min in place of Math.max the marker sinks under the bar it is marking.
    let s = stepMeter(SILENT, 1, 0.016);
    while (s.heldSec <= PEAK_HOLD_SEC) s = stepMeter(s, 0, 0.05);
    for (let i = 0; i < 40; i++) {
      s = stepMeter(s, 0.5, 0.05); // a steady -6dB tone under a falling marker
      expect(s.peakDb).toBeGreaterThanOrEqual(s.db - 1e-9);
    }
    expect(s.db).toBeCloseTo(dbOf(0.5), 6);
  });

  it("keeps the marker pinned to a level that is merely SUSTAINED, not rising", () => {
    // `db >= peakDb` vs `db > peakDb`: on a dead-flat tone the hold must keep restarting,
    // otherwise the marker eventually walks down through a signal that never dropped.
    let s = SILENT;
    for (let i = 0; i < 200; i++) s = stepMeter(s, 0.5, 0.05); // 10s of steady tone
    expect(s.peakDb).toBeCloseTo(dbOf(0.5), 6);
    expect(s.heldSec).toBe(0);
  });

  it("keeps the peak marker at or above the level, always (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(amp(), dt()), { maxLength: 60 }), (steps) => {
        let s = SILENT;
        for (const [a, d] of steps) {
          s = stepMeter(s, a, d);
          expect(s.peakDb).toBeGreaterThanOrEqual(s.db - 1e-9);
        }
      }),
    );
  });

  it("never reads below the floor or produces NaN, however it is driven (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(amp(), dt()), { maxLength: 80 }), (steps) => {
        let s = SILENT;
        for (const [a, d] of steps) {
          s = stepMeter(s, a, d);
          expect(Number.isFinite(s.db)).toBe(true);
          expect(Number.isFinite(s.peakDb)).toBe(true);
          expect(s.db).toBeGreaterThanOrEqual(FLOOR_DB);
          expect(s.peakDb).toBeGreaterThanOrEqual(FLOOR_DB);
        }
      }),
    );
  });

  it("latches clipping and never clears it on its own (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(amp(), dt()), { minLength: 1, maxLength: 40 }), (steps) => {
        let s = SILENT;
        let everLoud = false;
        for (const [a, d] of steps) {
          everLoud = everLoud || a >= CLIP_THRESHOLD;
          s = stepMeter(s, a, d);
          expect(s.clipped).toBe(everLoud);
        }
      }),
    );
  });

  it("treats a zero or nonsense dt as no time passing rather than jumping", () => {
    const loud = stepMeter(SILENT, 1, 0.016);
    expect(stepMeter(loud, 0, 0).db).toBeCloseTo(loud.db, 9);
    expect(stepMeter(loud, 0, NaN).db).toBeCloseTo(loud.db, 9);
    expect(stepMeter(loud, 0, -5).db).toBeCloseTo(loud.db, 9);
  });

  it("counts a sample exactly AT the clip threshold as clipping", () => {
    expect(stepMeter(SILENT, CLIP_THRESHOLD, 0.016).clipped).toBe(true);
    expect(stepMeter(SILENT, CLIP_THRESHOLD - 1e-6, 0.016).clipped).toBe(false);
  });

  it("a silent source parks at the floor instead of drifting below it", () => {
    let s = SILENT;
    for (let i = 0; i < 200; i++) s = stepMeter(s, 0, 0.05);
    expect(s.db).toBe(FLOOR_DB);
    expect(s.peakDb).toBe(FLOOR_DB);
    expect(s.clipped).toBe(false);
  });
});
