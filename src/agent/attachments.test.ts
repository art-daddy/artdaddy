import { describe, expect, it, vi } from "vitest";

import { collectInferenceAttachments } from "./attachments";
import { HISTORY_FRAME_MAX_BYTES } from "./historyFrames";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const store = {
  resolveRef: vi.fn(async (p: string) => `/abs/${p}`),
  readBytes: vi.fn(async () => new Uint8Array([65, 66])), // "AB"
};

describe("collectInferenceAttachments", () => {
  it("returns [] when there is no active store", async () => {
    expect(await collectInferenceAttachments([{ path: "a.png" }], null)).toEqual([]);
  });

  it("returns [] when rawAttachments is not an array", async () => {
    expect(await collectInferenceAttachments("nope", store as Any)).toEqual([]);
  });

  it("reads each ref into an inference attachment; skips non-objects + ref-less entries", async () => {
    const out = await collectInferenceAttachments(
      [
        { path: "library/a.png", kind: "image", caption: "cap", fps: 4 },
        { path: "b.mp4", kind: "video" },
        null, // skipped: not an object
        { kind: "image" }, // skipped: no path
      ],
      store as Any,
    );
    expect(out).toEqual([
      { kind: "image", b64: btoa("AB"), caption: "cap", fps: 4, ext: ".png" },
      { kind: "video", b64: btoa("AB"), caption: "", fps: undefined, ext: ".mp4" },
    ]);
    expect(store.resolveRef).toHaveBeenCalledWith("library/a.png");
  });

  it("skips a ref whose bytes cannot be read", async () => {
    const bad = {
      resolveRef: vi.fn(async (p: string) => p),
      readBytes: vi.fn(async () => {
        throw new Error("gone");
      }),
    };
    expect(await collectInferenceAttachments([{ path: "x.png" }], bad as Any)).toEqual([]);
  });

  // The chained (pre-history) request carries these bytes too, and a full-size still is tens of MB:
  // one would push the whole request past the server's 64 MB limit and lose the turn (UJ-019).
  it("does not send a picture larger than a history frame may be", async () => {
    const sized = (n: number) => ({
      resolveRef: vi.fn(async (p: string) => p),
      readBytes: vi.fn(async () => new Uint8Array(n)),
    });
    const at = await collectInferenceAttachments(
      [{ path: "a.jpg", kind: "image" }],
      sized(HISTORY_FRAME_MAX_BYTES) as Any,
    );
    expect(at).toHaveLength(1);
    const over = await collectInferenceAttachments(
      [{ path: "a.jpg", kind: "image" }],
      sized(HISTORY_FRAME_MAX_BYTES + 1) as Any,
    );
    expect(over).toEqual([]);
  });
});
