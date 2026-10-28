import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { intermediateSlices } from "./render";

// ffv1 refuses a slice over 8<<24 / (3 planes * 9 bits) pixels ("Unsupported number N of slices requested"), and a refusal
// ends the export. The rules below come from that constraint and from the 2x2 / 4x4 refusals, never from the module's own
// constants, so retuning the cap or the slice count cannot walk into a refusal unnoticed. intermediateSlices.smoke.e2e.ts
// holds the same rule to the real ffmpeg.
const FFV1_MAX_SLICE_PIXELS = Math.floor((8 << 24) / (3 * 9));
const MARGIN = 0.9;

const side = fc.integer({ min: 1, max: 8192 });

describe("intermediateSlices", () => {
  it("never asks ffv1 for a slice it can refuse", () => {
    fc.assert(
      fc.property(side, side, (width, height) => {
        const slices = intermediateSlices(width, height);
        expect(Number.isInteger(slices) && slices >= 0).toBe(true);
        if (slices === 0) return;
        // at most 90% of the size ffv1 refuses, on every aspect ratio
        expect((width * height) / slices).toBeLessThanOrEqual(FFV1_MAX_SLICE_PIXELS * MARGIN);
        // and no slice is thinner than 16 pixels on the axis it is cut along (2x2 is refused with 4 slices)
        expect(Math.min(width, height) / slices).toBeGreaterThanOrEqual(16);
      }),
      { numRuns: 3000 },
    );
  });

  it("does not depend on orientation", () => {
    fc.assert(
      fc.property(side, side, (width, height) => {
        expect(intermediateSlices(width, height)).toBe(intermediateSlices(height, width));
      }),
      { numRuns: 1000 },
    );
  });

  it("still slices every canvas a person actually exports", () => {
    // The point is speed on the promised lines, so a rule tightened until 4K is left alone has to fail here.
    const canvases: [number, number][] = [
      [640, 360],
      [854, 480],
      [1280, 720],
      [1920, 1080],
      [1080, 1920],
      [1080, 1080],
      [1080, 1350],
      [2560, 1440],
      [3840, 2160],
      [2160, 3840],
      [4096, 2160],
      [5120, 2880],
    ];
    for (const [width, height] of canvases) {
      expect(intermediateSlices(width, height), `${width}x${height}`).toBeGreaterThan(0);
    }
  });

  it("leaves what ffv1 cannot cut, and 6K and 8K canvases, on one thread", () => {
    for (const [width, height] of [
      [2, 2],
      [62, 62],
      [63, 4000],
      [6016, 3384],
      [7680, 4320],
      [8192, 8192],
    ]) {
      expect(intermediateSlices(width, height), `${width}x${height}`).toBe(0);
    }
  });
});
