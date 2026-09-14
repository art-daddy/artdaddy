// Pure pixel <-> frame <-> second mapping for the timeline view, plus edge
// snapping. All timeline interaction math lives here so it stays unit-testable;
// the React component only wires pointer events to these functions.
import type { Timeline } from "./model";

/** Seconds -> x pixels, given zoom (px/sec) and horizontal scroll (px). */
export function secToX(sec: number, zoom: number, scrollX = 0): number {
  return sec * zoom - scrollX;
}
/** x pixels -> seconds. */
export function xToSec(x: number, zoom: number, scrollX = 0): number {
  return (x + scrollX) / zoom;
}
/** Frame -> x pixels. */
export function frameToX(frame: number, fps: number, zoom: number, scrollX = 0): number {
  return secToX(frame / fps, zoom, scrollX);
}
/** x pixels -> nearest whole frame. */
export function xToFrame(x: number, fps: number, zoom: number, scrollX = 0): number {
  return Math.round(xToSec(x, zoom, scrollX) * fps);
}

/** Snap targets (in frames): 0, the playhead, and every clip edge except the
 *  clips currently being dragged.
 *
 *  `excludeIds` is the WHOLE moving set, not just the grabbed clip: a linked A/V pair (and a
 *  multi-clip selection) travels together, so leaving a travelling companion in the target list
 *  offers the clip its own starting edges and drags snap straight back to where they began. */
export function snapTargets(
  timeline: Timeline,
  opts: { excludeIds?: Iterable<string>; playheadFrame?: number } = {},
): number[] {
  const skip = new Set(opts.excludeIds ?? []);
  const set = new Set<number>([0]);
  if (opts.playheadFrame != null && Number.isFinite(opts.playheadFrame))
    set.add(Math.round(opts.playheadFrame));
  for (const tr of timeline.tracks ?? []) {
    for (const c of tr.clips ?? []) {
      if (skip.has(String(c.id))) continue;
      if (typeof c.timeline_in === "number") set.add(c.timeline_in);
      if (typeof c.timeline_out === "number") set.add(c.timeline_out);
    }
  }
  return [...set].sort((a, b) => a - b);
}

/** Snap a candidate frame to the nearest target within thresholdPx (screen
 *  space). Returns the candidate unchanged if nothing is close enough. */
export function snapFrame(
  candidate: number,
  targets: number[],
  fps: number,
  zoom: number,
  thresholdPx: number,
): number {
  const candPx = (candidate / fps) * zoom;
  let best = candidate;
  let bestDist = thresholdPx;
  for (const t of targets) {
    const dist = Math.abs((t / fps) * zoom - candPx);
    if (dist <= bestDist) {
      bestDist = dist;
      best = t;
    }
  }
  return best;
}

/** Snap a MOVE by EITHER edge, returning the resulting `timeline_in`.
 *
 *  Snapping only the head means a clip can butt its start against a neighbour but
 *  never its end — so closing a gap from the left is impossible, which is not how
 *  an NLE behaves. Both edges are offered and the one that moves LESS wins; a tie
 *  goes to the head. A tail snap that would push the clip before frame 0 is
 *  rejected rather than clamped, because clamping would land the clip somewhere
 *  the user didn't aim for.
 *
 *  Whether an edge snapped is decided by it LANDING ON A TARGET, not by the value
 *  changing: an edge already sitting exactly on a target is the strongest possible
 *  snap, and testing for movement would score it as "no snap" and let the opposite
 *  edge drag it off an alignment the user had already achieved. */
export function snapMoveIn(
  rawIn: number,
  len: number,
  targets: number[],
  fps: number,
  zoom: number,
  thresholdPx: number,
): number {
  const raw = Math.max(0, rawIn);
  const byHead = snapFrame(raw, targets, fps, zoom, thresholdPx);
  const byTail = snapFrame(raw + len, targets, fps, zoom, thresholdPx) - len;
  const headSnapped = targets.includes(byHead);
  const tailSnapped = byTail >= 0 && targets.includes(byTail + len);

  if (headSnapped && tailSnapped) {
    return Math.abs(byTail - raw) < Math.abs(byHead - raw) ? byTail : byHead;
  }
  if (headSnapped) return byHead;
  if (tailSnapped) return byTail;
  return raw;
}

/** Total duration of the timeline in frames (the max clip end across tracks). */
export function totalFrames(timeline: Timeline): number {
  let max = 0;
  for (const tr of timeline.tracks ?? []) {
    for (const c of tr.clips ?? []) {
      if (typeof c.timeline_out === "number" && c.timeline_out > max) max = c.timeline_out;
    }
  }
  return max;
}
