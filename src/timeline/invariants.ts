// Shared timeline invariants — the SINGLE source of truth for the predicates the
// property test asserts after every random op (invariants.property.test.ts) AND
// the eval oracle checks after every model scenario (oracle.ts). Keeping them here
// means a silent desync like t008 fails the EVAL too, not just the property test.
//
// Each predicate is pure and returns true when the invariant holds. They are
// deliberately defensive (tolerate partial / malformed clips) — the whole point is
// to catch a bad state, not to trust the shape. `timelineInvariantViolations` runs
// the whole battery and names what broke (for the oracle's silentCorruption signal).
import type { Timeline } from "./model";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime predicates over possibly-malformed data
type Any = any;

/** Every clip paired with its track. */
export function eachClip(tl: Timeline): Array<{ c: Any; t: Any }> {
  const out: Array<{ c: Any; t: Any }> = [];
  for (const t of (tl as Any)?.tracks ?? []) for (const c of t?.clips ?? []) out.push({ c, t });
  return out;
}

/** No two clips overlap on a track, and every clip has positive length. */
export function noBadOverlaps(tl: Timeline): boolean {
  for (const t of (tl as Any)?.tracks ?? []) {
    const cs = (t.clips ?? [])
      .slice()
      .sort((a: Any, b: Any) => (Number(a.timeline_in) || 0) - (Number(b.timeline_in) || 0));
    let prevOut = -Infinity;
    for (const c of cs) {
      const tin = Number(c.timeline_in) || 0;
      const tout = Number(c.timeline_out) || 0;
      if (tout <= tin) return false;
      if (tin < prevOut) return false;
      prevOut = tout;
    }
  }
  return true;
}

/** Same-source split A/V (shared link_group AND media_ref) stay locked together:
 *  identical length AND identical speed — a mismatch desyncs playback (the t008 bug). */
export function linkLockOk(tl: Timeline): boolean {
  const groups = new Map<string, Any[]>();
  for (const { c } of eachClip(tl)) {
    if (!c.link_group) continue;
    const arr = groups.get(c.link_group) ?? [];
    arr.push(c);
    groups.set(c.link_group, arr);
  }
  for (const clips of groups.values()) {
    const lenByMedia = new Map<string, Set<number>>();
    const speedByMedia = new Map<string, Set<number>>();
    for (const c of clips) {
      const key = String(c.media_ref);
      const len = (Number(c.timeline_out) || 0) - (Number(c.timeline_in) || 0);
      const speed = Number(c.speed ?? 1) || 1;
      (lenByMedia.get(key) ?? lenByMedia.set(key, new Set<number>()).get(key)!).add(len);
      (speedByMedia.get(key) ?? speedByMedia.set(key, new Set<number>()).get(key)!).add(speed);
    }
    for (const set of lenByMedia.values()) if (set.size > 1) return false;
    for (const set of speedByMedia.values()) if (set.size > 1) return false;
  }
  return true;
}

/** Link refs are well-formed: a link_group, when present, is a non-empty string.
 *  A LONE member is intentional (normalizeLinks only re-locks groups of >=2). */
export function linkRefsOk(tl: Timeline): boolean {
  for (const { c } of eachClip(tl)) {
    if (
      "link_group" in c &&
      c.link_group != null &&
      (typeof c.link_group !== "string" || c.link_group === "")
    )
      return false;
  }
  return true;
}

/** Frame fields are integers and no clip starts before frame 0. */
export function framesOk(tl: Timeline): boolean {
  for (const { c } of eachClip(tl)) {
    for (const k of ["timeline_in", "timeline_out", "source_in", "source_out"]) {
      const v = c[k];
      if (v !== undefined && v !== null && !Number.isInteger(v)) return false;
    }
    if ((Number(c.timeline_in) || 0) < 0) return false;
  }
  return true;
}

/** A clip's source span is non-empty (source_out > source_in). */
export function sourceSpansOk(tl: Timeline): boolean {
  for (const { c } of eachClip(tl)) {
    if (
      typeof c.source_in === "number" &&
      typeof c.source_out === "number" &&
      !(c.source_out > c.source_in)
    )
      return false;
  }
  return true;
}

/** No two clips anywhere share an id. */
export function uniqueClipIds(tl: Timeline): boolean {
  const seen = new Set<string>();
  for (const { c } of eachClip(tl)) {
    if (c.id == null) continue;
    if (seen.has(String(c.id))) return false;
    seen.add(String(c.id));
  }
  return true;
}

