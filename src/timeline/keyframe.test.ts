import { describe, expect, it } from "vitest";

import {
  isAnimated,
  keyframeAt,
  keyframeTimes,
  nextKeyframeTime,
  prevKeyframeTime,
  removeKeyframe,
  toConstant,
  toKeyframes,
  upsertKeyframe,
} from "./keyframe";

describe("keyframe editing helpers", () => {
  it("isAnimated distinguishes curves from constants", () => {
    expect(isAnimated(5)).toBe(false);
    expect(isAnimated(undefined)).toBe(false);
    expect(isAnimated([{ t: 0, v: 1 }])).toBe(true);
  });

  it("toKeyframes promotes a constant to a single key at t", () => {
    expect(toKeyframes(0.5, 10)).toEqual([{ t: 10, v: 0.5 }]);
    expect(toKeyframes(undefined, 3, 1)).toEqual([{ t: 3, v: 1 }]); // fallback used
    expect(toKeyframes(0.5, 10.4)).toEqual([{ t: 10, v: 0.5 }]); // t rounded
  });

  it("toKeyframes leaves an existing curve untouched", () => {
    const kfs = [{ t: 0, v: 1 }];
    expect(toKeyframes(kfs, 5)).toBe(kfs);
  });

  it("toConstant samples the curve at t", () => {
    const kfs = [
      { t: 0, v: 0 },
      { t: 10, v: 100 },
    ];
    expect(toConstant(kfs, 5)).toBe(50); // linear midpoint
    expect(toConstant(7, 5)).toBe(7); // already constant
    expect(toConstant(undefined, 5, 9)).toBe(9); // fallback
  });

  it("upsertKeyframe inserts, replaces, and keeps sorted order", () => {
    let v = upsertKeyframe(2, 0, 2); // promote constant -> key at 0
    expect(v).toEqual([{ t: 0, v: 2 }]);
    v = upsertKeyframe(v, 20, 5);
    v = upsertKeyframe(v, 10, 3);
    expect(v).toEqual([
      { t: 0, v: 2 },
      { t: 10, v: 3 },
      { t: 20, v: 5 },
    ]);
    v = upsertKeyframe(v, 10, 9); // replace at t=10
    expect(keyframeAt(v, 10)).toEqual({ t: 10, v: 9 });
    expect(v).toHaveLength(3);
  });

  it("upsertKeyframe carries an ease when provided", () => {
    expect(upsertKeyframe([{ t: 0, v: 0 }], 5, 1, "ease-in-out")).toContainEqual({
      t: 5,
      v: 1,
      ease: "ease-in-out",
    });
  });

  it("removeKeyframe drops a key but never empties the curve", () => {
    const kfs = [
      { t: 0, v: 0 },
      { t: 10, v: 1 },
    ];
    expect(removeKeyframe(kfs, 10)).toEqual([{ t: 0, v: 0 }]);
    expect(removeKeyframe([{ t: 0, v: 0 }], 0)).toEqual([{ t: 0, v: 0 }]); // last key kept
    expect(removeKeyframe(5, 0)).toBe(5); // constant unchanged
  });

  it("keyframeAt finds an exact key or nothing", () => {
    const kfs = [{ t: 12, v: 1 }];
    expect(keyframeAt(kfs, 12)).toEqual({ t: 12, v: 1 });
    expect(keyframeAt(kfs, 13)).toBeUndefined();
    expect(keyframeAt(7, 0)).toBeUndefined();
  });

  it("next/prev keyframe navigation respects strict ordering", () => {
    const kfs = [
      { t: 0, v: 0 },
      { t: 10, v: 1 },
      { t: 20, v: 2 },
    ];
    expect(nextKeyframeTime(kfs, 5)).toBe(10);
    expect(nextKeyframeTime(kfs, 20)).toBeUndefined(); // none after the last
    expect(prevKeyframeTime(kfs, 15)).toBe(10);
    expect(prevKeyframeTime(kfs, 0)).toBeUndefined(); // none before the first
    expect(nextKeyframeTime(3, 0)).toBeUndefined(); // constant
    expect(prevKeyframeTime(3, 0)).toBeUndefined();
  });

  it("keyframeTimes unions times across properties, sorted + unique", () => {
    const x = [
      { t: 0, v: 0 },
      { t: 10, v: 1 },
    ];
    const opacity = [
      { t: 10, v: 1 },
      { t: 30, v: 0 },
    ];
    expect(keyframeTimes([x, opacity, 5, undefined])).toEqual([0, 10, 30]);
    expect(keyframeTimes([7, undefined])).toEqual([]);
  });
});
