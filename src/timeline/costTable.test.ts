import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { COST_FEATURES, type CostFeature } from "./costShape";
import {
  BASE,
  ENCODE,
  ENGINE,
  FEATURE_PRICES,
  PRIOR_PACE,
  RANGE,
  REFERENCE_FRAME,
  REFERENCE_MEGAPIXELS,
  RUNG_TIME_FACTOR,
} from "./costTable";
import { CHIP_MAKERS, FASTER_X264_GAIN } from "./exportEncoder";

/** The features lane L3's fixes touch (the audit's "exact bundle": the exact cover mask, windowed masks, the dip layer, decode-once stills).
 *  Every other feature runs the same filters in both recipes, so its lean price must BE today's: a discount no fix delivers is a lie. */
const FIXED_BY_LANE_L3: readonly CostFeature[] = [
  "cover_zoom",
  "crossfade",
  "whip",
  "wipe",
  "dip",
  "fade",
  "still_decode",
];

/** What the audit measured the feature to add to a frame of a 1080x1920 clip (FILTER-MAP.md 8.5 and 8.10), against a plain frame of 13 ms.
 *  A placeholder is allowed to differ from its seed by what rounding costs, no more: when the lane fits the table on the rig these anchors
 *  are replaced with the fit's own, not left to fail. */
const AUDIT_MS_PER_FRAME: ReadonlyArray<readonly [CostFeature, number, number]> = [
  ["whip", 2.0736, 72],
  ["opacity_animated", 2.0736, 65],
  ["dip", 2.0736, 60],
  ["fade", 2.0736, 44],
  ["wipe", 2.0736, 25],
  ["crossfade", 2.0736, 22],
  ["contain_zoom", 2.0736, 9],
  ["opacity_constant", 2.0736, 9],
  ["grain", 2.0736, 26],
  ["chroma", 2.0736, 82],
  ["still_decode", 12, 43],
  ["cover_zoom", 2.5, 1182],
  ["cover_zoom", 7.9, 2625],
  ["cover_zoom", 16.8, 5000],
];
const MS_PER_REFERENCE_FRAME = 13;

