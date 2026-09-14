// Property / animation ops (set_clip_properties, set_keyframes, apply_effects,
// apply_color, set_transition). Ports timeline_edit_tools.py part 2. These set
// look/sound AFTER placement; deep field validation is left to validateTimeline.
import type { ClientToolContext } from "../tools/context";
import { isUnsafeAgentRef } from "../tools/store";
import { transitionMutation } from "./edit";
import { colorKnobs, kindForClip, resolveEffect, resolveGrade } from "./effectRegistry";
import { ctxApplyOp, loadTimeline } from "./engine";
import { OpError } from "./errors";
import { canvasFps, toFrames } from "./frames";
import { findClip } from "./helpers";
import { normalizeKeyframes } from "./keyframe";
import type { Clip, Timeline, Track } from "./model";
import { clampMagnification, setClipProperties, type SwapMedia } from "./operations";
import { placeableKind } from "./helpers";
import { sourceDurationSeconds, sourceHasAudio, sourceHasVideo } from "./placement";
import { sourceDims } from "./sourceDims";
import { sourceLengths } from "./sourceLength";
import { touchesSourceWindow, type SourceWindowRequest } from "./sourceWindow";

type Result = Record<string, unknown>;
type Args = Record<string, unknown>;
const NOT_READY: Result = { ok: false, error: "client tool runtime not ready" };
const KEYFRAME_PROPS = ["opacity", "rotate", "volume", "position", "scale", "scale_x", "scale_y"];
const present = (v: unknown): boolean => v !== undefined && v !== null && v !== "";
// scale/scale_x/scale_y are scalar tracks under `transform`; `position` is a vector.
const TRANSFORM_SCALAR_PROPS = new Set(["scale", "scale_x", "scale_y"]);

function requireClip(timeline: Timeline, clipId: unknown): [Track, Clip] {
  const found = findClip(timeline, String(clipId ?? ""));
  if (!found) throw new OpError(`clip '${String(clipId)}' not found`);
  return found;
}

function compileKeyframes(keyframes: Args[], fps: number): Array<Record<string, unknown>> {
  const rows = keyframes.map((k) => {
    const kf: { t: number; [key: string]: unknown } = { t: toFrames(k.t, fps), v: k.v };
    if (k.ease) kf.ease = k.ease;
    return kf;
  });
  return normalizeKeyframes(rows);
}

// The clip properties the agent sets via typed top-level params. The Inspector/UI
// calls this function directly with a legacy `properties` object; both are merged.
const CLIP_PROP_KEYS = [
  "transform",
  "fit",
  "rotate",
  "opacity",
  "speed",
  "duration",
  "source_in",
  "source_out",
  "flip",
  "crop",
  "blend",
  "volume",
  "loop",
  "stretch",
  "duck",
  "fade",
  "audio_filter",
];

/** Real length of each clip's source, in project frames. null = unknown (probe
 *  failed / no duration) or unbounded (image/text, which other NLEs also treats as
 *  infinite): the caller then skips the clamp rather than blocking a valid edit.
 *  Shared with the editor's drag-trim — see sourceLength.ts for why. */

