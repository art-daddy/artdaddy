// Property + example tests for move snapping by EITHER edge.
//
// The rule this file defends: a clip being dragged may snap by its head OR its
// tail, whichever lands closer, and a snap must never invent a position the user
// didn't aim at. The head-only behaviour that shipped before made it impossible to
// close a gap from the left — the clip's end would stop one frame short of the
// neighbour and no amount of nudging would seat it.
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { snapMoveIn } from "./geometry";

const FPS = 30;
const ZOOM = 40; // px per second -> 1.333 px per frame
const THRESH = 8; // SNAP_PX in TimelineEditor
const pxPerFrame = ZOOM / FPS;

describe("snapMoveIn — the tail snaps too", () => {
  it("seats the TAIL against a neighbour when the head has nothing near it", () => {
    // Clip is 30 frames; a neighbour starts at 200. Dropped so the tail lands at
    // 197 — 3 frames (4px) short. Head-only snapping leaves it stranded there.
    const got = snapMoveIn(167, 30, [0, 200], FPS, ZOOM, THRESH);
    expect(got).toBe(170); // tail now exactly on 200
    expect(got + 30).toBe(200);
  });

  it("still snaps by the HEAD when that is the closer edge", () => {
    const got = snapMoveIn(97, 30, [100, 500], FPS, ZOOM, THRESH);
    expect(got).toBe(100);
  });

  it("prefers whichever edge moves LESS when both could snap", () => {
    // head 2 frames from 100, tail 5 frames from 135 -> head wins.
    expect(snapMoveIn(98, 30, [100, 133], FPS, ZOOM, THRESH)).toBe(100);
    // head 5 frames from 100, tail 1 frame from 136 -> tail wins (in = 106).
    expect(snapMoveIn(105, 30, [100, 136], FPS, ZOOM, THRESH)).toBe(106);
  });

  it("leaves the position alone when neither edge is within the threshold", () => {
    const far = snapMoveIn(300, 30, [0, 1000], FPS, ZOOM, THRESH);
    expect(far).toBe(300);
  });

  it("REJECTS a tail snap that would push the clip before frame 0", () => {
    // 30-frame clip dropped at 0; a target at 26 is 4 frames from its tail, well
    // inside the threshold — but seating it there implies in = -4. Clamping to 0
    // would land the clip somewhere the user never aimed, so the drop stands.
    expect(snapMoveIn(0, 30, [26], FPS, ZOOM, THRESH)).toBe(0);
    // ...and the head still wins when it has a target of its own.
    expect(snapMoveIn(2, 30, [0, 26], FPS, ZOOM, THRESH)).toBe(0);
  });

  it("ALLOWS a tail snap that lands the clip exactly at frame 0", () => {
    // 30-frame clip, neighbour starts at 30: dragging left so the tail meets it
    // seats the clip at exactly 0. Frame 0 is a legal start — only NEGATIVE
    // starts are rejected, and an off-by-one there would make the first slot on
    // the timeline the one place a tail snap refuses to work.
    expect(snapMoveIn(2, 30, [30], FPS, ZOOM, THRESH)).toBe(0);
  });

  it("breaks an exact tie in favour of the HEAD", () => {
    // head is 2 frames from 98, tail is 2 frames from 112 — equal pull. The head
    // wins, because that is the edge the user reads as the clip's position.
    expect(snapMoveIn(100, 10, [98, 112], FPS, ZOOM, THRESH)).toBe(98);
  });

  it("does NOT drag a clip off an alignment it already has", () => {
    // Tail sits EXACTLY on 5 (in=1, len=4) while the head is 1 frame from 0.
    // Scoring "snapped" by displacement would call the perfect tail alignment
    // "no snap" and let the near head yank the clip to 0.
    expect(snapMoveIn(1, 4, [0, 5], FPS, ZOOM, THRESH)).toBe(1);
  });

  it("never returns a negative start", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -500, max: 500 }),
        fc.integer({ min: 1, max: 300 }),
        fc.array(fc.integer({ min: 0, max: 1000 }), { maxLength: 8 }),
        (rawIn, len, targets) => {
          expect(snapMoveIn(rawIn, len, targets, FPS, ZOOM, THRESH)).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("snapMoveIn invariants", () => {
  const args = fc.tuple(
    fc.integer({ min: 0, max: 800 }),
    fc.integer({ min: 1, max: 200 }),
    fc.array(fc.integer({ min: 0, max: 1000 }), { maxLength: 10 }),
  );

  it("the result is the raw drop, or puts one edge exactly on a target", () => {
    fc.assert(
      fc.property(args, ([rawIn, len, targets]) => {
        const got = snapMoveIn(rawIn, len, targets, FPS, ZOOM, THRESH);
        if (got === Math.max(0, rawIn)) return; // no snap
        expect(targets.includes(got) || targets.includes(got + len)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("never moves further than the threshold allows", () => {
    fc.assert(
      fc.property(args, ([rawIn, len, targets]) => {
        const raw = Math.max(0, rawIn);
        const got = snapMoveIn(raw, len, targets, FPS, ZOOM, THRESH);
        expect(Math.abs(got - raw) * pxPerFrame).toBeLessThanOrEqual(THRESH + 1e-9);
      }),
      { numRuns: 500 },
    );
  });

  it("returns a whole frame — never a fractional position", () => {
    fc.assert(
      fc.property(args, ([rawIn, len, targets]) => {
        const got = snapMoveIn(rawIn, len, targets, FPS, ZOOM, THRESH);
        expect(Number.isInteger(got)).toBe(true);
        expect(Number.isFinite(got)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("is idempotent — re-snapping an already-snapped position changes nothing", () => {
    fc.assert(
      fc.property(args, ([rawIn, len, targets]) => {
        const once = snapMoveIn(rawIn, len, targets, FPS, ZOOM, THRESH);
        expect(snapMoveIn(once, len, targets, FPS, ZOOM, THRESH)).toBe(once);
      }),
      { numRuns: 500 },
    );
  });

  it("with no targets it is the identity (Alt-bypass parity)", () => {
    fc.assert(
      fc.property(args, ([rawIn, len]) => {
        expect(snapMoveIn(rawIn, len, [], FPS, ZOOM, THRESH)).toBe(Math.max(0, rawIn));
      }),
      { numRuns: 200 },
    );
  });

  it("a zero threshold only snaps an exact hit", () => {
    expect(snapMoveIn(99, 30, [100], FPS, ZOOM, 0)).toBe(99);
    expect(snapMoveIn(100, 30, [100], FPS, ZOOM, 0)).toBe(100);
    expect(snapMoveIn(70, 30, [100], FPS, ZOOM, 0)).toBe(70); // tail exactly on 100
  });
});
