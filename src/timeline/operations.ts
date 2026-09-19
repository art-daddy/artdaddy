// The operations vocabulary — the ONE place a timeline rule lives.
//
// Every user-meaningful timeline change is a function here: pure over the timeline, no tool
// context, no I/O, no lock. Both doors call these and neither owns a rule of its own:
//
//   manual gesture ─┐
//                   ├─→ operations.ts ─→ session.apply ─→ document
//   agent tool ─────┘
//
// An agent tool is then a SCHEMA + argument validation + a call to an operation, and a manual
// gesture is the same call inside `runGesture` so a multi-step intent costs one undo entry. This is
// other NLEs' shape, where the editor owns the operations and `ToolExecutor` only relabels the undo.
//
// Two rules for anything added here:
//   1. No `ClientToolContext`, no `await`. Anything needing a probe or the filesystem resolves
//      BEFORE the lease is taken and arrives as a plain argument — holding the mutation lease
//      across ffprobe would stall every other edit in the app.
//   2. Throw `OpError` to refuse. The caller's apply turns that into `{ok:false}` with nothing
//      written; inside a gesture it rolls the whole intent back.
//   3. Frames come from the timeline (`canvasFps`), so a caller never does fps math itself.
import { OpError } from "./errors";
import { canvasFps, newId, toFrames } from "./frames";
import {
  appendMediaClip,
  clearRegion,
  clipKind,
  describeOverwrite,
  dragLinkPartners,
  emptyOverwriteReport,
  findClip,
  findTrack,
  insertClipClone,
  linkPartners,
  overwroteAnything,
  resolveTrack,
  rippleDeleteRange,
  rippleOpenGap,
  spanFrames,
  splitClipAt,
  syncLockedTracks,
  type MediaKind,
  type MediaSpec,
  type OverwriteReport,
} from "./helpers";
import {
  clampClipMagnification,
  MAX_MAGNIFICATION,
  visibleSourcePx,
  type Dims,
} from "./magnification";
import type { Clip, Timeline, Track } from "./model";
import { resolveFit } from "./renderPlan";
import { mergePatch, normalizeContent } from "./textPatch";
import { resolveSourceWindow, type SourceWindowRequest } from "./sourceWindow";

export type OperationResult = Record<string, unknown>;
type Args = Record<string, unknown>;

/** Refuse an edit to a LOCKED track.
 *
 *  "Blocks ALL edits" is a rule about a CLASS of operations, so it lives at the one boundary every
 *  clip mutation already passes through rather than in each of them — a per-tool check reaches only
 *  the tools that remember to ask, which is how a cross-cutting guard becomes a latent gap. */
function assertEditable(track: Track): void {
  if (track.locked === true)
    throw new OpError(`track '${track.id}' is locked — unlock it to edit its clips`);
}

export function requireClip(timeline: Timeline, clipId: unknown): [Track, Clip] {
  const found = findClip(timeline, String(clipId ?? ""));
  if (!found) throw new OpError(`clip '${String(clipId)}' not found`);
  assertEditable(found[0]);
  return found;
}

/** A track a structural edit is about to restructure (ripple, paste, insert). */
function requireEditableTrack(timeline: Timeline, trackId: string): Track {
  const track = findTrack(timeline, trackId);
  if (!track) throw new OpError(`track '${trackId}' not found`);
  assertEditable(track);
  return track;
}

/** Place already-resolved media on the timeline, overwriting whatever occupies each landing
 *  region (Premiere overwrite; `insertClips` is the ripple sibling).
 *
 *  `specs` carry their own resolved duration/source window, so this stays pure — the ffprobe that
 *  produced them ran before the lease was taken. */
export function placeClips(
  timeline: Timeline,
  specs: Array<MediaSpec & { note?: string }>,
): OperationResult {
  // A spec naming an EXISTING track is checked; a name with no track yet is auto-created by
  // resolveTrack, and a track that does not exist cannot be locked.
  for (const spec of specs) {
    if (!spec.trackId) continue;
    const t = findTrack(timeline, String(spec.trackId));
    if (t) assertEditable(t);
  }
  const created: Array<Record<string, unknown>> = [];
  const overwrote = emptyOverwriteReport();
  for (const spec of specs) {
    const out = appendMediaClip(timeline, spec, true);
    created.push(...out.created);
    overwrote.removed.push(...out.overwrote.removed);
    overwrote.shortened.push(...out.overwrote.shortened);
  }
  const notes = [...new Set(specs.map((s) => s.note).filter((n): n is string => Boolean(n)))];
  return {
    created,
    count: created.length,
    ...(notes.length ? { notes } : {}),
    ...overwriteInfo(overwrote),
  };
}

/** The destructive half of an overwrite, as its OWN named field plus a warning — not buried in the
 *  change delta, where a real session's agent read past it and reported the timeline unchanged. */
function overwriteInfo(r: OverwriteReport): OperationResult {
  if (!overwroteAnything(r)) return {};
  return { overwrote: r, warnings: [describeOverwrite(r)] };
}

/** Media resolved for a ripple insert — durations and source windows already probed. */
export interface InsertSpec {
  source: string;
  kind: MediaKind;
  dur: number;
  sIn: number | null;
  sOut: number | null;
  hasAudio: boolean;
  withAudio?: boolean;
  loop: boolean;
  stretch: boolean;
  note?: string;
}

/** Push everything at `atFrame` later and drop the media into the gap — the ripple sibling of
 *  `placeClips`, which overwrites instead. */
export function insertClips(
  timeline: Timeline,
  specs: InsertSpec[],
  trackId: string | undefined,
  atFrame: number,
): OperationResult {
  const total = specs.reduce((s, x) => s + x.dur, 0);
  const refTrack = resolveTrack(timeline, trackId, specs[0].kind, true);
  assertEditable(refTrack);
  rippleOpenGap(
    timeline,
    refTrack,
    atFrame,
    total,
    syncLockedTracks(timeline, refTrack, new Set<string>()),
  );
  const created: Array<Record<string, unknown>> = [];
  let cursor = atFrame;
  for (const spec of specs) {
    created.push(
      ...appendMediaClip(timeline, {
        source: spec.source,
        kind: spec.kind,
        tin: cursor,
        tout: cursor + spec.dur,
        sIn: spec.sIn,
        sOut: spec.sOut,
        hasAudio: spec.hasAudio,
        withAudio: spec.withAudio,
        loop: spec.loop,
        stretch: spec.stretch,
        trackId: refTrack.id,
      }).created,
    );
    cursor += spec.dur;
  }
  const notes = [...new Set(specs.map((s) => s.note).filter((n): n is string => Boolean(n)))];
  return {
    created,
    count: created.length,
    at: atFrame,
    pushed_by: total,
    track_id: refTrack.id,
    ...(notes.length ? { notes } : {}),
  };
}