export async function setClipPropertiesTool(
  args: Args,
  ctx: ClientToolContext | null,
): Promise<Result> {
  if (!ctx) return NOT_READY;
  if (!Array.isArray(args.clip_ids)) return { ok: false, error: "clip_ids must be a list" };
  // Collect properties from the typed top-level params (agent path) AND a legacy
  // `properties` object (the Inspector/UI calls this function directly with one).
  const propObj: Args = {};
  if (args.properties && typeof args.properties === "object")
    Object.assign(propObj, args.properties as Args);
  for (const k of CLIP_PROP_KEYS) if (k in args) propObj[k] = args[k];
  if (Object.keys(propObj).length === 0 && !present(args.media_ref)) {
    return { ok: false, error: "pass at least one property to set" };
  }
  const clipIds = args.clip_ids as unknown[];
  // `duration` is a RELATIVE length (frames), not a stored field: per clip it
  // becomes timeline_out = timeline_in + duration. Pulling it out keeps it from
  // being written raw, and — unlike an ABSOLUTE timeline_out — it is safe to
  // broadcast across many clips (each keeps its own start). `timeline_out` is
  // still honored when the Inspector passes it via `properties` (single clip).
  const durationRaw = propObj.duration;
  delete propObj.duration;
  // source_in/source_out likewise never reach the clip raw: writing one without
  // reconciling the other (and the length) is exactly how a "trim" became a slip.
  // resolveSourceWindow owns that reconciliation for every caller.
  const srcIn = propObj.source_in;
  const srcOut = propObj.source_out;
  delete propObj.source_in;
  delete propObj.source_out;
  const req: SourceWindowRequest = {
    sourceIn: typeof srcIn === "number" ? srcIn : null,
    sourceOut: typeof srcOut === "number" ? srcOut : null,
    duration: typeof durationRaw === "number" ? durationRaw : null,
  };
  if (
    typeof req.sourceIn === "number" &&
    typeof req.sourceOut === "number" &&
    req.sourceOut <= req.sourceIn
  ) {
    return {
      ok: false,
      error: `source_out must be after source_in (got in=${req.sourceIn}, out=${req.sourceOut} frames)`,
    };
  }
  const hasDuration = typeof durationRaw === "number" && durationRaw > 0;
  const namesEdge = touchesSourceWindow(req);
  const wantsWindow = namesEdge || hasDuration;
  const explicitLen = hasDuration || "timeline_out" in propObj;
  const speedChanged = "speed" in propObj && propObj.speed !== null && propObj.speed !== undefined;
  // Probed OUTSIDE the project lock (applyOp re-reads under it). Safe because we
  // only read media_ref/kind, which no edit changes; a clip deleted in between
  // just fails requireClip below.
  const lengths = wantsWindow
    ? await sourceLengths(ctx, clipIds)
    : new Map<string, number | null>();
  // A scale edit needs the SOURCE's pixel size: `scale` alone cannot tell a push-in on 4K footage
  // from a 14x blow-up of a 480p podcast. Probed only when the patch actually sets scale.
  const tf = propObj.transform;
  const setsScale =
    !!tf &&
    typeof tf === "object" &&
    ["scale", "scale_x", "scale_y"].some((k) => k in (tf as Args));
  const dims = setsScale ? await sourceDims(ctx, clipIds) : new Map();
  let media: SwapMedia | null = null;
  if (present(args.media_ref)) {
    const swap = await resolveSwapMedia(ctx, String(args.media_ref), await canvasFpsOf(ctx));
    if (swap.error) return swap.error;
    media = swap.media;
    // The window request is measured against the REPLACEMENT, not the clip being replaced.
    for (const cid of clipIds) lengths.set(String(cid ?? ""), media.totalFrames);
  }
  return ctxApplyOp(ctx, "set_clip_properties", (timeline) =>
    setClipProperties(
      timeline,
      clipIds,
      {
        props: propObj,
        durationRaw: typeof durationRaw === "number" ? durationRaw : null,
        window: req,
        namesEdge,
        speedChanged,
        explicitLen,
        media,
      },
      lengths,
      dims,
    ),
  );
}

async function canvasFpsOf(ctx: ClientToolContext): Promise<number> {
  try {
    return canvasFps(await loadTimeline(ctx.store));
  } catch {
    return 30;
  }
}

