import { ArtDaddyError } from "../lib/errors";

/** Raised by a timeline mutation to reject an op with a user-facing message.
 *  applyOp converts it into `{ ok: false, error }` and leaves the timeline
 *  untouched. */
export class OpError extends ArtDaddyError {
  readonly code = "op";
}

/** What the model is told when the project's timeline cannot be read: a damaged or missing record,
 *  which nothing it can call repairs. It names no file. The model has no tool that reads or writes
 *  one, and a name is an invitation to go looking (it did: `read_file` on a guessed `timeline.json`,
 *  five times), so the text says what is wrong and who can fix it. */
export function timelineUnreadable(detail: string): string {
  return `the project's timeline could not be read (${detail}). Nothing can be read or edited until it is repaired: tell the user, and don't try to rebuild it.`;
}
