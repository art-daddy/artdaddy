import { describe, expect, it } from "vitest";

import type { Attachment } from "../api/types";
import type { Mention } from "../timeline/mentions";
import { composeModelText, TIMELINE_CHANGED_NOTE } from "./compose";

describe("composeModelText", () => {
  it("returns the raw text when nothing is attached", () => {
    expect(composeModelText("hello", [], [])).toBe("hello");
  });

  it("says the timeline changed outside the chat only when told so (UJ-028)", () => {
    expect(composeModelText("how long is it?", [], [])).not.toContain(TIMELINE_CHANGED_NOTE);
    const out = composeModelText("how long is it?", [], [], { timelineChanged: true });
    expect(out.startsWith("how long is it?")).toBe(true);
    expect(out).toContain(TIMELINE_CHANGED_NOTE);
    expect(TIMELINE_CHANGED_NOTE).toContain("get_timeline");
  });

  it("renders editor-context mentions (playhead + range + clip)", () => {
    const mentions: Mention[] = [
      { kind: "playhead", frame: 120, fps: 30, timecode: "00:00:04:00" },
      {
        kind: "range",
        startFrame: 30,
        endFrame: 90,
        durationFrames: 60,
        fps: 30,
        startTimecode: "00:00:01:00",
        endTimecode: "00:00:03:00",
        durationTimecode: "00:00:02:00",
        semantics: "startInclusiveEndExclusive",
      },
      {
        kind: "clip",
        clipId: "c1",
        trackId: "v1",
        startFrame: 0,
        endFrame: 45,
        source: "library/a.mp4",
      },
    ];
    const out = composeModelText("cut here", [], mentions);
    expect(out).toContain("cut here");
    expect(out).toContain("playhead: frame 120 (00:00:04:00)");
    expect(out).toContain("range: frames [30, 90)");
    expect(out).toContain("clip c1 on track v1: frames [0, 45), source library/a.mp4");
  });

  it("lists attached assets by ref, pointing at inspect_media", () => {
    const atts: Attachment[] = [
      { path: "library/clip_abc.png", kind: "image", caption: "shot.png" },
    ];
    const out = composeModelText("look", atts, []);
    expect(out).toContain("look");
    expect(out).toContain("inspect_media");
    expect(out).toContain("image (shot.png): library/clip_abc.png");
  });

  it("combines text + mentions + attachments", () => {
    const out = composeModelText(
      "do it",
      [{ path: "library/a.mp4", kind: "video", caption: null }],
      [{ kind: "media", ref: "library/a.mp4", name: "a.mp4" }],
    );
    expect(out.startsWith("do it")).toBe(true);
    expect(out).toContain("media asset library/a.mp4");
    expect(out).toContain("video");
  });
});
