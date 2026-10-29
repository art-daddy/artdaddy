// The last few failures the person met, kept in memory so a problem report can say what had just gone wrong.
//
// A report used to be a note and a transcript: nothing said which request failed or why. This keeps codes and
// request ids only -- never a message, a prompt or a path -- and only the last few. Nothing here is sent by
// itself: a report (or a turn_error beacon) is the only thing that reads it.

export const MAX_RECENT_FAILURES = 10;

export interface FailureNote {
  /** Epoch seconds, the app's clock. */
  at: number;
  /** turn | generation | vision | ai: which kind of paid call failed. */
  where: string;
  /** What the person was told, as a code (content_policy, account_busy, http_503, network, ...). */
  code: string;
  /** The server's X-Request-ID for the failed call; absent when no answer ever came back. */
  requestId?: string;
  status?: number;
}

export interface FailureInput {
  where: string;
  code: string;
  requestId?: string;
  status?: number;
  at?: number;
}

// The server keeps this alphabet (and these bounds) for the same fields; matching them here keeps the wire clean.
const ILLEGAL = /[^A-Za-z0-9_.:-]/g;
/** Text in the closed alphabet the server accepts for codes and ids (anything else becomes `_`), cut to `cap`. */
export const legalText = (text: unknown, cap: number): string =>
  typeof text === "string" ? text.replace(ILLEGAL, "_").slice(0, cap) : "";
const clean = legalText;

/** A code that only says "something failed", which a later, specific note for the same request may replace. */
const isVague = (code: string): boolean =>
  code === "unknown" || code === "network" || /^http_\d+$/.test(code);

let ring: FailureNote[] = [];

export function noteFailure(input: FailureInput): void {
  const code = clean(input.code, 40) || "unknown";
  const requestId = clean(input.requestId, 128) || undefined;
  const status =
    typeof input.status === "number" &&
    Number.isInteger(input.status) &&
    input.status >= 100 &&
    input.status <= 599
      ? input.status
      : undefined;
  const same = requestId ? ring.find((note) => note.requestId === requestId) : undefined;
  if (same) {
    if (isVague(same.code) && !isVague(code)) same.code = code;
    if (same.status === undefined && status !== undefined) same.status = status;
    return;
  }
  const note: FailureNote = {
    at: input.at ?? Date.now() / 1000,
    where: clean(input.where, 30),
    code,
  };
  if (requestId) note.requestId = requestId;
  if (status !== undefined) note.status = status;
  ring = [...ring, note].slice(-MAX_RECENT_FAILURES);
}

/** The failures noted so far, oldest first. A copy: the record cannot be rewritten through it. */
export function recentFailures(): FailureNote[] {
  return ring.map((note) => ({ ...note }));
}

/** Forget everything: a new identity must not inherit the previous account's failures. */
export function clearRecentFailures(): void {
  ring = [];
}

/** Which kind of paid call a URL is, or null when it is not one. Only paid calls are noted: a failing telemetry beacon
 *  or balance read is not something the person asked for and would drown the failures that cost them something. */
export function paidCallWhere(url: string): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  if (/(^|\/)inference(\/stream)?$/.test(path)) return "turn";
  const proxy = /(^|\/)ai\/([a-z0-9_]+)$/.exec(path);
  if (!proxy) return null;
  if (proxy[2].startsWith("generate_")) return "generation";
  if (proxy[2].startsWith("vision_")) return "vision";
  return "ai";
}
