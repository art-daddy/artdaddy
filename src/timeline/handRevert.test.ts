// A hand edit "puts back" an agent's change only when the clip is the way it was before the agent touched it. These check
// that rule from both sides: a real revert is always seen (whatever order the keys were written in, on whichever track),
// and an ordinary edit, an untouched clip or a clip the agent removed is never taken for one.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { canonical, clipChanges, clipStates, clipsPutBack } from "./handRevert";
import type { Clip, Timeline } from "./model";

const clip = (id: string, over: Partial<Clip> = {}): Clip => ({
  id,
  kind: "video",
  media_ref: `media_${id}`,
  timeline_in: 0,
  timeline_out: 30,
  source_in: 0,
  source_out: 30,
  ...over,
});
const timeline = (tracks: Record<string, Clip[]>): Timeline => ({
  units: "frames",
  canvas: { width: 1920, height: 1080, fps: 30 },
  tracks: Object.entries(tracks).map(([id, clips], z) => ({ id, kind: "video", z, clips })),
});
/** Did the hand edit from `handBefore` to `handAfter` put back a clip of the agent's edit from `before` to `after`? */
const putBack = (before: Timeline, after: Timeline, handBefore: Timeline, handAfter: Timeline) =>
  clipsPutBack(clipChanges(before, after), clipStates(handBefore), clipStates(handAfter));

describe("a hand edit that puts the agent's change back", () => {
  const t0 = timeline({ v1: [clip("a"), clip("b", { timeline_in: 40, timeline_out: 70 })] });
  const moved = timeline({
    v1: [
      clip("a", { timeline_in: 100, timeline_out: 130 }),
      clip("b", { timeline_in: 40, timeline_out: 70 }),
    ],
  });

  it("is seen when the clip the agent moved is moved back exactly", () => {
    expect(putBack(t0, moved, moved, t0)).toEqual(["a"]);
  });

  it("is seen when only the fields the agent changed are back, whatever else the hand edit changed on the clip", () => {
    const back = timeline({
      v1: [clip("a", { opacity: 0.5 }), clip("b", { timeline_in: 40, timeline_out: 70 })],
    });
    expect(putBack(t0, moved, moved, back)).toEqual(["a"]);
  });

  it("is not seen when the clip is moved somewhere else, or only part of the way back", () => {
    const elsewhere = timeline({
      v1: [
        clip("a", { timeline_in: 200, timeline_out: 230 }),
        clip("b", { timeline_in: 40, timeline_out: 70 }),
      ],
    });
    const halfway = timeline({
      v1: [
        clip("a", { timeline_in: 0, timeline_out: 130 }),
        clip("b", { timeline_in: 40, timeline_out: 70 }),
      ],
    });
    expect(putBack(t0, moved, moved, elsewhere)).toEqual([]);
    expect(putBack(t0, moved, moved, halfway)).toEqual([]);
  });

  it("is not seen when the hand edit leaves that clip alone, even though the clip is still the way it was", () => {
    // The agent moved `a`; the person then trims `b`. `a` is not put back: it was never touched.
    const trimmed = timeline({
      v1: [
        clip("a", { timeline_in: 100, timeline_out: 130 }),
        clip("b", { timeline_in: 40, timeline_out: 60 }),
      ],
    });
    expect(putBack(t0, moved, moved, trimmed)).toEqual([]);
    // ...and a clip the agent never changed is never counted, whatever the hand does to it.
    expect(
      putBack(
        t0,
        moved,
        moved,
        timeline({ v1: [clip("a", { timeline_in: 100, timeline_out: 130 })] }),
      ),
    ).toEqual([]);
  });

  it("is seen when a clip the agent made is removed by hand, and not when another clip is", () => {
    const added = timeline({
      v1: [
        clip("a"),
        clip("b", { timeline_in: 40, timeline_out: 70 }),
        clip("new", { timeline_in: 80, timeline_out: 90 }),
      ],
    });
    expect(putBack(t0, added, added, t0)).toEqual(["new"]);
    const otherGone = timeline({
      v1: [clip("a"), clip("new", { timeline_in: 80, timeline_out: 90 })],
    });
    expect(putBack(t0, added, added, otherGone)).toEqual([]);
  });

  it("never counts a clip the agent removed: a clip made again by hand is a new clip", () => {
    const removed = timeline({ v1: [clip("b", { timeline_in: 40, timeline_out: 70 })] });
    expect(clipChanges(t0, removed).has("a")).toBe(false);
    expect(putBack(t0, removed, removed, t0)).toEqual([]);
  });

  it("counts the track a clip sits on: moved back to its own track is put back, to a third one is not", () => {
    const start = timeline({ v1: [clip("a")], v2: [] });
    const onV2 = timeline({ v1: [], v2: [clip("a")] });
    const onV3 = timeline({ v1: [], v2: [], v3: [clip("a")] });
    expect(putBack(start, onV2, onV2, start)).toEqual(["a"]);
    expect(putBack(start, onV2, onV2, onV3)).toEqual([]);
  });

  it("reads nested values whole: an effect set back to its old values is put back, whatever its key order", () => {
    const plain = timeline({
      v1: [clip("a", { effects: [{ type: "blur", amount: 2, radius: 1 }] })],
    });
    const blurred = timeline({
      v1: [clip("a", { effects: [{ type: "blur", amount: 9, radius: 1 }] })],
    });
    const reordered = timeline({
      v1: [clip("a", { effects: [{ radius: 1, amount: 2, type: "blur" }] })],
    });
    expect(putBack(plain, blurred, blurred, reordered)).toEqual(["a"]);
  });
});

