// The everyday timeline edits, as the person (or the agent) sees their result: moving and Alt-dragging
// clips with their sound, trimming, splitting, deleting, linking, crossfades, ripple deletes and track
// switches. Mutation testing (26 Nov) showed these lines RUN under the existing tests while many of
// their planted bugs went unnoticed; each case below pins a result a person would notice if it broke.
import { describe, expect, it } from "vitest";

import { findClip } from "./helpers";
import type { Timeline } from "./model";
import {
  duplicateClipsToPositions,
  linkClips,
  moveClips,
  nudgeClips,
  removeClips,
  rippleDelete,
  setTrack,
  setTracks,
  setTransition,
  splitClips,
  trimClips,
  unlinkClips,
} from "./operations";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

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
const trackOf = (t: Timeline, id: string): string => {
  const found = findClip(t, id);
  if (!found) throw new Error(`no clip ${id}`);
  return found[0].id;
};
const at = (t: Timeline, id: string): [number, number] => {
  const c = clipOf(t, id);
  return [c.timeline_in, c.timeline_out];
};
const footage = (t: Timeline, id: string): [number, number] => {
  const c = clipOf(t, id);
  return [c.source_in, c.source_out];
};
/** Every clip on a track, in time order, as [first frame, frame after the last]. */
const lane = (t: Timeline, trackId: string): Array<[number, number]> =>
  (t.tracks.find((x) => x.id === trackId)?.clips ?? [])
    .map((c) => [Number(c.timeline_in), Number(c.timeline_out)] as [number, number])
    .sort((x, y) => x[0] - y[0]);
const ids = (t: Timeline, trackId: string): string[] =>
  (t.tracks.find((x) => x.id === trackId)?.clips ?? []).map((c) => String(c.id));

/** A picture and its own sound, linked; the sound starts `offset` frames later (a J cut when > 0). */
function pair(tin: number, tout: number, offset = 0): Timeline {
  return tl(
    track("v1", "video", [vid("v", tin, tout, 100, { link_group: "g" })]),
    track("a1", "audio", [
      aud("s", tin + offset, tout + offset, 100, { media_ref: "v.mp4", link_group: "g" }),
    ]),
    track("v2", "video", []),
  );
}

describe("moving clips", () => {
  it("the clip's own sound follows by the same number of frames, keeping a J cut's offset", () => {
    const t = pair(30, 90, 10);
    moveClips(t, [{ clip_id: "v", to_timeline_in: 60 }]);
    expect(at(t, "v")).toEqual([60, 120]);
    expect(at(t, "s")).toEqual([70, 130]);
  });

  it("a move to another track with no frame given keeps the clip at its time", () => {
    const t = pair(30, 90);
    moveClips(t, [{ clip_id: "v", to_track: "v2", to_timeline_in: null }]);
    expect(trackOf(t, "v")).toBe("v2");
    expect(at(t, "v")).toEqual([30, 90]);
  });

  it("a move in time with no track given keeps the clip on its track", () => {
    const t = pair(30, 90);
    moveClips(t, [{ clip_id: "v", to_timeline_in: 60, to_track: null }]);
    expect(trackOf(t, "v")).toBe("v1");
    expect(t.tracks.map((x) => x.id)).toEqual(["v1", "a1", "v2"]);
  });

  it("refuses a move that names neither a frame nor a track", () => {
    expect(() => moveClips(pair(30, 90), [{ clip_id: "v" }])).toThrow(/to_timeline_in/);
  });

  describe("a dragged selection (refuses to land on a bystander)", () => {
    it("may land where one of its own clips was", () => {
      const t = tl(track("v1", "video", [vid("a", 0, 30), vid("b", 60, 90)]));
      nudgeClips(t, ["a", "b"], 60, { refuseOverwrite: true });
      expect(at(t, "a")).toEqual([60, 90]);
      expect(at(t, "b")).toEqual([120, 150]);
    });

    it("may land right up against a bystander after it", () => {
      const t = tl(track("v1", "video", [vid("a", 0, 30), vid("b", 30, 60), vid("x", 90, 120)]));
      nudgeClips(t, ["a", "b"], 30, { refuseOverwrite: true });
      expect(lane(t, "v1")).toEqual([
        [30, 60],
        [60, 90],
        [90, 120],
      ]);
    });

    it("may land right up against a bystander before it", () => {
      const t = tl(track("v1", "video", [vid("x", 0, 30), vid("a", 60, 90), vid("b", 90, 120)]));
      nudgeClips(t, ["a", "b"], -30, { refuseOverwrite: true });
      expect(lane(t, "v1")).toEqual([
        [0, 30],
        [30, 60],
        [60, 90],
      ]);
    });
  });
});

