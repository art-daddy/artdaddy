import { describe, expect, it } from "vitest";

import { clampClipValues, clampTimelineValues } from "./clamp";
import type { Clip, Timeline } from "./model";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// Mutation-tested (Stryker): 94.96% on clamp.ts. The residual survivors are all
// equivalent mutants -- boundary equality in clampNum (v===lo / x===hi yield the
// same result), the isNum half of the crop-pair guard (shadowed by the un-mutated
// `va+vb>=0.99` conjunct, which already requires both to be numeric), and the
// `?? []` / loop-bound fallbacks that emit the same [] -- so they are left unkilled.

/** A minimal clip with sensible timing defaults; `extra` overrides. */
const clip = (extra: Record<string, unknown>): Clip =>
  ({ timeline_in: 0, timeline_out: 30, ...extra }) as Any as Clip;

const tl = (tracks: Any): Timeline =>
  ({ units: "frames", canvas: { width: 1, height: 1, fps: 30 }, tracks }) as Any as Timeline;

describe("clampClipValues", () => {
  it("clamps opacity, volume, and scalar glow with exact notes", () => {
    const c = clip({ opacity: 1.5, volume: -2, glow: 200 });
    // Notes are emitted in field order and carry the exact old->new values.
    expect(clampClipValues(c, null)).toEqual(["opacity 1.5->1", "volume -2->0", "glow 200->100"]);
    expect((c as Any).opacity).toBe(1);
    expect((c as Any).volume).toBe(0);
    expect((c as Any).glow).toBe(100);
  });

  it("clamps glow object, crop pair scale, and duck with exact notes", () => {
    const c = clip({
      glow: { amount: 200, opacity: 2 },
      crop: { left: 0.6, right: 0.6 },
      duck: { against: "a", ratio: 0.5, threshold: 5 },
    });
    expect(clampClipValues(c, null)).toEqual([
      "glow.amount 200->100",
      "glow.opacity 2->1",
      "crop.left+right scaled to <1",
      "duck.ratio 0.5->1",
      "duck.threshold 5->1",
    ]);
    const a = c as Any;
    expect(a.glow.amount).toBe(100);
    expect(a.glow.opacity).toBe(1);
    expect(a.crop.left + a.crop.right).toBeCloseTo(0.98, 5);
    expect(a.duck.ratio).toBe(1);
    expect(a.duck.threshold).toBe(1);
  });

  it("clamps each crop side to 0.98 with a per-side note", () => {
    for (const side of ["left", "top", "right", "bottom"] as const) {
      const c = clip({ crop: { [side]: 1.5 } });
      expect(clampClipValues(c, null)).toEqual([`crop.${side} 1.5->0.98`]);
      expect((c as Any).crop[side]).toBe(0.98);
    }
  });

  it("scales a crop pair whose sum is exactly 0.99 (the >= boundary)", () => {
    const c = clip({ crop: { left: 0.5, right: 0.49 } }); // 0.5 + 0.49 === 0.99
    expect(clampClipValues(c, null)).toContain("crop.left+right scaled to <1");
    const a = c as Any;
    expect(a.crop.left + a.crop.right).toBeCloseTo(0.98, 5);
    expect(a.crop.left).toBeLessThan(0.5);
  });

  it("does not scale a crop pair when only one side is a number", () => {
    const c = clip({ crop: { left: 0.6 } }); // right absent -> pair guard must stay false
    expect(clampClipValues(c, null)).toEqual([]);
    expect((c as Any).crop.left).toBe(0.6);
  });

  it("clamps both fade edges to the clip span in frames (exact notes)", () => {
    const c = clip({ fade: { in: 40, out: 50 } });
    expect(clampClipValues(c, 30)).toEqual(["fade.in 40->30", "fade.out 50->30"]);
    expect((c as Any).fade.in).toBe(30);
    expect((c as Any).fade.out).toBe(30);
  });

  it("leaves a FRACTIONAL fade exactly as set", () => {
    // A clamp clamps; it does not tidy. The renderer reads fade/fps seconds, so 10.5 frames is
    // a legal value an agent may have set deliberately — rounding it here would rewrite the
    // document behind the caller's back and report a clamp that never happened. (Regression:
    // the fade KNOB briefly shared its rounding with this clamp.)
    const c = clip({ fade: { in: 10.5, out: 0.25 } });
    expect(clampClipValues(c, 30)).toEqual([]);
    expect((c as Any).fade.in).toBe(10.5);
    expect((c as Any).fade.out).toBe(0.25);
  });

  it("leaves an in-range fade edge alone", () => {
    const c = clip({ fade: { in: 40, out: 5 } });
    expect(clampClipValues(c, 30)).toEqual(["fade.in 40->30"]);
    expect((c as Any).fade.out).toBe(5);
  });

  it("returns no notes and mutates nothing for in-range scalars", () => {
    const c = clip({
      opacity: 0.5,
      volume: 3,
      glow: 50,
      crop: { left: 0.4, right: 0.4 },
      duck: { ratio: 2, threshold: 0.5 },
      fade: { in: 10, out: 10 },
    });
    expect(clampClipValues(c, 30)).toEqual([]);
    const a = c as Any;
    expect(a.opacity).toBe(0.5);
    expect(a.volume).toBe(3);
    expect(a.glow).toBe(50);
    expect(a.crop).toEqual({ left: 0.4, right: 0.4 });
    expect(a.duck).toEqual({ ratio: 2, threshold: 0.5 });
    expect(a.fade).toEqual({ in: 10, out: 10 });
  });

  it("leaves NaN scalars untouched (non-finite is validation's job)", () => {
    const c = clip({
      opacity: NaN,
      glow: { amount: NaN },
      duck: { ratio: NaN },
      fade: { in: NaN },
    });
    expect(clampClipValues(c, 30)).toEqual([]);
  });

  it("leaves keyframe arrays untouched", () => {
    const c = clip({ opacity: [{ t: 0, v: 5 }] });
    expect(clampClipValues(c, null)).toEqual([]);
    expect((c as Any).opacity).toEqual([{ t: 0, v: 5 }]);
  });

  it("does not clamp fade when the span is unknown", () => {
    const c = clip({ fade: { in: 99 } });
    expect(clampClipValues(c, null)).toEqual([]);
    expect((c as Any).fade.in).toBe(99);
  });

  it("does not crash and emits no notes when sub-objects are null or absent", () => {
    for (const extra of [{}, { glow: null }, { crop: null }, { duck: null }, { fade: null }]) {
      expect(() => clampClipValues(clip(extra), 30)).not.toThrow();
      expect(clampClipValues(clip(extra), 30)).toEqual([]);
    }
  });
});

