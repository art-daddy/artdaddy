// The speech model downloading, on screen.
//
// The model is 465 MiB and installs once per machine. Downloading it silently is what cost us a
// user: the first `get_transcript` sat for 2m21s with no output, he cancelled, and the tool
// reported "transcription cancelled" — a message that describes neither what was happening nor
// that it would have finished. Every path that can trigger the download reports through here, so
// there is exactly one place the UI has to read and exactly one message to keep honest.
import { create } from "zustand";

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
  report: (received: number, total: number) => void;
  clear: () => void;
}

export const useModelDownload = create<ModelDownloadStore>((set) => ({
  received: 0,
  total: 0,
  startedAt: 0,
  startReceived: 0,
  report: (received, total) =>
    set((s) =>
      s.total > 0
        ? { received, total }
        : { received, total, startedAt: Date.now(), startReceived: received },
    ),
  clear: () => set({ received: 0, total: 0, startedAt: 0, startReceived: 0 }),
}));

export function reportModelDownload(received: number, total: number): void {
  useModelDownload.getState().report(received, total);
}

export function clearModelDownload(): void {
  useModelDownload.getState().clear();
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

/** The one user-facing sentence for this download. Shared by the progress line and by the
 *  cancellation error, so what the tool says afterwards matches what the user was reading. */
export function modelDownloadMessage(received: number, total: number): string {
  return (
    `downloading speech model - this only happens the first time post install, ` +
    `${megabytes(total)} MB, ${percent(received, total)}%`
  );
}