describe("the cost table (every number a placeholder)", () => {
  it("prices every feature the cost shape can contain, in both recipes, and nothing else", () => {
    expect(Object.keys(FEATURE_PRICES).sort()).toEqual([...COST_FEATURES].sort());
    for (const feature of COST_FEATURES) {
      const price = FEATURE_PRICES[feature];
      expect(["frame", "megapixel_frame"], feature).toContain(price.unit);
      expect(["measured", "read", "assumed"], feature).toContain(price.basis);
      expect(price.seed.length, `${feature} says where it comes from`).toBeGreaterThan(20);
      for (const recipe of [price.today, price.lean])
        for (const value of [recipe.frame, recipe.window]) {
          expect(Number.isFinite(value) && value >= 0, feature).toBe(true);
        }
      // A price of nothing at all is not a price: a feature that is free says so with a small number, so "free" and "forgotten" differ.
      expect(price.today.frame + price.today.window, feature).toBeGreaterThan(0);
      expect(price.lean.frame + price.lean.window, feature).toBeGreaterThan(0);
    }
  });

  it("the lean recipe never costs more than today's for any load, and is today's for features no fix touches", () => {
    for (const feature of COST_FEATURES) {
      const { today, lean } = FEATURE_PRICES[feature];
      // For every window from none to the whole clip: the worst case is a window as long as the clip.
      expect(lean.frame, `${feature} frame`).toBeLessThanOrEqual(today.frame);
      expect(lean.frame + lean.window, `${feature} whole window`).toBeLessThanOrEqual(
        today.frame + today.window + 1e-9,
      );
      if (FIXED_BY_LANE_L3.includes(feature)) expect(lean.frame, feature).toBeLessThan(today.frame);
      else expect(lean, `${feature} has no fix, so no discount`).toEqual(today);
    }
    const cost = (price: { frame: number; window: number }, frames: number, window: number) =>
      price.frame * frames + price.window * window;
    fc.assert(
      fc.property(
        fc.constantFrom(...COST_FEATURES),
        fc.integer({ min: 1, max: 100_000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (feature, frames, share) => {
          const window = Math.floor(frames * share);
          const { today, lean } = FEATURE_PRICES[feature];
          expect(cost(lean, frames, window)).toBeLessThanOrEqual(
            cost(today, frames, window) + 1e-9,
          );
        },
      ),
    );
  });

  it("still describes the audit rows it was seeded from, to what rounding costs", () => {
    for (const [feature, mp, auditMs] of AUDIT_MS_PER_FRAME) {
      const price = FEATURE_PRICES[feature];
      const unit = price.unit === "megapixel_frame" ? mp : 1;
      const ms = price.today.frame * unit * MS_PER_REFERENCE_FRAME;
      expect(ms, `${feature} at ${mp} MP`).toBeGreaterThan(auditMs * 0.75);
      expect(ms, `${feature} at ${mp} MP`).toBeLessThan(auditMs * 1.25);
    }
    // The audit's seven-knob grade: four RGB filters and one eq.
    const grade =
      (4 * FEATURE_PRICES.grade_rgb.today.frame + FEATURE_PRICES.grade_basic.today.frame) *
      REFERENCE_MEGAPIXELS *
      MS_PER_REFERENCE_FRAME;
    expect(grade).toBeGreaterThan(29 * 0.75);
    expect(grade).toBeLessThan(29 * 1.25);
    // What a windowed mask still costs on the frames outside its window, against the audit's leftovers (+5.9, +16, +7.5, +18.5 ms).
    for (const [feature, auditMs] of [
      ["crossfade", 5.9],
      ["whip", 16],
      ["wipe", 7.5],
      ["fade", 18.5],
    ] as const) {
      const ms = FEATURE_PRICES[feature].lean.frame * REFERENCE_MEGAPIXELS * MS_PER_REFERENCE_FRAME;
      expect(ms, `${feature} outside its window`).toBeGreaterThan(auditMs * 0.75);
      expect(ms, `${feature} outside its window`).toBeLessThan(auditMs * 1.25);
    }
  });

  it("the reference export prices at exactly one reference frame", () => {
    expect(REFERENCE_FRAME.readMix + REFERENCE_FRAME.encode).toBeCloseTo(1, 12);
    expect(BASE.canvasFrame + BASE.layerFrame).toBeCloseTo(REFERENCE_FRAME.readMix, 12);
    expect(REFERENCE_MEGAPIXELS).toBeCloseTo((1920 * 1080) / 1e6, 12);
  });

  it("units: only the two per-frame features ignore the picture's size", () => {
    expect(
      COST_FEATURES.filter((feature) => FEATURE_PRICES[feature].unit === "frame").sort(),
    ).toEqual(["loudness", "speed_change"]);
  });

  it("the routes divide the encode term by gains that never promise a slowdown, and the unmeasured makers are the cautious ones", () => {
    for (const maker of CHIP_MAKERS) expect(ENCODE.chipGain[maker]).toBeGreaterThan(1);
    expect(ENCODE.chipGain.nvidia).toBeLessThanOrEqual(ENCODE.chipGain.amd);
    expect(ENCODE.chipGain.intel).toBeLessThanOrEqual(ENCODE.chipGain.amd);
    expect(ENCODE.fasterGain).toBe(FASTER_X264_GAIN);
    expect(ENCODE.quality.high).toBeGreaterThan(ENCODE.quality.medium);
    expect(ENCODE.quality.medium).toBeGreaterThan(ENCODE.quality.low);
    expect(ENGINE.streamed.min).toBeGreaterThanOrEqual(1);
    expect(ENGINE.streamed.max).toBeGreaterThanOrEqual(ENGINE.streamed.min);
    expect(RUNG_TIME_FACTOR[0]).toBe(1);
    expect(RUNG_TIME_FACTOR[1]).toBeGreaterThanOrEqual(RUNG_TIME_FACTOR[0]);
    expect(RUNG_TIME_FACTOR[2]).toBeGreaterThanOrEqual(RUNG_TIME_FACTOR[1]);
    expect(PRIOR_PACE.rHat).toBeGreaterThan(0);
  });

  it("the ranges nest, from narrow to very wide, and a single number is shown only where the range is narrow", () => {
    const nested = [RANGE.history, RANGE.derived, RANGE.pc_check, RANGE.guess];
    for (const range of nested) {
      expect(range.low).toBeLessThan(1);
      expect(range.high).toBeGreaterThan(1);
    }
    for (let i = 0; i + 1 < nested.length; i++) {
      expect(nested[i].low).toBeGreaterThanOrEqual(nested[i + 1].low);
      expect(nested[i].high).toBeLessThanOrEqual(nested[i + 1].high);
    }
    // DESIGN 3.4: one number when high / low is at most 1.8, a range otherwise.
    expect(RANGE.history.high / RANGE.history.low).toBeLessThanOrEqual(1.8);
    expect(RANGE.guess.high / RANGE.guess.low).toBeGreaterThan(1.8);
    expect(RANGE.muchLongerOver).toBe(4);
  });
});
