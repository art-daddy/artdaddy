// Message protocol between the main thread and the preview worker, plus the
// pure helper that lists a timeline's media sources so the main thread knows
// what to resolve to fetchable URLs (Tauri asset URLs) for the worker. The
// worker itself is browser-only (OffscreenCanvas + WebCodecs) and excluded from
// unit coverage; this contract is pure and tested.
import { clipKind } from "../timeline/helpers";
import type { Timeline } from "../timeline/model";
import type { TextLayer } from "./scene";

export interface PreviewInit {
  type: "init";
  canvas: OffscreenCanvas;
}
export interface PreviewRenderMsg {
  type: "render";
  timeline: Timeline;
  time: number;
  /** source -> fetchable URL, pre-resolved on the main thread. */
  urls: Record<string, string>;
  /** source -> its generated first-frame poster, for sources that have one. Stood in until the
   *  decoder produces a real frame, so a cold start shows a picture instead of black. */
  posters?: Record<string, string>;
}
/** Lightweight time-only update (playback/scrub). Avoids re-cloning the whole
 *  timeline across the worker boundary every frame; the worker reuses the last
 *  render's timeline + urls. */
export interface PreviewSeekMsg {
  type: "seek";
  time: number;
}
/** Grab the CURRENT composited frame as a JPEG (project thumbnail). The worker
 *  renders the last timeline+time, then encodes; the reply carries the bytes. */
export interface PreviewCaptureMsg {
  type: "capture";
  requestId: number;
  /** Longest-edge cap in px for the thumbnail (the worker downscales). */
  maxEdge?: number;
}
/** A text layer rasterized ON THE MAIN THREAD, in reply to `needText`. */
export interface PreviewTextBitmapMsg {
  type: "textBitmap";
  key: string;
  /** Omitted when rasterization failed; the worker just skips that layer. */
  bitmap?: ImageBitmap;
}
export type PreviewInbound =
  PreviewInit | PreviewRenderMsg | PreviewSeekMsg | PreviewCaptureMsg | PreviewTextBitmapMsg;

export interface PreviewRendered {
  type: "rendered";
  time: number;
}
/** Caption text must be rasterized on the MAIN thread: a FontFace added to a
 *  worker's FontFaceSet loads fine but is NOT applied to OffscreenCanvas text
 *  (measured — metrics stay identical to the fallback), so rasterizing here would
 *  silently draw every caption in Times instead of the bundled family. */
export interface PreviewNeedText {
  type: "needText";
  key: string;
  layer: TextLayer;
}
export interface PreviewErrored {
  type: "error";
  message: string;
}
export interface PreviewCaptured {
  type: "captured";
  requestId: number;
  /** JPEG bytes of the composited frame, or omitted when `error` is set. */
  bytes?: ArrayBuffer;
  error?: string;
}
/** An asset's real pixel size, once the worker's decoder knows it. The stage overlay
 *  draws its box where the PICTURE lands, which needs the source aspect — and the
 *  decoders that know it live here, so this is the one place the size is discovered. */
export interface PreviewDims {
  type: "dims";
  source: string;
  w: number;
  h: number;
}
/** Whether a visible video layer currently has NO decoded frame to show. Edge-triggered.
 *  The playhead is driven on the main thread, which cannot otherwise know the picture is
 *  behind it — without this the clock runs on over frames nobody ever sees. Sources that
 *  failed to load are excluded, or an undecodable file would hold playback forever. */
export interface PreviewStalled {
  type: "stalled";
  stalled: boolean;
}
/** One-shot, the first time a DECODED video frame is uploaded. There was no way to tell how long
 *  the first picture takes -- the black at the start of playback was reported by a user and could
 *  only be guessed at -- and the worker owns the moment it happens. */
export interface PreviewFirstFrame {
  type: "firstFrame";
  source: string;
}
export type PreviewOutbound =
  | PreviewRendered
  | PreviewErrored
  | PreviewCaptured
  | PreviewNeedText
  | PreviewDims
  | PreviewStalled
  | PreviewFirstFrame;

/** Distinct image/video sources referenced by the timeline, in first-seen
 *  order (audio/text and non-media sources are skipped). */
export function timelineSources(timeline: Timeline | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tr of timeline?.tracks ?? []) {
    for (const c of tr.clips ?? []) {
      if (c.kind === "audio" || c.kind === "text") continue;
      const src = typeof c.media_ref === "string" ? c.media_ref : "";
      if (!src || seen.has(src)) continue;
      const k = clipKind(c);
      if (k === "image" || k === "video") {
        seen.add(src);
        out.push(src);
      }
    }
  }
  return out;
}
