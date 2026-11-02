// The one sentence the sign-in screen shows about the last attempt that did not finish (api/signInProblems.ts).
//
// Transient on purpose, and kept apart from the session store: it is about a browser hand-off, it is never saved,
// and it must disappear the moment the person starts again or signs in. AuthProvider sets it when a callback
// fails; the sign-in screen reads it.
import { create } from "zustand";

import { signInProblemText, type CallbackReason } from "../api/signInProblems";

/** A sentence older than this is not shown: it is about an attempt the person has long since left. (A pending
 *  attempt itself lives ten minutes.) */
export const NOTICE_FRESH_MS = 10 * 60_000;

interface SignInNoticeState {
  text: string | null;
  at: number;
  /** Remember that this callback failed. A reason there is nothing to say about changes nothing, so it can never
   *  wipe a sentence that is still true. */
  failed: (reason: CallbackReason | undefined) => void;
  clear: () => void;
}

export const useSignInNotice = create<SignInNoticeState>((set) => ({
  text: null,
  at: 0,
  failed: (reason) => {
    const text = signInProblemText(reason);
    if (text) set({ text, at: Date.now() });
  },
  clear: () => set({ text: null, at: 0 }),
}));

/** What to show right now: the sentence, if there is one and it is still about the last try. */
export function freshSignInNotice(state: Pick<SignInNoticeState, "text" | "at">): string | null {
  return state.text !== null && Date.now() - state.at < NOTICE_FRESH_MS ? state.text : null;
}
