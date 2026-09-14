// A tiny bridge carrying the LIVE manual-editor UI state (playhead + selection)
// into the tool runtime, so get_timeline can report where the user is looking
// (mirrors other NLEs' get_timeline.currentFrame) WITHOUT the tool layer importing
// the UI store. The editor store pushes a snapshot whenever it changes; the
// get_timeline tool reads the latest. Both sides depend only on this leaf.
export interface EditorContextSnapshot {
  /** Playhead position in PROJECT FRAMES, or null when no project is open. */
  playheadFrame: number | null;
  /** Currently selected clip ids on the timeline. */
  selectedClipIds: string[];
  /** Half-open [startFrame, endFrame) range the user marked on the ruler, if any. */
  selectedRange: { startFrame: number; endFrame: number } | null;
  /** The empty space the user clicked, carried as the editor stores it: a POINT. Resolved to a
   *  span against the CURRENT timeline at read time, so an edit that filled the gap reports no
   *  gap rather than a span that now points at material. */
  selectedGap: { trackId: string; atFrame: number } | null;
}

const EMPTY: EditorContextSnapshot = {
  playheadFrame: null,
  selectedClipIds: [],
  selectedRange: null,
  selectedGap: null,
};

let snapshot: EditorContextSnapshot = EMPTY;

export function setEditorContextSnapshot(next: EditorContextSnapshot): void {
  snapshot = next;
}
export function getEditorContextSnapshot(): EditorContextSnapshot {
  return snapshot;
}
/** Test hook: reset to the empty snapshot so suites don't leak state. */
export function resetEditorContextSnapshot(): void {
  snapshot = EMPTY;
}