// ---- properties over random timelines -----------------------------------------------------------------------------

const ids = ["a", "b", "c", "d", "e"];
const arbClip = (id: string) =>
  fc
    .record({
      timeline_in: fc.integer({ min: 0, max: 50 }),
      length: fc.integer({ min: 1, max: 40 }),
      opacity: fc.option(fc.constantFrom(0.25, 0.5, 1), { nil: undefined }),
      effects: fc.option(
        fc.array(
          fc.record({
            type: fc.constantFrom("blur", "glow"),
            amount: fc.integer({ min: 0, max: 9 }),
          }),
          { maxLength: 2 },
        ),
        {
          nil: undefined,
        },
      ),
    })
    .map(({ timeline_in, length, opacity, effects }) =>
      clip(id, {
        timeline_in,
        timeline_out: timeline_in + length,
        ...(opacity === undefined ? {} : { opacity }),
        ...(effects === undefined ? {} : { effects }),
      }),
    );
/** A timeline of up to two tracks holding any subset of the clip ids. */
const arbTimeline = fc
  .tuple(
    ...ids.map((id) =>
      fc.tuple(fc.constantFrom<"skip" | "v1" | "v2">("skip", "v1", "v2"), arbClip(id)),
    ),
  )
  .map((placed) => {
    const tracks: Record<string, Clip[]> = { v1: [], v2: [] };
    for (const [where, c] of placed) if (where !== "skip") tracks[where].push(c);
    return timeline(tracks);
  });

describe("properties", () => {
  it("an exact revert puts back every clip the agent changed or made, and nothing it did not", () => {
    fc.assert(
      fc.property(arbTimeline, arbTimeline, (before, after) => {
        const change = clipChanges(before, after);
        const back = clipsPutBack(change, clipStates(after), clipStates(before));
        expect(new Set(back)).toEqual(new Set(change.keys()));
      }),
    );
  });

  it("a hand edit that changes nothing never puts anything back", () => {
    fc.assert(
      fc.property(arbTimeline, arbTimeline, arbTimeline, (before, after, now) => {
        const states = clipStates(now);
        expect(clipsPutBack(clipChanges(before, after), states, states)).toEqual([]);
      }),
    );
  });

  it("an agent edit that changes nothing has nothing to put back", () => {
    fc.assert(
      fc.property(arbTimeline, arbTimeline, (t, hand) => {
        expect(clipChanges(t, t).size).toBe(0);
        expect(clipsPutBack(clipChanges(t, t), clipStates(t), clipStates(hand))).toEqual([]);
      }),
    );
  });

  it("whatever it reports was touched by the hand edit and is back to its value from before the agent's edit", () => {
    const text = (state: ReadonlyMap<string, string> | undefined) =>
      state ? canonical(Object.fromEntries(state)) : "absent";
    fc.assert(
      fc.property(arbTimeline, arbTimeline, arbTimeline, (before, after, hand) => {
        const change = clipChanges(before, after);
        const handBefore = clipStates(after);
        const handAfter = clipStates(hand);
        for (const id of clipsPutBack(change, handBefore, handAfter)) {
          const made = change.get(id)!;
          expect(text(handBefore.get(id))).not.toBe(text(handAfter.get(id)));
          if (made.before === null) expect(handAfter.has(id)).toBe(false);
          else
            for (const field of made.fields)
              expect(handAfter.get(id)?.get(field)).toBe(made.before.get(field));
        }
      }),
    );
  });

  it("canonical text does not depend on the order an object's keys were written in", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ maxLength: 4 }), fc.jsonValue({ maxDepth: 2 })),
        (object) => {
          const reversed = Object.fromEntries(Object.entries(object).reverse());
          expect(canonical(reversed)).toBe(canonical(object));
          expect(JSON.parse(canonical(object)!)).toEqual(JSON.parse(JSON.stringify(object)));
        },
      ),
    );
  });
});
