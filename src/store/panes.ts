// Which side panes are showing. other NLEs' rule, and the one worth copying: the media, inspector and
// agent panes can be hidden, but the preview and the timeline cannot — those two ARE the editor, and
// an editor you can hide leaves the user with an empty window and no obvious way back.
//
// Scope is GLOBAL, not per-project, matching the panel SIZES that `autoSaveId` already persists to
// localStorage. Two different scopes for two halves of the same layout is how a window ends up
// restoring at a size the user set in a different project.
import { create } from "zustand";

export type PaneId = "library" | "inspector" | "chat";

export const PANE_LABELS: Record<PaneId, string> = {
  library: "Library",
  inspector: "Inspector",
  chat: "Assistant",
};

const KEY = "artdaddy-panes-v1";
// The inspector starts CLOSED and is opened by selecting a clip (Shell drives it): with nothing
// selected it can only show canvas settings, which is not worth a permanent column of the window.
const DEFAULTS: Record<PaneId, boolean> = { library: true, inspector: false, chat: true };
const ALL: Record<PaneId, boolean> = { library: true, inspector: true, chat: true };

function load(): Record<PaneId, boolean> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const saved = JSON.parse(raw) as Partial<Record<PaneId, unknown>>;
    // Only accept known ids with boolean values, so a hand-edited or stale entry can't hide a pane
    // under a name the View menu no longer offers — that would be unrecoverable from the UI.
    const out = { ...DEFAULTS };
    for (const id of Object.keys(DEFAULTS) as PaneId[])
      if (typeof saved[id] === "boolean") out[id] = saved[id];
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

function save(visible: Record<PaneId, boolean>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(visible));
  } catch {
    /* private mode / quota — the layout just won't persist */
  }
}

interface PanesState {
  visible: Record<PaneId, boolean>;
  toggle: (id: PaneId) => void;
  setVisible: (id: PaneId, on: boolean) => void;
  /** View → Show All Panels: the recovery path, so it means ALL of them — including the
   *  inspector, which is not on by default. */
  showAll: () => void;
}

export const usePanes = create<PanesState>((set) => ({
  visible: load(),
  toggle: (id) =>
    set((s) => {
      const visible = { ...s.visible, [id]: !s.visible[id] };
      save(visible);
      return { visible };
    }),
  setVisible: (id, on) =>
    set((s) => {
      const visible = { ...s.visible, [id]: on };
      save(visible);
      return { visible };
    }),
  showAll: () => {
    save(ALL);
    return set({ visible: { ...ALL } });
  },
}));
