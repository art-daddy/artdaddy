// The hand-editing modes of the timeline: trim to the playhead (Q / W), ripple trim (Shift+drag an
// edge), roll (drag a cut), slip (move the footage inside a clip), slide (move a clip between its
// neighbours), enable / disable (Shift+E) and nudge. Mutation testing (26 Nov) found NO test that ran
// any of the first six: every one of their planted bugs went unnoticed. Each case states what a person
// sees after the gesture: where each clip sits, how long it is, which footage plays in it, and what
// happened to the clips around it, on its own track and on the others.
import { describe, expect, it } from "vitest";

import { findClip } from "./helpers";
import { timelineInvariantViolations } from "./invariants";
import type { Timeline } from "./model";
import {
  linkClips,
  moveClips,
  nudgeClips,
  removeClips,
  rippleTrim,
  rollEdit,
  setClipEnabled,
  setTransition,
  slideClip,
  slipClip,
  splitClips,
  trimClips,
  trimToPlayhead,
  unlinkClips,
} from "./operations";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** A video clip on [tin, tout) showing its source from `sin`, at `speed`. */
const vid = (id: string, tin: number, tout: number, sin = 0, over: Any = {}): Any => {
  const speed = over.speed ?? 1;
  return {
    id,
    kind: "video",
    media_ref: `${id}.mp4`,
    timeline_in: tin,
    timeline_out: tout,
    source_in: sin,
    source_out: sin + Math.round((tout - tin) * speed),
    ...over,
  };
};
const aud = (id: string, tin: number, tout: number, sin = 0, over: Any = {}): Any =>
  vid(id, tin, tout, sin, { kind: "audio", media_ref: `${id}.mp3`, ...over });
const track = (id: string, kind: string, clips: Any[], over: Any = {}): Any => ({
  id,
  kind,
  z: 0,
  clips,
  ...over,
});
const tl = (...tracks: Any[]): Timeline =>
  ({ units: "frames", canvas: { width: 1920, height: 1080, fps: 30 }, tracks }) as Timeline;

const NO_LIMIT = new Map<string, number | null>();
const clipOf = (t: Timeline, id: string): Any => {
  const found = findClip(t, id);
  if (!found) throw new Error(`no clip ${id}`);
  return found[1];
};
/** Where a clip sits: [first frame, frame after the last]. */
const at = (t: Timeline, id: string): [number, number] => {
  const c = clipOf(t, id);
  return [c.timeline_in, c.timeline_out];
};
/** Which frames of its source a clip plays. */
const footage = (t: Timeline, id: string): [number, number] => {
  const c = clipOf(t, id);
  return [c.source_in, c.source_out];
};
/** The source frame a clip shows at timeline frame `f`. */
const shows = (t: Timeline, id: string, f: number): number => {
  const c = clipOf(t, id);
  return c.source_in + (f - c.timeline_in) * (c.speed ?? 1);
};
const snapshot = (t: Timeline): string => JSON.stringify(t);

/** Three abutting shots on V1, a sound bed on A1 aligned with the last one (sync-locked, the default)
 *  and a second bed on A2 that is NOT sync-locked. */
function threeShots(): Timeline {
  return tl(
    track("v1", "video", [vid("a", 0, 60, 0), vid("b", 60, 120, 200), vid("c", 120, 180, 300)]),
    track("a1", "audio", [aud("m", 120, 180, 0)]),
    track("a2", "audio", [aud("n", 120, 180, 0)], { sync_locked: false }),
  );
}

