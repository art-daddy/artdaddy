// What the preview runtime says when it cannot show something. It used to be a console.warn in a webview nobody reads, so
// "video preview stuck on one frame sometimes" left no record. The questions: is every way a video can fail to show named
// (a typed word, never a message), is a failure said once however often it repeats, and does anything of the file leave
// with it (only the source's id inside the app and a codec family).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PREVIEW_FAILURES } from "../api/editorEvents";
import { PreviewFailureError } from "./previewFailure";
import { startPreviewRuntime, type PreviewScope } from "./previewRuntime";
import type { PreviewInbound, PreviewOutbound } from "./protocol";
import { emptyTimeline, type Timeline } from "../timeline/model";

interface FakeVideo {
  onFailure?: (reason: string) => void;
  codecFamily: string;
  close: ReturnType<typeof vi.fn>;
}
const state = vi.hoisted(() => ({
  videos: [] as FakeVideo[],
  ready: (() => Promise.resolve()) as () => Promise<void>,
  load: vi.fn(),
  family: "",
}));
vi.mock("./renderer", () => ({
  PreviewRenderer: class {
    render = vi.fn();
    setTexture = vi.fn();
    dispose = vi.fn();
    captureJpeg = vi.fn(async () => new Uint8Array([42]).buffer);
    hasTexture = vi.fn(() => false);
  },
}));
vi.mock("./loader", () => ({ loadImage: state.load }));
vi.mock("./videoSource", () => ({
  VideoSource: class {
    dims = { w: 160, h: 96 };
    end = 3.1;
    codecFamily = state.family;
    onFailure?: (reason: string) => void;
    whenReady = vi.fn(() => state.ready());
    pump = vi.fn();
    nearestFrame = vi.fn(() => null);
    idle = vi.fn();
    close = vi.fn();
    constructor(_url: string, onFailure?: (reason: string) => void) {
      this.onFailure = onFailure;
      state.videos.push(this);
    }
  },
}));

const disposals: Array<() => void> = [];
const settle = async () => {
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
};
function timeline(kind: "image" | "video"): Timeline {
  return {
    ...emptyTimeline(),
    canvas: { width: 160, height: 96, fps: 30 },
    tracks: [
      {
        id: "video",
        kind: "video",
        z: 0,
        clips: [
          {
            id: "clip",
            kind,
            media_ref: "asset",
            source_in: 0,
            source_out: 93,
            timeline_in: 0,
            timeline_out: 93,
          },
        ],
      },
    ],
  };
}
function runtime() {
  const messages: PreviewOutbound[] = [];
  const scope: PreviewScope = { onmessage: null, postMessage: (message) => messages.push(message) };
  const dispose = startPreviewRuntime(scope);
  disposals.push(dispose);
  const send = (message: PreviewInbound) =>
    scope.onmessage?.({ data: message } as MessageEvent<PreviewInbound>);
  send({ type: "init", canvas: {} as OffscreenCanvas });
  const failures = () => messages.filter((m) => m.type === "failure");
  return { messages, dispose, send, failures };
}
beforeEach(() => {
  vi.useFakeTimers();
  state.videos.length = 0;
  state.ready = () => Promise.resolve();
  state.family = "";
  state.load.mockReset();
});
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.useRealTimers();
});