/** Add text clips — no media, so nothing to probe and no source window. */
export function addTextClips(timeline: Timeline, entries: Args[]): OperationResult {
  const fps = canvasFps(timeline);
  const created: Array<Record<string, unknown>> = [];
  for (const e of entries) {
    const [tin, tout] = spanFrames(e, fps);
    const clip: Clip = { id: newId("txt"), kind: "text", timeline_in: tin, timeline_out: tout };
    let content = e.content;
    if (typeof content === "string") content = [{ text: content }];
    if (present(content)) clip.content = content as Clip["content"];
    // A text clip with nothing to draw is never what anyone meant, and it is invisible rather
    // than noisy: the call returns ok, the clip lands, and the frame is blank. `raw_ass` counts
    // as content — it carries its own.
    if (!present(clip.content) && !present(e.raw_ass)) {
      throw new OpError(
        `each entry needs 'content' (the text to show)${e.text !== undefined ? " — got 'text'" : ""}`,
      );
    }
    for (const key of ["style", "transform", "animation", "raw_ass", "rotate"] as const) {
      if (present(e[key])) (clip as Record<string, unknown>)[key] = e[key];
    }
    const track = resolveTrack(timeline, e.track_id as string | undefined, "text", true);
    (track.clips ??= []).push(clip);
    created.push({ clip_id: clip.id, track_id: track.id });
  }
  return { created, count: created.length };
}

/** Restyle / reword existing text clips. Timing is deliberately NOT here: set_clip_properties
 *  owns where a clip sits and how long it runs, and two owners for that is how a "trim" became
 *  a slip. Targets are resolved by the caller (ids or a caption group). */
export function updateTextClips(
  timeline: Timeline,
  clipIds: string[],
  patch: Args,
): OperationResult {
  const targets: Array<[Track, Clip]> = [];
  for (const id of clipIds) {
    const found = findClip(timeline, id);
    if (!found) throw new OpError(`clip not found: ${id}`);
    if (found[1].kind !== "text") {
      throw new OpError(`update_text only applies to text clips; '${id}' is ${found[1].kind}`);
    }
    targets.push(found);
  }

  const updated: Array<Record<string, unknown>> = [];
  for (const [track, clip] of targets) {
    if (present(patch.content)) clip.content = normalizeContent(patch.content) as Clip["content"];
    for (const key of ["style", "transform", "animation"] as const) {
      const v = patch[key];
      if (v === undefined) continue;
      if (v === null) {
        delete clip[key];
        continue;
      }
      if (typeof v !== "object" || Array.isArray(v)) throw new OpError(`${key} must be an object`);
      clip[key] = mergePatch(clip[key] as Record<string, unknown> | undefined, v as Args) as never;
    }
    if (patch.rotate !== undefined) {
      if (patch.rotate === null) delete clip.rotate;
      else clip.rotate = Number(patch.rotate);
    }
    updated.push({ clip_id: clip.id, track_id: track.id });
  }
  return { updated, count: updated.length };
}

/** Move clips in time and/or across tracks. Linked partners follow by the SAME frame delta on
 *  their own track, so a J/L offset survives; landing regions are cleared, so a move never leaves
 *  a same-track overlap. */
export function moveClips(
  timeline: Timeline,
  moves: Args[],
  opts: { ignoreLinks?: boolean; refuseOverwrite?: boolean } = {},
): OperationResult {
  const fps = canvasFps(timeline);
  interface Placement {
    clip: Clip;
    toTrack: Track;
    tin: number;
    tout: number;
  }
  const placements: Placement[] = [];
  const movingIds = new Set<string>();
  const add = (clip: Clip, toTrack: Track, tin: number): void => {
    if (clip.id && movingIds.has(clip.id)) return;
    const len = (Number(clip.timeline_out) || 0) - (Number(clip.timeline_in) || 0);
    placements.push({ clip, toTrack, tin, tout: tin + len });
    if (clip.id) movingIds.add(clip.id);
  };
  for (const mv of moves) {
    const [fromTrack, clip] = requireClip(timeline, mv.clip_id);
    const hasFrame = mv.to_timeline_in !== undefined && mv.to_timeline_in !== null;
    const hasTrack = mv.to_track !== undefined && mv.to_track !== null;
    if (!hasFrame && !hasTrack)
      throw new OpError(`move for '${String(mv.clip_id)}' needs to_timeline_in and/or to_track`);
    const curIn = Number(clip.timeline_in) || 0;
    const tin = hasFrame ? toFrames(mv.to_timeline_in, fps) : curIn;
    const delta = tin - curIn;
    const toTrack = hasTrack
      ? resolveTrack(timeline, String(mv.to_track), clipKind(clip), true)
      : fromTrack;
    assertEditable(toTrack); // moving ONTO a locked track is an edit to that track
    add(clip, toTrack, tin);
    // Alt is the override key (Premiere / other NLEs): drag ONE half of an A/V pair.
    if (opts.ignoreLinks) continue;
    for (const [pt, pc] of linkPartners(timeline, clip))
      add(pc, pt, (Number(pc.timeline_in) || 0) + delta);
  }
  // Dragging ONE clip overwrites what it lands on, as an NLE should. Dragging a GROUP does not:
  // silently eating a bystander elsewhere on the timeline is not something the gesture shows you,
  // so the whole move is refused. Checked BEFORE anything is mutated — throwing part-way through
  // would otherwise depend on the caller having handed us a copy to discard.
  if (opts.refuseOverwrite) {
    for (const p of placements) {
      const hit = (p.toTrack.clips ?? []).find(
        (c) =>
          !(c.id && movingIds.has(String(c.id))) &&
          (Number(c.timeline_in) || 0) < p.tout &&
          (Number(c.timeline_out) || 0) > p.tin,
      );
      if (hit)
        throw new OpError(
          `that would drop '${String(p.clip.id)}' on top of '${String(hit.id)}' — move the group somewhere clear, or drag the clips one at a time to overwrite`,
        );
    }
  }
  // Pull every mover off its track first, so a clip on its way to a new home can't be
  // overwritten by its own landing (or by another mover's) while it still sits at the old one.
  for (const t of timeline.tracks ?? [])
    t.clips = (t.clips ?? []).filter((c) => !(c.id && movingIds.has(c.id)));
  const overwrote = emptyOverwriteReport();
  for (const p of placements) {
    const r = clearRegion(timeline, p.toTrack, p.tin, p.tout);
    overwrote.removed.push(...r.removed);
    overwrote.shortened.push(...r.shortened);
  }
  for (const p of placements) {
    p.clip.timeline_in = p.tin;
    p.clip.timeline_out = p.tout;
    (p.toTrack.clips ??= []).push(p.clip);
  }
  return { moved: moves.length, ...overwriteInfo(overwrote) };
}

