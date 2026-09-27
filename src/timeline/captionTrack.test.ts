// Where add_captions is allowed to put a caption group.
//
// A real session: the model named `text_track_id: "captions"`, that track already held a title
// ending at frame 60, and captions starting at frame 2 were appended behind it. The whole call
// died deep in validation on `captions.clips[1]: timeline_in=2 overlaps previous clip` and
// changed nothing â€” after doing all the work. Naming a track used to skip the fit check the
// unnamed path already did.
import { describe, expect, it } from "vitest";

import { resolveTextTrack } from "./helpers";
import { emptyTimeline, type Clip, type Timeline } from "./model";

function textTrack(id: string, clips: Array<[number, number]>): Timeline["tracks"][number] {
  return {
    id,
    kind: "text",
    z: 1,
    clips: clips.map(([tin, tout], i) => ({
      id: `${id}_${i}`,
      kind: "text",
      timeline_in: tin,
      timeline_out: tout,
    })) as Clip[],
  };
}

const spans = [
  { in: 2, out: 40 },
  { in: 40, out: 90 },
];

describe("resolveTextTrack", () => {
  it("uses a named track that is free", () => {
    const tl = emptyTimeline();
    tl.tracks = [textTrack("captions", [])];
    expect(resolveTextTrack(tl, "captions", spans).id).toBe("captions");
  });

  // The reported failure. It must refuse BEFORE building anything, not fail validation after.
  it("refuses a named track that is already occupied", () => {
    const tl = emptyTimeline();
    tl.tracks = [textTrack("captions", [[0, 60]])];
    expect(() => resolveTextTrack(tl, "captions", spans)).toThrow(/already has clips/);
  });

  // A refusal the model cannot act on is barely better than the validation error it replaced.
  it("names a free track to use instead, when there is one", () => {
    const tl = emptyTimeline();
    tl.tracks = [textTrack("captions", [[0, 60]]), textTrack("captions2", [])];
    expect(() => resolveTextTrack(tl, "captions", spans)).toThrow(/captions2/);
  });

  it("tells the caller to omit the track when nothing is free", () => {
    const tl = emptyTimeline();
    tl.tracks = [textTrack("captions", [[0, 60]])];
    expect(() => resolveTextTrack(tl, "captions", spans)).toThrow(/omit text_track_id/);
  });

  // The unnamed path was already correct and must stay that way: a pre-existing title is not
  // a reason to fail, it is a reason to use another lane.
  it("routes around an occupied track when none was named", () => {
    const tl = emptyTimeline();
    tl.tracks = [textTrack("titles", [[0, 60]])];
    expect(resolveTextTrack(tl, null, spans).id).not.toBe("titles");
  });

  it("reuses a free existing track when none was named", () => {
    const tl = emptyTimeline();
    tl.tracks = [textTrack("titles", [[0, 60]]), textTrack("captions", [])];
    expect(resolveTextTrack(tl, null, spans).id).toBe("captions");
  });
});
