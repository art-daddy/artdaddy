import { beforeEach, describe, expect, it, vi } from "vitest";

import { IndexCoordinator } from "./indexCoordinator";
import type { Timeline } from "../timeline/model";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// Mocks must be hoisted so the vi.mock factories can reference them.
const { processImportedMedia, clearSourceUrlCache } = vi.hoisted(() => ({
  processImportedMedia: vi.fn(async () => false),
  clearSourceUrlCache: vi.fn(),
}));
vi.mock("../preview/mediaProxy", () => ({ processImportedMedia }));
vi.mock("../preview/resolve", () => ({ clearSourceUrlCache }));

const runner = { run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) } as Any;
const makeRunner = async () => runner as Any;
const fakeStore = (clips: { path: string; status?: string; id?: string }[] = []): Any => ({
  projectDir: "C:/p",
  listClips: vi.fn(async () => clips),
});

function tl(clips: { media_ref: string; kind?: string }[]): Timeline {
  return {
    canvas: { width: 1, height: 1, fps: 30 },
    tracks: [
      {
        id: "v",
        clips: clips.map((c, i) => ({ id: `c${i}`, ...c, timeline_in: 0, timeline_out: 1 })),
      },
    ],
  } as Any;
}

async function settle(pred: () => boolean, ms = 1000): Promise<void> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5));
}

beforeEach(() => {
  processImportedMedia.mockReset();
  processImportedMedia.mockResolvedValue(false);
  clearSourceUrlCache.mockReset();
});