/** Copy clips to new positions in one action — Alt+drag (Premiere / other NLEs' `isDuplicate`).
 *
 *  The originals stay put and the COPIES land at the target, which is what makes this a duplicate
 *  rather than a move. Copies get fresh ids and a fresh link group, so duplicating an A/V pair
 *  yields a pair that travels together but independently of the original.
 *
 *  Deliberately NOT a second placement implementation: the clones are dropped in place and then
 *  handed to `moveClips`, so the landing rules (locked-track refusal, region clearing, the
 *  pull-off-track-first ordering) have exactly one owner. `insertClipClone` is the wrong
 *  primitive here — it ripples a gap open, and an Alt+drag overwrites like any other drag. */
export function duplicateClipsToPositions(
  timeline: Timeline,
  moves: Args[],
  opts: { ignoreLinks?: boolean } = {},
): OperationResult {
  const clones: Args[] = [];
  const newIds: string[] = [];
  for (const mv of moves) {
    const [track, clip] = requireClip(timeline, mv.clip_id);
    const members: Array<[Track, Clip]> = [
      [track, clip],
      ...(opts.ignoreLinks ? [] : linkPartners(timeline, clip)),
    ];
    const group = members.length > 1 ? newId("lg") : null;
    for (const [t, src] of members) {
      const copy = JSON.parse(JSON.stringify(src)) as Clip;
      copy.id = newId(src.kind === "audio" ? "aud" : "clip");
      if (group !== null) copy.link_group = group;
      else delete (copy as Record<string, unknown>).link_group;
      (t.clips ??= []).push(copy);
      newIds.push(copy.id);
      // Only the clip under the pointer carries the requested destination; its partner rides
      // along on the frame delta, which is what `moveClips` already does for a linked move.
      if (src === clip) clones.push({ ...mv, clip_id: copy.id });
    }
  }
  if (!clones.length) throw new OpError("nothing to duplicate");
  moveClips(timeline, clones, opts);
  return { new_clip_ids: newIds };
}

/** Set a clip's edges, reconciling the source window against the real media length.
 *
 *  `sourceLengths` maps clip id -> total source frames (null when unknown), probed by the caller
 *  before the lease. THE trim rule for both doors: writing edges raw once shipped a clip claiming
 *  frames past the end of its own footage. */
export function trimClips(
  timeline: Timeline,
  trims: Args[],
  sourceLengths: Map<string, number | null>,
): OperationResult {
  const fps = canvasFps(timeline);
  const notes: string[] = [];
  let n = 0;
  for (const tr of trims) {
    const [, clip] = requireClip(timeline, tr.clip_id);
    const partners = linkPartners(timeline, clip).map(([, pc]) => pc);
    const next: Partial<
      Record<"source_in" | "source_out" | "timeline_in" | "timeline_out", number>
    > = {};
    for (const field of ["source_in", "source_out", "timeline_in", "timeline_out"] as const) {
      if (tr[field] !== undefined && tr[field] !== null) next[field] = toFrames(tr[field], fps);
    }
    const sIn = next.source_in ?? (clip.source_in as number | undefined);
    const sOut = next.source_out ?? (clip.source_out as number | undefined);
    const tIn = next.timeline_in ?? (clip.timeline_in as number | undefined);
    const tOut = next.timeline_out ?? (clip.timeline_out as number | undefined);
    // Reject a degenerate/inverted span BEFORE touching anything, so a refused trim is atomic.
    if (typeof sIn === "number" && typeof sOut === "number" && sOut <= sIn)
      throw new OpError(`source_out must be after source_in (got in=${sIn}, out=${sOut} frames)`);
    if (typeof tIn === "number" && typeof tOut === "number" && tOut <= tIn)
      throw new OpError(
        `timeline_out must be after timeline_in (got in=${tIn}, out=${tOut} frames)`,
      );

    // loop/stretch clips deliberately fill a slot from a source of a different length, so they have
    // no window to reconcile. A clip with NO window (a still) must not be given one here either —
    // that is what made an image's tail-drag invalid.
    const fillsSlot = clip.loop === true || clip.stretch === true;
    const hasWindow = !fillsSlot && typeof sIn === "number";
    const was = {
      timeline_in: Number(clip.timeline_in) || 0,
      timeline_out: Number(clip.timeline_out) || 0,
    };
    if (hasWindow && typeof tIn === "number" && typeof tOut === "number") {
      const win = resolveSourceWindow(
        { sourceIn: sIn, duration: tOut - tIn },
        {
          sourceIn: clip.source_in as number | undefined,
          sourceOut: clip.source_out as number | undefined,
          length: tOut - tIn,
          speed: Number(clip.speed ?? 1) || 1,
          speedChanged: false,
          totalFrames: sourceLengths.get(String(tr.clip_id ?? "")) ?? null,
        },
      );
      const resolved = {
        timeline_in: tIn,
        timeline_out: tIn + win.length,
        source_in: win.sourceIn,
        source_out: win.sourceOut,
      };
      for (const [field, value] of Object.entries(resolved))
        (clip as Record<string, unknown>)[field] = value;
      dragLinkPartners(partners, was, resolved, {
        source_in: win.sourceIn,
        source_out: win.sourceOut,
      });
      for (const note of win.notes) if (!notes.includes(note)) notes.push(note);
    } else {
      for (const field of ["source_in", "source_out", "timeline_in", "timeline_out"] as const) {
        if (next[field] !== undefined) (clip as Record<string, unknown>)[field] = next[field];
      }
      dragLinkPartners(partners, was, {
        timeline_in: Number(clip.timeline_in) || 0,
        timeline_out: Number(clip.timeline_out) || 0,
      });
    }
    n++;
  }
  return notes.length ? { trimmed: n, notes } : { trimmed: n };
}

/** Shift clips by `delta` frames, stopping at frame 0 (Premiere's Alt+arrow nudge).
 *
 *  The whole selection moves as one, so the clamp is computed from the EARLIEST clip — nudging a
 *  selection into the rail must not squash it by moving some clips and not others. */
