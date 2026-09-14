// Shared HTTP layer for the client's server calls. Adds a bounded
// retry-with-backoff on 429 (rate limit) for BOTH the model round (/inference)
// and the paid /ai proxy tools. Retry count + backoff ceiling are env-tunable
// (.env / VITE_*). On exhaustion the caller throws RateLimitError, so /inference
// can surface a clean "try again shortly" to the USER and a paid tool can tell
// the model to switch model or ask the user.
import { ArtDaddyError } from "../lib/errors";

function envInt(v: unknown, dflt: number, lo: number, hi: number): number {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

// Mutable so tests can shrink the waits; production reads the env defaults once.
// Backoff doubles from `baseS` (15s -> 30s -> 60s ...), clamped to `capS`.
export const rateLimitConfig = {
  retries: envInt(import.meta.env.VITE_RATE_LIMIT_RETRIES, 3, 0, 10),
  capS: envInt(import.meta.env.VITE_RATE_LIMIT_BACKOFF_CAP_S, 120, 1, 3600),
  baseS: 15,
  // Pause before re-firing a transient failure. Deliberately short: unlike a 429
  // this is not a "you are over quota, back off" signal.
  transientBackoffS: 1,
};

/** A 429 that persisted past the retry budget. Treated (like CreditLimitError)
 *  as an expected, non-Sentry error carrying a user/model-facing message. */
export class RateLimitError extends ArtDaddyError {
  readonly code = "rate_limited";
  readonly expected = true;
  constructor(
    message = "Rate-limited: the service is busy right now. Wait a moment and try again.",
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

/** Parse a Retry-After header (delta-seconds or an HTTP-date) to milliseconds. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header.trim());
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

/** Exponential backoff (honoring Retry-After) with +0-20% jitter, capped. */
function backoffMs(attempt: number, retryAfter: number | null): number {
  const base = retryAfter ?? rateLimitConfig.baseS * 2 ** attempt * 1000;
  const capped = Math.min(base, rateLimitConfig.capS * 1000);
  return Math.round(capped + capped * 0.2 * Math.random());
}

/** setTimeout as a promise that rejects immediately when `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RetryOpts {
  /** Extra attempts for a TRANSIENT failure — a 5xx or a dropped/timed-out
   *  connection. Opt-in, 0 by default: re-firing a non-idempotent paid call
   *  (generation) after an ambiguous timeout can bill the user twice. Only
   *  idempotent reads should set it. */
  transientRetries?: number;
}

/** `fetch` that retries a 429 with bounded exponential backoff (honoring
 *  Retry-After), plus — only when the caller opts in — a transient 5xx/timeout.
 *  Any other response (incl. 401/402/4xx) passes straight through. Aborts
 *  immediately when `signal` fires; a user Stop is never retried. */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
  opts: RetryOpts = {},
): Promise<Response> {
  const transientCap = Math.max(0, Math.trunc(opts.transientRetries ?? 0));
  let transient = 0;
  let rateLimited = 0;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal });
    } catch (e) {
      // Dropped / timed-out connection. A user Stop is an abort, not a transient.
      if (signal?.aborted || transient >= transientCap) throw e;
      transient += 1;
      await sleep(rateLimitConfig.transientBackoffS * 1000, signal);
      continue;
    }
    if (res.status >= 500 && transient < transientCap) {
      transient += 1;
      await res.body?.cancel().catch(() => undefined);
      await sleep(rateLimitConfig.transientBackoffS * 1000, signal);
      continue;
    }
    if (res.status !== 429 || rateLimited >= rateLimitConfig.retries) return res;
    // Free the 429 body before waiting to retry (avoid a dangling stream).
    await res.body?.cancel().catch(() => undefined);
    await sleep(backoffMs(rateLimited, retryAfterMs(res.headers.get("Retry-After"))), signal);
    rateLimited += 1;
  }
}
