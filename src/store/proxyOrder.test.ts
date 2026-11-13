// Which clip's preview copy the person is waiting for (UJ-091). Pure, so: properties over any timeline.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { Timeline } from "../timeline/model";
import { focusRef, frameAt } from "./proxyOrder";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const clip = (ref: string | undefined, at: number, len = 60, kind = "video") =>
  ({ id: `c-${ref}-${at}`, kind, media_ref: ref, timeline_in: at, timeline_out: at + len }) as Any;
const timeline = (...tracks: Any[][]): Timeline =>
  ({
    canvas: { width: 1, height: 1, fps: 30 },
    tracks: tracks.map((clips, i) => ({ id: `t${i}`, clips })),
  }) as Any;

describe("focusRef", () => {
  it("is the clip under the playhead, and a clip ending at the playhead does not count", () => {
    const t = timeline([clip("a", 0), clip("b", 60), clip("c", 120)]);
    expect(focusRef(t, 0)).toBe("a");
    expect(focusRef(t, 59)).toBe("a");
    expect(focusRef(t, 60)).toBe("b"); // a ends at 60: half-open
    expect(focusRef(t, 150)).toBe("c");
  });

  it("past every clip, or before them all, it is the first clip ON THE TIMELINE, whatever the track order", () => {
    const t = timeline([clip("late", 500)], [clip("early", 10), clip("mid", 200)]);
    expect(focusRef(t, 9_999)).toBe("early");
    expect(focusRef(timeline([clip("late", 500), clip("early", 100)]), 0)).toBe("early");
  });

  it("never offers sound-only or text clips, a clip with no ref, or anything from an empty timeline", () => {
    const t = timeline([
      clip("song", 0, 100, "audio"),
      clip("title", 0, 100, "text"),
      clip(undefined, 0),
      clip("v", 300),
    ]);
    expect(focusRef(t, 10)).toBe("v"); // nothing drawable under the playhead: the first drawable on the timeline
    expect(focusRef(timeline([]), 0)).toBeNull();
    expect(focusRef(timeline([clip("song", 0, 100, "audio")]), 0)).toBeNull();
    expect(focusRef(null, 0)).toBeNull();
    expect(focusRef(undefined, 0)).toBeNull();
  });

  it("property: always a drawable ref that is on the timeline; a covering clip wins whenever one exists", () => {
    const spec = fc.record({
      ref: fc.constantFrom("a", "b", "c", "d", "e"),
      at: fc.integer({ min: 0, max: 600 }),
      len: fc.integer({ min: 1, max: 120 }),
      kind: fc.constantFrom("video", "image", "audio", "text"),
    });
    fc.assert(
      fc.property(
        fc.array(fc.array(spec, { maxLength: 6 }), { maxLength: 3 }),
        fc.integer({ min: 0, max: 800 }),
        (tracks, frame) => {
          const t = timeline(
            ...tracks.map((cs) => cs.map((c) => clip(c.ref, c.at, c.len, c.kind))),
          );
          const drawable = tracks.flat().filter((c) => c.kind !== "audio" && c.kind !== "text");
          const got = focusRef(t, frame);
          if (drawable.length === 0) {
            expect(got).toBeNull();
            return;
          }
          expect(drawable.map((c) => c.ref)).toContain(got);
          const covering = drawable.filter((c) => frame >= c.at && frame < c.at + c.len);
          if (covering.length) expect(covering.map((c) => c.ref)).toContain(got);
          else {
            const first = Math.min(...drawable.map((c) => c.at));
            expect(drawable.filter((c) => c.at === first).map((c) => c.ref)).toContain(got);
          }
        },
      ),
    );
  });
});

describe("frameAt", () => {
  it("counts the timeline's own frames, never negative, and falls back to 30 without a timeline", () => {
    expect(frameAt(timeline(), 2)).toBe(60);
    expect(frameAt(timeline(), -5)).toBe(0);
    expect(frameAt(null, 2)).toBe(60);
    expect(frameAt({ canvas: { width: 1, height: 1, fps: 24 }, tracks: [] } as Any, 2.5)).toBe(60);
  });
});
