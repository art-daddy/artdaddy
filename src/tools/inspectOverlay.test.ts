import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { fitDims, gridAss, GRID_NOTE } from "./inspectOverlay";

/** Sizes ffmpeg's `scale=768:768:force_original_aspect_ratio=decrease` actually produced (the shipped
 *  N-126655 build, 2026-10-04). The grid is drawn for exactly these pixels, so a size computed
 *  differently would draw it 1 px off the frame it lands on. */
const MEASURED: Array<[number, number, number, number]> = [
  [1920, 1080, 768, 432],
  [1080, 1920, 432, 768],
  [1360, 720, 768, 407],
  [200, 100, 768, 384],
  [1080, 1350, 614, 768],
  [720, 1280, 432, 768],
  [641, 361, 768, 433],
  [3840, 1607, 768, 321],
  [100, 2000, 38, 768],
];

describe("fitDims", () => {
  it("gives the size ffmpeg's fit produces", () => {
    for (const [w, h, ew, eh] of MEASURED) expect(fitDims(w, h, 768), `${w}x${h}`).toEqual({ w: ew, h: eh });
  });

  it("fills the edge on the long side and keeps the shape within a pixel", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 16, max: 8192 }),
        fc.integer({ min: 16, max: 8192 }),
        fc.integer({ min: 64, max: 2048 }),
        (w, h, edge) => {
          const d = fitDims(w, h, edge);
          expect(Math.max(d.w, d.h)).toBe(edge);
          expect(Math.min(d.w, d.h)).toBeLessThanOrEqual(edge);
          // The short side is the long side scaled by the source's aspect, rounded.
          if (w >= h) expect(Math.abs(d.h - (edge * h) / w)).toBeLessThanOrEqual(0.5);
          else expect(Math.abs(d.w - (edge * w) / h)).toBeLessThanOrEqual(0.5);
        },
      ),
    );
  });
});

/** The vector paths in one Dialogue's \p drawing, each `m x y l ...` as numbers in pixels. */
function rects(line: string): number[][] {
  const body = /\\p3\}(.*)\{\\p0\}/.exec(line)?.[1] ?? "";
  return body
    .split("m ")
    .filter(Boolean)
    .map((r) => r.replace("l ", "").trim().split(/\s+/).map((n) => Number(n) / 4));
}

