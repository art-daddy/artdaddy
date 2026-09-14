import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BUNDLED_FONT_URLS } from "./fonts";
import { FONT_FILES } from "../timeline/render";
import { clampFont } from "../timeline/renderPlan";

// Three places have to agree on the caption families: the exporter's file map,
// the plan's clamp, and the preview's FontFace registry. A family present in the
// first two but missing here renders in the export and silently falls back to
// Times in the preview — the bug this registry was added to fix, which no test
// caught because each side was self-consistent.
describe("preview fonts <-> exporter drift", () => {
  it("registers exactly the families the exporter ships", () => {
    expect(Object.keys(BUNDLED_FONT_URLS).sort()).toEqual(Object.keys(FONT_FILES).sort());
  });

  it("registers every family clampFont can produce", () => {
    // clampFont is what actually decides the family the preview will be asked to
    // draw, so anything it returns MUST be registered.
    for (const name of [...Object.keys(FONT_FILES), "Impact", "", "bebasneue", undefined]) {
      expect(BUNDLED_FONT_URLS[clampFont(name)]).toBeDefined();
    }
  });

  it("points each family at its own non-empty face", () => {
    const urls = Object.values(BUNDLED_FONT_URLS);
    expect(urls.every((u) => typeof u === "string" && u.length > 0)).toBe(true);
    expect(new Set(urls).size).toBe(urls.length); // no family silently sharing another's file
  });
});

// The loader only ever runs in a browser/worker realm, so nothing else exercises
// it — and a silent failure here is invisible: the preview just keeps drawing in
// the fallback font, which is the original bug.
describe("loadBundledFonts", () => {
  const loaded: string[] = [];
  let failFamily: string | null = null;

  class FakeFontFace {
    constructor(
      readonly family: string,
      readonly source: string,
    ) {}
    async load(): Promise<this> {
      if (this.family === failFamily) throw new Error("network");
      return this;
    }
  }

  beforeEach(() => {
    loaded.length = 0;
    failFamily = null;
    vi.resetModules(); // the module memoises its promise; each test needs a fresh realm
    vi.stubGlobal("FontFace", FakeFontFace);
  });
  afterEach(() => vi.unstubAllGlobals());

  const target = { add: (f: FontFace) => loaded.push((f as unknown as FakeFontFace).family) };

  it("registers every bundled family, pointed at its own url", async () => {
    const { loadBundledFonts, BUNDLED_FONT_URLS: urls } = await import("./fonts");
    await loadBundledFonts(target);
    expect(loaded.sort()).toEqual(Object.keys(urls).sort());
  });

  it("still registers the others when one face fails to load", async () => {
    failFamily = "Poppins";
    const { loadBundledFonts, BUNDLED_FONT_URLS: urls } = await import("./fonts");
    await expect(loadBundledFonts(target)).resolves.toBeUndefined(); // never rejects
    expect(loaded).not.toContain("Poppins");
    expect(loaded).toHaveLength(Object.keys(urls).length - 1);
  });

  it("loads once per realm even when called from several places", async () => {
    const { loadBundledFonts } = await import("./fonts");
    await Promise.all([loadBundledFonts(target), loadBundledFonts(target)]);
    await loadBundledFonts(target);
    expect(loaded).toHaveLength(Object.keys(BUNDLED_FONT_URLS).length); // not 2x/3x
  });
});
