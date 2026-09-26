// The manual-editing store. Holds the working timeline + view state (selection,
// playhead, zoom) and is the single observable the timeline UI and live preview
// render from. It subscribes to the timeline change bus, so writes from EITHER
// the user (manual ops) or the AI (client tools run in this same webview) flow
// back in and update the UI instantly. Edits and undo/redo route through the
// shared engine, so manual + AI edits share one validated history.
import { useStore, type StateCreator } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

import { onTimelineChange } from "../timeline/bus";
import {
  closeProjectSession,
  doRedo,
  doUndo,
  ensureStarterTimeline,
  loadTimeline,
} from "../timeline/engine";
import { whenProjectIdle } from "../tools/coordinator";
import { canvasFps } from "../timeline/frames";
import { gapAt } from "../timeline/gaps";
import { linkGroupIds as linkGroupIdsOf } from "../timeline/helpers";
import type { Clip, Timeline } from "../timeline/model";
import type { CommandRunner } from "../tools/command";
import { setEditorContextSnapshot } from "../tools/editorContext";
import { projectDirFor } from "../tools/dataRoot";
import { ProjectStoreAccess } from "../tools/store";
import { IndexCoordinator } from "./indexCoordinator";
import { makeEditorCommands } from "./editorCommands";

export type ProjectStoreFactory = (
  projectDir: string,
) => ProjectStoreAccess | Promise<ProjectStoreAccess>;

// Default: an fs-backed store on the Tauri filesystem. Dynamically imported so
// the browser bundle / unit tests never load the Tauri plugins; tests inject a
// mock via setProjectStoreFactory.
let makeProjectStore: ProjectStoreFactory = async (dir) => {
  const { TauriFs } = await import("../tools/tauri");
  return new ProjectStoreAccess(dir, new TauriFs());
};

/** DI hook (tests / future web adapter): override how the fs-backed store is built. */
export function setProjectStoreFactory(fn: ProjectStoreFactory): void {
  makeProjectStore = fn;
}

/** Build an fs-backed store for a project dir using the active factory. Exposed
 *  so session/transcript reads can construct a store WITHOUT waiting for the
 *  editor to finish loading — otherwise the read races the editor, gets no store,
 *  and falls back to the (now stateless) server, losing chat history on reopen. */
export function createProjectStore(dir: string): ProjectStoreAccess | Promise<ProjectStoreAccess> {
  return makeProjectStore(dir);
}

// add_clips needs a REAL runner to probe media (duration + audio stream). Lazy +
// injectable so tests supply a fake and non-add ops never load the Tauri shell.
let makeRunner: () => CommandRunner | Promise<CommandRunner> = async () => {
  const { TauriCommandRunner } = await import("../tools/tauri");
  return new TauriCommandRunner();
};
/** DI hook (tests): override how the command runner is built. */
export function setRunnerFactory(fn: () => CommandRunner | Promise<CommandRunner>): void {
  makeRunner = fn;
}

// Background preview proxy + transcript indexing is owned by IndexCoordinator (per project).

const MIN_ZOOM = 4; // px per second
const MAX_ZOOM = 400;
const DEFAULT_ZOOM = 40;

/** A copied clip plus where it came from (to paste back onto a matching track). */
export interface ClipboardEntry {
  clip: Clip;
  trackId: string;
  trackKind: string;
}

