// A stand-in for the server's direct uploads AND the bucket they go to, for tests of the app's side of them.
//
// What the server says is built from the SAME fixture the server's own tests are held to (src/api/__fixtures__/uploadViews.json), so it
// cannot drift from the real answers; what it adds is behaviour. A ticket is an address for exactly one size and type; the "bucket"
// refuses anything else with the statuses measured on the real one (and refuses a request that carries an account token as well,
// as Google does); a paid call that names an upload reads it and then removes it; one that names an upload that is not there is turned
// away, and a paid call refused before it runs leaves its uploads where they are. Install with `vi.stubGlobal("fetch", server.fetch)`.
import uploadViews from "../api/__fixtures__/uploadViews.json";
import { apiBase } from "../api/config";

export const BUCKET = "https://storage.test";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** What one paid call carried when it reached the server. */
export interface SeenCall {
  name: string;
  /** media key -> the upload it named. */
  refs: Record<string, string>;
  /** media key -> the bytes it carried inline. */
  inline: Record<string, Uint8Array>;
  /** The request body as text: whatever else was in it. */
  body: string;
}

export interface UploadBehaviour {
  /** POST /uploads: "on", a status to answer with, or "drop" (the connection fails); or a function of how many tickets have been
   *  asked for so far (this one included), to change the answer part way through a call. */
  tickets: "on" | number | "drop" | ((asked: number) => "on" | number | "drop");
  /** PUT to a ticket's address: "ok", "blocked" (the browser refuses: no CORS), or a status. */
  put: "ok" | "blocked" | number;
  /** The paid call: "ok"; {refuse} is answered BEFORE it runs (uploads stay); {fail} runs and then answers with an error;
   *  "unbucketed" is the server saying it cannot look in the bucket (as it does BEFORE any work) to any call that names an upload. */
  ai: "ok" | "unbucketed" | { refuse: number } | { fail: number };
  /** DELETE /uploads/{id}: "ok", a status, or "drop". */
  remove: "ok" | number | "drop";
  /** What a paid call that ran answers with. */
  answer: unknown;
  /** Edits each ticket before it is handed out: a test makes a ticket the server would never give. */
  alter: ((ticket: { upload: Record<string, unknown> }) => void) | null;
}

interface Ticket {
  id: string;
  type: string;
  size: number;
}

export class FakeUploadServer {
  /** The bucket: what has been uploaded, by upload id. */
  readonly objects = new Map<string, { bytes: Uint8Array; type: string }>();
  /** Every request seen, in order: `METHOD path` (the bucket's are `METHOD bucket:<id>`). */
  readonly calls: string[] = [];
  /** Every paid call that reached the server, as it arrived. */
  readonly seen: SeenCall[] = [];
  /** The headers each request carried, by the line in `calls`. */
  readonly headers: Record<string, string>[] = [];
  /** Called when an upload has just been stored: a test can lose it here, as the passing of time would. */
  onStored: ((id: string) => void) | null = null;
  behaviour: UploadBehaviour = {
    tickets: "on",
    put: "ok",
    ai: "ok",
    remove: "ok",
    answer: { result: { ok: true, text: "an answer" } },
    alter: null,
  };
  /** While set, a paid call that has been validated waits for it before it is answered: calls can be held open. */
  gate: Promise<void> | null = null;
  private readonly issued = new Map<string, Ticket>();
  private minted = 0;
  private asked = 0;

