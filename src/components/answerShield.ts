import { useCallback, useRef } from "react";

/** How long after an answer the next one from the same place is ignored. */
export const ANSWER_SHIELD_MS = 400;

/** A double-click on an answer must not also answer the next question, which appears under the cursor the
 *  moment the first is answered. A person's answers from one place (a dialog, a card) wrap in the guard it
 *  returns; the first goes through, and any that follows within {@link ANSWER_SHIELD_MS} is dropped. An
 *  assistant's answer never passes through here. */
export function useAnswerShield(): (act: () => void) => void {
  const last = useRef(0);
  return useCallback((act: () => void) => {
    const now = Date.now();
    // A clock that stepped backwards (a time sync, waking from sleep) makes the gap negative: that is not
    // "just now", and must not swallow a person's answers until the clock catches up.
    const gap = now - last.current;
    if (gap >= 0 && gap < ANSWER_SHIELD_MS) return;
    last.current = now;
    act();
  }, []);
}
