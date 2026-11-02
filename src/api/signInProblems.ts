// What the person is told when the browser step finished and the app could not complete sign-in (T-20).
//
// Until now a callback that failed was thrown away: the screen stayed exactly as it was, with no word and nothing
// to do, which is the same dead end the sign-in page had from the other side. The reason a callback failed is the
// closed word it is already reported under (api/authEvents.ts), and this is what each one means to a person. It is
// a Record over those words, so adding a reason there without a sentence here does not compile.
//
// A sentence says what happened in plain words and what to press. It never carries the developer's message
// (which can hold an address or a reply from the server), a code, a status number or a name from the code.
import type { AuthReason } from "./authEvents";

export type CallbackReason = AuthReason<"callback">;

const AGAIN = "Press “Log in or sign up” to try again.";

/** `null`: say nothing. A link that was not a sign-in link is not a failed sign-in, and a sign-in the person
 *  cancelled themselves (by signing out or starting over) is not something to tell them about. */
export const SIGN_IN_PROBLEMS: Readonly<Record<CallbackReason, string | null>> = {
  no_attempt: `Sign-in didn't finish: ArtDaddy wasn't waiting for it, which can happen if it was started a while ago. ${AGAIN}`,
  unrecognized: null,
  missing_params: `Sign-in didn't finish: the link from the browser was incomplete. ${AGAIN}`,
  state_mismatch: `Sign-in didn't finish: that browser tab belonged to an earlier try. ${AGAIN} Finish in the tab it opens.`,
  exchange_network:
    "Sign-in didn't finish: ArtDaddy couldn't reach the server. Check your connection, then press “Log in or sign up” again.",
  exchange_rejected: `Sign-in didn't finish: the link had expired or was already used. ${AGAIN}`,
  exchange_server:
    "Sign-in didn't finish: the server had a problem. Wait a moment, then press “Log in or sign up” again.",
  exchange_unreadable:
    "Sign-in didn't finish: the server had a problem. Wait a moment, then press “Log in or sign up” again.",
  cancelled: null,
  not_saved: `You signed in, but ArtDaddy couldn't keep it on this computer. ${AGAIN}`,
  error: `Sign-in didn't finish because something went wrong. ${AGAIN}`,
};

/** The sentence for a failed callback, or null when there is nothing to say. */
export function signInProblemText(reason: CallbackReason | undefined): string | null {
  if (!reason || !Object.prototype.hasOwnProperty.call(SIGN_IN_PROBLEMS, reason)) return null;
  return SIGN_IN_PROBLEMS[reason];
}
