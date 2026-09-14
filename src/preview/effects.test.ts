// The PURE half of preview effects: flattening the clip's effect stack into shader
// numbers, and baking tone curves into a ramp. The shader itself needs a real WebGL
// context (validated in-browser), but these two are where the silent-no-op risk lives
// — a stack that flattens to neutral renders nothing, exactly like the glow bug.
import { describe, expect, it } from "vitest";

import { bakeCurves, effectsOf, NEUTRAL_FX } from "./scene";

describe("effectsOf", () => {
  it("an empty / absent stack is neutral", () => {
    expect(effectsOf(undefined)).toEqual(NEUTRAL_FX);
    expect(effectsOf([])).toEqual(NEUTRAL_FX);
  });

  it("every renderable effect moves the stack OFF neutral (a silent no-op is the bug)", () => {
    const cases = [
      { type: "blur", params: { radius: 10 } },
      { type: "sharpen", params: { sharpness: 1 } },
      { type: "grain", params: { grain: 20 } },
      { type: "vignette", params: { vignette: 0.4 } },
      { type: "glow", params: { intensity: 30 } },
      { type: "clarity", params: { clarity: 0.5 } },
      { type: "chroma", params: { color: "#00FF00", similarity: 0.3 } },
      { type: "motion", params: { frames: 6 } },
      { type: "denoise", params: { strength: 8 } },
    ];
    for (const e of cases) {
      expect(effectsOf([e]), `${e.type} flattened to neutral`).not.toEqual(NEUTRAL_FX);
    }
  });

  it("`custom` is honestly NOT previewable, so it stays neutral", () => {
    expect(effectsOf([{ type: "custom", params: { expr: "hflip" } }])).toEqual(NEUTRAL_FX);
  });

  it("enabled:false is skipped, matching the renderer's bypass", () => {
    expect(effectsOf([{ type: "blur", params: { radius: 10 }, enabled: false }])).toEqual(
      NEUTRAL_FX,
    );
  });

  it("the clip-level glow WINS over an effects[] glow, as render.ts does", () => {
    const both = effectsOf([{ type: "glow", params: { intensity: 10 } }], 80);
    expect(both.b[0]).toBeCloseTo(0.8); // the clip-level 80, not the stack's 10
  });

  it("parses a hex key colour, and falls back to green on junk", () => {
    expect(effectsOf([{ type: "chroma", params: { color: "#FF0000" } }]).key).toEqual([1, 0, 0]);
    expect(effectsOf([{ type: "chroma", params: { color: "nope" } }]).key).toEqual([0, 1, 0]);
  });
});

describe("bakeCurves", () => {
  it("returns undefined when there is no curve (so the common path uploads nothing)", () => {
    expect(bakeCurves(undefined)).toBeUndefined();
    expect(bakeCurves({ exposure: 0.5 })).toBeUndefined();
  });

  it("bakes a lifted-black master curve into the alpha ramp", () => {
    const lut = bakeCurves({
      masterCurve: [
        [0, 0.2],
        [1, 1],
      ],
    })!;
    expect(lut).toHaveLength(256 * 4);
    expect(lut[3]).toBe(51); // master at x=0 -> 0.2
    expect(lut[255 * 4 + 3]).toBe(255); // master at x=1 -> 1
    expect(lut[128 * 4 + 3]).toBeGreaterThan(128); // midpoint lifted
  });

  it("an unset channel is identity, not zero (a zeroed ramp would black the frame)", () => {
    const lut = bakeCurves({
      redCurve: [
        [0, 0],
        [1, 0.5],
      ],
    })!;
    expect(lut[255 * 4 + 0]).toBe(128); // red halved
    expect(lut[255 * 4 + 1]).toBe(255); // green untouched
    expect(lut[255 * 4 + 3]).toBe(255); // master untouched
  });

  it("clamps and sorts out-of-order / out-of-range control points", () => {
    const lut = bakeCurves({
      masterCurve: [
        [1, 2],
        [0, -1],
      ],
    })!;
    expect(lut[3]).toBe(0);
    expect(lut[255 * 4 + 3]).toBe(255);
  });
});
