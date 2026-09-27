// A media element's play() returns a promise that rejects for two very different reasons, and
// both were being dropped with `void` — which discards the VALUE, not the rejection. Every one
// became an unhandledrejection, reported to Sentry as a crash. One user generated 24 in a
// single session simply by clicking play on footage the webview could not decode.
import { reportAppError } from "../api/appEvents";

/** Play was superseded by a pause/seek/source change. Routine, and not worth a word. */
function isInterrupted(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

// The element genuinely cannot play the file. The user can see that nothing happened, so this
// needs no dialog — but it must not be silent to US or a codec we never decode looks like a
// user who simply did not press play. Once per session: a run of identical failures answers
// the same question the first one did.
let reportedUnsupported = false;

/** Handle a rejected `play()`. Never rethrows: the UI is already in the paused state that a
 *  failed play leaves behind. */
export function ignorePlayRejection(err: unknown): void {
  if (isInterrupted(err)) return;
  if (reportedUnsupported) return;
  reportedUnsupported = true;
  reportAppError(`media playback refused: ${String(err).slice(-160)}`);
}

/** Test hook: forget that we already reported an unsupported source. */
export function __resetPlayRejection(): void {
  reportedUnsupported = false;
}
