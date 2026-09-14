// Property tests for the timeline view geometry (pixel ↔ frame mapping + snapping).
//
// The snap invariant is the one that matters and is the easiest to get subtly
// wrong: a snap may only ever return the candidate UNCHANGED or one of the
// declared targets. Anything else is a clip landing somewhere the user did not
// drop it and no edge highlighted to explain why.
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  frameToX,
  secToX,
  snapFrame,
  snapTargets,
  totalFrames,
  xToFrame,
  xToSec,
} from "./geometry";
import type { Timeline } from "./model";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const zoom = fc.double({ min: 1, max: 400, noNaN: true });
const scroll = fc.double({ min: 0, max: 20000, noNaN: true });
const fps = fc.constantFrom(24, 25, 30, 50, 60);

const timelineArb = fc
  .array(
    fc.record({
      id: fc.string({ minLength: 1, maxLength: 6 }),
      timeline_in: fc.integer({ min: 0, max: 5000 }),
      len: fc.integer({ min: 1, max: 600 }),
    }),
    { maxLength: 8 },
  )
  .map(
    (rows) =>
      ({
        units: "frames",
        canvas: { width: 1080, height: 1920, fps: 30 },
        tracks: [
          {
            id: "v1",
            kind: "video",
            z: 0,
            clips: rows.map((r, i) => ({
              id: `${r.id}${i}`,
              timeline_in: r.timeline_in,
              timeline_out: r.timeline_in + r.len,
            })),
          },
        ],
      }) as unknown as Timeline,
  );