export interface EditorState {
  projectId: string | null;
  store: ProjectStoreAccess | null;
  timeline: Timeline | null;
  selection: string | null; // primary/anchor selected clip id (single-clip ops)
  selectedIds: string[]; // every selected clip id (multi-select)
  /** The empty space the user clicked, as a POINT — resolved to a span through `gapAt` at every
   *  use, so an edit that shifts the frames cannot leave it pointing at material. Mutually
   *  exclusive with a clip selection: Delete must have exactly one target. */
  selectedGap: { trackId: string; atFrame: number } | null;
  /** Library assets open as tabs beside the live preview, in strip order. `transient` marks
   *  the one single-click slot the next single click reuses, so browsing the library cannot
   *  fill the strip with tabs nobody asked to keep. */
  mediaTabs: { ref: string; transient: boolean }[];
  /** Which preview tab is showing: a library ref, or null for the pinned live preview. */
  activeMediaTab: string | null;
  selectedRange: { startFrame: number; endFrame: number } | null; // ruler in/out selection (half-open frames)
  playhead: number; // seconds
  zoom: number; // pixels per second
  trackScale: { video: number; audio: number }; // per-kind vertical (row-height) zoom
  loading: boolean;
  error: string | null;
  gestureActive: boolean;
  importing: boolean;
  /** True when the in-memory timeline has un-persisted edits (async autosave pending) or the last
   *  autosave failed — surfaced as an "Unsaved" indicator. Cleared once a save completes. */
  dirty: boolean;
  clipboard: ClipboardEntry | null;
  /** Library id -> human file name, for clip labels. A clip stores its media as a
   *  bare library id, which is not readable, so the UI resolves the name from the
   *  catalog (falling back to the ref itself for legacy path-shaped refs). */
  mediaNames: Record<string, string>;
  /** media id -> "generating" | "failed" for library rows that are not ready. Absent = ready. */
  mediaStatus: Record<string, string>;
  /** Re-read the catalog (names + status). Called when a background job settles. */
  refreshMedia: () => void;
  _unsub: (() => void) | null;
  _pending: Timeline | null; // a bus update deferred until a gesture ends
  _index: IndexCoordinator | null; // per-project background proxy + transcript indexer

