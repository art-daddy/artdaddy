// Geometry for direct manipulation on the preview stage: where a clip's transform box
// lands on screen, which clip a click hits, and what a drag does to the box.
//
// Pure and view-agnostic on purpose — the overlay component owns pointer events and
// React state, this owns every number. The box is expressed NORMALISED to the canvas
// (centre + size, 0..1) because that is exactly what `transform.position` / `scale`
// store, so a drag maps to a property write with no hidden conversion.
//
// The box and the picture rect both come from scene.ts — the COMPOSITOR — so the overlay draws
// where the picture actually is, never where a second copy of the layout rule says it should be.
// `normBoxOf` is a re-export of the compositor's own `normBox`; `pictureShrink` delegates to its
// `clipRects`. stageGeometry.test.ts pins both against buildScene's real output.
import type { Clip, Crop } from "../timeline/model";
import { resolveFit, type FitKind } from "../timeline/renderPlan";
import { clipRects, normBox, type AssetDims, type NormBox, type Rect } from "./scene";

export type { NormBox };

export type Corner = "tl" | "tr" | "bl" | "br";
export type CropEdge = "left" | "right" | "top" | "bottom";

/** Smallest box a drag may leave behind, as a fraction of the canvas. Matches the
 *  0.05 floor other NLEs uses — below this the handles overlap and become ungrabbable. */
export const MIN_BOX = 0.05;

/** The letterboxed canvas rect inside a view — the compositor scales the canvas to fit
 *  and centres it, so screen coords only mean something relative to THIS rect. */
export function canvasRectInView(
  viewW: number,
  viewH: number,
  canvasW: number,
  canvasH: number,
): Rect {
  if (!(viewW > 0) || !(viewH > 0) || !(canvasW > 0) || !(canvasH > 0))
    return { x: 0, y: 0, w: 0, h: 0 };
  const canvasAspect = canvasW / canvasH;
  const w = viewW / viewH > canvasAspect ? viewH * canvasAspect : viewW;
  const h = viewW / viewH > canvasAspect ? viewH : viewW / canvasAspect;
  return { x: (viewW - w) / 2, y: (viewH - h) / 2, w, h };
}

/** A clip's transform box at `atFrame`, normalised to the canvas — the compositor's own answer.
 *  Kept as a named export because the overlay reads in normalised units throughout. */
export const normBoxOf = normBox;

export function normBoxToView(b: NormBox, canvas: Rect): Rect {
  return {
    x: canvas.x + (b.cx - b.w / 2) * canvas.w,
    y: canvas.y + (b.cy - b.h / 2) * canvas.h,
    w: b.w * canvas.w,
    h: b.h * canvas.h,
  };
}

/** Fraction of the transform box each axis of the PICTURE actually occupies.
 *
 *  The transform box is not where the clip is drawn: `fit` (contain by default)
 *  letterboxes the picture inside it, and `crop` narrows it further. A 726x612 photo
 *  in a 1080x1920 frame fills the width but only 47% of the height — so a box-drawn
 *  handle sits a quarter of the canvas above the clip, which is the bug this fixes.
 *
 *  Delegates to the compositor's own `clipRects`, so the overlay and the picture can
 *  never drift apart. `{1,1}` while the size is unknown (degrade to the old box) and
 *  for `cover`, where the picture does fill the box.
 *
 *  Both factors are invariant under a MOVE (box size fixed) and under our aspect-locked
 *  SCALE (box aspect fixed), which is what lets a gesture measure them once at the start
 *  and convert its result back to a transform box. */
export function pictureShrink(
  box: NormBox,
  canvasW: number,
  canvasH: number,
  asset: AssetDims | null,
  fit: FitKind,
  crop: Crop | undefined,
): { sw: number; sh: number } {
  const boxPx = { x: 0, y: 0, w: box.w * canvasW, h: box.h * canvasH };
  if (!asset || !(asset.w > 0) || !(asset.h > 0) || !(boxPx.w > 0) || !(boxPx.h > 0))
    return { sw: 1, sh: 1 };
  const { dst } = clipRects(boxPx, asset, fit, crop, false, false);
  return { sw: dst.w / boxPx.w, sh: dst.h / boxPx.h };
}

