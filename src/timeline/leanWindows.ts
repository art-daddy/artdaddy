// Fix 2 (Phase 3a): windows for the per-pixel alpha filters, and the frames the dip's colour layer needs.
//
// Today (0.27.0) a clip with a transition, a fade or an animated opacity runs a `geq` over its picture on EVERY frame of the clip, although the
// number it multiplies the alpha plane by is exactly 1.0 outside a short stretch of time. Adding `:enable='<window>'` to that `geq` makes ffmpeg
// pass the frame through untouched outside the window, which is the same picture as multiplying the alpha by 1.0.
//
// RULES. A window may only be WIDER than the frames whose factor is not 1, never narrower, and it must be tight enough to be worth having.
// Every threshold sits half a frame from every frame time (the compositor's own UJ-026 rule, `frameGate` in render.ts: a bound printed to six
// places lands a hair off its frame, so a bound AT a frame is decided by rounding). Everything is pure and never throws: null means "no window,
// keep today's `geq` as it is".
//
// Times are the frame's presentation time in seconds: `T` inside a `geq` and `t` inside an `enable` are the same number, pts times the time base as a double, so frame k of the project has
// T = k * (1 / fps), which is NOT always the same float as k / fps (it differs on about a third of the frames; tested against the app's ffmpeg, closure G28). The builder prints seconds with
// toFixed(6) and the factors use the PRINTED numbers, so these functions print first and reason about what ffmpeg will see.
import { compileLeanExpr, type LeanExpr } from "./leanExpr";
import { assertNever, type TransitionKind } from "./transition";

/** Times above this are refused: toFixed(6) prints plain digits (never an exponent) far below it. */
const MAX_SECONDS = 1e9;
/** A frame rate outside this is not a video's: the half-frame arithmetic below is not what the proofs assume. */
const MIN_FPS = 1e-3;
const MAX_FPS = 1000;
/** A frame within this many seconds of a transition window's closing edge counts as past it. Printing one time moves it by at most 5e-7, the three
 *  numbers that make up the edge by 1.5e-6, so a frame that sits ON the edge in exact arithmetic is always inside this band. */
const TIE_SECONDS = 5e-6;
/** A fade window that would close fewer frames than this is not worth the risk: no window. */
const MIN_CLOSED_FRAMES = 2;
/** Opacity: the evaluation is brute force over the clip's frames (about 3 microseconds each), so a clip longer than this (one hour at 60 fps) keeps today's `geq`. */
const MAX_OPACITY_FRAMES = 216_000;
const MAX_OPACITY_EXPR_CHARS = 100_000;
const MAX_INTERVALS = 12;
/** Opacity: a window that would stay open on more than this share of the clip's frames gains too little to be worth the risk. */
const MAX_OPEN_SHARE = 0.85;
const MAX_WINDOW_CHARS = 400;
/** A streamed export builds the whole graph once per partition, with the same clips each time: the answer for one curve and frame range is kept. */
const OPACITY_MEMO_ENTRIES = 32;
const opacityMemo = new Map<string, string | null>();

/** Six decimals, never an exponent, never "-0.000000": the way the builder prints a time, and the only way a window prints one. A number that cannot
 *  be printed so (not finite, or too large for plain digits) throws, which `guarded` turns into "no window". */
function printed(x: number): string {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21)
    throw new RangeError(`cannot print ${x} as a time`);
  const text = x.toFixed(6);
  return text === "-0.000000" ? "0.000000" : text;
}

/** The number ffmpeg reads back from a printed time. */
function asPrinted(x: number): number {
  return Number(printed(x));
}

