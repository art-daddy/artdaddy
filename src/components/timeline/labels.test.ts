import { describe, expect, it } from "vitest";

import { clipId, clipLabel, findClipWithTrack, trackLabels } from "./labels";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe("clipId", () => {
  it("uses the clip id, else the fallback", () => {
    expect(clipId({ id: "c1" } as Any, "f")).toBe("c1");
    expect(clipId({} as Any, "f")).toBe("f");
  });
});

describe("clipLabel", () => {
  it("returns the file name for media clips", () => {
    expect(clipLabel({ kind: "video", media_ref: "library/a b.mp4" } as Any)).toBe("a b.mp4");
    expect(clipLabel({ kind: "video", media_ref: "C:\\x\\y.mov" } as Any)).toBe("y.mov");
  });
  it("returns the text for text clips (string or {content})", () => {
    expect(clipLabel({ kind: "text", text: "hello" } as Any)).toBe("hello");
    expect(clipLabel({ kind: "text", text: { content: "hi" } } as Any)).toBe("hi");
    expect(clipLabel({ kind: "text" } as Any)).toBe("text");
  });
});

describe("trackLabels", () => {
  it("numbers per kind in array order", () => {
    expect(
      trackLabels([
        { kind: "video" },
        { kind: "audio" },
        { kind: "video" },
        { kind: "text" },
      ] as Any),
    ).toEqual(["v1", "a1", "v2", "t1"]);
  });
});

describe("findClipWithTrack", () => {
  it("finds the clip + its track id, or null", () => {
    const tracks = [
      { id: "T1", clips: [{ id: "c1" }] },
      { id: "T2", clips: [{ id: "c2" }] },
    ] as Any;
    expect(findClipWithTrack(tracks, "c2")).toEqual({ clip: { id: "c2" }, trackId: "T2" });
    expect(findClipWithTrack(tracks, "nope")).toBeNull();
  });
});
