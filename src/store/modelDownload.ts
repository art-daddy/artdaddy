// The speech model downloading, on screen.
//
// The model is 465 MiB and installs once per machine. Downloading it silently is what cost us a
// user: the first `get_transcript` sat for 2m21s with no output, he cancelled, and the tool
// reported "transcription cancelled" — a message that describes neither what was happening nor
// that it would have finished. Every path that can trigger the download reports through here, so
// there is exactly one place the UI has to read and exactly one message to keep honest.
import { create } from "zustand";

import type { ModelFailureKind } from "../tools/modelFailure";

interface ModelDownloadState {
  /** Bytes on disk so far, including anything a previous attempt already fetched. */
  received: number;
  /** Total bytes of the pinned model, 0 when nothing is downloading. */
  total: number;
  /** When this download's first report came (ms), and the bytes it already had then: the speed
   *  is what arrived SINCE, not what an earlier attempt left on disk. */
  startedAt: number;
  startReceived: number;
}

interface ModelDownloadStore extends ModelDownloadState {
  /** Stops the download, whoever is waiting for it; set while one is under way. */
  cancel: (() => void) | null;
  /** Why the last download failed for good, until the person dismisses it or a new attempt begins.
   *  Never held together with a download under way: `report` ends it. */
  failure: ModelFailureKind | null;
  /** The manifest key of the file whose download failed: the card's Retry asks for THAT file, not for what the
   *  plan names now. Lives and dies with `failure`. */
  failureKey: string | null;
  /** The download under way is not this PC's first speech model: another model file is already here, so the words
   *  about "the first time you start the app" would be untrue of it. False when nothing is downloading. */
  again: boolean;
  /** When the app tries again by itself (ms since the epoch); null when no round is scheduled. */
  nextAttemptAt: number | null;
  /** `again` left out: unchanged. */
  report: (received: number, total: number, again?: boolean) => void;
  setCancel: (cancel: (() => void) | null) => void;
  setFailure: (failure: ModelFailureKind | null, key?: string | null) => void;
  setAgain: (again: boolean) => void;
  setNextAttemptAt: (at: number | null) => void;
  clear: () => void;
}

export const useModelDownload = create<ModelDownloadStore>((set) => ({
  received: 0,
  total: 0,
  startedAt: 0,
  startReceived: 0,
  cancel: null,
  failure: null,
  failureKey: null,
  again: false,
  nextAttemptAt: null,
  // A report is a download beginning or moving, so a failure and a scheduled round are over.
  report: (received, total, again) =>
    set((s) => ({
      ...(s.total > 0
        ? { received, total }
        : { received, total, startedAt: Date.now(), startReceived: received }),
      ...(again === undefined ? undefined : { again }),
      ...(s.failure !== null || s.nextAttemptAt !== null
        ? { failure: null, failureKey: null, nextAttemptAt: null }
        : undefined),
    })),
  setCancel: (cancel) => set({ cancel }),
  setFailure: (failure, key = null) => set({ failure, failureKey: failure === null ? null : key }),
  setAgain: (again) => set({ again }),
  setNextAttemptAt: (nextAttemptAt) => set({ nextAttemptAt }),
  // What stays: the failure and the next round. The download ending is exactly when they matter.
  clear: () =>
    set({ received: 0, total: 0, startedAt: 0, startReceived: 0, cancel: null, again: false }),
}));

export function reportModelDownload(received: number, total: number, again?: boolean): void {
  useModelDownload.getState().report(received, total, again);
}

/** Say how the download under way is stopped (the person pressed Cancel). Cleared with it. */
export function setModelDownloadCancel(cancel: (() => void) | null): void {
  useModelDownload.getState().setCancel(cancel);
}

export function clearModelDownload(): void {
  useModelDownload.getState().clear();
}

/** Say why a download failed for good, and which file it was (null: nothing failed, or the person dismissed it). */
export function setModelDownloadFailure(
  failure: ModelFailureKind | null,
  key: string | null = null,
): void {
  useModelDownload.getState().setFailure(failure, key);
}

/** Say whether the download under way is a second model file (another one is already on this PC). */
export function setModelDownloadAgain(again: boolean): void {
  useModelDownload.getState().setAgain(again);
}

/** Say when the next round starts by itself (null: none is scheduled). */
export function setModelNextAttemptAt(at: number | null): void {
  useModelDownload.getState().setNextAttemptAt(at);
}

/** Whole MiB, which is the unit the 465 MiB model is actually sized in — dividing by 1e6
 *  would announce a 488 MB download of a file every other tool calls 465 MB. */
export function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

export function percent(received: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.min(100, Math.max(0, Math.floor((received / total) * 100)));
}

/** Seconds the rest of the download takes at the speed it has had so far, or null while there is
 *  nothing to measure yet (under 2 s in, or no byte since it began). */
export function downloadEtaSeconds(s: ModelDownloadState, now = Date.now()): number | null {
  const elapsed = (now - s.startedAt) / 1000;
  const fetched = s.received - s.startReceived;
  if (!(s.total > 0) || !(elapsed >= 2) || !(fetched > 0)) return null;
  return Math.max(0, Math.ceil((s.total - s.received) / (fetched / elapsed)));
}

/** "about 40 s", "about 12 min", "about 2 h": how long is left, in the unit a person would say it
 *  in. Rounds up, so the figure is never shorter than the wait. */
export function formatEta(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 90) return `about ${s} s`;
  const min = Math.ceil(s / 60);
  if (min < 90) return `about ${min} min`;
  return `about ${Math.ceil(min / 60)} h`;
}

/** What the person is told about this download, in the words the owner chose (2026-11-01). The
 *  second sentence is part of the message: a 465 MB download that appears on its own needs it. */
export const MODEL_DOWNLOAD_NOTE = "This only happens when you start the app for the first time.";

/** The same, for a download that is not this PC's first speech model (another model file is already here): "the
 *  first time you start the app" would be untrue of it. */
export const MODEL_DOWNLOAD_NOTE_AGAIN = "This only happens once.";

/** The note for the download under way: `again` is the store's flag for a second model file. */
export function modelDownloadNote(again = false): string {
  return again ? MODEL_DOWNLOAD_NOTE_AGAIN : MODEL_DOWNLOAD_NOTE;
}

/** The one user-facing line for this download: what it is, how big, how far, and how long is
 *  left once that can be told. */
export function modelDownloadMessage(
  received: number,
  total: number,
  etaSeconds: number | null = null,
  again = false,
): string {
  const left = etaSeconds === null ? "" : `, ${formatEta(etaSeconds)} left`;
  const what = again
    ? `another speech model (about ${megabytes(total)} MB)`
    : `the speech model (one time, about ${megabytes(total)} MB)`;
  return `Downloading ${what} - ${percent(received, total)}%${left}`;
}
