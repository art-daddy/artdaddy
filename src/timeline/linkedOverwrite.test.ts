// An overwrite on ONE track must not destroy material on ANOTHER.
//
// Found by alpha-testing the real UI: dropping a music clip onto A1, over the audio half of a
// linked A/V pair, DELETED the video on V1. `clearRegion` drops a cleared clip's linked partners
// on every track, unconditionally — so overwriting the audio half took the video half with it,
// and a 120-frame video overwritten from frame 3 was left 3 frames long. Both public doors
// (add_clips overwrite, and a drag = moveClips) call the same helper, so both lose the same data.
//
// The rule these pin is about the OUTCOME, not the helper: after an overwrite of [s,e) on track T,
// nothing outside T changed except by the same [s,e) window. A partner that survives with a broken
// link is the intended casualty; a partner that disappears is data loss.
import { describe, expect, it } from "vitest";

import { clearRegion } from "./helpers";
import type { Timeline, Track } from "./model";
import { moveClips } from "./operations";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clip = (id: string, tin: number, tout: number, extra: any = {}) => ({
  id,
  media_ref: "cam.mp4",
  timeline_in: tin,
  timeline_out: tout,
  source_in: tin,
  source_out: tout,
  speed: 1,
  ...extra,
});

/** V1 video [0,120) linked to A1 audio [0,120); A2 free for the incoming music. */
const linkedPair = (): Timeline =>
  ({
    canvas: { width: 1920, height: 1080, fps: 30 },
    tracks: [
      { id: "v1", kind: "video", z: 0, clips: [clip("vid", 0, 120, { link_group: "g1" })] },
      { id: "a1", kind: "audio", z: 0, clips: [clip("aud", 0, 120, { link_group: "g1" })] },
      { id: "a2", kind: "audio", z: 1, clips: [clip("music", 0, 120, { media_ref: "song.mp3" })] },
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

const on = (t: Timeline, id: string): Track => t.tracks!.find((x) => x.id === id)!;
const spans = (t: Timeline, id: string) =>
  (on(t, id).clips ?? []).map((c) => [c.timeline_in, c.timeline_out]);

describe("an overwrite on one track does not destroy another track", () => {
  it("clearing ALL of A1 leaves the linked video on V1 standing", () => {
    const t = linkedPair();
    clearRegion(t, on(t, "a1"), 0, 120);
    expect(spans(t, "a1")).toEqual([]); // the region really was cleared
    expect(spans(t, "v1")).toEqual([[0, 120]]); // and the video is untouched
  });

  it("clearing PART of A1 does not truncate the video to the surviving head", () => {
    const t = linkedPair();
    clearRegion(t, on(t, "a1"), 3, 120);
    expect(spans(t, "a1")).toEqual([[0, 3]]);
    expect(spans(t, "v1")).toEqual([[0, 120]]); // the reported repro: V1 was left [0,3)
  });

  it("clearing a MIDDLE slice of A1 leaves the video whole", () => {
    const t = linkedPair();
    clearRegion(t, on(t, "a1"), 40, 80);
    expect(spans(t, "a1")).toEqual([
      [0, 40],
      [80, 120],
    ]);
    expect(spans(t, "v1")).toEqual([[0, 120]]);
  });

  it("the surviving partner is UNLINKED, not silently still paired to a clip that changed", () => {
    const t = linkedPair();
    clearRegion(t, on(t, "a1"), 0, 120);
    expect(on(t, "v1").clips![0].link_group).toBeUndefined();
  });

  // The failure direction: the guard must not have turned clearRegion into a no-op on partners
  // that genuinely sit inside the cleared window on the SAME track.
  it("still clears a linked partner that lies inside the region ON THE CLEARED TRACK", () => {
    const t = linkedPair();
    // Both halves of a pair stacked on a1 (an odd but legal shape): clearing a1 removes both.
    on(t, "a1").clips!.push(clip("aud2", 0, 120, { link_group: "g1" }));
    clearRegion(t, on(t, "a1"), 0, 120);
    expect(spans(t, "a1")).toEqual([]);
  });

  it("dragging a music clip onto A1 over the pair's audio does not delete the video (moveClips)", () => {
    const t = linkedPair();
    moveClips(t, [{ clip_id: "music", to_track: "a1", to_timeline_in: 0 }]);
    expect(spans(t, "a1")).toEqual([[0, 120]]);
    expect(on(t, "a1").clips![0].id).toBe("music");
    expect(spans(t, "v1")).toEqual([[0, 120]]);
  });

  it("dragging over PART of the pair's audio leaves the video full length (moveClips)", () => {
    const t = linkedPair();
    moveClips(t, [{ clip_id: "music", to_track: "a1", to_timeline_in: 3 }]);
    expect(spans(t, "v1")).toEqual([[0, 120]]);
  });

  it("moving the VIDEO half away still carries its own audio partner with it", () => {
    const t = linkedPair();
    moveClips(t, [{ clip_id: "vid", to_timeline_in: 200 }]);
    expect(spans(t, "v1")).toEqual([[200, 320]]);
    expect(spans(t, "a1")).toEqual([[200, 320]]); // the link still moves the pair together
  });
});