/** The transform box narrowed to the picture. Concentric with the box for every fit
 *  mode, which is why only the two scale factors are needed. */
export function shrinkBox(box: NormBox, s: { sw: number; sh: number }): NormBox {
  return { cx: box.cx, cy: box.cy, w: box.w * s.sw, h: box.h * s.sh, rotate: box.rotate };
}

/** Inverse of `shrinkBox`: the transform box that would draw this picture box. What a
 *  gesture writes, since `transform.scale` describes the BOX, not the picture. */
export function growBox(pic: NormBox, s: { sw: number; sh: number }): NormBox {
  return {
    cx: pic.cx,
    cy: pic.cy,
    w: s.sw > 0 ? pic.w / s.sw : pic.w,
    h: s.sh > 0 ? pic.h / s.sh : pic.h,
    rotate: pic.rotate,
  };
}

/** Everything the overlay needs for one clip at one frame: its transform box, the
 *  picture actually drawn inside it, and the factor between them (which a gesture
 *  measures once and uses to convert its result back into a transform). */
export function pictureBoxOf(
  clip: Clip,
  atFrame: number,
  canvasW: number,
  canvasH: number,
  asset: AssetDims | null,
): { box: NormBox; pic: NormBox; shrink: { sw: number; sh: number } } {
  const box = normBoxOf(clip, atFrame);
  const shrink = pictureShrink(box, canvasW, canvasH, asset, resolveFit(clip.fit), clip.crop);
  return { box, pic: shrinkBox(box, shrink), shrink };
}

/** The rect the overlay actually DRAWS: `rect`, pulled back inside `bounds`.
 *
 *  A clip scaled past the frame is legitimate — that is how landscape footage fills a
 *  vertical canvas — but its corners then land outside the stage, where the handles are
 *  impossible to grab. Resizing works off pointer DELTAS, so a handle drawn somewhere
 *  other than its true corner still drags correctly.
 *
 *  The OUTLINE and the HANDLES must both come from here. They used to clamp differently
 *  (handles pulled in, outline drawn raw), which is why the dots sat on the frame edge
 *  while the lines ran off into the surrounding chrome. */
export function clampedRect(rect: Rect, bounds: Rect): Rect {
  const cx = (v: number): number => Math.min(Math.max(v, bounds.x), bounds.x + bounds.w);
  const cy = (v: number): number => Math.min(Math.max(v, bounds.y), bounds.y + bounds.h);
  const l = cx(rect.x);
  const r = cx(rect.x + rect.w);
  const t = cy(rect.y);
  const b = cy(rect.y + rect.h);
  return { x: l, y: t, w: r - l, h: b - t };
}

/** Where to DRAW each corner handle — the corners of the box as ROTATED, each clamped into
 *  `bounds` so a handle can never leave the stage.
 *
 *  For an upright box this is exactly the old "clamp the rect, take its corners": clamping x and
 *  y independently per corner is the same thing when the corners are axis-aligned. Rotated, it is
 *  the only version that means anything — the picture's corners are no longer the rect's. */
export function handlePositions(
  rect: Rect,
  bounds: Rect,
  rotate = 0,
): Record<Corner, { x: number; y: number }> {
  const c = rotatedCorners(rect, rotate);
  const clampX = (v: number): number => Math.min(Math.max(v, bounds.x), bounds.x + bounds.w);
  const clampY = (v: number): number => Math.min(Math.max(v, bounds.y), bounds.y + bounds.h);
  const fit = (p: { x: number; y: number }) => ({ x: clampX(p.x), y: clampY(p.y) });
  return { tl: fit(c.tl), tr: fit(c.tr), bl: fit(c.bl), br: fit(c.br) };
}

/** Spin `p` about `c` by `rad` CLOCKWISE. Screen space, so y grows downward and a positive
 *  angle turns the way the shader and ffmpeg both turn.
 *
 *  Zero is returned untouched, and that is load-bearing: `c + (p - c)` is not bit-identical to
 *  `p`, so an unrotated box's corners came back an ulp off and the outline no longer matched the
 *  rect it is required to equal. Every caller inherits the exact identity from here. */
