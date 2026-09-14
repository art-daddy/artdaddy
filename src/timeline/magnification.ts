// How far a clip's picture is blown up past its own resolution — and the ceiling on it.
//
// `transform.scale` sizes the clip's BOX as a multiple of the canvas; `fit` then decides how the
// source fills that box. Neither number is the magnification on its own, and the interesting one
// is their product: a 16:9 480p source already covers a 9:16 canvas at 4x, so `scale: 3.45` on top
// is a 13.8x blow-up showing 78x139 source pixels. That renders as a featureless smear — reported
// as "the video is static" (the picture stops carrying visible change while the audio plays on).
//
// The export path already refuses to invent detail (`exportOptions.outputSize` never upscales);
// this is the same rule one boundary earlier, where the pixels are actually thrown away.
import { hasVal, sampleAnim } from "./anim";
import type { Animatable, Clip, Keyframe } from "./model";
import type { FitKind } from "./renderPlan";

export interface Dims {
  w: number;
  h: number;
}

/** Ceiling on how far a clip may be magnified past its source resolution.
 *
 *  Vertical reframing costs magnification before anyone zooms at all — filling 1080x1920 from
 *  1080p is 1.8x, from 720p 2.7x, from 480p 4.0x — so the ceiling has to clear that or the most
 *  common edit in the app becomes impossible. 6x leaves real headroom on top of every one of
 *  those (1080p -> scale 3.4, 720p -> 2.2, 480p -> 1.5) while refusing the case where fewer than
 *  ~180 source pixels are stretched across the canvas' short side. */
export const MAX_MAGNIFICATION = 6;

/** The factor the source is magnified by to fill `box` under `fit`. >1 invents pixels.
 *
 *  THE one owner: the compositor's `fitRects` derives its own scale from this, so a guard that
 *  says "this is 13.8x" and a picture that is actually 13.8x cannot drift apart. */
export function fitScale(box: Dims, img: Dims, fit: FitKind): number {
  if (!(img.w > 0) || !(img.h > 0) || !(box.w > 0) || !(box.h > 0)) return 1;
  return fit === "cover"
    ? Math.max(box.w / img.w, box.h / img.h)
    : Math.min(box.w / img.w, box.h / img.h);
}

const track = (v: Animatable | undefined): Keyframe[] | null =>
  Array.isArray(v) && v.length > 0 ? v : null;

/** Every instant where a scale track can peak. Each ease is monotonic between keyframes and the
 *  value is held flat outside them, so an extreme can only sit ON a keyframe. */
function sampleTimes(t: Clip["transform"]): number[] {
  const times = new Set<number>([0]);
  for (const v of [t?.scale, t?.scale_x, t?.scale_y])
    for (const k of track(v) ?? []) times.add(k.t);
  return [...times];
}

function boxAt(t: Clip["transform"], canvas: Dims, at: number): Dims {
  // Same precedence AND the same "is it set" test as the compositor's normBox: the agent's typed
  // params arrive as explicit `null` for unset, and an axis with none falls back to `scale`.
  const s = hasVal(t?.scale) ? sampleAnim(t?.scale, at, 1) : 1;
  const sx = hasVal(t?.scale_x) ? sampleAnim(t?.scale_x, at, 1) : s;
  const sy = hasVal(t?.scale_y) ? sampleAnim(t?.scale_y, at, 1) : s;
  return { w: sx * canvas.w, h: sy * canvas.h };
}

/** The box (canvas px) at the instant this clip is most magnified. */
function peakBox(clip: Clip, canvas: Dims, src: Dims, fit: FitKind): Dims {
  let best = boxAt(clip.transform, canvas, 0);
  let peak = fitScale(best, src, fit);
  for (const at of sampleTimes(clip.transform)) {
    const box = boxAt(clip.transform, canvas, at);
    const mag = fitScale(box, src, fit);
    if (mag > peak) {
      peak = mag;
      best = box;
    }
  }
  return best;
}

/** Peak magnification the clip's transform reaches over its whole animation. */
export function clipMagnification(clip: Clip, canvas: Dims, src: Dims, fit: FitKind): number {
  return fitScale(peakBox(clip, canvas, src, fit), src, fit);
}

/** How much a canvas-pixel box must shrink to stop magnifying `src` past `max`. 1 = already fine.
 *
 *  The stage's resize GHOST rails on this as well as the commit, so a drag stops where the write
 *  would stop rather than promising a size the commit then refuses — "it snaps back" is the
 *  visible symptom of an interaction that lied. */
export function boxShrinkFactor(
  box: Dims,
  src: Dims | null,
  fit: FitKind,
  max = MAX_MAGNIFICATION,
): number {
  if (!src || !(src.w > 0) || !(src.h > 0)) return 1;
  const mag = fitScale(box, src, fit);
  return mag > max && mag > 0 ? max / mag : 1;
}

/** The source region visible on canvas at `mag`, in SOURCE pixels — the number that says whether
 *  there is still a picture. */
export function visibleSourcePx(canvas: Dims, mag: number): Dims {
  const m = mag > 0 ? mag : 1;
  return { w: Math.round(canvas.w / m), h: Math.round(canvas.h / m) };
}

function scaleTrack(v: Animatable | undefined, k: number): Animatable {
  if (typeof v === "number") return v * k;
  if (Array.isArray(v)) return v.map((p) => ({ ...p, v: p.v * k }));
  return k; // unset (undefined or an explicit null) means 1
}

export interface MagnificationClamp {
  /** Peak magnification the edit asked for. */
  requested: number;
  /** Peak magnification after clamping (== requested when nothing was changed). */
  applied: number;
  clamped: boolean;
}

/** Bound a clip's scale so its peak magnification stays within `max`, IN PLACE.
 *
 *  All three scale tracks are divided by the same factor, so the box keeps its aspect and an
 *  animation keeps its shape — a zoom that was refused still zooms, just from a size the source
 *  can carry. Returns null when the clip has no picture to magnify (no source dimensions, or a
 *  text clip whose `scale` sets type size rather than a pixel box). */
export function clampClipMagnification(
  clip: Clip,
  canvas: Dims,
  src: Dims | null,
  fit: FitKind,
  max = MAX_MAGNIFICATION,
): MagnificationClamp | null {
  if (!src || !(src.w > 0) || !(src.h > 0) || !(canvas.w > 0) || !(canvas.h > 0)) return null;
  const requested = clipMagnification(clip, canvas, src, fit);
  if (!(requested > 0)) return null;
  const k = boxShrinkFactor(peakBox(clip, canvas, src, fit), src, fit, max);
  if (k >= 1) return { requested, applied: requested, clamped: false };
  const t = (clip.transform ??= {});
  // scale_x/scale_y fall back to `scale` per axis, so `scale` must move whenever EITHER axis
  // reads it — writing only the tracks that already carry a value would leave the other axis at
  // full size and stretch the picture instead of shrinking the box.
  if (hasVal(t.scale) || !hasVal(t.scale_x) || !hasVal(t.scale_y)) t.scale = scaleTrack(t.scale, k);
  if (hasVal(t.scale_x)) t.scale_x = scaleTrack(t.scale_x, k);
  if (hasVal(t.scale_y)) t.scale_y = scaleTrack(t.scale_y, k);
  return { requested, applied: clipMagnification(clip, canvas, src, fit), clamped: true };
}
