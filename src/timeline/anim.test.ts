import { describe, expect, it } from "vitest";

import { compileAnim, sampleAnim } from "./anim";
import type { Animatable } from "./model";

describe("sampleAnim", () => {
  it("returns a constant and the fallback for undefined/empty", () => {
    expect(sampleAnim(0.5, 999)).toBe(0.5);
    expect(sampleAnim(undefined, 0, 1)).toBe(1);
    expect(sampleAnim([], 0, 0.7)).toBe(0.7);
  });
  it("holds the first value before and the last value after the range", () => {
    const a: Animatable = [
      { t: 10, v: 20 },
      { t: 20, v: 80 },
    ];
    expect(sampleAnim(a, 0)).toBe(20); // before first -> clamp
    expect(sampleAnim(a, 10)).toBe(20);
    expect(sampleAnim(a, 100)).toBe(80); // after last -> clamp
    expect(sampleAnim(a, 20)).toBe(80);
  });
  it("interpolates linearly between keyframes", () => {
    const a: Animatable = [
      { t: 0, v: 0 },
      { t: 10, v: 100 },
    ];
    expect(sampleAnim(a, 5)).toBeCloseTo(50, 6);
    expect(sampleAnim(a, 2.5)).toBeCloseTo(25, 6);
  });
  it("applies the segment's easing curve", () => {
    const base = (ease: string): Animatable => [
      { t: 0, v: 0, ease },
      { t: 10, v: 100 },
    ];
    expect(sampleAnim(base("ease-in"), 5)).toBeCloseTo(25, 6); // p^2
    expect(sampleAnim(base("ease-out"), 5)).toBeCloseTo(75, 6); // 1-(1-p)^2
    expect(sampleAnim(base("ease-in-out"), 2.5)).toBeCloseTo(15.625, 6); // smoothstep
    expect(sampleAnim(base("bogus"), 5)).toBeCloseTo(50, 6); // unknown -> linear
  });

  it("holds a stepped segment flat until the NEXT keyframe, then jumps", () => {
    const a: Animatable = [
      { t: 0, v: 0, ease: "hold" },
      { t: 10, v: 100 },
    ];
    for (const t of [0, 1, 5, 9, 9.999]) expect(sampleAnim(a, t)).toBe(0);
    expect(sampleAnim(a, 10)).toBe(100); // the step lands exactly on the key
  });

  it("mixes hold with ramped segments on one curve", () => {
    // A caption that appears, sits still, then fades: only the middle segment steps.
    const a: Animatable = [
      { t: 0, v: 0 },
      { t: 10, v: 100, ease: "hold" },
      { t: 20, v: 0 },
    ];
    expect(sampleAnim(a, 5)).toBeCloseTo(50, 6); // ramp in
    expect(sampleAnim(a, 15)).toBe(100); // held, not half way down
    expect(sampleAnim(a, 20)).toBe(0);
  });
  it("walks multi-segment curves", () => {
    const a: Animatable = [
      { t: 0, v: 0 },
      { t: 10, v: 100 },
      { t: 20, v: 0 },
    ];
    expect(sampleAnim(a, 15)).toBeCloseTo(50, 6);
  });
});

describe("compileAnim", () => {
  it("emits a bare number for constants and single keyframes", () => {
    expect(compileAnim(0.5, "T")).toBe("0.500000");
    expect(compileAnim([{ t: 3, v: 5 }], "T")).toBe("5.000000");
  });
  it("builds a nested piecewise expression in the time variable", () => {
    const e = compileAnim(
      [
        { t: 0, v: 0 },
        { t: 1, v: 1 },
      ],
      "T",
    );
    expect(e).toContain("if(lt(T,0.000000),0.000000"); // hold before first
    expect(e).toContain("if(lt(T,1.000000)");
    expect(e).toContain("clip((T-0.000000)/1.000000,0,1)");
    expect(e.endsWith("1.000000))")).toBe(true); // hold last
  });
  it("subtracts the offset to get clip-relative time", () => {
    const e = compileAnim(
      [
        { t: 1, v: 0 },
        { t: 2, v: 1 },
      ],
      "T",
      0.5,
    );
    expect(e).toContain("(T-0.500000)");
  });
  it("emits the easing sub-expressions", () => {
    const inE = compileAnim(
      [
        { t: 0, v: 0, ease: "ease-in" },
        { t: 1, v: 1 },
      ],
      "t",
    );
    expect(inE).toContain("pow(");
    const outE = compileAnim(
      [
        { t: 0, v: 0, ease: "ease-out" },
        { t: 1, v: 1 },
      ],
      "t",
    );
    expect(outE).toContain("(1-pow(1-");
    const ioE = compileAnim(
      [
        { t: 0, v: 0, ease: "ease-in-out" },
        { t: 1, v: 1 },
      ],
      "t",
    );
    expect(ioE).toContain("(3-2*");
  });
});
