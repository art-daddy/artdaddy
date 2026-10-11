// Two lifecycle markers: the app started, and a project actually opened.
//
// Signing in is not evidence anybody reached the product. A tester authenticated, produced
// nothing at all, and no record anywhere could tell "opened it and hit a wall" from "never
// came back" — the account row and a refresh token were the only trace he ever left.
//
// Carries NO identity: the server takes that from the authenticated request.
import { apiBase } from "./config";
import { authedFetch, hasSession } from "./auth";
import { platform } from "../platform";
import { hostInfo, resolveHostInfo } from "../platform/host";
import { useAuth } from "../store/auth";
import type { WhisperRunFacts } from "../tools/whisperFacts";

export type AppEvent =
  | "launch"
  | "project_opened"
  | "heartbeat"
  | "media_import"
  | "app_error"
  | "credits_exhausted"
  | "transcription";

interface AppEventDetail {
  projectId?: string;
  ok?: boolean;
  reason?: string;
  via?: string;
  eventId?: string;
  occurredAt?: number;
  ownerId?: string;
  onVerifiedSend?: () => void;
}

export type AppEventDelivery = "stored" | "discarded" | "unavailable";

const MAX_PENDING_EVENTS = 50;
const STARTUP_WAIT_MS = 60_000;
const pendingEvents = new Set<(ready: boolean) => void>();

/** Report one marker. Never throws and never blocks: this is a beacon, not a feature. */
export async function reportAppEvent(
  event: AppEvent,
  detail: AppEventDetail = {},
): Promise<AppEventDelivery> {
  if (detail.eventId && (!detail.ownerId || !Number.isFinite(detail.occurredAt)))
    return "discarded";
  if (detail.onVerifiedSend && !detail.ownerId) return "discarded";
  const submitted = useAuth.getState();
  if (
    submitted.status === "locked" ||
    (submitted.status === "offline" && !submitted.hasStoredSession)
  )
    return "discarded";
  if (detail.ownerId && submitted.profile?.user_id && detail.ownerId !== submitted.profile.user_id)
    return "discarded";
  const snapshot = { ...detail };
  const controller = new AbortController();
  let discarded = false;
  let owner = detail.ownerId ?? submitted.profile?.user_id ?? "";
  let resume: ((ready: boolean) => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const off = useAuth.subscribe((state) => {
    const signedOut =
      state.status === "locked" || (state.status === "offline" && !state.hasStoredSession);
    const user = state.profile?.user_id ?? "";
    if (signedOut || (user && owner && user !== owner)) {
      discarded = true;
      controller.abort();
      resume?.(false);
    } else {
      if (user) owner = user;
      if (state.status !== "checking" && (!snapshot.ownerId || user)) resume?.(true);
    }
  });
  try {
    if (submitted.status === "checking" || (snapshot.ownerId && !submitted.profile?.user_id)) {
      if (pendingEvents.size >= MAX_PENDING_EVENTS) return "unavailable";
      const ready = await new Promise<boolean>((resolve) => {
        resume = resolve;
        pendingEvents.add(resolve);
        timeout = setTimeout(() => resolve(false), STARTUP_WAIT_MS);
        (timeout as { unref?: () => void }).unref?.();
      });
      pendingEvents.delete(resume!);
      clearTimeout(timeout);
      if (!ready || controller.signal.aborted) return discarded ? "discarded" : "unavailable";
    }
    // The authoritative OS needs an IPC round-trip; a launch beacon would otherwise race it
    // and report the user-agent's guess, which is the thing it exists to replace.
    await resolveHostInfo();
    // The server takes identity from the request, so a signed-out beacon is a guaranteed 401
    // carrying a marker we could not attribute anyway. Matters most for the heartbeat, which
    // would otherwise retry that 401 every few minutes for as long as the app is open.
    if (!(await hasSession())) return discarded ? "discarded" : "unavailable";
    if (controller.signal.aborted) return discarded ? "discarded" : "unavailable";
    const { os, arch } = hostInfo();
    timeout = setTimeout(() => controller.abort(), 10_000);
    (timeout as { unref?: () => void }).unref?.();
    let verifiedAuthorization: string | null = null;
    if (snapshot.ownerId) {
      const verification = await authedFetch(
        `${apiBase()}/me`,
        { signal: controller.signal },
        (url, init) => {
          if (controller.signal.aborted) throw new Error("event session ended before verification");
          verifiedAuthorization = new Headers(init.headers).get("Authorization");
          return fetch(url, init);
        },
      );
      if (!verification.ok || !verifiedAuthorization) return "unavailable";
      const verified = (await verification.json().catch(() => null)) as {
        user_id?: unknown;
      } | null;
      if (typeof verified?.user_id !== "string" || !verified.user_id) return "unavailable";
      if (verified.user_id !== snapshot.ownerId) return "discarded";
    }
    const response = await authedFetch(
      `${apiBase()}/telemetry/app`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event,
          os,
          arch,
          app_version: __ARTDADDY_RELEASE__,
          shell: platform.name,
          project_id: snapshot.projectId ?? "",
          ...(snapshot.ok === undefined ? {} : { ok: snapshot.ok }),
          ...(snapshot.reason ? { reason: snapshot.reason.slice(0, 300) } : {}),
          ...(snapshot.via ? { via: snapshot.via.slice(0, 30) } : {}),
          ...(snapshot.eventId ? { event_id: snapshot.eventId } : {}),
          ...(snapshot.occurredAt === undefined ? {} : { occurred_at: snapshot.occurredAt }),
        }),
        signal: controller.signal,
      },
      (url, init) => {
        if (controller.signal.aborted) throw new Error("event session ended before delivery");
        const currentUser = useAuth.getState().profile?.user_id;
        if (owner && currentUser && owner !== currentUser)
          throw new Error("event account changed before delivery");
        if (
          snapshot.ownerId &&
          new Headers(init.headers).get("Authorization") !== verifiedAuthorization
        ) {
          throw new Error("event token changed after account verification");
        }
        snapshot.onVerifiedSend?.();
        return fetch(url, init);
      },
    );
    if (!response.ok) return "unavailable";
    const result = (await response.json().catch(() => null)) as {
      ok?: unknown;
      status?: unknown;
    } | null;
    return result?.ok === true && result.status === "ok" ? "stored" : "unavailable";
  } catch {
    // Offline, signed out, server down — all fine. A marker is never worth a visible failure.
    return discarded ? "discarded" : "unavailable";
  } finally {
    if (resume) pendingEvents.delete(resume);
    clearTimeout(timeout);
    off();
  }
}