  /** Result: "loaded" (committed this project's store), "superseded" (a newer
   *  load took over -> leave the winner's state), or "failed" (build error). The
   *  caller (Shell) reveals the workspace only on "loaded" (Q2). */
  load: (projectId: string) => Promise<"loaded" | "superseded" | "failed">;
  reload: () => Promise<void>;
  select: (clipId: string | null, opts?: { additive?: boolean }) => void;
  selectAll: () => void;
  /** Replace the selection with `ids` (link groups expanded) in ONE update — a marquee
   *  would otherwise fire a store write per clip it swept over. */
  selectMany: (ids: readonly string[]) => void;
  /** Premiere's A / Shift+A: the selected clip and everything at or after it. */
  selectForward: (scope: "track" | "all") => void;
  /** Select the empty space at `frame` on `trackId`, if there is any there. Clears the clip
   *  selection; a frame that is not in a gap clears the gap selection instead. */
  selectGap: (trackId: string, frame: number) => void;
  /** Close the selected gap: ripple the track from the gap's start to its end. */
  rippleDeleteGap: () => Promise<void>;
  /** Show `ref` in the preview. Without `pin` it takes the transient slot. */
  openMediaTab: (ref: string, opts?: { pin?: boolean }) => void;
  closeMediaTab: (ref: string) => void;
  /** null selects the live preview tab. A ref not in the strip is ignored. */
  setActiveMediaTab: (ref: string | null) => void;
  setSelectedRange: (range: { startFrame: number; endFrame: number } | null) => void;
  setPlayhead: (seconds: number) => void;
  setZoom: (pxPerSec: number) => void;
  setTrackScale: (kind: "video" | "audio", factor: number) => void;
  beginGesture: () => void;
  endGesture: () => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  moveClip: (
    clipId: string,
    opts: {
      toTimelineIn?: number;
      toTrack?: string;
      /** Alt+drag: leave the original and place a COPY at the target. */
      duplicate?: boolean;
      /** Alt: act on this clip alone, leaving its link partner where it is. */
      ignoreLinks?: boolean;
    },
  ) => Promise<void>;
  trimClip: (
    clipId: string,
    edges: { source_in?: number; source_out?: number; timeline_in?: number; timeline_out?: number },
  ) => Promise<void>;
  /** Shift the selection by whole frames, stopping at frame 0 (Alt+arrow). */
  nudgeClips: (ids: string[], delta: number) => Promise<void>;
  /** Drag of a multi-clip selection: one delta, one undo entry, refused rather than overwriting. */
  moveSelectionBy: (ids: string[], delta: number) => Promise<void>;
  /** Enable/disable clips (Shift+E): they keep their place but neither draw nor sound. */
  setClipEnabled: (ids: string[], enabled: boolean) => Promise<void>;
  /** Trim one edge to the playhead (Q / W); refused when the playhead is outside the clip. */
  trimToPlayhead: (clipId: string, edge: "head" | "tail") => Promise<void>;
  /** Trim an edge AND close the gap, so everything after it follows (Shift+drag). */
  rippleTrim: (clipId: string, edge: "head" | "tail", toFrame: number) => Promise<void>;
  /** Move the cut shared by two abutting clips; `leftClipId` is the OUTGOING one (Ctrl+drag). */
  rollEdit: (leftClipId: string, toFrame: number) => Promise<void>;
  /** Move the source window under a fixed footprint (Alt+drag the body). */
  slipClip: (clipId: string, delta: number) => Promise<void>;
  /** Move a clip between its neighbours, which absorb it (Ctrl+Alt+drag the body). */
  slideClip: (clipId: string, delta: number) => Promise<void>;
  /** Real length of the clip's source in project frames; null when unbounded (a still)
   *  or unprobeable. Lets a drag stop at the end of the footage instead of promising a
   *  length the commit will then clamp away. */
  clipSourceFrames: (clipId: string) => Promise<number | null>;
  splitClip: (clipId: string, atFrame: number) => Promise<void>;
  deleteClips: (ids: string[]) => Promise<void>;
  rippleDeleteClip: (clipId: string) => Promise<void>;
  duplicateClip: (clipId: string) => Promise<void>;
  linkClips: (ids: string[]) => Promise<void>;
  unlinkClips: (ids: string[]) => Promise<void>;
  copyClip: (clipId: string) => void;
  pasteClip: (atFrame?: number) => Promise<void>;
  setClipProperties: (clipId: string, properties: Record<string, unknown>) => Promise<void>;
  /** Add or move ONE keyframe on any animatable property — the single door for the Inspector's
   *  stopwatch, the keyframe lane, and the volume rubber band on the clip, so the three can never
   *  disagree about clamping or about what a move does. `at`/`fromT` are CLIP-RELATIVE frames;
   *  `fromT` is the key being dragged, so a move replaces rather than accumulates. */
  setKeyframe: (
    clipId: string,
    path: string,
    at: number,
    value: number,
    opts?: { fromT?: number; ease?: string },
  ) => Promise<void>;
  setTransition: (
    clipId: string,
    transition: { kind: string; duration: number; expr?: string } | null,
  ) => Promise<void>;
  setCanvas: (patch: { width?: number; height?: number; fps?: number }) => Promise<void>;
  addClip: (source: string, trackId: string | undefined, atFrame: number) => Promise<void>;
  /** Place several sources end to end as ONE undoable intent (a multi-file drop). */
  addClips: (sources: string[], trackId: string | undefined, atFrame: number) => Promise<void>;
  /** Generate a poster + (when the codec isn't web-decodable) an H.264 preview proxy. */
  processImport: (relSource: string) => Promise<void>;
  addTrack: (kind: "video" | "audio" | "text") => Promise<void>;
  removeTrack: (trackId: string) => Promise<void>;
  setTrack: (
    trackId: string,
    patch: {
      mute?: boolean;
      hidden?: boolean;
      sync_locked?: boolean;
      locked?: boolean;
      solo?: boolean;
      z?: number;
    },
  ) => Promise<void>;
  /** Patch SEVERAL tracks as ONE undoable action — a restack that touches N tracks must
   *  not cost N presses of Ctrl+Z. */
  setTracks: (
    patches: Array<{
      trackId: string;
      mute?: boolean;
      hidden?: boolean;
      sync_locked?: boolean;
      locked?: boolean;
      solo?: boolean;
      z?: number;
    }>,
  ) => Promise<void>;
  dispose: () => void;
}

