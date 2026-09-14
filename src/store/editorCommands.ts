// The editor's timeline-mutation commands, split out of the store shell so
// editor.ts owns view state + project lifecycle and this owns the edit surface.
// Every command is a thin, dependency-injected delegation to a tested timeline
// tool (get/set/getRunner are supplied by the store).
import {
  applyTransitionTool,
  duplicateClipsTool,
  linkClipsTool,
  pasteClipsTool,
  removeClipsTool,
  rippleDeleteTool,
  splitClipsTool,
  trimClipsTool,
  unlinkClipsTool,
} from "../timeline/edit";
import { findClip } from "../timeline/helpers";
import { useProjectNotice } from "./projectNotice";
import { readAnim, writeAnim } from "../timeline/animProps";
import { upsertKeyframe } from "../timeline/keyframe";
import { gapAt } from "../timeline/gaps";
import type { Clip } from "../timeline/model";
import {
  addTrackTool,
  removeTracksTool,
  setCanvasTool,
  setTrackTool,
  setTracksTool,
} from "../timeline/ops";
import { addClipsTool, resolveAddSpecs } from "../timeline/placement";
import {
  duplicateClipsToPositions,
  moveClips,
  nudgeClips,
  placeClips,
  rippleTrim,
  rollEdit,
  setClipEnabled,
  slideClip,
  slipClip,
  trimToPlayhead,
} from "../timeline/operations";
import { runGesture } from "../timeline/engine";
import { setClipPropertiesTool } from "../timeline/props";
import { sourceLengths } from "../timeline/sourceLength";
import type { CommandRunner } from "../tools/command";
import type { ClientToolContext } from "../tools/context";
import type { ProjectStoreAccess } from "../tools/store";
import type { EditorState } from "./editor";

// Timeline edit tools only ever read ctx.store; this runner guards against an op
// unexpectedly reaching for a binary (none of the PLACEMENT/structure ops do).
const NO_RUNNER: CommandRunner = {
  run: () => Promise.reject(new Error("command runner is not available in the manual editor")),
};
function editCtx(store: ProjectStoreAccess): ClientToolContext {
  return { store, runner: NO_RUNNER };
}

async function probeDurationFrames(
  runner: CommandRunner,
  absSource: string,
  fps: number,
): Promise<number> {
  try {
    const r = await runner.run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      absSource,
    ]);
    const sec = parseFloat((r.stdout ?? "").trim());
    if (r.code === 0 && Number.isFinite(sec) && sec > 0) return Math.max(1, Math.round(sec * fps));
  } catch {
    /* image / probe failure -> default */
  }
  return Math.round(5 * fps); // stills / unprobeable default to 5s
}

type EditorCommandKey =
  | "moveClip"
  | "trimClip"
  | "nudgeClips"
  | "moveSelectionBy"
  | "setClipEnabled"
  | "trimToPlayhead"
  | "rippleTrim"
  | "rollEdit"
  | "slipClip"
  | "slideClip"
  | "clipSourceFrames"
  | "splitClip"
  | "deleteClips"
  | "rippleDeleteClip"
  | "rippleDeleteGap"
  | "duplicateClip"
  | "linkClips"
  | "unlinkClips"
  | "copyClip"
  | "pasteClip"
  | "setClipProperties"
  | "setKeyframe"
  | "setTransition"
  | "setCanvas"
  | "addClip"
  | "addClips"
  | "processImport"
  | "addTrack"
  | "removeTrack"
  | "setTrack"
  | "setTracks";

/** Build the editor's timeline-mutation commands bound to the store's get/set +
 *  the (lazy, injectable) command runner. */
