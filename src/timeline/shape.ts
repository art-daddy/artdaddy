// Shared timeline PROJECTION helpers: the compact clip shape used by both the
// get_timeline read (default-omit) and the mutation-delta returned by every edit
// tool (a before -> after diff in get_timeline vocabulary, so the model patches
// its picture without re-reading). Lives in its own module so `engine.ts`
// (applyOp) and `ops.ts` (getTimelineTool) can both import it without a cycle.
import type { Clip, Timeline } from "./model";

// ── clip default-omit ────────────────────────────────────────────────────────
// A field left at its default is dropped from the model-facing shape (absent
// means "this default"). Keys the edit tools accept (id, media_ref,
// timeline_in/out, source_in/out, link_group) are never touched.
const CLIP_SCALAR_DEFAULTS: ReadonlyArray<readonly [string, unknown]> = [
  ["speed", 1],
  ["volume", 1],
  ["opacity", 1],
  ["rotate", 0],
  ["glow", 0],
  ["loop", false],
  ["stretch", false],
  ["blend", "normal"],
];
const CLIP_EMPTY_OBJECT_KEYS = [
  "transform",
  "crop",
  "flip",
  "color",
  "style",
  "animation",
  "fade",
  "duck",
] as const;

function isEmptyObject(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0;
}

/** Shallow copy of `clip` with default-valued fields dropped. */
export function compactClip(clip: Clip): Record<string, unknown> {
  const out: Record<string, unknown> = { ...clip };
  for (const [k, def] of CLIP_SCALAR_DEFAULTS) if (out[k] === def) delete out[k];
  for (const k of CLIP_EMPTY_OBJECT_KEYS) if (isEmptyObject(out[k])) delete out[k];
  if (Array.isArray(out.effects) && out.effects.length === 0) delete out.effects;
  return out;
}

// ── caption groups ──────────────────────────────────────────────────────────
const CAPTION_PREVIEW_CHARS = 240;

/** The words a text clip shows, whichever shape it stores them in. */
export function clipText(clip: Clip): string {
  const c = clip.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((r) => String(r?.text ?? "")).join(" ");
  return typeof clip.text === "string" ? clip.text : "";
}

/** Collapse each caption group into ONE row.
 *
 *  A minute of speech is a few hundred caption clips. Listing them individually is most of a
 *  get_timeline response, which crowds out the rest of the project and costs real money every
 *  turn — and the model almost never wants an individual caption: it wants to read them, or
 *  restyle the set (update_text takes the group id). Groups of ONE are left alone: a summary
 *  there hides a clip id and saves nothing.
 *
 *  The row carries the span, the count and the words, so a read is still a read. */
