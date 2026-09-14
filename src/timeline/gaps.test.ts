// Property tests over the gap resolver's invariants. A new pure module gets rules that survive a
// rewrite, not a handful of examples that echo the loop.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { gapAt, gapsOn } from "./gaps";
import type { Timeline, Track } from "./model";

const track = (spans: Array<[number, number]>, extra: Partial<Track> = {}): Track =>
  ({
    id: "v1",
    kind: "video",
    z: 0,
    clips: spans.map(([a, b], i) => ({ id: `c${i}`, timeline_in: a, timeline_out: b })),
    ...extra,
  }) as Track;

const timeline = (t: Track): Timeline =>
  ({ units: "frames", canvas: { width: 1080, height: 1920, fps: 30 }, tracks: [t] }) as Timeline;

/** Non-overlapping clips in timeline order, with gaps of arbitrary (possibly zero) size. */
const arbTrack = fc
  .array(
    fc.record({ gap: fc.integer({ min: 0, max: 50 }), len: fc.integer({ min: 1, max: 50 }) }),
    {
      minLength: 1,
      maxLength: 8,
    },
  )
  .map((items) => {
    const spans: Array<[number, number]> = [];
    let cursor = 0;
    for (const { gap, len } of items) {
      cursor += gap;
      spans.push([cursor, cursor + len]);
      cursor += len;
    }
    return spans;
  });

describe("gapsOn", () => {
  it("never overlaps a clip", () => {
    fc.assert(
      fc.property(arbTrack, (spans) => {
        for (const g of gapsOn(track(spans)))
          for (const [a, b] of spans) expect(g.start >= b || g.end <= a).toBe(true);
      }),
    );
  });

  it("every gap is bounded on the right by a clip that starts exactly there", () => {
    // This is the rule that makes trailing space not a gap: there is nothing to close.
    fc.assert(
      fc.property(arbTrack, (spans) => {
        for (const g of gapsOn(track(spans))) expect(spans.some(([a]) => a === g.end)).toBe(true);
      }),
    );
  });

  it("gaps are non-empty, ordered, and disjoint", () => {
    fc.assert(
      fc.property(arbTrack, (spans) => {
        const gaps = gapsOn(track(spans));
        for (const g of gaps) expect(g.end).toBeGreaterThan(g.start);
        for (let i = 1; i < gaps.length; i++)
          expect(gaps[i].start).toBeGreaterThanOrEqual(gaps[i - 1].end);
      }),
    );
  });

  it("a track whose clips tile from 0 has no gaps at all", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 8 }),
        (lens) => {
          const spans: Array<[number, number]> = [];
          let cursor = 0;
          for (const len of lens) {
            spans.push([cursor, cursor + len]);
            cursor += len;
          }
          expect(gapsOn(track(spans))).toEqual([]);
        },
      ),
    );
  });

  it("overlapping clips do not manufacture a gap", () => {
    // Overlap is illegal but representable; the walk must take the furthest end, not the last.
    expect(
      gapsOn(
        track([
          [0, 100],
          [10, 40],
          [120, 160],
        ]),
      ),
    ).toEqual([{ start: 100, end: 120 }]);
  });

  it("a zero-length clip inside a gap does not cut the gap in two", () => {
    // A degenerate span is not material. Counting it would report two holes where the user
    // sees one, and Delete would then close only half of it.
    expect(
      gapsOn(
        track([
          [0, 60],
          [80, 80],
          [100, 160],
        ]),
      ),
    ).toEqual([{ start: 60, end: 100 }]);
  });

  it("reads the same however the clips are ORDERED in the array", () => {
    // `moveClips` pushes the clip it moved onto the end, so out-of-order clips are the normal
    // case here, not an exotic one.
    const inOrder: Array<[number, number]> = [
      [0, 60],
      [100, 160],
      [200, 260],
    ];
    const shuffled: Array<[number, number]> = [
      [200, 260],
      [0, 60],
      [100, 160],
    ];
    expect(gapsOn(track(shuffled))).toEqual(gapsOn(track(inOrder)));
    expect(gapsOn(track(shuffled))).toEqual([
      { start: 60, end: 100 },
      { start: 160, end: 200 },
    ]);
  });

  it("a zero-length clip inside a gap does not cut the gap in two", () => {
    // A degenerate span is not material. Treating it as material would report two gaps where
    // the user sees one hole, and Delete would then close only half of it.
    expect(
      gapsOn(
        track([
          [0, 60],
          [80, 80],
          [100, 160],
        ]),
      ),
    ).toEqual([{ start: 60, end: 100 }]);
  });

  it("reads the same however the clips are ORDERED in the array", () => {
    // `moveClips` pushes the clip it moved onto the end, so this is the normal case, not an
    // exotic one. Without the sort, a moved clip reports gaps that are not there.
    const inOrder: Array<[number, number]> = [
      [0, 60],
      [100, 160],
      [200, 260],
    ];
    const shuffled: Array<[number, number]> = [
      [200, 260],
      [0, 60],
      [100, 160],
    ];
    expect(gapsOn(track(shuffled))).toEqual(gapsOn(track(inOrder)));
    expect(gapsOn(track(shuffled))).toEqual([
      { start: 60, end: 100 },
      { start: 160, end: 200 },
    ]);
  });
});

