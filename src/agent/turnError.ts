// Naming a turn's failure: the code the person was shown, and the id of the call that failed.
import { reportTurnError } from "../api/appEvents";
import { isExpected } from "../lib/errors";
import { noteFailure } from "../observability/recentFailures";

/** The code for a failure that ENDED a turn by throwing. Typed errors carry their own; an HTTP failure is `http_<status>`;
 *  a dropped connection is `network`; anything nobody recognised is `unexpected`, never blank. By name for the round
 *  deadline, so this does not depend on the module that defines it. */
export function turnErrorCode(error: unknown): string {
  if (isExpected(error)) return error.code;
  if ((error as { name?: unknown } | null)?.name === "RoundTimeoutError") return "round_timeout";
  const status = /^(\d{3}):/.exec(error instanceof Error ? error.message : "");
  if (status) return `http_${status[1]}`;
  if (error instanceof TypeError) return "network";
  return "unexpected";
}

/** The id of the call a thrown failure came from, when the round sender attached one. */
export function requestIdOf(error: unknown): string | undefined {
  const id = (error as { requestId?: unknown } | null)?.requestId;
  return typeof id === "string" && id ? id : undefined;
}

/** A turn ended in an error: keep it for a problem report and report it. A failure the HTTP layer already noted for the
 *  same request gains the code the turn knows. */
export function noteTurnError(code: string, requestId?: string): void {
  noteFailure({ where: "turn", code, requestId });
  reportTurnError(code, requestId);
}