export function nudgeClips(
  timeline: Timeline,
  clipIds: unknown[],
  delta: number,
  opts: { refuseOverwrite?: boolean } = {},
): OperationResult {
  const clips = clipIds.map((id) => requireClip(timeline, id)[1]);
  if (!clips.length) throw new OpError("nothing selected to nudge");
  const earliest = Math.min(...clips.map((c) => Number(c.timeline_in) || 0));
  const applied = Math.max(delta, -earliest);
  if (applied === 0) throw new OpError("the selection is already at frame 0");
  return moveClips(
    timeline,
    clips.map((c) => ({
      clip_id: c.id,
      to_timeline_in: (Number(c.timeline_in) || 0) + applied,
    })),
    opts,
  );
}

/** Move one edge of a clip to `toFrame`, pinning the opposite edge.
 *
 *  The source window walks by the same span the timeline edge did, scaled by speed. Unlike
 *  `trimToPlayhead` this allows an edge to move OUTWARD (a clip getting longer), which roll, slide
 *  and a lengthening ripple all need; `trimClips` still clamps it to the real footage. */
function setEdge(
  timeline: Timeline,
  clipId: unknown,
  edge: "head" | "tail",
  toFrame: number,
  sourceLengths: Map<string, number | null>,
): OperationResult {
  const [, clip] = requireClip(timeline, clipId);
  const tIn = Number(clip.timeline_in) || 0;
  const tOut = Number(clip.timeline_out) || 0;
  const speed = Number(clip.speed ?? 1) || 1;
  const sIn = clip.source_in;
  const sOut = clip.source_out;
  const hasWindow = typeof sIn === "number" && typeof sOut === "number";
  if (edge === "head") {
    const length = tOut - toFrame;
    if (length <= 0) throw new OpError("that edge would leave the clip with no length");
    return trimClips(
      timeline,
      [
        {
          clip_id: clip.id,
          timeline_in: toFrame,
          // Pin the tail: the in-point walks by exactly the span the head gave up or gained.
          ...(hasWindow
            ? { source_in: Math.max(0, (sOut as number) - Math.round(length * speed)) }
            : {}),
        },
      ],
      sourceLengths,
    );
  }
  const length = toFrame - tIn;
  if (length <= 0) throw new OpError("that edge would leave the clip with no length");
  return trimClips(
    timeline,
    [
      {
        clip_id: clip.id,
        timeline_out: toFrame,
        ...(hasWindow ? { source_out: (sIn as number) + Math.round(length * speed) } : {}),
      },
    ],
    sourceLengths,
  );
}

/** Trim a clip's head or tail to `atFrame` (Premiere Q / W).
 *
 *  Refuses when the playhead is outside the clip: there is no meaningful trim there, and
 *  collapsing the clip to nothing is worse than doing nothing. */
export function trimToPlayhead(
  timeline: Timeline,
  clipId: unknown,
  edge: "head" | "tail",
  atFrame: number,
  sourceLengths: Map<string, number | null>,
): OperationResult {
  const [, clip] = requireClip(timeline, clipId);
  const tIn = Number(clip.timeline_in) || 0;
  const tOut = Number(clip.timeline_out) || 0;
  if (!(tIn < atFrame && atFrame < tOut))
    throw new OpError(
      `the playhead (${atFrame}f) is not inside the clip (${tIn}..${tOut}f) — nothing to trim to`,
    );
  return setEdge(timeline, clipId, edge, atFrame, sourceLengths);
}

/** Trim an edge AND close (or open) the gap it leaves, so everything after it follows.
 *
 *  Premiere's Shift+drag. A plain trim leaves a hole; a ripple keeps the sequence tight and makes
 *  it shorter or longer by exactly the trimmed amount. Sync-locked lanes travel with it, the same
 *  rule `rippleDelete` already uses, so cross-track alignment survives. */
export function rippleTrim(
  timeline: Timeline,
  clipId: unknown,
  edge: "head" | "tail",
  toFrame: number,
  sourceLengths: Map<string, number | null>,
): OperationResult {
  const [track, clip] = requireClip(timeline, clipId);
  const tIn = Number(clip.timeline_in) || 0;
  const tOut = Number(clip.timeline_out) || 0;
  const sync = syncLockedTracks(timeline, track, new Set<string>());
  if (edge === "tail") {
    const delta = toFrame - tOut;
    if (delta === 0) throw new OpError("the edge is already there");
    if (toFrame <= tIn) throw new OpError("a ripple trim cannot consume the whole clip");
    if (delta > 0) rippleOpenGap(timeline, track, tOut, delta, sync);
    setEdge(timeline, clipId, "tail", toFrame, sourceLengths);
    if (delta < 0) rippleDeleteRange(timeline, track, toFrame, tOut, sync);
    return { rippled: delta, track: track.id };
  }
  const delta = toFrame - tIn;
  if (delta === 0) throw new OpError("the edge is already there");
  if (toFrame >= tOut) throw new OpError("a ripple trim cannot consume the whole clip");
  if (delta < 0) rippleOpenGap(timeline, track, tIn, -delta, sync);
  setEdge(timeline, clipId, "head", toFrame, sourceLengths);
  if (delta > 0) rippleDeleteRange(timeline, track, tIn, toFrame, sync);
  return { rippled: -delta, track: track.id };
}

/** Move the CUT shared by two abutting clips (Premiere's roll).
 *
 *  One gives up exactly what the other takes, so nothing after the pair moves and the sequence
 *  length is fixed — that is what makes it a roll rather than two trims. */
export function rollEdit(
  timeline: Timeline,
  clipId: unknown,
  toFrame: number,
  sourceLengths: Map<string, number | null>,
): OperationResult {
  const [track, left] = requireClip(timeline, clipId);
  const cut = Number(left.timeline_out) || 0;
  const right = (track.clips ?? []).find((c) => (Number(c.timeline_in) || 0) === cut);
  if (!right) throw new OpError("a roll needs a clip on BOTH sides of the cut");
  if (toFrame <= (Number(left.timeline_in) || 0) || toFrame >= (Number(right.timeline_out) || 0))
    throw new OpError("the roll would consume one of the two clips");
  // Grow the incoming side first: trimming the outgoing one first would leave a momentary gap
  // that a later validation pass could reject.
  setEdge(timeline, right.id, "head", toFrame, sourceLengths);
  setEdge(timeline, clipId, "tail", toFrame, sourceLengths);
  return { cut_moved_to: toFrame, track: track.id };
}

/** Move the SOURCE window under a fixed timeline footprint (Premiere's slip).
 *
 *  The clip does not move and does not change length; different content plays inside it.
 *  `trimClips` owns the clamp, so a slip cannot run past either end of the footage. */