/** Every clip-selection producer returns through here. A clip selection and a gap selection are
 *  mutually exclusive — Delete must have exactly one target — and this is the one place that
 *  rule lives. A new selection setter that skips it is a bug; the gap block in `editor.test.ts`
 *  pins the four producers that exist today. */
function clipSel<T extends object>(patch: T): T & { selectedGap: null } {
  return { ...patch, selectedGap: null };
}

/** All clip ids sharing `clipId`'s link group (incl. itself); a lone clip -> [clipId].
 *  Click-selection expands to the whole group so linked A/V clips select together. */
function linkGroupIds(timeline: Timeline | null, clipId: string): string[] {
  return linkGroupIdsOf(timeline, clipId);
}

/** Load the library catalog's human names (id -> filename) into state, so clip
 *  labels can show "interview.mov" for a clip whose media_ref is a bare id.
 *  `current` guards the commit: a slower refresh must not land on a project that
 *  superseded it. Failures are non-fatal — labels fall back to the raw ref. */
async function refreshMediaNames(
  store: ProjectStoreAccess,
  current: () => boolean,
  set: (partial: Partial<EditorState>) => void,
): Promise<void> {
  try {
    const names: Record<string, string> = {};
    const status: Record<string, string> = {};
    for (const c of await store.listClips()) {
      const id = String(c.id ?? "");
      if (!id) continue;
      const name =
        String(c.filename ?? "").trim() ||
        String(c.path ?? "")
          .split(/[\\/]/)
          .pop();
      if (name) names[id] = name;
      const st = typeof c.status === "string" ? c.status : "";
      if (st === "generating" || st === "failed") status[id] = st;
    }
    if (current()) set({ mediaNames: names, mediaStatus: status });
  } catch {
    /* catalog unreadable — labels fall back to the ref */
  }
}

