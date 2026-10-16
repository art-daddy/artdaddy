// Tells the server one export finished. Rendering is entirely local, so this row is the only
// evidence the server ever gets that an export happened at all.
//
import { apiBase } from "./config";
import { platform } from "../platform";
import { hostInfo } from "../platform/host";

export const EXPORT_REASON_CODES = [
  "none", "source_unavailable", "storage_unavailable", "storage_full", "memory_limit", "time_limit",
  "verification_failed", "render_failed", "interrupted", "cancelled", "declined", "unknown",
] as const;
export const EXPORT_SIZE_BANDS = ["hd", "4k", "heavy_hd", "other", "unknown"] as const;
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
}

/** Legacy request-text bound retained for mixed-version compatibility. This collector sends no raw error text. */
export const MAX_EXPORT_ERROR = 300;

function reasonFor(ev: ExportEvent): ExportReasonCode {
  if (ev.status === "done") return "none";
  if (ev.status === "cancelled") return "cancelled";
  if (ev.status === "declined") return "declined";
  if (EXPORT_REASON_CODES.includes(ev.reason_code as ExportReasonCode)) return ev.reason_code!;
  const error = String(ev.error ?? "").slice(0, 32_768).toLowerCase();
  if (/no space left|enospc|disk.*full/.test(error)) return "storage_full";
  if (/no such file|source.*(?:missing|unavailable)|enoent/.test(error)) return "source_unavailable";
  if (/permission denied|access is denied|eacces|read.only|destination.*unavailable/.test(error)) return "storage_unavailable";
  if (/memory.*(?:budget|limit|exceeded)|cannot allocate memory|out of memory/.test(error)) return "memory_limit";
  if (/deadline|execution.*expired|timed out/.test(error)) return "time_limit";
  if (/artifact|verification|frame.*count|duration.*mismatch/.test(error)) return "verification_failed";
  if (/interrupted|restart|crash/.test(error)) return "interrupted";
  if (/ffmpeg|encoder|render/.test(error)) return "render_failed";
  return "unknown";
}

function sizeBand(ev: ExportEvent): ExportSizeBand {
  if (EXPORT_SIZE_BANDS.includes(ev.project_size_band as ExportSizeBand)) return ev.project_size_band!;
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
    const reason = reasonFor(ev);
    const elapsed = Number(ev.elapsed_ms ?? 0);
    await fetch(`${apiBase()}/telemetry/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Which build and which OS is the client's to state, not the caller's — every export
      // reports them the same way, so no call site can get them wrong or leave them out.
      // `platform` is the SHELL (tauri/web); the OS is what a per-platform failure is read by.
      body: JSON.stringify({
        status: ["done", "failed", "cancelled", "blocked", "declined"].includes(ev.status) ? ev.status : "failed",
        elapsed_ms: Number.isFinite(elapsed) ? Math.round(Math.max(0, Math.min(elapsed, 10_000_000_000))) : 0,
        reason_code: reason,
        project_size_band: sizeBand(ev),
        readiness: ["ready", "not_ready", "unknown"].includes(ev.readiness ?? "") ? ev.readiness
          : ev.status === "done" ? "ready"
          : ["source_unavailable", "storage_unavailable", "storage_full"].includes(reason) ? "not_ready" : "unknown",
        app_version: __ARTDADDY_RELEASE__,
        platform: hostInfo().os,
        arch: hostInfo().arch,
        shell: platform.name,
      }),
      credentials: "omit",
      referrerPolicy: "no-referrer",
      // A background beacon must not be able to hang a shutdown drain on a stalled socket.
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Offline, signed out, server down — all fine. Deliberately NOT notifyAuthFailure(): a
    // background beacon must not be able to throw the sign-in screen at someone mid-edit.
  }
}