describe("Alt+drag (copy clips to where they are dropped)", () => {
  it("copies a J-cut pair: the dragged clip lands at the pointer, its sound at the same offset, as a new pair", () => {
    const t = pair(0, 60, 10);
    const r = duplicateClipsToPositions(t, [{ clip_id: "v", to_timeline_in: 120 }]);
    expect(at(t, "v")).toEqual([0, 60]);
    expect(at(t, "s")).toEqual([10, 70]);
    const copies = r.new_clip_ids as string[];
    expect(copies).toHaveLength(2);
    const [cv, cs] = copies.map((id) => clipOf(t, id));
    expect([cv.timeline_in, cv.timeline_out]).toEqual([120, 180]);
    expect([cs.timeline_in, cs.timeline_out]).toEqual([130, 190]);
    expect(cv.kind).toBe("video");
    expect(cs.kind).toBe("audio");
    expect(cv.link_group).toBeTruthy();
    expect(cs.link_group).toBe(cv.link_group);
    expect(cv.link_group).not.toBe("g");
  });

  it("a copy of an unlinked clip is linked to nothing", () => {
    const t = tl(track("v1", "video", [vid("a", 0, 60)]));
    const [copy] = duplicateClipsToPositions(t, [{ clip_id: "a", to_timeline_in: 90 }])
      .new_clip_ids as string[];
    expect(at(t, copy)).toEqual([90, 150]);
    expect(clipOf(t, copy).link_group).toBeUndefined();
  });

  it("copying ONE half of a pair (Alt held on the clip) copies only that half, unlinked", () => {
    const t = pair(0, 60);
    const r = duplicateClipsToPositions(t, [{ clip_id: "v", to_timeline_in: 120 }], {
      ignoreLinks: true,
    });
    const copies = r.new_clip_ids as string[];
    expect(copies).toHaveLength(1);
    expect(at(t, copies[0])).toEqual([120, 180]);
    expect(clipOf(t, copies[0]).link_group).toBeUndefined();
    expect(lane(t, "a1")).toEqual([[0, 60]]);
  });

  it("refuses to copy nothing", () => {
    expect(() => duplicateClipsToPositions(pair(0, 60), [])).toThrow(/nothing to duplicate/);
  });
});

describe("trimming", () => {
  it("a head trim on a clip that does not start at 0 moves its sound's head by the same amount", () => {
    const t = pair(30, 90);
    trimClips(t, [{ clip_id: "v", timeline_in: 40, source_in: 110 }], NO_LIMIT);
    expect(at(t, "v")).toEqual([40, 90]);
    expect(footage(t, "v")).toEqual([110, 160]);
    expect(at(t, "s")).toEqual([40, 90]);
    expect(footage(t, "s")).toEqual([110, 160]);
    trimClips(t, [{ clip_id: "v", timeline_out: 80 }], NO_LIMIT);
    expect(at(t, "v")).toEqual([40, 80]);
    expect(at(t, "s")).toEqual([40, 80]);
  });

  it("at 2x a clip half as long plays half as much footage", () => {
    const t = tl(track("v1", "video", [vid("a", 0, 60, 0, { speed: 2 })]));
    trimClips(t, [{ clip_id: "a", timeline_out: 30 }], NO_LIMIT);
    expect(at(t, "a")).toEqual([0, 30]);
    expect(footage(t, "a")).toEqual([0, 60]);
  });

  it.each([["loop"], ["stretch"]])(
    "a %s clip keeps its footage when trimmed: it fills its slot from a source of another length",
    (mode) => {
      const bed = aud("bed", 0, 300, 0, { [mode]: true, source_out: 90 });
      const t = tl(track("a1", "audio", [bed]));
      trimClips(t, [{ clip_id: "bed", timeline_out: 200 }], new Map([["bed", 90]]));
      expect(at(t, "bed")).toEqual([0, 200]);
      expect(footage(t, "bed")).toEqual([0, 90]);
    },
  );

  it("a still linked to a sound takes the sound with it", () => {
    const still = {
      id: "p",
      kind: "image",
      media_ref: "p.png",
      timeline_in: 30,
      timeline_out: 90,
      link_group: "g",
    };
    const t = tl(
      track("v1", "video", [still]),
      track("a1", "audio", [aud("s", 30, 90, 0, { link_group: "g" })]),
    );
    trimClips(t, [{ clip_id: "p", timeline_in: 45 }], NO_LIMIT);
    expect(at(t, "p")).toEqual([45, 90]);
    expect(at(t, "s")).toEqual([45, 90]);
  });

  it("a field sent as null means 'not given', not frame 0", () => {
    const t = pair(30, 90);
    trimClips(t, [{ clip_id: "v", timeline_out: 80, source_in: null }], NO_LIMIT);
    expect(at(t, "v")).toEqual([30, 80]);
    expect(footage(t, "v")).toEqual([100, 150]);
  });

  it("says how many clips it trimmed, and a note shared by several clips once", () => {
    const t = tl(track("v1", "video", [vid("a", 0, 60)]), track("v2", "video", [vid("b", 0, 60)]));
    const r = trimClips(
      t,
      [
        { clip_id: "a", timeline_out: 90 },
        { clip_id: "b", timeline_out: 90 },
      ],
      new Map([
        ["a", 60],
        ["b", 60],
      ]),
    );
    expect(at(t, "a")).toEqual([0, 60]);
    expect(at(t, "b")).toEqual([0, 60]);
    expect(r.trimmed).toBe(2);
    expect(r.notes).toHaveLength(1);
  });
});