// The store body, extracted so it can be instantiated per project (getEditorStore
// registry below) as well as via the current singleton. zustand binds set/get to
// EACH instance, so an op bound to project A's store can never mutate project B's.
const editorCreator: StateCreator<EditorState> = (set, get) => {
  // Per-instance load counter: each project's store owns its own, so a slower load for
  // THIS store (an A->B->A re-activation of the same id) detects a newer load/dispose
  // superseded it, while NEVER superseding a DIFFERENT project's instance (registry
  // below). A bare projectId check can't tell two activations of one id apart (R6-3).
  let loadSeq = 0;
  return {
    projectId: null,
    store: null,
    timeline: null,
    selection: null,
    selectedIds: [],
    selectedGap: null,
    mediaTabs: [],
    activeMediaTab: null,
    selectedRange: null,
    playhead: 0,
    zoom: DEFAULT_ZOOM,
    trackScale: { video: 1, audio: 1 },
    loading: false,
    error: null,
    gestureActive: false,
    importing: false,
    dirty: false,
    clipboard: null,
    mediaNames: {},
    mediaStatus: {},
    refreshMedia: () => {
      const store = get().store;
      const pid = get().projectId;
      if (!store) return;
      void refreshMediaNames(store, () => get().projectId === pid, set);
      // Media that just landed was skipped by every earlier sweep (it had no file), so this is
      // its first chance at a proxy.
      void get()._index?.sweep(get().timeline);
    },
    _unsub: null,
    _pending: null,
    _index: null,

    load: async (projectId) => {
      const seq = ++loadSeq; // this activation's generation (see loadSeq above)
      get()._unsub?.();
      get()._index?.dispose();
      // Clear store + timeline at the START (not only at the commit below): projectId
      // flips to the new project synchronously here while the store/timeline build
      // async, and desktopStore()/consumers key off (projectId === id && store). Leaving
      // the OLD store mounted in that window let a still-mounted FileTree import into the
      // PREVIOUS project (Q1). Nulling them makes
      // desktopStore() return null until the new store commits, so a stray import
      // no-ops / takes the server path instead of hitting the wrong project's store.
      set({
        projectId,
        store: null,
        timeline: null,
        loading: true,
        error: null,
        selection: null,
        selectedIds: [],
        selectedGap: null,
        // Tabs address media through THIS project's store, so they cannot outlive it.
        mediaTabs: [],
        activeMediaTab: null,
        selectedRange: null,
        playhead: 0,
        dirty: false,
        mediaNames: {},
        mediaStatus: {},
        _unsub: null,
        _pending: null,
        _index: null,
      });
      try {
        const dir = await projectDirFor(projectId);
        // Open-awaits-close: if THIS project is mid-close, wait for its in-flight commits to drain
        // before reading/seeding, so a reopen never races the old session's still-committing edit
        // (whose starter seed would otherwise clobber it — data loss #1). A supersession during the
        // wait is caught by the final commit check below (which tears down what we built).
        await whenProjectIdle(dir);
        const store = await makeProjectStore(dir);
        // Do NOT swallow a load failure into an empty timeline: ensureStarterTimeline
        // seeds a starter ONLY when no file exists (a fresh project) and otherwise
        // THROWS on a malformed/unreadable existing file ("refusing to overwrite it").
        // Catching that here revealed a null workspace as success and let the agent
        // save over a recoverable file -- let it reach the outer catch -> "failed" (R6-4).
        // canWrite gates the seed write on THIS activation still being current (R7-2).
        const timeline = await ensureStarterTimeline(store, { canWrite: () => loadSeq === seq });
        const index = new IndexCoordinator(
          store,
          () => makeRunner(),
          () => {
            const cur = get().timeline;
            if (cur) set({ timeline: { ...cur } });
          },
          (v) => set({ importing: v }),
        );
        // React to every subsequent write (manual OR AI) to this project's timeline.
        const unsub = onTimelineChange((tl, change) => {
          if (get().projectId !== projectId) return; // stale subscription
          if (change.projectDir && change.projectDir !== dir) return; // another project's write
          // A persistence-only signal (autosave completed/failed): update the Unsaved flag only.
          if (change.source === "saved" || change.source === "save-failed") {
            set({ dirty: change.dirty ?? false });
            return;
          }
          void index.sweep(tl); // agent/manual added or moved media -> preview proxy
          const dirty = change.dirty ?? false;
          if (get().gestureActive) {
            set({ _pending: tl, dirty }); // don't clobber an in-progress drag
            return;
          }
          set({ timeline: tl, dirty });
        });
        // Media imported WITHOUT touching the timeline (file menu / FileTree / chat
        // attach / paste) fires "artdaddy:files-changed"; re-sweep so the new library
        // asset gets its proxy right away instead of on the next reload.
        const onFilesChanged = () => {
          if (get().projectId !== projectId) return;
          void index.sweep(get().timeline);
          void refreshMediaNames(store, () => get().projectId === projectId, set);
        };
        try {
          window.addEventListener("artdaddy:files-changed", onFilesChanged);
        } catch {
          /* non-DOM env (tests) */
        }
        const unsubAll = () => {
          unsub();
          try {
            window.removeEventListener("artdaddy:files-changed", onFilesChanged);
          } catch {
            /* non-DOM */
          }
        };
        // A slower load() for a DIFFERENT project must not win the commit race: while
        // we built this project's store/timeline off disk, a newer load() may have
        // taken over (projectId now points elsewhere). Committing here would bind the
        // CURRENT project's id to THIS stale project's store + timeline — every edit
        // and save would then land on the wrong project. Tear down what we built and
        // bail so the winning load owns the state (same currency check as the
        // timeline subscription above, applied to the final commit). We compare the
        // monotonic generation, not just the id, so this ALSO catches an A->B->A
        // re-activation where a bare id check couldn't tell the stale load apart (R6-3).
        if (loadSeq !== seq) {
          unsubAll();
          index.dispose();
          return "superseded";
        }
        set({ store, timeline, loading: false, _unsub: unsubAll, _index: index });
        if (timeline) void index.sweep(timeline);
        void refreshMediaNames(store, () => loadSeq === seq, set);
        return "loaded";
      } catch (e) {
        // A stale load's failure must not write its error onto the project that
        // superseded it either (same generation check as the commit above).
        if (loadSeq !== seq) return "superseded";
        set({ error: String(e), loading: false });
        return "failed";
      }
    },

    reload: async () => {
      const { store } = get();
      if (!store) return;
      const seq = loadSeq; // pin THIS activation; a switch/dispose retires this reload
      try {
        const timeline = await loadTimeline(store);
        if (loadSeq !== seq) return; // a newer load()/dispose() took over -> don't install onto its store (R7-2)
        set({ timeline });
        void get()._index?.sweep(timeline);
      } catch (e) {
        if (loadSeq !== seq) return;
        set({ error: String(e) });
      }
    },

    select: (clipId, opts) =>
      set((s) => {
        if (clipId === null) return clipSel({ selection: null, selectedIds: [] });
        const group = linkGroupIds(s.timeline, clipId); // linked clips select as a unit
        if (opts?.additive) {
          const has = s.selectedIds.includes(clipId);
          const ids = has
            ? s.selectedIds.filter((i) => !group.includes(i))
            : [...s.selectedIds, ...group.filter((i) => !s.selectedIds.includes(i))];
          return clipSel({
            selectedIds: ids,
            selection: has ? (ids[ids.length - 1] ?? null) : clipId,
          });
        }
        return clipSel({ selection: clipId, selectedIds: group });
      }),
    selectAll: () =>
      set((s) => {
        const ids: string[] = [];
        for (const t of s.timeline?.tracks ?? [])
          for (const c of t.clips ?? []) if (c.id) ids.push(String(c.id));
        return clipSel({ selectedIds: ids, selection: ids.length ? ids[ids.length - 1] : null });
      }),
    selectMany: (ids) =>
      set((s) => {
        const out: string[] = [];
        for (const id of ids)
          for (const g of linkGroupIds(s.timeline, id)) if (!out.includes(g)) out.push(g);
        return clipSel({ selectedIds: out, selection: out.length ? out[out.length - 1] : null });
      }),
    selectForward: (scope) =>
      set((s) => {
        const anchor = s.selection;
        if (!anchor) return {};
        let from = -1;
        let onTrack: string | null = null;
        for (const t of s.timeline?.tracks ?? [])
          for (const c of t.clips ?? [])
            if (String(c.id) === anchor) {
              from = Number(c.timeline_in) || 0;
              onTrack = String(t.id);
            }
        if (onTrack === null) return {};
        const out: string[] = [];
        for (const t of s.timeline?.tracks ?? []) {
          if (scope === "track" && String(t.id) !== onTrack) continue;
          for (const c of t.clips ?? [])
            if (c.id && (Number(c.timeline_in) || 0) >= from) out.push(String(c.id));
        }
        return clipSel({ selectedIds: out, selection: out.length ? out[out.length - 1] : anchor });
      }),
    selectGap: (trackId, frame) =>
      set((s) => {
        const g = gapAt(s.timeline, trackId, frame);
        // Off a gap this is just "you clicked empty lane": deselect everything, which is what
        // the plain-click-clears-the-selection rule already required of this path.
        if (!g) return clipSel({ selection: null, selectedIds: [] });
        return { selectedGap: { trackId, atFrame: frame }, selection: null, selectedIds: [] };
      }),
    setPlayhead: (seconds) => set({ playhead: Math.max(0, seconds) }),
    openMediaTab: (ref, opts) =>
      set((s) => {
        const pin = opts?.pin ?? false;
        const at = s.mediaTabs.findIndex((t) => t.ref === ref);
        if (at >= 0)
          return {
            activeMediaTab: ref,
            mediaTabs: pin
              ? s.mediaTabs.map((t, i) => (i === at ? { ref, transient: false } : t))
              : s.mediaTabs,
          };
        const slot = pin ? -1 : s.mediaTabs.findIndex((t) => t.transient);
        const tab = { ref, transient: !pin };
        return {
          activeMediaTab: ref,
          mediaTabs:
            slot >= 0 ? s.mediaTabs.map((t, i) => (i === slot ? tab : t)) : [...s.mediaTabs, tab],
        };
      }),
    closeMediaTab: (ref) =>
      set((s) => {
        const at = s.mediaTabs.findIndex((t) => t.ref === ref);
        if (at < 0) return {};
        const mediaTabs = s.mediaTabs.filter((t) => t.ref !== ref);
        if (s.activeMediaTab !== ref) return { mediaTabs };
        // Closing what you are looking at lands on the right neighbour, else the left,
        // else the live preview -- never on nothing.
        const next = mediaTabs[at] ?? mediaTabs[at - 1];
        return { mediaTabs, activeMediaTab: next?.ref ?? null };
      }),
    setActiveMediaTab: (ref) =>
      set((s) => (ref && !s.mediaTabs.some((t) => t.ref === ref) ? {} : { activeMediaTab: ref })),
    setSelectedRange: (range) =>
      set(() => {
        if (!range) return { selectedRange: null };
        const a = Math.max(0, Math.round(Math.min(range.startFrame, range.endFrame)));
        const b = Math.max(a, Math.round(Math.max(range.startFrame, range.endFrame)));
        return { selectedRange: b > a ? { startFrame: a, endFrame: b } : null };
      }),
    setZoom: (pxPerSec) => set({ zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pxPerSec)) }),
    setTrackScale: (kind, factor) =>
      set((s) => ({ trackScale: { ...s.trackScale, [kind]: Math.min(3, Math.max(0.5, factor)) } })),

    beginGesture: () => set({ gestureActive: true }),
    endGesture: () => {
      const pending = get()._pending;
      set({ gestureActive: false, _pending: null, ...(pending ? { timeline: pending } : {}) });
    },

    // Undo/redo route through the shared engine; the resulting write emits on the
    // bus, so the subscriber above refreshes `timeline` — no manual reload needed.
    undo: async () => {
      const { store } = get();
      if (store) await doUndo(store);
    },
    redo: async () => {
      const { store } = get();
      if (store) await doRedo(store);
    },

    ...makeEditorCommands(get, set, () => makeRunner()),

    dispose: () => {
      loadSeq++; // retire any in-flight load()/reload() so it can't reinstall its store/index after teardown (R7-2)
      const prev = get().store;
      if (prev) void closeProjectSession(prev.projectDir); // end the editing session (bump the session gen + drop undo stacks synchronously; drain in the background) so a reopen starts fresh and no commit races the close (R11 f/u #10)
      get()._unsub?.();
      get()._index?.dispose();
      set({
        projectId: null,
        store: null,
        timeline: null,
        selection: null,
        selectedIds: [],
        selectedGap: null,
        selectedRange: null,
        playhead: 0,
        zoom: DEFAULT_ZOOM,
        loading: false,
        error: null,
        gestureActive: false,
        clipboard: null,
        _unsub: null,
        _pending: null,
        _index: null,
      });
    },
  };
};

