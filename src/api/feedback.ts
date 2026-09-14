// Opt-in diagnostic feedback (POST /telemetry/feedback). Best-effort — never
// throws into the UI. The client uploads a small JSON snapshot only on an
// explicit user action (thumbs up/down or "report a problem").
import { authHeaders, notifyAuthFailure } from "./auth";
import { apiBase } from "./config";

export type FeedbackKind = "up" | "down" | "report";

export interface FeedbackBundle {
  transcript?: unknown;
  timeline?: unknown;
  manifests?: Record<string, unknown>;
}

export interface FeedbackPayload {
  kind: FeedbackKind;
  transcript_id?: string;
  project_id?: string;
  note?: string;
  request_id?: string;
  bundle: FeedbackBundle;
}

/** Send one feedback item. Returns whether the server stored it (best-effort;
 *  never throws — a failed report must not disrupt editing). */
export async function submitFeedback(payload: FeedbackPayload): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase()}/telemetry/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify(payload),
    });
    if (res.status === 401) notifyAuthFailure();
    if (!res.ok) return false;
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean };
    return Boolean(j.ok);
  } catch {
    return false;
  }
}