describe("splitting", () => {
  it("splitting a picture at the frame its J-cut sound starts leaves the sound whole", () => {
    const t = pair(0, 60, 30);
    splitClips(t, [{ clip_id: "v", at: 30 }]);
    expect(lane(t, "v1")).toEqual([
      [0, 30],
      [30, 60],
    ]);
    expect(lane(t, "a1")).toEqual([[30, 90]]);
  });

  it("splitting a picture at the frame its L-cut sound ends leaves the sound whole", () => {
    const t = pair(30, 90, -30);
    splitClips(t, [{ clip_id: "v", at: 60 }]);
    expect(lane(t, "v1")).toEqual([
      [30, 60],
      [60, 90],
    ]);
    expect(lane(t, "a1")).toEqual([[0, 60]]);
  });

  it("a sound running through the split is cut at the same frame, each half paired with its picture", () => {
    const t = pair(0, 60);
    const { new_clip_ids } = splitClips(t, [{ clip_id: "v", at: 20 }]) as {
      new_clip_ids: string[];
    };
    expect(lane(t, "a1")).toEqual([
      [0, 20],
      [20, 60],
    ]);
    const right = clipOf(t, new_clip_ids[0]);
    const rightSound = (t.tracks[1].clips ?? []).find((c) => c.timeline_in === 20)!;
    expect(rightSound.link_group).toBe(right.link_group);
    expect(right.link_group).not.toBe(clipOf(t, "v").link_group);
  });
});

describe("deleting", () => {
  function scene(): Timeline {
    return tl(
      track("v1", "video", [vid("v", 0, 60, 0, { link_group: "g" }), vid("x", 60, 120)]),
      track("a1", "audio", [aud("s", 0, 60, 0, { media_ref: "v.mp4", link_group: "g" })]),
      track("a2", "audio", [aud("y", 0, 120)]),
    );
  }

  it("deleting a picture deletes its own sound, and nothing else", () => {
    const t = scene();
    expect(removeClips(t, ["v"])).toEqual({ removed: 2 });
    expect(ids(t, "v1")).toEqual(["x"]);
    expect(ids(t, "a1")).toEqual([]);
    expect(ids(t, "a2")).toEqual(["y"]);
  });

  it("an id that is no longer there is skipped when others are deleted", () => {
    const t = scene();
    expect(removeClips(t, ["gone", "x"])).toEqual({ removed: 1 });
    expect(ids(t, "v1")).toEqual(["v"]);
  });

  it("deleting only ids that are no longer there is refused", () => {
    expect(() => removeClips(scene(), ["gone"])).toThrow(/no matching clip/);
  });
});

