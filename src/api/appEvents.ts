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

export type AppEvent = "launch" | "project_opened";

/** Report one marker. Never throws and never blocks: this is a beacon, not a feature. */
export async function reportAppEvent(event: AppEvent, projectId = ""): Promise<void> {
  try {
    // The authoritative OS needs an IPC round-trip; a launch beacon would otherwise race it
    // and report the user-agent's guess, which is the thing it exists to replace.
    await resolveHostInfo();
    const { os, arch } = hostInfo();
    await fetch(`${apiBase()}/telemetry/app`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({
        event,
        os,
        arch,
        app_version: __ARTDADDY_RELEASE__,
        shell: platform.name,
        project_id: projectId,
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
  void reportAppEvent("project_opened", projectId);
}

/** Tests only. */
export function __resetAppEvents(): void {
  launched = false;
  openedProjects.clear();
}
