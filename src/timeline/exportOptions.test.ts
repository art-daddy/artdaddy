// Export delivery presets. The rules that matter are about what a preset must NEVER do:
// invent detail by upscaling, emit an odd dimension that ffmpeg refuses outright, or change
// anything at all when the user asked for the source size.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { crfFor, outputFps, outputSize } from "./exportOptions";

describe("outputSize", () => {
  it("reads the preset off the SHORTER side, so it means the same thing in both orientations", () => {
    expect(outputSize(1920, 1080, "720p")).toEqual({ w: 1280, h: 720 });
    expect(outputSize(1080, 1920, "720p")).toEqual({ w: 720, h: 1280 });
  });

  it("emits nothing when the canvas already matches", () => {
    expect(outputSize(1920, 1080, "1080p")).toBeNull();
    expect(outputSize(1080, 1920, "1080p")).toBeNull();
  });

  it("emits nothing for 'source' or no preset at all", () => {
    expect(outputSize(1920, 1080, "source")).toBeNull();
    expect(outputSize(1920, 1080, undefined)).toBeNull();
  });

  it("never UPSCALES — asking 2160p of a 720p project invents detail and costs a fortune", () => {
    expect(outputSize(1280, 720, "2160p")).toBeNull();
    expect(outputSize(1280, 720, "1080p")).toBeNull();
  });

  it("keeps the aspect ratio it was given", () => {
    const r = outputSize(2560, 1080, "480p"); // an ultrawide
    expect(r).not.toBeNull();
    expect(r!.w / r!.h).toBeCloseTo(2560 / 1080, 1);
  });

  it("refuses to produce an odd dimension, which ffmpeg cannot encode to yuv420p", () => {
    // The failure this guards is not cosmetic: libx264 + yuv420p aborts with "width not
    // divisible by 2", so an odd result means the export simply fails.
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8000 }),
        fc.integer({ min: 2, max: 8000 }),
        fc.constantFrom("2160p", "1440p", "1080p", "720p", "480p" as const),
        (w, h, preset) => {
          const r = outputSize(w, h, preset);
          if (!r) return;
          expect(r.w % 2).toBe(0);
          expect(r.h % 2).toBe(0);
          expect(r.w).toBeGreaterThanOrEqual(2);
          expect(r.h).toBeGreaterThanOrEqual(2);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("never returns a size LARGER than the canvas, for any input (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8000 }),
        fc.integer({ min: 2, max: 8000 }),
        fc.constantFrom("2160p", "1440p", "1080p", "720p", "480p" as const),
        (w, h, preset) => {
          const r = outputSize(w, h, preset);
          if (!r) return;
          expect(r.w).toBeLessThanOrEqual(w + 1); // +1 for the even-rounding step
          expect(r.h).toBeLessThanOrEqual(h + 1);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("shrugs off a degenerate canvas instead of emitting a broken filter", () => {
    expect(outputSize(0, 1080, "720p")).toBeNull();
    expect(outputSize(1920, 0, "720p")).toBeNull();
  });
});

describe("crfFor", () => {
  it("leaves libx264 on its own default when no quality was chosen", () => {
    // Load-bearing: this is what keeps a default export byte-identical to what it was before
    // presets existed.
    expect(crfFor(undefined)).toBeNull();
  });

  it("gets better as the label gets better", () => {
    expect(crfFor("high")).toBeLessThan(crfFor("medium")!);
    expect(crfFor("medium")).toBeLessThan(crfFor("low")!);
  });
});

describe("outputFps", () => {
  it("uses the canvas rate when nothing was asked for", () => {
    expect(outputFps(30, undefined)).toBe(30);
  });

  it("uses the requested rate when it is usable", () => {
    expect(outputFps(30, 60)).toBe(60);
    expect(outputFps(30, 24)).toBe(24);
  });

  it("falls back to the canvas rate rather than emitting nonsense", () => {
    for (const bad of [0, -1, 121, NaN, Infinity]) expect(outputFps(30, bad)).toBe(30);
  });

  it("always returns a rate ffmpeg will accept (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 120 }),
        fc.double({ min: -1000, max: 1000, noNaN: false }),
        (canvas, requested) => {
          const r = outputFps(canvas, requested);
          expect(Number.isInteger(r)).toBe(true);
          expect(r).toBeGreaterThanOrEqual(1);
          expect(r).toBeLessThanOrEqual(120);
        },
      ),
      { numRuns: 300 },
    );
  });
});
