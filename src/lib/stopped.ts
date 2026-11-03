// What the person's Stop does to a call that is still running.
//
// Stop is the person's own action, so a call it ends is not a call that went wrong: the chat must not say
// "Couldn't ...", the tool-failure numbers must not count it, and error reporting must not hear about it.
// A call that Stop ended answers STOPPED_ERROR, and the telemetry carries the same word next to the turn's
// `stopped` outcome. Tools that notice the abort return it themselves; the loop answers it for the ones
// that throw.

/** The one word a call answers when Stop ended it. */
export const STOPPED_ERROR = "cancelled";

/** The answer of a call that Stop ended. */
export function stoppedAnswer(): { ok: false; error: typeof STOPPED_ERROR } {
  return { ok: false, error: STOPPED_ERROR };
}

/** Whether a call's answer is the one Stop makes. */
export function isStoppedAnswer(answer: unknown): boolean {
  return (
    typeof answer === "object" &&
    answer !== null &&
    (answer as { error?: unknown }).error === STOPPED_ERROR
  );
}

/** Whether what a tool threw is what being aborted looks like: an AbortError, or words that say so
 *  ("signal is aborted without reason", "The user aborted a request", "encode failed: cancelled").
 *  Only meaningful together with the turn's Stop flag: an abort nobody asked for is a failure. */
export function looksLikeAbort(thrown: unknown): boolean {
  if (
    typeof thrown === "object" &&
    thrown !== null &&
    (thrown as { name?: unknown }).name === "AbortError"
  )
    return true;
  const text = thrown instanceof Error ? thrown.message : String(thrown ?? "");
  return /abort|cancel/i.test(text);
}

/** Whether a call's answer is a failure that says it was aborted or cancelled: the marker itself, or the
 *  words an aborted request leaves behind ("signal is aborted without reason", "video_ask: The user
 *  aborted a request.", "encode for gemini failed: cancelled"). Most tools catch the abort themselves and
 *  answer this way, and the registry answers a thrown one the same way, so this is what Stop looks like
 *  where answers are recorded. Only meaningful together with the turn's Stop flag. */
export function isAbortFailure(answer: unknown): boolean {
  if (typeof answer !== "object" || answer === null) return false;
  const { ok, error } = answer as { ok?: unknown; error?: unknown };
  return ok !== true && typeof error === "string" && looksLikeAbort(error);
}
