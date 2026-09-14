// Thin external-API proxy calls (POST /ai/{name}). The client owns all tool
// logic + media pre-processing and uploads ready-to-send bytes; the server makes
// the ONE authed model/API call (the credential stays server-side) and returns
// bytes / text. Mirrors agent/api.ts's auth (401) + credit (402) handling.
import { authHeaders, notifyAuthFailure } from "./auth";
import { apiBase } from "./config";
import { fetchWithRetry, RateLimitError, type RetryOpts } from "./http";
import { CreditLimitError, markOverLimit } from "./usage";
import { correlationBody } from "../observability/sentry";

export interface AiMedia {
  b64: string;
  ext?: string;
}

export interface AiProxyBody {
  /** The call's params (incl. which `media` keys to send, in order). */
  args: Record<string, unknown>;
  /** ref -> {b64, ext?}: bytes for any client media the call reads. */
  media?: Record<string, AiMedia>;
  /** Correlation ids for observability (Sentry tags); added automatically. */
  project_id?: string;
  transcript_id?: string;
}

/** Every /ai/{name} response is `{result, media?, metrics?}`. */
export interface AiProxyResult<R = Record<string, unknown>> {
  result: R;
  media?: {
    b64: string;
    ext?: string;
    kind?: string | null;
    name?: string | null;
    model?: string | null;
    prompt?: string | null;
    folder?: string | null;
  }[];
  metrics?: { cost_usd?: number };
}

/** POST one thin external-API call. Throws CreditLimitError on 402, notifies on 401. */
export async function callAiProxy<R = Record<string, unknown>>(
  name: string,
  body: AiProxyBody,
  signal?: AbortSignal,
  opts: RetryOpts = {},
): Promise<AiProxyResult<R>> {
  const res = await fetchWithRetry(
    `${apiBase()}/ai/${name}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({ ...body, ...correlationBody() }),
    },
    signal,
    opts,
  );
  if (!res.ok) {
    if (res.status === 401) notifyAuthFailure();
    const text = await res.text().catch(() => "");
    // The sign-in prompt is already up (notifyAuthFailure). What the MODEL needs is to stop: it
    // used to receive the raw body — `401: {"detail":"invalid or expired session"}` — which reads
    // as a generation failure, so it re-tried a paid call that could not possibly succeed.
    if (res.status === 401)
      throw new Error(
        `${name} could not run: the session has expired and the user has been asked to sign in again. ` +
          `Do NOT retry this or any other paid call — say the sign-in is needed and stop.`,
      );
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
    // Retries are already exhausted here, so the message has to tell the MODEL what
    // to do next — otherwise it just fires the same call again and burns the turn.
    if (res.status === 429)
      throw new RateLimitError(
        `${name} is rate-limited / out of quota right now (429), and automatic retries are exhausted. ` +
          `Do NOT immediately retry the same call. Either switch to a different model if this tool takes one, ` +
          `or tell the user the service is busy and to try again in a few minutes.`,
      );
    throw new Error(`${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as AiProxyResult<R>;
}

export function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
