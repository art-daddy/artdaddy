import { loadImage } from "./loader";
import type { PreviewEndpoint, PreviewInbound, PreviewOutbound, StillAnimation } from "./protocol";
import { PreviewRenderer } from "./renderer";
import { type AssetDims, buildScene, type Layer, textLayerToImageLayer } from "./scene";
import { AnimatedStill } from "./stillAnimation";
import { textKey } from "./text";
import { VideoSource } from "./videoSource";
import { canvasFps } from "../timeline/frames";
import { clipKind } from "../timeline/helpers";
import type { Timeline } from "../timeline/model";

export interface PreviewScope {
  postMessage(message: PreviewOutbound, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<PreviewInbound>) => void) | null;
}

export function createMainThreadPreview(): PreviewEndpoint {
  let disposed = false;
  const scope: PreviewScope = {
    onmessage: null,
    postMessage(message) {
      queueMicrotask(() => {
        if (!disposed) endpoint.onmessage?.({ data: message } as MessageEvent<PreviewOutbound>);
      });
    },
  };
  const dispose = startPreviewRuntime(scope);
  const endpoint: PreviewEndpoint = {
    onmessage: null,
    postMessage(message) {
      queueMicrotask(() => {
        if (!disposed) scope.onmessage?.({ data: message } as MessageEvent<PreviewInbound>);
        else if (message.type === "textBitmap") message.bitmap?.close();
      });
    },
    terminate() {
      if (disposed) return;
      disposed = true;
      endpoint.onmessage = null;
      dispose();
    },
  };
  return endpoint;
}

