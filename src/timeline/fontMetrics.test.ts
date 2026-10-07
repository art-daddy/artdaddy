// The metrics the app sizes and measures text by must be the fonts it ships, exactly. A test that
// copied a few numbers would agree with a stale table; this one reads every font file and compares
// every number, and walks every family the plan can choose.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { BUNDLED_FACES } from "./fontMetrics.data";
import { exportCell, lineWidthPx } from "./fontMetrics";
import { parseFont } from "./fontParse";
import { BUNDLED_FONTS } from "./renderPlan";

const FONTS = path.resolve(process.cwd(), "src-tauri/resources/fonts");
const shipped = readdirSync(FONTS)
  .filter((f) => /\.(ttf|otf)$/i.test(f))
  .map((file) => ({ file, font: parseFont(new Uint8Array(readFileSync(path.join(FONTS, file)))) }));

describe("fontMetrics.data.ts matches the shipped fonts (regenerate: npm run fontmetrics)", () => {
  it("has one entry per shipped font file, and nothing else", () => {
    expect(Object.keys(BUNDLED_FACES).sort()).toEqual(shipped.map((s) => s.font.family).sort());
  });

  it.each(shipped.map((s) => [s.font.family, s] as const))("%s: every number", (family, s) => {
    const d = BUNDLED_FACES[family];
    expect([d.file, d.upm, d.winAscent, d.winDescent]).toEqual([
      s.file,
      s.font.upm,
      s.font.winAscent,
      s.font.winDescent,
    ]);
    const table = new Map<number, number>();
    for (const [start, advs] of d.ranges) advs.forEach((a, i) => table.set(start + i, a));
    expect(table).toEqual(new Map(s.font.advances));
  });

  it("covers every family the render plan can choose", () => {
    for (const family of BUNDLED_FONTS) expect(BUNDLED_FACES[family], family).toBeDefined();
  });
});

describe("lineWidthPx", () => {
  const families = [...BUNDLED_FONTS];

  it("is the font's own advance sum for text the font draws", () => {
    // A line of one repeated character is that character's advance times the count.
    for (const s of shipped) {
      const adv = s.font.advances.get("H".codePointAt(0)!)!;
      expect(lineWidthPx("HHHH", s.font.family, 50)).toBeCloseTo((4 * adv * 50) / s.font.upm, 6);
    }
  });

  it("grows with the em and the letter spacing, and never shrinks as text is added", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...families),
        fc.string({ unit: "grapheme", maxLength: 40 }),
        fc.string({ unit: "grapheme", minLength: 1, maxLength: 10 }),
        fc.integer({ min: 1, max: 200 }),
        (family, a, b, size) => {
          const w = lineWidthPx(a, family, size);
          expect(lineWidthPx(a + b, family, size)).toBeGreaterThanOrEqual(w);
          expect(lineWidthPx(a, family, size * 2)).toBeCloseTo(2 * w, 6);
          expect(lineWidthPx(a, family, size, 3)).toBeGreaterThanOrEqual(w);
        },
      ),
    );
  });

  it("gives a Chinese or Japanese character a whole em", () => {
    expect(lineWidthPx("日本語", "Poppins", 80)).toBeCloseTo(240, 6);
  });
});

describe("exportCell", () => {
  it("is the face's (winAscent + winDescent) / upm for text it draws", () => {
    for (const s of shipped)
      expect(exportCell("Hello", s.font.family)).toBeCloseTo(
        (s.font.winAscent + s.font.winDescent) / s.font.upm,
        9,
      );
  });

  it("follows the script a line is mostly written in, not the font it names", () => {
    const latin = exportCell("Hello", "Poppins");
    expect(exportCell("مرحبا بالعالم", "Poppins")).not.toBe(latin);
    expect(exportCell("你好世界", "Poppins")).not.toBe(latin);
    // One Latin word on an Arabic line does not move the line off the Arabic face.
    expect(exportCell("مرحبا بالعالم Hi", "Poppins")).toBe(exportCell("مرحبا بالعالم", "Poppins"));
  });
});