// One launch per process, and one marker per project. Without these, a reconnect loop or a
// project the user reopens all day would bury the signal in its own noise.
let launched = false;
const openedProjects = new Set<string>();

export function reportLaunchOnce(): void {
  if (launched) return;
  launched = true;
  void reportAppEvent("launch");
}

export function reportProjectOpened(projectId: string): void {
  if (!projectId || openedProjects.has(projectId)) return;
  openedProjects.add(projectId);
  void reportAppEvent("project_opened", { projectId });
}

// Getting footage in is the first thing everyone does, and the dimension guard genuinely
// refuses some files. A refusal ends the session before a prompt ever exists, so the trace
// simply stops -- indistinguishable from walking away.
//
// Failures are always reported; successes only the FIRST time per project AND WAY IN. Deduping
// on the project alone hid every later way in behind whichever came first: a recording that
// followed a file import produced no row at all, which is why "did her recording ever land?"
// could not be answered from the trace. Keyed by `via`, the hundred-file import still costs one
// beacon while each distinct door reports once.
const importedProjects = new Set<string>();

export function reportMediaImport(ok: boolean, projectId = "", reason = "", via = ""): void {
  if (ok) {
    const key = `${projectId}|${via}`;
    if (importedProjects.has(key)) return;
    importedProjects.add(key);
  }
  void reportAppEvent("media_import", { projectId, ok, reason, via });
}

/** A crash leaves no event by definition, which is what makes it the likeliest silent exit. */
export function reportAppError(reason: string, projectId = ""): void {
  if (!reason) return;
  void reportAppEvent("app_error", { projectId, ok: false, reason });
}

// Reported once per over-limit transition, not per refusal: a shot list produces a run of
// identical 402s, and counting those would say a wall was hit twenty times when it was hit once.
let reportedExhausted = false;

export function reportCreditsExhausted(reason = ""): void {
  if (reportedExhausted) return;
  reportedExhausted = true;
  void reportAppEvent("credits_exhausted", { ok: false, reason });
}

/** Called when usage drops back under the limit, so a later wall is reported again. */
export function resetCreditsExhausted(): void {
  reportedExhausted = false;
}

// Sampled: short runs are mostly model load, and all of a user's app events share one server budget.
const TRANSCRIPTION_MIN_AUDIO_S = 30;
const TRANSCRIPTION_EVERY_MS = 60_000;
let lastTranscriptionReport = -Infinity;

export function reportTranscription(facts: WhisperRunFacts, now = Date.now()): void {
  const audio = facts.audioSeconds;
  if (audio === null || audio < TRANSCRIPTION_MIN_AUDIO_S) return;
  if (now - lastTranscriptionReport < TRANSCRIPTION_EVERY_MS) return;
  lastTranscriptionReport = now;
  const wall = facts.wallSeconds;
  const figures = [
    `audio_s=${audio.toFixed(1)}`,
    wall ? `wall_s=${wall.toFixed(1)} x=${(audio / wall).toFixed(2)}` : "",
    facts.model ? `model=${facts.model}` : "",
    facts.threads ? `threads=${facts.threads}` : "",
  ];
  void reportAppEvent("transcription", {
    via: facts.backend ?? "unknown",
    reason: figures.filter(Boolean).join(" "),
  });
}

/** Tests only. */
export function __resetAppEvents(): void {
  for (const resume of pendingEvents) resume(false);
  pendingEvents.clear();
  launched = false;
  openedProjects.clear();
  importedProjects.clear();
  reportedExhausted = false;
  lastTranscriptionReport = -Infinity;
  stopHeartbeat();
}

// `launch` and `project_opened` are POINTS, and two points cannot measure a session. Someone
// editing local footage through the UI or an MCP host makes no other call for hours, so
// "opened a project and worked all afternoon" and "opened one and walked away" left byte-identical
// records. A beat every few minutes is the difference.
const HEARTBEAT_MS = 5 * 60_000;
let beat: ReturnType<typeof setInterval> | null = null;

/** Begin beating for `projectId`, replacing any previous beat. Idle by default: nothing
 *  schedules a timer until a project is actually open. */
export function startHeartbeat(projectId: string): void {
  stopHeartbeat();
  if (!projectId) return;
  beat = setInterval(() => void reportAppEvent("heartbeat", { projectId }), HEARTBEAT_MS);
  // Node/Tauri only: a bare interval would hold the process open at shutdown.
  (beat as { unref?: () => void }).unref?.();
}

export function stopHeartbeat(): void {
  if (beat) clearInterval(beat);
  beat = null;
}
