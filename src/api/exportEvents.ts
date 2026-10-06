// Tells the server one export finished. Rendering is entirely local, so this row is the only
// evidence the server ever gets that an export happened at all.
//
// It carries NO identity: the server takes that from the authenticated request. A user id in
// this body would be a value the client chose, and a per-user metric the client can choose is
// not a metric.
import { apiBase } from "./config";
import { authHeaders } from "./auth";
import { platform } from "../platform";
import { hostInfo } from "../platform/host";

export interface ExportEvent {
  /** Terminal state only — a running export has nothing to report yet. */
  status: "done" | "failed" | "cancelled";
  /** Length of the delivered video, seconds. */
  duration_s?: number;
  /** Size of the delivered file, bytes. 0 when it never got written. */
  size_bytes?: number;
  /** Wall-clock the encode took, ms. */
  elapsed_ms?: number;
  width?: number;
  height?: number;
  fps?: number;
  quality?: string;
  warnings?: number;
  error?: string;
  project_id?: string;
}

/** The server's bound on `error` (ExportEventBody, pinned by the server's tests). Over it, a
 *  server that refuses long text dropped the whole row: every failed export went unreported. */
export const MAX_EXPORT_ERROR = 300;

/** A failure's text within the bound, keeping both ends: the exit code and cause come first, and
 *  ffmpeg's verdict ("Conversion failed!") last. */
function boundedError(error: string | undefined): string {
  const e = error ?? "";
  if (e.length <= MAX_EXPORT_ERROR) return e;
  const marker = " ... ";
  const head = Math.floor(((MAX_EXPORT_ERROR - marker.length) * 3) / 5);
  const tail = MAX_EXPORT_ERROR - marker.length - head;
  return e.slice(0, head) + marker + e.slice(e.length - tail);
}

/** Report one finished export. Never throws and never blocks anything: by the time this runs
 *  the user's file is already on disk, so a telemetry failure must be invisible to them. */
export async function reportExport(ev: ExportEvent): Promise<void> {
  try {
    await fetch(`${apiBase()}/telemetry/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      // Which build and which OS is the client's to state, not the caller's — every export
      // reports them the same way, so no call site can get them wrong or leave them out.
      // `platform` is the SHELL (tauri/web); the OS is what a per-platform failure is read by.
      body: JSON.stringify({
        ...ev,
        error: boundedError(ev.error),
        app_version: __ARTDADDY_RELEASE__,
        platform: hostInfo().os,
        arch: hostInfo().arch,
        shell: platform.name,
      }),
      // A background beacon must not be able to hang a shutdown drain on a stalled socket.
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Offline, signed out, server down — all fine. Deliberately NOT notifyAuthFailure(): a
    // background beacon must not be able to throw the sign-in screen at someone mid-edit.
  }
}
