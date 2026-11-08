import { describe, expect, it } from "vitest";

import { addTextClips, textLanes } from "./operations";
import type { Timeline } from "./model";

// add_text_clips used to append onto whatever track the entry named (or the default one) with
// no fit check, so the call died later in validateTimeline against the SORTED array —
// "captions.clips[7]: timeline_in=2 overlaps previous clip", an index the caller never saw,
// with no way to tell which entry was wrong or whether it hit pre-existing content.
//
// These assert the OUTCOME the caller experiences: which track clips land on, and that a
// refusal names the caller's own entry indices. Deliberately no test asserts "resolveTextTrack
// was called" — that would pass just as happily with the fit check deleted.

const FPS = 30;

function timeline(tracks: Array<{ id: string; kind?: string; clips?: unknown[] }>): Timeline {
  return {
    units: "frames",
    canvas: { width: 1920, height: 1080, fps: FPS },
    tracks: tracks.map((t, i) => ({
      id: t.id,
      kind: t.kind ?? "text",
      z: i,
      clips: (t.clips ?? []) as never,
    })),
  } as unknown as Timeline;
}

const text = (tin: number, tout: number, extra: Record<string, unknown> = {}) => ({
  content: "hello",
  timeline_in: tin,
  timeline_out: tout,
  ...extra,
});

const clipAt = (tin: number, tout: number) => ({
  id: `c${tin}`,
  kind: "text",
  timeline_in: tin,
  timeline_out: tout,
  content: [{ text: "existing" }],
});

/** Every track's clips, keyed by id — the persisted shape, not the return value. */
function placed(tl: Timeline): Record<string, Array<[number, number]>> {
  const out: Record<string, Array<[number, number]>> = {};
  for (const t of tl.tracks) {
    out[t.id] = (t.clips ?? []).map((c) => [c.timeline_in as number, c.timeline_out as number]);
  }
  return out;
}

describe("add_text_clips: two entries that overlap on one NAMED track are refused, not built", () => {
  // The caller chose that track for both, so the call contradicts itself. (Entries that name no
  // track are never refused for overlapping: each gets a lane, below.)
  it("names BOTH colliding entries by the caller's own index, and the track", () => {
    const tl = timeline([{ id: "captions" }]);
    expect(() =>
      addTextClips(tl, [
        text(0, 60, { track_id: "captions" }),
        text(30, 90, { track_id: "captions" }),
      ]),
    ).toThrow(
      /entries\[1\] \(frames 30-90\) overlaps entries\[0\] \(frames 0-60\) on track 'captions'/,
    );
  });

  // The suggestion has to be one the caller can use: omitting track_id is what places a title on a
  // free track now, and the old advice (give one its own track_id) is still true but longer.
  it("says what to do: omit track_id on one of them, or change the timing", () => {
    const tl = timeline([{ id: "captions" }]);
    expect(() =>
      addTextClips(tl, [
        text(0, 60, { track_id: "captions" }),
        text(30, 90, { track_id: "captions" }),
      ]),
    ).toThrow(/Omit track_id on one of them and it is placed on a free track/);
  });

  // The indices must describe what the CALLER wrote. Sorting by time to find collisions makes
  // it easy to report positions in the sorted order instead, which is the same unusable error
  // the validator already gave.
  it("reports caller indices even when the entries arrive out of time order", () => {
    const tl = timeline([{ id: "captions" }]);
    const on = { track_id: "captions" };
    expect(() => addTextClips(tl, [text(200, 260, on), text(0, 60, on), text(30, 90, on)])).toThrow(
      /entries\[2\] \(frames 30-90\) overlaps entries\[1\] \(frames 0-60\)/,
    );
  });

  it("writes NOTHING when it refuses", () => {
    const tl = timeline([{ id: "captions" }]);
    const on = { track_id: "captions" };
    expect(() =>
      addTextClips(tl, [text(0, 60, on), text(30, 90, on), text(500, 560, on)]),
    ).toThrow();
    expect(placed(tl)).toEqual({ captions: [] });
  });

  // Touching ranges are the boundary case: frame 60 is the first frame NOT covered by [0,60).
  it("allows entries that merely touch, named or not", () => {
    for (const extra of [{}, { track_id: "captions" }]) {
      const tl = timeline([{ id: "captions" }]);
      expect(() => addTextClips(tl, [text(0, 60, extra), text(60, 90, extra)])).not.toThrow();
      expect(placed(tl).captions).toEqual([
        [0, 60],
        [60, 90],
      ]);
    }
  });

  it("lets overlapping entries through when the caller separates them by track", () => {
    const tl = timeline([{ id: "captions" }, { id: "titles" }]);
    addTextClips(tl, [text(0, 60, { track_id: "captions" }), text(30, 90, { track_id: "titles" })]);
    expect(placed(tl)).toEqual({ captions: [[0, 60]], titles: [[30, 90]] });
  });

  // Two names, one overlapping pair under EACH: both are contradictions, and the first is named.
  it("a pair that overlaps on a track the call named stays refused beside entries that name none", () => {
    const tl = timeline([{ id: "captions" }, { id: "titles" }]);
    expect(() =>
      addTextClips(tl, [
        text(0, 60),
        text(0, 60, { track_id: "titles" }),
        text(30, 90, { track_id: "titles" }),
      ]),
    ).toThrow(/on track 'titles'/);
    expect(placed(tl)).toEqual({ captions: [], titles: [] });
  });
});

