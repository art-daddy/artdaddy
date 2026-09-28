import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { addTextClips } from "./operations";
import type { Timeline } from "./model";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// add_text_clips against the placement rules the owner set (2026-09-27), over random timelines
// and batches. The oracle is the RULE, not the code:
//   - entries sharing a track (the same track_id, or all the auto-placed ones) must not overlap
//     each other -> refuse;
//   - a NAMED track with existing text where an entry goes -> refuse;
//   - otherwise it must succeed. A guard that refuses legitimate input is a regression too.
// On success no track may hold overlapping clips, which is the property the renderer depends
// on and the one the old code broke.
//
// NOT asserted here: "a refusal leaves the timeline untouched". At this layer it does not — a
// named track that did not exist is created while an earlier batch resolves, then a later batch
// is refused (fast-check found it on its 4th run). That guarantee belongs to applyOp, which
// mutates a COPY and discards it on refusal; it is proven at that boundary, against the saved
// document, in textTrackRefusal.test.ts.

const TRACK_IDS = ["captions", "titles", "captions2"] as const;
const NAMES = [undefined, "captions", "titles", "captions2", "lower_thirds"] as const;

const disjointClips = (prefix: string) =>
  fc
    .uniqueArray(fc.integer({ min: 0, max: 14 }), { maxLength: 4 })
    .map((slots) =>
      slots
        .sort((a, b) => a - b)
        .map((s) => ({
          id: `${prefix}_${s}`,
          kind: "text",
          timeline_in: s * 20,
          timeline_out: s * 20 + 15,
          content: [{ text: "existing" }],
        })),
    );

const timelineArb = fc
  .subarray([...TRACK_IDS], { minLength: 0 })
  .chain((ids) => fc.tuple(fc.constant(ids), fc.tuple(...ids.map((id) => disjointClips(id)))))
  .map(
    ([ids, clipLists]) =>
      ({
        units: "frames",
        canvas: { width: 1920, height: 1080, fps: 30 },
        tracks: ids.map((id, i) => ({ id, kind: "text", z: i, clips: clipLists[i] })),
      }) as unknown as Timeline,
  );

const entryArb = fc
  .record({
    tin: fc.integer({ min: 0, max: 280 }),
    len: fc.integer({ min: 1, max: 60 }),
    track: fc.constantFrom(...NAMES),
  })
  .map(({ tin, len, track }) => ({
    content: "t",
    timeline_in: tin,
    timeline_out: tin + len,
    ...(track ? { track_id: track } : {}),
  }));

const overlap = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];

/** What the rules say should happen — computed from the rules, independently of the code. */
function expectedRefusal(tl: Timeline, entries: Any[]): boolean {
  const groups = new Map<string, Array<[number, number]>>();
  for (const e of entries) {
    const key = e.track_id ?? "\u0000auto";
    groups.set(key, [...(groups.get(key) ?? []), [e.timeline_in, e.timeline_out]]);
  }
  for (const spans of groups.values()) {
    for (let i = 0; i < spans.length; i++) {
      for (let j = i + 1; j < spans.length; j++) if (overlap(spans[i], spans[j])) return true;
    }
  }
  for (const [key, spans] of groups) {
    const track = tl.tracks.find((t) => t.id === key);
    if (!track) continue;
    for (const c of track.clips ?? []) {
      const range: [number, number] = [c.timeline_in as number, c.timeline_out as number];
      if (spans.some((s) => overlap(s, range))) return true;
    }
  }
  return false;
}

function noTrackOverlaps(tl: Timeline): boolean {
  for (const t of tl.tracks) {
    const spans = (t.clips ?? [])
      .map((c) => [c.timeline_in as number, c.timeline_out as number] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1]) return false;
  }
  return true;
}

describe("add_text_clips: placement rules over random timelines and batches", () => {
  it("refuses exactly the batches the rules refuse", () => {
    fc.assert(
      fc.property(timelineArb, fc.array(entryArb, { minLength: 1, maxLength: 6 }), (tl, entries) => {
        let threw = false;
        try {
          addTextClips(structuredClone(tl), entries);
        } catch {
          threw = true;
        }
        expect(threw, "refused iff the rules say so").toBe(expectedRefusal(tl, entries));
      }),
      { numRuns: 600 },
    );
  });

  it("never leaves two clips overlapping on one track", () => {
    fc.assert(
      fc.property(timelineArb, fc.array(entryArb, { minLength: 1, maxLength: 6 }), (tl, entries) => {
        fc.pre(!expectedRefusal(tl, entries));
        const work = structuredClone(tl);
        addTextClips(work, entries);
        expect(noTrackOverlaps(work)).toBe(true);
      }),
      { numRuns: 600 },
    );
  });

  it("lands every entry once, named ones on their track, the rest together on one other track", () => {
    fc.assert(
      fc.property(timelineArb, fc.array(entryArb, { minLength: 1, maxLength: 6 }), (tl, entries) => {
        fc.pre(!expectedRefusal(tl, entries));
        const work = structuredClone(tl);
        const r = addTextClips(work, entries) as Any;
        expect(r.created).toHaveLength(entries.length);

        const trackOf = new Map<string, string>();
        for (const t of work.tracks) for (const c of t.clips ?? []) trackOf.set(String(c.id), t.id);
        const autoTracks = new Set<string>();
        entries.forEach((e: Any, i: number) => {
          const landed = trackOf.get(r.created[i].clip_id);
          expect(landed).toBe(r.created[i].track_id);
          if (e.track_id) expect(landed).toBe(e.track_id);
          else autoTracks.add(landed!);
        });
        expect(autoTracks.size).toBeLessThanOrEqual(1);
        const named = new Set(entries.map((e: Any) => e.track_id).filter(Boolean));
        for (const id of autoTracks) expect(named.has(id)).toBe(false);
      }),
      { numRuns: 600 },
    );
  });

  it("never disturbs text that was already there", () => {
    fc.assert(
      fc.property(timelineArb, fc.array(entryArb, { minLength: 1, maxLength: 6 }), (tl, entries) => {
        fc.pre(!expectedRefusal(tl, entries));
        const work = structuredClone(tl);
        addTextClips(work, entries);
        for (const t of tl.tracks) {
          const after = work.tracks.find((w) => w.id === t.id)!;
          for (const c of t.clips ?? []) expect(after.clips).toContainEqual(c);
        }
      }),
      { numRuns: 400 },
    );
  });

  // Creating a track while an existing one had room would multiply tracks over a session.
  it("only creates a track for auto-placed text when no existing text track had room", () => {
    fc.assert(
      fc.property(timelineArb, fc.array(entryArb, { minLength: 1, maxLength: 6 }), (tl, entries) => {
        fc.pre(!expectedRefusal(tl, entries));
        const auto = entries.filter((e: Any) => !e.track_id);
        fc.pre(auto.length > 0);
        const work = structuredClone(tl);
        const r = addTextClips(work, entries) as Any;
        const autoTrack = r.created[entries.indexOf(auto[0])].track_id;
        if (tl.tracks.some((t) => t.id === autoTrack)) return;
        const named = new Set(entries.map((e: Any) => e.track_id).filter(Boolean));
        const couldFit = tl.tracks.filter(
          (t) =>
            !named.has(t.id) &&
            !auto.some((e: Any) =>
              (t.clips ?? []).some((c) =>
                overlap(
                  [e.timeline_in, e.timeline_out],
                  [c.timeline_in as number, c.timeline_out as number],
                ),
              ),
            ),
        );
        expect(couldFit.map((t) => t.id)).toEqual([]);
      }),
      { numRuns: 600 },
    );
  });
});
