// The rule under test: what the handles draw is where the compositor puts the clip, and
// what a drag produces is what the user aimed at. Both are geometry, so the tests assert
// RELATIONSHIPS that survive a rewrite (aspect preserved, never inverts, topmost wins)
// rather than restating the arithmetic.
//
// The parity block is the one that matters most: stageGeometry computes the clip box
// independently of scene.ts, so a change to either silently puts the handles somewhere
// the picture isn't. That test compares against the compositor's OWN draw list.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { Clip, Timeline } from "../timeline/model";
import { buildScene, type AssetDims } from "./scene";
import {
  angleFromCentre,
  canvasRectInView,
  clampedRect,
  croppedFractions,
  growBox,
  handleOrigin,
  handlePositions,
  hitTest,
  MIN_BOX,
  movedBox,
  normBoxOf,
  normBoxToView,
  pictureBoxOf,
  resizedBox,
  rotatedCorners,
  rotationHandlePoint,
  snapDegrees,
  viewDeltaToNorm,
  type Corner,
  type NormBox,
} from "./stageGeometry";

const CORNERS: Corner[] = ["tl", "tr", "bl", "br"];
const box = (cx: number, cy: number, w: number, h: number, rotate = 0): NormBox => ({
  cx,
  cy,
  w,
  h,
  rotate,
});

