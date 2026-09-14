// Preview worker (browser-only; coverage-excluded). Owns the WebGL2 renderer on
// a transferred OffscreenCanvas plus the image/video/text caches, and runs the
// composite loop OFF the main thread so a heavy timeline never janks the UI.
//
// The worker MUST NOT touch Tauri (no IPC here): the main thread resolves every
// clip source to a fetchable asset URL and sends it in the `render` message; the
// worker only ever fetch()es those URLs.
import { loadImage } from "./loader";
import type { PreviewInbound, PreviewOutbound } from "./protocol";
import { PreviewRenderer } from "./renderer";
import { type AssetDims, buildScene, type Layer, textLayerToImageLayer } from "./scene";
import { textKey } from "./text";
import { VideoSource } from "./videoSource";
import { clipKind } from "../timeline/helpers";
import type { Timeline } from "../timeline/model";

let renderer: PreviewRenderer | null = null;
const dims = new Map<string, AssetDims>();
const videos = new Map<string, VideoSource>();
const prepared = new Map<string, string>(); // source -> the asset URL its load was kicked off from
const uploaded = new Map<string, number>(); // source -> ts of the frame last drawn
const failed = new Set<string>(); // sources that will never decode here; never stall on these

let timeline: Timeline | null = null;
let urls: Record<string, string> = {};
let posters: Record<string, string> = {};
let time = 0;
let dirty = true;
let lastTime = NaN;
let lastTimeline: Timeline | null = null;
let looping = false;
let stalled = false;

// Minimal worker-global shape (avoids pulling in the WebWorker lib, which
// conflicts with the DOM lib this project compiles against).
interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<PreviewInbound>) => void) | null;
}
const ctx = self as unknown as WorkerScope;
const post = (m: PreviewOutbound): void => ctx.postMessage(m);

// Text keys we've asked the main thread to rasterize, so a cache miss on every
// frame doesn't re-request the same layer 60 times a second.
const textPending = new Set<string>();

ctx.onmessage = (e: MessageEvent<PreviewInbound>) => {
  const msg = e.data;
  if (msg.type === "init") {
    try {
      renderer = new PreviewRenderer(msg.canvas);
    } catch (err) {
      post({ type: "error", message: String(err) });
      return;
    }
    if (!looping) {
      looping = true;
      loop();
    }
  } else if (msg.type === "render") {
    timeline = msg.timeline;
    urls = msg.urls;
    posters = msg.posters ?? {};
    time = msg.time;
    prepare();
  } else if (msg.type === "seek") {
    time = msg.time;
  } else if (msg.type === "capture") {
    void captureThumbnail(msg.requestId, msg.maxEdge);
  } else if (msg.type === "textBitmap") {
    textPending.delete(msg.key);
    if (msg.bitmap && renderer) {
      renderer.setTexture(msg.key, msg.bitmap);
      dirty = true;
    }
  }
};

// Render the CURRENT frame, then encode it to a JPEG for the project thumbnail.
// Forces a render so the framebuffer holds the latest frame (the WebGL context
// is not preserveDrawingBuffer), then reads it back via the renderer.
async function captureThumbnail(requestId: number, maxEdge?: number): Promise<void> {
  try {
    if (!renderer || !timeline?.canvas) throw new Error("nothing to render yet");
    dirty = true;
    render();
    const bytes = await renderer.captureJpeg(maxEdge ?? 480);
    ctx.postMessage({ type: "captured", requestId, bytes }, [bytes]);
  } catch (err) {
    post({ type: "captured", requestId, error: String(err) });
  }
}

