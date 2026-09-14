// Structural timeline ops (get_timeline, canvas, add_track, remove_tracks,
// set_track, undo, redo) as client tools. Ports timeline_op_tools.py. Clip
// placement/edit ops land in later slices.
import type { ClientToolContext } from "../tools/context";
import { getEditorContextSnapshot } from "../tools/editorContext";
import type { ClientToolRegistry } from "../tools/registry";
import {
  linkClipsTool,
  moveClipsTool,
  removeClipsTool,
  rippleDeleteTool,
  splitClipsTool,
  unlinkClipsTool,
} from "./edit";
import { aspectLabel, resolveCanvas } from "./canvas";
import { ctxApplyOp, doRedo, doUndo, loadTimeline } from "./engine";
import { OpError } from "./errors";
import { canvasFps, newId } from "./frames";
import { gapAt } from "./gaps";
import { findTrack, nextZ } from "./helpers";
import { normalizeKeyframes } from "./keyframe";
import * as operations from "./operations";
import { buildGapMention, buildRangeMention, formatTimecode } from "./mentions";
import type { Timeline, Track } from "./model";
import { addClipsTool, addTextClipsTool, insertClipsTool, updateTextTool } from "./placement";
import {
  applyColorTool,
  applyEffectsTool,
  setClipPropertiesTool,
  setKeyframesTool,
  setTransitionTool,
} from "./props";
import { exportTimelineTool } from "./render";
import { manageExportsTool } from "./exportQueue";
import { collapseCaptionGroups, compactClip } from "./shape";

type Result = Record<string, unknown>;
type Args = Record<string, unknown>;
const NOT_READY: Result = { ok: false, error: "client tool runtime not ready" };

function present(v: unknown): boolean {
  return v !== undefined && v !== null;
}

// ── get_timeline compaction ────────────────────────────────────────────────
// `compactClip` (default-omit) is shared with the mutation-delta path (shape.ts),
// so a read and an edit-return describe a clip identically.
function timelineTotalFrames(tl: Timeline): number {
  let max = 0;
  for (const t of tl.tracks ?? [])
    for (const c of t.clips ?? []) max = Math.max(max, Number(c.timeline_out) || 0);
  return max;
}

/** Shallow copy of `track` with default flags dropped and its clips compacted +
 *  optionally windowed to [win.start, win.end). A track whose clips were clipped
 *  reports `total_clips` (its full pre-window count). */
function compactTrack(
  track: Track,
  win: { start: number; end: number } | null,
  captionDetail = false,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...track };
  if (out.mute === false) delete out.mute;
  if (out.hidden === false) delete out.hidden;
  if (out.sync_locked === true) delete out.sync_locked; // absent = locked (default); keep only explicit false
  let clips = track.clips ?? [];
  if (win) {
    const visible = clips.filter(
      (c) => (Number(c.timeline_in) || 0) < win.end && (Number(c.timeline_out) || 0) > win.start,
    );
    if (visible.length < clips.length) out.total_clips = clips.length;
    clips = visible;
  }
  out.clips = captionDetail ? clips.map(compactClip) : collapseCaptionGroups(clips);
  return out;
}