describe("linking", () => {
  function groups(): Timeline {
    return tl(
      track("v1", "video", [
        vid("a", 0, 60, 0, { link_group: "g1" }),
        vid("c", 60, 120, 0, { link_group: "g2" }),
      ]),
      track("a1", "audio", [
        aud("b", 0, 60, 0, { link_group: "g1" }),
        aud("d", 60, 120, 0, { link_group: "g2" }),
      ]),
    );
  }

  it("linking clips of two groups makes ONE group of all of them", () => {
    const t = groups();
    const r = linkClips(t, ["a", "c"]);
    const g = clipOf(t, "a").link_group;
    expect(["a", "b", "c", "d"].map((id) => clipOf(t, id).link_group)).toEqual([g, g, g, g]);
    expect(r).toEqual({ linked: 4, link_group: g });
  });

  it("unlinking one clip dissolves its whole group and leaves other groups alone", () => {
    const t = groups();
    expect(unlinkClips(t, ["gone", "a"])).toEqual({ unlinked: 2 });
    expect(clipOf(t, "a").link_group).toBeUndefined();
    expect(clipOf(t, "b").link_group).toBeUndefined();
    expect(clipOf(t, "c").link_group).toBe("g2");
    expect(clipOf(t, "d").link_group).toBe("g2");
  });

  it("unlinking clips that are not linked is refused", () => {
    const t = tl(track("v1", "video", [vid("a", 0, 60)]));
    expect(() => unlinkClips(t, ["a"])).toThrow(/no linked clips/);
  });
});

describe("crossfades (a transition into a clip)", () => {
  /** b's predecessor in TIME is the 10-frame clip a, stored after it. */
  function shuffled(): Timeline {
    return tl(track("v1", "video", [vid("b", 60, 120), vid("a", 50, 60), vid("c", 120, 180)]));
  }

  it("fades from the clip before it in time, whatever order the track stores them in", () => {
    const t = shuffled();
    expect(
      setTransition(t, { clip_id: "b", transition_in: { kind: "fade", duration: 10 } }),
    ).toEqual({ clip_id: "b", kind: "fade", duration: 10 });
    expect(clipOf(t, "b").transition_in).toEqual({ kind: "fade", duration: 10 });
    // c's predecessor is the 60-frame b, so 30 frames fit; measured against a (10 frames) it would not.
    setTransition(t, { clip_id: "c", transition_in: { kind: "fade", duration: 30 } });
    expect(clipOf(t, "c").transition_in).toEqual({ kind: "fade", duration: 30 });
  });

  it("the first clip on a track has nothing to fade from", () => {
    expect(() =>
      setTransition(shuffled(), { clip_id: "a", transition_in: { kind: "fade", duration: 5 } }),
    ).toThrow(/preceding clip/);
  });

  it.each([
    ["the outgoing clip is shorter", [30, 50], [50, 110]],
    ["the incoming clip is shorter", [30, 90], [90, 110]],
  ])("may be as long as the shorter clip and no longer (%s)", (_what, [ai, ao], [bi, bo]) => {
    const make = () => tl(track("v1", "video", [vid("a", ai, ao), vid("b", bi, bo)]));
    const ok = make();
    setTransition(ok, { clip_id: "b", transition_in: { kind: "fade", duration: 20 } });
    expect(clipOf(ok, "b").transition_in.duration).toBe(20);
    expect(() =>
      setTransition(make(), { clip_id: "b", transition_in: { kind: "fade", duration: 21 } }),
    ).toThrow(/exceed/);
  });

  it.each([
    ["no length", { kind: "fade", duration: 0 }],
    ["no kind", { kind: "", duration: 10 }],
  ])("refuses a transition with %s", (_what, transition) => {
    expect(() => setTransition(shuffled(), { clip_id: "b", transition_in: transition })).toThrow(
      /non-empty kind and duration/,
    );
  });

  it("null, or no transition at all, takes the crossfade away", () => {
    for (const transition_in of [null, undefined]) {
      const t = shuffled();
      setTransition(t, { clip_id: "b", transition_in: { kind: "fade", duration: 10 } });
      expect(setTransition(t, { clip_id: "b", transition_in })).toEqual({
        clip_id: "b",
        removed: true,
      });
      expect("transition_in" in clipOf(t, "b")).toBe(false);
    }
  });

  it("keeps a custom expression without its surrounding spaces, and drops one that is only spaces", () => {
    const t = shuffled();
    setTransition(t, {
      clip_id: "b",
      transition_in: { kind: "custom", duration: 5, expr: "  A*P  " },
    });
    expect(clipOf(t, "b").transition_in).toEqual({ kind: "custom", duration: 5, expr: "A*P" });
    setTransition(t, { clip_id: "b", transition_in: { kind: "custom", duration: 5, expr: "   " } });
    expect(clipOf(t, "b").transition_in).toEqual({ kind: "custom", duration: 5 });
  });
});