describe("trim to the playhead (Q / W)", () => {
  it("Q cuts the head off at the playhead, and every frame that stays keeps its picture", () => {
    const t = tl(track("v1", "video", [vid("a", 30, 90, 100)]));
    const before = shows(t, "a", 70);
    trimToPlayhead(t, "a", "head", 50, NO_LIMIT);
    expect(at(t, "a")).toEqual([50, 90]);
    expect(footage(t, "a")).toEqual([120, 160]);
    expect(shows(t, "a", 70)).toBe(before);
  });

  it("W cuts the tail off at the playhead, and the start keeps its picture", () => {
    const t = tl(track("v1", "video", [vid("a", 30, 90, 100)]));
    trimToPlayhead(t, "a", "tail", 70, NO_LIMIT);
    expect(at(t, "a")).toEqual([30, 70]);
    expect(footage(t, "a")).toEqual([100, 140]);
  });

  it("on a clip playing at 2x the footage moves twice as far as the edge", () => {
    const t = tl(track("v1", "video", [vid("a", 30, 90, 100, { speed: 2 })]));
    const picture = shows(t, "a", 70);
    trimToPlayhead(t, "a", "head", 50, NO_LIMIT);
    expect(at(t, "a")).toEqual([50, 90]);
    expect(shows(t, "a", 70)).toBe(picture);
    const u = tl(track("v1", "video", [vid("a", 30, 90, 100, { speed: 2 })]));
    trimToPlayhead(u, "a", "tail", 70, NO_LIMIT);
    expect(footage(u, "a")).toEqual([100, 180]);
  });

  it("takes the clip's own sound with it", () => {
    const t = tl(
      track("v1", "video", [vid("a", 30, 90, 100, { link_group: "g" })]),
      track("a1", "audio", [aud("s", 30, 90, 100, { media_ref: "a.mp4", link_group: "g" })]),
    );
    trimToPlayhead(t, "a", "head", 50, NO_LIMIT);
    expect(at(t, "s")).toEqual([50, 90]);
    expect(footage(t, "s")).toEqual(footage(t, "a"));
    trimToPlayhead(t, "a", "tail", 70, NO_LIMIT);
    expect(at(t, "s")).toEqual([50, 70]);
  });

  it("trims a still without inventing a source window for it", () => {
    const still = { id: "p", kind: "image", media_ref: "p.png", timeline_in: 30, timeline_out: 90 };
    const t = tl(track("v1", "video", [still]));
    trimToPlayhead(t, "p", "head", 50, NO_LIMIT);
    expect(at(t, "p")).toEqual([50, 90]);
    expect("source_in" in clipOf(t, "p")).toBe(false);
    trimToPlayhead(t, "p", "tail", 70, NO_LIMIT);
    expect(at(t, "p")).toEqual([50, 70]);
    expect("source_out" in clipOf(t, "p")).toBe(false);
  });

  it.each([
    ["on the clip's first frame", 30],
    ["on the frame after its last", 90],
    ["before the clip", 10],
    ["after the clip", 120],
  ])("does nothing with the playhead %s", (_where, frame) => {
    for (const edge of ["head", "tail"] as const) {
      const t = tl(track("v1", "video", [vid("a", 30, 90, 100)]));
      const before = snapshot(t);
      expect(() => trimToPlayhead(t, "a", edge, frame, NO_LIMIT)).toThrow(/not inside the clip/);
      expect(snapshot(t)).toBe(before);
    }
  });
});