export async function getTimelineTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return NOT_READY;
  let timeline: Timeline;
  try {
    timeline = await loadTimeline(ctx.store);
  } catch (e) {
    return {
      ok: false,
      error: `timeline.json not found — bootstrap the timeline first (${String(e)})`,
    };
  }
  // Migration: older projects baked a now-dropped "do NOT place image files" rule
  // into the schema note; strip it so the model isn't misled (images ARE valid
  // visual clips — placed as a held frame for their timeline duration).
  if (
    typeof timeline._schema_note === "string" &&
    timeline._schema_note.includes("do NOT place image")
  ) {
    timeline._schema_note = timeline._schema_note.replace(
      /\s*Only VIDEO sources.*?on the timeline\.?/,
      "",
    );
  }
  // Optional windowing: page a large timeline by frame range. Half-open
  // [start, end); a clip is kept when it OVERLAPS the window.
  let win: { start: number; end: number } | null = null;
  if (present(args.start_frame) || present(args.end_frame)) {
    const gaveEnd = present(args.end_frame);
    const start = present(args.start_frame) ? Math.max(0, Math.trunc(Number(args.start_frame))) : 0;
    const end = gaveEnd ? Math.trunc(Number(args.end_frame)) : timelineTotalFrames(timeline);
    // Only an end the CALLER supplied can be wrong. A derived one that fails this is
    // just an empty/short timeline (start_frame:0 on a fresh project), which means
    // "read it all" — erroring there punished the model for the project being empty.
    if (!(end > start)) {
      if (gaveEnd)
        return {
          ok: false,
          error:
            `invalid window [${start}, ${end}) — end_frame must be greater than start_frame. ` +
            `Omit both to read the WHOLE timeline; you don't need to know its length.`,
        };
    } else {
      win = { start, end };
    }
  }
  // Compact projection: default-valued fields omitted, clips optionally windowed.
  const captionDetail = args.caption_detail === true;
  const compact = {
    ...timeline,
    tracks: (timeline.tracks ?? []).map((t) => compactTrack(t, win, captionDetail)),
  };
  const result: Result = { ok: true, timeline: compact };
  if (win) result.window = [win.start, win.end];
  // Ambient editor context: WHERE the user is looking right now (playhead +
  // selection), so the model can act on "here"/"this" without the user spelling
  // out frames. Mirrors other NLEs' get_timeline.currentFrame. Present only when
  // the manual editor has pushed a live snapshot (absent in headless runs).
  const snap = getEditorContextSnapshot();
  const fps = canvasFps(timeline);
  if (snap.playheadFrame != null) {
    result.current_frame = snap.playheadFrame;
    result.current_timecode = formatTimecode(snap.playheadFrame, fps);
  }
  if (snap.selectedClipIds.length) result.selected_clip_ids = snap.selectedClipIds;
  if (snap.selectedRange) {
    result.selected_range = buildRangeMention(
      snap.selectedRange.startFrame,
      snap.selectedRange.endFrame,
      fps,
    );
  }
  // Resolved against THIS timeline, never carried as a span: the user's click is a point, and
  // between the click and this read an edit may have filled the space. `gapAt` returns null
  // then, which is the honest answer -- reporting the old span would point the model at
  // material and invite it to ripple over a clip.
  if (snap.selectedGap) {
    const g = gapAt(timeline, snap.selectedGap.trackId, snap.selectedGap.atFrame);
    if (g) result.selected_gap = buildGapMention(g.trackId, g, fps);
  }
  return result;
}

/** The canvas mutation on the ACTIVE timeline. NOT registered as a model tool:
 *  `set_project_settings` (tools/project.ts) is the single canvas tool the model
 *  sees and wraps this, then syncs project.json. Also called directly by the
 *  manual editor (store/editorCommands.ts). */
export function setCanvasTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return Promise.resolve(NOT_READY);
  return ctxApplyOp(ctx, "set_project_settings", (timeline) => {
    const canvas = timeline.canvas;
    const before = {
      width: Math.trunc(Number(canvas.width) || 0),
      height: Math.trunc(Number(canvas.height) || 0),
      fps: Math.trunc(Number(canvas.fps) || 30),
    };
    const next = resolveCanvas(args, before);
    if ("error" in next) throw new OpError(next.error);
    if (next.fps !== before.fps) {
      // fps is project-wide: every frame coordinate is measured at canvas.fps, so
      // changing it rescales every clip span, source cursor, keyframe time, fade
      // and transition by the ratio and pushes later clips right so rounding can't
      // overlap them. Mirrors other NLEs applyTimelineSettings / Timeline.rescaleFrames.
      rescaleTimelineFps(timeline, next.fps / before.fps);
      canvas.fps = next.fps;
    }
    canvas.width = next.width;
    canvas.height = next.height;

    const changed: string[] = [];
    if (next.fps !== before.fps) changed.push("fps");
    if (next.width !== before.width || next.height !== before.height) changed.push("resolution");
    const out: Result = {
      fps: next.fps,
      resolution: `${next.width}x${next.height}`,
      aspect_ratio: aspectLabel(next.width, next.height),
      changed,
    };
    if (next.note) out.note = next.note;
    if (!changed.length) out.note = "settings already matched — nothing changed";
    else if (changed.includes("fps"))
      out.note = `clip frames rescaled to ${next.fps}fps — re-read get_timeline before frame-based edits`;
    return out;
  });
}