// ---- Per-project instance registry (other NLEs's per-document model) ----------
// One editor store instance per open project, resolved by id -- mirrors the
// coordinator's projectSessions and the engine's editorHistory. An op that must
// target a SPECIFIC project (e.g. a chat undo spanning an await during which the
// user switches projects) resolves its instance here by the projectId captured at
// submission, so its set() lands on that project's store and can never corrupt
// whichever project happens to be active on completion.
const editorStores = new Map<string, StoreApi<EditorState>>();

/** Get (or lazily create) the editor store instance bound to `projectId`. */
export function getEditorStore(projectId: string): StoreApi<EditorState> {
  let s = editorStores.get(projectId);
  if (!s) {
    s = createStore<EditorState>(editorCreator);
    editorStores.set(projectId, s);
  }
  return s;
}

/** Drop a project's editor store instance (called when the project is closed). */
export function disposeEditorStore(projectId: string): void {
  const s = editorStores.get(projectId);
  if (!s) return;
  s.getState().dispose(); // ends the editing session (drain) + clears the instance
  editorStores.delete(projectId);
}

// ---- The active-project pointer ("frontmost document") ---------------------
// Holds ONLY the active project id, not a copy of its state. The UI resolves the
// ACTUAL instance from the registry (getEditorStore) and reads it directly, so there
// is no writable state mirror to drift. A tiny id store makes the resolution reactive:
// every consumer -- including always-mounted ones (menu bar, file tree) above the
// routed panes -- re-renders when the active project changes. With no project active
// (the no-project route, unit tests) reads fall back to a standalone empty store, so
// imperative callers keep the previous behavior.
const activeEditorId = createStore<{ id: string | null }>(() => ({ id: null }));
const defaultEditorStore = createStore<EditorState>(editorCreator);
let editorBridgeUnsub: (() => void) | null = null;

