import { describe, expect, it } from "vitest";

import { computePeaks, peaksToPath } from "./waveform";

describe("computePeaks", () => {
  it("returns zero-filled peaks for empty input", () => {
    const p = computePeaks(new Float32Array([]), 4);
    expect(Array.from(p)).toEqual([0, 0, 0, 0]);
  });

  it("takes the max absolute amplitude per bucket", () => {
    // 8 samples -> 2 buckets: [0.2,-0.9,0.1,0.3] and [-0.4,0.5,0.8,-0.1]
    const ch = new Float32Array([0.2, -0.9, 0.1, 0.3, -0.4, 0.5, 0.8, -0.1]);
    const p = computePeaks(ch, 2);
    expect(p.length).toBe(2);
    expect(p[0]).toBeCloseTo(0.9);
    expect(p[1]).toBeCloseTo(0.8);
  });

  it("clamps peaks above 1 and always fills at least one bucket", () => {
    expect(computePeaks(new Float32Array([2, -3]), 1)[0]).toBe(1);
    expect(computePeaks(new Float32Array([0.5]), 0).length).toBe(1); // buckets floored to >= 1
  });

  it("handles more buckets than samples without gaps", () => {
    const p = computePeaks(new Float32Array([0.5, 0.6]), 4);
    expect(p.length).toBe(4);
    expect(Math.max(...Array.from(p))).toBeCloseTo(0.6);
  });
});

describe("peaksToPath", () => {
  it("is empty for no peaks", () => {
    expect(peaksToPath(new Float32Array([]))).toBe("");
  });

  it("mirrors around the centre and closes the path", () => {
    const d = peaksToPath(new Float32Array([1]), 100); // one peak, full amplitude
    expect(d).toBe("M0 0L0 100Z"); // top at 0, bottom at 100, closed
  });

  it("traces the top forward then the bottom back", () => {
    const d = peaksToPath(new Float32Array([0, 1]), 100); // mid = 50
    // top: (0,50) then (1,0); bottom back: (1,100) then (0,50)
    expect(d).toBe("M0 50L1 0L1 100L0 50Z");
  });
});