describe("canvasRectInView", () => {
  it("letterboxes: preserves the canvas aspect and centres it inside the view", () => {
    const r = canvasRectInView(800, 600, 1080, 1920); // portrait canvas in a landscape view
    expect(r.w / r.h).toBeCloseTo(1080 / 1920, 6);
    expect(r.h).toBe(600); // height-constrained
    expect(r.x + r.w / 2).toBeCloseTo(400, 6);
    expect(r.y + r.h / 2).toBeCloseTo(300, 6);
  });

  it("pillarboxes the other way round, and never overflows the view", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4000 }),
        fc.integer({ min: 1, max: 4000 }),
        fc.integer({ min: 1, max: 8000 }),
        fc.integer({ min: 1, max: 8000 }),
        (vw, vh, cw, ch) => {
          const r = canvasRectInView(vw, vh, cw, ch);
          expect(r.w).toBeLessThanOrEqual(vw + 1e-6);
          expect(r.h).toBeLessThanOrEqual(vh + 1e-6);
          expect(r.w / r.h).toBeCloseTo(cw / ch, 4);
          expect(r.x).toBeGreaterThanOrEqual(-1e-9);
          expect(r.y).toBeGreaterThanOrEqual(-1e-9);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("collapses to zero rather than dividing by zero on a not-yet-laid-out view", () => {
    // A React overlay mounts before layout, so this WILL be hit with 0x0 on the first paint.
    const cases: [number, number, number, number][] = [
      [0, 600, 1080, 1920],
      [800, 0, 1080, 1920],
      [800, 600, 0, 1920],
      [800, 600, 1080, 0],
      [NaN, 600, 1080, 1920],
    ];
    for (const [vw, vh, cw, ch] of cases) {
      expect(canvasRectInView(vw, vh, cw, ch)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    }
  });

  it("uses the LARGEST rect that fits: exactly one axis is filled edge to edge", () => {
    // Pins which branch is which — a swapped pair still preserves aspect, so the
    // aspect property above cannot see it, but the canvas would overflow or shrink.
    const wide = canvasRectInView(800, 600, 1920, 1080); // wider than the view -> width-bound
    expect(wide.w).toBeCloseTo(800, 6);
    expect(wide.h).toBeCloseTo(450, 6);
    expect(wide.x).toBeCloseTo(0, 6);
    expect(wide.y).toBeCloseTo(75, 6);
    const tall = canvasRectInView(800, 600, 1080, 1920); // taller -> height-bound
    expect(tall.h).toBeCloseTo(600, 6);
    expect(tall.w).toBeCloseTo(337.5, 6);
    expect(tall.y).toBeCloseTo(0, 6);
    expect(tall.x).toBeCloseTo(231.25, 6);
    const exact = canvasRectInView(800, 600, 4, 3); // same aspect -> fills both
    expect(exact).toEqual({ x: 0, y: 0, w: 800, h: 600 });
  });
});

describe("normBoxOf", () => {
  it("an untransformed clip fills the canvas", () => {
    expect(normBoxOf({ id: "a" } as Clip, 0)).toEqual({
      cx: 0.5,
      cy: 0.5,
      w: 1,
      h: 1,
      rotate: 0,
    });
    expect(normBoxOf({ id: "a", transform: {} } as Clip, 0)).toEqual({
      cx: 0.5,
      cy: 0.5,
      w: 1,
      h: 1,
      rotate: 0,
    });
  });

  it("reads scale_x/scale_y over the uniform scale, and samples keyframes at the frame", () => {
    const clip = {
      id: "a",
      transform: {
        position: { x: 0.25, y: 0.75 },
        scale: 0.5,
        scale_x: [
          { t: 0, v: 0.2 },
          { t: 10, v: 0.6 },
        ],
      },
    } as unknown as Clip;
    expect(normBoxOf(clip, 0)).toMatchObject({ cx: 0.25, cy: 0.75, w: 0.2, h: 0.5 });
    expect(normBoxOf(clip, 10)).toMatchObject({ w: 0.6, h: 0.5 });
    // A keyframed box MOVES over time — a single-frame check cannot tell animated from static.
    expect(normBoxOf(clip, 0).w).not.toBe(normBoxOf(clip, 10).w);
  });

  it("treats ANY transform field as a transform, and a missing axis as centred", () => {
    // Each field alone must switch the clip off the full-canvas default; a clip with only
    // scale_y set was otherwise reported as untransformed and its handles filled the frame.
    const only = (t: unknown) => normBoxOf({ id: "a", transform: t } as unknown as Clip, 0);
    expect(only({ position: { x: 0.2 } })).toEqual({ cx: 0.2, cy: 0.5, w: 1, h: 1, rotate: 0 });
    expect(only({ position: { y: 0.2 } })).toEqual({ cx: 0.5, cy: 0.2, w: 1, h: 1, rotate: 0 });
    expect(only({ scale: 0.4 })).toEqual({ cx: 0.5, cy: 0.5, w: 0.4, h: 0.4, rotate: 0 });
    expect(only({ scale_x: 0.4 })).toEqual({ cx: 0.5, cy: 0.5, w: 0.4, h: 1, rotate: 0 });
    expect(only({ scale_y: 0.4 })).toEqual({ cx: 0.5, cy: 0.5, w: 1, h: 0.4, rotate: 0 });
  });
});

describe("normBoxOf ↔ compositor parity", () => {
  // If these two ever disagree the handles sit somewhere the picture isn't, and nothing
  // else in the suite would notice: the overlay would look self-consistent and be wrong.
  const dims = new Map<string, AssetDims>([["v.mp4", { w: 1920, h: 1080 }]]);
  const CANVAS = { x: 0, y: 0, w: 1080, h: 1920 };
  const timelineWith = (transform: unknown, timelineIn = 0): Timeline =>
    ({
      // Production timelines are authored in FRAMES and say so; without this the plan is
      // read as already-seconds and the whole frame base shifts under you.
      units: "frames",
      canvas: { width: 1080, height: 1920, fps: 30 },
      tracks: [
        {
          id: "v1",
          kind: "video",
          z: 0,
          clips: [
            {
              id: "c1",
              kind: "video",
              media_ref: "v.mp4",
              timeline_in: timelineIn,
              timeline_out: timelineIn + 60,
              source_in: 0,
              source_out: 60,
              ...(transform ? { transform } : {}),
            },
          ],
        },
      ],
    }) as unknown as Timeline;

  it.each([
    ["untransformed", undefined],
    ["centred half-size", { position: { x: 0.5, y: 0.5 }, scale: 0.5 }],
    ["off-centre band", { position: { x: 0.5, y: 0.2 }, scale_x: 1, scale_y: 0.25 }],
    ["partly off-frame", { position: { x: 0.1, y: 0.9 }, scale: 0.8 }],
  ])("%s: the handle box equals the compositor's clipBox", (_name, transform) => {
    const tl = timelineWith(transform);
    const scene = buildScene(tl, 0, dims);
    expect(scene.layers).toHaveLength(1);
    const mine = normBoxToView(normBoxOf(tl.tracks[0].clips![0], 0), CANVAS);
    const theirs = scene.layers[0].clipBox;
    expect(mine.x).toBeCloseTo(theirs.x, 0);
    expect(mine.y).toBeCloseTo(theirs.y, 0);
    expect(mine.w).toBeCloseTo(theirs.w, 0);
    expect(mine.h).toBeCloseTo(theirs.h, 0);
  });

  it("samples animation CLIP-RELATIVELY, matching the compositor on a LATE-starting clip", () => {
    // The trap the earlier cases all miss: they start at frame 0, where absolute and
    // clip-relative frames coincide. A clip starting at 90 with a keyframed scale is the
    // only shape that can catch the overlay reading the animation at the wrong base.
    const TIMELINE_IN = 90;
    const tl = timelineWith(
      {
        position: { x: 0.5, y: 0.5 },
        scale: [
          { t: 0, v: 0.25 },
          { t: 30, v: 0.75 },
        ],
      },
      TIMELINE_IN,
    );
    const clip = tl.tracks[0].clips![0];
    const seen: number[] = [];
    for (const absFrame of [90, 105, 120]) {
      const scene = buildScene(tl, absFrame / 30, dims);
      expect(scene.layers).toHaveLength(1);
      const mine = normBoxToView(normBoxOf(clip, absFrame - TIMELINE_IN), CANVAS);
      expect(mine.w).toBeCloseTo(scene.layers[0].clipBox.w, 0);
      expect(mine.h).toBeCloseTo(scene.layers[0].clipBox.h, 0);
      seen.push(scene.layers[0].clipBox.w);
    }
    // The box must actually MOVE across those frames, or the agreement above is vacuous —
    // two implementations that both freeze would match perfectly and both be wrong.
    expect(new Set(seen).size).toBe(3);
  });
});

describe("the overlay box is where the compositor DRAWS the picture", () => {
  // The parity block above pins normBoxOf against `clipBox` — the TRANSFORM box. That is
  // the wrong quantity to draw handles from: `fit` letterboxes the picture INSIDE that
  // box, so the two agreed perfectly while the handles sat a quarter of the canvas above
  // the clip. These compare against `dst`, which is what the user actually sees.
  const CANVAS_W = 1080;
  const CANVAS_H = 1920;
  const CANVAS = { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H };
  const timelineWith = (clipExtra: Record<string, unknown>): Timeline =>
    ({
      units: "frames",
      canvas: { width: CANVAS_W, height: CANVAS_H, fps: 30 },
      tracks: [
        {
          id: "v1",
          kind: "video",
          z: 0,
          clips: [
            {
              id: "c1",
              kind: "image",
              media_ref: "a.png",
              timeline_in: 0,
              timeline_out: 60,
              ...clipExtra,
            },
          ],
        },
      ],
    }) as unknown as Timeline;

  it("a 726x612 photo in a 1080x1920 frame fills the width and 47% of the height", () => {
    // The reported bug, with the reporter's own numbers. contain-fit scales 726 -> 1080,
    // so the picture is 1080x910 while the transform box is the whole 1080x1920 frame.
    const tl = timelineWith({});
    const { box, pic } = pictureBoxOf(tl.tracks[0].clips![0], 0, CANVAS_W, CANVAS_H, {
      w: 726,
      h: 612,
    });
    expect(box.h).toBe(1); // the slot: the whole frame
    expect(pic.h).toBeCloseTo((612 * (1080 / 726)) / 1920, 3); // the picture: 47% of it
    expect(pic.w).toBe(1);
    // Handles drawn from the box would sit this far above the picture — a quarter of the
    // canvas. Asserting it is NOT zero is the whole point.
    expect((box.h - pic.h) / 2).toBeGreaterThan(0.25);
  });

  it.each([
    ["untransformed still", { w: 726, h: 612 }, {}],
    ["landscape video, scaled", { w: 1920, h: 1080 }, { transform: { scale: 0.8 } }],
    [
      "tall source, off-centre",
      { w: 900, h: 2400 },
      { transform: { position: { x: 0.3, y: 0.6 } } },
    ],
    ["cover fills the box", { w: 1920, h: 1080 }, { fit: "cover" }],
    ["cropped on two sides", { w: 1000, h: 1000 }, { crop: { left: 0.25, bottom: 0.1 } }],
  ])("%s: equals the compositor's own dst rect", (_name, asset, extra) => {
    const tl = timelineWith(extra as Record<string, unknown>);
    const scene = buildScene(tl, 0, new Map<string, AssetDims>([["a.png", asset as AssetDims]]));
    expect(scene.layers).toHaveLength(1);
    const mine = normBoxToView(
      pictureBoxOf(tl.tracks[0].clips![0], 0, CANVAS_W, CANVAS_H, asset as AssetDims).pic,
      CANVAS,
    );
    const theirs = scene.layers[0].dst;
    expect(mine.x).toBeCloseTo(theirs.x, 0);
    expect(mine.y).toBeCloseTo(theirs.y, 0);
    expect(mine.w).toBeCloseTo(theirs.w, 0);
    expect(mine.h).toBeCloseTo(theirs.h, 0);
  });

  it("falls back to the transform box while the size is still unknown", () => {
    const tl = timelineWith({});
    const { box, pic, shrink } = pictureBoxOf(tl.tracks[0].clips![0], 0, CANVAS_W, CANVAS_H, null);
    expect(pic).toEqual(box);
    expect(shrink).toEqual({ sw: 1, sh: 1 });
  });

  it("growBox undoes shrinkBox, so a gesture writes the transform it started from", () => {
    // The overlay drags the PICTURE but must commit a BOX. A round trip that loses the
    // letterbox would silently rescale the clip on every no-op drag.
    const tl = timelineWith({ transform: { position: { x: 0.4, y: 0.7 }, scale: 0.6 } });
    const { box, pic, shrink } = pictureBoxOf(tl.tracks[0].clips![0], 0, CANVAS_W, CANVAS_H, {
      w: 726,
      h: 612,
    });
    const back = growBox(pic, shrink);
    expect(back.cx).toBeCloseTo(box.cx, 6);
    expect(back.cy).toBeCloseTo(box.cy, 6);
    expect(back.w).toBeCloseTo(box.w, 6);
    expect(back.h).toBeCloseTo(box.h, 6);
  });
});

describe("hitTest", () => {
  const r = (x: number, y: number) => ({ x, y, w: 10, h: 10 });

  it("returns the TOPMOST clip under the point, not the first in the array", () => {
    const entries = [
      { id: "under", rect: r(0, 0), z: 1 },
      { id: "over", rect: r(0, 0), z: 5 },
      { id: "also-under", rect: r(0, 0), z: 3 },
    ];
    expect(hitTest(entries, 5, 5)?.id).toBe("over");
    expect(hitTest([...entries].reverse(), 5, 5)?.id).toBe("over"); // order must not matter
  });

  it("misses outside every rect, and includes the boundary", () => {
    const entries = [{ id: "a", rect: r(0, 0), z: 0 }];
    expect(hitTest(entries, 11, 5)).toBeNull();
    expect(hitTest(entries, 5, -1)).toBeNull();
    expect(hitTest([], 5, 5)).toBeNull();
    // All four edges are INCLUSIVE: a click on the border of a clip selects it.
    for (const [x, y] of [
      [0, 5],
      [10, 5],
      [5, 0],
      [5, 10],
    ])
      expect(hitTest(entries, x, y)?.id).toBe("a");
    // ...and one pixel beyond each edge does not.
    for (const [x, y] of [
      [-0.1, 5],
      [10.1, 5],
      [5, -0.1],
      [5, 10.1],
    ])
      expect(hitTest(entries, x, y)).toBeNull();
  });

  it("keeps the FIRST of two clips at equal z, so a tie is stable", () => {
    const tie = [
      { id: "first", rect: r(0, 0), z: 2 },
      { id: "second", rect: r(0, 0), z: 2 },
    ];
    expect(hitTest(tie, 5, 5)?.id).toBe("first");
  });
});

describe("movedBox", () => {
  it("translates by exactly the delta when nothing is in snapping range", () => {
    const { box: b } = movedBox(box(0.5, 0.5, 0.2, 0.2), 0.1, -0.2, 0);
    expect(b).toEqual({ cx: 0.6, cy: 0.3, w: 0.2, h: 0.2, rotate: 0 });
  });

  it("never changes the SIZE, however far it is dragged (property)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.05, max: 1, noNaN: true }),
        fc.double({ min: 0.05, max: 1, noNaN: true }),
        fc.double({ min: -50, max: 50, noNaN: true }),
        fc.double({ min: -50, max: 50, noNaN: true }),
        (w, h, dx, dy) => {
          const { box: b } = movedBox(box(0.5, 0.5, w, h), dx, dy, 0.02);
          expect(b.w).toBe(w);
          expect(b.h).toBe(h);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("round-trips: moving by d then by -d returns to the start (no snapping)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.1, max: 0.9, noNaN: true }),
        fc.double({ min: -2, max: 2, noNaN: true }),
        (cx, dx) => {
          const start = box(cx, 0.5, 0.3, 0.3);
          const there = movedBox(start, dx, 0, 0).box;
          const back = movedBox(there, -dx, 0, 0).box;
          expect(back.cx).toBeCloseTo(start.cx, 9);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("snaps EVERY edge to its own canvas edge, not just the horizontal pair", () => {
    const b = box(0.5, 0.5, 0.2, 0.2);
    expect(movedBox(b, -0.395, 0, 0.02).box.cx).toBeCloseTo(0.1, 9); // left  -> 0
    expect(movedBox(b, 0.395, 0, 0.02).box.cx).toBeCloseTo(0.9, 9); // right -> 1
    expect(movedBox(b, 0, -0.395, 0.02).box.cy).toBeCloseTo(0.1, 9); // top   -> 0
    expect(movedBox(b, 0, 0.395, 0.02).box.cy).toBeCloseTo(0.9, 9); // bottom-> 1
  });

  it("snapping is inclusive at exactly the threshold and off just beyond it", () => {
    const b = box(0.5, 0.5, 0.2, 0.2);
    expect(movedBox(b, -0.38, 0, 0.02).box.cx).toBeCloseTo(0.1, 9); // gap == snap -> pinned
    expect(movedBox(b, -0.379, 0, 0.02).box.cx).toBeCloseTo(0.121, 9); // just outside -> free
    expect(movedBox(b, 0, -0.38, 0.02).box.cy).toBeCloseTo(0.1, 9);
    expect(movedBox(b, 0, -0.379, 0.02).box.cy).toBeCloseTo(0.121, 9);
  });

  it("reports the two centre guides INDEPENDENTLY", () => {
    const b = box(0.5, 0.5, 0.2, 0.2);
    const xOnly = movedBox(b, 0.005, 0.3, 0.02);
    expect([xOnly.guideX, xOnly.guideY]).toEqual([true, false]);
    const yOnly = movedBox(b, 0.3, 0.005, 0.02);
    expect([yOnly.guideX, yOnly.guideY]).toEqual([false, true]);
  });

  it("snaps the leading edge to the canvas edge, and reports centre guides", () => {
    const near = movedBox(box(0.5, 0.5, 0.2, 0.2), -0.395, 0, 0.02).box; // left edge ≈ 0.005
    expect(near.cx).toBeCloseTo(0.1, 9); // pinned so the left edge sits exactly on 0
    const right = movedBox(box(0.5, 0.5, 0.2, 0.2), 0.395, 0, 0.02).box;
    expect(right.cx).toBeCloseTo(0.9, 9);
    const centred = movedBox(box(0.5, 0.5, 0.2, 0.2), 0.01, 0.01, 0.02);
    expect(centred.guideX).toBe(true);
    expect(centred.guideY).toBe(true);
    expect(centred.box.cx).toBe(0.5);
    const away = movedBox(box(0.5, 0.5, 0.2, 0.2), 0.3, 0.3, 0.02);
    expect(away.guideX).toBe(false);
    expect(away.guideY).toBe(false);
  });

  it("with snapping OFF, a drag is never silently adjusted", () => {
    const { box: b, guideX } = movedBox(box(0.5, 0.5, 0.2, 0.2), 0.0001, 0, 0);
    expect(b.cx).toBe(0.5001);
    expect(guideX).toBe(false);
  });
});

describe("resizedBox", () => {
  it("holds the OPPOSITE corner still (that is what makes a resize feel anchored)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CORNERS),
        fc.double({ min: -0.3, max: 0.3, noNaN: true }),
        fc.double({ min: -0.3, max: 0.3, noNaN: true }),
        (corner, dx, dy) => {
          const start = box(0.5, 0.5, 0.4, 0.4);
          const out = resizedBox(start, corner, dx, dy);
          const sL = start.cx - start.w / 2;
          const sR = start.cx + start.w / 2;
          const sT = start.cy - start.h / 2;
          const sB = start.cy + start.h / 2;
          const oL = out.cx - out.w / 2;
          const oR = out.cx + out.w / 2;
          const oT = out.cy - out.h / 2;
          const oB = out.cy + out.h / 2;
          if (corner === "tl" || corner === "bl") expect(oR).toBeCloseTo(sR, 9);
          else expect(oL).toBeCloseTo(sL, 9);
          if (corner === "tl" || corner === "tr") expect(oB).toBeCloseTo(sB, 9);
          else expect(oT).toBeCloseTo(sT, 9);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("NEVER inverts or collapses, however violently it is dragged (property)", () => {
    // The failure direction: yank a corner far past the opposite one. A naive
    // implementation produces a negative size and the overlay turns inside out.
    fc.assert(
      fc.property(
        fc.constantFrom(...CORNERS),
        fc.double({ min: -100, max: 100, noNaN: true }),
        fc.double({ min: -100, max: 100, noNaN: true }),
        fc.option(fc.double({ min: 0.1, max: 10, noNaN: true }), { nil: undefined }),
        (corner, dx, dy, aspect) => {
          const out = resizedBox(box(0.5, 0.5, 0.4, 0.4), corner, dx, dy, { aspect });
          expect(out.w).toBeGreaterThanOrEqual(MIN_BOX - 1e-9);
          expect(out.h).toBeGreaterThanOrEqual(MIN_BOX - 1e-9);
          expect(Number.isFinite(out.cx)).toBe(true);
          expect(Number.isFinite(out.cy)).toBe(true);
        },
      ),
      { numRuns: 600 },
    );
  });

  it("holds the media aspect exactly — this is what keeps handles ON the picture", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CORNERS),
        fc.double({ min: -0.5, max: 0.5, noNaN: true }),
        fc.double({ min: -0.5, max: 0.5, noNaN: true }),
        fc.double({ min: 0.2, max: 5, noNaN: true }),
        (corner, dx, dy, aspect) => {
          const out = resizedBox(box(0.5, 0.5, 0.4, 0.4), corner, dx, dy, { aspect });
          expect(out.w / out.h).toBeCloseTo(aspect, 6);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("without an aspect lock, the axes move independently", () => {
    const out = resizedBox(box(0.5, 0.5, 0.4, 0.4), "br", 0.2, 0, {});
    expect(out.w).toBeCloseTo(0.6, 9);
    expect(out.h).toBeCloseTo(0.4, 9);
  });

  it("clamps the DRAGGED edge only, per corner, when yanked past the opposite one", () => {
    // One assertion per corner: a shared clamp that moved the wrong edge would still
    // satisfy the "never inverts" property while anchoring the box to the wrong point.
    const start = box(0.5, 0.5, 0.4, 0.4);
    const far = 10;
    const tl = resizedBox(start, "tl", far, far);
    expect(tl.cx + tl.w / 2).toBeCloseTo(0.7, 9); // right edge held
    expect(tl.cy + tl.h / 2).toBeCloseTo(0.7, 9); // bottom edge held
    expect(tl.w).toBeCloseTo(MIN_BOX, 9);
    const br = resizedBox(start, "br", -far, -far);
    expect(br.cx - br.w / 2).toBeCloseTo(0.3, 9); // left edge held
    expect(br.cy - br.h / 2).toBeCloseTo(0.3, 9); // top edge held
    expect(br.h).toBeCloseTo(MIN_BOX, 9);
    const tr = resizedBox(start, "tr", -far, far);
    expect(tr.cx - tr.w / 2).toBeCloseTo(0.3, 9);
    expect(tr.cy + tr.h / 2).toBeCloseTo(0.7, 9);
    const bl = resizedBox(start, "bl", far, -far);
    expect(bl.cx + bl.w / 2).toBeCloseTo(0.7, 9);
    expect(bl.cy - bl.h / 2).toBeCloseTo(0.3, 9);
  });

  it("aspect lock grows the axis the pointer pulled FURTHER, moving the dragged edge", () => {
    const start = box(0.5, 0.5, 0.4, 0.4);
    // Pull mostly horizontally: width wins and the height is derived, moving the TOP edge.
    const wide = resizedBox(start, "tl", -0.2, -0.01, { aspect: 1 });
    expect(wide.w).toBeCloseTo(0.6, 9);
    expect(wide.h).toBeCloseTo(0.6, 9);
    expect(wide.cy + wide.h / 2).toBeCloseTo(0.7, 9); // bottom held, top moved
    // Pull mostly vertically: height wins and the width is derived, moving the LEFT edge.
    const tall = resizedBox(start, "tl", -0.01, -0.2, { aspect: 1 });
    expect(tall.h).toBeCloseTo(0.6, 9);
    expect(tall.cx + tall.w / 2).toBeCloseTo(0.7, 9); // right held, left moved
  });

  it("ignores a nonsense aspect instead of producing NaN", () => {
    for (const aspect of [0, -2, NaN, Infinity]) {
      const out = resizedBox(box(0.5, 0.5, 0.4, 0.4), "br", 0.2, 0, { aspect });
      expect(Number.isFinite(out.w)).toBe(true);
      expect(out.w).toBeGreaterThanOrEqual(MIN_BOX);
      // and it must behave as UNLOCKED, not silently lock to some other ratio
      expect(out.w).toBeCloseTo(0.6, 9);
      expect(out.h).toBeCloseTo(0.4, 9);
    }
  });
});

describe("croppedFractions", () => {
  it("drags each handle INWARD, whichever side it is on", () => {
    expect(croppedFractions(undefined, "left", 0.2).left).toBeCloseTo(0.2, 9);
    expect(croppedFractions(undefined, "top", 0.2).top).toBeCloseTo(0.2, 9);
    // right/bottom move inward on a negative screen delta but that is a BIGGER crop
    expect(croppedFractions(undefined, "right", -0.2).right).toBeCloseTo(0.2, 9);
    expect(croppedFractions(undefined, "bottom", -0.2).bottom).toBeCloseTo(0.2, 9);
  });

  it("opposing crops can never eat the whole frame (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("left" as const, "right" as const, "top" as const, "bottom" as const),
        fc.double({ min: 0, max: 0.98, noNaN: true }),
        fc.double({ min: -50, max: 50, noNaN: true }),
        (edge, existing, d) => {
          const start =
            edge === "left" || edge === "right" ? { right: existing } : { bottom: existing };
          const out = croppedFractions(start, edge, d);
          for (const v of [out.left, out.right, out.top, out.bottom]) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(0.99);
          }
          expect(out.left! + out.right!).toBeLessThan(1);
          expect(out.top! + out.bottom!).toBeLessThan(1);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("leaves the other three edges untouched", () => {
    const out = croppedFractions({ left: 0.1, right: 0.2, top: 0.3, bottom: 0.05 }, "left", 0.05);
    expect(out).toEqual({ left: 0.15000000000000002, right: 0.2, top: 0.3, bottom: 0.05 });
  });

  it("treats an out-of-range stored crop as absent rather than trusting it", () => {
    const out = croppedFractions({ left: 5, right: -1, top: 1, bottom: 0 }, "top", 0.1);
    expect(out.left).toBe(0);
    expect(out.right).toBe(0);
    expect(out.top).toBeCloseTo(0.1, 9);
    // exactly 0 and exactly 1 are both "no crop" — the open interval is deliberate
    expect(croppedFractions({ left: 0 }, "top", 0.1).left).toBe(0);
    expect(croppedFractions({ left: 1 }, "top", 0.1).left).toBe(0);
    expect(croppedFractions({ left: 0.999 }, "top", 0.1).left).toBeCloseTo(0.999, 9);
  });
});

describe("handlePositions", () => {
  const bounds = { x: 100, y: 50, w: 200, h: 400 };

  it("the outline and the handles are the SAME rectangle, for ANY box (property)", () => {
    // The reported bug: the dots were clamped inside the frame while the outline was
    // drawn raw, so once the clip was scaled past the frame the lines ran off into the
    // surrounding chrome and the dots sat on the edge, visibly detached.
    fc.assert(
      fc.property(
        fc.double({ min: -5000, max: 5000, noNaN: true }),
        fc.double({ min: -5000, max: 5000, noNaN: true }),
        fc.double({ min: 0, max: 10000, noNaN: true }),
        fc.double({ min: 0, max: 10000, noNaN: true }),
        (x, y, w, h) => {
          const r = clampedRect({ x, y, w, h }, bounds);
          const p = handlePositions({ x, y, w, h }, bounds);
          expect(p.tl).toEqual({ x: r.x, y: r.y });
          expect(p.tr).toEqual({ x: r.x + r.w, y: r.y });
          expect(p.bl).toEqual({ x: r.x, y: r.y + r.h });
          expect(p.br).toEqual({ x: r.x + r.w, y: r.y + r.h });
        },
      ),
      { numRuns: 400 },
    );
  });

  it("a ZERO rotation is bit-identical to no rotation, on a rect that exposes the ulp", () => {
    // Seed 95154530 found this: rotating by 0 still round-tripped every corner through the
    // box centre, and `c + (p - c)` drops an ulp — so the outline came back one bit off the
    // rect it is required to equal, for an ordinary upright clip.
    const rect = { x: 0, y: 50.00000000000001, w: 0, h: 128.00000000000003 };
    expect(rotatedCorners(rect, 0)).toEqual({
      tl: { x: rect.x, y: rect.y },
      tr: { x: rect.x + rect.w, y: rect.y },
      bl: { x: rect.x, y: rect.y + rect.h },
      br: { x: rect.x + rect.w, y: rect.y + rect.h },
    });
    expect(handlePositions(rect, bounds, 0)).toEqual(handlePositions(rect, bounds));
  });

  it("leaves the corners alone while the box fits inside the canvas", () => {
    const rect = { x: 120, y: 80, w: 60, h: 100 };
    expect(handlePositions(rect, bounds)).toEqual({
      tl: { x: 120, y: 80 },
      tr: { x: 180, y: 80 },
      bl: { x: 120, y: 180 },
      br: { x: 180, y: 180 },
    });
  });

  it("pulls handles back inside when the clip is scaled PAST the frame", () => {
    // The reported bug: scale a clip up and its corners leave the stage, which clips
    // them, so there is nothing left to grab and no way to scale back down.
    const huge = { x: -500, y: -900, w: 2000, h: 3000 };
    expect(handlePositions(huge, bounds)).toEqual({
      tl: { x: 100, y: 50 },
      tr: { x: 300, y: 50 },
      bl: { x: 100, y: 450 },
      br: { x: 300, y: 450 },
    });
  });

  it("keeps EVERY handle inside the canvas for ANY box (property)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -5000, max: 5000, noNaN: true }),
        fc.double({ min: -5000, max: 5000, noNaN: true }),
        fc.double({ min: 0, max: 10000, noNaN: true }),
        fc.double({ min: 0, max: 10000, noNaN: true }),
        fc.double({ min: 0, max: 40, noNaN: true }),
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        (x, y, w, h, size, rotate) => {
          const pts = handlePositions({ x, y, w, h }, bounds, rotate);
          for (const p of Object.values(pts)) {
            expect(p.x).toBeGreaterThanOrEqual(bounds.x);
            expect(p.x).toBeLessThanOrEqual(bounds.x + bounds.w);
            expect(p.y).toBeGreaterThanOrEqual(bounds.y);
            expect(p.y).toBeLessThanOrEqual(bounds.y + bounds.h);
            // ...and the whole handle DRAWN at that point stays inside too.
            const o = handleOrigin(p, bounds, size);
            expect(o.x).toBeGreaterThanOrEqual(bounds.x - 1e-9);
            expect(o.x + size).toBeLessThanOrEqual(bounds.x + bounds.w + 1e-9);
            expect(o.y).toBeGreaterThanOrEqual(bounds.y - 1e-9);
            expect(o.y + size).toBeLessThanOrEqual(bounds.y + bounds.h + 1e-9);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("nudges the HANDLE inward, never the outline", () => {
    // Clamping to the exact edge leaves half the handle outside the stage: it still LOOKS
    // present, but its centre is no longer the topmost element and real mouse input lands
    // on the container instead (found by hit-testing the running app). Insetting the SHAPE
    // instead drew a clip that exactly fills the frame as if it were smaller than it.
    const huge = { x: -500, y: -900, w: 2000, h: 3000 };
    expect(clampedRect(huge, bounds)).toEqual({ x: 100, y: 50, w: 200, h: 400 }); // the frame, exactly
    const pts = handlePositions(huge, bounds);
    expect(handleOrigin(pts.tl, bounds, 10)).toEqual({ x: 100, y: 50 });
    expect(handleOrigin(pts.br, bounds, 10)).toEqual({ x: 290, y: 440 });
  });

  it("centres the handle when the canvas is thinner than the handle itself", () => {
    const thin = { x: 0, y: 0, w: 6, h: 6 };
    const pts = handlePositions({ x: -100, y: -100, w: 500, h: 500 }, thin);
    expect(pts.tl.x).toBeLessThanOrEqual(pts.tr.x);
    expect(pts.tl.y).toBeLessThanOrEqual(pts.bl.y);
    // Nothing can fit; centring keeps it symmetric instead of inverting the bounds.
    expect(handleOrigin(pts.tl, thin, 10)).toEqual({ x: -2, y: -2 });
  });

  it("clamps each axis independently, so a box that overflows only sideways keeps its true top", () => {
    const wide = { x: -100, y: 100, w: 1000, h: 50 };
    const pts = handlePositions(wide, bounds);
    expect(pts.tl).toEqual({ x: 100, y: 100 }); // x clamped, y untouched
    expect(pts.br).toEqual({ x: 300, y: 150 });
  });
});

describe("viewDeltaToNorm", () => {
  it("scales a pixel delta by the canvas rect, and survives a collapsed rect", () => {
    expect(viewDeltaToNorm(50, 100, { x: 0, y: 0, w: 500, h: 400 })).toEqual({
      dx: 0.1,
      dy: 0.25,
    });
    expect(viewDeltaToNorm(50, 100, { x: 0, y: 0, w: 0, h: 0 })).toEqual({ dx: 0, dy: 0 });
  });

  it("round-trips a box through view space unchanged", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.05, max: 0.95, noNaN: true }),
        fc.double({ min: 0.05, max: 0.9, noNaN: true }),
        (cx, w) => {
          const canvas = { x: 17, y: 42, w: 800, h: 600 };
          const b = box(cx, 0.5, w, 0.5);
          const view = normBoxToView(b, canvas);
          expect((view.x - canvas.x + view.w / 2) / canvas.w).toBeCloseTo(b.cx, 9);
          expect(view.w / canvas.w).toBeCloseTo(b.w, 9);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("rotation geometry", () => {
  const rect = { x: 100, y: 200, w: 60, h: 40 };
  const centre = { x: 130, y: 220 };

  it("turns the box the SAME way the renderer does", () => {
    // The direction is the whole ballgame: a sign flip still draws a tidy rotated outline,
    // just mirrored off the picture. The shader spins by (cos*dx - sin*dy, sin*dx + cos*dy)
    // in screen space, so a positive angle sends the TOP-LEFT corner to the RIGHT and DOWN.
    const c = rotatedCorners(rect, Math.PI / 2);
    expect(c.tl.x).toBeCloseTo(150, 6);
    expect(c.tl.y).toBeCloseTo(190, 6);
    expect(c.tr.x).toBeCloseTo(150, 6);
    expect(c.tr.y).toBeCloseTo(250, 6);
  });

  it("leaves an upright box exactly where it was", () => {
    expect(rotatedCorners(rect, 0)).toEqual({
      tl: { x: 100, y: 200 },
      tr: { x: 160, y: 200 },
      bl: { x: 100, y: 240 },
      br: { x: 160, y: 240 },
    });
  });

  it("keeps every corner the same distance from the centre, at any angle (property)", () => {
    // Rotation is rigid. A version that scaled or skewed would still look plausible on a
    // screenshot; this cannot pass unless the transform is a real rotation.
    const dist = (p: { x: number; y: number }) => Math.hypot(p.x - centre.x, p.y - centre.y);
    const before = Object.values(rotatedCorners(rect, 0)).map(dist);
    fc.assert(
      fc.property(fc.double({ min: -10, max: 10, noNaN: true }), (rad) => {
        const after = Object.values(rotatedCorners(rect, rad)).map(dist);
        after.forEach((d, i) => expect(d).toBeCloseTo(before[i], 9));
      }),
    );
  });

  it("puts the rotate knob above the top edge, and carries it around with the box", () => {
    expect(rotationHandlePoint(rect, 0, 24)).toEqual({ x: 130, y: 176 });
    const turned = rotationHandlePoint(rect, Math.PI / 2, 24);
    expect(turned.x).toBeCloseTo(174, 6); // a quarter turn puts "up" to the right
    expect(turned.y).toBeCloseTo(220, 6);
  });

  it("reads a pointer angle clockwise from straight up", () => {
    expect(angleFromCentre(centre, { x: centre.x, y: centre.y - 50 })).toBeCloseTo(0, 6);
    expect(angleFromCentre(centre, { x: centre.x + 50, y: centre.y })).toBeCloseTo(90, 6);
    expect(angleFromCentre(centre, { x: centre.x, y: centre.y + 50 })).toBeCloseTo(180, 6);
    expect(angleFromCentre(centre, { x: centre.x - 50, y: centre.y })).toBeCloseTo(-90, 6);
  });

  it("the angle it reads is the angle that draws that corner (round trip, property)", () => {
    // The two halves of the gesture — pointer -> degrees, degrees -> corners — have to be
    // inverses, or the picture lags the cursor by a constant.
    fc.assert(
      fc.property(fc.double({ min: -179, max: 180, noNaN: true }), (deg) => {
        const rad = (deg * Math.PI) / 180;
        const knob = rotationHandlePoint(rect, rad, 24);
        expect(angleFromCentre(centre, knob)).toBeCloseTo(deg, 6);
      }),
    );
  });

  it("snaps near a stop and stays continuous away from one", () => {
    expect(snapDegrees(43, 15, 5)).toBe(45);
    expect(snapDegrees(88, 15, 5)).toBe(90);
    expect(snapDegrees(2, 15, 5)).toBe(0);
    expect(snapDegrees(37, 15, 5)).toBe(37); // 8 degrees off 45 — left alone
    expect(snapDegrees(37, 15, 0)).toBe(37); // no tolerance, no snapping
    expect(snapDegrees(37, 0, 5)).toBe(37); // no step, no snapping
    expect(snapDegrees(37, -15, 5)).toBe(37); // ...and a nonsense step cannot invert it
    expect(snapDegrees(40, 15, 5)).toBe(45); // EXACTLY at the tolerance still snaps
    expect(snapDegrees(39.9, 15, 5)).toBe(39.9); // ...just outside does not
  });

  it("normalises the wrap point so no angle reads as -180", () => {
    // atan2 returns -180 for a pointer straight below the centre approached from the left;
    // leaving it there makes the same direction read as two different numbers.
    expect(angleFromCentre({ x: 0, y: 0 }, { x: -0, y: 1 })).toBe(180);
    expect(snapDegrees(-180, 15, 5)).toBe(-180); // the snap itself does not re-wrap
  });

  it("never moves an angle further than the tolerance (property)", () => {
    // A snap that could yank the clip a long way would be a worse gesture than none.
    fc.assert(
      fc.property(fc.double({ min: -720, max: 720, noNaN: true }), (deg) => {
        expect(Math.abs(snapDegrees(deg, 15, 5) - deg)).toBeLessThanOrEqual(5 + 1e-9);
      }),
    );
  });
});
