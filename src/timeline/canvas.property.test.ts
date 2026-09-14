// Property tests for resolveCanvas. canvas.test.ts pins VALUES on fixed examples;
// these pin the structural laws that examples can't cover, over random input.
//
// The bug this module exists to prevent came from a model that had to supply values it
// could not know. The laws below are the ones that make guessing unnecessary and make a
// bad guess loud: an omitted field never changes anything, an accepted canvas is always
// usable, and null is always exactly the same as omitted.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  ASPECT,
  MAX_EDGE,
  MAX_FPS,
  MIN_EDGE,
  MIN_FPS,
  QUALITY_SHORT,
  aspectLabel,
  resolveCanvas,
} from "./canvas";

const curGen = fc.record({
  width: fc.integer({ min: MIN_EDGE, max: MAX_EDGE }),
  height: fc.integer({ min: MIN_EDGE, max: MAX_EDGE }),
  fps: fc.integer({ min: MIN_FPS, max: MAX_FPS }),
});
const aspectGen = fc.constantFrom(...Object.keys(ASPECT));
const qualityGen = fc.constantFrom(...Object.keys(QUALITY_SHORT));
const edgeGen = fc.integer({ min: MIN_EDGE, max: MAX_EDGE });
const fpsGen = fc.integer({ min: MIN_FPS, max: MAX_FPS });

/** Any plausible model call, including the junk ones. */
const argsGen = fc.record(
  {
    width: fc.oneof(fc.integer({ min: -10, max: 10000 }), fc.constant(null)),
    height: fc.oneof(fc.integer({ min: -10, max: 10000 }), fc.constant(null)),
    aspect_ratio: fc.oneof(aspectGen, fc.string(), fc.constant(null)),
    quality: fc.oneof(qualityGen, fc.string(), fc.constant(null)),
    fps: fc.oneof(fc.integer({ min: -5, max: 500 }), fc.constant(null)),
  },
  { requiredKeys: [] },
);