describe("gapAt", () => {
  it("resolves a frame inside a gap and nothing outside one", () => {
    const tl = timeline(
      track([
        [0, 60],
        [100, 160],
      ]),
    );
    expect(gapAt(tl, "v1", 60)).toEqual({ trackId: "v1", start: 60, end: 100 });
    expect(gapAt(tl, "v1", 99)).toEqual({ trackId: "v1", start: 60, end: 100 });
    expect(gapAt(tl, "v1", 100)).toBeNull(); // the gap is half-open — 100 is the clip
    expect(gapAt(tl, "v1", 30)).toBeNull(); // inside the first clip
    expect(gapAt(tl, "v1", 200)).toBeNull(); // trailing space is not a gap
  });

  it("finds the space before the first clip", () => {
    expect(gapAt(timeline(track([[40, 100]])), "v1", 10)).toEqual({
      trackId: "v1",
      start: 0,
      end: 40,
    });
  });

  it("refuses a LOCKED track, because the ripple behind Delete would refuse it too", () => {
    const spans: Array<[number, number]> = [
      [0, 60],
      [100, 160],
    ];
    expect(gapAt(timeline(track(spans)), "v1", 70)).not.toBeNull();
    expect(gapAt(timeline(track(spans, { locked: true })), "v1", 70)).toBeNull();
  });

  it("is null for an unknown track or no timeline", () => {
    expect(gapAt(timeline(track([[0, 60]])), "nope", 70)).toBeNull();
    expect(gapAt(null, "v1", 70)).toBeNull();
    expect(gapAt({ tracks: [] } as unknown as Timeline, "v1", 70)).toBeNull();
  });

  it("reads the gap on the track it was ASKED for, not the first one", () => {
    // Two tracks whose holes do not overlap: asking v2 must never answer with v1's gap.
    const tl = {
      units: "frames",
      canvas: { width: 1080, height: 1920, fps: 30 },
      tracks: [
        track(
          [
            [0, 60],
            [100, 160],
          ],
          { id: "v1" },
        ),
        track(
          [
            [0, 200],
            [300, 360],
          ],
          { id: "v2" },
        ),
      ],
    } as Timeline;
    expect(gapAt(tl, "v1", 70)).toEqual({ trackId: "v1", start: 60, end: 100 });
    expect(gapAt(tl, "v2", 70)).toBeNull(); // frame 70 is inside v2's first clip
    expect(gapAt(tl, "v2", 250)).toEqual({ trackId: "v2", start: 200, end: 300 });
    expect(gapAt(tl, "v1", 250)).toBeNull(); // ...and that gap is not v1's
  });
});