/** A clip's kind is compatible with its track (audio clips only on audio tracks). */
export function trackKindOk(tl: Timeline): boolean {
  for (const t of (tl as Any)?.tracks ?? []) {
    for (const c of t.clips ?? []) {
      if (t.kind === "audio" && c.kind !== "audio") return false;
      if (t.kind === "video" && c.kind === "audio") return false;
    }
  }
  return true;
}

/** Each track's clips array is stored ordered by timeline_in (the pipeline sorts). */
export function clipsSorted(tl: Timeline): boolean {
  for (const t of (tl as Any)?.tracks ?? []) {
    const cs = t.clips ?? [];
    for (let i = 1; i < cs.length; i++) {
      if ((Number(cs[i].timeline_in) || 0) < (Number(cs[i - 1].timeline_in) || 0)) return false;
    }
  }
  return true;
}

/** Every keyframe track has strictly increasing, integer, NON-NEGATIVE times. */
export function keyframesMonotonic(tl: Timeline): boolean {
  const trackOk = (v: Any): boolean => {
    if (!Array.isArray(v)) return true;
    let prev = -1;
    for (const kf of v) {
      const t = Number(kf?.t);
      if (!Number.isInteger(t) || t <= prev) return false;
      prev = t;
    }
    return true;
  };
  for (const { c } of eachClip(tl)) {
    for (const key of ["opacity", "rotate", "volume"]) if (!trackOk(c[key])) return false;
    const tf = c.transform;
    if (tf)
      for (const v of [tf.position?.x, tf.position?.y, tf.scale, tf.scale_x, tf.scale_y])
        if (!trackOk(v)) return false;
  }
  return true;
}

/** Every SCALAR knob sits within the bounds clampTimelineValues enforces. */
export function scalarsInBounds(tl: Timeline): boolean {
  const EPS = 1e-9;
  const inRange = (v: Any, lo: number, hi: number | null): boolean =>
    typeof v !== "number" || (v >= lo - EPS && (hi === null || v <= hi + EPS));
  for (const { c } of eachClip(tl)) {
    if (!inRange(c.opacity, 0, 1)) return false;
    if (!inRange(c.volume, 0, null)) return false;
    if (typeof c.glow === "number") {
      if (!inRange(c.glow, 0, 100)) return false;
    } else if (c.glow && typeof c.glow === "object") {
      if (!inRange(c.glow.amount, 0, 100) || !inRange(c.glow.opacity, 0, 1)) return false;
    }
    if (c.crop && typeof c.crop === "object") {
      for (const side of ["left", "top", "right", "bottom"])
        if (!inRange(c.crop[side], 0, 0.98)) return false;
      if ((Number(c.crop.left) || 0) + (Number(c.crop.right) || 0) > 0.99) return false;
      if ((Number(c.crop.top) || 0) + (Number(c.crop.bottom) || 0) > 0.99) return false;
    }
    if (c.duck && typeof c.duck === "object") {
      if (!inRange(c.duck.ratio, 1, null) || !inRange(c.duck.threshold, 0.001, 1)) return false;
    }
    if (c.fade && typeof c.fade === "object") {
      const span = (Number(c.timeline_out) || 0) - (Number(c.timeline_in) || 0);
      if (!inRange(c.fade.in, 0, span) || !inRange(c.fade.out, 0, span)) return false;
    }
  }
  return true;
}

/** The full battery, labelled — what BOTH the property test and eval oracle check. */
export const TIMELINE_INVARIANTS: ReadonlyArray<readonly [string, (tl: Timeline) => boolean]> = [
  ["clips don't overlap on a track", noBadOverlaps],
  ["linked A/V stay length+speed locked (t008 desync)", linkLockOk],
  ["link_group refs are well-formed", linkRefsOk],
  ["frames are integer + non-negative", framesOk],
  ["source spans are non-empty", sourceSpansOk],
  ["clip ids are unique", uniqueClipIds],
  ["clip kind matches its track", trackKindOk],
  ["clips are stored sorted by timeline_in", clipsSorted],
  ["keyframe times are increasing integers >= 0", keyframesMonotonic],
  ["scalar knobs are within clamp bounds", scalarsInBounds],
];

/** Run the whole battery; return the labels of any invariants that BROKE (or threw).
 *  Empty array = the timeline is internally consistent. */
export function timelineInvariantViolations(tl: Timeline): string[] {
  const broken: string[] = [];
  for (const [label, fn] of TIMELINE_INVARIANTS) {
    try {
      if (!fn(tl)) broken.push(label);
    } catch {
      broken.push(`${label} (threw)`);
    }
  }
  return broken;
}
