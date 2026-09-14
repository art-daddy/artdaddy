// Per-field presets: a named motion and a named size. Both SEED and are overridden by explicit
// fields — the same rule style.preset already follows, deliberately, so there is one merge
// behaviour to learn rather than two.
import { describe, expect, it } from "vitest";

import { mergeAnimation, resolveSizePx } from "./renderPlan";

describe("mergeAnimation", () => {
  it("expands a named motion into the fields it implies", () => {
    expect(mergeAnimation({ preset: "karaoke" })).toMatchObject({
      build: "word-highlight",
      timing: "transcript",
      emphasis: { kind: "highlight" },
    });
  });

  it("lets an explicit field beat the preset", () => {
    // The whole point of seeding: "karaoke, but chunked" must not be silently overruled.
    expect(mergeAnimation({ preset: "karaoke", build: "phrase-chunks" }).build).toBe(
      "phrase-chunks",
    );
  });

  it("passes an unknown preset through instead of inventing motion", () => {
    const out = mergeAnimation({ preset: "disco", build: "typewriter" });
    expect(out.build).toBe("typewriter");
    expect(out.entrance).toBeUndefined();
  });

  it("leaves a preset-free animation exactly as it was", () => {
    expect(mergeAnimation({ build: "whole-line", entrance: "fade" })).toEqual({
      build: "whole-line",
      entrance: "fade",
    });
  });

  it("survives junk where an animation should be", () => {
    expect(mergeAnimation(undefined)).toEqual({});
    expect(mergeAnimation("nope")).toEqual({});
    expect(mergeAnimation(null)).toEqual({});
  });
});

describe("resolveSizePx", () => {
  const CH = 1920;

  it("scales a named tier to the canvas, not to a fixed pixel count", () => {
    // The reason tiers exist: 90px is large on 1080 and small on 4K; "l" is the same size
    // on both.
    const tall = resolveSizePx({ size: "l" }, 1920, 0);
    const short = resolveSizePx({ size: "l" }, 1080, 0);
    expect(tall).toBeGreaterThan(short);
    expect(tall / 1920).toBeCloseTo(short / 1080, 6);
  });

  it("orders the tiers", () => {
    const px = (t: string) => resolveSizePx({ size: t }, CH, 0);
    expect(px("s")).toBeLessThan(px("m"));
    expect(px("m")).toBeLessThan(px("l"));
    expect(px("l")).toBeLessThan(px("xl"));
  });

  it("still takes an exact px number", () => {
    expect(resolveSizePx({ size: 42 }, CH, 0)).toBe(42);
  });

  it("falls back when the tier is unknown, rather than rendering microscopic text", () => {
    expect(resolveSizePx({ size: "enormous" }, CH, 77)).toBe(77);
    expect(resolveSizePx({}, CH, 77)).toBe(77);
  });

  it("accepts a tier however it was typed", () => {
    expect(resolveSizePx({ size: " XL " }, CH, 0)).toBe(resolveSizePx({ size: "xl" }, CH, 0));
  });

  it("keeps fontsize winning over size, as before", () => {
    expect(resolveSizePx({ fontsize: 10, size: "xl" }, CH, 0)).toBe(10);
  });
});