/** Rescale every frame quantity in the timeline by `scale` (= newFps / oldFps).
 *  Per track, clips are visited left-to-right and each clip's start is clamped to
 *  the previous clip's rounded end, so integer rounding can never make same-track
 *  clips overlap (later clips slide right). source_out is left to the derive step.
 *  speed is unitless and unchanged. */
function rescaleTimelineFps(timeline: Timeline, scale: number): void {
  const round = (n: number): number => Math.round(n * scale);
  const scaleTrack = (obj: Record<string, unknown>, key: string): void => {
    const v = obj[key];
    // Rounding can land two distinct times on the same frame — dedupe (last wins).
    if (Array.isArray(v))
      obj[key] = normalizeKeyframes(v.map((kf) => ({ ...kf, t: round((kf as { t: number }).t) })));
  };
  for (const track of timeline.tracks ?? []) {
    const ordered = (track.clips ?? [])
      .slice()
      .sort((a, b) => (Number(a.timeline_in) || 0) - (Number(b.timeline_in) || 0));
    let prevEnd = 0;
    for (const c of ordered) {
      const inF = Number(c.timeline_in) || 0;
      const outF = Number(c.timeline_out) || 0;
      const dur = Math.max(1, round(outF - inF));
      const newIn = Math.max(round(inF), prevEnd);
      c.timeline_in = newIn;
      c.timeline_out = newIn + dur;
      prevEnd = c.timeline_out;
      if (typeof c.source_in === "number") c.source_in = round(c.source_in);
      const rec = c as unknown as Record<string, unknown>;
      scaleTrack(rec, "opacity");
      scaleTrack(rec, "rotate");
      scaleTrack(rec, "volume");
      const tf = c.transform as Record<string, unknown> | undefined;
      if (tf) {
        const pos = tf.position as Record<string, unknown> | undefined;
        if (pos) {
          scaleTrack(pos, "x");
          scaleTrack(pos, "y");
        }
        scaleTrack(tf, "scale");
        scaleTrack(tf, "scale_x");
        scaleTrack(tf, "scale_y");
      }
      if (c.fade) {
        if (typeof c.fade.in === "number") c.fade.in = round(c.fade.in);
        if (typeof c.fade.out === "number") c.fade.out = round(c.fade.out);
      }
      if (c.transition_in && typeof c.transition_in.duration === "number") {
        c.transition_in.duration = round(c.transition_in.duration);
      }
    }
  }
}

export function addTrackTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return Promise.resolve(NOT_READY);
  const tkind = String(args.kind ?? "video").toLowerCase();
  if (!["video", "audio", "text"].includes(tkind)) {
    return Promise.resolve({ ok: false, error: "kind must be 'video', 'audio', or 'text'" });
  }
  return ctxApplyOp(ctx, "add_track", (timeline) => {
    const tracks = timeline.tracks;
    const trackId = (args.id ? String(args.id) : "") || newId("track");
    if (findTrack(timeline, trackId)) throw new OpError(`track '${trackId}' already exists`);
    tracks.push({
      id: trackId,
      kind: tkind as Track["kind"],
      z: present(args.z) ? Math.trunc(Number(args.z)) : nextZ(tracks),
      clips: [],
    });
    return { track_id: trackId };
  });
}