function spin(
  p: { x: number; y: number },
  c: { x: number; y: number },
  rad: number,
): { x: number; y: number } {
  if (!rad) return { x: p.x, y: p.y };
  const s = Math.sin(rad);
  const co = Math.cos(rad);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + co * dx - s * dy, y: c.y + s * dx + co * dy };
}

/** The four corners of `rect` after rotating about its own centre — where the picture's
 *  corners actually are. The renderer rotates about the same point (its shader spins the quad
 *  around `u_dst`'s centre), which is what lets the outline sit on the picture. */
export function rotatedCorners(
  rect: Rect,
  rotate: number,
): Record<Corner, { x: number; y: number }> {
  const c = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  return {
    tl: spin({ x: rect.x, y: rect.y }, c, rotate),
    tr: spin({ x: rect.x + rect.w, y: rect.y }, c, rotate),
    bl: spin({ x: rect.x, y: rect.y + rect.h }, c, rotate),
    br: spin({ x: rect.x + rect.w, y: rect.y + rect.h }, c, rotate),
  };
}

/** Where the rotate knob sits: `offset` px beyond the middle of the box's TOP edge, carried
 *  around with the box so it always reads as "the top of this clip". */
export function rotationHandlePoint(
  rect: Rect,
  rotate: number,
  offset: number,
): { x: number; y: number } {
  const c = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  return spin({ x: c.x, y: rect.y - offset }, c, rotate);
}

/** Degrees CLOCKWISE from straight up for a pointer at `p` about `centre`, in (-180, 180]. */
export function angleFromCentre(
  centre: { x: number; y: number },
  p: { x: number; y: number },
): number {
  const deg = (Math.atan2(p.x - centre.x, centre.y - p.y) * 180) / Math.PI;
  return deg <= -180 ? deg + 360 : deg;
}

/** Snap to the nearest multiple of `step` degrees, but only within `tol` of one — so the
 *  gesture stays continuous everywhere except near a stop. */
export function snapDegrees(deg: number, step: number, tol: number): number {
  if (!(step > 0) || !(tol > 0)) return deg;
  const nearest = Math.round(deg / step) * step;
  return Math.abs(deg - nearest) <= tol ? nearest : deg;
}

/** Top-left of a `size`-px handle centred on `point`, nudged so the whole handle stays
 *  inside `bounds`.
 *
 *  Centring it on a corner that sits ON the frame edge leaves half the handle outside the
 *  stage: it still LOOKS present, but its centre is no longer the topmost element and real
 *  mouse input lands on the container instead (found by hit-testing the running app). The
 *  nudge is applied to the HANDLE, never to the outline — insetting the shape itself drew
 *  a clip that exactly fills the frame as if it were smaller than the frame. */
export function handleOrigin(
  point: { x: number; y: number },
  bounds: Rect,
  size: number,
): { x: number; y: number } {
  const fit = (v: number, min: number, extent: number): number =>
    extent <= size ? min + (extent - size) / 2 : Math.min(Math.max(v, min), min + extent - size);
  return {
    x: fit(point.x - size / 2, bounds.x, bounds.w),
    y: fit(point.y - size / 2, bounds.y, bounds.h),
  };
}

/** A view-space delta as a fraction of the canvas — the unit every drag below works in. */
export function viewDeltaToNorm(dx: number, dy: number, canvas: Rect): { dx: number; dy: number } {
  return { dx: canvas.w > 0 ? dx / canvas.w : 0, dy: canvas.h > 0 ? dy / canvas.h : 0 };
}

function within(r: Rect, px: number, py: number): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

/** Topmost clip under a point. Entries are matched by HIGHEST z first, so a click
 *  selects what the viewer sees rather than whatever the array happens to hold first. */
export function hitTest<T extends { rect: Rect; z: number }>(
  entries: readonly T[],
  px: number,
  py: number,
): T | null {
  let best: T | null = null;
  for (const e of entries) {
    if (!within(e.rect, px, py)) continue;
    if (!best || e.z > best.z) best = e;
  }
  return best;
}

/** Translate the box. Edges snap to the canvas edges and the centre to the canvas centre
 *  (edges first, then centre — a centre hit wins the tie), reporting which guides fired
 *  so the overlay can draw them. */