describe("ripple delete (cut a window out and close the gap)", () => {
  const four = () =>
    tl(
      track("v1", "video", [
        vid("a", 0, 30),
        vid("b", 30, 60),
        vid("c", 60, 90),
        vid("d", 90, 120),
      ]),
    );

  it("cuts every window it is given, even when they are listed out of order", () => {
    const t = four();
    const r = rippleDelete(t, {
      track_id: "v1",
      ranges: [
        { start: 60, end: 90 },
        { start: 0, end: 30 },
      ],
    });
    expect(ids(t, "v1").sort()).toEqual(["b", "d"]);
    expect(lane(t, "v1")).toEqual([
      [0, 30],
      [30, 60],
    ]);
    expect(r.removed_span).toBe(60);
  });

  it("windows that touch are cut as one", () => {
    const r = rippleDelete(four(), {
      track_id: "v1",
      ranges: [
        { start: 0, end: 30 },
        { start: 30, end: 60 },
      ],
    });
    expect(r).toMatchObject({ removed_span: 60, ranges: 1 });
  });

  it("a cut aimed at one clip stays inside that clip", () => {
    const t = tl(track("v1", "video", [vid("a", 0, 60), vid("b", 60, 120), vid("c", 120, 180)]));
    const r = rippleDelete(t, { clip_id: "b", start: 30, end: 90 });
    // Only b's first 30 frames go: a is untouched, b's last 30 frames close up against it.
    expect(at(t, "a")).toEqual([0, 60]);
    expect(footage(t, "a")).toEqual([0, 60]);
    expect(lane(t, "v1")).toEqual([
      [0, 60],
      [60, 90],
      [90, 150],
    ]);
    expect(at(t, "c")).toEqual([90, 150]);
    expect(r.removed_span).toBe(30);
  });

  it("a cut aimed at a clip that misses it is refused", () => {
    const t = tl(track("v1", "video", [vid("a", 0, 60), vid("b", 60, 120)]));
    expect(() => rippleDelete(t, { clip_id: "b", start: 0, end: 60 })).toThrow(/no range overlaps/);
  });

  it.each([
    ["an empty window", { track_id: "v1", start: 30, end: 30 }, /end must be after start/],
    ["a start with no end", { track_id: "v1", start: 30 }, /give the cut window/],
    ["no track and no clip", { start: 0, end: 30 }, /provide track_id or clip_id/],
  ])("refuses %s", (_what, args, message) => {
    expect(() => rippleDelete(four(), args)).toThrow(message);
  });
});

describe("track switches", () => {
  const FLAGS = ["mute", "hidden", "sync_locked", "locked", "solo"] as const;
  const all = (on: boolean): Timeline =>
    tl(
      track("v1", "video", [], {
        mute: on,
        hidden: on,
        sync_locked: on,
        locked: on,
        solo: on,
        z: 3,
      }),
      track("v2", "video", [], { z: 1 }),
    );
  const flagsOf = (t: Timeline, id: string): Record<string, unknown> => {
    const tr = t.tracks.find((x) => x.id === id) as Any;
    return Object.fromEntries([...FLAGS, "z"].map((f) => [f, tr[f]]));
  };

  it.each(FLAGS)("switching %s changes that switch and no other", (flag) => {
    for (const on of [true, false]) {
      const t = all(on);
      const before = flagsOf(t, "v1");
      expect(setTrack(t, { track_id: "v1", [flag]: !on })).toEqual({ track_id: "v1" });
      expect(flagsOf(t, "v1")).toEqual({ ...before, [flag]: !on });
    }
  });

  it("a switch sent as null is left as it was", () => {
    const t = all(true);
    const before = flagsOf(t, "v1");
    setTrack(t, {
      track_id: "v1",
      mute: null,
      hidden: null,
      sync_locked: null,
      locked: null,
      solo: null,
    });
    expect(flagsOf(t, "v1")).toEqual(before);
  });

  it("several tracks are switched in one go", () => {
    const t = all(false);
    expect(
      setTracks(t, [
        { track_id: "v1", z: 1 },
        { track_id: "v2", z: 3, hidden: true },
      ]),
    ).toEqual({ track_ids: ["v1", "v2"] });
    expect(flagsOf(t, "v1").z).toBe(1);
    expect(flagsOf(t, "v2")).toMatchObject({ z: 3, hidden: true });
  });

  it("an unknown track is refused", () => {
    expect(() => setTrack(all(false), { track_id: "nope", mute: true })).toThrow(/not found/);
  });
});
