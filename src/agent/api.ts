// Typed HTTP calls for the client-owned loop: one stateless model round on the
// thin proxy. Plain request/response, plus an opt-in SSE variant of the same round.
import { authHeaders, notifyAuthFailure } from "../api/auth";
import { api } from "../api/client";
import { fetchWithRetry, RateLimitError, SessionExpiredError } from "../api/http";
import { readSSE } from "../api/sse";
import { CreditLimitError, markOverLimit } from "../api/usage";
import { hostInfo } from "../platform/host";
import type { InferenceAttachment, RoundInput, RoundResultDTO } from "./types";

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify(body),
    },
    signal,
  );
  if (!res.ok) {
    if (res.status === 401) notifyAuthFailure();
    const text = await res.text().catch(() => "");
    if (res.status === 401) throw new SessionExpiredError();
    if (res.status === 402) {
      let detail: unknown = text;
      try {
        detail = (JSON.parse(text) as { detail?: unknown }).detail ?? text;
      } catch {
        /* keep raw text */
      }
      markOverLimit(detail);
      throw new CreditLimitError(detail);
    }
    // Retries exhausted: a clean, non-Sentry error the turn surfaces to the user.
    if (res.status === 429) throw new RateLimitError();
    throw new Error(`${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

export interface InferBody {
  round_input: RoundInput;
  model?: string;
  effort?: string;
  attachments?: InferenceAttachment[];
  // Correlation ids for observability (Sentry tags) — not used for any logic.
  project_id?: string;
  transcript_id?: string;
  // Client-owned continuity + the project "rules" (style/workflow) config.
  transcript?: { requests: unknown[] } | null;
  provider_snapshot?: Record<string, unknown> | null;
  project?: Record<string, unknown> | null;
}

/** Diagnostics the server cannot derive: the webview's user-agent reports an Intel Mac on
 *  Apple Silicon, and it is what labels the prompt log and any server-side error. Applied by
 *  BOTH round senders, so the streaming and non-streaming paths cannot describe the same
 *  machine differently. */
function withClientInfo(body: InferBody): InferBody & Record<string, unknown> {
  const { os, arch } = hostInfo();
  return {
    ...body,
    client_os: os,
    client_arch: arch,
    app_version: __ARTDADDY_RELEASE__,
    surface: "app",
  };
}

/** Run ONE model round on the stateless proxy. Returns the round result plus a
 *  refreshed continuity token (the caller stores it for the next round). */
export async function inferRound(body: InferBody, signal?: AbortSignal): Promise<RoundResultDTO> {
  // Same deadline as the streaming path: a POST that never answers hangs the turn exactly
  // as a silent stream does, and this is also the fallback an older server lands on.
  const deadline = withDeadline(signal, ROUND_TIMEOUT_MS);
  try {
    return await postJson<RoundResultDTO>(
      api.inferenceUrl(),
      withClientInfo(body),
      deadline.signal,
    );
  } catch (e) {
    return deadline.rethrow(e);
  } finally {
    deadline.done();
  }
}

/** What a streamed round reports as it arrives. `reset` retracts everything emitted
 *  for this round so far — the attempt that produced it was retried or chain-reset,
 *  so its prose is not the answer. */
export type RoundDelta = { kind: "text" | "reasoning" | "reset"; text: string };

/** No round may run forever. Until this existed the ONLY thing that could end a round was
 *  the user pressing Stop: a stream that opened and then went quiet left the promise pending,
 *  so the catch never ran, the turn never settled, and the app showed "thinking" until it was
 *  restarted — with nothing reported, because nothing threw. Generous on purpose; this is the
 *  backstop for a broken connection, not a limit on how long a model may think. */
const ROUND_TIMEOUT_MS = 10 * 60_000;
/** How long the socket may be completely silent. The server sends a keepalive comment every
 *  15s while a round runs, so real silence this long means the connection is gone. */
const STREAM_IDLE_MS = 90_000;

/** The round ran out of time on OUR side. Separate from an abort so the turn can tell the
 *  user their connection died instead of silently behaving as if they had pressed Stop. */
export class RoundTimeoutError extends Error {
  constructor(ms: number) {
    super(
      `the model did not respond within ${Math.round(ms / 60_000)} minutes — ` +
        `the connection was probably lost. Nothing was changed; try again.`,
    );
    this.name = "RoundTimeoutError";
  }
}

/** The caller's signal plus a deadline, and a way to tell which one fired.
 *
 *  Built on a plain timer rather than `AbortSignal.timeout`/`AbortSignal.any`: those hang their
 *  timer off the platform rather than the global clock, so nothing can test what happens when
 *  one fires — and an untestable timeout is how the original hang survived to a user. */
function withDeadline(signal: AbortSignal | undefined, ms: number) {
  const ctrl = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    ctrl.abort();
  }, ms);

  const onAbort = () => ctrl.abort();
  if (signal?.aborted) ctrl.abort();
  else signal?.addEventListener("abort", onAbort);

  return {
    signal: ctrl.signal,
    // A user Stop and a timeout both surface as an AbortError; only the deadline is an error.
    rethrow: (e: unknown): never => {
      if (expired && !signal?.aborted) throw new RoundTimeoutError(ms);
      throw e;
    },
    // Must run on EVERY path: a 10-minute timer left behind per round keeps the event loop
    // busy and, in a long session, accumulates one for every message ever sent.
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

// One server either has the streaming route or it doesn't. Remembered per base URL so
// a server that predates it costs ONE extra request, not one per round.
const noStreamRoute = new Set<string>();

/** Run ONE model round, streamed. Deltas are presentation; the returned DTO is the
 *  record and is byte-identical to what {@link inferRound} would have returned.
 *
 *  Falls back to the non-streaming route only when the endpoint is ABSENT — never once
 *  a round is under way. A mid-stream failure has already burned tokens on the server,
 *  so retrying it as a fresh round would charge the user twice for one turn. */
export async function inferRoundStreaming(
  body: InferBody,
  onDelta: (d: RoundDelta) => void,
  signal?: AbortSignal,
): Promise<RoundResultDTO> {
  const base = api.base;
  if (noStreamRoute.has(base)) return inferRound(body, signal);

  const deadline = withDeadline(signal, ROUND_TIMEOUT_MS);
  try {
    return await streamRound(base, body, onDelta, deadline.signal, signal);
  } catch (e) {
    return deadline.rethrow(e);
  } finally {
    deadline.done();
  }
}

async function streamRound(
  base: string,
  body: InferBody,
  onDelta: (d: RoundDelta) => void,
  signal: AbortSignal,
  userSignal: AbortSignal | undefined,
): Promise<RoundResultDTO> {
  const res = await fetch(api.inferenceStreamUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(await authHeaders()),
    },
    body: JSON.stringify(withClientInfo(body)),
    signal,
  });

  if (res.status === 404 || res.status === 405) {
    // An older server. Nothing ran, so re-issuing the round is free and correct -- and it
    // goes through inferRound rather than a second copy of the non-streaming request.
    noStreamRoute.add(base);
    return inferRound(body, userSignal);
  }
  if (!res.ok) {
    if (res.status === 401) notifyAuthFailure();
    const text = await res.text().catch(() => "");
    if (res.status === 401) throw new SessionExpiredError();
    if (res.status === 402) {
      let detail: unknown = text;
      try {
        detail = (JSON.parse(text) as { detail?: unknown }).detail ?? text;
      } catch {
        /* keep raw text */
      }
      markOverLimit(detail);
      throw new CreditLimitError(detail);
    }
    if (res.status === 429) throw new RateLimitError();
    throw new Error(`${res.status}: ${text || res.statusText}`);
  }
  if (!res.body) throw new Error("no response body for the inference stream");

  let result: RoundResultDTO | null = null;
  await readSSE(
    res.body,
    ({ event, data }) => {
      if (event === "delta") onDelta(data as RoundDelta);
      else if (event === "result") result = data as RoundResultDTO;
    },
    { idleMs: STREAM_IDLE_MS },
  );
  if (!result) throw new Error("the inference stream ended without a result");
  return result;
}
