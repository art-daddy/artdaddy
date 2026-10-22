// Main-thread half of the worker-backed preview. Owns the Worker and the
// source→URL resolution (which needs Tauri, so it MUST stay on the main thread),
// and turns timeline/time changes into worker messages:
//   - timeline changed  -> full `render` with freshly resolved asset urls
//   - only the time moved -> cheap `seek` (worker reuses the last timeline+urls)
// so we never re-clone a 300-clip timeline across the worker boundary per frame.
import { loadBundledFonts } from "./fonts";
import { setAssetDims } from "./assetDims";
import type { PreviewEndpoint, PreviewInbound, PreviewOutbound, StillAnimation } from "./protocol";
import { timelineSources } from "./protocol";
import { resolvePosterUrl, resolvePreviewUrl, resolveStillAnimation } from "./resolve";
import type { TextLayer } from "./scene";
import { rasterizeText } from "./text";
import { kindOf } from "../media/formats";
import { withStillKinds } from "../timeline/helpers";
import type { Timeline } from "../timeline/model";
import type { ProjectStoreAccess } from "../tools/store";

export interface PreviewClient {
  /** Push the current timeline + playhead to the worker. */
  render(timeline: Timeline | null, time: number): void;
  /** Update the project store used to resolve sources (e.g. after a project switch). */
  setStore(store: ProjectStoreAccess | null): void;
  /** Grab the current composited frame as JPEG bytes (project thumbnail), or
   *  null if capture failed / timed out. */
  capture(maxEdge?: number): Promise<Uint8Array | null>;
  /** Tear down the worker. */
  dispose(): void;
}

export interface PreviewClientDeps {
  /** Override worker construction (tests inject a fake). */
  createWorker?: () => Worker;
  createFallback?: () => PreviewEndpoint | Promise<PreviewEndpoint>;
  /** Override source resolution (tests inject a fake). */
  resolve?: (store: ProjectStoreAccess, source: string) => Promise<string | null>;
  /** Override the animated-still lookup (tests inject a fake). */
  resolveAnimation?: (store: ProjectStoreAccess, source: string) => Promise<StillAnimation | null>;
  /** Called when the worker reports it could not start / render. */
  onError?: (message: string) => void;
  /** Called when a visible video layer runs out of decoded frames, and again when it
   *  recovers. Drives the playhead hold; see stallGate.ts. */
  onStalled?: (stalled: boolean) => void;
}

/** Cold-start timing, as standard performance entries so a driver session (or DevTools) can read
 *  them without the app carrying its own log. Each phase is marked ONCE: what matters is the first
 *  picture after a project opens, and a mark per frame would bury it. */
const marked = new Set<string>();
function mark(phase: string): void {
  if (marked.has(phase) || typeof performance === "undefined") return;
  marked.add(phase);
  try {
    performance.mark(`preview:${phase}`);
    if (phase !== "render-requested") {
      performance.measure(`preview:${phase}-since-request`, "preview:render-requested");
    }
  } catch {
    /* the origin mark is missing (a seek before any render): timing is best-effort */
  }
}