describe("ripple trim (Shift+drag an edge)", () => {
  it("shortening a tail pulls everything after it in, on every sync-locked track, by exactly that much", () => {
    const t = threeShots();
    rippleTrim(t, "a", "tail", 40, NO_LIMIT);
    expect(at(t, "a")).toEqual([0, 40]);
    expect(footage(t, "a")).toEqual([0, 40]);
    expect(at(t, "b")).toEqual([40, 100]);
    expect(footage(t, "b")).toEqual([200, 260]);
    expect(at(t, "c")).toEqual([100, 160]);
    expect(at(t, "m")).toEqual([100, 160]);
    expect(at(t, "n")).toEqual([120, 180]); // its track is not sync-locked
    expect(timelineInvariantViolations(t)).toEqual([]);
  });

  it("lengthening a tail pushes everything after it out by exactly that much", () => {
    const t = threeShots();
    rippleTrim(t, "a", "tail", 80, NO_LIMIT);
    expect(at(t, "a")).toEqual([0, 80]);
    expect(footage(t, "a")).toEqual([0, 80]);
    expect(at(t, "b")).toEqual([80, 140]);
    expect(at(t, "c")).toEqual([140, 200]);
    expect(at(t, "m")).toEqual([140, 200]);
    expect(at(t, "n")).toEqual([120, 180]);
    expect(timelineInvariantViolations(t)).toEqual([]);
  });

  it("shortening a head keeps the clip where it starts, plays later footage, and pulls the rest in", () => {
    const t = threeShots();
    rippleTrim(t, "b", "head", 80, NO_LIMIT);
    expect(at(t, "a")).toEqual([0, 60]);
    expect(at(t, "b")).toEqual([60, 100]);
    expect(footage(t, "b")).toEqual([220, 260]);
    expect(at(t, "c")).toEqual([100, 160]);
    expect(at(t, "m")).toEqual([100, 160]);
    expect(at(t, "n")).toEqual([120, 180]);
    expect(timelineInvariantViolations(t)).toEqual([]);
  });

  it("reports how far the rest of the timeline moved, and on which track", () => {
    expect(rippleTrim(threeShots(), "a", "tail", 40, NO_LIMIT)).toEqual({
      rippled: -20,
      track: "v1",
    });
    expect(rippleTrim(threeShots(), "b", "head", 80, NO_LIMIT)).toEqual({
      rippled: -20,
      track: "v1",
    });
  });

  // KNOWN BUG (found 2026-11-28 by the testing catch-up; pre-existing). Remove `.fails` once fixed.
  // Dragging a head OUTWARD with ripple grows the clip by twice the drag and moves its start onto the
  // clip before it, so the edit is refused by validation (or, with a gap before the clip, lands 20
  // frames early and 40 frames long).
  it.fails(
    "lengthening a head keeps the clip where it starts, plays earlier footage, and pushes the rest out",
    () => {
      const t = threeShots();
      rippleTrim(t, "b", "head", 40, NO_LIMIT);
      expect(at(t, "a")).toEqual([0, 60]);
      expect(at(t, "b")).toEqual([60, 140]);
      expect(footage(t, "b")).toEqual([180, 260]);
      expect(at(t, "c")).toEqual([140, 200]);
      expect(timelineInvariantViolations(t)).toEqual([]);
    },
  );

  it.each([
    ["a tail to the clip's own start", "a", "tail", 0],
    ["a tail past the clip's start", "b", "tail", 50],
    ["a head to the clip's own end", "b", "head", 120],
    ["a head past the clip's end", "b", "head", 130],
  ] as const)("refuses %s: a ripple trim cannot consume the whole clip", (_what, id, edge, to) => {
    expect(() => rippleTrim(threeShots(), id, edge, to, NO_LIMIT)).toThrow(/whole clip/);
  });

  // KNOWN BUG (found 2026-11-28 by the testing catch-up; pre-existing). Remove `.fails` once fixed.
  // Lengthened past the end of its footage, the clip stops at its last frame but everything after it
  // has already been pushed out by the whole drag, so a gap opens.
  it.fails(
    "lengthening a tail past the end of the footage moves the rest only as far as the clip grew",
    () => {
      const t = threeShots();
      try {
        rippleTrim(t, "a", "tail", 150, new Map([["a", 90]]));
      } catch {
        // refusing would be a correct answer too
      }
      expect(footage(t, "a")[1]).toBeLessThanOrEqual(90);
      expect(at(t, "b")[0]).toBe(at(t, "a")[1]);
    },
  );

  it("refuses an edge that is already where it was asked to go", () => {
    expect(() => rippleTrim(threeShots(), "b", "tail", 120, NO_LIMIT)).toThrow(/already there/);
    expect(() => rippleTrim(threeShots(), "b", "head", 60, NO_LIMIT)).toThrow(/already there/);
  });
});