// The 12 of 13 failed calls: titles the caller wrote with no track, two or more of them overlapping
// in time. The description said to leave track_id out, and leaving it out failed the whole call.
// Each overlapping title now lands on a text track where it fits, opening one when none does.
describe("add_text_clips: entries that name no track and overlap each get a lane of their own", () => {
  it("places two overlapping titles on two tracks, and loses neither", () => {
    const tl = timeline([{ id: "captions" }]);
    const r = addTextClips(tl, [text(0, 60), text(30, 90)]) as {
      created: Array<{ track_id: string }>;
    };
    expect(placed(tl)).toEqual({ captions: [[0, 60]], captions2: [[30, 90]] });
    expect(r.created.map((c) => c.track_id)).toEqual(["captions", "captions2"]);
  });

  // created[i] answers entries[i], whatever order the titles overlap in: the caller reads it by index.
  it("answers each entry by the caller's own index, even when they arrive out of time order", () => {
    const tl = timeline([{ id: "captions" }]);
    const r = addTextClips(tl, [text(200, 260), text(0, 60), text(30, 90)]) as {
      created: Array<{ clip_id: string; track_id: string }>;
    };
    expect(r.created.map((c) => c.track_id)).toEqual(["captions", "captions", "captions2"]);
    const where = (id: string) => {
      const t = tl.tracks.find((x) => (x.clips ?? []).some((c) => c.id === id))!;
      return [t.id, (t.clips ?? []).find((c) => c.id === id)!.timeline_in];
    };
    expect(r.created.map((c) => where(c.clip_id))).toEqual([
      ["captions", 200],
      ["captions", 0],
      ["captions2", 30],
    ]);
  });

  // Titles that follow one another stay together; only the one that collides moves.
  it("keeps titles in sequence on the first lane and moves only the one that overlaps", () => {
    const tl = timeline([{ id: "captions" }]);
    addTextClips(tl, [text(0, 100), text(50, 150), text(100, 200)]);
    expect(placed(tl)).toEqual({
      captions: [
        [0, 100],
        [100, 200],
      ],
      captions2: [[50, 150]],
    });
  });

  it("opens exactly as many tracks as the deepest overlap forces, and no more", () => {
    const tl = timeline([{ id: "captions" }]);
    addTextClips(tl, [text(0, 90), text(10, 90), text(20, 90), text(100, 120), text(95, 130)]);
    expect(tl.tracks.map((t) => t.id)).toEqual(["captions", "captions2", "captions3"]);
    const total = Object.values(placed(tl)).reduce((n, spans) => n + spans.length, 0);
    expect(total).toBe(5);
  });

  it("reuses an existing text track with room before it opens a new one", () => {
    const tl = timeline([{ id: "captions", clips: [clipAt(0, 400)] }, { id: "titles" }]);
    addTextClips(tl, [text(0, 60), text(30, 90)]);
    expect(placed(tl)).toEqual({
      captions: [[0, 400]],
      titles: [[0, 60]],
      captions2: [[30, 90]],
    });
  });

  it("never lays a lane over clips that were already there", () => {
    const tl = timeline([{ id: "captions", clips: [clipAt(40, 50)] }]);
    addTextClips(tl, [text(0, 60), text(30, 90)]);
    expect(placed(tl).captions).toEqual([[40, 50]]);
    expect(placed(tl).captions2).toEqual([[0, 60]]);
    expect(placed(tl).captions3).toEqual([[30, 90]]);
  });

  // A track the call named is not free for the others, though nothing is written to it yet.
  it("keeps every lane off a track another entry in the call named", () => {
    const tl = timeline([{ id: "captions" }]);
    addTextClips(tl, [text(0, 60, { track_id: "captions" }), text(0, 60), text(30, 90)]);
    expect(placed(tl)).toEqual({
      captions: [[0, 60]],
      captions2: [[0, 60]],
      captions3: [[30, 90]],
    });
  });

  it("puts titles that do not overlap on ONE track, as before", () => {
    const tl = timeline([{ id: "captions" }]);
    const r = addTextClips(tl, [text(0, 30), text(40, 70), text(80, 110)]) as { notes?: string[] };
    expect(placed(tl)).toEqual({
      captions: [
        [0, 30],
        [40, 70],
        [80, 110],
      ],
    });
    expect(r.notes).toBeUndefined();
  });

  // The caller wrote no track, so it learns where each title went and that the choice was ours.
  it("says which entries went on which track, only when more than one was needed", () => {
    const tl = timeline([{ id: "captions" }]);
    const r = addTextClips(tl, [text(0, 100), text(50, 150), text(100, 200)]) as {
      notes: string[];
    };
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toContain("'captions' (entries 0, 2)");
    expect(r.notes[0]).toContain("'captions2' (entry 1)");
    expect(r.notes[0]).toContain("2 text tracks");
    expect(r.notes[0]).toMatch(/Pass track_id to choose the tracks yourself/);
  });

  // A track opened for a lane takes its place among the others in the order the call mentions it,
  // so which one sits above which does not depend on how the entries were grouped.
  it("opens new tracks in the order the call first mentions them", () => {
    const first = timeline([]);
    addTextClips(first, [text(0, 60, { track_id: "lower_thirds" }), text(0, 60), text(30, 90)]);
    expect(first.tracks.map((t) => t.id)).toEqual(["lower_thirds", "captions", "captions2"]);
    const second = timeline([]);
    addTextClips(second, [text(0, 60), text(30, 90), text(0, 60, { track_id: "lower_thirds" })]);
    expect(second.tracks.map((t) => t.id)).toEqual(["captions", "captions2", "lower_thirds"]);
  });

  // The names a call picks are only worth anything if the next call finds them again.
  it("a second call with overlapping titles finds the first call's tracks busy and goes on", () => {
    const tl = timeline([{ id: "captions" }]);
    addTextClips(tl, [text(0, 60), text(30, 90)]);
    addTextClips(tl, [text(10, 50), text(20, 40)]);
    expect(tl.tracks.map((t) => t.id)).toEqual(["captions", "captions2", "captions3", "captions4"]);
    expect(placed(tl).captions3).toEqual([[10, 50]]);
    expect(placed(tl).captions4).toEqual([[20, 40]]);
  });
});