export function startPreviewRuntime(scope: PreviewScope): () => void {
  let renderer: PreviewRenderer | null = null;
  const dims = new Map<string, AssetDims>();
  const videos = new Map<string, VideoSource>();
  const prepared = new Map<string, string>();
  const uploaded = new Map<string, number>();
  const failed = new Set<string>();
  const stills = new Map<string, AnimatedStill>();
  const textPending = new Set<string>();
  let timeline: Timeline | null = null;
  let urls: Record<string, string> = {};
  let posters: Record<string, string> = {};
  let animations: Record<string, StillAnimation> = {};
  let time = 0;
  let dirty = true;
  let lastTime = NaN;
  let lastTimeline: Timeline | null = null;
  let looping = false;
  let stalled = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const post = (message: PreviewOutbound, transfer: Transferable[] = []): void => {
    if (!disposed) scope.postMessage(message, transfer);
  };
  const current = (source: string, url: string): boolean =>
    !disposed && prepared.get(source) === url;

  scope.onmessage = (event) => {
    const message = event.data;
    if (disposed) {
      if (message.type === "textBitmap") message.bitmap?.close();
      return;
    }
    if (message.type === "probe") {
      let webgl2 = false;
      try {
        const context = new OffscreenCanvas(1, 1).getContext("webgl2");
        webgl2 = Boolean(context);
        context?.getExtension("WEBGL_lose_context")?.loseContext();
      } catch {}
      post({ type: "capabilities", webgl2 });
    } else if (message.type === "init") {
      try {
        renderer = new PreviewRenderer(message.canvas);
      } catch (error) {
        post({ type: "error", message: String(error) });
        return;
      }
      if (!looping) {
        looping = true;
        loop();
      }
    } else if (message.type === "render") {
      timeline = message.timeline;
      urls = message.urls;
      posters = message.posters ?? {};
      animations = message.animations ?? {};
      time = message.time;
      prepare();
    } else if (message.type === "seek") {
      time = message.time;
    } else if (message.type === "capture") {
      void captureThumbnail(message.requestId, message.maxEdge);
    } else if (message.type === "textBitmap") {
      textPending.delete(message.key);
      if (message.bitmap) {
        try {
          renderer?.setTexture(message.key, message.bitmap);
          dirty = true;
        } finally {
          message.bitmap.close();
        }
      }
    }
  };

  async function captureThumbnail(requestId: number, maxEdge?: number): Promise<void> {
    try {
      if (!renderer || !timeline?.canvas) throw new Error("nothing to render yet");
      dirty = true;
      render();
      const bytes = await renderer.captureJpeg(maxEdge ?? 480);
      post({ type: "captured", requestId, bytes }, [bytes]);
    } catch (error) {
      post({ type: "captured", requestId, error: String(error) });
    }
  }

  function prepare(): void {
    for (const [source, still] of stills) {
      if (animations[source]?.url === still.url) continue;
      still.close();
      stills.delete(source);
    }
    for (const [source, animation] of Object.entries(animations)) {
      if (stills.has(source)) continue;
      stills.set(
        source,
        new AnimatedStill(
          source,
          animation.url,
          animation.timing,
          () => (disposed ? null : renderer),
          () => {
            if (!disposed) dirty = true;
          },
        ),
      );
    }
    for (const track of timeline?.tracks ?? []) {
      for (const clip of track.clips ?? []) {
        if (clip.kind === "audio" || clip.kind === "text" || typeof clip.media_ref !== "string")
          continue;
        const source = clip.media_ref;
        const url = urls[source];
        if (!url || prepared.get(source) === url) continue;
        const reloaded = prepared.has(source);
        prepared.set(source, url);
        if (reloaded) {
          videos.get(source)?.close();
          videos.delete(source);
          dims.delete(source);
          uploaded.delete(source);
          failed.delete(source);
        }
        const kind = clipKind(clip);
        if (kind === "image") {
          void loadImage(url)
            .then(({ bitmap, dims: size }) => {
              try {
                if (!current(source, url)) return;
                renderer?.setTexture(source, bitmap);
                dims.set(source, size);
                post({ type: "dims", source, w: size.w, h: size.h });
                dirty = true;
              } finally {
                bitmap.close();
              }
            })
            .catch((error) => {
              if (!current(source, url)) return;
              console.warn(`[preview] image load failed: ${source}`, error);
              prepared.delete(source);
            });
        } else if (kind === "video") {
          const poster = posters[source];
          if (poster && !uploaded.has(source)) {
            void loadImage(poster)
              .then(({ bitmap }) => {
                try {
                  if (!current(source, url) || uploaded.has(source)) return;
                  renderer?.setTexture(source, bitmap);
                  dirty = true;
                } finally {
                  bitmap.close();
                }
              })
              .catch(() => undefined);
          }
          const video = new VideoSource(url);
          videos.set(source, video);
          void video
            .whenReady()
            .then(() => {
              if (!current(source, url) || videos.get(source) !== video) return;
              dims.set(source, { ...video.dims, end: video.end });
              post({ type: "dims", source, w: video.dims.w, h: video.dims.h });
              dirty = true;
            })
            .catch((error) => {
              if (!current(source, url)) return;
              console.warn(
                `[preview] video not decodable (needs an H.264 proxy?): ${source}`,
                error,
              );
              failed.add(source);
            });
        }
      }
    }
  }

  function loop(): void {
    if (disposed) return;
    try {
      render();
    } catch (error) {
      looping = false;
      post({ type: "error", message: String(error) });
      return;
    }
    timer = setTimeout(loop, 16);
  }

  function render(): void {
    if (disposed || !renderer || !timeline?.canvas) return;
    const drawn = timeline;
    const at = time;
    let changed = dirty || at !== lastTime || drawn !== lastTimeline;
    dirty = false;
    lastTime = at;
    lastTimeline = drawn;
    const scene = buildScene(drawn, at, dims);
    const visible = new Set<string>();
    let starving = false;
    const fps = canvasFps(drawn);
    for (const layer of scene.layers) {
      if (layer.kind === "image") {
        const key = layer.still ? stills.get(layer.source)?.keyFor(fps, layer.still) : undefined;
        if (key) layer.source = key;
        continue;
      }
      if (layer.kind !== "video") continue;
      visible.add(layer.source);
      const video = videos.get(layer.source);
      if (!video) {
        if (!failed.has(layer.source)) starving = true;
        continue;
      }
      video.pump(layer.sourceTime ?? 0);
      const frame = video.nearestFrame(layer.sourceTime ?? 0);
      if (frame && uploaded.get(layer.source) !== frame.timestamp) {
        renderer.setTexture(layer.source, frame, video.orientation);
        if (!uploaded.has(layer.source)) post({ type: "firstFrame", source: layer.source });
        uploaded.set(layer.source, frame.timestamp);
        changed = true;
      }
      if (!frame && !failed.has(layer.source)) starving = true;
    }
    if (starving !== stalled) {
      stalled = starving;
      post({ type: "stalled", stalled });
    }
    for (const [source, video] of videos) {
      if (!visible.has(source)) {
        video.idle();
        uploaded.delete(source);
      }
    }
    const textLayers: Layer[] = [];
    for (const text of scene.textLayers) {
      const key = textKey(text);
      if (!renderer.hasTexture(key) && !textPending.has(key)) {
        textPending.add(key);
        post({ type: "needText", key, layer: text });
      }
      if (renderer.hasTexture(key)) textLayers.push(textLayerToImageLayer(text, key));
    }
    if (!changed) return;
    const layers = [...scene.layers, ...textLayers].sort((left, right) => left.z - right.z);
    renderer.render({ ...scene, layers });
    post({ type: "rendered", time: at });
  }

  return () => {
    if (disposed) return;
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    scope.onmessage = null;
    for (const video of videos.values()) video.close();
    for (const still of stills.values()) still.close();
    renderer?.dispose();
    renderer = null;
    videos.clear();
    stills.clear();
    prepared.clear();
    uploaded.clear();
    dims.clear();
    failed.clear();
    textPending.clear();
    timeline = null;
  };
}