export function makeEditorCommands(
  get: () => EditorState,
  set: (partial: Partial<EditorState>) => void,
  getRunner: () => CommandRunner | Promise<CommandRunner>,
): Pick<EditorState, EditorCommandKey> {
  /** Context for edits that CHANGE A CLIP'S LENGTH. Those bound the clip by its real
   *  media duration, which needs ffprobe — under NO_RUNNER the probe fails, the tool
   *  reads it as "unbounded", and a hand-drag stretches a video past its own footage. */
  const probeCtx = async (store: ProjectStoreAccess): Promise<ClientToolContext> => {
    try {
      return { store, runner: await getRunner() };
    } catch {
      return editCtx(store); // no Tauri (web) -> unbounded, same as an unprobeable file
    }
  };
  return {
    moveClip: async (clipId, opts) => {
      const { store } = get();
      if (!store) return;
      const move = {
        clip_id: clipId,
        to_timeline_in: opts.toTimelineIn,
        to_track: opts.toTrack,
      };
      // Alt+drag duplicates instead of moving, and can leave the link partner behind.
      await runGesture(store, opts.duplicate ? "duplicate_clips" : "move_clips", (apply) => {
        apply(opts.duplicate ? "duplicate_clips" : "move_clips", (tl) =>
          opts.duplicate
            ? duplicateClipsToPositions(tl, [move], { ignoreLinks: opts.ignoreLinks })
            : moveClips(tl, [move], { ignoreLinks: opts.ignoreLinks }),
        );
      });
    },
    trimClip: async (clipId, edges) => {
      const { store } = get();
      if (!store) return;
      await trimClipsTool({ trims: [{ clip_id: clipId, ...edges }] }, await probeCtx(store));
    },
    nudgeClips: async (ids, delta) => {
      const { store } = get();
      if (!store || !ids.length) return;
      await runGesture(store, "nudge_clips", (apply) => {
        apply("nudge_clips", (tl) => nudgeClips(tl, ids, delta));
      });
    },
    /** Drag of a multi-clip selection: every clip shifts by the same delta, in ONE undo entry,
     *  and the whole thing is refused rather than overwriting a bystander. */
    moveSelectionBy: async (ids, delta) => {
      const { store } = get();
      if (!store || ids.length < 2 || !delta) return;
      await runGesture(store, "move_clips", (apply) => {
        apply("move_clips", (tl) => nudgeClips(tl, ids, delta, { refuseOverwrite: true }));
      });
    },
    setClipEnabled: async (ids, enabled) => {
      const { store } = get();
      if (!store || !ids.length) return;
      await runGesture(store, "set_clip_enabled", (apply) => {
        apply("set_clip_enabled", (tl) => setClipEnabled(tl, ids, enabled));
      });
    },
    trimToPlayhead: async (clipId, edge) => {
      const { store, timeline, playhead } = get();
      if (!store || !timeline) return;
      const fps = Number(timeline.canvas?.fps) || 30;
      const at = Math.round(playhead * fps);
      // Probed before the lease, like every other length-changing edit.
      const lengths = await sourceLengths(await probeCtx(store), [clipId]);
      await runGesture(store, "trim_to_playhead", (apply) => {
        apply("trim_to_playhead", (tl) => trimToPlayhead(tl, clipId, edge, at, lengths));
      });
    },
    rippleTrim: async (clipId, edge, toFrame) => {
      const { store } = get();
      if (!store) return;
      const lengths = await sourceLengths(await probeCtx(store), [clipId]);
      await runGesture(store, "ripple_trim", (apply) => {
        apply("ripple_trim", (tl) => rippleTrim(tl, clipId, edge, toFrame, lengths));
      });
    },
    rollEdit: async (leftClipId, toFrame) => {
      const { store, timeline } = get();
      if (!store || !timeline) return;
      // Both sides of the cut change, so both need their real source lengths for the clamp.
      const found = findClip(timeline, leftClipId);
      const cut = found ? Number(found[1].timeline_out) || 0 : 0;
      const right = found?.[0].clips?.find((c) => (Number(c.timeline_in) || 0) === cut);
      const ids = right?.id ? [leftClipId, String(right.id)] : [leftClipId];
      const lengths = await sourceLengths(await probeCtx(store), ids);
      await runGesture(store, "roll_edit", (apply) => {
        apply("roll_edit", (tl) => rollEdit(tl, leftClipId, toFrame, lengths));
      });
    },
    slipClip: async (clipId, delta) => {
      const { store } = get();
      if (!store) return;
      const lengths = await sourceLengths(await probeCtx(store), [clipId]);
      await runGesture(store, "slip_clip", (apply) => {
        apply("slip_clip", (tl) => slipClip(tl, clipId, delta, lengths));
      });
    },
    slideClip: async (clipId, delta) => {
      const { store, timeline } = get();
      if (!store || !timeline) return;
      const found = findClip(timeline, clipId);
      const ids = [clipId, ...(found?.[0].clips ?? []).map((c) => String(c.id ?? ""))].filter(
        Boolean,
      );
      const lengths = await sourceLengths(await probeCtx(store), ids);
      await runGesture(store, "slide_clip", (apply) => {
        apply("slide_clip", (tl) => slideClip(tl, clipId, delta, lengths));
      });
    },
    clipSourceFrames: async (clipId) => {
      const { store } = get();
      if (!store) return null;
      const lengths = await sourceLengths(await probeCtx(store), [clipId]);
      return lengths.get(clipId) ?? null;
    },
    splitClip: async (clipId, atFrame) => {
      const { store } = get();
      if (!store) return;
      await splitClipsTool({ splits: [{ clip_id: clipId, at: atFrame }] }, editCtx(store));
    },
    deleteClips: async (ids) => {
      const { store } = get();
      if (!store || ids.length === 0) return;
      await removeClipsTool({ clip_ids: ids }, editCtx(store));
      set({ selection: null, selectedIds: [] });
    },
    rippleDeleteClip: async (clipId) => {
      const { store, timeline } = get();
      if (!store || !timeline) return;
      const found = findClip(timeline, clipId);
      if (!found) return;
      const [track, clip] = found;
      await rippleDeleteTool(
        { track_id: track.id, start: clip.timeline_in as number, end: clip.timeline_out as number },
        editCtx(store),
      );
    },
    rippleDeleteGap: async () => {
      const { store, timeline, selectedGap } = get();
      if (!store || !selectedGap) return;
      // Resolve the point NOW, through the same owner the highlight is drawn from. A span cached
      // at click time could have been shifted by any edit since, and cutting it would trim a clip.
      const g = gapAt(timeline, selectedGap.trackId, selectedGap.atFrame);
      if (!g) return;
      await rippleDeleteTool({ track_id: g.trackId, start: g.start, end: g.end }, editCtx(store));
      set({ selectedGap: null });
    },
    duplicateClip: async (clipId) => {
      const { store } = get();
      if (!store) return;
      const r = (await duplicateClipsTool({ clip_ids: [clipId] }, editCtx(store))) as {
        new_clip_ids?: string[];
      };
      const nid = r.new_clip_ids?.[0];
      if (nid) set({ selection: nid, selectedIds: [nid] });
    },
    linkClips: async (ids) => {
      const { store } = get();
      if (!store || ids.length < 2) return;
      await linkClipsTool({ clip_ids: ids }, editCtx(store));
    },
    unlinkClips: async (ids) => {
      const { store } = get();
      if (!store || ids.length === 0) return;
      await unlinkClipsTool({ clip_ids: ids }, editCtx(store));
    },
    copyClip: (clipId) => {
      const { timeline } = get();
      if (!timeline) return;
      const found = findClip(timeline, clipId);
      if (!found) return;
      const [track, clip] = found;
      set({
        clipboard: {
          clip: JSON.parse(JSON.stringify(clip)) as Clip,
          trackId: track.id,
          trackKind: String(track.kind),
        },
      });
    },
    pasteClip: async (atFrame) => {
      const { store, timeline, clipboard, playhead } = get();
      if (!store || !timeline || !clipboard) return;
      const fps = Number(timeline.canvas?.fps) || 30;
      const at = atFrame ?? Math.round(playhead * fps);
      const track =
        timeline.tracks.find((t) => t.id === clipboard.trackId) ??
        timeline.tracks.find((t) => String(t.kind) === clipboard.trackKind);
      if (!track) return;
      const r = (await pasteClipsTool(
        { clips: [clipboard.clip], track_id: track.id, at },
        editCtx(store),
      )) as { new_clip_ids?: string[] };
      const nid = r.new_clip_ids?.[0];
      if (nid) set({ selection: nid, selectedIds: [nid] });
    },
    setClipProperties: async (clipId, properties) => {
      const { store } = get();
      if (!store) return;
      // May carry `duration` / a source edge from the Inspector -> same length rule as a drag.
      await setClipPropertiesTool({ clip_ids: [clipId], properties }, await probeCtx(store));
    },
    setKeyframe: async (clipId, path, at, value, opts = {}) => {
      const { store, timeline } = get();
      if (!store || !timeline) return;
      const found = findClip(timeline, clipId);
      if (!found) return;
      const clip = found[1];
      const cur = readAnim(clip, path);
      const curve = Array.isArray(cur) ? cur : null;
      // A move REPLACES the grabbed key; it is not remove-then-add. `removeKeyframe` refuses to
      // drop the LAST key on a curve (by contract it never returns an empty one), so
      // remove-then-upsert silently turned a single-key drag into two keys (S14).
      const from = opts.fromT;
      const base =
        typeof from === "number" && curve ? curve.filter((k) => Number(k.t) !== from) : cur;
      const next = upsertKeyframe(base, at, value, opts.ease);
      await setClipPropertiesTool(
        { clip_ids: [clipId], properties: writeAnim(clip, path, next) },
        await probeCtx(store),
      );
    },
    setTransition: async (clipId, transition) => {
      const { store } = get();
      if (!store) return;
      await applyTransitionTool({ clip_id: clipId, transition_in: transition }, editCtx(store));
    },
    setCanvas: async (patch) => {
      const { store } = get();
      if (!store) return;
      await setCanvasTool(patch, editCtx(store));
    },
    addClip: async (source, trackId, atFrame) => {
      const { store, timeline } = get();
      if (!store || !timeline) return;
      const runner = await getRunner();
      const fps = Number(timeline.canvas?.fps) || 30;
      const abs = (await store.resolveRef(source)) ?? source;
      const dur = await probeDurationFrames(runner, abs, fps);
      const at = Math.max(0, Math.round(atFrame));
      await addClipsTool(
        {
          entries: [
            { media_ref: source, track_id: trackId, timeline_in: at, timeline_out: at + dur },
          ],
        },
        // The awaits above (runner warm-up, ref resolve, ffprobe) can span a project switch; the
        // session-liveness guard in saveTimeline abandons the write if the user navigated away
        // (the store captured its session at load), so the clip never lands in the project they left.
        { store, runner },
      );
    },
    addClips: async (sources, trackId, atFrame) => {
      const { store, timeline } = get();
      if (!store || !timeline || !sources.length) return;
      const runner = await getRunner();
      const fps = Number(timeline.canvas?.fps) || 30;
      const at = Math.max(0, Math.round(atFrame));
      const ctx = { store, runner };
      // Probe every file BEFORE taking the lease: `runGesture` holds it for the whole intent, and
      // holding it across N ffprobes would stall every other edit in the app.
      let cursor = at;
      const entries: Array<Record<string, unknown>> = [];
      for (const source of sources) {
        const abs = (await store.resolveRef(source)) ?? source;
        const dur = await probeDurationFrames(runner, abs, fps);
        entries.push({
          media_ref: source,
          track_id: trackId,
          timeline_in: cursor,
          timeline_out: cursor + dur,
        });
        cursor += dur;
      }
      let specs;
      try {
        specs = await resolveAddSpecs(ctx, entries);
      } catch (e) {
        // This swallowed every failed placement, so an OS drop onto a lane imported the file
        // and then did nothing at all — no clip, no error, nothing to report.
        useProjectNotice
          .getState()
          .notify(
            `Couldn't add ${sources.length === 1 ? "that file" : `those ${sources.length} files`} to the timeline: ${e instanceof Error ? e.message : String(e)}`,
          );
        return;
      }
      // ONE entry for one drop, however many files it carried — dropping five used to cost five
      // presses of Ctrl+Z.
      await runGesture(store, "add_clips", (apply) => {
        apply("add_clips", (tl) => placeClips(tl, specs));
      });
    },
    processImport: async (relSource) => {
      // Poster + preview proxy + transcript for a just-imported source, via the
      // per-project indexer (proxies drain first, so the preview is ready fast).
      get()._index?.indexSource(relSource);
    },
    addTrack: async (kind) => {
      const { store } = get();
      if (!store) return;
      await addTrackTool({ kind }, editCtx(store));
    },
    removeTrack: async (trackId) => {
      const { store } = get();
      if (!store) return;
      await removeTracksTool({ track_ids: [trackId] }, editCtx(store));
    },
    setTrack: async (trackId, patch) => {
      const { store } = get();
      if (!store) return;
      await setTrackTool({ track_id: trackId, ...patch }, editCtx(store));
    },
    setTracks: async (patches) => {
      const { store } = get();
      if (!store || patches.length === 0) return;
      await setTracksTool(
        { tracks: patches.map(({ trackId, ...rest }) => ({ track_id: trackId, ...rest })) },
        editCtx(store),
      );
    },
  };
}
