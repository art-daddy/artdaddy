// Client error reporting — opt-in via VITE_SENTRY_DSN, a safe no-op when unset.
//
// Mirrors the backend (src/akaru/server/observability.py): ERRORS ONLY (no
// traces, no breadcrumbs). Every event is SCRUBBED to ids + metadata — never
// user content (prompts, transcripts, media, tool args) or secrets. Correlation
// tags (project / transcript / model) link an issue to the client-owned
// transcript, so no breadcrumbs are needed to reconstruct the story.
import * as Sentry from "@sentry/react";

let enabled = false;

// The active project/transcript/model ids — set once per turn. Kept independent
// of `enabled` so the ids are still forwarded to the SERVER (which may run its
// own Sentry) even when the client's DSN is unset.
let ids: { project_id?: string; transcript_id?: string; model_id?: string } = {};

// Keys whose VALUES must never leave the process (user content + secrets).
const SCRUB_KEYS = new Set([
  "user_text",
  "text",
  "prompt",
  "system_prompt",
  "user_prompt",
  "instructions",
  "transcript",
  "requests",
  "response",
  "final_text",
  "result",
  "results",
  "args",
  "arguments",
  "media",
  "b64",
  "attachments",
  "project",
  "style_body",
  "workflow_body",
  "authorization",
  "cookie",
  "api_key",
  "token",
  "password",
  "secret",
]);

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return "…";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SCRUB_KEYS.has(k.toLowerCase()) ? "[scrubbed]" : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** An event nobody can act on: no type, no message, no frames — it arrives in the dashboard
 *  as "<unknown>" with a blank location. A quarter of our issues were these, and each one
 *  costs quota and triage attention while saying nothing. Usually a non-Error value (`{}`,
 *  a string, a rejected fetch) handed to captureException. */
function isActionable(event: Sentry.ErrorEvent): boolean {
  if (event.message && String(event.message).trim()) return true;
  const values = event.exception?.values ?? [];
  return values.some(
    (v) =>
      (v.type && v.type.trim() && v.type !== "Error") ||
      (v.value && v.value.trim()) ||
      (v.stacktrace?.frames?.length ?? 0) > 0,
  );
}

function beforeSend(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  if (!isActionable(event)) return null;
  const req = event.request;
  if (req) {
    delete req.data; // never send request bodies
    delete req.cookies;
    if (req.headers) {
      for (const h of Object.keys(req.headers)) {
        if (["authorization", "cookie", "x-api-key"].includes(h.toLowerCase())) {
          req.headers[h] = "[scrubbed]";
        }
      }
    }
  }
  if (event.extra) event.extra = scrub(event.extra) as Record<string, unknown>;
  return event;
}

/** Initialize Sentry when VITE_SENTRY_DSN is set; return true if active. A
 *  no-op (returns false) otherwise, so local dev + tests never send anything. */
export function initSentry(): boolean {
  const dsn = (import.meta.env.VITE_SENTRY_DSN ?? "").trim();
  if (!dsn) return false;
  // .env carries the DSN, and Vite loads it in dev too -- so the dev server was
  // reporting HMR-only ReferenceErrors as if users had hit them.
  if (import.meta.env.DEV) return false;
  Sentry.init({
    dsn,
    release: import.meta.env.VITE_ARTDADDY_RELEASE || __ARTDADDY_RELEASE__,
    environment: import.meta.env.VITE_ARTDADDY_ENV || "alpha",
    sendDefaultPii: false,
    tracesSampleRate: 0, // errors only
    maxBreadcrumbs: 0, // no breadcrumbs (transcript_id links out)
    beforeSend,
  });
  enabled = true;
  return true;
}

/** Set the active correlation ids for the current turn. Records them for the
 *  /ai forward path and, when Sentry is on, tags all subsequent events. */
export function setCorrelation(next: {
  project_id?: string | null;
  transcript_id?: string | null;
  model_id?: string | null;
}): void {
  ids = {
    project_id: next.project_id || undefined,
    transcript_id: next.transcript_id || undefined,
    model_id: next.model_id || undefined,
  };
  if (!enabled) return;
  for (const [k, v] of Object.entries(ids)) {
    if (v) Sentry.setTag(k, String(v).slice(0, 200));
  }
}

/** The project/transcript ids to forward on /ai calls (empty when unset). */
export function correlationBody(): { project_id?: string; transcript_id?: string } {
  const out: { project_id?: string; transcript_id?: string } = {};
  if (ids.project_id) out.project_id = ids.project_id;
  if (ids.transcript_id) out.transcript_id = ids.transcript_id;
  return out;
}

/** Attribute events to the signed-in tester, so "how many people hit this" is a real
 *  number. Every issue read 0 users affected while five testers were using the app,
 *  because nothing ever identified one — which made a live bug look like local noise.
 *
 *  The access secret IS the identity here, so it is HASHED: Sentry gets a stable opaque
 *  id, never the credential, and `sendDefaultPii` stays off. */
export async function identifyUser(secret: string | null): Promise<void> {
  if (!enabled) return;
  if (!secret) {
    Sentry.setUser(null);
    return;
  }
  Sentry.setUser({ id: await opaqueId(secret) });
}

async function opaqueId(secret: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return "tester";
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Report a handled error with a small, scrubbed context. No-op when disabled. */
export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.captureException(
    err,
    context ? { extra: scrub(context) as Record<string, unknown> } : undefined,
  );
}

export { Sentry };
