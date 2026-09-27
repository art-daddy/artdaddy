import { describe, expect, it } from "vitest";

import { addTextClips } from "./operations";
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

describe("add_text_clips: entries that cannot both render are refused, not built", () => {
  it("names BOTH colliding entries by the caller's own index", () => {
    const tl = timeline([{ id: "captions" }]);
    expect(() => addTextClips(tl, [text(0, 60), text(30, 90)])).toThrow(
      /entries\[1\] \(frames 30-90\) overlaps entries\[0\] \(frames 0-60\)/,
    );
  });

  // The indices must describe what the CALLER wrote. Sorting by time to find collisions makes
  // it easy to report positions in the sorted order instead, which is the same unusable error
  // the validator already gave.
  it("reports caller indices even when the entries arrive out of time order", () => {
    const tl = timeline([{ id: "captions" }]);
    expect(() => addTextClips(tl, [text(200, 260), text(0, 60), text(30, 90)])).toThrow(
      /entries\[2\] \(frames 30-90\) overlaps entries\[1\] \(frames 0-60\)/,
    );
  });

  it("writes NOTHING when it refuses", () => {
    const tl = timeline([{ id: "captions" }]);
    expect(() => addTextClips(tl, [text(0, 60), text(30, 90), text(500, 560)])).toThrow();
    expect(placed(tl)).toEqual({ captions: [] });
  });

  // Touching ranges are the boundary case: frame 60 is the first frame NOT covered by [0,60).
  it("allows entries that merely touch", () => {
    const tl = timeline([{ id: "captions" }]);
    expect(() => addTextClips(tl, [text(0, 60), text(60, 90)])).not.toThrow();
    expect(placed(tl).captions).toEqual([
      [0, 60],
      [60, 90],
    ]);
  });

  it("lets overlapping entries through when the caller separates them by track", () => {
    const tl = timeline([{ id: "captions" }, { id: "titles" }]);
    addTextClips(tl, [text(0, 60, { track_id: "captions" }), text(30, 90, { track_id: "titles" })]);
    expect(placed(tl)).toEqual({ captions: [[0, 60]], titles: [[30, 90]] });
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