export function slipClip(
  timeline: Timeline,
  clipId: unknown,
  deltaFrames: number,
  sourceLengths: Map<string, number | null>,
): OperationResult {
  const [, clip] = requireClip(timeline, clipId);
  if (typeof clip.source_in !== "number")
    throw new OpError("this clip has no source window to slip (a still plays no content)");
  const speed = Number(clip.speed ?? 1) || 1;
  const shift = Math.round(deltaFrames * speed);
  if (shift === 0) throw new OpError("nothing to slip");
  const nextIn = Math.max(0, clip.source_in + shift);
  trimClips(timeline, [{ clip_id: clip.id, source_in: nextIn }], sourceLengths);
  return { slipped: shift };
}

/** Move a clip between its neighbours, which absorb the move (Premiere's slide).
 *
 *  The clip keeps its content and length; the neighbours change length by the same amount in
 *  opposite directions, so the sequence length is fixed. */
export function slideClip(
  timeline: Timeline,
  clipId: unknown,
  deltaFrames: number,
  sourceLengths: Map<string, number | null>,
): OperationResult {
  const [track, clip] = requireClip(timeline, clipId);
  const tIn = Number(clip.timeline_in) || 0;
  const tOut = Number(clip.timeline_out) || 0;
  if (deltaFrames === 0) throw new OpError("nothing to slide");
  const clips = track.clips ?? [];
  const left = clips.find((c) => (Number(c.timeline_out) || 0) === tIn);
  const right = clips.find((c) => (Number(c.timeline_in) || 0) === tOut);
  if (!left && !right) throw new OpError("a slide needs a neighbour to absorb the move");
  if (left && tIn + deltaFrames <= (Number(left.timeline_in) || 0))
    throw new OpError("the slide would consume the left neighbour");
  if (right && tOut + deltaFrames >= (Number(right.timeline_out) || 0))
    throw new OpError("the slide would consume the right neighbour");
  // Neighbours first: moving the clip first would overlap one of them mid-operation.
  if (left) setEdge(timeline, left.id, "tail", tIn + deltaFrames, sourceLengths);
  if (right) setEdge(timeline, right.id, "head", tOut + deltaFrames, sourceLengths);
  clip.timeline_in = tIn + deltaFrames;
  clip.timeline_out = tOut + deltaFrames;
  return { slid: deltaFrames };
}

/** Enable or disable clips (Premiere Shift+E): they keep their place but neither draw nor sound.
 *
 *  Carries link partners, because a disabled picture with live audio is a desync the user did not
 *  ask for. Absent means enabled, so disabling writes the flag and enabling REMOVES it rather than
 *  leaving `disabled: false` litter in every document that ever toggled. */
export function setClipEnabled(
  timeline: Timeline,
  clipIds: unknown[],
  enabled: boolean,
): OperationResult {
  let n = 0;
  for (const cid of clipIds) {
    const [, clip] = requireClip(timeline, cid);
    for (const c of [clip, ...linkPartners(timeline, clip).map(([, pc]) => pc)]) {
      if (enabled) delete (c as Record<string, unknown>).disabled;
      else c.disabled = true;
      n++;
    }
  }
  if (n === 0) throw new OpError("no clips to enable or disable");
  return { updated: n, enabled };
}

/** Cut clips at a frame, carrying any linked partner that spans the same frame. */
export function splitClips(timeline: Timeline, splits: Args[]): OperationResult {
  const fps = canvasFps(timeline);
  const newIds: string[] = [];
  for (const sp of splits) {
    const [track, clip] = requireClip(timeline, sp.clip_id);
    const at = toFrames(sp.at, fps);
    const tin = clip.timeline_in as number;
    const tout = clip.timeline_out as number;
    if (!(tin < at && at < tout))
      throw new OpError(`split 'at' (${at}f) must be strictly inside the clip (${tin}..${tout}f)`);
    const newGroup = clip.link_group ? newId("lg") : null;
    const partners = linkPartners(timeline, clip);
    const right = splitClipAt(track, clip, at, newGroup);
    newIds.push(right.id as string);
    for (const [pt, pc] of partners) {
      const pci = pc.timeline_in;
      const pco = pc.timeline_out;
      if (typeof pci === "number" && typeof pco === "number" && pci < at && at < pco)
        splitClipAt(pt, pc, at, newGroup);
    }
  }
  return { new_clip_ids: newIds };
}

/** Copy each clip in immediately after itself. */
export function duplicateClips(timeline: Timeline, clipIds: unknown[]): OperationResult {
  const newIds: string[] = [];
  for (const cid of clipIds) {
    const [track, clip] = requireClip(timeline, cid);
    const copy = insertClipClone(
      timeline,
      track,
      clip,
      Number(clip.timeline_out) || 0,
      syncLockedTracks(timeline, track, new Set<string>()),
    );
    newIds.push(copy.id as string);
  }
  return { new_clip_ids: newIds };
}

/** Drop copies of `clips` onto a track from `at`, stacked back to back. */
export function pasteClips(
  timeline: Timeline,
  clips: Clip[],
  trackId: unknown,
  at: unknown,
): OperationResult {
  const track = requireEditableTrack(timeline, String(trackId ?? ""));
  const start = toFrames(at ?? 0, canvasFps(timeline));
  const syncTracks = syncLockedTracks(timeline, track, new Set<string>());
  const newIds: string[] = [];
  let cursor = start;
  for (const clip of clips) {
    const copy = insertClipClone(timeline, track, clip, cursor, syncTracks);
    newIds.push(copy.id as string);
    cursor = copy.timeline_out as number;
  }
  return { new_clip_ids: newIds };
}

/** Remove clips and everything linked to them. */
export function removeClips(timeline: Timeline, clipIds: unknown[]): OperationResult {
  const ids = new Set(clipIds.map(String));
  for (const cid of [...ids]) {
    const found = findClip(timeline, cid);
    if (!found) continue;
    assertEditable(found[0]);
    for (const [, pc] of linkPartners(timeline, found[1])) if (pc.id) ids.add(pc.id);
  }
  let removed = 0;
  for (const track of timeline.tracks ?? []) {
    const keep: Clip[] = [];
    for (const c of track.clips ?? []) {
      if (c !== null && typeof c === "object" && c.id && ids.has(c.id)) removed++;
      else keep.push(c);
    }
    track.clips = keep;
  }
  if (removed === 0) throw new OpError("no matching clip ids");
  return { removed };
}