/** The next float above (up) or below a number. */
function stepUlp(x: number, up: boolean): number {
  if (x === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  view.setBigInt64(0, view.getBigInt64(0) + (x > 0 === up ? 1n : -1n));
  return view.getFloat64(0);
}

/** The times frame k can be read at: k / fps and k * (1 / fps), the two ways to compute it (a presentation time is a count times the time base), and one float step either side of each. */
function frameReadings(k: number, fps: number): number[] {
  const a = k / fps;
  const b = k * (1 / fps);
  return [a, b, stepUlp(a, true), stepUlp(a, false), stepUlp(b, true), stepUlp(b, false)];
}

function usableSeconds(x: number): boolean {
  return Number.isFinite(x) && Math.abs(x) <= MAX_SECONDS;
}

function usableFps(fps: number): boolean {
  return Number.isFinite(fps) && fps >= MIN_FPS && fps <= MAX_FPS;
}

function guarded(build: () => string | null): string | null {
  try {
    return build();
  } catch {
    return null;
  }
}

export interface TransitionWindowRule {
  /** The factor is exactly 1 for every column from the end of the transition on, so a one-sided window is a superset of the frames that need the filter. */
  readonly closes: boolean;
  readonly why: string;
}

/** What each transition kind's alpha factor does once its progress p = clip((T-start)/dur,0,1) has reached 1 (render.ts, the `cross` switch). A kind
 *  added to TRANSITION_KINDS does not compile until it is decided here, and the oracle test walks every kind against the real builder's text. */
export function transitionWindowRule(kind: TransitionKind): TransitionWindowRule {
  switch (kind) {
    case "crossfade":
      return { closes: true, why: "the factor is p itself, which is 1 from p = 1" };
    case "custom":
      return {
        closes: true,
        why: "a custom expression is not evaluated: it renders as the crossfade, whose factor is p",
      };
    case "whip":
      return {
        closes: true,
        why: "the factor is s*s*(3-2*s) with s = clip((p-X/W+0.12)/0.12,0,1); at p = 1 and X <= W-1 the numerator is at least 0.12+1/W, so s is above 1 and clips to 1",
      };
    case "wipe-l":
      return {
        closes: true,
        why: "the factor is lt(X,W*p); at p = 1 it is lt(X,W), true for every column",
      };
    case "wipe-r":
      return {
        closes: true,
        why: "the factor is gt(X,W*(1-p)); at p = 1 it is gt(X,0), false for column 0 (0.27.0 leaves that column see-through). The owner decided that the window closes anyway; the caller decides which clips may use it",
      };
    case "dip-to-black":
    case "dip-to-white":
      return {
        closes: true,
        why: "the clip's own factor is clip(2*p-1,0,1), 1 from p = 1 (the colour layer is dipLayerFrames')",
      };
    default:
      return assertNever(kind);
  }
}

/** The window of the `geq` a transition puts on the INCOMING clip: `alpha(X,Y)*<factor of p>` with p = clip((T-start)/dur,0,1).
 *
 *  `startSec` (tin - leadIn) and `durSec` are the numbers the builder holds BEFORE it prints them with toFixed(6). Every kind's factor is exactly 1 from
 *  p = 1 on (transitionWindowRule), and p is 1 from E = start + dur on, so the window is one-sided: `lt(t,theta)`, open from the clip's first frame
 *  (the lead-in clones included) until the first frame that is at least half a frame past E. The factor is not 1 only where T < E (plus float
 *  noise far below half a frame), so every such frame is open.
 *
 *  theta is the half-frame time between the last open frame and the first closed one, so it is never AT a frame time. That matters for exactly one
 *  frame: a transition of an odd number of frames (the 15 of a half second at 30 fps) ends E on a half frame, so E + half a frame IS a frame
 *  time, and a bound printed there is decided by the sixth decimal. For the kinds whose factor is 1 on that frame it changes nothing; for wipe-right
 *  (the one kind that is NOT 1 at its end) it decides whether that frame still shows today's thin line. This function closes it: a frame within
 *  TIE_SECONDS of E + half a frame counts as past it.
 *
 *  wipe-r returns the same text as the other kinds; whether a clip may use it (static, unrotated, unblended) is the caller's decision. */
export function transitionWindow(
  kind: TransitionKind,
  startSec: number,
  durSec: number,
  fps: number,
): string | null {
  return guarded(() => {
    if (!transitionWindowRule(kind).closes) return null;
    if (!usableSeconds(startSec) || !usableSeconds(durSec) || !usableFps(fps)) return null;
    const start = asPrinted(startSec);
    const dur = asPrinted(durSec);
    if (!(dur > 0)) return null;
    const end = start + dur;
    const firstClosed = Math.ceil((end + 0.5 / fps - TIE_SECONDS) * fps);
    return `lt(t,${printed((firstClosed - 0.5) / fps)})`;
  });
}

/** The window of the fade `geq`: `alpha(X,Y)*min(clip((T-tin)/fin,0,1),clip((tout-T)/fout,0,1))`, each part present only when its fade is above 0
 *  (render.ts `fadeAlphaExpr`; the arguments are the same seconds). The factor is exactly 1 on [tin+fin, tout-fout] and below 1 everywhere else, the
 *  hold clones after tout included (the out ramp is 0 there), so the window is two half-lines, open until half a frame after the first ramp ends and
 *  from half a frame before the second ramp starts: `lte(t,a)+gte(t,b)`, or the one half-line when only one fade exists. A sum is non-zero when
 *  either side is open. null when no fade exists, when the ramps cover the clip, or when the closed stretch holds fewer than MIN_CLOSED_FRAMES frames. */
export function fadeWindow(
  tin: number,
  tout: number,
  fadeIn: number,
  fadeOut: number,
  fps: number,
): string | null {
  return guarded(() => {
    if (![tin, tout, fadeIn, fadeOut].every(usableSeconds) || !usableFps(fps)) return null;
    const hasIn = fadeIn > 0;
    const hasOut = fadeOut > 0;
    if (!hasIn && !hasOut) return null;
    const from = asPrinted(tin);
    const to = asPrinted(tout);
    const fin = asPrinted(fadeIn);
    const fout = asPrinted(fadeOut);
    if ((hasIn && !(fin > 0)) || (hasOut && !(fout > 0)) || !(to > from)) return null;
    const margin = 0.5 / fps;
    const inEdge = from + fin + margin;
    const outEdge = to - fout - margin;
    // The whole frames the window closes lie strictly between its two edges, each half a frame past a ramp's end. A side without a ramp has no edge: its bound sits half a frame
    // outside the clip, so the clip's own first (last) frame counts, and a time that prints a hair above or below its frame cannot move the count (a bound AT a frame is decided by rounding).
    const closedFrom = hasIn ? inEdge : from - margin;
    const closedTo = hasOut ? outEdge : to - margin;
    if (Math.ceil(closedTo * fps) - Math.floor(closedFrom * fps) - 1 < MIN_CLOSED_FRAMES)
      return null;
    const parts: string[] = [];
    if (hasIn) parts.push(`lte(t,${printed(inEdge)})`);
    if (hasOut) parts.push(`gte(t,${printed(outEdge)})`);
    return parts.join("+");
  });
}

/** The window of the animated-opacity `geq`: `alpha(X,Y)*clip((<curve>),0,1)`. `factorExpr` is the curve text `compileAnim` wrote, a function of T alone;
 *  the clip is drawn on frames [firstFrame, endFrame).
 *
 *  No reasoning about easing curves: the curve is EVALUATED, with the arithmetic ffmpeg uses (leanExpr.ts; its pow(x, 2) can be a float off from ffmpeg's C library's: a frame that needs the filter only under that
 *  was next to a marked frame, so covered by the widening below, on every curve of a search of 53,400, closure G29: a search result, not a guarantee), at every reading of the frame's time (frameReadings: k * (1/fps), which is what ffmpeg reads, k/fps, and a float step either side of each) for the frames
 *  firstFrame-2 through endFrame+1. A frame is marked when its factor is not exactly 1 (a value that is NaN is marked too) at its own time k/fps. Each run of marked
 *  frames is widened by one frame on each side, so that a frame whose time ffmpeg computes one float step off (pts times the time base) still lands
 *  inside, and runs that touch are merged. A frame that is fine at k/fps but not at another reading of its time (k * (1/fps), or a float step either
 *  side of either) is covered as it is, one frame, not widened. Each run becomes `between(t,a,b)` with a and b half a frame outside its first and last frame. A run that
 *  includes the first (last) evaluated frame is left OPEN on that side (`lte` / `gte`): the stream may hold clones beyond the clip's span.
 *
 *  null when the curve cannot be evaluated or is not a function of T alone, when no frame is marked (the filter is then a no-op the caller may
 *  drop; this function does not decide that), when the window would be open on more than MAX_OPEN_SHARE of the clip's frames, when it needs more than
 *  MAX_INTERVALS terms, or when the clip is longer than MAX_OPACITY_FRAMES. */
export function opacityWindow(
  factorExpr: string,
  firstFrame: number,
  endFrame: number,
  fps: number,
): string | null {
  return guarded(() => {
    if (typeof factorExpr !== "string" || factorExpr.length === 0) return null;
    if (factorExpr.length > MAX_OPACITY_EXPR_CHARS || /\b[XYWH]\b/.test(factorExpr)) return null;
    if (!Number.isSafeInteger(firstFrame) || !Number.isSafeInteger(endFrame)) return null;
    if (!(endFrame > firstFrame) || endFrame - firstFrame > MAX_OPACITY_FRAMES || !usableFps(fps))
      return null;
    const key = `${fps}|${firstFrame}|${endFrame}|${factorExpr}`;
    const known = opacityMemo.get(key);
    if (known !== undefined) return known;
    const curve = compileLeanExpr(factorExpr);
    const answer = curve ? opacityWindowOf(curve, firstFrame, endFrame, fps) : null;
    if (opacityMemo.size >= OPACITY_MEMO_ENTRIES)
      opacityMemo.delete(opacityMemo.keys().next().value!);
    opacityMemo.set(key, answer);
    return answer;
  });
}

function opacityWindowOf(
  curve: LeanExpr,
  firstFrame: number,
  endFrame: number,
  fps: number,
): string | null {
  const lo = firstFrame - 2;
  const count = endFrame - firstFrame + 4;
  const marked = new Uint8Array(count);
  const noisy = new Uint8Array(count);
  // clip((curve),0,1) is exactly 1 only when the curve is at or above 1; a NaN fails the comparison and is marked. A frame is `marked` when that fails at its own time. A frame whose
  // own time is fine but another reading of it is not (frameReadings: a time is only known to a float step, and a curve printed to six places can dip a hair below 1 one step before a key,
  // or jump there, a hold) is `noisy`: the window covers it, and, because the readings are already the float steps, it is not widened.
  for (let i = 0; i < count; i += 1) {
    const readings = frameReadings(lo + i, fps);
    if (!(curve({ T: readings[0], W: 1, H: 1 }) >= 1)) marked[i] = 1;
    else if (!readings.every((T) => curve({ T, W: 1, H: 1 }) >= 1)) noisy[i] = 1;
  }
  const widened: Array<[first: number, last: number]> = [];
  for (let i = 0; i < count; i += 1) {
    if (marked[i] === 0) continue;
    let j = i;
    while (j + 1 < count && marked[j + 1] === 1) j += 1;
    const previous = widened[widened.length - 1];
    if (previous && i - 1 <= previous[1] + 1) previous[1] = j + 1;
    else widened.push([i - 1, j + 1]);
    i = j;
  }
  for (let i = 0; i < count; i += 1) if (noisy[i] === 1) widened.push([i, i]);
  widened.sort((x, y) => x[0] - y[0]);
  const runs: Array<[first: number, last: number]> = [];
  for (const run of widened) {
    const previous = runs[runs.length - 1];
    if (previous && run[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], run[1]);
    else runs.push([run[0], run[1]]);
  }
  if (runs.length === 0 || runs.length > MAX_INTERVALS) return null;
  // the frames the clip is drawn on, firstFrame .. endFrame-1, sit at indexes 2 .. count-3
  let open = 0;
  for (const [first, last] of runs)
    open += Math.max(0, Math.min(last, count - 3) - Math.max(first, 2) + 1);
  if (open > MAX_OPEN_SHARE * (count - 4)) return null;
  const terms: string[] = [];
  for (const [n, [first, last]] of runs.entries()) {
    const openLeft = n === 0 && marked[0] + noisy[0] > 0;
    const openRight = n === runs.length - 1 && marked[count - 1] + noisy[count - 1] > 0;
    if (openLeft && openRight) return null;
    const a = printed((lo + first - 0.5) / fps);
    const b = printed((lo + last + 0.5) / fps);
    terms.push(openLeft ? `lte(t,${b})` : openRight ? `gte(t,${a})` : `between(t,${a},${b})`);
  }
  const text = terms.join("+");
  return text.length < MAX_WINDOW_CHARS ? text : null;
}

/** The frames the dip's colour layer has to exist for (render.ts, the layer behind `dipov`): the frames the overlay's own gate opens,
 *  [gateFirst, gateEnd), plus one frame on each side, cut to the command's frame range when it has one (`range` = a streamed partition's
 *  [from, to), project frames) and to [0, totalFrames), the frames the base canvas stream has in this command. Returns {from, to} (project
 *  frames, `to` exclusive) or null when the overlay's gate opens on no frame of this command: the caller then emits neither the layer nor its
 *  overlay. Integers only; anything else is null. */
export function dipLayerFrames(
  gateFirst: number,
  gateEnd: number,
  range: { from: number; to: number } | null,
  totalFrames: number,
): { from: number; to: number } | null {
  const numbers = range
    ? [gateFirst, gateEnd, totalFrames, range.from, range.to]
    : [gateFirst, gateEnd, totalFrames];
  if (!numbers.every((n) => Number.isSafeInteger(n)) || !(totalFrames > 0)) return null;
  const lo = Math.max(0, range ? range.from : 0);
  const hi = Math.min(totalFrames, range ? range.to : totalFrames);
  const openFrom = Math.max(gateFirst, lo);
  const openTo = Math.min(gateEnd, hi);
  if (!(openTo > openFrom)) return null;
  return { from: Math.max(openFrom - 1, lo), to: Math.min(openTo + 1, hi) };
}