export function removeTracksTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return Promise.resolve(NOT_READY);
  if (!Array.isArray(args.track_ids))
    return Promise.resolve({ ok: false, error: "track_ids must be a list" });
  const ids = new Set(args.track_ids.map(String));
  return ctxApplyOp(ctx, "remove_tracks", (timeline) => {
    const before = timeline.tracks.length;
    timeline.tracks = timeline.tracks.filter((t) => !ids.has(t.id));
    const removed = before - timeline.tracks.length;
    if (removed === 0) throw new OpError("no matching track ids");
    return { removed };
  });
}

export function setTrackTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return Promise.resolve(NOT_READY);
  return ctxApplyOp(ctx, "set_track", (timeline) => operations.setTrack(timeline, args));
}

/** Patch SEVERAL tracks as one operation.
 *
 *  Restacking by dragging a track label changes the z of every track it passes, and
 *  issuing one `set_track` per track cost one undo entry per track — so one drag took
 *  N presses of Ctrl+Z to put back. One op, one entry. */
export function setTracksTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return Promise.resolve(NOT_READY);
  if (!Array.isArray(args.tracks))
    return Promise.resolve({ ok: false, error: "tracks must be a list" });
  const patches = args.tracks as Args[];
  return ctxApplyOp(ctx, "set_tracks", (timeline) => operations.setTracks(timeline, patches));
}

export function undoTool(_args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return Promise.resolve(NOT_READY);
  return doUndo(ctx.store);
}
export function redoTool(_args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return Promise.resolve(NOT_READY);
  return doRedo(ctx.store);
}

export function registerTimelineTools(
  registry: ClientToolRegistry,
  getCtx: () => ClientToolContext | null,
): void {
  registry.register("get_timeline", (args) => getTimelineTool(args, getCtx()));
  registry.register("add_track", (args) => addTrackTool(args, getCtx()));
  registry.register("remove_tracks", (args) => removeTracksTool(args, getCtx()));
  registry.register("set_track", (args) => setTrackTool(args, getCtx()));
  registry.register("set_tracks", (args) => setTracksTool(args, getCtx()));
  registry.register("undo", (args) => undoTool(args, getCtx()));
  registry.register("redo", (args) => redoTool(args, getCtx()));
  // placement (8b)
  registry.register("add_clips", (args) => addClipsTool(args, getCtx()));
  registry.register("insert_clips", (args) => insertClipsTool(args, getCtx()));
  registry.register("add_text_clips", (args) => addTextClipsTool(args, getCtx()));
  registry.register("update_text", (args) => updateTextTool(args, getCtx()));
  // structural edits (8c)
  registry.register("move_clips", (args) => moveClipsTool(args, getCtx()));
  // NOTE: no trim_clips. Retired in contract 1.7.0 — trimming/slipping is
  // set_clip_properties' source_in/source_out/duration. trimClipsTool survives as
  // an INTERNAL function for the editor's drag-trim, which passes an explicit,
  // already-consistent quad (see store/editorCommands.ts).
  registry.register("split_clips", (args) => splitClipsTool(args, getCtx()));
  registry.register("remove_clips", (args) => removeClipsTool(args, getCtx()));
  registry.register("ripple_delete", (args) => rippleDeleteTool(args, getCtx()));
  // properties / animation (8d)
  registry.register("set_clip_properties", (args) => setClipPropertiesTool(args, getCtx()));
  registry.register("set_keyframes", (args) => setKeyframesTool(args, getCtx()));
  registry.register("apply_effects", (args) => applyEffectsTool(args, getCtx()));
  registry.register("apply_color", (args) => applyColorTool(args, getCtx()));
  registry.register("set_transition", (args) => setTransitionTool(args, getCtx()));
  registry.register("link_clips", (args) => linkClipsTool(args, getCtx()));
  registry.register("unlink_clips", (args) => unlinkClipsTool(args, getCtx()));
  // export (8f)
  registry.register("export", (args) => exportTimelineTool(args, getCtx()));
  registry.register("manage_exports", (args) => manageExportsTool(args));
}
