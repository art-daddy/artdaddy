import { describe, expect, it } from "vitest";

import { timelineSources } from "./protocol";
import { emptyTimeline, type Timeline } from "../timeline/model";

function tl(clips: Array<{ media_ref?: string; kind?: string }>): Timeline {
  return {
    ...emptyTimeline(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tracks: [
      {
        id: "t1",
        kind: "video",
        clips: clips.map((c, i) => ({ id: `c${i}`, timeline_in: 0, timeline_out: 10, ...c })),
      },
    ] as any,
  };
}

describe("timelineSources", () => {
  it("returns [] for an empty or missing timeline", () => {
    expect(timelineSources(null)).toEqual([]);
    expect(timelineSources(emptyTimeline())).toEqual([]);
  });

  it("collects distinct image/video sources in first-seen order", () => {
    const t = tl([
      { media_ref: "a.mp4" },
      { media_ref: "b.png" },
      { media_ref: "a.mp4" }, // dup
    ]);
    expect(timelineSources(t)).toEqual(["a.mp4", "b.png"]);
  });

  it("skips audio and text clips", () => {
    const t = tl([
      { media_ref: "voice.mp3", kind: "audio" },
      { kind: "text" },
      { media_ref: "clip.mov" },
      { media_ref: "pic.png" },
    ]);
    expect(timelineSources(t)).toEqual(["clip.mov", "pic.png"]);
  });
});
