// Typed HTTP calls for the client-owned loop: one stateless model round on the
// thin proxy. Plain request/response, plus an opt-in SSE variant of the same round.
import { authHeaders, notifyAuthFailure } from "../api/auth";
import { api } from "../api/client";
import { fetchWithRetry, RateLimitError } from "../api/http";
import { readSSE } from "../api/sse";
import { CreditLimitError, markOverLimit } from "../api/usage";
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

/** Run ONE model round on the stateless proxy. Returns the round result plus a
 *  refreshed continuity token (the caller stores it for the next round). */
export async function inferRound(body: InferBody, signal?: AbortSignal): Promise<RoundResultDTO> {
  return postJson<RoundResultDTO>(api.inferenceUrl(), body, signal);
}

/** What a streamed round reports as it arrives. `reset` retracts everything emitted
 *  for this round so far — the attempt that produced it was retried or chain-reset,
 *  so its prose is not the answer. */
export type RoundDelta = { kind: "text" | "reasoning" | "reset"; text: string };

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

  const res = await fetch(api.inferenceStreamUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(await authHeaders()),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (res.status === 404 || res.status === 405) {
    // An older server. Nothing ran, so re-issuing the round is free and correct -- and it
    // goes through inferRound rather than a second copy of the non-streaming request.
    noStreamRoute.add(base);
    return inferRound(body, signal);
  }
  if (!res.ok) {
    if (res.status === 401) notifyAuthFailure();
    const text = await res.text().catch(() => "");
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
  await readSSE(res.body, ({ event, data }) => {
    if (event === "delta") onDelta(data as RoundDelta);
    else if (event === "result") result = data as RoundResultDTO;
  });
  if (!result) throw new Error("the inference stream ended without a result");
  return result;
}
