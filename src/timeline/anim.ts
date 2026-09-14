// Animatable properties: a bare number OR a Keyframe[] curve. Two consumers —
// the WebGL preview samples a numeric value per frame (sampleAnim), and the
// ffmpeg renderer compiles a per-frame expression (compileAnim). Both share the
// same easing so the preview and the export agree. Mirrors renderer.py's
// _compile_anim / _ease_progress. Pure + fully unit-tested.
import type { Animatable } from "./model";

/** Ease a normalised progress `p` in [0,1]. Unknown modes fall back to linear.
 *
 *  `hold` is a step: progress never advances, so the segment stays at its start value until the
 *  NEXT keyframe takes over. Expressing it as an easing rather than a special case is what keeps
 *  the sampler, the preview and the ffmpeg compiler from needing three separate branches. */
function easeNum(p: number, mode: string | undefined): number {
  switch (mode) {
    case "hold":
      return 0;
    case "ease-in":
      return p * p;
    case "ease-out":
      return 1 - (1 - p) * (1 - p);
    case "ease-in-out": // smoothstep
      return p * p * (3 - 2 * p);
    default:
      return p;
  }
}

/** True when an animatable actually carries a value. The agent's typed params arrive as an
 *  explicit `null` for "unset", so null must read the same as absent. */
export function hasVal(v: unknown): boolean {
  return typeof v === "number" || Array.isArray(v);
}

/** Sample an Animatable at clip-relative time `at`. `at` and the keyframe `t`
 *  must share units — FRAMES in the frames timeline, SECONDS in the seconds
 *  view. A bare number is constant; undefined/empty yields `fallback`. Values
 *  are held flat before the first and after the last keyframe. */
export function sampleAnim(value: Animatable | undefined, at: number, fallback = 0): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "number") return value;
  const pts = value;
  if (pts.length === 0) return fallback;
  if (at <= pts[0].t) return pts[0].v;
  const last = pts[pts.length - 1];
  if (at >= last.t) return last.v;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    if (at < b.t) {
      const span = b.t - a.t;
      const p = span > 0 ? (at - a.t) / span : 0;
      return a.v + (b.v - a.v) * easeNum(Math.max(0, Math.min(1, p)), a.ease);
    }
  }
  return last.v;
}

/** Fade-envelope multiplier in [0,1] at clip-relative time `rel`. `rel`, `dur`, `fin`,
 *  `fout` share units (FRAMES in the preview, SECONDS in the renderer). Linear ramp
 *  0->1 over the fade-in and 1->0 over the fade-out, 1 in between. Mirrors the ffmpeg
 *  `min(clip(...),clip(...))` alpha expression so preview and render agree. */
export function fadeMul(rel: number, dur: number, fin: number, fout: number): number {
  let m = 1;
  if (fin > 0) m = Math.min(m, Math.max(0, Math.min(1, rel / fin)));
  if (fout > 0) m = Math.min(m, Math.max(0, Math.min(1, (dur - rel) / fout)));
  return m;
}

/** Ease a progress sub-expression `p` (already clipped to [0,1]) as ffmpeg. */
function easeExpr(p: string, mode: string | undefined): string {
  switch (mode) {
    case "hold":
      return "0";
    case "ease-in":
      return `pow(${p},2)`;
    case "ease-out":
      return `(1-pow(1-${p},2))`;
    case "ease-in-out":
      return `(pow(${p},2)*(3-2*${p}))`;
    default:
      return p;
  }
}

/** Compile an Animatable into a per-frame ffmpeg expression in `timeVar`
 *  (seconds). `offset` (seconds) is subtracted to get clip-relative time, so a
 *  seconds-view keyframe `t` lines up with the clip. Values hold flat outside
 *  the keyframe range. Mirrors renderer.py::_compile_anim. */
export function compileAnim(value: Animatable, timeVar: string, offset = 0): string {
  if (typeof value === "number") return value.toFixed(6);
  const pts = value;
  if (pts.length === 1) return pts[0].v.toFixed(6);
  const local = Math.abs(offset) < 1e-9 ? timeVar : `(${timeVar}-${offset.toFixed(6)})`;
  // Hold the last value beyond the final keyframe, then nest segments back-to-front.
  let expr = pts[pts.length - 1].v.toFixed(6);
  for (let i = pts.length - 2; i >= 0; i -= 1) {
    const ti = pts[i].t;
    const vi = pts[i].v;
    const tj = pts[i + 1].t;
    const vj = pts[i + 1].v;
    const dur = tj - ti || 1e-6;
    const p = `clip((${local}-${ti.toFixed(6)})/${dur.toFixed(6)},0,1)`;
    const eased = easeExpr(p, pts[i].ease);
    expr = `if(lt(${local},${tj.toFixed(6)}),(${vi.toFixed(6)}+(${(vj - vi).toFixed(6)})*${eased}),${expr})`;
  }
  // Hold the first value before the first keyframe.
  expr = `if(lt(${local},${pts[0].t.toFixed(6)}),${pts[0].v.toFixed(6)},${expr})`;
  return expr;
}