function activeEditorStore(): StoreApi<EditorState> {
  const id = activeEditorId.getState().id;
  return id ? getEditorStore(id) : defaultEditorStore;
}

// Bridge the live playhead + selection into the tool runtime so get_timeline can report
// where the user is looking (other NLEs' currentFrame). Re-pointed at the active instance
// on every switch (below), so it tracks the frontmost project without a state mirror.
function pushEditorSnapshot(s: EditorState): void {
  const fps = s.timeline ? canvasFps(s.timeline) : 30;
  setEditorContextSnapshot({
    playheadFrame: s.timeline ? Math.max(0, Math.round(s.playhead * fps)) : null,
    selectedClipIds: s.selectedIds,
    selectedRange: s.selectedRange,
    selectedGap: s.selectedGap,
  });
}

/** Point the UI + tool runtime at project `id`'s editor instance (or clear it). */
function setActiveEditor(id: string | null): void {
  activeEditorId.setState({ id });
  editorBridgeUnsub?.();
  const store = id ? getEditorStore(id) : null;
  editorBridgeUnsub = store ? store.subscribe(pushEditorSnapshot) : null;
  pushEditorSnapshot((store ?? defaultEditorStore).getState());
}

function useEditorHook<T>(selector: (s: EditorState) => T): T {
  // Re-render when the active project changes (the id store) AND track its instance.
  const id = useStore(activeEditorId, (s) => s.id);
  return useStore(id ? getEditorStore(id) : defaultEditorStore, selector);
}
type EditorSetState = StoreApi<EditorState>["setState"];
/** The active-project editor view: `useEditor(sel)` subscribes reactively;
 *  `useEditor.getState()/.setState()` read/write the ACTUAL active instance (not a mirror). */
export const useEditor = Object.assign(useEditorHook, {
  getState: (): EditorState => activeEditorStore().getState(),
  setState: ((...args: Parameters<EditorSetState>) =>
    (activeEditorStore().setState as (...a: Parameters<EditorSetState>) => void)(
      ...args,
    )) as EditorSetState,
});

/** Make `projectId` the active project: point the view at its instance and load its
 *  timeline. Returns the load outcome (Shell reveals the panes on "loaded"). */
export function activateEditorProject(
  projectId: string,
): Promise<"loaded" | "superseded" | "failed"> {
  setActiveEditor(projectId);
  return getEditorStore(projectId).getState().load(projectId);
}

/** Leave `projectId`: clear the active-project pointer and dispose its instance so a
 *  reopen starts fresh (ends the editing session -> no commit races the close). */
export function deactivateEditorProject(projectId: string | null): void {
  setActiveEditor(null);
  if (projectId) disposeEditorStore(projectId);
}

export const _zoomBounds = { MIN_ZOOM, MAX_ZOOM, DEFAULT_ZOOM };