describe("textLanes: the split behind it", () => {
  const item = (index: number, tin: number, tout: number) => ({ index, tin, tout });

  it("is empty for no entries and one lane for entries that never overlap", () => {
    expect(textLanes([])).toEqual([]);
    expect(textLanes([item(0, 0, 10), item(1, 10, 20), item(2, 30, 40)])).toHaveLength(1);
  });

  it("splits the way the deepest overlap says, and lanes hold no overlaps", () => {
    const lanes = textLanes([
      item(0, 0, 100),
      item(1, 50, 150),
      item(2, 100, 200),
      item(3, 60, 70),
    ]);
    expect(lanes.map((l) => l.map((i) => i.index))).toEqual([[0, 2], [1], [3]]);
  });
});

describe("add_text_clips: placement when no track is named", () => {
  it("skips the occupied track and uses a free one", () => {
    const tl = timeline([{ id: "captions", clips: [clipAt(0, 120)] }, { id: "titles" }]);
    addTextClips(tl, [text(0, 60)]);
    expect(placed(tl)).toEqual({ captions: [[0, 120]], titles: [[0, 60]] });
  });

  it("creates a new track when every existing one is busy", () => {
    const tl = timeline([
      { id: "captions", clips: [clipAt(0, 120)] },
      { id: "captions2", clips: [clipAt(0, 120)] },
    ]);
    addTextClips(tl, [text(0, 60)]);
    expect(tl.tracks.map((t) => t.id)).toEqual(["captions", "captions2", "captions3"]);
    expect(placed(tl).captions3).toEqual([[0, 60]]);
  });

  // The whole batch must fit the SAME track: choosing per-entry would scatter one caller
  // intent across tracks, and picking a track that fits only the first entry would put the
  // rest back into a collision the caller was never told about.
  it("chooses a track the whole batch fits, not just the first entry", () => {
    const tl = timeline([{ id: "captions", clips: [clipAt(200, 260)] }, { id: "titles" }]);
    addTextClips(tl, [text(0, 60), text(200, 260 + 0)]);
    expect(placed(tl).captions).toEqual([[200, 260]]);
    expect(placed(tl).titles).toEqual([
      [0, 60],
      [200, 260],
    ]);
  });

  // Nothing is written until every entry resolves, so a fit check cannot see the clips this
  // same call is about to place on a track another entry named.
  it("keeps auto-placed entries off a track named by another entry in the same call", () => {
    const tl = timeline([{ id: "captions" }]);
    addTextClips(tl, [text(0, 60, { track_id: "captions" }), text(0, 60)]);
    const byTrack = placed(tl);
    expect(byTrack.captions).toEqual([[0, 60]]);
    expect(Object.entries(byTrack).filter(([id]) => id !== "captions")).toEqual([
      ["captions2", [[0, 60]]],
    ]);
  });
});

describe("add_text_clips: a named track is honoured but checked", () => {
  it("refuses an occupied named track and points at a free one", () => {
    const tl = timeline([{ id: "captions", clips: [clipAt(0, 120)] }, { id: "titles" }]);
    expect(() => addTextClips(tl, [text(0, 60, { track_id: "captions" })])).toThrow(
      /already has clips.*track_id:'titles'/s,
    );
  });

  it("names the parameter this tool actually takes, not add_captions'", () => {
    const tl = timeline([{ id: "captions", clips: [clipAt(0, 120)] }]);
    expect(() => addTextClips(tl, [text(0, 60, { track_id: "captions" })])).toThrow(
      /omit track_id/,
    );
    expect(() => addTextClips(tl, [text(0, 60, { track_id: "captions" })])).not.toThrow(
      /text_track_id/,
    );
  });

  it("places on the named track when it has room", () => {
    const tl = timeline([{ id: "captions", clips: [clipAt(0, 60)] }, { id: "titles" }]);
    addTextClips(tl, [text(200, 260, { track_id: "captions" })]);
    expect(placed(tl).captions).toEqual([
      [0, 60],
      [200, 260],
    ]);
    expect(placed(tl).titles).toEqual([]);
  });
});