export function createPreviewClient(
  canvas: HTMLCanvasElement,
  deps: PreviewClientDeps = {},
): PreviewClient {
  const resolve = deps.resolve ?? resolvePreviewUrl;
  const resolveAnimation = deps.resolveAnimation ?? resolveStillAnimation;
  let worker: Worker | null = null;
  try {
    worker = deps.createWorker
      ? deps.createWorker()
      : new Worker(new URL("./previewWorker.ts", import.meta.url), { type: "module" });
  } catch {}

  let ready = false;
  let disposed = false;
  let failed = false;
  let startingFallback = false;
  let endpoint: PreviewEndpoint | null = worker;
  let probeTimer: ReturnType<typeof setTimeout> | null = null;
  const queued: Array<{ message: PreviewInbound; transfer: Transferable[] }> = [];
  const post = (message: PreviewInbound, transfer: Transferable[] = []): void => {
    if (disposed || failed) {
      if (message.type === "textBitmap") message.bitmap?.close();
      return;
    }
    if (!ready) queued.push({ message, transfer });
    else endpoint?.postMessage(message, transfer);
  };
  const pendingCaptures = new Map<
    number,
    {
      settle: (bytes: Uint8Array | null) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const settleCaptures = (): void => {
    for (const pending of pendingCaptures.values()) {
      clearTimeout(pending.timer);
      pending.settle(null);
    }
    pendingCaptures.clear();
  };
  const retireQueued = (): void => {
    for (const pending of queued.splice(0)) {
      if (pending.message.type === "textBitmap") pending.message.bitmap?.close();
    }
  };
  const fail = (message: string): void => {
    if (disposed || failed) return;
    failed = true;
    if (probeTimer !== null) clearTimeout(probeTimer);
    retireQueued();
    settleCaptures();
    endpoint?.terminate();
    deps.onError?.(message);
  };
  const receive = (e: MessageEvent<PreviewOutbound>): void => {
    if (disposed || failed) return;
    if (e.data.type === "capabilities") {
      if (ready || startingFallback) return;
      if (!e.data.webgl2) {
        void startFallback();
        return;
      }
      if (probeTimer !== null) clearTimeout(probeTimer);
      try {
        const offscreen = canvas.transferControlToOffscreen();
        endpoint?.postMessage({ type: "init", canvas: offscreen } satisfies PreviewInbound, [
          offscreen,
        ]);
        ready = true;
        flushQueued();
      } catch (error) {
        fail(String(error));
      }
    } else if (e.data.type === "error") fail(e.data.message);
    else if (e.data.type === "stalled") deps.onStalled?.(e.data.stalled);
    else if (e.data.type === "firstFrame") mark("first-frame");
    else if (e.data.type === "needText") void answerText(e.data.key, e.data.layer);
    else if (e.data.type === "dims") setAssetDims(e.data.source, { w: e.data.w, h: e.data.h });
    else if (e.data.type === "captured") {
      const pending = pendingCaptures.get(e.data.requestId);
      if (pending) {
        pendingCaptures.delete(e.data.requestId);
        clearTimeout(pending.timer);
        pending.settle(e.data.bytes ? new Uint8Array(e.data.bytes) : null);
      }
    }
  };
  const attach = (next: PreviewEndpoint): void => {
    next.onmessage = (event) => {
      if (endpoint === next) receive(event);
    };
  };
  function flushQueued(): void {
    for (const pending of queued.splice(0))
      endpoint?.postMessage(pending.message, pending.transfer);
  }
  async function startFallback(): Promise<void> {
    if (disposed || failed || ready || startingFallback) return;
    startingFallback = true;
    if (probeTimer !== null) clearTimeout(probeTimer);
    endpoint = null;
    worker?.terminate();
    try {
      const local = deps.createFallback
        ? await deps.createFallback()
        : (await import("./previewRuntime")).createMainThreadPreview();
      if (disposed || failed) {
        local.terminate();
        return;
      }
      endpoint = local;
      attach(local);
      local.postMessage({ type: "init", canvas } satisfies PreviewInbound);
      ready = true;
      flushQueued();
    } catch (error) {
      fail(String(error));
    }
  }

  /** Rasterize a caption HERE, not in the worker: a FontFace registered on a
   *  worker loads but never reaches its OffscreenCanvas, so the worker would draw
   *  the bundled families in Times and the preview would stop matching the export.
   *  Waits for the faces so the first caption isn't cached in the fallback. */
  async function answerText(key: string, layer: TextLayer): Promise<void> {
    let bitmap: ImageBitmap | null = null;
    try {
      await loadBundledFonts(document.fonts);
      bitmap = rasterizeText(layer);
    } catch {
      /* fall through: the worker skips a layer it never receives a bitmap for */
    }
    if (disposed || failed) {
      bitmap?.close();
      return;
    }
    post(
      { type: "textBitmap", key, ...(bitmap ? { bitmap } : {}) } satisfies PreviewInbound,
      bitmap ? [bitmap] : [],
    );
  }

  let captureSeq = 0;
  let store: ProjectStoreAccess | null = null;
  let lastTimeline: Timeline | null = null;
  let token = 0; // guards against a slow resolve clobbering a newer timeline
  // What kind of FILE each ref names (a ref's file never changes kind), so a clip stored as "video"
  // whose file is a still is drawn as the still it is: the export's rule (helpers.withStillKinds).
  const fileKinds = new Map<string, string | null>();
  async function fileKindOf(s: ProjectStoreAccess, src: string): Promise<string | null> {
    const key = `${s.projectDir}\u0000${src}`;
    if (fileKinds.has(key)) return fileKinds.get(key)!;
    let abs: string | null = null;
    try {
      abs = await s.resolveRef(src);
    } catch {
      abs = null; // best-effort: the stored kind stands
    }
    const kind = abs ? kindOf(abs) : null;
    if (abs) fileKinds.set(key, kind); // an unresolved ref is asked again once its file lands
    return kind;
  }

  async function resolveAndRender(timeline: Timeline, time: number): Promise<void> {
    const mine = ++token;
    mark("render-requested");
    const urls: Record<string, string> = {};
    const posters: Record<string, string> = {};
    const animations: Record<string, StillAnimation> = {};
    const kinds = new Map<string, string | null>();
    const s = store;
    if (s) {
      await Promise.all(
        timelineSources(timeline).map(async (src) => {
          // Concurrently: resolution is ~85% of the time to the first picture (measured in-app at
          // 363ms of 433ms), so awaiting the poster after the source would have added its IPC
          // round-trips to the critical path rather than alongside it.
          const [u, p, k, a] = await Promise.all([
            resolve(s, src),
            resolvePosterUrl(s, src).catch(() => null), // best-effort: no poster, old black start
            fileKindOf(s, src),
            resolveAnimation(s, src).catch(() => null), // best-effort: the still draws unmoving
          ]);
          if (u) urls[src] = u;
          else console.warn(`[preview] timeline source did not resolve to a file: ${src}`);
          if (p) posters[src] = p;
          if (a) animations[src] = a;
          kinds.set(src, k);
        }),
      );
    }
    mark("urls-resolved");
    if (mine !== token) return; // a newer timeline superseded this resolve
    const drawn = withStillKinds(timeline, (ref) => kinds.get(ref) ?? null);
    post({
      type: "render",
      timeline: drawn,
      time,
      urls,
      posters,
      animations,
    } satisfies PreviewInbound);
  }

  if (worker) {
    attach(worker);
    worker.onerror = (event) => {
      if (endpoint !== worker || disposed || failed) return;
      if (ready) fail(event.message || "Preview worker failed");
      else void startFallback();
    };
    probeTimer = setTimeout(() => {
      void startFallback();
    }, 3000);
    worker.postMessage({ type: "probe" } satisfies PreviewInbound);
  } else {
    void startFallback();
  }

  return {
    render(timeline, time) {
      if (disposed || failed || !timeline) return;
      if (timeline !== lastTimeline) {
        lastTimeline = timeline;
        void resolveAndRender(timeline, time);
      } else {
        post({ type: "seek", time } satisfies PreviewInbound);
      }
    },
    setStore(next) {
      if (disposed || failed) return;
      if (store !== next) {
        token++;
        lastTimeline = null;
      }
      store = next;
    },
    capture(maxEdge) {
      if (disposed || failed) return Promise.resolve(null);
      return new Promise<Uint8Array | null>((resolve) => {
        const requestId = ++captureSeq;
        // Never hang the caller if the worker is wedged / WebGL is unavailable.
        const timer = setTimeout(() => {
          if (pendingCaptures.delete(requestId)) resolve(null);
        }, 4000);
        pendingCaptures.set(requestId, { settle: resolve, timer });
        post({ type: "capture", requestId, maxEdge } satisfies PreviewInbound);
      });
    },
    dispose() {
      disposed = true;
      token++; // strand any in-flight resolve
      if (probeTimer !== null) clearTimeout(probeTimer);
      retireQueued();
      settleCaptures();
      endpoint?.terminate();
      if (endpoint !== worker) worker?.terminate();
    },
  };
}
