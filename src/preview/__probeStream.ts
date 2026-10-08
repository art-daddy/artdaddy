// Dev-only probe for e2e/ui/stream.spec.ts. Drives the preview's own decoder (VideoSource) through
// the PLAYBACK path the preview worker runs - pump(t) then nearestFrame(t) on a ~60 Hz tick
// (previewWorker.ts render()) - and reports which decoded frame each source time shows, and where
// the decoder says the media ends. Nothing is read back from the decoder's internals: a frame is
// "shown" when nearestFrame hands one over, exactly as the worker would upload it.
//
// A clip of two frames never drew in playback (UJ-034): the decoder holds the last frames of a
// stream back to reorder them, and pump never told it the stream had ended. Not part of the build.
import { VideoSource } from "./videoSource";

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

void (async () => {
  const out: Record<string, StreamShot> = {};
  try {
    // Ten frames with B-frames (I B B B P B B B P P): the decoder reorders, so it holds frames back.
    out["ten_frames"] = await play("stream/ten_frames.mp4", 10, 30);
    // Two frames: the whole clip sits in the decoder's reorder window.
    out["two_frames"] = await play("rotation/h264_rot0.mp4", 2, 30);
    (window as unknown as { __stream: unknown }).__stream = out;
  } catch (e) {
    (window as unknown as { __stream: unknown }).__stream = { error: String(e) };
  }
})();
