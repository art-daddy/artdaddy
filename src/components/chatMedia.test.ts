import { describe, expect, it } from "vitest";

import { attachmentKind, mediaKindFromName } from "./chatMedia";

describe("attachmentKind", () => {
  it("maps by mime prefix, defaulting to image", () => {
    expect(attachmentKind("video/mp4")).toBe("video");
    expect(attachmentKind("audio/mpeg")).toBe("audio");
    expect(attachmentKind("image/png")).toBe("image");
    expect(attachmentKind("application/pdf")).toBe("image");
  });
});

describe("mediaKindFromName", () => {
  it("maps by extension (case-insensitive), defaulting to image", () => {
    expect(mediaKindFromName("a.MP4")).toBe("video");
    expect(mediaKindFromName("b.wav")).toBe("audio");
    expect(mediaKindFromName("c.png")).toBe("image");
    expect(mediaKindFromName("noext")).toBe("image");
  });
});
