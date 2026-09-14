// In-process pub/sub for timeline.json writes. Every write through the engine
// (applyOp / undo / redo / seed) publishes here, so the editor store and the
// live preview react instantly to BOTH manual and AI edits — the multi-writer,
// single-webview analogue of an in-process observable document (how a native NLE
// like other NLEs gets "free" live updates). A Tauri fs watcher is layered on top
// only as a fallback for writes that don't originate in this webview.
import type { Timeline } from "./model";

export interface TimelineChange {
  /** Where the write came from (diagnostic only): "engine", "watcher", "saved", "save-failed". */
  source: string;
  /** Absolute project dir of the timeline that changed (for multi-project safety). */
  projectDir?: string;
  /** Whether the in-memory timeline has un-persisted edits AFTER this notification (Phase 5.6): an
   *  edit sets it true, a completed autosave false, a failed autosave leaves it true (Unsaved).
   *  Undefined for emitters that don't track persistence (the sync fallback + bus.test). */
  dirty?: boolean;
}

export type TimelineListener = (timeline: Timeline, change: TimelineChange) => void;

const listeners = new Set<TimelineListener>();

/** Subscribe to timeline writes. Returns an unsubscribe function. */
export function onTimelineChange(fn: TimelineListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Publish a timeline write to every subscriber. A throwing subscriber is
 *  isolated so it can't break the others or the write that triggered it. */
export function emitTimelineChange(
  timeline: Timeline,
  source = "engine",
  projectDir?: string,
  dirty?: boolean,
): void {
  const change: TimelineChange = { source, projectDir, dirty };
  for (const fn of [...listeners]) {
    try {
      fn(timeline, change);
    } catch {
      /* isolate subscriber errors */
    }
  }
}

/** Test helper: drop all subscribers. */
export function _resetTimelineBus(): void {
  listeners.clear();
}