/** Resolve + probe a replacement source. Everything slow happens HERE, before the lease. */
async function resolveSwapMedia(
  ctx: ClientToolContext,
  raw: string,
  fps: number,
): Promise<{ media: SwapMedia; error?: undefined } | { media?: undefined; error: Result }> {
  const ref = raw.trim();
  if (!ref) return { error: { ok: false, error: "media_ref must be a non-empty library ref" } };
  if (isUnsafeAgentRef(ref))
    return {
      error: {
        ok: false,
        error: `media_ref must be a library asset (media id / filename), not a system path: ${ref}`,
      },
    };
  // Same containment as add_clips, and the same tolerance: a raw system path is refused, but a
  // ref that simply does not resolve YET (media still generating) falls through — the slot already
  // decides the length, so a swap does not need the file to exist.
  const abs = (await ctx.store.resolveMediaRef(ref)) ?? ref;
  let kind = placeableKind(abs);
  if (kind === "video" && !(await sourceHasVideo(ctx, abs))) kind = "audio";
  const hasAudio = kind === "audio" ? true : kind === "video" ? await sourceHasAudio(ctx, abs) : false;
  let totalFrames: number | null = null;
  if (kind === "video" || kind === "audio") {
    const secs = await sourceDurationSeconds(ctx.runner, abs);
    totalFrames = secs > 0 ? Math.round(secs * fps) : null;
  }
  return { media: { ref: await ctx.store.toMediaRef(abs), kind, totalFrames, hasAudio } };
}

export async function setKeyframesTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return NOT_READY;
  const property = String(args.property ?? "");
  if (!KEYFRAME_PROPS.includes(property)) {
    return {
      ok: false,
      error: `property must be one of ${JSON.stringify(KEYFRAME_PROPS)}`,
    };
  }
  if (!Array.isArray(args.keyframes)) return { ok: false, error: "keyframes must be a list" };
  const keyframes = args.keyframes as Args[];
  // Animating scale reaches the same tracks `set_clip_properties` writes, so it needs the same
  // source size to bound it — a guard on one door only leaves the other wide open.
  const dims =
    TRANSFORM_SCALAR_PROPS.has(property) && keyframes.length > 0
      ? await sourceDims(ctx, [args.clip_id])
      : new Map();
  return ctxApplyOp(ctx, "set_keyframes", (timeline) => {
    const fps = canvasFps(timeline);
    const [, clip] = requireClip(timeline, args.clip_id);
    // `position` (a VECTOR track) and `scale`/`scale_x`/`scale_y` animate the
    // normalized `transform`; other props stay top-level on the clip.
    if (property === "position") {
      clip.transform ??= {};
      const t = clip.transform as Record<string, unknown>;
      t.position ??= {};
      const pos = t.position as Record<string, unknown>;
      if (keyframes.length === 0) {
        delete pos.x;
        delete pos.y;
        return { property, n: 0, cleared: true };
      }
      // A position keyframe is {t, x, y, ease?}; split into two scalar sub-tracks.
      pos.x = normalizeKeyframes(
        keyframes.map((k) => ({
          t: toFrames(k.t, fps),
          v: k.x,
          ...(k.ease ? { ease: k.ease } : {}),
        })),
      );
      pos.y = normalizeKeyframes(
        keyframes.map((k) => ({
          t: toFrames(k.t, fps),
          v: k.y,
          ...(k.ease ? { ease: k.ease } : {}),
        })),
      );
      return { property, n: keyframes.length };
    }
    if (TRANSFORM_SCALAR_PROPS.has(property)) {
      clip.transform ??= {};
      const t = clip.transform as Record<string, unknown>;
      if (keyframes.length === 0) {
        delete t[property];
        return { property, n: 0, cleared: true };
      }
      t[property] = compileKeyframes(keyframes, fps);
      const notes: string[] = [];
      clampMagnification(timeline, clip, String(args.clip_id ?? ""), dims, notes);
      return notes.length
        ? { property, n: keyframes.length, notes }
        : { property, n: keyframes.length };
    }
    if (keyframes.length === 0) {
      delete (clip as Record<string, unknown>)[property];
      return { property, n: 0, cleared: true };
    }
    (clip as Record<string, unknown>)[property] = compileKeyframes(keyframes, fps);
    return { property, n: keyframes.length };
  });
}