  /** `fetch`, as the app calls it. */
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(
      (init?.headers as Record<string, string> | undefined) ?? {},
    ))
      headers[k.toLowerCase()] = v;
    const base = new URL(apiBase());
    if (url.origin === BUCKET) return this.bucket(method, url, headers, init?.body);
    const path = url.pathname.slice(base.pathname.replace(/\/$/, "").length);
    this.calls.push(`${method} ${path}`);
    this.headers.push(headers);
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const text = typeof init?.body === "string" ? init.body : "{}";
    if (method === "POST" && path === "/uploads")
      return this.mint(JSON.parse(text) as { content_type: string; size: number });
    const removal = /^\/uploads\/([^/]+)$/.exec(path);
    if (method === "DELETE" && removal) return this.remove(removal[1]);
    if (method === "POST" && /^\/ai\/[^/]+$/.test(path))
      return await this.paid(path.slice(4), text);
    return new Response("not found", { status: 404 });
  };

  /** What the bucket holds, as text, by id: handy in assertions. */
  stored(id: string): Uint8Array | undefined {
    return this.objects.get(id)?.bytes;
  }

  private json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json", ...extra },
    });
  }

  private error(code: keyof typeof uploadViews.errors): Response {
    const known = uploadViews.errors[code];
    return this.json(clone(known.body), known.status);
  }

  private mint(want: { content_type: string; size: number }): Response {
    this.asked += 1;
    const chosen = this.behaviour.tickets;
    const mode = typeof chosen === "function" ? chosen(this.asked) : chosen;
    if (mode === "drop") throw new TypeError("Failed to fetch");
    if (typeof mode === "number") {
      const named = Object.entries(uploadViews.errors).find(([, e]) => e.status === mode);
      return named
        ? this.error(named[0] as keyof typeof uploadViews.errors)
        : new Response("{}", { status: mode });
    }
    // The real server gives tickets for an mp4 clip of a whole, positive size and nothing else.
    if (want.content_type !== "video/mp4" || !Number.isInteger(want.size) || want.size < 1)
      return this.error("upload_refused");
    this.minted += 1;
    const id = crypto.randomUUID().replaceAll("-", "");
    const ticket = clone(uploadViews.ticket);
    ticket.upload.id = id;
    ticket.upload.url = `${BUCKET}/uploads/${id}?sig=${this.minted}`;
    ticket.upload.headers = {
      "Content-Type": want.content_type,
      "x-goog-content-length-range": `${want.size},${want.size}`,
    };
    this.issued.set(ticket.upload.url, { id, type: want.content_type, size: want.size });
    this.behaviour.alter?.(ticket);
    return this.json(ticket);
  }

  private bucket(
    method: string,
    url: URL,
    headers: Record<string, string>,
    body: BodyInit | null | undefined,
  ): Response {
    const issued = this.issued.get(url.href);
    this.calls.push(`${method} bucket:${issued?.id ?? url.pathname}`);
    this.headers.push(headers);
    if (method !== "PUT") return new Response("not allowed", { status: 403 });
    const mode = this.behaviour.put;
    if (mode === "blocked") throw new TypeError("Failed to fetch");
    if (typeof mode === "number") return new Response("", { status: mode });
    // Google: one way to prove who you are. A request that carries an account's token as well as a signed address is refused.
    if (headers["authorization"])
      return new Response("Only one auth mechanism allowed", { status: 400 });
    if (!issued) return new Response("SignatureDoesNotMatch", { status: 403 });
    if (headers["content-type"] !== issued.type)
      return new Response("SignatureDoesNotMatch", { status: 403 });
    if (headers["x-goog-content-length-range"] !== `${issued.size},${issued.size}`)
      return new Response("MalformedSecurityHeader", { status: 400 });
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(0);
    if (bytes.byteLength !== issued.size) return new Response("EntityTooLarge", { status: 400 });
    this.objects.set(issued.id, { bytes: new Uint8Array(bytes), type: issued.type });
    this.onStored?.(issued.id);
    return new Response("", { status: 200 });
  }

  private remove(id: string): Response {
    const mode = this.behaviour.remove;
    if (mode === "drop") throw new TypeError("Failed to fetch");
    if (typeof mode === "number") return new Response("{}", { status: mode });
    this.objects.delete(id);
    return this.json(clone(uploadViews.removed));
  }

  private async paid(name: string, text: string): Promise<Response> {
    const body = JSON.parse(text) as {
      media?: Record<string, { ref?: string; b64?: string; clip?: unknown }>;
    };
    const refs: Record<string, string> = {};
    const inline: Record<string, Uint8Array> = {};
    const gone: string[] = [];
    for (const [key, entry] of Object.entries(body.media ?? {})) {
      if (typeof entry.ref === "string") {
        refs[key] = entry.ref;
        if (!this.objects.has(entry.ref)) gone.push(key);
      } else if (typeof entry.b64 === "string") {
        inline[key] = Uint8Array.from(atob(entry.b64), (c) => c.charCodeAt(0));
      }
    }
    this.seen.push({ name, refs, inline, body: text });
    if (gone.length) {
      const missing = clone(uploadViews.errors.upload_missing);
      missing.body.detail.keys = gone;
      return this.json(missing.body, missing.status);
    }
    const mode = this.behaviour.ai;
    if (mode === "unbucketed" && Object.keys(refs).length) {
      const unavailable = clone(uploadViews.errors.uploads_unavailable);
      return this.json(unavailable.body, unavailable.status);
    }
    if (typeof mode === "object" && "refuse" in mode)
      return new Response("{}", { status: mode.refuse });
    if (this.gate) await this.gate;
    for (const id of Object.values(refs)) this.objects.delete(id); // the call ran: what it read is gone
    if (typeof mode === "object" && "fail" in mode)
      return new Response("{}", { status: mode.fail });
    return this.json(this.behaviour.answer);
  }
}
