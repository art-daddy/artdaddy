import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMainThreadPreview, startPreviewRuntime, type PreviewScope } from "./previewRuntime";
import type { PreviewInbound, PreviewOutbound } from "./protocol";
import { emptyTimeline, type Timeline } from "../timeline/model";

const state = vi.hoisted(() => ({
  renderers: [] as Array<{
    render: ReturnType<typeof vi.fn>;
    setTexture: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    captureJpeg: ReturnType<typeof vi.fn>;
  }>,
  videos: [] as Array<{ close: ReturnType<typeof vi.fn> }>,
  load: vi.fn(),
}));
vi.mock("./renderer", () => ({
  PreviewRenderer: class {
    render = vi.fn();
    setTexture = vi.fn();
    dispose = vi.fn();
    captureJpeg = vi.fn(async () => new Uint8Array([42]).buffer);
    hasTexture = vi.fn(() => false);
    constructor() {
      state.renderers.push(this);
    }
  },
}));
vi.mock("./loader", () => ({ loadImage: state.load }));
vi.mock("./videoSource", () => ({
  VideoSource: class {
    dims = { w: 160, h: 96 };
    end = 3.1;
    whenReady = vi.fn(async () => undefined);
    pump = vi.fn();
    nearestFrame = vi.fn(() => null);
    idle = vi.fn();
    close = vi.fn();
    constructor() {
      state.videos.push(this);
    }
  },
}));

const disposals: Array<() => void> = [];
const settle = async () => {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
};
function timeline(kind: "image" | "video" = "image"): Timeline {
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
  return { messages, dispose, send, renderer: state.renderers.at(-1)! };
}
beforeEach(() => {
  vi.useFakeTimers();
  state.renderers.length = 0;
  state.videos.length = 0;
  state.load.mockReset();
});
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.useRealTimers();
});

describe("shared preview runtime ownership", () => {
  it("stops scheduled drawing and releases its renderer exactly once", async () => {
    const { send, dispose, renderer, messages } = runtime();
    send({ type: "render", timeline: timeline(), time: 0, urls: {} });
    await vi.advanceTimersByTimeAsync(16);
    expect(renderer.render).toHaveBeenCalledOnce();
    const emitted = messages.length;
    dispose();
    dispose();
    await vi.advanceTimersByTimeAsync(160);
    expect(renderer.render).toHaveBeenCalledOnce();
    expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(messages).toHaveLength(emitted);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes a delayed image rather than uploading it after disposal", async () => {
    let finish!: (value: unknown) => void;
    state.load.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { send, dispose, renderer, messages } = runtime();
    send({ type: "render", timeline: timeline(), time: 0, urls: { asset: "old" } });
    dispose();
    const bitmap = { close: vi.fn() };
    finish({ bitmap, dims: { w: 100, h: 100 } });
    await settle();
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(renderer.setTexture).not.toHaveBeenCalled();
    expect(messages.filter((message) => message.type === "dims")).toHaveLength(0);
  });

  it("cannot replace a new source's texture and dimensions with an older completion", async () => {
    let finish!: (value: unknown) => void;
    const old = { close: vi.fn() };
    const fresh = { close: vi.fn() };
    state.load.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    state.load.mockResolvedValueOnce({ bitmap: fresh, dims: { w: 200, h: 100 } });
    const { send, renderer, messages } = runtime();
    send({ type: "render", timeline: timeline(), time: 0, urls: { asset: "old" } });
    send({ type: "render", timeline: timeline(), time: 0, urls: { asset: "new" } });
    await settle();
    finish({ bitmap: old, dims: { w: 100, h: 100 } });
    await settle();
    expect(renderer.setTexture.mock.calls).toEqual([["asset", fresh]]);
    expect(messages.filter((message) => message.type === "dims")).toEqual([
      { type: "dims", source: "asset", w: 200, h: 100 },
    ]);
    expect(old.close).toHaveBeenCalledOnce();
    expect(fresh.close).toHaveBeenCalledOnce();
  });

  it("retires all video decoders without continuing to draw", async () => {
    const { send, dispose, renderer } = runtime();
    send({ type: "render", timeline: timeline("video"), time: 0, urls: { asset: "video" } });
    await settle();
    expect(state.videos).toHaveLength(1);
    dispose();
    await vi.advanceTimersByTimeAsync(160);
    expect(state.videos[0].close).toHaveBeenCalledOnce();
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it("does not emit a capture that completes after the runtime was disposed", async () => {
    let finish!: (bytes: ArrayBuffer) => void;
    const { send, dispose, renderer, messages } = runtime();
    renderer.captureJpeg.mockReturnValueOnce(
      new Promise<ArrayBuffer>((resolve) => {
        finish = resolve;
      }),
    );
    send({ type: "render", timeline: timeline(), time: 0, urls: {} });
    send({ type: "capture", requestId: 7 });
    dispose();
    finish(new Uint8Array([42]).buffer);
    await settle();
    expect(messages.filter((message) => message.type === "captured")).toHaveLength(0);
  });

  it("drops queued local work and closes its bitmap when terminated before delivery", async () => {
    const endpoint = createMainThreadPreview();
    disposals.push(() => endpoint.terminate());
    const received = vi.fn();
    endpoint.onmessage = received;
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    endpoint.postMessage({ type: "init", canvas: {} as HTMLCanvasElement });
    endpoint.postMessage({ type: "textBitmap", key: "caption", bitmap });
    endpoint.terminate();
    await settle();
    expect(state.renderers).toHaveLength(0);
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(received).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