describe("roll (drag the cut between two clips)", () => {
  it("moving the cut later: the left clip takes exactly what the right one gives up, and nothing else moves", () => {
    const t = threeShots();
    const later = shows(t, "b", 100);
    rollEdit(t, "a", 80, NO_LIMIT);
    expect(at(t, "a")).toEqual([0, 80]);
    expect(footage(t, "a")).toEqual([0, 80]);
    expect(at(t, "b")).toEqual([80, 120]);
    expect(footage(t, "b")).toEqual([220, 260]);
    expect(shows(t, "b", 100)).toBe(later);
    expect(at(t, "c")).toEqual([120, 180]);
    expect(at(t, "m")).toEqual([120, 180]);
  });

  it("moving the cut earlier: the right clip shows earlier footage, its later frames keep their picture", () => {
    const t = threeShots();
    const later = shows(t, "b", 100);
    expect(rollEdit(t, "a", 40, NO_LIMIT)).toEqual({ cut_moved_to: 40, track: "v1" });
    expect(at(t, "a")).toEqual([0, 40]);
    expect(at(t, "b")).toEqual([40, 120]);
    expect(footage(t, "b")).toEqual([180, 260]);
    expect(shows(t, "b", 100)).toBe(later);
    expect(at(t, "c")).toEqual([120, 180]);
  });

  it("refuses a cut with no clip on its right", () => {
    expect(() => rollEdit(threeShots(), "c", 150, NO_LIMIT)).toThrow(/BOTH sides/);
  });

  // KNOWN BUG (found 2026-11-28 by the testing catch-up; pre-existing). Remove `.fails` once fixed.
  // A roll is not bounded by the footage either clip has. Rolled past the end of the outgoing clip's
  // file, that clip stops at its last frame while the incoming one has already given up its head, so
  // a black gap opens at the cut; rolled before the first frame of the incoming clip's file, that
  // clip's picture slips (every later frame shows other footage).
  it.fails("a roll past the end of the outgoing clip's footage leaves no gap at the cut", () => {
    const t = threeShots();
    try {
      rollEdit(t, "a", 80, new Map([["a", 60]]));
    } catch {
      // refusing the roll would be a correct answer too
    }
    expect(at(t, "a")[1]).toBe(at(t, "b")[0]);
    expect(footage(t, "a")[1]).toBeLessThanOrEqual(60);
  });

  it.fails(
    "a roll before the first frame of the incoming clip's footage does not slip its picture",
    () => {
      const t = tl(track("v1", "video", [vid("a", 0, 60, 0), vid("b", 60, 120, 0)]));
      const later = shows(t, "b", 100);
      try {
        rollEdit(t, "a", 40, NO_LIMIT);
      } catch {
        // refusing the roll would be a correct answer too
      }
      expect(shows(t, "b", 100)).toBe(later);
    },
  );

  it.each([
    ["onto the left clip's first frame", 0],
    ["onto the right clip's end", 120],
    ["past the right clip", 130],
  ])("refuses to roll the cut %s", (_where, to) => {
    expect(() => rollEdit(threeShots(), "a", to, NO_LIMIT)).toThrow(/consume/);
  });
});

describe("slip (move the footage inside a clip that stays put)", () => {
  it("shows later footage in the same place and for the same length", () => {
    const t = tl(track("v1", "video", [vid("a", 30, 90, 100)]));
    expect(slipClip(t, "a", 10, NO_LIMIT)).toEqual({ slipped: 10 });
    expect(at(t, "a")).toEqual([30, 90]);
    expect(footage(t, "a")).toEqual([110, 170]);
  });

  it("at 2x a slip of 5 frames moves the footage 10 source frames", () => {
    const t = tl(track("v1", "video", [vid("a", 30, 90, 100, { speed: 2 })]));
    expect(slipClip(t, "a", 5, NO_LIMIT)).toEqual({ slipped: 10 });
    expect(at(t, "a")).toEqual([30, 90]);
    expect(footage(t, "a")).toEqual([110, 230]);
  });

  it("stops at the first frame of the footage, keeping its place and length", () => {
    const t = tl(track("v1", "video", [vid("a", 30, 90, 100)]));
    slipClip(t, "a", -500, NO_LIMIT);
    expect(at(t, "a")).toEqual([30, 90]);
    expect(footage(t, "a")).toEqual([0, 60]);
  });

  // KNOWN BUG (found 2026-11-28 by the testing catch-up; pre-existing). Remove `.fails` once fixed.
  // A slip past the END of the footage shortens the clip (a gap opens after it) instead of stopping at
  // the last frame the way a slip into the head stops at the first.
  it.fails("stops at the last frame of the footage, keeping its place and length", () => {
    const t = tl(track("v1", "video", [vid("a", 30, 90, 100)]));
    slipClip(t, "a", 50, new Map([["a", 200]]));
    expect(at(t, "a")).toEqual([30, 90]);
    expect(footage(t, "a")).toEqual([140, 200]);
  });

  // KNOWN BUG (found 2026-11-28 by the testing catch-up; pre-existing). Remove `.fails` once fixed.
  // A slip by the clip's own length or more is refused outright ("source_out must be after
  // source_in"), even when the file has all the footage it needs: the new in-point is checked against
  // the OLD out-point before the window is worked out.
  it.fails("slips by more than the clip's own length when the file has the footage", () => {
    const t = tl(track("v1", "video", [vid("a", 30, 90, 100)]));
    try {
      slipClip(t, "a", 60, new Map([["a", 300]]));
    } catch {
      // the refusal is the bug: the outcome below is what a person expects
    }
    expect(at(t, "a")).toEqual([30, 90]);
    expect(footage(t, "a")).toEqual([160, 220]);
  });

  it("refuses a still, which has no footage to slip", () => {
    const still = { id: "p", kind: "image", media_ref: "p.png", timeline_in: 0, timeline_out: 60 };
    expect(() => slipClip(tl(track("v1", "video", [still])), "p", 5, NO_LIMIT)).toThrow(
      /no source window/,
    );
  });

  it("refuses a slip too small to move a single source frame", () => {
    const t = tl(track("v1", "video", [vid("a", 0, 60, 100)]));
    expect(() => slipClip(t, "a", 0, NO_LIMIT)).toThrow(/nothing to slip/);
    const slow = tl(track("v1", "video", [vid("a", 0, 60, 100, { speed: 0.25 })]));
    expect(() => slipClip(slow, "a", 1, NO_LIMIT)).toThrow(/nothing to slip/);
  });
});

