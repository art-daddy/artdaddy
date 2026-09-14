import { describe, expect, it } from "vitest";

import { zoomPan, zoomResize, zoomThumb } from "./zoombar";

const V = { scrollLeft: 0, clientWidth: 200, zoom: 40, totalSec: 10 }; // 400px content, 5s visible

describe("zoomThumb", () => {
  it("maps the visible window to a thumb fraction", () => {
    expect(zoomThumb(V)).toEqual({ left: 0, width: 0.5 });
    expect(zoomThumb({ ...V, scrollLeft: 200 })).toEqual({ left: 0.5, width: 0.5 });
  });
  it("keeps a minimum grabbable width and never overflows", () => {
    const t = zoomThumb({ scrollLeft: 0, clientWidth: 10, zoom: 400, totalSec: 100 });
    expect(t.width).toBeGreaterThanOrEqual(0.02);
    expect(t.width).toBeLessThanOrEqual(1);
  });
});

describe("zoomPan", () => {
  it("moves the view start to the given bar fraction", () => {
    expect(zoomPan(V, 0.25)).toBe(100); // 0.25 * 10s * 40px/s
    expect(zoomPan(V, -1)).toBe(0); // clamped
  });
});

describe("zoomResize", () => {
  it("drags the right end to zoom in, anchoring the left edge", () => {
    const r = zoomResize(V, "r", 0.25, 4, 400); // visible end -> 2.5s
    expect(r.zoom).toBe(80); // 200px / 2.5s
    expect(r.scrollLeft).toBe(0); // left edge stays at 0s
  });
  it("drags the left end to zoom in, anchoring the right edge", () => {
    const r = zoomResize(V, "l", 0.25, 4, 400); // visible start -> 2.5s, end stays 5s
    expect(r.zoom).toBe(80);
    expect(r.scrollLeft).toBe(200); // 2.5s * 80px/s
  });
  it("clamps zoom to the max and keeps the anchor", () => {
    const r = zoomResize(V, "r", 0.0001, 4, 400);
    expect(r.zoom).toBe(400);
    expect(r.scrollLeft).toBe(0);
  });
  it("clamps zoom to the min", () => {
    const r = zoomResize(
      { scrollLeft: 0, clientWidth: 200, zoom: 40, totalSec: 100 },
      "r",
      1,
      4,
      400,
    );
    expect(r.zoom).toBe(4); // 200/100=2 -> min 4
  });
});