export function applyEffectsTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return Promise.resolve(NOT_READY);
  if (!Array.isArray(args.clip_ids))
    return Promise.resolve({ ok: false, error: "clip_ids must be a list" });
  const add = Array.isArray(args.add) ? (args.add as Args[]) : [];
  const remove = Array.isArray(args.remove) ? (args.remove as unknown[]) : [];
  if (add.length === 0 && remove.length === 0)
    return Promise.resolve({ ok: false, error: "pass 'add' and/or 'remove'" });
  const clipIds = args.clip_ids as unknown[];
  return ctxApplyOp(ctx, "apply_effects", (timeline) => {
    let n = 0;
    const echo: Record<string, unknown[]> = {};
    for (const cid of clipIds) {
      const [, clip] = requireClip(timeline, cid);
      const field = clip.kind === "audio" ? "audio_effects" : "effects";
      const kind = kindForClip(clip.kind);
      const stack = new Map<string, Record<string, unknown>>();
      for (const e of ((clip as Record<string, unknown>)[field] as Args[]) ?? []) {
        if (e !== null && typeof e === "object" && e.type) stack.set(String(e.type), { ...e });
      }
      for (const eff of add) {
        if (!eff.type) throw new OpError("each effect needs a 'type'");
        // Resolve against the registry BEFORE storing: an effect that reaches the
        // timeline is always complete enough for the renderer to draw it.
        const { effect, error } = resolveEffect(eff, kind, stack.get(String(eff.type)));
        if (error || !effect) throw new OpError(error ?? "invalid effect");
        stack.set(String(effect.type), effect);
      }
      for (const etype of remove) stack.delete(String(etype));
      if (stack.size) (clip as Record<string, unknown>)[field] = [...stack.values()];
      else delete (clip as Record<string, unknown>)[field];
      echo[String(clip.id)] = [...stack.values()];
      n++;
    }
    return { updated: n, effects: echo };
  });
}

export function applyColorTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return Promise.resolve(NOT_READY);
  if (!Array.isArray(args.clip_ids))
    return Promise.resolve({ ok: false, error: "clip_ids must be a list" });
  const clipIds = args.clip_ids as unknown[];
  // Build the grade patch: a pasted whole-grade `color` object (grade-copy) plus
  // any flattened top-level knobs (knobs win on conflict). `reset` (or color:null)
  // starts from a neutral grade; an empty result clears the grade.
  // Null-prototype accumulator: a literal `__proto__` in a pasted grade would hit
  // the prototype setter instead of becoming an own key, and so dodge validation.
  const patch: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (args.color !== null && typeof args.color === "object")
    Object.assign(patch, args.color as Record<string, unknown>);
  for (const k of colorKnobs()) if (args[k] !== undefined) patch[k] = args[k];
  // Clamp + reject unknown knobs against the served registry: the description has
  // always promised clamping, and a pasted `color` object could carry anything.
  const { grade, error } = resolveGrade(patch);
  if (error || !grade) return Promise.resolve({ ok: false, error: error ?? "invalid grade" });
  // A LUT is a library .cube asset (media_... id / filename) — reject a raw system path up front so an
  // absolute / `..` LUT is never stored (and later fed to ffmpeg's lut3d=file=). Mirrors resolveMediaRef.
  if (typeof grade.lut === "string" && isUnsafeAgentRef(grade.lut)) {
    return Promise.resolve({
      ok: false,
      error: `lut must be a library asset (media_... id or filename), not a system path: ${grade.lut}`,
    });
  }
  const startNeutral = args.reset === true || args.color === null;
  return ctxApplyOp(ctx, "apply_color", (timeline) => {
    let n = 0;
    const echo: Record<string, unknown> = {};
    for (const cid of clipIds) {
      const [, clip] = requireClip(timeline, cid);
      const next = { ...(startNeutral ? {} : (clip.color ?? {})), ...grade };
      if (Object.keys(next).length > 0) clip.color = next;
      else delete (clip as Record<string, unknown>).color;
      echo[String(clip.id)] = next;
      n++;
    }
    return { updated: n, color: echo };
  });
}

// The agent's set_transition (op "set_transition") shares the auto-overlap
// mutation with the UI's apply_transition: it shifts the clip so it overlaps the
// previous same-track clip by `duration`, so the model never pre-arranges the
// overlap (abutting clips are fine). Clearing restores the abutting position.
export function setTransitionTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return Promise.resolve(NOT_READY);
  return ctxApplyOp(ctx, "set_transition", transitionMutation(args));
}
