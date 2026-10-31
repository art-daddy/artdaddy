// Thin external-API proxy calls (POST /ai/{name}). The client owns all tool
// logic + media pre-processing and uploads ready-to-send bytes; the server makes
// the ONE authed model/API call (the credential stays server-side) and returns
// bytes / text. Mirrors agent/api.ts's auth (401) + credit (402) handling.
import { authedFetch, notifyAuthFailure } from "./auth";
import { apiBase } from "./config";
import {
  fetchWithRetry,
  RateLimitError,
  SessionExpiredError,
  SessionRenewalUnavailableError,
  type RetryOpts,
} from "./http";
import {
  downloadOrderResult,
  markOrderAccepted,
  OrderFailedError,
  orderKnownToServer,
  waitForOrder,
} from "./orders";
import { creditWallFromBody } from "./creditWall";
import {
  discardUploads,
  pauseUploads,
  UploadMissingError,
  uploadClip,
  UploadsUnavailableError,
} from "./uploads";
import { CreditLimitError, markOverLimit, refreshUsage } from "./usage";
import { SerialGate } from "../lib/serialGate";
import { correlationBody } from "../observability/sentry";
import { catalogIdentity } from "../contract";
import { ClientUpdateRequiredError } from "../update/updater";

export interface AiMedia {
  b64: string;
  ext?: string;
}

/** A clip as bytes. The app uploads it straight to the bucket and the call carries only its id; if that cannot be done the clip is
 *  sent inline, exactly as a `{ b64 }` entry would have been (see ./uploads). Only clips the server reads by address (a video
 *  question, a style pass) may be given this way. */
export interface AiClip {
  clip: Uint8Array;
  ext?: string;
}

/** What goes over the wire for a clip that was uploaded. */
interface AiRef {
  ref: string;
}

export interface AiProxyBody {
  /** The call's params (incl. which `media` keys to send, in order). */
  args: Record<string, unknown>;
  /** ref -> {b64, ext?}: bytes for any client media the call reads; a `{ clip }` is uploaded instead of being sent in the request. */
  media?: Record<string, AiMedia | AiClip>;
  /** Correlation ids for observability (Sentry tags); added automatically. */
  project_id?: string;
  transcript_id?: string;
  /** Makes a GENERATION call an order: the server keeps the order, and the finished file, until the app has it. The same number
   *  sent again is the same order, never a second charge. Ignored (answered inline) by a server that cannot keep results. */
  order_id?: string;
}

/** The body as it is sent: no clip is ever in it as bytes. */
type SentBody = Omit<AiProxyBody, "media"> & { media?: Record<string, AiMedia | AiRef> };

export interface AiCallOpts extends RetryOpts {
  /** Called once the server has taken the call as an order. From then on the server owns the wait: the answer cannot be lost. */
  onOrder?: (orderId: string) => void;
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

/** A request body above this is "big" and is sent one at a time. It is deliberately the size the server holds one at a
 *  time (ARTDADDY_HEAVY_BODY_MB, default 8): a body costs the server about 7-8 times its size in memory, so it turns the
 *  rest away busy, and firing four clip uploads at once used to get three of them refused. */
export const BIG_UPLOAD_BYTES = 8 * 1024 * 1024;
const bigUploads = new SerialGate();

/** POST one thin external-API call. Throws CreditLimitError on 402, notifies on 401.
 *
 *  With an `order_id` (generation only) the call is an ORDER when the server can keep results: it answers at once, and this waits
 *  for the order and returns exactly what the live call would have. A server that cannot answers inline, as it always did.
 *
 *  A `{ clip }` in the media is uploaded straight to the bucket and the call names it by id, so the server never carries the clip.
 *  That is only ever an optimisation: whatever goes wrong with an upload, the clip is sent inline as it always was. */
export async function callAiProxy<R = Record<string, unknown>>(
  name: string,
  body: AiProxyBody,
  signal?: AbortSignal,
  opts: AiCallOpts = {},
): Promise<AiProxyResult<R>> {
  const clips = Object.entries(body.media ?? {}).filter((entry): entry is [string, AiClip] =>
    isClip(entry[1]),
  );
  if (clips.length === 0) return sendAiProxy<R>(name, body as SentBody, signal, opts);
  const refs = new Map<string, string>();
  try {
    await uploadAll(clips, refs, signal);
    // An upload the server cannot find is sent again, once, and only that one; if that fails too, or the server says it cannot look
    // in the bucket at all, every clip goes inline as it always did. Neither answer is given after any work was done, so sending
    // again is safe, and an inline call cannot be refused for either: at most three tries.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await sendAiProxy<R>(name, withClips(body, refs), signal, opts);
      } catch (e) {
        const gone = e instanceof UploadMissingError;
        if (!(gone || e instanceof UploadsUnavailableError) || attempt >= 2) throw e;
        if (gone && attempt === 0) {
          for (const key of e.keys) refs.delete(key);
          await uploadAll(
            clips.filter(([key]) => e.keys.includes(key)),
            refs,
            signal,
          );
        } else {
          void discardUploads([...refs.values()]);
          refs.clear();
          if (!gone) pauseUploads();
        }
      }
    }
  } catch (e) {
    // The call did not complete: nothing has used what was uploaded (or it ran and the server has already removed it, which is fine).
    void discardUploads([...refs.values()]);
    throw e;
  }
}