export function movedBox(
  start: NormBox,
  dxNorm: number,
  dyNorm: number,
  snap = 0,
): { box: NormBox; guideX: boolean; guideY: boolean } {
  let cx = start.cx + dxNorm;
  let cy = start.cy + dyNorm;
  if (Math.abs(cx - start.w / 2) <= snap) cx = start.w / 2;
  else if (Math.abs(cx + start.w / 2 - 1) <= snap) cx = 1 - start.w / 2;
  if (Math.abs(cy - start.h / 2) <= snap) cy = start.h / 2;
  else if (Math.abs(cy + start.h / 2 - 1) <= snap) cy = 1 - start.h / 2;
  const guideX = Math.abs(cx - 0.5) <= snap;
  const guideY = Math.abs(cy - 0.5) <= snap;
  return {
    box: { ...start, cx: guideX ? 0.5 : cx, cy: guideY ? 0.5 : cy },
    guideX,
    guideY,
  };
}

/** Resize from a corner, holding the opposite corner still.
 *
 *  `aspect` (box width / box height, in CANVAS units) locks the box to the media's shape,
 *  which is what makes the handles sit on the picture instead of on a letterboxed frame —
 *  the same trick other NLEs uses. The dragged edge stops at the opposite one, so a box can
 *  never invert or collapse however far the pointer travels. */
export function resizedBox(
  start: NormBox,
  corner: Corner,
  dxNorm: number,
  dyNorm: number,
  opts: { aspect?: number; min?: number } = {},
): NormBox {
  const min = opts.min ?? MIN_BOX;
  const movesLeft = corner === "tl" || corner === "bl";
  const movesTop = corner === "tl" || corner === "tr";
  let left = start.cx - start.w / 2;
  let right = start.cx + start.w / 2;
  let top = start.cy - start.h / 2;
  let bottom = start.cy + start.h / 2;

  if (movesLeft) left = Math.min(left + dxNorm, right - min);
  else right = Math.max(right + dxNorm, left + min);
  if (movesTop) top = Math.min(top + dyNorm, bottom - min);
  else bottom = Math.max(bottom + dyNorm, top + min);

  const aspect = opts.aspect;
  if (aspect && aspect > 0 && Number.isFinite(aspect)) {
    // Grow along whichever axis the pointer pulled further, so the corner tracks the cursor.
    const w = right - left;
    const h = bottom - top;
    if (w >= h * aspect) {
      const adjH = Math.max(min, w / aspect);
      if (movesTop) top = bottom - adjH;
      else bottom = top + adjH;
    } else {
      const adjW = Math.max(min, h * aspect);
      if (movesLeft) left = right - adjW;
      else right = left + adjW;
    }
  }
  return {
    cx: (left + right) / 2,
    cy: (top + bottom) / 2,
    w: right - left,
    h: bottom - top,
    rotate: start.rotate,
  };
}

const CROP_MAX = 0.99;

/** Move one crop edge. Fractions stay in [0, 0.99] and an opposing pair can never sum to
 *  1 or more — a fully-cropped clip has no pixels, and the renderer silently clamps that
 *  to 0.01, so the invariant belongs here where the user can still see what happened. */
export function croppedFractions(start: Crop | undefined, edge: CropEdge, dNorm: number): Crop {
  const cur: Required<Pick<Crop, "left" | "right" | "top" | "bottom">> = {
    left: frac(start?.left),
    right: frac(start?.right),
    top: frac(start?.top),
    bottom: frac(start?.bottom),
  };
  const opposite = { left: "right", right: "left", top: "bottom", bottom: "top" } as const;
  // The right/bottom handles move inward on a NEGATIVE delta but that is a LARGER crop.
  const signed = edge === "right" || edge === "bottom" ? -dNorm : dNorm;
  const ceiling = Math.max(0, Math.min(CROP_MAX, 1 - cur[opposite[edge]] - 0.01));
  const next = { ...cur };
  next[edge] = Math.min(Math.max(0, cur[edge] + signed), ceiling);
  return next;
}

function frac(v: unknown): number {
  return typeof v === "number" && v > 0 && v < 1 ? v : 0;
}