describe("resolveCanvas (property)", () => {
  it("returns EITHER a canvas or an error, never both and never neither", () => {
    fc.assert(
      fc.property(argsGen, curGen, (args, cur) => {
        const r = resolveCanvas(args, cur);
        const isErr = "error" in r;
        expect(isErr ? typeof r.error === "string" && r.error.length > 0 : true).toBe(true);
        if (!isErr) expect(["width", "height", "fps"].every((k) => k in r)).toBe(true);
      }),
    );
  });

  it("every ACCEPTED canvas is usable: in range, positive, never 0", () => {
    // The whole bug was an accepted canvas nobody could render (0x0, then 1x1).
    fc.assert(
      fc.property(argsGen, curGen, (args, cur) => {
        const r = resolveCanvas(args, cur);
        if ("error" in r) return;
        expect(r.width).toBeGreaterThanOrEqual(MIN_EDGE);
        expect(r.height).toBeGreaterThanOrEqual(MIN_EDGE);
        expect(r.width).toBeLessThanOrEqual(MAX_EDGE);
        expect(r.height).toBeLessThanOrEqual(MAX_EDGE);
        expect(r.fps).toBeGreaterThanOrEqual(MIN_FPS);
        expect(r.fps).toBeLessThanOrEqual(MAX_FPS);
      }),
    );
  });

  it("null is indistinguishable from omitted (the strict-mode contract)", () => {
    // Strict mode forces every property to be present, so the model says "unset" with
    // null. If these ever diverged, an unset field would start changing the canvas.
    fc.assert(
      fc.property(argsGen, curGen, (args, cur) => {
        const withoutNulls = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null));
        expect(resolveCanvas(args, cur)).toEqual(resolveCanvas(withoutNulls, cur));
      }),
    );
  });

  it("changing ONLY fps never changes the size — the model needs no size to retime", () => {
    fc.assert(
      fc.property(curGen, fpsGen, (cur, fps) => {
        const r = resolveCanvas({ fps }, cur);
        expect(r).toEqual({ width: cur.width, height: cur.height, fps });
      }),
    );
  });

  it("the size never depends on the fps requested", () => {
    fc.assert(
      fc.property(argsGen, curGen, fpsGen, fpsGen, (args, cur, f1, f2) => {
        const a = resolveCanvas({ ...args, fps: f1 }, cur);
        const b = resolveCanvas({ ...args, fps: f2 }, cur);
        if ("error" in a || "error" in b) return;
        expect([a.width, a.height]).toEqual([b.width, b.height]);
      }),
    );
  });

  it("an in-range explicit PAIR always wins, whatever else is passed", () => {
    fc.assert(
      fc.property(
        edgeGen,
        edgeGen,
        fc.option(aspectGen, { nil: undefined }),
        fc.option(qualityGen, { nil: undefined }),
        curGen,
        (width, height, aspect_ratio, quality, cur) => {
          const r = resolveCanvas({ width, height, aspect_ratio, quality }, cur);
          if ("error" in r) throw new Error(`explicit ${width}x${height} was refused: ${r.error}`);
          expect([r.width, r.height]).toEqual([width, height]);
        },
      ),
    );
  });

  it("a disagreeing preset is reported, never silently applied", () => {
    // Graded with a wide margin on purpose. The implementation's threshold is
    // relative to the LABEL's ratio ("2.4:1" → 2.4) while ASPECT stores 2560×1080
    // (= 2.370), so an input sitting near the 5% boundary can legitimately fall on
    // either side. The RULE being tested is "a clear disagreement is always named",
    // not the exact cutoff — re-deriving the cutoff here would just mirror the code.
    fc.assert(
      fc.property(edgeGen, edgeGen, aspectGen, curGen, (width, height, aspect, cur) => {
        const r = resolveCanvas({ width, height, aspect_ratio: aspect }, cur);
        if ("error" in r) return;
        const [aw, ah] = ASPECT[aspect];
        const target = aw / ah;
        const clearlyDisagrees = Math.abs(width / height - target) / target > 0.25;
        if (clearlyDisagrees) expect(String(r.note)).toContain("aspect_ratio");
      }),
    );
  });

  it("a preset that MATCHES the explicit size is never reported as a conflict", () => {
    // The opposite direction: a spurious "they disagreed" note trains the model to
    // stop trusting the field.
    fc.assert(
      fc.property(aspectGen, curGen, (aspect, cur) => {
        const [w, h] = ASPECT[aspect];
        const r = resolveCanvas({ width: w, height: h, aspect_ratio: aspect }, cur);
        if ("error" in r) return;
        expect(String(r.note ?? "")).not.toContain("aspect_ratio");
      }),
    );
  });

  it("any preset combination yields an in-range canvas from any current size", () => {
    fc.assert(
      fc.property(aspectGen, qualityGen, curGen, (aspect_ratio, quality, cur) => {
        const r = resolveCanvas({ aspect_ratio, quality }, cur);
        if ("error" in r) throw new Error(`${aspect_ratio}+${quality} refused: ${r.error}`);
        expect(Math.min(r.width, r.height)).toBeGreaterThanOrEqual(MIN_EDGE);
        expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(MAX_EDGE);
      }),
    );
  });

  it("is idempotent: feeding a resolved canvas back changes nothing", () => {
    fc.assert(
      fc.property(argsGen, curGen, (args, cur) => {
        const first = resolveCanvas(args, cur);
        if ("error" in first) return;
        const again = resolveCanvas(
          { width: first.width, height: first.height, fps: first.fps },
          first,
        );
        if ("error" in again) return; // a re-request that changes nothing is refused
        expect([again.width, again.height, again.fps]).toEqual([
          first.width,
          first.height,
          first.fps,
        ]);
      }),
    );
  });

  it("an out-of-range fps is always refused, and the message echoes what was sent", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: 1000 }).filter((f) => f < MIN_FPS || f > MAX_FPS),
        curGen,
        (fps, cur) => {
          const r = resolveCanvas({ fps }, cur);
          if (!("error" in r)) throw new Error(`fps ${fps} was accepted`);
          expect(r.error).toContain(String(fps));
        },
      ),
    );
  });

  it("a refusal always tells the model the CURRENT size, so it never has to guess", () => {
    // Every size-shaped rejection must carry the values that would have made it work.
    fc.assert(
      fc.property(fc.integer({ min: -10, max: 63 }), edgeGen, curGen, (bad, good, cur) => {
        const r = resolveCanvas({ width: bad, height: good }, cur);
        if (!("error" in r)) return;
        expect(r.error).toContain(`${cur.width}x${cur.height}`);
      }),
    );
  });

  it("passing nothing is always refused", () => {
    fc.assert(
      fc.property(curGen, (cur) => {
        expect("error" in resolveCanvas({}, cur)).toBe(true);
        expect(
          "error" in
            resolveCanvas({ width: null, height: null, fps: null, aspect_ratio: null }, cur),
        ).toBe(true);
      }),
    );
  });
});

