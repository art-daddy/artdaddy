// Fix 1 (Phase 3a): the cover aperture of a zooming picture as an EXACT mask stream instead of a per-pixel `geq` on every frame.
//
// Today (0.27.0) a clip with an animated size and fit "cover" runs one `geq` over its pre-scaled picture on every frame; its alpha is 1 inside the
// box the zoom shows and 0 outside (render.ts `coverAperture`). That is a rectangle that changes from frame to frame, so the same alpha can be made as
// a small gray stream (white, with black `drawbox` strips outside the rectangle of each frame) merged into the picture's alpha plane with `alphamerge`.
// LAB-W1 and LAB-AUDIT measured 0 differing pixels on every witness they hashed; this file is the product form of that lab code, and the parity proof
// of the build (`framemd5` of the picture just before the encoder, flag off against flag on) is what decides it again, witness by witness.
//
// Everything here is pure. The rectangle of a frame comes from the product's OWN aperture expressions evaluated in the arithmetic of ffmpeg's
// evaluator (leanExpr.ts), never guessed: the box of frame f is the set of integer columns X with (W - a)/2 <= X < (W + a)/2 (and the same for rows),
// where a and b are the aperture's width and height at T = f * (1 / fps).
import { compileLeanExpr } from "./leanExpr";

/** Columns x0 through x1 - 1 and rows y0 through y1 - 1, in pre-scaled pixels. */
export type Rect = readonly [x0: number, x1: number, y0: number, y1: number];

export interface ApertureInput {
  /** The aperture's width and height in pre-scaled pixels as expressions of T, W and H: the text render.ts writes into the `geq`. */
  widthExpr: string;
  heightExpr: string;
  /** The pre-scaled picture's size as ffmpeg itself reports it (leanProbe.ts), never recomputed here. */
  width: number;
  height: number;
  /** The project's frame rate (a whole number: the exporter's canvas rate). */
  fps: number;
  /** The project frames [from, to) the mask must cover exactly: the frames the clip is drawn on. */
  from: number;
  to: number;
}

/** The mask runs this many frames past the clip's last drawn frame, each carrying the rectangle of its OWN time, so a picture frame that lands one
 *  past its expected end still meets a mask frame (alphamerge repeats the last mask frame after the mask ends, but never fabricates an earlier one). */
export const LEAN_MASK_EXTRA_FRAMES = 2;

/** Budget (DESIGN-3a 2.1 item 6, revised 14 Nov evening after the first measurements: a 1.0 to 1.2 zoom on a 1080x1920 canvas needs 252 groups whatever its length, a 1.0 to 1.3
 *  zoom about 450, and a group costs a few microseconds per frame, so the first guess of 400 would have refused ordinary zooms). Over this, the clip keeps `geq`. */
export const LEAN_MAX_GROUPS_PER_CLIP = 2000;

/** The rectangle of every frame in [from, to + LEAN_MASK_EXTRA_FRAMES), or null when an expression is outside the evaluator's subset or gives a
 *  value that is not a finite number (the caller keeps today's recipe). */
export function apertureRects(input: ApertureInput): Rect[] | null {
  const { width: W, height: H, fps } = input;
  if (!(W > 0 && H > 0 && Number.isInteger(W) && Number.isInteger(H) && fps >= 1)) return null;
  if (!(input.to > input.from)) return null;
  const widthOf = compileLeanExpr(input.widthExpr);
  const heightOf = compileLeanExpr(input.heightExpr);
  if (!widthOf || !heightOf) return null;
  const tick = 1 / fps; // av_q2d of the 1/fps time base every clip chain has after its `fps` filter
  const rects: Rect[] = [];
  for (let f = input.from; f < input.to + LEAN_MASK_EXTRA_FRAMES; f += 1) {
    const env = { T: f * tick, W, H };
    const a = widthOf(env);
    const b = heightOf(env);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    // gte(X,(W-a)/2) * lt(X,(W+a)/2) on integer X selects the columns ceil((W-a)/2) through ceil((W+a)/2) - 1; the same for rows
    rects.push([
      Math.min(W, Math.max(0, Math.ceil((W - a) / 2))),
      Math.min(W, Math.max(0, Math.ceil((W + a) / 2))),
      Math.min(H, Math.max(0, Math.ceil((H - b) / 2))),
      Math.min(H, Math.max(0, Math.ceil((H + b) / 2))),
    ]);
  }
  return rects;
}

export interface MaskStream {
  /** The mask's filter chain, from its source to its last filter (no input label, no output label). */
  text: string;
  groups: number;
  boxes: number;
}

/** The strips outside a rectangle, each with a positive width and height (a `drawbox` width or height of 0 means the WHOLE frame, so a
 *  zero-size strip must never be written). */
export function stripsOutside(
  rect: Rect,
  width: number,
  height: number,
): Array<[x: number, y: number, w: number, h: number]> {
  const [x0, x1, y0, y1] = rect;
  const strips: Array<[number, number, number, number]> = [];
  if (x0 > 0) strips.push([0, 0, x0, height]);
  if (x1 < width) strips.push([x1, 0, width - x1, height]);
  if (y0 > 0) strips.push([0, 0, width, y0]);
  if (y1 < height) strips.push([0, y1, width, height - y1]);
  return strips;
}

/** The mask stream for the rectangles `apertureRects` returned: a white gray canvas of the picture's size with black strips outside each
 *  frame's rectangle, one group of strips per run of equal rectangles, switched by the mask's own frame number, and stamped in PROJECT time
 *  (`setpts=PTS+from`, the way the compositor's colour sources are) so it pairs by timestamp with the picture's frames. null = over budget. */
export function maskStream(input: ApertureInput, rects: readonly Rect[]): MaskStream | null {
  const { width: W, height: H, fps } = input;
  const groups: Array<{ from: number; to: number; rect: Rect }> = [];
  rects.forEach((rect, n) => {
    const last = groups[groups.length - 1];
    if (last && last.rect.every((v, i) => v === rect[i])) last.to = n;
    else groups.push({ from: n, to: n, rect });
  });
  if (groups.length > LEAN_MAX_GROUPS_PER_CLIP) return null;
  const boxes: string[] = [];
  for (const g of groups)
    for (const [x, y, w, h] of stripsOutside(g.rect, W, H))
      boxes.push(
        `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black:t=fill:enable='between(n,${g.from},${g.to})'`,
      );
  // half a frame short, so that printing the duration cannot add a frame (the compositor's colour sources do the same)
  const duration = ((rects.length - 0.5) / fps).toFixed(6);
  return {
    text:
      `color=c=white:s=${W}x${H}:r=${fps}:d=${duration},format=gray` +
      `${boxes.map((b) => `,${b}`).join("")},setpts=PTS+${input.from}`,
    groups: groups.length,
    boxes: boxes.length,
  };
}