export function collapseCaptionGroups(clips: Clip[]): Array<Record<string, unknown>> {
  const counts = new Map<string, number>();
  for (const c of clips) {
    const g = c.caption_group;
    if (typeof g === "string" && g) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  const collapsible = new Set([...counts].filter(([, n]) => n > 1).map(([g]) => g));
  if (!collapsible.size) return clips.map(compactClip);

  const out: Array<Record<string, unknown>> = [];
  const emitted = new Set<string>();
  for (const clip of clips) {
    const g = clip.caption_group;
    if (typeof g !== "string" || !collapsible.has(g)) {
      out.push(compactClip(clip));
      continue;
    }
    if (emitted.has(g)) continue;
    emitted.add(g);
    const members = clips.filter((c) => c.caption_group === g);
    const text = members.map(clipText).filter(Boolean).join(" ");
    out.push({
      kind: "caption_group",
      caption_group: g,
      timeline_in: Math.min(...members.map((c) => Number(c.timeline_in) || 0)),
      timeline_out: Math.max(...members.map((c) => Number(c.timeline_out) || 0)),
      count: members.length,
      text: text.length > CAPTION_PREVIEW_CHARS ? `${text.slice(0, CAPTION_PREVIEW_CHARS)}…` : text,
      note: "collapsed; restyle with update_text{caption_group}, or pass caption_detail:true for each clip",
    });
  }
  return out;
}

// ── mutation delta (before -> after diff) ────────────────────────────────────
const DELTA_CLIP_CAP = 30; // list at most this many changed clips; note the rest
const SHIFT_RUN_MIN = 3; // collapse a same-delta run of >= this many clips to one rule

/** A change delta in get_timeline vocabulary. Only non-empty parts are present. */
export interface MutationDelta {
  /** Clips that changed (new, resized, retimed, moved track, or props edited) —
   *  each in compact shape plus its `track` id. */
  clips?: Array<Record<string, unknown>>;
  /** Bulk same-delta slides collapsed: "everything from `from_frame` on this
   *  track moved by `by` (`count` clips)". */
  shifted?: Array<{ track: string; from_frame: number; by: number; count: number }>;
  removed_ids?: string[];
  created_tracks?: string[];
  clips_note?: string;
}

interface Placed {
  trackId: string;
  clip: Clip;
  tin: number;
  tout: number;
  json: string;
}

function indexClips(tl: Timeline): Map<string, Placed> {
  const m = new Map<string, Placed>();
  for (const t of tl.tracks ?? []) {
    for (const c of t.clips ?? []) {
      if (typeof c.id === "string") {
        m.set(c.id, {
          trackId: t.id,
          clip: c,
          tin: Number(c.timeline_in) || 0,
          tout: Number(c.timeline_out) || 0,
          json: JSON.stringify(c),
        });
      }
    }
  }
  return m;
}

/** Diff `before` vs `after` into a compact change delta: removed ids, created
 *  tracks, changed clips (resulting state), and bulk same-delta slides collapsed
 *  into `shifted` rules. Empty sections are omitted. */
export function diffTimeline(before: Timeline, after: Timeline): MutationDelta {
  const b = indexClips(before);
  const a = indexClips(after);

  const removed: string[] = [];
  for (const id of b.keys()) if (!a.has(id)) removed.push(id);

  const beforeTracks = new Set((before.tracks ?? []).map((t) => t.id));
  const created: string[] = [];
  for (const t of after.tracks ?? []) if (!beforeTracks.has(t.id)) created.push(t.id);

  // Classify each surviving/new clip: untouched, a pure shift, or otherwise changed.
  interface Shift {
    id: string;
    trackId: string;
    beforeStart: number;
    by: number;
  }
  const shiftCandidates: Shift[] = [];
  const changedIds: string[] = [];
  for (const [id, av] of a) {
    const bv = b.get(id);
    if (!bv) {
      changedIds.push(id); // new clip
      continue;
    }
    if (av.json === bv.json) continue; // untouched
    const by = av.tin - bv.tin;
    // Pure shift: same track, same duration, ONLY timeline_in/out moved by `by`.
    if (av.trackId === bv.trackId && by !== 0 && av.tout - bv.tout === by) {
      const normalized = JSON.stringify({
        ...(av.clip as Record<string, unknown>),
        timeline_in: bv.tin,
        timeline_out: bv.tout,
      });
      if (normalized === bv.json) {
        shiftCandidates.push({ id, trackId: bv.trackId, beforeStart: bv.tin, by });
        continue;
      }
    }
    changedIds.push(id);
  }

  // Collapse same-(track, by) shift runs of >= SHIFT_RUN_MIN into one rule; runs
  // too small to collapse fall back to individual changed clips.
  const groups = new Map<string, Shift[]>();
  for (const s of shiftCandidates) {
    const key = `${s.trackId}\u0000${s.by}`;
    const arr = groups.get(key);
    if (arr) arr.push(s);
    else groups.set(key, [s]);
  }
  const shifted: NonNullable<MutationDelta["shifted"]> = [];
  for (const run of groups.values()) {
    if (run.length >= SHIFT_RUN_MIN) {
      shifted.push({
        track: run[0].trackId,
        from_frame: Math.min(...run.map((s) => s.beforeStart)),
        by: run[0].by,
        count: run.length,
      });
    } else {
      for (const s of run) changedIds.push(s.id);
    }
  }
  shifted.sort((x, y) =>
    x.track === y.track ? x.from_frame - y.from_frame : x.track < y.track ? -1 : 1,
  );

  // Resulting compact state (+ track id) for every changed clip.
  const clips: Array<Record<string, unknown>> = [];
  for (const id of changedIds) {
    const av = a.get(id);
    if (av) clips.push({ ...compactClip(av.clip), track: av.trackId });
  }
  clips.sort((x, y) => {
    const tx = String(x.track),
      ty = String(y.track);
    return tx === ty
      ? (Number(x.timeline_in) || 0) - (Number(y.timeline_in) || 0)
      : tx < ty
        ? -1
        : 1;
  });

  const delta: MutationDelta = {};
  let clipsOut = clips;
  if (clips.length > DELTA_CLIP_CAP) {
    delta.clips_note = `showing ${DELTA_CLIP_CAP} of ${clips.length} changed clips — re-read get_timeline for the rest`;
    clipsOut = clips.slice(0, DELTA_CLIP_CAP);
  }
  if (clipsOut.length) delta.clips = clipsOut;
  if (shifted.length) delta.shifted = shifted;
  if (removed.length) delta.removed_ids = removed;
  if (created.length) delta.created_tracks = created;
  return delta;
}
