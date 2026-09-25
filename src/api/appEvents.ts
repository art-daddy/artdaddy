// Two lifecycle markers: the app started, and a project actually opened.
//
// Signing in is not evidence anybody reached the product. A tester authenticated, produced
// nothing at all, and no record anywhere could tell "opened it and hit a wall" from "never
// came back" — the account row and a refresh token were the only trace he ever left.
//
// Carries NO identity: the server takes that from the authenticated request.
import { apiBase } from "./config";
import { authHeaders } from "./auth";
import { platform } from "../platform";
import { hostInfo, resolveHostInfo } from "../platform/host";

export type AppEvent =
  "launch" | "project_opened" | "heartbeat" | "media_import" | "app_error" | "credits_exhausted";

interface AppEventDetail {
  projectId?: string;
  ok?: boolean;
  reason?: string;
}

/** Report one marker. Never throws and never blocks: this is a beacon, not a feature. */
export async function reportAppEvent(event: AppEvent, detail: AppEventDetail = {}): Promise<void> {
  try {
    // The authoritative OS needs an IPC round-trip; a launch beacon would otherwise race it
    // and report the user-agent's guess, which is the thing it exists to replace.
    await resolveHostInfo();
    const auth = await authHeaders();
    // The server takes identity from the request, so a signed-out beacon is a guaranteed 401
    // carrying a marker we could not attribute anyway. Matters most for the heartbeat, which
    // would otherwise retry that 401 every few minutes for as long as the app is open.
    if (!auth.Authorization) return;
    const { os, arch } = hostInfo();
    await fetch(`${apiBase()}/telemetry/app`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        event,
        os,
        arch,
        app_version: __ARTDADDY_RELEASE__,
        shell: platform.name,
        project_id: detail.projectId ?? "",
        ...(detail.ok === undefined ? {} : { ok: detail.ok }),
        ...(detail.reason ? { reason: detail.reason.slice(0, 300) } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Offline, signed out, server down — all fine. A marker is never worth a visible failure.
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
// Failures are always reported; successes only the FIRST time per project. A hundred-file
// import would otherwise spend the whole per-user beacon budget on one answer we already have.
const importedProjects = new Set<string>();

export function reportMediaImport(ok: boolean, projectId = "", reason = ""): void {
  if (ok) {
    if (importedProjects.has(projectId)) return;
    importedProjects.add(projectId);
  }
  void reportAppEvent("media_import", { projectId, ok, reason });
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

/** Tests only. */
export function __resetAppEvents(): void {
  launched = false;
  openedProjects.clear();
  importedProjects.clear();
  reportedExhausted = false;
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
