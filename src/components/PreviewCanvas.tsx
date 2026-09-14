// Live preview: hands its canvas to a Web Worker that composites the timeline
// off the main thread (OffscreenCanvas + WebGL2 + WebCodecs). The canvas is
// transferred to the worker on mount, so this component only forwards the
// timeline/playhead and the project store; all decoding/compositing happens
// off-thread. Degrades to an error label where the worker/WebGL2 is unavailable.
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { createPreviewClient, type PreviewClient } from "../preview/previewClient";
import { canvasRectInView } from "../preview/stageGeometry";
import { useEditor } from "../store/editor";
import { withProjectLock } from "../tools/coordinator";
import { INTERNAL_DIR, joinPath } from "../tools/store";
import type { Timeline } from "../timeline/model";

export default function PreviewCanvas({
  timeline,
  time = 0,
  zoom = "fit",
  onStalled,
  children,
}: {
  timeline: Timeline | null;
  time?: number;
  /** "fit" scales the frame to the viewport; a number is frame px per CSS px (1 = 100%). */
  zoom?: number | "fit";
  /** Fires when the compositor has no decoded frame for a visible clip, and again on
   *  recovery, so playback can wait for the picture instead of running past it. */
  onStalled?: (stalled: boolean) => void;
  children?: React.ReactNode;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<PreviewClient | null>(null);
  const disposeTimer = useRef<number | null>(null);
  const thumbTimer = useRef<number | null>(null);
  const errRef = useRef<HTMLParagraphElement>(null);
  const store = useEditor((s) => s.store);
  // The client is built once, so it must not capture this frame's callback.
  const stalledRef = useRef(onStalled);
  stalledRef.current = onStalled;

  // Create the worker-backed client once. The canvas is transferred to the
  // worker (transferControlToOffscreen), which is ONE-SHOT per <canvas> node —
  // but React StrictMode (dev) runs this effect twice on the SAME node
  // (setup → cleanup → setup). So we reuse the client across that throwaway
  // cycle and defer disposal: an immediate re-setup cancels it, while a genuine
  // unmount (no follow-up setup) tears the worker down on the next tick. A real
  // remount later gets a fresh <canvas> element, so its transfer is clean.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (disposeTimer.current !== null) {
      clearTimeout(disposeTimer.current);
      disposeTimer.current = null;
    }
    if (!clientRef.current) {
      try {
        clientRef.current = createPreviewClient(canvas, {
          onError: (m) => {
            if (errRef.current) errRef.current.textContent = `Preview unavailable: ${m}`;
          },
          onStalled: (s) => stalledRef.current?.(s),
        });
      } catch (e) {
        if (errRef.current) errRef.current.textContent = `Preview unavailable: ${String(e)}`;
      }
    }
    return () => {
      disposeTimer.current = window.setTimeout(() => {
        clientRef.current?.dispose();
        clientRef.current = null;
        disposeTimer.current = null;
      }, 0);
    };
  }, []);

  // Keep the worker's source resolution pointed at the current project store.
  // Declared before the render effect so a project switch updates the store
  // before the new timeline is resolved.
  useEffect(() => {
    clientRef.current?.setStore(store);
  }, [store]);

  // Push timeline/playhead to the worker on every change.
  useEffect(() => {
    clientRef.current?.render(timeline, time);
  }, [timeline, time]);

  // Refresh the project thumbnail (composited playhead frame) a short beat after
  // edits settle, so the picker shows the latest look. Best-effort + debounced;
  // no-op on web / before the store is ready / on an empty timeline.
  useEffect(() => {
    if (!store || !timeline?.tracks?.length) return;
    if (thumbTimer.current !== null) clearTimeout(thumbTimer.current);
    thumbTimer.current = window.setTimeout(() => {
      thumbTimer.current = null;
      void (async () => {
        const bytes = await clientRef.current?.capture();
        if (!bytes || !bytes.length) return;
        try {
          await withProjectLock(store.projectDir, () =>
            store.writeBytes(joinPath(store.projectDir, INTERNAL_DIR, "thumbnail.jpg"), bytes),
          );
        } catch {
          /* best-effort */
        }
      })();
    }, 2000);
    return () => {
      if (thumbTimer.current !== null) {
        clearTimeout(thumbTimer.current);
        thumbTimer.current = null;
      }
    };
  }, [timeline, store]);

  // Program-monitor zoom. The worker sizes the backing store to the PROJECT resolution
  // (renderer.ts: canvas.width = scene.width), so magnifying past 100% shows real frame
  // pixels rather than a re-render — same as Premiere. CSS sizing is therefore the whole
  // mechanism, and the overlay follows for free because this box IS the canvas.
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = (): void => setViewport({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cw = Number(timeline?.canvas?.width) || 1080;
  const ch = Number(timeline?.canvas?.height) || 1920;
  const fitted = canvasRectInView(viewport.w, viewport.h, cw, ch);
  const size = zoom === "fit" ? { w: fitted.w, h: fitted.h } : { w: cw * zoom, h: ch * zoom };

  return (
    <div ref={viewportRef} className="flex h-full w-full overflow-auto">
      {/* m-auto (not items-center) so the box centres when it fits and stays fully
          scrollable when it does not — flex centring would clip its top-left. */}
      <div
        className="relative m-auto shrink-0 grow-0"
        style={{ width: size.w || undefined, height: size.h || undefined }}
      >
        <canvas ref={canvasRef} className="block h-full w-full rounded bg-black" />
        <p
          ref={errRef}
          className="pointer-events-none absolute bottom-1 left-2 text-[10px] text-amber-500"
        />
        {/* Overlays live HERE, not in the padded stage box: this box is exactly the area the
            canvas occupies at the current zoom, so their geometry can't drift from the picture. */}
        {children}
      </div>
    </div>
  );
}
