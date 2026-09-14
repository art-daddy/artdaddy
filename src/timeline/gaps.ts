// Where the empty space is on a track — the one owner of "is this frame a gap?".
//
// A gap selection is stored as a POINT (track + frame), never a span, and resolved through here
// every time it is drawn or acted on. That is deliberate: a span cached at click time goes stale
// the moment any edit shifts the frames, and a stale span is a highlight pointing at material
// that Delete would then cut. A point either resolves to the gap it is in, or to nothing.
//
// Only EDITABLE tracks have gaps here. A locked track's empty space is not selectable, because
// the ripple that Delete would run refuses a locked track — offering the selection would promise
// something the commit rejects.
import type { Timeline, Track } from "./model";

export interface Gap {
  start: number;
  end: number;
}

/** Every gap on `track`, left to right. Trailing space after the last clip is NOT a gap: it is
 *  unbounded on the right, so there is nothing to close. */
export function gapsOn(track: Track): Gap[] {
  const spans = (track.clips ?? [])
    .map((c) => [Number(c.timeline_in) || 0, Number(c.timeline_out) || 0] as const)
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  const out: Gap[] = [];
  let cursor = 0;
  for (const [tin, tout] of spans) {
    if (tin > cursor) out.push({ start: cursor, end: tin });
    cursor = Math.max(cursor, tout);
  }
  return out;
}

/** The gap containing `frame` on `trackId`, or null. */
export function gapAt(
  timeline: Timeline | null,
  trackId: string,
  frame: number,
): (Gap & { trackId: string }) | null {
  const track = (timeline?.tracks ?? []).find((t) => String(t.id) === trackId);
  if (!track || track.locked === true) return null;
  const hit = gapsOn(track).find((g) => frame >= g.start && frame < g.end);
  return hit ? { ...hit, trackId } : null;
}
