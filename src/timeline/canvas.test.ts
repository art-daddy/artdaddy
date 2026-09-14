// Canvas guard rails (set_project_settings). The bug this exists to prevent: the model
// didn't know the canvas size, felt obliged to supply it anyway, sent width/height 0
// (rejected 4x), then "recovered" with width/height 1 — which was ACCEPTED, silently
// turning the project into a 1x1 pixel video while the tool reported success.
import { describe, expect, it } from "vitest";

import { resolveCanvas } from "./canvas";

const CURRENT = { width: 1920, height: 1080, fps: 30 };
const ok = (r: ReturnType<typeof resolveCanvas>) => {
  if ("error" in r) throw new Error(`unexpected error: ${r.error}`);
  return r;
};
const err = (r: ReturnType<typeof resolveCanvas>): string => {
  if (!("error" in r)) throw new Error(`expected an error, got ${JSON.stringify(r)}`);
  return r.error;
};

describe("resolveCanvas", () => {
  it("an omitted field keeps its CURRENT value — the model never has to know the size", () => {
    // This is the fix for the whole class: changing fps must not require a size.
    expect(ok(resolveCanvas({ fps: 24 }, CURRENT))).toEqual({
      width: 1920,
      height: 1080,
      fps: 24,
    });
  });

  it("REGRESSION: a 1x1 canvas is refused (it used to be accepted and reported ok)", () => {
    expect(err(resolveCanvas({ width: 1, height: 1, fps: 24 }, CURRENT))).toContain("64");
  });

  it("REGRESSION: an INHERITED key is an unknown preset, not a crash", () => {
    // Found by fuzz: ASPECT["__proto__"] is Object.prototype, which is truthy, so the
    // unknown-preset guard passed and destructuring it threw a TypeError instead of
    // returning the helpful "use one of: ..." message.
    for (const key of ["__proto__", "constructor", "toString", "valueOf"]) {
      expect(err(resolveCanvas({ aspect_ratio: key }, CURRENT))).toContain("unknown aspect_ratio");
      expect(err(resolveCanvas({ quality: key }, CURRENT))).toContain("unknown quality");
    }
  });

  // The contract nests the sizing knobs under `size` so "leave the canvas alone" is ONE
  // decision. Flat-per-knob, gpt-5.4 AND gpt-5.4-mini both volunteered an aspect_ratio
  // on a frame-rate-only request and silently flipped a portrait project to landscape.
  describe("nested `size` (the contract shape)", () => {
    const PORTRAIT = { width: 1080, height: 1920, fps: 30 };

    it("size:null on an fps change leaves the canvas EXACTLY as it was", () => {
      expect(ok(resolveCanvas({ fps: 24, size: null }, PORTRAIT))).toEqual({
        width: 1080,
        height: 1920,
        fps: 24,
      });
    });

    it("an absent size is the same as size:null", () => {
      expect(resolveCanvas({ fps: 24, size: null }, PORTRAIT)).toEqual(
        resolveCanvas({ fps: 24 }, PORTRAIT),
      );
    });

    it("a nested size resolves exactly like the flat form", () => {
      expect(resolveCanvas({ size: { aspect_ratio: "16:9", quality: "720p" } }, PORTRAIT)).toEqual(
        resolveCanvas({ aspect_ratio: "16:9", quality: "720p" }, PORTRAIT),
      );
    });

    it("nested explicit pixels still win over a disagreeing preset, with a note", () => {
      const r = ok(
        resolveCanvas({ size: { width: 1080, height: 1080, aspect_ratio: "16:9" } }, PORTRAIT),
      );
      expect([r.width, r.height]).toEqual([1080, 1080]);
      expect(String(r.note)).toContain("aspect_ratio");
    });

    it("fps:null with a size changes only the size", () => {
      expect(ok(resolveCanvas({ fps: null, size: { aspect_ratio: "1:1" } }, PORTRAIT))).toEqual({
        width: 1080,
        height: 1080,
        fps: 30,
      });
    });

    it("an empty size object alone changes nothing, so it is refused", () => {
      expect("error" in resolveCanvas({ size: {} }, PORTRAIT)).toBe(true);
    });

    it("nested bounds are enforced like flat ones", () => {
      expect(err(resolveCanvas({ size: { width: 1, height: 1 } }, PORTRAIT))).toContain("64");
    });
  });

  it("the zero-fill the model actually sent is refused, and the reply says what to do", () => {
    const e = err(resolveCanvas({ width: 0, height: 0, fps: 24 }, CURRENT));
    expect(e).toContain("Omit width/height");
    expect(e).toContain("1920x1080"); // tells it the current size instead of making it guess
  });

  it("width and height must arrive together", () => {
    expect(err(resolveCanvas({ width: 1280 }, CURRENT))).toContain("together");
    expect(err(resolveCanvas({ height: 720 }, CURRENT))).toContain("together");
  });

  it("explicit pixels WIN over a disagreeing shortcut, with a note (never a hard reject)", () => {
    // Deliberately not an error: our own set_project_settings learned that rejecting a
    // conflict makes weaker models loop re-sending it. Most-specific input wins instead.
    const r = ok(resolveCanvas({ width: 1280, height: 720, quality: "4K" }, CURRENT));
    expect(r.width).toBe(1280);
    expect(r.height).toBe(720);
    expect(r.note).toContain("ignored");
  });

  it("an AGREEING shortcut alongside explicit pixels passes without complaint", () => {
    const r = ok(resolveCanvas({ width: 1920, height: 1080, aspect_ratio: "16:9" }, CURRENT));
    expect(r.note).toBeUndefined();
  });

  it("refuses a call that changes nothing", () => {
    expect(err(resolveCanvas({}, CURRENT))).toContain("at least one");
  });

  it("bounds fps and echoes the offending value", () => {
    expect(err(resolveCanvas({ fps: 0 }, CURRENT))).toContain("got 0");
    expect(err(resolveCanvas({ fps: 500 }, CURRENT))).toContain("got 500");
    expect(ok(resolveCanvas({ fps: 120 }, CURRENT)).fps).toBe(120);
  });

  it("bounds the size at both ends", () => {
    expect(err(resolveCanvas({ width: 63, height: 1080 }, CURRENT))).toContain("64..8192");
    expect(err(resolveCanvas({ width: 9000, height: 1080 }, CURRENT))).toContain("64..8192");
  });

  describe("shortcuts", () => {
    it("aspect_ratio keeps the current SHORT edge", () => {
      // 1920x1080 -> short edge 1080 -> portrait 9:16 becomes 1080x1920.
      expect(ok(resolveCanvas({ aspect_ratio: "9:16" }, CURRENT))).toEqual({
        width: 1080,
        height: 1920,
        fps: 30,
      });
    });

    it("quality alone rescales, keeping the current shape", () => {
      expect(ok(resolveCanvas({ quality: "4K" }, CURRENT))).toEqual({
        width: 3840,
        height: 2160,
        fps: 30,
      });
    });

    it("aspect_ratio + quality combine", () => {
      expect(ok(resolveCanvas({ aspect_ratio: "1:1", quality: "720p" }, CURRENT))).toEqual({
        width: 720,
        height: 720,
        fps: 30,
      });
    });

    it("rejects an unknown preset by NAME, listing the real ones", () => {
      expect(err(resolveCanvas({ aspect_ratio: "widescreen" }, CURRENT))).toContain("16:9");
      expect(err(resolveCanvas({ quality: "8K" }, CURRENT))).toContain("720p");
    });

    it("a shortcut never produces an out-of-range canvas", () => {
      for (const q of ["720p", "1080p", "2K", "4K"]) {
        for (const a of ["16:9", "9:16", "1:1", "4:3", "2.4:1", "9:14"]) {
          const r = ok(resolveCanvas({ aspect_ratio: a, quality: q }, CURRENT));
          expect(Math.min(r.width, r.height), `${a} ${q}`).toBeGreaterThanOrEqual(64);
          expect(Math.max(r.width, r.height), `${a} ${q}`).toBeLessThanOrEqual(8192);
          // Odd dimensions break some encoders.
          expect(r.width % 2, `${a} ${q}`).toBe(0);
          expect(r.height % 2, `${a} ${q}`).toBe(0);
        }
      }
    });
  });
});
