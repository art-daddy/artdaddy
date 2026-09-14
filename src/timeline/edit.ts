// Structural edit tools (move/trim/split/remove/ripple_delete): SCHEMA + argument validation +
// a call into timeline/operations.ts, which owns every rule. No timeline math lives here — the
// manual gesture and the agent reach the same operation, so the two cannot drift.
import type { ClientToolContext } from "../tools/context";
import { ctxApplyOp } from "./engine";
import type { Clip, Timeline } from "./model";
import * as ops from "./operations";
import { sourceLengths } from "./sourceLength";

type Result = Record<string, unknown>;
type Args = Record<string, unknown>;
const NOT_READY: Result = { ok: false, error: "client tool runtime not ready" };

export function moveClipsTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return Promise.resolve(NOT_READY);
  if (!Array.isArray(args.moves))
    return Promise.resolve({ ok: false, error: "moves must be a list" });
  const moves = args.moves as Args[];
  return ctxApplyOp(ctx, "move_clips", (timeline) => ops.moveClips(timeline, moves));
}

/** INTERNAL ONLY since contract 1.7.0 — no longer a model-facing tool. The editor's
 *  drag-trim calls this with an already-consistent set of edges; the model reaches
 *  trimming through set_clip_properties (source_in/source_out/duration).
 *
 *  BOTH doors resolve the window through `resolveSourceWindow` against the real media
 *  length. They used to differ: this one wrote the edges raw, so a hand-drag could
 *  stretch a video past its own footage (deriveSourceSpans then made the result pass
 *  validation, and the export silently ran out of frames), while the same drag on a
 *  STILL invented a half-written window that validation rejected outright — the clip
 *  visibly snapped back. */
export async function trimClipsTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return NOT_READY;
  if (!Array.isArray(args.trims)) return { ok: false, error: "trims must be a list" };
  const trims = args.trims as Args[];
  // Probed OUTSIDE the project lock (applyOp re-reads under it), like set_clip_properties:
  // only media_ref/kind are read and no edit changes those.
  const lengths = await sourceLengths(
    ctx,
    trims.map((t) => t.clip_id),
  );
  return ctxApplyOp(ctx, "trim_clips", (timeline) => ops.trimClips(timeline, trims, lengths));
}

export function splitClipsTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return Promise.resolve(NOT_READY);
  if (!Array.isArray(args.splits))
    return Promise.resolve({ ok: false, error: "splits must be a list" });
  const splits = args.splits as Args[];
  return ctxApplyOp(ctx, "split_clips", (timeline) => ops.splitClips(timeline, splits));
}

export function duplicateClipsTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return Promise.resolve(NOT_READY);
  if (!Array.isArray(args.clip_ids))
    return Promise.resolve({ ok: false, error: "clip_ids must be a list" });
  const clipIds = args.clip_ids as unknown[];
  return ctxApplyOp(ctx, "duplicate_clips", (timeline) => ops.duplicateClips(timeline, clipIds));
}

export function pasteClipsTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return Promise.resolve(NOT_READY);
  if (!Array.isArray(args.clips))
    return Promise.resolve({ ok: false, error: "clips must be a list" });
  const clips = args.clips as Clip[];
  return ctxApplyOp(ctx, "paste_clips", (timeline) =>
    ops.pasteClips(timeline, clips, args.track_id, args.at),
  );
}

/** The mutation shared by the UI's `apply_transition` and the agent's `set_transition` — same
 *  operation, different op label on the undo entry. */
export function transitionMutation(args: Args): (timeline: Timeline) => Result {
  return (timeline) => ops.setTransition(timeline, args);
}

// UI path (op "apply_transition"); the agent's set_transition shares the same
// mutation with op "set_transition".
export function applyTransitionTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return Promise.resolve(NOT_READY);
  return ctxApplyOp(ctx, "apply_transition", transitionMutation(args));
}

export function removeClipsTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return Promise.resolve(NOT_READY);
  if (!Array.isArray(args.clip_ids))
    return Promise.resolve({ ok: false, error: "clip_ids must be a list" });
  const clipIds = args.clip_ids as unknown[];
  return ctxApplyOp(ctx, "remove_clips", (timeline) => ops.removeClips(timeline, clipIds));
}

/** Stamp ONE new link_group across the given clips (+ any clips already linked to
 *  them, so pre-existing groups merge). Linked clips then move/trim/split/delete
 *  as a unit; a same-source A/V pair also stays speed/length-locked (normalizeLinks). */
export function linkClipsTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return Promise.resolve(NOT_READY);
  const clipIds = Array.isArray(args.clip_ids) ? (args.clip_ids as unknown[]).map(String) : [];
  if (clipIds.length < 2)
    return Promise.resolve({ ok: false, error: "link needs at least 2 clip_ids" });
  return ctxApplyOp(ctx, "link_clips", (timeline) => ops.linkClips(timeline, clipIds));
}

/** Clear link_group from the given clips + their partners (dissolve the group), so
 *  each clip is edited independently again. The inverse of link_clips. */
export function unlinkClipsTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return Promise.resolve(NOT_READY);
  const clipIds = Array.isArray(args.clip_ids) ? (args.clip_ids as unknown[]).map(String) : [];
  if (!clipIds.length)
    return Promise.resolve({ ok: false, error: "clip_ids must be a non-empty list" });
  return ctxApplyOp(ctx, "unlink_clips", (timeline) => ops.unlinkClips(timeline, clipIds));
}

export function rippleDeleteTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return Promise.resolve(NOT_READY);
  return ctxApplyOp(ctx, "ripple_delete", (timeline) => ops.rippleDelete(timeline, args));
}
