// When the server last ANSWERED this app, as far as the app saw. It exists for one honest sentence: "the server was asleep after a pause".
// A server that answered a minute ago is not asleep, so a slow reply from it is not a wake-up and the chat must not say so (components/waitStatus.ts).
//
// Only a few places write it, the ones every session passes through (the saved-session renewal, the build check, the start of an AI answer). A request that
// answered and was not recorded makes the app think the server has been quiet longer than it was, which can only cause a wrong "waking" claim on a slow
// answer, never hide a real one. In memory only; nothing about the person.
let lastAnsweredAt: number | null = null;

/** The server answered something (any status: a replica that says 503 is awake). */
export function noteServerAnswered(now: number = Date.now()): void {
  lastAnsweredAt = now;
}

/** How long the server has been quiet toward this app, or null when it has not answered in this run. */
export function serverQuietMs(now: number = Date.now()): number | null {
  return lastAnsweredAt === null ? null : Math.max(0, now - lastAnsweredAt);
}

/** Tests only: forget every answer. */
export function resetServerContact(): void {
  lastAnsweredAt = null;
}
