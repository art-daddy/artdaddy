import { ArtDaddyError } from "../lib/errors";

/** Raised by a timeline mutation to reject an op with a user-facing message.
 *  applyOp converts it into `{ ok: false, error }` and leaves timeline.json
 *  untouched. */
export class OpError extends ArtDaddyError {
  readonly code = "op";
}