// Kick off async loads for any not-yet-seen media source now that we have a URL.
// Keyed by (source -> URL): if a source's resolved URL CHANGES we tear down the
// stale decoder and reload from the new one. This matters most when a generated
// H.264 proxy replaces the original once its transcode finishes — an HEVC/ProRes
// original the WebCodecs decoder can't decode would otherwise stay a black frame.
function prepare(): void {
  for (const tr of timeline?.tracks ?? []) {
    for (const c of tr.clips ?? []) {
      if (c.kind === "audio" || c.kind === "text" || typeof c.media_ref !== "string") continue;
      const src = c.media_ref;
      const url = urls[src];
      if (!url) continue; // not resolved yet — retried on a later render msg
      if (prepared.get(src) === url) continue; // already loaded from this exact URL
      const isReload = prepared.has(src); // same source, but its resolved URL changed -> swap
      prepared.set(src, url);
      if (isReload) {
        videos.get(src)?.close();
        videos.delete(src);
        dims.delete(src);
        uploaded.delete(src);
        failed.delete(src); // a new URL (e.g. a finished proxy) deserves a fresh verdict
      }
      // The clip CARRIES its kind: media_ref is a bare library id with no extension to
      // sniff, and getting this wrong builds NO decoder at all — a black frame and
      // silence, with nothing logged.
      const kind = clipKind(c);
      if (kind === "image") {
        void loadImage(url)
          .then(({ bitmap, dims: d }) => {
            renderer?.setTexture(src, bitmap);
            dims.set(src, d);
            post({ type: "dims", source: src, w: d.w, h: d.h });
            dirty = true;
          })
          .catch((err) => {
            console.warn(`[preview] image load failed: ${src}`, err);
            prepared.delete(src);
          });
      } else if (kind === "video") {
        // Stand the poster in FIRST. Reading the index and decoding from a keyframe takes a
        // beat, and until then this layer has no texture at all, so the compositor shows its
        // black base — which is what pressing play on a cold timeline looked like. Dropped the
        // moment a real frame is uploaded, and it never suppresses the stall signal.
        const posterUrl = posters[src];
        if (posterUrl && !uploaded.has(src)) {
          void loadImage(posterUrl)
            .then(({ bitmap }) => {
              if (uploaded.has(src) || prepared.get(src) !== url) return; // a real frame won
              renderer?.setTexture(src, bitmap);
              dirty = true;
            })
            .catch(() => undefined); // best-effort: no poster just means the old black start
        }
        const vs = new VideoSource(url);
        videos.set(src, vs);
        void vs
          .whenReady()
          .then(() => {
            dims.set(src, vs.dims);
            post({ type: "dims", source: src, w: vs.dims.w, h: vs.dims.h });
            dirty = true;
          })
          .catch((err) => {
            console.warn(`[preview] video not decodable (needs an H.264 proxy?): ${src}`, err);
            failed.add(src);
          });
      }
    }
  }
}

// Workers have no requestAnimationFrame; a ~60fps setTimeout loop off the main
// thread is fine. buildScene + decode pump run here, never on the UI thread.
function loop(): void {
  render();
  setTimeout(loop, 16);
}

function render(): void {
  if (!renderer || !timeline?.canvas) return;
  const tl = timeline;
  const t = time;
  let d = dirty || t !== lastTime || tl !== lastTimeline;
  dirty = false;
  lastTime = t;
  lastTimeline = tl;

  const scene = buildScene(tl, t, dims);
  const visible = new Set<string>();
  // Starved = a layer that IS on screen has no frame to draw yet. Reported so the main
  // thread can hold the playhead instead of running on over pictures nobody sees.
  let starving = false;
  for (const l of scene.layers) {
    if (l.kind !== "video") continue;
    visible.add(l.source);
    const vs = videos.get(l.source);
    if (!vs) {
      if (!failed.has(l.source)) starving = true; // still resolving its URL / being prepared
      continue;
    }
    vs.pump(l.sourceTime ?? 0);
    const frame = vs.nearestFrame(l.sourceTime ?? 0);
    if (frame && uploaded.get(l.source) !== frame.timestamp) {
      renderer.setTexture(l.source, frame); // owned by vs — upload, don't close
      if (!uploaded.has(l.source)) post({ type: "firstFrame", source: l.source });
      uploaded.set(l.source, frame.timestamp);
      d = true;
    }
    if (!frame && !failed.has(l.source)) starving = true;
  }
  if (starving !== stalled) {
    stalled = starving;
    post({ type: "stalled", stalled });
  }
  for (const [src, vs] of videos) {
    if (!visible.has(src)) {
      vs.idle();
      uploaded.delete(src);
    }
  }
  const textLayers: Layer[] = [];
  for (const tx of scene.textLayers) {
    const key = textKey(tx);
    // Rasterized on the MAIN thread (see PreviewNeedText): worker FontFaceSets
    // don't reach OffscreenCanvas, so doing it here draws every caption in Times.
    if (!renderer.hasTexture(key) && !textPending.has(key)) {
      textPending.add(key);
      post({ type: "needText", key, layer: tx });
    }
    if (renderer.hasTexture(key)) textLayers.push(textLayerToImageLayer(tx, key));
  }
  if (!d) return;
  const layers = [...scene.layers, ...textLayers].sort((a, b) => a.z - b.z);
  renderer.render({ ...scene, layers });
  post({ type: "rendered", time: t });
}
