// The client's error convention: THROW typed errors internally; CONVERT them to a
// clean outcome/message at each user-facing boundary. This module is the canonical
// statement of that convention.
//
// Whether an error is a normal, HANDLED control-flow signal (a rate/credit limit, a
// mutation-gate rejection) rather than a Sentry-worthy crash is a property OF the error
// — `expected` — so a new typed error self-classifies and no boundary has to keep a
// list in sync. `isExpected` is the single predicate every REPORT boundary uses, so the
// Sentry-skip set can never drift from what each error declares about itself.

/** Base class for every typed error the client throws. */
export abstract class ArtDaddyError extends Error {
  /** Stable machine code for logs/telemetry. NEVER shown raw to a user. */
  abstract readonly code: string;
  /** True for a handled, control-flow error that a boundary converts to a clean
   *  outcome — NOT a crash — so it is not reported to Sentry. Defaults to false: an
   *  unrecognised throw is unexpected and IS reported. */
  readonly expected: boolean = false;
  /** The human-facing sentence for this error. Defaults to `message` — our typed
   *  errors carry user-facing text — but a subclass whose `message` is technical
   *  (ApiError's raw server detail) overrides it. Read it via `toUserMessage`. */
  get userMessage(): string {
    return this.message;
  }
}

/** The single "is this a handled control-flow error?" predicate. Doubles as a type
 *  guard so a boundary can read `err.message` after the check. Only ArtDaddyError
 *  subclasses that declare `expected = true` pass. */
export function isExpected(err: unknown): err is ArtDaddyError {
  return err instanceof ArtDaddyError && err.expected;
}

/** Convert ANY thrown value into a clean sentence to show a human — the PRESENTATION
 *  half of the convention (internal code throws typed errors; a user-facing boundary
 *  calls this so a person never sees a raw `TypeError: Failed to fetch` or a server
 *  detail). Typed errors supply their own `userMessage`; a fetch/network failure maps
 *  to a connectivity line; anything else falls back to a generic apology. */
export function toUserMessage(err: unknown): string {
  if (err instanceof ArtDaddyError) return err.userMessage;
  if (err instanceof TypeError && /fetch|network|load failed/i.test(err.message))
    return "Couldn't reach the server. Check your connection and try again.";
  return "Something went wrong. Please try again.";
}
