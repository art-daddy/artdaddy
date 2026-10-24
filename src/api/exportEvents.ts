// Tells the server one export finished. Rendering is entirely local, so this row is the only
// evidence the server ever gets that an export happened at all.
//
// It carries NO identity in its body: the server takes that from the authenticated request. A
// user id in this body would be a value the client chose, and a per-user metric the client can
// choose is not a metric. The request therefore MUST travel with the session (authedFetch);
// release 0.21.6 sent it with no credentials at all, so every report was anonymous (V2-D109).
import { apiBase } from "./config";
import { authedFetch, hasSession } from "./auth";
import { platform } from "../platform";
import { hostInfo } from "../platform/host";

export const EXPORT_REASON_CODES = [
  "none",
  "source_unavailable",
  "storage_unavailable",
  "storage_full",
  "memory_limit",
  "time_limit",
  "verification_failed",
  "render_failed",
  "interrupted",
  "cancelled",
  "declined",
  "unknown",
] as const;
export const EXPORT_SIZE_BANDS = ["hd", "4k", "heavy_hd", "other", "unknown"] as const;
export const EXPORT_OPERATIONS = ["render", "copy", "unknown"] as const;
export type ExportReasonCode = (typeof EXPORT_REASON_CODES)[number];
export type ExportSizeBand = (typeof EXPORT_SIZE_BANDS)[number];

export interface ExportEvent {
  /** Terminal state only — a running export has nothing to report yet. */
  status: "done" | "failed" | "cancelled" | "blocked" | "declined";
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
  reason_code?: ExportReasonCode;
  project_size_band?: ExportSizeBand;
  readiness?: "ready" | "not_ready" | "unknown";
  visual_layers?: number;
  operation?: (typeof EXPORT_OPERATIONS)[number];
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

/** A non-negative number within the server's bound for it. The server refuses a number outside
 *  its bound, which drops the whole row, so the client clamps rather than lose the report. */
function bounded(value: unknown, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(n, max)) : 0;
}

function reasonFor(ev: ExportEvent): ExportReasonCode {
  if (ev.status === "done") return "none";
  if (ev.status === "cancelled") return "cancelled";
  if (ev.status === "declined") return "declined";
  if (EXPORT_REASON_CODES.includes(ev.reason_code as ExportReasonCode)) return ev.reason_code!;
  const error = String(ev.error ?? "")
    .slice(0, 32_768)
    .toLowerCase();
  if (/no space left|enospc|disk.*full/.test(error)) return "storage_full";
  if (
    /no such file|source.*(?:missing|unavailable)|enoent|\bis offline\b|\bmedia files? (?:are|is) offline\b|still (?:being )?generat(?:ing|ed)|failed to generate|is not in the library/.test(
      error,
    )
  )
    return "source_unavailable";
  if (/permission denied|access is denied|eacces|read.only|destination.*unavailable/.test(error))
    return "storage_unavailable";
  if (/memory.*(?:budget|limit|exceeded)|cannot allocate memory|out of memory/.test(error))
    return "memory_limit";
  if (/deadline|execution.*expired|timed out/.test(error)) return "time_limit";
  if (/artifact|verification|frame.*count|duration.*mismatch/.test(error))
    return "verification_failed";
  if (/interrupted|restart|crash/.test(error)) return "interrupted";
  if (/ffmpeg|encoder|render/.test(error)) return "render_failed";
  return "unknown";
}

function sizeBand(ev: ExportEvent): ExportSizeBand {
  if (EXPORT_SIZE_BANDS.includes(ev.project_size_band as ExportSizeBand))
    return ev.project_size_band!;
  const short = Math.min(ev.width ?? 0, ev.height ?? 0);
  const long = Math.max(ev.width ?? 0, ev.height ?? 0);
  if (!(short > 0 && Number.isFinite(short) && Number.isFinite(long))) return "unknown";
  if (short <= 1080 && long <= 1920) return (ev.visual_layers ?? 0) > 4 ? "heavy_hd" : "hd";
  return short <= 2160 && long <= 3840 ? "4k" : "other";
}

/** Report one finished export. Never throws and never blocks anything: by the time this runs
 *  the user's file is already on disk, so a telemetry failure must be invisible to them. */
export async function reportExport(ev: ExportEvent): Promise<void> {
  try {
    // Signed out: there is no account to file the row under and the server would answer 401, so
    // a beacon sends nothing rather than a guaranteed refusal.
    if (!(await hasSession())) return;
    await authedFetch(`${apiBase()}/telemetry/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // An explicit allow-list, never `...ev`: an export or job object spread into the body
      // would send whatever fields it ever grows. Which build and which OS is the client's to
      // state, not the caller's, so no call site can get them wrong or leave them out.
      // `platform` is the SHELL (tauri/web); the OS is what a per-platform failure is read by.
      body: JSON.stringify({
        status: ["done", "failed", "cancelled", "blocked", "declined"].includes(ev.status)
          ? ev.status
          : "failed",
        duration_s: bounded(ev.duration_s, 86_400),
        size_bytes: Math.round(bounded(ev.size_bytes, 1e13)),
        elapsed_ms: Math.round(bounded(ev.elapsed_ms, 10_000_000_000)),
        width: Math.round(bounded(ev.width, 16_384)),
        height: Math.round(bounded(ev.height, 16_384)),
        fps: bounded(ev.fps, 1_000),
        quality: String(ev.quality ?? "").slice(0, 20),
        warnings: Math.round(bounded(ev.warnings, 10_000)),
        error: boundedError(ev.error),
        project_id: String(ev.project_id ?? "").slice(0, 200),
        reason_code: reasonFor(ev),
        operation: EXPORT_OPERATIONS.includes(ev.operation as (typeof EXPORT_OPERATIONS)[number])
          ? ev.operation
          : "unknown",
        project_size_band: sizeBand(ev),
        readiness: ["ready", "not_ready", "unknown"].includes(ev.readiness ?? "")
          ? ev.readiness
          : "unknown",
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
