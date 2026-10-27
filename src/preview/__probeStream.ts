// Dev-only probe for e2e/ui/stream.spec.ts. Drives the preview's own decoder (VideoSource) through
// the PLAYBACK path the preview worker runs - pump(t) then nearestFrame(t) on a ~60 Hz tick
// (previewWorker.ts render()) - and reports which decoded frame each source time shows, and where
// the decoder says the media ends. Nothing is read back from the decoder's internals: a frame is
// "shown" when nearestFrame hands one over, exactly as the worker would upload it.
//
// A clip of two frames never drew in playback (UJ-034): the decoder holds the last frames of a
// stream back to reorder them, and pump never told it the stream had ended. Not part of the build.
import { VideoSource } from "./videoSource";
import { createPreviewClient } from "./previewClient";
import type { PreviewInbound } from "./protocol";
import type { Timeline } from "../timeline/model";
import type { ProjectStoreAccess } from "../tools/store";

export interface WorkerSeekShot {
  time: number;
  pixel: number[];
  matched: boolean;
  /** How long the picture took to appear, in ms: the whole deadline when it never did. */
  waitedMs: number;
}

export interface WorkerSeekResult {
  shots: WorkerSeekShot[];
  errors: string[];
  backend: "worker" | "main-thread" | "unselected";
}

export interface StreamShot {
  /** Where the decoder says the media ends, in source seconds (UJ-033). */
  end: number;
  /** The timestamp (microseconds) of the frame shown at source time k/fps; null when nothing was. */
  shown: Array<number | null>;
  error?: string;
}

const TICK_MS = 16; // the worker's loop
// How long a frame may take before it counts as never shown. A count of ticks was not a duration
// (about 1.5 s plus however long each capture took), and macos-14's decoders stall for seconds at a
// time: the run of 2026-10-27 captured a blank canvas after a seek and nothing at all after the next.
const FRAME_DEADLINE_MS = 8_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function play(file: string, frames: number, fps: number): Promise<StreamShot> {
  const vs = new VideoSource(`/e2e/ui/fixtures/${file}`);
  try {
    await vs.whenReady();
    const shown: Array<number | null> = [];
    for (let k = 0; k < frames; k++) {
      const t = k / fps;
      let frame: VideoFrame | null = null;
      // The worker holds the playhead while a visible layer has no frame (its "stalled" signal),
      // so a frame that is merely slow still shows; one that never comes out does not.
      const deadline = performance.now() + FRAME_DEADLINE_MS;
      while (!frame && performance.now() < deadline) {
        vs.pump(t);
        frame = vs.nearestFrame(t);
        if (!frame) await sleep(TICK_MS);
      }
      shown.push(frame ? frame.timestamp : null);
    }
    return { end: vs.end, shown };
  } catch (e) {
    return { end: Number.NaN, shown: [], error: String(e) };
  } finally {
    vs.close();
  }
}

async function seekInWorker(): Promise<WorkerSeekResult> {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 96;
  document.body.append(canvas);
  const errors: string[] = [];
  let backend: WorkerSeekResult["backend"] = "unselected";
  const forced = new URLSearchParams(location.search).has("forceWorkerUnavailable");
  const unavailable = forced
    ? URL.createObjectURL(
        new Blob(['onmessage=()=>postMessage({type:"capabilities",webgl2:false});'], {
          type: "text/javascript",
        }),
      )
    : null;
  const client = createPreviewClient(canvas, {
    createWorker: () => {
      const worker = unavailable
        ? new Worker(unavailable)
        : new Worker(new URL("./previewWorker.ts", import.meta.url), { type: "module" });
      return {
        get onmessage() {
          return worker.onmessage;
        },
        set onmessage(handler: Worker["onmessage"]) {
          worker.onmessage = handler;
        },
        get onerror() {
          return worker.onerror;
        },
        set onerror(handler: Worker["onerror"]) {
          worker.onerror = handler;
        },
        postMessage(message: PreviewInbound, transfer: Transferable[] = []) {
          if (message.type === "init") backend = "worker";
          worker.postMessage(message, transfer);
        },
        terminate() {
          worker.terminate();
        },
      } as unknown as Worker;
    },
    createFallback: async () => {
      backend = "main-thread";
      return (await import("./previewRuntime")).createMainThreadPreview();
    },
    resolve: async () => new URL("/e2e/ui/fixtures/mac-recording-preview.mp4", location.href).href,
    resolveAnimation: async () => null,
    onError: (message) => errors.push(message),
  });
  client.setStore({
    projectDir: "preview-probe",
    resolveRef: async () => "/e2e/ui/fixtures/mac-recording-preview.mp4",
  } as unknown as ProjectStoreAccess);
  const timeline: Timeline = {
    units: "frames",
    canvas: { width: 160, height: 96, fps: 30 },
    tracks: [
      {
        id: "v1",
        kind: "video",
        z: 0,
        clips: [
          {
            id: "seek-video",
            kind: "video",
            media_ref: "recording",
            timeline_in: 0,
            timeline_out: 93,
            source_in: 0,
            source_out: 93,
          },
        ],
      },
    ],
  };
  const shots: WorkerSeekShot[] = [];
  try {
    client.render(timeline, 0.4);
    let previousTime = 0.4;
    for (const [time, expected] of [
      [0.4, "red"],
      [2, "green"],
      [0.4, "red"],
      [2.9, "green"],
      [0.4, "red"],
    ] as const) {
      for (let frame = Math.round(previousTime * 30) + 1; frame < Math.round(time * 30); frame++) {
        client.render(timeline, frame / 30);
        await sleep(TICK_MS);
      }
      client.render(timeline, time);
      let pixel: number[] = [];
      let matched = false;
      const started = performance.now();
      while (!matched && performance.now() - started < FRAME_DEADLINE_MS) {
        const bytes = await client.capture(160);
        if (bytes) {
          const bitmap = await createImageBitmap(
            new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }),
          );
          const sample = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context = sample.getContext("2d", { willReadFrequently: true })!;
          context.drawImage(bitmap, 0, 0);
          pixel = [
            ...context.getImageData(
              Math.floor(bitmap.width / 2),
              Math.floor(bitmap.height / 2),
              1,
              1,
            ).data,
          ];
          bitmap.close();
          matched = expected === "red" ? pixel[0] > pixel[1] + 60 : pixel[1] > pixel[0] + 60;
        }
        if (!matched) await sleep(TICK_MS);
      }
      shots.push({ time, pixel, matched, waitedMs: Math.round(performance.now() - started) });
      previousTime = time;
    }
    return { shots, errors, backend };
  } finally {
    client.dispose();
    if (unavailable) URL.revokeObjectURL(unavailable);
    canvas.remove();
  }
}

void (async () => {
  const out: Record<string, StreamShot> = {};
  try {
    // Ten frames with B-frames (I B B B P B B B P P): the decoder reorders, so it holds frames back.
    out["ten_frames"] = await play("stream/ten_frames.mp4", 10, 30);
    // Two frames: the whole clip sits in the decoder's reorder window.
    out["two_frames"] = await play("rotation/h264_rot0.mp4", 2, 30);
    (window as unknown as { __workerSeek: WorkerSeekResult }).__workerSeek = await seekInWorker();
    (window as unknown as { __stream: unknown }).__stream = out;
  } catch (e) {
    (window as unknown as { __stream: unknown }).__stream = { error: String(e) };
  }
})();
