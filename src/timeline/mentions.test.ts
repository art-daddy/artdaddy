import { describe, expect, it } from "vitest";

import type { Clip } from "./model";
import {
  buildClipMention,
  buildMediaMention,
  buildPlayheadMention,
  buildRangeMention,
  formatTimecode,
  mentionKey,
  mentionLabel,
  RANGE_SEMANTICS,
} from "./mentions";

describe("formatTimecode", () => {
  it("formats HH:MM:SS:FF at fps", () => {
    expect(formatTimecode(0, 30)).toBe("00:00:00:00");
    expect(formatTimecode(45, 30)).toBe("00:00:01:15"); // 1s + 15 frames
    expect(formatTimecode(30 * 3661 + 7, 30)).toBe("01:01:01:07");
  });
  it("clamps negatives and rounds", () => {
    expect(formatTimecode(-5, 30)).toBe("00:00:00:00");
    expect(formatTimecode(29.6, 30)).toBe("00:00:01:00");
  });
});

describe("buildPlayheadMention", () => {
  it("carries frame, fps, and a derived timecode", () => {
    const m = buildPlayheadMention(90, 30);
    expect(m).toEqual({ kind: "playhead", frame: 90, fps: 30, timecode: "00:00:03:00" });
  });
});

describe("buildRangeMention", () => {
  it("is half-open, ordered, with derived timecodes + semantics", () => {
    const m = buildRangeMention(90, 30, 30); // reversed input
    expect(m.startFrame).toBe(30);
    expect(m.endFrame).toBe(90);
    expect(m.durationFrames).toBe(60);
    expect(m.startTimecode).toBe("00:00:01:00");
    expect(m.endTimecode).toBe("00:00:03:00");
    expect(m.durationTimecode).toBe("00:00:02:00");
    expect(m.semantics).toBe(RANGE_SEMANTICS);
  });
});

describe("buildClipMention", () => {
  it("summarises a clip in frames, omitting default speed", () => {
    const clip = {
      id: "clip_a",
      timeline_in: 10,
      timeline_out: 70,
      media_ref: "library/x.mp4",
      speed: 1,
    } as unknown as Clip;
    expect(buildClipMention(clip, "v1")).toEqual({
      kind: "clip",
      clipId: "clip_a",
      trackId: "v1",
      startFrame: 10,
      endFrame: 70,
      source: "library/x.mp4",
    });
  });
  it("keeps a non-default speed", () => {
    const clip = { id: "c", timeline_in: 0, timeline_out: 50, speed: 1.2 } as unknown as Clip;
    expect(buildClipMention(clip).speed).toBe(1.2);
  });
});

describe("buildMediaMention", () => {
  it("references a library asset by ref", () => {
    expect(buildMediaMention("library/clip_x.mp4", "hero.mp4", "video")).toEqual({
      kind: "media",
      ref: "library/clip_x.mp4",
      name: "hero.mp4",
      mediaKind: "video",
    });
  });
});

describe("mentionLabel / mentionKey", () => {
  it("labels and keys each kind", () => {
    const p = buildPlayheadMention(30, 30);
    const r = buildRangeMention(0, 60, 30);
    const c = buildClipMention({ id: "c1", timeline_in: 0, timeline_out: 30 } as unknown as Clip);
    const media = buildMediaMention("library/a.mp4", "a.mp4");
    expect(mentionLabel(p)).toContain("playhead");
    expect(mentionLabel(media)).toBe("a.mp4");
    expect(mentionKey(p)).toBe("playhead:30");
    expect(mentionKey(r)).toBe("range:0-60");
    expect(mentionKey(c)).toBe("clip:c1");
    expect(mentionKey(media)).toBe("media:library/a.mp4");
  });
});
