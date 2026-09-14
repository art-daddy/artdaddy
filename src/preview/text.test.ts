import { describe, expect, it } from "vitest";

import type { TextLayer } from "./scene";
import { blockTop, textKey } from "./text";

const layer = (over: Partial<TextLayer> = {}): TextLayer => ({
  kind: "text",
  text: "Hello",
  z: 0,
  opacity: 1,
  box: { x: 0, y: 0, w: 200, h: 100 },
  fontPx: 48,
  color: "#ffffff",
  align: "center",
  anchorV: "middle",
  font: "sans-serif",
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  weight: null,
  letterSpacingPx: 0,
  outline: null,
  shadow: null,
  bgBox: null,
  karaoke: null,
  ...over,
});

describe("blockTop — which way extra lines grow", () => {
  const BOX = 100;
  const LINE = 20;
  const first = (anchor: TextLayer["anchorV"], lines: number) =>
    blockTop(anchor, BOX, lines * LINE);

  // The reported bug: a caption that wrapped shoved its first line upward, so consecutive cards
  // sat at different heights. Compare ONE line against TWO — a single-line check cannot see it.
  it("middle moves the first line up when a second line appears", () => {
    expect(first("middle", 2)).toBeLessThan(first("middle", 1));
  });

  it("top holds the first line still however many lines there are", () => {
    expect(first("top", 1)).toBe(first("top", 2));
    expect(first("top", 1)).toBe(first("top", 5));
  });

  it("bottom holds the LAST line still instead", () => {
    const lastLine = (lines: number) => first("bottom", lines) + lines * LINE;
    expect(lastLine(1)).toBe(lastLine(3));
  });

  it("anchors the block on the same point they all describe", () => {
    // One line: every anchor puts that single line in the same place, because the block IS the line.
    expect(first("top", 1)).toBe(BOX / 2);
    expect(first("middle", 1)).toBe(BOX / 2 - LINE / 2);
    expect(first("bottom", 1)).toBe(BOX / 2 - LINE);
  });
});

describe("textKey", () => {
  it("is stable for identical layers", () => {
    expect(textKey(layer())).toBe(textKey(layer()));
  });

  it("changes when the text or style changes", () => {
    const base = textKey(layer());
    expect(textKey(layer({ text: "Bye" }))).not.toBe(base);
    expect(textKey(layer({ color: "#ff0000" }))).not.toBe(base);
    expect(textKey(layer({ fontPx: 60 }))).not.toBe(base);
    expect(textKey(layer({ align: "left" }))).not.toBe(base);
    // The anchor changes where the block lands, so a cached bitmap keyed without it would be
    // reused at the wrong height.
    expect(textKey(layer({ anchorV: "top" }))).not.toBe(base);
    expect(textKey(layer({ box: { x: 0, y: 0, w: 300, h: 100 } }))).not.toBe(base);
    expect(textKey(layer({ bold: true }))).not.toBe(base);
    expect(textKey(layer({ italic: true }))).not.toBe(base);
    expect(textKey(layer({ underline: true }))).not.toBe(base);
    expect(textKey(layer({ strike: true }))).not.toBe(base);
    expect(textKey(layer({ weight: 700 }))).not.toBe(base);
    expect(textKey(layer({ karaoke: { sungChars: 3, secondaryColor: "#808080" } }))).not.toBe(base);
    expect(textKey(layer({ letterSpacingPx: 4 }))).not.toBe(base);
  });
});
