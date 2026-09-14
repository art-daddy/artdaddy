// Timeline zoom scrollbar (Premiere-style "zoom bar"): the scroll viewport maps
// to a draggable thumb whose ENDS resize to zoom in/out (keeping the opposite
// edge anchored in time) and whose BODY pans. Pure geometry in SECONDS — the
// component owns the DOM + drag wiring. Fully unit-tested.

export interface ZoomView {
  scrollLeft: number; // px
  clientWidth: number; // viewport px
  zoom: number; // px per second
  totalSec: number; // full timeline duration
}

function fullSpan(v: ZoomView): number {
  // The bar covers the whole content, but never less than the visible span.
  return Math.max(v.totalSec, v.clientWidth / v.zoom, 0.001);
}
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** The thumb as [left, width] fractions (0..1) of the bar. */
export function zoomThumb(v: ZoomView): { left: number; width: number } {
  const full = fullSpan(v);
  const startSec = v.scrollLeft / v.zoom;
  const durSec = v.clientWidth / v.zoom;
  return { left: clamp01(startSec / full), width: Math.max(0.02, Math.min(1, durSec / full)) };
}

/** Pan so the thumb's left edge sits at fraction `f` of the bar → scrollLeft px. */
export function zoomPan(v: ZoomView, f: number): number {
  return Math.max(0, clamp01(f) * fullSpan(v) * v.zoom);
}

/** Resize an end to fraction `f`, anchoring the opposite edge in time.
 *  Returns the new zoom (px/sec, clamped) + scrollLeft (px). */
export function zoomResize(
  v: ZoomView,
  edge: "l" | "r",
  f: number,
  minZoom: number,
  maxZoom: number,
): { zoom: number; scrollLeft: number } {
  const full = fullSpan(v);
  const startSec = v.scrollLeft / v.zoom;
  const endSec = startSec + v.clientWidth / v.zoom;
  const ns = edge === "l" ? clamp01(f) * full : startSec;
  const ne = edge === "r" ? clamp01(f) * full : endSec;
  const dur = Math.max(0.05, ne - ns); // keep at least 50ms visible
  const zoom = Math.min(maxZoom, Math.max(minZoom, v.clientWidth / dur));
  const start = edge === "l" ? ne - v.clientWidth / zoom : ns; // recompute from clamped zoom
  return { zoom, scrollLeft: Math.max(0, start * zoom) };
}