describe("pixel ↔ time mapping round-trips", () => {
  it("seconds survive a trip through pixel space", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 3600, noNaN: true }), zoom, scroll, (s, z, sx) => {
        expect(xToSec(secToX(s, z, sx), z, sx)).toBeCloseTo(s, 6);
      }),
      { numRuns: 400 },
    );
  });

  it("a whole frame survives a trip through pixel space exactly", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 200000 }), fps, zoom, scroll, (f, r, z, sx) => {
        expect(xToFrame(frameToX(f, r, z, sx), r, z, sx)).toBe(f);
      }),
      { numRuns: 400 },
    );
  });

  it("scrolling right moves content left by exactly the scroll amount", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 600, noNaN: true }), zoom, scroll, (s, z, sx) => {
        expect(secToX(s, z, sx)).toBeCloseTo(secToX(s, z, 0) - sx, 6);
      }),
      { numRuns: 300 },
    );
  });

  it("xToFrame always returns a whole frame", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e5, max: 1e5, noNaN: true }),
        fps,
        zoom,
        scroll,
        (x, r, z, sx) => {
          expect(Number.isInteger(xToFrame(x, r, z, sx))).toBe(true);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("snapTargets", () => {
  it("is sorted, de-duplicated, and always offers the timeline start", () => {
    fc.assert(
      fc.property(timelineArb, (tl) => {
        const t = snapTargets(tl);
        expect(t).toContain(0);
        expect([...t].sort((a, b) => a - b)).toEqual(t);
        expect(new Set(t).size).toBe(t.length);
      }),
      { numRuns: 300 },
    );
  });

  it("offers both edges of every clip", () => {
    fc.assert(
      fc.property(timelineArb, (tl) => {
        const t = new Set(snapTargets(tl));
        for (const c of (tl as Any).tracks[0].clips) {
          expect(t.has(c.timeline_in)).toBe(true);
          expect(t.has(c.timeline_out)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("EXCLUDES the dragged clip's own edges — a clip must not snap to itself", () => {
    fc.assert(
      fc.property(timelineArb, (tl) => {
        const clips = (tl as Any).tracks[0].clips;
        fc.pre(clips.length > 0);
        const me = clips[0];
        const others = clips.slice(1);
        const t = new Set(snapTargets(tl, { excludeIds: [me.id] }));
        const otherEdges = new Set<number>([0]);
        for (const c of others) {
          otherEdges.add(c.timeline_in);
          otherEdges.add(c.timeline_out);
        }
        // Its own edge may still appear if a DIFFERENT clip shares it.
        if (!otherEdges.has(me.timeline_in)) expect(t.has(me.timeline_in)).toBe(false);
        if (!otherEdges.has(me.timeline_out)) expect(t.has(me.timeline_out)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it("includes a finite playhead and ignores a non-finite one", () => {
    fc.assert(
      fc.property(timelineArb, fc.double({ min: 0, max: 5000, noNaN: true }), (tl, ph) => {
        expect(snapTargets(tl, { playheadFrame: ph })).toContain(Math.round(ph));
      }),
      { numRuns: 200 },
    );
    for (const bad of [NaN, Infinity, -Infinity]) {
      const t = snapTargets({ tracks: [] } as unknown as Timeline, { playheadFrame: bad });
      expect(t).toEqual([0]);
    }
  });

  it("survives a timeline with no tracks or no clips", () => {
    expect(snapTargets({} as Timeline)).toEqual([0]);
    expect(snapTargets({ tracks: [{ id: "v1", kind: "video", z: 0 }] } as Any)).toEqual([0]);
  });
});

describe("snapFrame", () => {
  const targets = fc.array(fc.integer({ min: 0, max: 5000 }), { maxLength: 12 });

  it("returns the candidate unchanged OR one of the targets — never a third value", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: 6000 }),
        targets,
        fps,
        zoom,
        fc.double({ min: 0, max: 60, noNaN: true }),
        (cand, ts, r, z, thr) => {
          const got = snapFrame(cand, ts, r, z, thr);
          expect(got === cand || ts.includes(got)).toBe(true);
        },
      ),
      { numRuns: 600 },
    );
  });

  it("only snaps to something genuinely within the pixel threshold", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: 6000 }),
        targets,
        fps,
        zoom,
        fc.double({ min: 0, max: 60, noNaN: true }),
        (cand, ts, r, z, thr) => {
          const got = snapFrame(cand, ts, r, z, thr);
          if (got !== cand) {
            const distPx = Math.abs((got / r) * z - (cand / r) * z);
            expect(distPx).toBeLessThanOrEqual(thr + 1e-9);
          }
        },
      ),
      { numRuns: 600 },
    );
  });

  it("never moves when there are no targets", () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fps,
        zoom,
        fc.double({ min: 0, max: 100, noNaN: true }),
        (c, r, z, thr) => {
          expect(snapFrame(c, [], r, z, thr)).toBe(c);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("snaps to an exact target even with a zero threshold", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5000 }), fps, zoom, (t, r, z) => {
        expect(snapFrame(t, [t], r, z, 0)).toBe(t);
      }),
      { numRuns: 300 },
    );
  });

  it("is idempotent — snapping an already-snapped frame changes nothing", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: 6000 }),
        targets,
        fps,
        zoom,
        fc.double({ min: 0, max: 60, noNaN: true }),
        (cand, ts, r, z, thr) => {
          const once = snapFrame(cand, ts, r, z, thr);
          expect(snapFrame(once, ts, r, z, thr)).toBe(once);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("totalFrames", () => {
  it("is the maximum clip end and never below any clip", () => {
    fc.assert(
      fc.property(timelineArb, (tl) => {
        const total = totalFrames(tl);
        const ends = (tl as Any).tracks[0].clips.map((c: Any) => c.timeline_out);
        for (const e of ends) expect(total).toBeGreaterThanOrEqual(e);
        expect(total).toBe(ends.length ? Math.max(...ends) : 0);
      }),
      { numRuns: 300 },
    );
  });

  it("is 0 for an empty or malformed timeline rather than -Infinity", () => {
    expect(totalFrames({} as Timeline)).toBe(0);
    expect(totalFrames({ tracks: [] } as unknown as Timeline)).toBe(0);
    expect(totalFrames({ tracks: [{ id: "v", kind: "video", z: 0, clips: [] }] } as Any)).toBe(0);
  });
});