// Below: laws the mutation run proved nothing was checking. Surviving mutants in
// evenDim / scaleShortEdge / aspectLabel / the 5% conflict threshold meant those could
// be broken silently — aspectLabel in particular is echoed back to the model as the
// canvas's `aspect_ratio`, so a wrong label misinforms every later decision.
describe("resolveCanvas — derived geometry (property)", () => {
  it("a PRESET-derived canvas is always even on both edges", () => {
    // Odd frame dimensions break several encoders; explicit pixels are the user's
    // problem, but anything WE compute must be safe.
    fc.assert(
      fc.property(aspectGen, qualityGen, curGen, (aspect_ratio, quality, cur) => {
        const r = resolveCanvas({ aspect_ratio, quality }, cur);
        if ("error" in r) return;
        expect(r.width % 2).toBe(0);
        expect(r.height % 2).toBe(0);
      }),
    );
  });

  it("quality scales the SHORT edge to the preset, whichever edge that is", () => {
    fc.assert(
      fc.property(qualityGen, curGen, (quality, cur) => {
        const r = resolveCanvas({ quality }, cur);
        if ("error" in r) return;
        // Rounding to even can move it by 1px; the short edge must still be the target.
        expect(Math.abs(Math.min(r.width, r.height) - QUALITY_SHORT[quality]!)).toBeLessThanOrEqual(
          1,
        );
      }),
    );
  });

  it("scaling preserves the shape (aspect within rounding)", () => {
    fc.assert(
      fc.property(qualityGen, curGen, (quality, cur) => {
        const r = resolveCanvas({ quality }, cur);
        if ("error" in r) return;
        const wanted = cur.width / cur.height;
        expect(Math.abs(r.width / r.height - wanted) / wanted).toBeLessThan(0.02);
      }),
    );
  });

  it("a square current size scales to a square (the w <= h boundary)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 64, max: 4000 }), qualityGen, (edge, quality) => {
        const r = resolveCanvas({ quality }, { width: edge, height: edge, fps: 30 });
        if ("error" in r) return;
        expect(r.width).toBe(r.height);
      }),
    );
  });

  it("each aspect preset reports back the label it was asked for", () => {
    // The tool echoes aspectLabel(w,h) to the model as `aspect_ratio`.
    fc.assert(
      fc.property(aspectGen, curGen, (aspect_ratio, cur) => {
        const r = resolveCanvas({ aspect_ratio }, cur);
        if ("error" in r) return;
        expect(aspectLabel(r.width, r.height)).toBe(
          aspectLabel(ASPECT[aspect_ratio]![0], ASPECT[aspect_ratio]![1]),
        );
      }),
    );
  });
});

describe("aspectLabel", () => {
  it("reduces to lowest terms", () => {
    expect(aspectLabel(1920, 1080)).toBe("16:9");
    expect(aspectLabel(1080, 1920)).toBe("9:16");
    expect(aspectLabel(1080, 1080)).toBe("1:1");
    expect(aspectLabel(1440, 1080)).toBe("4:3");
    expect(aspectLabel(1280, 720)).toBe("16:9"); // a different size, the SAME shape
  });

  it("is scale-invariant: the same shape always gets the same label", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), (k) => {
        expect(aspectLabel(16 * k, 9 * k)).toBe("16:9");
      }),
    );
  });

  it("never divides by zero on a degenerate size", () => {
    expect(() => aspectLabel(0, 0)).not.toThrow();
  });
});

describe("explicit-vs-preset conflict threshold", () => {
  it("a shape within 5% passes silently; beyond it is reported", () => {
    // 1920x1080 is exactly 16:9. 1920x1000 is 1.92 (~8% off) -> must be flagged.
    const cur = { width: 1080, height: 1920, fps: 30 };
    const exact = resolveCanvas({ width: 1920, height: 1080, aspect_ratio: "16:9" }, cur);
    expect("error" in exact ? "" : (exact.note ?? "")).toBe("");
    const off = resolveCanvas({ width: 1920, height: 1000, aspect_ratio: "16:9" }, cur);
    expect("error" in off ? "" : String(off.note)).toContain("aspect_ratio");
  });

  it("a quality within 5% of the short edge passes silently; beyond it is reported", () => {
    const cur = { width: 1080, height: 1920, fps: 30 };
    const near1080 = resolveCanvas({ width: 1920, height: 1080, quality: "1080p" }, cur);
    expect("error" in near1080 ? "" : (near1080.note ?? "")).toBe("");
    const far = resolveCanvas({ width: 1280, height: 720, quality: "4K" }, cur);
    expect("error" in far ? "" : String(far.note)).toContain("quality");
  });
});