describe("a video the preview could not read", () => {
  it.each(PREVIEW_FAILURES)("says %s when that is what the file failed with", async (reason) => {
    state.ready = () =>
      Promise.reject(new PreviewFailureError(reason, "the message may name 'My Holiday.mp4'"));
    const { send, failures } = runtime();
    send({
      type: "render",
      timeline: timeline("video"),
      time: 0,
      urls: { asset: "asset://My%20Holiday.mp4" },
    });
    await settle();
    expect(failures()).toEqual([{ type: "failure", source: "asset", reason, codec: "" }]);
  });

  it("a failure nobody typed is `other`, and the decoder's own 'not supported' is `unsupported`", async () => {
    state.ready = () => Promise.reject(new Error("something with C:/Users/me/holiday.mp4 in it"));
    const first = runtime();
    first.send({ type: "render", timeline: timeline("video"), time: 0, urls: { asset: "u1" } });
    await settle();
    expect(first.failures()).toMatchObject([{ reason: "other" }]);

    const notSupported = Object.assign(new Error("config"), { name: "NotSupportedError" });
    state.ready = () => Promise.reject(notSupported);
    const second = runtime();
    second.send({ type: "render", timeline: timeline("video"), time: 0, urls: { asset: "u2" } });
    await settle();
    expect(second.failures()).toMatchObject([{ reason: "unsupported" }]);
  });

  it("says which codec family it was when the index had been read far enough to know", async () => {
    state.family = "hev1";
    state.ready = () =>
      Promise.reject(new PreviewFailureError("read_failed", "range read failed: 500"));
    const { send, failures } = runtime();
    send({ type: "render", timeline: timeline("video"), time: 0, urls: { asset: "u" } });
    await settle();
    expect(failures()).toMatchObject([{ reason: "read_failed", codec: "hev1" }]);
  });

  it("carries nothing of the message or the url", async () => {
    state.ready = () =>
      Promise.reject(new PreviewFailureError("no_index", "C:/Users/me/My Holiday.mp4 has no moov"));
    const { send, messages } = runtime();
    send({
      type: "render",
      timeline: timeline("video"),
      time: 0,
      urls: { asset: "asset://localhost/C%3A/Users/me/My%20Holiday.mp4" },
    });
    await settle();
    expect(JSON.stringify(messages)).not.toMatch(/Holiday|Users|localhost|moov/);
  });

  it("a video that reads fine says nothing", async () => {
    const { send, failures } = runtime();
    send({ type: "render", timeline: timeline("video"), time: 0, urls: { asset: "u" } });
    await settle();
    expect(failures()).toEqual([]);
  });
});

describe("a decoder that stops with an error", () => {
  it("is said as decoder_error with the codec family, once however often it dies again", async () => {
    state.family = "avc1";
    const { send, failures } = runtime();
    send({ type: "render", timeline: timeline("video"), time: 0, urls: { asset: "u" } });
    await settle();
    const video = state.videos[0];
    video.onFailure?.("decoder_error");
    video.onFailure?.("decoder_error");
    video.onFailure?.("decoder_error");
    expect(failures()).toEqual([
      { type: "failure", source: "asset", reason: "decoder_error", codec: "avc1" },
    ]);
  });

  it("a second kind of failure for the same source is a second thing to say", async () => {
    const { send, failures } = runtime();
    send({ type: "render", timeline: timeline("video"), time: 0, urls: { asset: "u" } });
    await settle();
    state.videos[0].onFailure?.("decoder_error");
    state.videos[0].onFailure?.("unsupported");
    expect(failures().map((f) => (f as { reason: string }).reason)).toEqual([
      "decoder_error",
      "unsupported",
    ]);
  });

  it("says nothing after the preview has been closed", async () => {
    const { send, dispose, failures } = runtime();
    send({ type: "render", timeline: timeline("video"), time: 0, urls: { asset: "u" } });
    await settle();
    dispose();
    state.videos[0].onFailure?.("decoder_error");
    expect(failures()).toEqual([]);
  });
});

describe("a picture that would not load", () => {
  it("is image_failed, once", async () => {
    state.load.mockRejectedValue(new Error("decode of C:/Users/me/photo.png failed"));
    const { send, failures, messages } = runtime();
    send({ type: "render", timeline: timeline("image"), time: 0, urls: { asset: "u" } });
    await settle();
    expect(failures()).toEqual([
      { type: "failure", source: "asset", reason: "image_failed", codec: "" },
    ]);
    expect(JSON.stringify(messages)).not.toMatch(/Users|photo/);
  });
});