describe("slide (move a clip between its neighbours)", () => {
  it("later: the clip keeps its footage, the left neighbour grows and the right one shrinks by the same amount", () => {
    const t = threeShots();
    const rightLater = shows(t, "c", 150);
    expect(slideClip(t, "b", 10, NO_LIMIT)).toEqual({ slid: 10 });
    expect(at(t, "b")).toEqual([70, 130]);
    expect(footage(t, "b")).toEqual([200, 260]);
    expect(at(t, "a")).toEqual([0, 70]);
    expect(footage(t, "a")).toEqual([0, 70]);
    expect(at(t, "c")).toEqual([130, 180]);
    expect(shows(t, "c", 150)).toBe(rightLater);
    expect(at(t, "m")).toEqual([120, 180]); // the sequence did not change length
    expect(timelineInvariantViolations(t)).toEqual([]);
  });

  it("earlier: the left neighbour shrinks and the right one shows earlier footage", () => {
    const t = threeShots();
    slideClip(t, "b", -10, NO_LIMIT);
    expect(at(t, "a")).toEqual([0, 50]);
    expect(at(t, "b")).toEqual([50, 110]);
    expect(footage(t, "b")).toEqual([200, 260]);
    expect(at(t, "c")).toEqual([110, 180]);
    expect(footage(t, "c")).toEqual([290, 360]);
  });

  it("with a neighbour on one side only, that one absorbs the move", () => {
    const t = threeShots();
    slideClip(t, "c", -10, NO_LIMIT);
    expect(at(t, "b")).toEqual([60, 110]);
    expect(at(t, "c")).toEqual([110, 170]);
    const u = threeShots();
    slideClip(u, "a", 10, NO_LIMIT);
    expect(at(u, "a")).toEqual([10, 70]);
    expect(at(u, "b")).toEqual([70, 120]);
    expect(footage(u, "b")).toEqual([210, 260]);
  });

  it("refuses a clip with no neighbour to absorb the move", () => {
    const t = tl(track("v1", "video", [vid("a", 0, 60), vid("b", 90, 150)]));
    expect(() => slideClip(t, "b", 10, NO_LIMIT)).toThrow(/neighbour/);
  });

  it.each([
    ["swallows the left neighbour", -60, /left neighbour/],
    ["swallows the right neighbour", 60, /right neighbour/],
  ])("refuses a slide that %s", (_what, delta, message) => {
    expect(() => slideClip(threeShots(), "b", delta, NO_LIMIT)).toThrow(message);
  });

  it("refuses a slide of nothing", () => {
    expect(() => slideClip(threeShots(), "b", 0, NO_LIMIT)).toThrow(/nothing to slide/);
  });
});

