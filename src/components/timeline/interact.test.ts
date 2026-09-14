// Rules under test, not arithmetic: a marquee selects what it touches regardless of which
// corner you started from, a razor never makes an empty clip, and a reorder only writes the
// tracks that actually moved (each write is a separate undo entry).
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { idsInBox, isMarqueeDrag, normalizeBox, razorFrame, reorderZ, type Span } from "./interact";

const span = (id: string, x0: number, x1: number, y0: number, y1: number): Span => ({
  id,
  x0,
  x1,
  y0,
  y1,
});

describe("normalizeBox", () => {
  it("gives the same box whichever corner the drag started from", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -500, max: 500 }),
        fc.integer({ min: -500, max: 500 }),
        fc.integer({ min: -500, max: 500 }),
        fc.integer({ min: -500, max: 500 }),
        (ax, ay, bx, by) => {
          expect(normalizeBox(ax, ay, bx, by)).toEqual(normalizeBox(bx, by, ax, ay));
        },
      ),
      { numRuns: 300 },
    );
  });

  it("always yields a non-negative extent", () => {
    const b = normalizeBox(100, 80, 20, 10);
    expect(b).toEqual({ x0: 20, y0: 10, x1: 100, y1: 80 });
  });
});

describe("idsInBox", () => {
  const spans = [
    span("a", 0, 50, 0, 20),
    span("b", 60, 120, 0, 20),
    span("c", 0, 50, 30, 50), // second row
  ];

  it("selects on OVERLAP, not containment", () => {
    // A clip wider than the marquee must still be caught, or you could never box-select
    // a long clip without zooming out first.
    expect(idsInBox([span("wide", -1000, 1000, 0, 20)], normalizeBox(10, 5, 20, 15))).toEqual([
      "wide",
    ]);
  });

  it("picks up every row the box crosses, and nothing outside it", () => {
    expect(idsInBox(spans, normalizeBox(10, 10, 70, 40)).sort()).toEqual(["a", "b", "c"]);
    expect(idsInBox(spans, normalizeBox(10, 10, 40, 15))).toEqual(["a"]);
    expect(idsInBox(spans, normalizeBox(200, 200, 300, 300))).toEqual([]);
    expect(idsInBox([], normalizeBox(0, 0, 100, 100))).toEqual([]);
  });

  it("counts a touching edge as a hit but a one-pixel gap as a miss", () => {
    const s = [span("a", 10, 20, 10, 20)];
    expect(idsInBox(s, normalizeBox(20, 20, 30, 30))).toEqual(["a"]); // corner touch
    expect(idsInBox(s, normalizeBox(20.1, 20.1, 30, 30))).toEqual([]);
    expect(idsInBox(s, normalizeBox(0, 0, 10, 10))).toEqual(["a"]);
    expect(idsInBox(s, normalizeBox(0, 0, 9.9, 9.9))).toEqual([]);
    // Each axis must be checked independently: a box that overlaps in x but sits in a
    // different row is a miss, and vice versa.
    expect(idsInBox(s, normalizeBox(10, 30, 20, 40))).toEqual([]); // same x, below
    expect(idsInBox(s, normalizeBox(10, 0, 20, 5))).toEqual([]); // same x, above
    expect(idsInBox(s, normalizeBox(30, 10, 40, 20))).toEqual([]); // same y, right
    expect(idsInBox(s, normalizeBox(0, 10, 5, 20))).toEqual([]); // same y, left
  });

  it("direction of the drag never changes the result (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 0, max: 60 }),
        (ax, ay, bx, by) => {
          const fwd = idsInBox(spans, normalizeBox(ax, ay, bx, by));
          const rev = idsInBox(spans, normalizeBox(bx, by, ax, ay));
          expect(fwd).toEqual(rev);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("isMarqueeDrag", () => {
  it("ignores a click that wobbled, accepts a deliberate drag on either axis", () => {
    expect(isMarqueeDrag(normalizeBox(0, 0, 2, 2))).toBe(false);
    expect(isMarqueeDrag(normalizeBox(0, 0, 10, 1))).toBe(true);
    expect(isMarqueeDrag(normalizeBox(0, 0, 1, 10))).toBe(true);
    expect(isMarqueeDrag(normalizeBox(0, 0, 4, 0))).toBe(true); // exactly the threshold, x
    expect(isMarqueeDrag(normalizeBox(0, 0, 0, 4))).toBe(true); // exactly the threshold, y
    expect(isMarqueeDrag(normalizeBox(0, 0, 3.9, 3.9))).toBe(false);
  });
});

describe("razorFrame", () => {
  const clip = { timeline_in: 100, timeline_out: 200 };

  it("cuts strictly INSIDE the clip", () => {
    expect(razorFrame(clip, 150)).toBe(150);
    expect(razorFrame(clip, 101)).toBe(101);
    expect(razorFrame(clip, 199)).toBe(199);
  });

  it("refuses a cut that would leave an empty piece, or on junk input", () => {
    // Splitting on an edge is a no-op that would still cost an undo entry.
    expect(razorFrame(clip, 100)).toBeNull();
    expect(razorFrame(clip, 200)).toBeNull();
    expect(razorFrame(clip, 50)).toBeNull();
    expect(razorFrame(clip, 500)).toBeNull();
    expect(razorFrame({}, 150)).toBeNull();
    expect(razorFrame({ timeline_in: "x", timeline_out: 200 }, 150)).toBeNull();
  });

  it("never returns a frame outside the clip (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 1, max: 500 }),
        fc.double({ min: -2000, max: 4000, noNaN: true }),
        (tin, len, at) => {
          const r = razorFrame({ timeline_in: tin, timeline_out: tin + len }, at);
          if (r === null) return;
          expect(r).toBeGreaterThan(tin);
          expect(r).toBeLessThan(tin + len);
          expect(Number.isInteger(r)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("reorderZ", () => {
  // group is DISPLAY order, topmost first; topmost composites on top, so it takes the
  // highest z. v3 on top (z2), v1 at the bottom (z0).
  const group = [
    { id: "v3", z: 2 },
    { id: "v2", z: 1 },
    { id: "v1", z: 0 },
  ];

  it("dragging the TOP track to the bottom hands it the LOWEST z", () => {
    // The direction that was wrong when this shipped: the label moved to the bottom while
    // the clip kept compositing on top, so picture and UI disagreed.
    expect(reorderZ(group, "v3", 2)).toEqual([
      { id: "v2", z: 2 },
      { id: "v1", z: 1 },
      { id: "v3", z: 0 },
    ]);
  });

  it("dragging the BOTTOM track to the top hands it the HIGHEST z", () => {
    expect(reorderZ(group, "v1", 0)).toEqual([
      { id: "v1", z: 2 },
      { id: "v3", z: 1 },
      { id: "v2", z: 0 },
    ]);
  });

  it("writes ONLY the tracks whose z actually changed", () => {
    // Every returned entry is one set_track call and therefore one undo entry, so an
    // unmoved track must not appear.
    expect(reorderZ(group, "v3", 1)).toEqual([
      { id: "v2", z: 2 },
      { id: "v3", z: 1 },
    ]);
    expect(reorderZ(group, "v3", 0)).toEqual([]); // dropped where it started
    expect(reorderZ(group, "nope", 2)).toEqual([]);
  });

  it("clamps an out-of-range drop instead of dropping the track", () => {
    expect(reorderZ(group, "v3", 99)).toEqual(reorderZ(group, "v3", 2));
    expect(reorderZ(group, "v1", -5)).toEqual(reorderZ(group, "v1", 0));
  });

  it("reuses the group's EXISTING z values, never renumbering onto a new scale", () => {
    // Sparse/offset z (tracks added over time) must survive a reorder — renumbering to
    // 0..n would silently reshuffle this group against the others.
    const sparse = [
      { id: "a", z: 40 },
      { id: "b", z: 9 },
      { id: "c", z: 5 },
    ];
    const out = reorderZ(sparse, "c", 0);
    expect(out.map((o) => o.z).sort((x, y) => x - y)).toEqual([5, 9, 40]);
    expect(out.find((o) => o.id === "c")?.z).toBe(40); // moved to the top -> highest z
  });

  it("is a PERMUTATION: the set of z values is conserved, no duplicates (property)", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 50 }), { minLength: 2, maxLength: 6 }),
        fc.nat({ max: 5 }),
        fc.nat({ max: 5 }),
        (zs, moveIdx, toIdx) => {
          const g = zs.map((z, i) => ({ id: `t${i}`, z }));
          const moved = g[moveIdx % g.length].id;
          const changes = reorderZ(g, moved, toIdx % g.length);
          const after = new Map(g.map((t) => [t.id, t.z]));
          for (const c of changes) after.set(c.id, c.z);
          const finalZs = [...after.values()].sort((a, b) => a - b);
          expect(finalZs).toEqual([...zs].sort((a, b) => a - b));
          expect(new Set(finalZs).size).toBe(g.length); // no two tracks share a z
        },
      ),
      { numRuns: 400 },
    );
  });
});
