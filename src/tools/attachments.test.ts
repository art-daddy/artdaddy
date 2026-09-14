import { describe, expect, it } from "vitest";

import { audioAttachment, imageAttachment, videoAttachment } from "./attachments";

describe("attachment builders", () => {
  it("image/audio carry path + kind + caption", () => {
    expect(imageAttachment("/a.png", "cap")).toEqual({
      path: "/a.png",
      kind: "image",
      caption: "cap",
    });
    expect(audioAttachment("/a.mp3")).toEqual({ path: "/a.mp3", kind: "audio", caption: "" });
  });
  it("video omits fps unless given", () => {
    expect(videoAttachment("/v.mp4", "c")).toEqual({ path: "/v.mp4", kind: "video", caption: "c" });
    expect(videoAttachment("/v.mp4", "c", 4)).toEqual({
      path: "/v.mp4",
      kind: "video",
      caption: "c",
      fps: 4,
    });
  });
});
