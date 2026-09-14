import { describe, expect, it } from "vitest";

import { buildMentionOptions, detectAtQuery, stripAtQuery } from "./mentionOptions";
import type { Timeline } from "./model";

const timeline = {
  canvas: { width: 1920, height: 1080, fps: 30 },
  tracks: [
    {
      id: "v1",
      kind: "video",
      z: 0,
      clips: [{ id: "clip_a", timeline_in: 0, timeline_out: 60, media_ref: "library/a.mp4" }],
    },
  ],
} as unknown as Timeline;

describe("detectAtQuery / stripAtQuery", () => {
  it("detects a trailing @token", () => {
    expect(detectAtQuery("cut this @cl")).toBe("cl");
    expect(detectAtQuery("@")).toBe("");
    expect(detectAtQuery("start @clip_a")).toBe("clip_a");
  });
  it("returns null when not in a fresh @token", () => {
    expect(detectAtQuery("no mention here")).toBeNull();
    expect(detectAtQuery("email a@b after")).toBeNull(); // trailing space/word breaks it
    expect(detectAtQuery("done ")).toBeNull();
  });
  it("strips the trailing @query, keeping leading whitespace", () => {
    expect(stripAtQuery("cut this @cl")).toBe("cut this ");
    expect(stripAtQuery("@clip")).toBe("");
  });
});

describe("buildMentionOptions", () => {
  it("includes playhead, range, clips, and media", () => {
    const opts = buildMentionOptions({
      timeline,
      playheadFrame: 90,
      selectedRange: { startFrame: 0, endFrame: 60 },
      selectedGap: null,
      media: [{ ref: "library/b.mp4", name: "hero.mp4", kind: "video" }],
    });
    const groups = opts.map((o) => o.group);
    expect(groups).toContain("playhead");
    expect(groups).toContain("range");
    expect(groups).toContain("clip");
    expect(groups).toContain("media");
    const clip = opts.find((o) => o.group === "clip");
    expect(clip?.mention.kind).toBe("clip");
  });
  it("omits playhead/range when absent", () => {
    const opts = buildMentionOptions({
      timeline,
      playheadFrame: null,
      selectedRange: null,
      selectedGap: null,
      media: [],
    });
    expect(opts.every((o) => o.group === "clip" || o.group === "gap")).toBe(true);
  });
  it("filters by a case-insensitive query", () => {
    const opts = buildMentionOptions(
      {
        timeline,
        playheadFrame: 90,
        selectedRange: null,
        selectedGap: null,
        media: [{ ref: "library/b.mp4", name: "hero.mp4" }],
      },
      "hero",
    );
    expect(opts).toHaveLength(1);
    expect(opts[0].group).toBe("media");
  });
});