describe("gridAss", () => {
  const W = 768;
  const H = 432;
  // Built inside each test, never at describe time: a value computed while the suite is being
  // COLLECTED belongs to no test, and mutation testing then has to re-run everything per mutant.
  const build = (): { ass: string; events: string[] } => {
    const ass = gridAss(W, H, "f120");
    return { ass, events: ass.split("\n").filter((l) => l.startsWith("Dialogue:")) };
  };

  it("draws at exactly the frame's pixels", () => {
    const { ass } = build();
    expect(ass).toContain(`PlayResX: ${W}`);
    expect(ass).toContain(`PlayResY: ${H}`);
    expect(GRID_NOTE).toBe("0-1, origin top-left");
  });

  // libass reads a v4+ script: sections in order, a Format line naming each section's fields, and
  // every event drawn with a style the file defines. A file that breaks any of these is not drawn
  // the way it says (an undefined style falls back to libass's default, at its default size).
  it("is a well-formed v4+ script whose every event uses a style it defines", () => {
    for (const caption of ["f120", undefined]) {
      const ass = gridAss(W, H, caption);
      const lines = ass.split("\n");
      const at = (s: string): number => lines.indexOf(s);
      expect(at("[Script Info]")).toBe(0);
      expect(at("[Script Info]")).toBeLessThan(at("[V4+ Styles]"));
      expect(at("[V4+ Styles]")).toBeLessThan(at("[Events]"));
      expect(lines.slice(0, at("[V4+ Styles]"))).toContain("ScriptType: v4.00+");
      const fields = (l: string): number => l.split(":")[1].split(",").length;
      const styleFormat = lines[at("[V4+ Styles]") + 1];
      const eventFormat = lines[at("[Events]") + 1];
      expect(styleFormat).toMatch(/^Format: Name,/);
      expect(eventFormat).toMatch(/^Format: Layer,/);
      const styles = lines.filter((l) => l.startsWith("Style: "));
      for (const s of styles) expect(fields(s), s).toBe(fields(styleFormat));
      const names = new Set(styles.map((s) => s.slice(7).split(",")[0]));
      const events = lines.filter((l) => l.startsWith("Dialogue: "));
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) {
        const f = e.slice(10).split(",");
        expect(f.length, e).toBeGreaterThanOrEqual(fields(eventFormat)); // text may hold commas
        expect(names.has(f[3]), `style '${f[3]}' is not defined`).toBe(true);
      }
    }
  });

  it("sizes the labels to the frame, between 8 and 11 px", () => {
    const size = (w: number, h: number): number =>
      Number(gridAss(w, h).split("\n").find((l) => l.startsWith("Style: Chip,"))!.split(",")[2]);
    expect(size(768, 432)).toBeCloseTo(432 / 42, 1); // 10.3: scales with the short side
    expect(size(512, 288)).toBe(8);
    expect(size(200, 100)).toBe(8);
    expect(size(3840, 2160)).toBe(11);
  });

  it("puts a line every 0.05 across both axes, the major ones at 0, 0.5 and 1", () => {
    const { events } = build();
    const strokes = events.filter((e) => e.includes("\\p3}"));
    expect(strokes).toHaveLength(4); // minor outline, minor core, major outline, major core
    // Centre of every vertical stroke, as a fraction of the width, per drawing.
    const centres = (line: string): number[] =>
      rects(line)
        .filter((r) => r[1] === 0 && r[5] === H) // vertical: spans the full height
        .map((r) => Math.round(((r[0] + r[2]) / 2 / W) * 100) / 100);
    const minor = centres(strokes[0]);
    const major = centres(strokes[2]);
    expect(major).toEqual([0, 0.5, 1]);
    expect(minor).toHaveLength(18);
    const all = [...minor, ...major].sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: 21 }, (_, i) => Math.round(i * 5) / 100));
    // Each style is ONE drawing covering both axes, so crossings are not painted twice.
    expect(rects(strokes[0])).toHaveLength(36);
    expect(rects(strokes[2])).toHaveLength(6);
  });

  it("draws every stroke as a closed axis-aligned rectangle, the edge ones inside the frame", () => {
    const { events } = build();
    const strokes = events.filter((e) => e.includes("\\p3}"));
    for (const line of strokes) {
      // Commands are space-separated: "...0 m 12..." never "...0m 12...".
      expect(/\\p3\}(.*)\{\\p0\}/.exec(line)![1]).not.toMatch(/\dm /);
      for (const [x0, y0, x1, y1, x2, y2, x3, y3] of rects(line)) {
        expect([y1, x2, y3, x3]).toEqual([y0, x1, y2, x0]); // (x0,y0) (x1,y0) (x1,y2) (x0,y2)
        expect(x1).toBeGreaterThan(x0);
        expect(y2).toBeGreaterThan(y0);
      }
    }
    // The lines at 0 and 1 are centred half a pixel inside the frame, so both halves show.
    const major = rects(strokes[3]);
    const vertical = major.filter((r) => r[1] === 0).map((r) => (r[0] + r[2]) / 2);
    const horizontal = major.filter((r) => r[0] === 0).map((r) => (r[1] + r[5]) / 2);
    expect(vertical).toEqual([0.5, W / 2, W - 0.5]);
    expect(horizontal).toEqual([0.5, H / 2, H - 0.5]);
  });

  it("draws every stroke as a dark outline under a lighter core", () => {
    const { events } = build();
    const strokes = events.filter((e) => e.includes("\\p3}"));
    const width = (line: string): number => {
      const vertical = rects(line).filter((r) => r[1] === 0);
      const r = vertical[Math.floor(vertical.length / 2)]; // one away from the edges
      return Math.round((r[2] - r[0]) * 100) / 100;
    };
    const colour = (line: string): string => /\\1c&H([0-9A-F]{6})&/.exec(line)![1];
    const alpha = (line: string): number => 1 - parseInt(/\\1a&H([0-9A-F]{2})&/.exec(line)![1], 16) / 255;
    // [outline, core] for minor then major, in drawing (layer) order.
    expect(strokes.map(colour)).toEqual(["000000", "FFFFFF", "000000", "FFFFFF"]);
    expect(strokes.map(width)).toEqual([2, 1, 2.5, 1.5]);
    expect(strokes.map((s) => Math.round(alpha(s) * 100) / 100)).toEqual([0.55, 0.75, 0.65, 0.95]);
    const layers = strokes.map((s) => Number(/^Dialogue: (\d+),/.exec(s)![1]));
    expect([...layers].sort((a, b) => a - b)).toEqual(layers); // outline under core, minor under major
  });

  it("labels every 0.1 down the right edge and along the bottom, inside the frame", () => {
    const { events } = build();
    const labels = events
      .filter((e) => e.includes(",Chip,"))
      .map((e) => {
        const m = /\\an(\d)\\pos\(([\d.]+),([\d.]+)\)\}(.*)$/.exec(e)!;
        return { an: Number(m[1]), x: Number(m[2]), y: Number(m[3]), text: m[4] };
      });
    const right = labels.filter((l) => l.x === W - 4);
    const bottom = labels.filter((l) => l.y === H - 4 && l.x !== W - 4);
    const ticks = ["0", "0.1", "0.2", "0.3", "0.4", "0.5", "0.6", "0.7", "0.8", "0.9", "1"];
    expect(right.map((l) => l.text)).toEqual(ticks);
    expect(bottom.map((l) => l.text)).toEqual(ticks.slice(0, 10)); // "1" is the right edge's corner
    for (const l of labels) {
      expect(l.x).toBeGreaterThanOrEqual(0);
      expect(l.x).toBeLessThanOrEqual(W);
      expect(l.y).toBeGreaterThanOrEqual(0);
      expect(l.y).toBeLessThanOrEqual(H);
    }
    // Interior labels sit ON their line; the end labels are anchored to stay inside the frame.
    expect(right.find((l) => l.text === "0.5")!.y).toBeCloseTo(H / 2, 5);
    expect(bottom.find((l) => l.text === "0.5")!.x).toBeCloseTo(W / 2, 5);
    expect(right[0]).toMatchObject({ an: 9, y: 4 }); // top-right corner: hangs below its point
    expect(right[10]).toMatchObject({ an: 3, y: H - 4 }); // bottom-right corner: sits above it
    right.slice(1, 10).forEach((l, i) => {
      expect(l.an).toBe(6); // right-middle: centred on its line, text to the left of the edge
      expect(l.y).toBeCloseTo(((i + 1) / 10) * H, 1);
    });
    expect(bottom[0]).toMatchObject({ an: 1, x: 4 }); // bottom-left corner
    bottom.slice(1).forEach((l, i) => {
      expect(l.an).toBe(2); // bottom-centre: centred on its line
      expect(l.x).toBeCloseTo(((i + 1) / 10) * W, 1);
    });
  });

  it("puts the caption top-left, and a caption can never become an ASS tag", () => {
    const { events } = build();
    const cap = events.filter((e) => e.includes(",Caption,"));
    expect(cap).toHaveLength(1);
    expect(cap[0]).toMatch(/\{\\an7\\pos\(5,3\)\}f120$/);
    const hostile = gridAss(W, H, "f1{\\fs400\\c&H0000FF&}2\\N");
    const text = hostile.split("\n").find((l) => l.includes(",Caption,"))!.split("}").slice(1).join("}");
    expect(text).not.toMatch(/[{}\\]/);
    expect(text).toContain("f1");
    expect(gridAss(W, H).includes(",Caption,")).toBe(false);
  });
});