describe("clampTimelineValues", () => {
  it("locates notes by track id and clip index (exact)", () => {
    const t = tl([
      { id: "v", kind: "video", z: 0, clips: [clip({ opacity: 2, fade: { in: 40, out: 6 } })] },
    ]);
    expect(clampTimelineValues(t)).toEqual([
      "v.clips[0]: opacity 2->1",
      "v.clips[0]: fade.in 40->30",
    ]);
    const c = (t.tracks[0].clips as Any)[0];
    expect(c.opacity).toBe(1);
    expect(c.fade.in).toBe(30); // clamped to the 30-frame span, NOT 1s (= 1 frame)
    expect(c.fade.out).toBe(6);
  });

  it("uses '?' when the track has no id", () => {
    const t = tl([{ kind: "video", z: 0, clips: [clip({ opacity: 2 })] }]);
    expect(clampTimelineValues(t)).toEqual(["?.clips[0]: opacity 2->1"]);
  });

  it("returns exactly [] for an all-in-range timeline", () => {
    const t = tl([{ id: "v", kind: "video", z: 0, clips: [clip({ opacity: 0.5 })] }]);
    expect(clampTimelineValues(t)).toEqual([]);
  });

  it("computes the fade span as timeline_out - timeline_in", () => {
    // span = 40 - 10 = 30, so a 40-frame fade clamps to 30 (NOT 40+10 = 50).
    const t = tl([
      {
        id: "v",
        kind: "video",
        z: 0,
        clips: [clip({ timeline_in: 10, timeline_out: 40, fade: { in: 40 } })],
      },
    ]);
    expect(clampTimelineValues(t)).toEqual(["v.clips[0]: fade.in 40->30"]);
    expect((t.tracks[0].clips as Any)[0].fade.in).toBe(30);
  });

  it("leaves the fade span null when timing is non-numeric", () => {
    // in/out non-numeric -> span stays null -> fade branch is skipped entirely,
    // so a negative fade.in is NOT clamped to 0.
    const t = tl([
      {
        id: "v",
        kind: "video",
        z: 0,
        clips: [clip({ timeline_in: "x", timeline_out: 40, fade: { in: -5 } })],
      },
    ]);
    expect(clampTimelineValues(t)).toEqual([]);
    expect((t.tracks[0].clips as Any)[0].fade.in).toBe(-5);
  });

  it("skips null and non-object clips and locates by index", () => {
    const t = tl([
      { id: "v", kind: "video", z: 0, clips: [null, undefined, 42, clip({ opacity: 5 })] },
    ]);
    expect(clampTimelineValues(t)).toEqual(["v.clips[3]: opacity 5->1"]);
  });

  it("handles missing tracks and missing clips arrays", () => {
    expect(clampTimelineValues(tl(undefined))).toEqual([]);
    expect(clampTimelineValues(tl([{ id: "v", kind: "video", z: 0 }]))).toEqual([]);
  });
});