describe("enable / disable (Shift+E)", () => {
  function pair(): Timeline {
    return tl(
      track("v1", "video", [vid("v", 0, 60, 0, { link_group: "g" }), vid("x", 60, 120)]),
      track("a1", "audio", [aud("s", 0, 60, 0, { media_ref: "v.mp4", link_group: "g" })]),
    );
  }

  it("disabling a picture silences its own sound too, and leaves every other clip alone", () => {
    const t = pair();
    expect(setClipEnabled(t, ["v"], false)).toEqual({ updated: 2, enabled: false });
    expect(clipOf(t, "v").disabled).toBe(true);
    expect(clipOf(t, "s").disabled).toBe(true);
    expect("disabled" in clipOf(t, "x")).toBe(false);
  });

  it("enabling takes the flag off both, rather than leaving disabled:false behind", () => {
    const t = pair();
    setClipEnabled(t, ["v"], false);
    setClipEnabled(t, ["s"], true);
    expect("disabled" in clipOf(t, "v")).toBe(false);
    expect("disabled" in clipOf(t, "s")).toBe(false);
  });

  it("refuses an empty selection", () => {
    expect(() => setClipEnabled(pair(), [], false)).toThrow(/no clips/);
  });
});

describe("nudge", () => {
  it("refuses to nudge nothing, and refuses a nudge that cannot move the selection at all", () => {
    const t = tl(track("v1", "video", [vid("a", 0, 60)]));
    expect(() => nudgeClips(t, [], 5)).toThrow(/nothing selected/);
    expect(() => nudgeClips(t, ["a"], -5)).toThrow(/already at frame 0/);
  });

  it("stops the selection at frame 0 as a whole", () => {
    const t = tl(track("v1", "video", [vid("a", 10, 60), vid("b", 60, 120)]));
    nudgeClips(t, ["a", "b"], -30);
    expect(at(t, "a")).toEqual([0, 50]);
    expect(at(t, "b")).toEqual([50, 110]);
  });
});

describe("a locked track refuses every edit to its clips", () => {
  // "Locked blocks ALL edits" is a rule about a class of operations, so it is walked over the class:
  // one forgotten operation is a locked clip that still moves.
  const locked = (): Timeline =>
    tl(
      track("v1", "video", [vid("a", 0, 60, 0), vid("b", 60, 120, 200), vid("c", 120, 180, 300)], {
        locked: true,
      }),
      track("v2", "video", [vid("z", 0, 60)]),
    );
  const edits: Array<[string, (t: Timeline) => unknown]> = [
    ["trim to the playhead", (t) => trimToPlayhead(t, "b", "head", 80, NO_LIMIT)],
    ["ripple trim", (t) => rippleTrim(t, "b", "tail", 100, NO_LIMIT)],
    ["roll", (t) => rollEdit(t, "a", 40, NO_LIMIT)],
    ["slip", (t) => slipClip(t, "b", 5, NO_LIMIT)],
    ["slide", (t) => slideClip(t, "b", 5, NO_LIMIT)],
    ["disable", (t) => setClipEnabled(t, ["b"], false)],
    ["nudge", (t) => nudgeClips(t, ["b"], 5)],
    ["move", (t) => moveClips(t, [{ clip_id: "b", to_timeline_in: 300 }])],
    ["move onto it", (t) => moveClips(t, [{ clip_id: "z", to_track: "v1", to_timeline_in: 300 }])],
    ["split", (t) => splitClips(t, [{ clip_id: "b", at: 90 }])],
    ["trim", (t) => trimClips(t, [{ clip_id: "b", timeline_out: 100 }], NO_LIMIT)],
    ["delete", (t) => removeClips(t, ["b"])],
    ["link", (t) => linkClips(t, ["b", "z"])],
    ["unlink", (t) => unlinkClips(t, ["b"])],
    [
      "transition",
      (t) => setTransition(t, { clip_id: "b", transition_in: { kind: "fade", duration: 5 } }),
    ],
  ];

  it.each(edits)("%s", (_what, edit) => {
    const t = locked();
    const before = snapshot(t);
    expect(() => edit(t)).toThrow(/locked/);
    expect(snapshot(t)).toBe(before);
  });
});
