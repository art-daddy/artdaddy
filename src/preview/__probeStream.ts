// Dev-only probe for e2e/ui/stream.spec.ts. Drives the preview's own decoder (VideoSource) through
// the PLAYBACK path the preview worker runs - pump(t) then nearestFrame(t) on a ~60 Hz tick
// (previewWorker.ts render()) - and reports which decoded frame each source time shows, and where
// the decoder says the media ends. Nothing is read back from the decoder's internals: a frame is
// "shown" when nearestFrame hands one over, exactly as the worker would upload it.
//
// A clip of two frames never drew in playback (UJ-034): the decoder holds the last frames of a
// stream back to reorder them, and pump never told it the stream had ended. Not part of the build.
import { VideoSource } from "./videoSource";
import type { PreviewOutbound } from "./protocol";
import type { Timeline } from "../timeline/model";

export interface WorkerSeekShot {
  time: number;
  pixel: number[];
  matched: boolean;
}

export interface WorkerSeekResult {
  shots: WorkerSeekShot[];
  errors: string[];
}

export interface StreamShot {
  /** Where the decoder says the media ends, in source seconds (UJ-033). */
  end: number;
  /** The timestamp (microseconds) of the frame shown at source time k/fps; null when nothing was. */
  shown: Array<number | null>;
  error?: string;
}

const TICK_MS = 16; // the worker's loop
const PATIENCE = 90; // ticks (~1.5 s) a frame may take before it counts as never shown

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
      for (let n = 0; n < PATIENCE && !frame; n++) {
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
  const worker = new Worker(new URL("./previewWorker.ts", import.meta.url), { type: "module" });
  const captures = new Map<number, (bytes: Uint8Array | null) => void>();
  const errors: string[] = [];
  let sequence = 0;
  worker.onmessage = (event: MessageEvent<PreviewOutbound>) => {
    const message = event.data;
    if (message.type === "error") errors.push(message.message);
    if (message.type !== "captured") return;
    const complete = captures.get(message.requestId);
    if (!complete) return;
    captures.delete(message.requestId);
    complete(message.bytes ? new Uint8Array(message.bytes) : null);
  };
  const capture = () =>
    new Promise<Uint8Array | null>((resolve) => {
      const requestId = ++sequence;
      captures.set(requestId, resolve);
      worker.postMessage({ type: "capture", requestId, maxEdge: 160 });
      setTimeout(() => {
        if (captures.delete(requestId)) resolve(null);
      }, 4000);
    });
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
    const offscreen = canvas.transferControlToOffscreen();
    worker.postMessage({ type: "init", canvas: offscreen }, [offscreen]);
    worker.postMessage({
      type: "render",
      timeline,
      time: 0.4,
      urls: {
        recording: new URL("/e2e/ui/fixtures/mac-recording-preview.mp4", location.href).href,
      },
    });
    let previousTime = 0.4;
    for (const [time, expected] of [
      [0.4, "red"],
      [2, "green"],
      [0.4, "red"],
      [2.9, "green"],
      [0.4, "red"],
    ] as const) {
      for (let frame = Math.round(previousTime * 30) + 1; frame < Math.round(time * 30); frame++) {
        worker.postMessage({ type: "seek", time: frame / 30 });
        await sleep(TICK_MS);
      }
      worker.postMessage({ type: "seek", time });
      let pixel: number[] = [];
      let matched = false;
      for (let attempt = 0; attempt < PATIENCE && !matched; attempt++) {
        const bytes = await capture();
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
      shots.push({ time, pixel, matched });
      previousTime = time;
    }
    return { shots, errors };
  } finally {
    worker.terminate();
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
