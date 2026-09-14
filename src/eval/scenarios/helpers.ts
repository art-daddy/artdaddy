// Scenario authoring helpers — terse timeline builders + tolerant assertions.
// Assertions THROW a plain Error on mismatch (the oracle catches it as a Tier-1
// violation), so scenarios don't couple to a test framework. Keep Tier-1 checks
// ROBUST: assert the essential outcome of the task, not fragile exact geometry the
// model has reasonable latitude over.
import type { Clip, Timeline, Track } from "../../timeline/model";

export function timeline(tracks: Track[], canvas?: Partial<Timeline["canvas"]>): Timeline {
  return {
    units: "frames",
    canvas: { width: 1080, height: 1920, fps: 30, ...canvas },
    tracks,
  } as unknown as Timeline;
}

export function vtrack(id: string, z: number, clips: Partial<Clip>[]): Track {
  return { id, kind: "video", z, clips: clips as Clip[] } as Track;
}
export function atrack(id: string, z: number, clips: Partial<Clip>[]): Track {
  return { id, kind: "audio", z, clips: clips as Clip[] } as Track;
}
export function ttrack(id: string, z: number, clips: Partial<Clip>[]): Track {
  return { id, kind: "text", z, clips: clips as Clip[] } as Track;
}

/** A video/image clip occupying [tin,tout) frames from source [sin,sout). */
export function vclip(
  id: string,
  media: string,
  tin: number,
  tout: number,
  extra: Partial<Clip> = {},
): Partial<Clip> {
  return {
    id,
    media_ref: media,
    kind: "video",
    timeline_in: tin,
    timeline_out: tout,
    source_in: 0,
    source_out: tout - tin,
    ...extra,
  };
}
export function aclip(
  id: string,
  media: string,
  tin: number,
  tout: number,
  extra: Partial<Clip> = {},
): Partial<Clip> {
  return {
    id,
    media_ref: media,
    kind: "audio",
    timeline_in: tin,
    timeline_out: tout,
    source_in: 0,
    source_out: tout - tin,
    ...extra,
  };
}

// ── assertions ───────────────────────────────────────────────────────────────
export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
export function near(actual: number, expected: number, tol: number, what: string): void {
  assert(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tol,
    `${what}: expected ≈${expected} (±${tol}), got ${actual}`,
  );
}

// ── readers ──────────────────────────────────────────────────────────────────
export function trackOf(tl: Timeline, id: string): Track | undefined {
  return (tl.tracks ?? []).find((t) => t.id === id);
}
/** Clips of a track, sorted by start. */
export function clipsOf(tl: Timeline, trackId: string): Clip[] {
  const t = trackOf(tl, trackId);
  return [...(t?.clips ?? [])].sort((a, b) => Number(a.timeline_in) - Number(b.timeline_in));
}
export function allClips(tl: Timeline): Clip[] {
  return (tl.tracks ?? []).flatMap((t) => t.clips ?? []);
}
export function clipById(tl: Timeline, id: string): Clip | undefined {
  return allClips(tl).find((c) => c.id === id);
}
export function span(c: Clip | undefined): number {
  return c ? Number(c.timeline_out) - Number(c.timeline_in) : NaN;
}
/** True if the sorted clips of a track have no gaps and no overlaps (abutting). */
export function contiguousFrom(tl: Timeline, trackId: string, start = 0, tol = 1): boolean {
  const cs = clipsOf(tl, trackId);
  let cursor = start;
  for (const c of cs) {
    if (Math.abs(Number(c.timeline_in) - cursor) > tol) return false;
    cursor = Number(c.timeline_out);
  }
  return true;
}
