// Note a failed paid call for a problem report. Observation only: nothing here may change what the caller gets, so
// every step is guarded and a failure to observe is silent.
import { noteFailure, paidCallWhere } from "./recentFailures";

/** The typed code the server answered with (`detail.error`, or a top-level `error`), else the status. Reads a COPY of
 *  the body, so the caller can still read the original. */
async function codeOf(res: Response): Promise<string> {
  try {
    const body = (await res.clone().json()) as { detail?: unknown; error?: unknown } | null;
    const detail = body?.detail;
    const typed = detail && typeof detail === "object" ? (detail as { error?: unknown }).error : undefined;
    if (typeof typed === "string" && typed) return typed;
    if (typeof body?.error === "string" && body.error) return body.error;
  } catch {
    /* not JSON, an unreadable body, or a response that cannot be copied */
  }
  return `http_${res.status}`;
}

/** A paid call that came back with an error status. */
export async function noteFailedResponse(url: string, res: Response): Promise<void> {
  try {
    if (!(res.status >= 400)) return;
    const where = paidCallWhere(url);
    if (!where) return;
    const requestId = res.headers?.get?.("x-request-id") ?? undefined;
    noteFailure({ where, code: await codeOf(res), status: res.status, requestId });
  } catch {
    /* observing must never change what the caller sees */
  }
}

/** A paid call that never got an answer. A user Stop, or a refusal to send at all, is not a failed call. */
export function noteFailedRequest(url: string, error: unknown): void {
  try {
    const name = (error as { name?: unknown } | null)?.name;
    if (!(error instanceof TypeError) && name !== "TimeoutError" && name !== "NetworkError") return;
    const where = paidCallWhere(url);
    if (where) noteFailure({ where, code: "network" });
  } catch {
    /* observing must never change what the caller sees */
  }
}