function isClip(entry: AiMedia | AiClip): entry is AiClip {
  return "clip" in entry;
}

/** Upload every clip at once and note the id of each that went, by media key. If one cannot be sent for a reason that ends the call
 *  (the credit wall, a Stop), the ones that did arrive are taken back out and that reason is what is thrown. */
async function uploadAll(
  clips: [string, AiClip][],
  refs: Map<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  const settled = await Promise.allSettled(
    clips.map(([, entry]) => uploadClip(entry.clip, signal)),
  );
  const arrived = settled.flatMap((s) => (s.status === "fulfilled" && s.value ? [s.value] : []));
  const ended = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (ended) {
    void discardUploads(arrived);
    throw ended.reason;
  }
  settled.forEach((s, i) => {
    if (s.status === "fulfilled" && s.value) refs.set(clips[i][0], s.value);
  });
}

/** The body to send: a clip that was uploaded is its id, any other is its bytes as text, exactly as it was before uploads. */
function withClips(body: AiProxyBody, refs: Map<string, string>): SentBody {
  const media: Record<string, AiMedia | AiRef> = {};
  for (const [key, entry] of Object.entries(body.media ?? {})) {
    if (!isClip(entry)) media[key] = entry;
    else if (refs.has(key)) media[key] = { ref: refs.get(key)! };
    else media[key] = { b64: toB64(entry.clip), ...(entry.ext ? { ext: entry.ext } : {}) };
  }
  return { ...body, media };
}

/** The media keys of a 400 that says uploads are gone, else null. */
function missingUploadKeys(text: string): string[] | null {
  try {
    const detail = (JSON.parse(text) as { detail?: { error?: unknown; keys?: unknown } } | null)
      ?.detail;
    if (detail?.error !== "upload_missing" || !Array.isArray(detail.keys)) return null;
    const keys = detail.keys.filter((key): key is string => typeof key === "string");
    return keys.length ? keys : null;
  } catch {
    return null;
  }
}

/** Whether a 503 is the server saying it cannot look in the bucket right now (it says so before doing any work). */
function bucketUnavailable(text: string): boolean {
  try {
    const detail = (JSON.parse(text) as { detail?: { error?: unknown } } | null)?.detail;
    return detail?.error === "uploads_unavailable";
  } catch {
    return false;
  }
}

