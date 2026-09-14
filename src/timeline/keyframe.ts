// Keyframe *editing* helpers: convert between constant and animated forms and
// upsert/remove/navigate keys at a clip-relative frame. The runtime *sampling*
// lives in anim.ts (sampleAnim); this module is the editing side used by the
// inspector's stopwatch controls and the timeline's keyframe diamonds.
// All times are INTEGER clip-relative frames (0 = the clip's first frame).
// Pure + fully unit-tested.
import { sampleAnim } from "./anim";
import type { Animatable, Keyframe } from "./model";

/** True when the value is a keyframe curve (as opposed to a constant number). */
export function isAnimated(value: Animatable | undefined): value is Keyframe[] {
  return Array.isArray(value);
}

/** A stable copy sorted by time. */
function sortByTime(kfs: Keyframe[]): Keyframe[] {
  return [...kfs].sort((a, b) => a.t - b.t);
}

/** Sort keyframe rows by time and drop duplicate times, keeping the LAST row for
 *  any repeated `t` (last-write-wins). Used both when accepting a raw keyframe
 *  list (`set_keyframes`) and after fps-rescaling rounds two distinct times onto
 *  the same frame. Generic so it works on model `Keyframe`s and raw compiled rows. */
export function normalizeKeyframes<T extends { t: number }>(kfs: T[]): T[] {
  const byT = new Map<number, T>();
  for (const k of kfs) byT.set(k.t, k); // a later duplicate overwrites an earlier one
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/** Enable animation: turn a constant into a single key at clip-relative `t`. */
export function toKeyframes(value: Animatable | undefined, t: number, fallback = 0): Keyframe[] {
  if (isAnimated(value)) return value;
  const v = typeof value === "number" ? value : fallback;
  return [{ t: Math.round(t), v }];
}

/** Disable animation: collapse a curve to the constant sampled at `t`. */
export function toConstant(value: Animatable | undefined, t: number, fallback = 0): number {
  return sampleAnim(value, t, fallback);
}

/** Insert or replace the key at clip-relative `t` (rounded), keeping sorted order.
 *  A bare constant is first promoted to a curve so the first edit starts the animation. */
export function upsertKeyframe(
  value: Animatable | undefined,
  t: number,
  v: number,
  ease?: string,
): Keyframe[] {
  const at = Math.round(t);
  const base = isAnimated(value) ? value : toKeyframes(value, at);
  const rest = base.filter((k) => k.t !== at);
  const key: Keyframe = ease ? { t: at, v, ease } : { t: at, v };
  return sortByTime([...rest, key]);
}

/** Remove the key at clip-relative `t` (rounded). Never returns an empty curve —
 *  removing the final key is a no-op (use toConstant to fully de-animate). */
export function removeKeyframe(value: Animatable | undefined, t: number): Animatable | undefined {
  if (!isAnimated(value)) return value;
  const at = Math.round(t);
  const rest = value.filter((k) => k.t !== at);
  if (rest.length === 0) return value;
  return sortByTime(rest);
}

/** The key exactly at clip-relative `t` (rounded), or undefined. */
export function keyframeAt(value: Animatable | undefined, t: number): Keyframe | undefined {
  if (!isAnimated(value)) return undefined;
  const at = Math.round(t);
  return value.find((k) => k.t === at);
}

/** The nearest keyframe time strictly after `t`, or undefined. */
export function nextKeyframeTime(value: Animatable | undefined, t: number): number | undefined {
  if (!isAnimated(value)) return undefined;
  const at = Math.round(t);
  let best: number | undefined;
  for (const k of value) if (k.t > at && (best === undefined || k.t < best)) best = k.t;
  return best;
}

/** The nearest keyframe time strictly before `t`, or undefined. */
export function prevKeyframeTime(value: Animatable | undefined, t: number): number | undefined {
  if (!isAnimated(value)) return undefined;
  const at = Math.round(t);
  let best: number | undefined;
  for (const k of value) if (k.t < at && (best === undefined || k.t > best)) best = k.t;
  return best;
}

/** Sorted, unique union of all keyframe times across the given animatable values. */
export function keyframeTimes(values: Array<Animatable | undefined>): number[] {
  const set = new Set<number>();
  for (const v of values) if (isAnimated(v)) for (const k of v) set.add(k.t);
  return [...set].sort((a, b) => a - b);
}