describe("IndexCoordinator", () => {
  // The seen-set is permanent, so indexing a file that does not exist yet burns that asset's
  // ONLY chance at a proxy and a transcript — it would never be retried.
  it("skips media that is still generating, then indexes it once it lands", async () => {
    const store = fakeStore([
      { id: "media_gen_a", path: "library/media_gen_a.mp4", status: "generating" },
    ]);
    const c = new IndexCoordinator(store, makeRunner, vi.fn(), vi.fn());

    await c.sweep(tl([{ media_ref: "media_gen_a" }]));
    await settle(() => processImportedMedia.mock.calls.length > 0, 60);
    expect(processImportedMedia).not.toHaveBeenCalled();

    // It landed: the row loses its status, and the NEXT sweep must pick it up.
    store.listClips = vi.fn(async () => [{ id: "media_gen_a", path: "library/media_gen_a.mp4" }]);
    await c.sweep(tl([{ media_ref: "media_gen_a" }]));
    await settle(() => processImportedMedia.mock.calls.length > 0);
    expect(processImportedMedia).toHaveBeenCalledTimes(1);
  });

  // The poster IS the library tile and the timeline thumbnail. Placing a clip must not be
  // what earns one: an asset imported by the agent, generated, or left over when the queue
  // never drained sat in the library with a blank tile forever, because `seen` is permanent
  // and only the timeline loop enqueued the proxy pass.
  it("gives a library video a poster even though it is on NO track", async () => {
    const store = fakeStore([{ id: "media_x", path: "library/media_x.mp4" }]);
    const c = new IndexCoordinator(store, makeRunner, vi.fn(), vi.fn());

    await c.sweep(tl([])); // empty timeline: nothing placed

    await settle(() => processImportedMedia.mock.calls.length > 0);
    expect(
      processImportedMedia,
      "an unplaced library video must still get its poster pass",
    ).toHaveBeenCalledTimes(1);
  });

  it("does not run the poster pass on audio, which has no frame to extract", async () => {
    const store = fakeStore([{ id: "media_a", path: "library/media_a.wav" }]);
    const c = new IndexCoordinator(store, makeRunner, vi.fn(), vi.fn());

    await c.sweep(tl([]));
    await new Promise((r) => setTimeout(r, 20));
    expect(processImportedMedia).not.toHaveBeenCalled();
  });

  it("never indexes media whose generation failed", async () => {
    const store = fakeStore([
      { id: "media_gen_b", path: "library/media_gen_b.mp3", status: "failed" },
    ]);
    const c = new IndexCoordinator(store, makeRunner, vi.fn(), vi.fn());

    await c.sweep(tl([{ media_ref: "media_gen_b", kind: "audio" }]));
    await new Promise((r) => setTimeout(r, 20));
    expect(processImportedMedia).not.toHaveBeenCalled();
  });

  it("indexes a timeline video for preview without starting transcription", async () => {
    processImportedMedia.mockImplementation(async () => {
      return false;
    });
    const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
    await c.sweep(tl([{ media_ref: "library/a.mp4" }]));
    await settle(() => processImportedMedia.mock.calls.length > 0);
    expect(processImportedMedia).toHaveBeenCalledTimes(1);
  });

  it("clears the URL cache + bumps the preview when a new proxy lands", async () => {
    processImportedMedia.mockResolvedValue(true);
    const onProxy = vi.fn();
    const c = new IndexCoordinator(fakeStore(), makeRunner, onProxy, vi.fn());
    await c.sweep(tl([{ media_ref: "library/a.mp4" }]));
    await settle(() => onProxy.mock.calls.length > 0);
    expect(clearSourceUrlCache).toHaveBeenCalled();
    expect(onProxy).toHaveBeenCalled();
  });

  it("toggles the importing overlay around a proxy transcode", async () => {
    const setImporting = vi.fn();
    (processImportedMedia as Any).mockImplementation(
      async (_s: Any, _r: Any, _src: Any, mark?: () => void) => {
        mark?.();
        return true;
      },
    );
    const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), setImporting);
    await c.sweep(tl([{ media_ref: "library/a.mp4" }]));
    await settle(() => setImporting.mock.calls.length >= 2);
    expect(setImporting).toHaveBeenNthCalledWith(1, true);
    expect(setImporting).toHaveBeenLastCalledWith(false);
  });

  it("indexes previewable library assets off the timeline and dedups repeat sweeps", async () => {
    const c = new IndexCoordinator(
      fakeStore([{ path: "library/lib.mp4" }]),
      makeRunner,
      vi.fn(),
      vi.fn(),
    );
    await c.sweep(tl([{ media_ref: "library/a.mp4" }]));
    await settle(() => processImportedMedia.mock.calls.length >= 2);
    await c.sweep(tl([{ media_ref: "library/a.mp4" }])); // same media -> no new work
    await new Promise((r) => setTimeout(r, 20));
    expect(processImportedMedia).toHaveBeenCalledTimes(2); // timeline + library video
  });

  it("skips the proxy for audio-only clips and no-ops after dispose", async () => {
    const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
    await c.sweep(tl([{ media_ref: "library/song.mp3", kind: "audio" }]));
    await new Promise((r) => setTimeout(r, 20));
    expect(processImportedMedia).not.toHaveBeenCalled();
    c.dispose();
    c.indexSource("library/b.mp4");
    await new Promise((r) => setTimeout(r, 20));
    expect(processImportedMedia).not.toHaveBeenCalled();
  });

  it("dispose() aborts the IN-FLIGHT proxy job, not just the queue", async () => {
    let captured: AbortSignal | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    (processImportedMedia as Any).mockImplementation(
      async (_s: Any, _r: Any, _src: Any, _mark: Any, signal?: AbortSignal) => {
        captured = signal;
        await gate; // stay in-flight (like a running ffmpeg) until released
        return false;
      },
    );
    const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
    await c.sweep(tl([{ media_ref: "library/a.mp4" }]));
    await settle(() => captured !== undefined);
    expect(captured?.aborted).toBe(false); // running, not yet disposed
    c.dispose();
    expect(captured?.aborted).toBe(true); // dispose kills the in-flight process' signal
    release();
    await new Promise((r) => setTimeout(r, 0)); // let the drain unwind
  });
});