async function sendAiProxy<R = Record<string, unknown>>(
  name: string,
  body: SentBody,
  signal?: AbortSignal,
  opts: AiCallOpts = {},
): Promise<AiProxyResult<R>> {
  const { onOrder, ...retry } = opts;
  const orderId = body.order_id;
  const payload = JSON.stringify({ ...body, ...correlationBody(), catalog_id: catalogIdentity() });
  const send = () =>
    authedFetch(
      `${apiBase()}/ai/${name}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      },
      (u, init) => fetchWithRetry(u, init, signal, retry),
    );
  // Judged by the request actually sent (JSON of base64 is ASCII, so characters are bytes). Small calls are never held.
  let res: Response;
  try {
    res = payload.length > BIG_UPLOAD_BYTES ? await bigUploads.run(send, signal) : await send();
  } catch (e) {
    if (orderId && submitMayHaveArrived(e, signal))
      return recoverLostSubmit<R>(orderId, e, signal, onOrder);
    throw e;
  }
  if (!res.ok) {
    if (res.status === 426) throw new ClientUpdateRequiredError();
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
    if (res.status === 402) throw creditWallFromBody(text);
    // The server could not find an upload the call named: the caller sends those clips again (see callAiProxy).
    if (res.status === 400) {
      const gone = missingUploadKeys(text);
      if (gone) throw new UploadMissingError(gone);
    }
    // It could not look in the bucket right now: the caller sends the clips inline instead (see callAiProxy).
    if (bucketUnavailable(text)) throw new UploadsUnavailableError();
    // Retries are already exhausted here, so the message has to tell the MODEL what
    // to do next — otherwise it just fires the same call again and burns the turn.
    if (res.status === 429)
      throw new RateLimitError(
        `${name} is rate-limited / out of quota right now (429), and automatic retries are exhausted. ` +
          `Do NOT immediately retry the same call. Either switch to a different model if this tool takes one, ` +
          `or tell the user the service is busy and to try again in a few minutes.`,
      );
    const failure = new Error(`${res.status}: ${text || res.statusText}`);
    // A server error may have come AFTER the server made the order: ask rather than assume it did not.
    if (orderId && res.status >= 500)
      return recoverLostSubmit<R>(orderId, failure, signal, onOrder);
    throw failure;
  }
  const answer =
    res.status === 202 && orderId
      ? null
      : ((await res.json()) as AiProxyResult<R> | { order: unknown });
  // A 202 is the server saying it took the order: whatever the body is, the order exists and is waited for (a body that cannot be
  // read must not make a paid, running order look like a failed call).
  if (orderId && (res.status === 202 || isOrderAnswer(answer))) {
    await res.body?.cancel().catch(() => undefined);
    return collectOrder<R>(orderId, signal, onOrder);
  }
  return answer as AiProxyResult<R>;
}

/** An answer about an order, as opposed to the live call's `{result, ...}`. */
function isOrderAnswer(answer: unknown): boolean {
  return (
    typeof answer === "object" && answer !== null && "order" in answer && !("result" in answer)
  );
}

/** Whether a failure to send may still have reached the server. Not when the request demonstrably never left. */
function submitMayHaveArrived(e: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  return !(
    e instanceof ClientUpdateRequiredError ||
    e instanceof SessionExpiredError ||
    e instanceof SessionRenewalUnavailableError
  );
}

/** The answer to a submit was lost (the connection dropped, or the server failed after it may have made the order). Sending the
 *  call again would be a second attempt at something that may be running, so ask the server whether it has the order: if it has,
 *  wait for it as usual; if it never got the call, this was an ordinary failure, and is reported as one. It asks for as long as
 *  the server cannot say, because an order that exists is paid for. */
async function recoverLostSubmit<R>(
  orderId: string,
  cause: unknown,
  signal: AbortSignal | undefined,
  onOrder: ((orderId: string) => void) | undefined,
): Promise<AiProxyResult<R>> {
  if (!(await orderKnownToServer(orderId, signal))) throw cause;
  return collectOrder<R>(orderId, signal, onOrder);
}

/** The server has the order: wait for it, then fetch the finished result. */
async function collectOrder<R>(
  orderId: string,
  signal: AbortSignal | undefined,
  onOrder: ((orderId: string) => void) | undefined,
): Promise<AiProxyResult<R>> {
  markOrderAccepted(orderId);
  onOrder?.(orderId);
  let ready;
  try {
    ready = await waitForOrder(orderId, { signal });
  } catch (e) {
    // The tools already know how to explain a rate limit and a credit wall to the model and the person.
    if (e instanceof OrderFailedError && e.code === "rate_limited")
      throw new RateLimitError(e.message);
    if (e instanceof OrderFailedError && e.code === "credit_limit_reached") throw creditWall(e);
    throw e;
  }
  return (await downloadOrderResult(ready, signal)) as AiProxyResult<R>;
}

/** The server took the order and then found the account unable to pay for it. A live call's 402 says so with the balance on it, and
 *  the balance display and the tools act on that; this says the same from the numbers the order carries. Without numbers the
 *  account is not claimed to be over (it may be one request that costs more than what is left): the real balance is asked for. */
function creditWall(e: OrderFailedError): Error {
  if (!e.detail) {
    void refreshUsage();
    return e;
  }
  markOverLimit(e.detail);
  return new CreditLimitError(e.detail);
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