/** Stamp ONE new link_group across the given clips plus anything already linked to them, so
 *  pre-existing groups merge rather than fragment. */
export function linkClips(timeline: Timeline, clipIds: string[]): OperationResult {
  const members = new Set<Clip>();
  for (const cid of clipIds) {
    const [, clip] = requireClip(timeline, cid);
    members.add(clip);
    for (const [, pc] of linkPartners(timeline, clip)) members.add(pc);
  }
  const lg = newId("lg");
  for (const c of members) c.link_group = lg;
  return { linked: members.size, link_group: lg };
}

/** Dissolve the link group(s) the named clips belong to — a group is dissolved whole. */
export function unlinkClips(timeline: Timeline, clipIds: string[]): OperationResult {
  const members = new Set<Clip>();
  for (const cid of clipIds) {
    const found = findClip(timeline, cid);
    if (!found) continue;
    assertEditable(found[0]);
    members.add(found[1]);
    for (const [, pc] of linkPartners(timeline, found[1])) members.add(pc);
  }
  let n = 0;
  for (const c of members) {
    if (c.link_group) {
      delete (c as Record<string, unknown>).link_group;
      n++;
    }
  }
  if (n === 0) throw new OpError("no linked clips to unlink");
  return { unlinked: n };
}

/** Set or clear a clip's inbound crossfade. NON-SHIFTING (Premiere model B): a transition is
 *  purely a `duration`, so setting one never moves clips and never needs a timeline overlap. */
export function setTransition(timeline: Timeline, args: Args): OperationResult {
  const transitionIn = args.transition_in as
    { kind?: unknown; duration?: unknown; expr?: unknown } | null | undefined;
  const [track, clip] = requireClip(timeline, args.clip_id);
  const ordered = [...(track.clips ?? [])].sort(
    (a, b) => (Number(a.timeline_in) || 0) - (Number(b.timeline_in) || 0),
  );
  const prev = ordered[ordered.indexOf(clip) - 1] ?? null;
  if (!prev) throw new OpError("a transition needs a preceding clip on the same track");

  if (transitionIn === null || transitionIn === undefined) {
    delete (clip as Record<string, unknown>).transition_in;
    return { clip_id: String(args.clip_id ?? ""), removed: true };
  }
  const kind = String(transitionIn.kind ?? "");
  const duration = Math.round(Number(transitionIn.duration) || 0);
  if (!kind || duration <= 0)
    throw new OpError("transition_in needs a non-empty kind and duration > 0");
  const bLen = (Number(clip.timeline_out) || 0) - (Number(clip.timeline_in) || 0);
  const aLen = (Number(prev.timeline_out) || 0) - (Number(prev.timeline_in) || 0);
  if (duration > bLen || duration > aLen)
    throw new OpError("transition duration can't exceed either clip's length");
  const t: Record<string, unknown> = { kind, duration };
  if (typeof transitionIn.expr === "string" && transitionIn.expr.trim())
    t.expr = transitionIn.expr.trim();
  clip.transition_in = t as Clip["transition_in"];
  return { clip_id: String(args.clip_id ?? ""), kind, duration };
}

/** Parse the delete window(s): a `ranges` list or a single start/end. Converted to frames,
 *  validated, merged when they overlap/abut, and sorted LATEST-FIRST so deleting one range never
 *  invalidates the (earlier) frame numbers of the ranges still to process. */
function rippleRanges(args: Args, fps: number): { s: number; e: number }[] {
  const raw: { s: number; e: number }[] = [];
  const push = (start: unknown, end: unknown) => {
    const s = toFrames(start, fps);
    const e = toFrames(end, fps);
    if (e <= s) throw new OpError(`ripple range end must be after start (got ${s}..${e})`);
    raw.push({ s, e });
  };
  if (Array.isArray(args.ranges)) {
    for (const r of args.ranges as Args[]) push(r.start, r.end);
  } else if (args.start !== undefined && args.end !== undefined) {
    push(args.start, args.end);
  }
  if (!raw.length)
    throw new OpError(
      "give the cut window: a non-empty ranges list ([{start,end}, ...] in frames) OR a single start+end pair.",
    );
  raw.sort((a, b) => a.s - b.s);
  const merged: { s: number; e: number }[] = [{ ...raw[0] }];
  for (let i = 1; i < raw.length; i++) {
    const last = merged[merged.length - 1];
    if (raw[i].s <= last.e) last.e = Math.max(last.e, raw[i].e);
    else merged.push({ ...raw[i] });
  }
  merged.sort((a, b) => b.s - a.s);
  return merged;
}

/** Cut a window out and close the gap, shifting sync-locked tracks alongside. */
export function rippleDelete(timeline: Timeline, args: Args): OperationResult {
  const trackId = String(args.track_id ?? "").trim();
  const clipId = String(args.clip_id ?? "").trim();
  if (!trackId && !clipId)
    throw new OpError(
      "provide track_id or clip_id — track_id cuts across a whole track; clip_id cuts within one clip.",
    );
  const notes: string[] = [];
  if (
    Array.isArray(args.ranges) &&
    (args.ranges as unknown[]).length &&
    args.start !== undefined &&
    args.end !== undefined
  ) {
    notes.push("used the ranges list; the single start/end you also passed was ignored.");
  }
  const fps = canvasFps(timeline);
  let track: Track;
  let span: { lo: number; hi: number } | null = null;
  // clip_id is the narrower target, so it wins over track_id — BUT only if it resolves. A
  // hallucinated clip_id falls back to a valid track_id + note rather than failing the delete.
  const found = clipId ? findClip(timeline, clipId) : null;
  if (clipId && found) {
    const [t, clip] = found;
    track = t;
    span = { lo: Number(clip.timeline_in) || 0, hi: Number(clip.timeline_out) || 0 };
    if (trackId)
      notes.push(
        "used clip_id (the cut is clamped to that one clip's span); the track_id you also passed was ignored — pass just track_id to cut across the whole track.",
      );
  } else if (clipId && trackId) {
    const t = findTrack(timeline, trackId);
    if (!t)
      throw new OpError(
        `neither clip_id '${clipId}' nor track_id '${trackId}' matched anything on the timeline.`,
      );
    assertEditable(t);
    track = t;
    notes.push(
      `clip_id '${clipId}' didn't match any clip, so the cut ran across track_id '${trackId}' instead.`,
    );
  } else if (clipId) {
    throw new OpError(`clip '${clipId}' not found`);
  } else {
    track = requireEditableTrack(timeline, trackId);
  }
  let ranges = rippleRanges(args, fps);
  if (span) {
    const { lo, hi } = span;
    ranges = ranges
      .map((r) => ({ s: Math.max(lo, r.s), e: Math.min(hi, r.e) }))
      .filter((r) => r.e > r.s);
    if (!ranges.length) throw new OpError(`no range overlaps clip '${clipId}' span [${lo}, ${hi})`);
  }
  let removedSpan = 0;
  const ignore = new Set(
    (Array.isArray(args.ignore_sync_locked_tracks) ? args.ignore_sync_locked_tracks : []).map(
      String,
    ),
  );
  const syncTracks = syncLockedTracks(timeline, track, ignore);
  for (const { s, e } of ranges) {
    rippleDeleteRange(timeline, track, s, e, syncTracks);
    removedSpan += e - s;
  }
  return {
    track: track.id,
    removed_span: removedSpan,
    ranges: ranges.length,
    ...(notes.length ? { notes } : {}),
  };
}

