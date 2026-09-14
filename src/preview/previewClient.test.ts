import { beforeEach, describe, expect, it, vi } from "vitest";

import { createPreviewClient } from "./previewClient";
import { emptyTimeline, type Timeline } from "../timeline/model";
import { useProjectNotice } from "../store/projectNotice";
import type { ProjectStoreAccess } from "../tools/store";

vi.mock("./fonts", () => ({ loadBundledFonts: vi.fn(async () => undefined) }));
vi.mock("./text", () => ({ rasterizeText: vi.fn(() => mockBitmap) }));
let mockBitmap: unknown = { close: () => undefined };

type Msg = Record<string, unknown>;
type Posted = { msg: Msg; transfer?: Transferable[] };

/** A store that can answer what the client actually asks it: where a ref lives and how big it
 *  is. `{}` used to stand in here, which quietly meant "every source is of unknown size". */
const storeOfSize = (size: number | null = 1024) =>
  ({
    resolveRef: async (src: string) => `C:/media/${src}`,
    byteSize: async () => size,
  }) as unknown as ProjectStoreAccess;

class FakeWorker {
  posted: Posted[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  terminated = false;
  postMessage(msg: unknown, transfer?: Transferable[]): void {
    this.posted.push({ msg: msg as Msg, transfer });
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(data: unknown): void {
    this.onmessage?.({ data } as unknown as MessageEvent);
  }
  ofType(type: string): Msg[] {
    return this.posted.filter((p) => p.msg.type === type).map((p) => p.msg);
  }
}

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

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// The notice store is global; without this a leaked message makes the next test's
// "nothing was reported" assertion pass or fail on test ORDER.
beforeEach(() => useProjectNotice.getState().clear());

function setup(resolveImpl?: (s: ProjectStoreAccess, src: string) => Promise<string | null>) {
  const worker = new FakeWorker();
  const offscreen = {} as OffscreenCanvas;
  const transferControlToOffscreen = vi.fn(() => offscreen);
  const canvas = { transferControlToOffscreen } as unknown as HTMLCanvasElement;
  const onError = vi.fn();
  const onStalled = vi.fn();
  const resolve = vi.fn(
    resolveImpl ?? (async (_s: ProjectStoreAccess, src: string) => `url:${src}`),
  );
  const client = createPreviewClient(canvas, {
    createWorker: () => worker as unknown as Worker,
    resolve,
    onError,
    onStalled,
  });
  return { worker, offscreen, transferControlToOffscreen, onError, onStalled, resolve, client };
}

describe("createPreviewClient", () => {
  it("transfers the canvas and posts an init message with the offscreen canvas", () => {
    const { worker, offscreen, transferControlToOffscreen } = setup();
    expect(transferControlToOffscreen).toHaveBeenCalledOnce();
    const init = worker.posted.find((p) => p.msg.type === "init");
    expect(init?.msg).toEqual({ type: "init", canvas: offscreen });
    expect(init?.transfer).toEqual([offscreen]); // canvas ownership handed to the worker
  });

  it("treats a null timeline as a no-op", async () => {
    const { worker, client, resolve } = setup();
    client.render(null, 0);
    await flush();
    expect(resolve).not.toHaveBeenCalled();
    expect(worker.ofType("render")).toHaveLength(0);
    expect(worker.ofType("seek")).toHaveLength(0);
  });

  it("resolves sources and posts a render for a new timeline, dropping unresolved ones", async () => {
    const { worker, client, resolve } = setup(async (_s, src) =>
      src === "b.png" ? null : `url:${src}`,
    );
    client.setStore(storeOfSize());
    const t = tl([{ media_ref: "a.mp4" }, { media_ref: "b.png" }]);
    client.render(t, 0);
    await flush();
    expect(resolve).toHaveBeenCalledTimes(2);
    const render = worker.ofType("render")[0];
    expect(render.type).toBe("render");
    expect(render.timeline).toBe(t);
    expect(render.time).toBe(0);
    expect(render.urls).toEqual({ "a.mp4": "url:a.mp4" }); // b.png -> null, dropped
  });

  it("posts a cheap seek when only the time changes", async () => {
    const { worker, client } = setup();
    client.setStore(storeOfSize());
    const t = tl([{ media_ref: "a.mp4" }]);
    client.render(t, 0);
    await flush();
    client.render(t, 1); // same timeline object
    expect(worker.ofType("seek")).toEqual([{ type: "seek", time: 1 }]);
    expect(worker.ofType("render")).toHaveLength(1); // no re-resolve / re-render
  });

  it("posts a fresh render when the timeline changes again", async () => {
    const { worker, client } = setup();
    client.setStore(storeOfSize());
    const a = tl([{ media_ref: "a.mp4" }]);
    const b = tl([{ media_ref: "c.mov" }]);
    client.render(a, 0);
    await flush();
    client.render(b, 2);
    await flush();
    const renders = worker.ofType("render");
    expect(renders).toHaveLength(2);
    expect(renders[1].timeline).toBe(b);
    expect(renders[1].time).toBe(2);
  });

  it("posts an empty url map when no store is set (resolve is skipped)", async () => {
    const { worker, client, resolve } = setup();
    const t = tl([{ media_ref: "a.mp4" }]);
    client.render(t, 0); // no setStore
    await flush();
    expect(resolve).not.toHaveBeenCalled();
    expect(worker.ofType("render")[0].urls).toEqual({});
  });

  it("capture() posts a capture request and resolves with the returned JPEG bytes", async () => {
    const { worker, client } = setup();
    const p = client.capture(320);
    const req = worker.ofType("capture")[0];
    expect(req.type).toBe("capture");
    expect(req.maxEdge).toBe(320);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    worker.emit({ type: "captured", requestId: req.requestId, bytes: bytes.buffer });
    expect(await p).toEqual(bytes);
  });

  it("capture() resolves null when the worker reports an error (no bytes)", async () => {
    const { worker, client } = setup();
    const p = client.capture();
    const req = worker.ofType("capture")[0];
    worker.emit({ type: "captured", requestId: req.requestId, error: "no webgl" });
    expect(await p).toBeNull();
  });

  it("capture() ignores a mismatched requestId, then resolves on the real reply", async () => {
    const { worker, client } = setup();
    const p = client.capture();
    const req = worker.ofType("capture")[0];
    worker.emit({
      type: "captured",
      requestId: (req.requestId as number) + 999,
      bytes: new Uint8Array([9]).buffer,
    });
    worker.emit({ type: "captured", requestId: req.requestId, bytes: new Uint8Array([7]).buffer });
    expect(await p).toEqual(new Uint8Array([7]));
  });

  it("forwards worker error messages to onError", () => {
    const { worker, onError } = setup();
    worker.emit({ type: "error", message: "no webgl2" });
    expect(onError).toHaveBeenCalledWith("no webgl2");
  });

  it("ignores non-error worker messages", () => {
    const { worker, onError } = setup();
    worker.emit({ type: "rendered", time: 3 });
    expect(onError).not.toHaveBeenCalled();
  });

  it("forwards stall reports in BOTH directions", () => {
    // Recovery is the half that would strand playback: a hold that is never lifted is a
    // freeze, so dropping the false is worse than dropping the true.
    const { worker, onStalled } = setup();
    worker.emit({ type: "stalled", stalled: true });
    expect(onStalled).toHaveBeenLastCalledWith(true);
    worker.emit({ type: "stalled", stalled: false });
    expect(onStalled).toHaveBeenLastCalledWith(false);
  });

  it("does not mistake a stall for a render failure", () => {
    const { worker, onError } = setup();
    worker.emit({ type: "stalled", stalled: true });
    expect(onError).not.toHaveBeenCalled();
  });

  it("terminates the worker on dispose", () => {
    const { worker, client } = setup();
    client.dispose();
    expect(worker.terminated).toBe(true);
  });

  it("drops an in-flight resolve superseded by a newer timeline", async () => {
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((r) => (releaseFirst = r));
    let call = 0;
    const { worker, client } = setup(async (_s, src) => {
      call += 1;
      if (call === 1) await gate; // stall the first timeline's resolve
      return `url:${src}`;
    });
    client.setStore(storeOfSize());
    const a = tl([{ media_ref: "a.mp4" }]);
    const b = tl([{ media_ref: "b.mp4" }]);
    client.render(a, 0); // token 1: slow
    client.render(b, 1); // token 2: fast, supersedes
    await flush();
    releaseFirst(); // let the stale resolve finish — it must NOT post
    await flush();
    const renders = worker.ofType("render");
    expect(renders).toHaveLength(1);
    expect(renders[0].timeline).toBe(b);
  });

  // Captions are rasterized HERE, not in the worker: a FontFace added to a worker
  // loads but never reaches its OffscreenCanvas, so worker-side rendering silently
  // draws every caption in Times. If this round-trip breaks, captions vanish from
  // the preview entirely — nothing else covers it.
  describe("needText round-trip", () => {
    const layer = { text: "hi", box: { w: 10, h: 10 } } as never;

    it("answers with the rasterized bitmap, transferred, under the same key", async () => {
      mockBitmap = { close: () => undefined };
      const { worker } = setup();
      worker.emit({ type: "needText", key: "text:abc", layer });
      await flush();
      const reply = worker.posted.find((p) => p.msg.type === "textBitmap");
      expect(reply?.msg.key).toBe("text:abc");
      expect(reply?.msg.bitmap).toBe(mockBitmap);
      expect(reply?.transfer).toEqual([mockBitmap]); // must transfer, not clone
    });

    it("still replies when rasterization yields nothing, so the worker stops waiting", async () => {
      mockBitmap = null;
      const { worker } = setup();
      worker.emit({ type: "needText", key: "text:none", layer });
      await flush();
      const reply = worker.posted.find((p) => p.msg.type === "textBitmap");
      expect(reply?.msg.key).toBe("text:none");
      expect(reply?.msg.bitmap).toBeUndefined();
      expect(reply?.transfer).toEqual([]);
    });
  });
});
