// Direct uploads (UJ-048b): a clip goes from the app straight to the private bucket, and the paid call that needs it carries only its id.
//
// Why: a clip in a request body costs the small server about five times its size in memory while it is handled, so big ones had to be
// served one at a time and the rest turned away busy. A clip in the bucket never touches the server, and the model reads it from there.
//
// The rule that keeps this safe: uploading is only ever an OPTIMISATION. Anything that goes wrong here (a server that has no uploads, a
// refused ticket, a bucket that will not take the clip, a connection that fails) means "send the clip inline, as the app always did",
// never a lost clip and never a failed call. The only things that are not swallowed are the user's own Stop and the credit wall.
import { authedFetch } from "./auth";
import { apiBase } from "./config";
import { creditWallFromBody } from "./creditWall";
import { fetchCompatibleClient } from "../update/compatibility";

const CLIP_TYPE = "video/mp4";
/** How long a server that has no uploads (an older build, or one with no bucket) is left alone before it is asked again. */
export const UPLOADS_OFF_MS = 10 * 60 * 1000;
/** How long uploads are left alone after the server said, on a paid call, that it could not look in the bucket right then. */
export const UPLOADS_PAUSE_MS = 2 * 60 * 1000;
const UPLOAD_ID = /^[0-9a-f]{32}$/;
/** The only headers a ticket may tell the app to send to the bucket: the clip's type and the one length it may have. */
const TICKET_HEADERS = new Set(["content-type", "x-goog-content-length-range"]);

let offUntil = 0;

/** Forget what has been learned about the server (tests). */
export function resetUploads(): void {
  offUntil = 0;
}

/** Leave uploads alone for a couple of minutes: the server could not look in the bucket. */
export function pauseUploads(): void {
  offUntil = Date.now() + UPLOADS_PAUSE_MS;
}

/** A paid call that names uploads was answered "the server cannot look in the bucket right now". It says so before doing any work,
 *  so the call is safe to send again, with the clips inline. */
export class UploadsUnavailableError extends Error {
  constructor() {
    super("The server could not look in the bucket for an uploaded clip.");
    this.name = "UploadsUnavailableError";
  }
}

/** A paid call named uploads the bucket no longer has. `keys` are the media keys to send again. */
export class UploadMissingError extends Error {
  readonly keys: string[];
  constructor(keys: string[]) {
    super("An uploaded clip is no longer available.");
    this.name = "UploadMissingError";
    this.keys = keys;
  }
}

interface Ticket {
  id: string;
  url: string;
  headers: Record<string, string>;
}

/** The ticket the server answered with, or null when it is not one the app will use: not an upload id, not a plain https address,
 *  or asking for any header beyond the type and the length the bucket checks. */
function parseTicket(body: unknown): Ticket | null {
  const upload = (body as { upload?: unknown } | null)?.upload;
  if (!upload || typeof upload !== "object") return null;
  const { id, url, headers } = upload as Record<string, unknown>;
  if (typeof id !== "string" || !UPLOAD_ID.test(id) || typeof url !== "string") return null;
  try {
    if (new URL(url).protocol !== "https:") return null;
  } catch {
    return null;
  }
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return null;
  const sent: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string" || !TICKET_HEADERS.has(name.toLowerCase())) return null;
    sent[name] = value;
  }
  return { id, url, headers: sent };
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

async function askForTicket(size: number, signal?: AbortSignal): Promise<Ticket | null> {
  let res: Response;
  try {
    res = await authedFetch(
      `${apiBase()}/uploads`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content_type: CLIP_TYPE, size }),
      },
      (u, init) => fetchCompatibleClient(u, { ...init, signal }),
    );
  } catch (e) {
    if (signal?.aborted) throw e;
    return null;
  }
  // The same wall a paid call meets: the account cannot use the clip, so it is not sent anywhere.
  if (res.status === 402)
    throw creditWallFromBody(await res.text().catch(() => ""), "Nothing was uploaded");
  if (res.status === 404 || res.status === 405 || res.status === 501)
    offUntil = Date.now() + UPLOADS_OFF_MS;
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  try {
    return parseTicket(await res.json());
  } catch {
    return null;
  }
}

/** Upload one clip straight to the bucket. Resolves to the upload's id, or to null when the clip should be sent inline instead (for
 *  whatever reason: nothing here ever stops a call that could still be made). Rejects only for the credit wall and for the user's
 *  own Stop, in which case anything that may have arrived is taken back out. */
export async function uploadClip(bytes: Uint8Array, signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) throw abortError();
  if (bytes.byteLength === 0 || Date.now() < offUntil) return null;
  const ticket = await askForTicket(bytes.byteLength, signal);
  if (!ticket) return null;
  try {
    // A plain request to the bucket: the address carries its own permission, so no account token goes with it (the bucket refuses a
    // request that carries both), and it is not one of our own server's calls.
    const res = await fetch(ticket.url, {
      method: "PUT",
      headers: ticket.headers,
      body: bytes as Uint8Array<ArrayBuffer>,
      signal,
    });
    await res.body?.cancel().catch(() => undefined);
    return res.status === 200 ? ticket.id : null;
  } catch (e) {
    if (!signal?.aborted) return null;
    void discardUploads([ticket.id]);
    throw e;
  }
}

/** Take uploads back out of the bucket. Best effort and never throws: the call it follows has its own outcome to report, and the
 *  bucket sweeps whatever is left within a day. */
export async function discardUploads(ids: string[]): Promise<void> {
  await Promise.allSettled(
    ids
      .filter((id) => UPLOAD_ID.test(id))
      .map(async (id) => {
        const res = await authedFetch(
          `${apiBase()}/uploads/${id}`,
          { method: "DELETE" },
          (u, init) => fetchCompatibleClient(u, init),
        );
        await res.body?.cancel().catch(() => undefined);
      }),
  );
}