/** Everything `setClipProperties` needs, resolved by the caller: the plain properties to write,
 *  the relative length, and the source-window request. Kept as one object so the rule reads the
 *  same intent the tool parsed. */
export interface ClipPropertyPlan {
  props: Args;
  durationRaw: number | null;
  window: SourceWindowRequest;
  namesEdge: boolean;
  speedChanged: boolean;
  explicitLen: boolean;
  /** Swap which SOURCE the clip points at, keeping everything else. Resolved by the caller
   *  (resolve + probe happen before the lease). */
  media?: SwapMedia | null;
}

/** A replacement source, already resolved and probed. */
export interface SwapMedia {
  /** The library ref to store on the clip. */
  ref: string;
  kind: MediaKind;
  /** Total source length in project frames, or null when unbounded/unprobeable. */
  totalFrames: number | null;
  hasAudio: boolean;
}

/** Point `clip` at a different source, keeping its slot and everything about how it looks.
 *
 *  There was no way to do this: replacing a shot meant remove_clips + add_clips, which drops the
 *  grade, the transform and every keyframe. Done eight times in one session, and a missed re-apply
 *  ships an ungraded shot — the failure is silent, which is what makes it worth a real operation.
 *
 *  The source window restarts at 0 of the new media and keeps the slot; a shorter replacement
 *  SHORTENS the clip (and says so) rather than claiming frames past the end of its own footage. */
function swapClipMedia(timeline: Timeline, clip: Clip, m: SwapMedia, notes: string[]): void {
  const cid = String(clip.id ?? "");
  const tIn = Number(clip.timeline_in) || 0;
  const tOut = Number(clip.timeline_out) || 0;
  const speed = Number(clip.speed ?? 1) || 1;
  clip.media_ref = m.ref;
  // A lottie carries no `kind` on the clip (appendMediaClip does the same); the others do.
  if (m.kind === "video" || m.kind === "image" || m.kind === "audio") clip.kind = m.kind;
  else delete (clip as Record<string, unknown>).kind;
  if (m.kind === "image" || m.kind === "lottie") {
    // A still has no source window; leaving the old one behind would fail source/timeline parity.
    delete (clip as Record<string, unknown>).source_in;
    delete (clip as Record<string, unknown>).source_out;
  } else {
    let want = Math.max(1, Math.round((tOut - tIn) * speed));
    if (m.totalFrames !== null && m.totalFrames < want) {
      want = m.totalFrames;
      const span = Math.max(1, Math.round(want / speed));
      clip.timeline_out = tIn + span;
      notes.push(
        `clip ${cid}: '${m.ref}' is shorter than the slot, so the clip is now ${span} frames ` +
          `(it was ${tOut - tIn}). Fill the gap or move what follows.`,
      );
    }
    clip.source_in = 0;
    clip.source_out = want;
  }
  // The linked audio must follow, or the pair points at two different sources. A replacement with
  // no audio leaves nothing for the partner to play, so it goes rather than becoming silent noise
  // the renderer has to suppress.
  const partners = linkPartners(timeline, clip);
  for (const [track, pc] of partners) {
    if (pc.kind !== "audio") continue;
    if (!m.hasAudio) {
      track.clips = (track.clips ?? []).filter((c) => c !== pc);
      notes.push(`clip ${cid}: '${m.ref}' has no audio, so its linked audio clip was removed.`);
      continue;
    }
    pc.media_ref = m.ref;
    pc.timeline_in = Number(clip.timeline_in) || 0;
    pc.timeline_out = Number(clip.timeline_out) || 0;
    if (typeof clip.source_in === "number") {
      pc.source_in = clip.source_in;
      pc.source_out = clip.source_out as number;
    }
  }
}

/** True when this patch sets the clip's size — the only edit a magnification clamp may touch.
 *  Clamping on an unrelated property change would silently re-zoom a clip nobody resized. */
function patchSetsScale(props: Args): boolean {
  const t = props.transform;
  if (!t || typeof t !== "object") return false;
  return ["scale", "scale_x", "scale_y"].some((k) => k in (t as Record<string, unknown>));
}

/** Bound a clip's zoom to what its source can actually carry, and say so.
 *
 *  `transform.scale` sizes the box; `fit` decides how the source fills it. Their product is the
 *  magnification, and past a point it stops being a picture: a 480p source covering a 9:16 canvas
 *  at `scale: 3.45` shows 78x139 source pixels stretched over 1080x1920, which reads as a frozen
 *  smear. Silent because the clip is still there, still the right length, still in sync.
 *
 *  Exported because `set_keyframes` animates the same tracks by a different route — a guard on
 *  one door only is how a clip ends up over-magnified through the other. */
export function clampMagnification(
  timeline: Timeline,
  clip: Clip,
  cid: string,
  dims: Map<string, Dims | null>,
  notes: string[],
): void {
  const cw = Math.trunc(Number(timeline.canvas?.width));
  const ch = Math.trunc(Number(timeline.canvas?.height));
  if (!(cw > 0) || !(ch > 0)) return;
  const src = dims.get(cid) ?? null;
  const r = clampClipMagnification(clip, { w: cw, h: ch }, src, resolveFit(clip.fit));
  if (!r?.clamped) return;
  const px = visibleSourcePx({ w: cw, h: ch }, r.requested);
  notes.push(
    `clip ${clip.id}: zoom reduced — ${r.requested.toFixed(1)}x magnification of a ` +
      `${src!.w}x${src!.h} source shows only ${px.w}x${px.h} source pixels across the canvas ` +
      `(max ${MAX_MAGNIFICATION}x, applied ${r.applied.toFixed(1)}x). To fill a vertical frame ` +
      `from a wider source, put the zoomed+blurred copy BEHIND and leave the real shot near scale 1.`,
  );
}

/** Rescale a clip's timeline_out to keep the same source content at its speed. No-op for stills
 *  (no source window) or a non-positive speed (validateTimeline reports that). */
function rescaleForSpeed(clip: Clip): void {
  const speed = Number(clip.speed ?? 1) || 1;
  if (speed <= 0) return;
  const sIn = clip.source_in;
  const sOut = clip.source_out;
  const tIn = clip.timeline_in;
  if (typeof sIn !== "number" || typeof sOut !== "number" || typeof tIn !== "number") return;
  clip.timeline_out = tIn + Math.round((sOut - sIn) / speed);
}

/** Write clip properties, reconciling any source-window or length change against the real media.
 *
 *  The agent's door onto trimming (`source_in`/`source_out`/`duration`), so it shares
 *  `resolveSourceWindow` and `dragLinkPartners` with `trimClips` — the two used to own separate
 *  copies of the partner rule and drifted. */
export function setClipProperties(
  timeline: Timeline,
  clipIds: unknown[],
  plan: ClipPropertyPlan,
  sourceLengths: Map<string, number | null>,
  sourceDims: Map<string, Dims | null> = new Map(),
): OperationResult {
  const { props: propObj, durationRaw, window: req, namesEdge, speedChanged, explicitLen } = plan;
  const hasDuration = typeof durationRaw === "number" && durationRaw > 0;
  const setsScale = patchSetsScale(propObj);
  const notes: string[] = [];
  let n = 0;
  for (const cid of clipIds) {
    const [, clip] = requireClip(timeline, cid);
    // BEFORE the window resolution below, so a source_in the caller passed alongside the swap is
    // measured against the NEW media rather than the one being replaced.
    if (plan.media) swapClipMedia(timeline, clip, plan.media, notes);
    for (const [key, value] of Object.entries(propObj)) {
      if (value === null || value === undefined) delete (clip as Record<string, unknown>)[key];
      else (clip as Record<string, unknown>)[key] = value;
    }
    if (setsScale) clampMagnification(timeline, clip, String(cid ?? ""), sourceDims, notes);
    // loop/stretch clips deliberately fill a slot from a source of a different length, so they
    // have no source-window parity to maintain: `duration` stays a plain resize for them (that IS
    // the "extend a music bed" case). A clip with no window at all (text, a still) only gets one
    // if the caller names an edge — a bare `duration` must not invent one on a text clip.
    const fillsSlot = clip.loop === true || clip.stretch === true;
    const useWindow =
      !fillsSlot && (namesEdge || (hasDuration && typeof clip.source_in === "number"));
    const was = {
      timeline_in: Number(clip.timeline_in) || 0,
      timeline_out: Number(clip.timeline_out) || 0,
    };
    if (useWindow) {
      const tIn = Number(clip.timeline_in) || 0;
      const win = resolveSourceWindow(req, {
        sourceIn: typeof clip.source_in === "number" ? clip.source_in : undefined,
        sourceOut: typeof clip.source_out === "number" ? clip.source_out : undefined,
        length: (Number(clip.timeline_out) || 0) - tIn,
        speed: Number(clip.speed ?? 1) || 1,
        speedChanged,
        totalFrames: sourceLengths.get(String(cid ?? "")) ?? null,
      });
      clip.source_in = win.sourceIn;
      clip.source_out = win.sourceOut;
      clip.timeline_out = tIn + win.length;
      for (const note of win.notes) if (!notes.includes(note)) notes.push(note);
    } else if (hasDuration) {
      clip.timeline_out = (Number(clip.timeline_in) || 0) + (durationRaw as number);
    }
    // Speed rescales the clip's OWN length to keep the same source content (NLE-style: 2x ->
    // half the frames), unless an explicit length was given.
    if (speedChanged && !explicitLen && !useWindow) rescaleForSpeed(clip);

    // Locked pair: ANY timing edit drags the linked audio so A/V cannot desync.
    if (speedChanged || explicitLen || namesEdge) {
      const partners = linkPartners(timeline, clip).map(([, pc]) => pc);
      if (speedChanged) for (const pc of partners) pc.speed = clip.speed;
      dragLinkPartners(
        partners,
        was,
        {
          timeline_in: Number(clip.timeline_in) || 0,
          timeline_out: Number(clip.timeline_out) || 0,
        },
        useWindow && typeof clip.source_in === "number"
          ? { source_in: clip.source_in, source_out: clip.source_out as number }
          : undefined,
      );
    }
    // fade/volume are AUDIO-render properties (the renderer reads them only on audio clips). When
    // set on a clip whose audio lives on a linked partner, drag them across so the edit isn't a
    // silent no-op on the video clip.
    if ("fade" in propObj || "volume" in propObj) {
      for (const [, pc] of linkPartners(timeline, clip)) {
        if (pc.kind !== "audio") continue;
        if ("fade" in propObj) {
          if (propObj.fade == null) delete (pc as Record<string, unknown>).fade;
          else pc.fade = propObj.fade as Clip["fade"];
        }
        if ("volume" in propObj) {
          if (propObj.volume == null) delete (pc as Record<string, unknown>).volume;
          else pc.volume = propObj.volume as Clip["volume"];
        }
      }
    }
    n++;
  }
  return notes.length ? { updated: n, notes } : { updated: n };
}

const present = (v: unknown): boolean => v !== undefined && v !== null;

function applyTrackPatch(timeline: Timeline, args: Args): string {
  const trackId = String(args.track_id ?? "");
  const track = findTrack(timeline, trackId);
  if (!track) throw new OpError(`track '${trackId}' not found`);
  if (present(args.mute)) track.mute = Boolean(args.mute);
  if (present(args.hidden)) track.hidden = Boolean(args.hidden);
  if (present(args.sync_locked)) track.sync_locked = Boolean(args.sync_locked);
  if (present(args.locked)) track.locked = Boolean(args.locked);
  if (present(args.solo)) track.solo = Boolean(args.solo);
  if (present(args.z)) track.z = Math.trunc(Number(args.z));
  return trackId;
}

/** Patch ONE track's flags. */
export function setTrack(timeline: Timeline, args: Args): OperationResult {
  return { track_id: applyTrackPatch(timeline, args) };
}

/** Patch SEVERAL tracks as one operation — a restack issuing one setTrack per track cost the user
 *  one Ctrl+Z per track. */
export function setTracks(timeline: Timeline, patches: Args[]): OperationResult {
  return { track_ids: patches.map((p) => applyTrackPatch(timeline, p)) };
}
