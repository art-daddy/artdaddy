// Tells the server one export finished. Rendering is entirely local, so this row is the only
// evidence the server ever gets that an export happened at all.
//
// It carries NO identity in its body: the server takes that from the authenticated request. A
// user id in this body would be a value the client chose, and a per-user metric the client can
// choose is not a metric. The request therefore MUST travel with the session (authedFetch);
// release 0.21.6 sent it with no credentials at all, so every report was anonymous (V2-D109).
//
// A report that cannot be delivered right now (no session, offline, the server waking, a lapsed
// session) is KEPT and sent later instead of being lost: see exportOutbox.ts for the rules, and
// `reportExport` / `flushExportReports` below for when it is sent. `owner_id` in the body is the
// account the report was queued under: a claim the server checks against the session, never an
// identity it takes from the body.
import { apiBase } from "./config";
import { authedFetch, hasSession } from "./auth";
import {
  lastKnownUser,
  noteFailure,
  pendingReports,
  queueReport,
  rememberUser,
  removeReport,
  type PendingReport,
  type ReportBody,
} from "./exportOutbox";
import { platform } from "../platform";
import { hostInfo } from "../platform/host";
import { useAuth } from "../store/auth";
import { signedInUser } from "./exportOwner";

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
  /** How long the export's last run took, ms, as the app process measured it. `elapsed_ms` runs from
   *  SUBMISSION, so it also counts every minute the app was not running; a speed figure wants this one.
   *  0 when unknown. */
  active_ms?: number;
  /** True when a later launch of the app finished an export an earlier launch had started: the app
   *  ended mid-export (crash, force-quit, shutdown, power loss) and the export was picked up again.
   *  `elapsed_ms` then spans the downtime, which can be days. */
  recovered?: boolean;
  /** The account that asked for this export, captured when it was admitted (exportQueue.ts). It is
   *  what the report is filed under, even when the export ends after a different account has signed
   *  in. Absent for a refusal, and for an export an older build admitted: then whoever is signed in. */
  owner?: string;
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

const REPORT_STATUSES = ["done", "failed", "cancelled", "blocked", "declined"] as const;
const READINESS = ["ready", "not_ready", "unknown"] as const;

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** THE allow-list: the only place a report body is shaped, for a report just built AND for one read
 *  back from storage, so neither can send a field the server does not know or a number outside its
 *  bound (it refuses the whole row for either). Null when `input` is not a report at all. */
export function composeBody(input: Record<string, unknown>): ReportBody | null {
  const status = input.status;
  if (typeof status !== "string" || !(REPORT_STATUSES as readonly string[]).includes(status))
    return null;
  return {
    status,
    duration_s: bounded(input.duration_s, 86_400),
    size_bytes: Math.round(bounded(input.size_bytes, 1e13)),
    elapsed_ms: Math.round(bounded(input.elapsed_ms, 10_000_000_000)),
    active_ms: Math.round(bounded(input.active_ms, 10_000_000_000)),
    recovered: input.recovered === true,
    width: Math.round(bounded(input.width, 16_384)),
    height: Math.round(bounded(input.height, 16_384)),
    fps: bounded(input.fps, 1_000),
    quality: String(input.quality ?? "").slice(0, 20),
    warnings: Math.round(bounded(input.warnings, 10_000)),
    error: boundedError(String(input.error ?? "")),
    project_id: String(input.project_id ?? "").slice(0, 200),
    reason_code: oneOf(EXPORT_REASON_CODES, input.reason_code, "unknown"),
    operation: oneOf(EXPORT_OPERATIONS, input.operation, "unknown"),
    project_size_band: oneOf(EXPORT_SIZE_BANDS, input.project_size_band, "unknown"),
    readiness: oneOf(READINESS, input.readiness, "unknown"),
    app_version: String(input.app_version ?? "").slice(0, 20),
    platform: String(input.platform ?? "").slice(0, 20),
    arch: String(input.arch ?? "").slice(0, 20),
    shell: String(input.shell ?? "").slice(0, 20),
  };
}

/** The body for one finished export. Named fields, never `...ev`: an export or job object spread
 *  into the body would send whatever fields it ever grows. Which build and which OS is the client's
 *  to state, not the caller's, so no call site can get them wrong or leave them out, and they are
 *  captured HERE: a report sent a week later still names the build that ran the export.
 *  `platform` is the SHELL (tauri/web); the OS is what a per-platform failure is read by. */
function buildBody(ev: ExportEvent): ReportBody {
  const body = composeBody({
    status: REPORT_STATUSES.includes(ev.status) ? ev.status : "failed",
    duration_s: ev.duration_s,
    size_bytes: ev.size_bytes,
    elapsed_ms: ev.elapsed_ms,
    active_ms: ev.active_ms,
    recovered: ev.recovered,
    width: ev.width,
    height: ev.height,
    fps: ev.fps,
    quality: ev.quality,
    warnings: ev.warnings,
    error: ev.error,
    project_id: ev.project_id,
    reason_code: reasonFor(ev),
    operation: ev.operation,
    project_size_band: sizeBand(ev),
    readiness: ev.readiness,
    app_version: __ARTDADDY_RELEASE__,
    platform: hostInfo().os,
    arch: hostInfo().arch,
    shell: platform.name,
  });
  if (!body) throw new Error("an export report always has a status");
  return body;
}

function newReportId(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** What delivering one report came to:
 *  - stored   the server confirmed it has the report. Nothing more to do.
 *  - dropped  it can never be accepted (the server refused the body, or it is not a report):
 *             sending it again would only fail again.
 *  - blocked  nobody who may send it is signed in right now (nobody, or a different account): it
 *             waits for its own account.
 *  - retry    the network or the server was not there: try again shortly.
 *  - failed   the server answered that it could not store it: it goes to the back of the queue and is
 *             tried again, and never given up on for that (see exportOutbox.ts). */
type Outcome = "stored" | "dropped" | "blocked" | "retry" | "failed";

async function classify(response: Response): Promise<Outcome> {
  const code = response.status;
  if (code === 401 || code === 403) return "blocked";
  // The report is claimed by a different account than the session that carried it: that is a fact
  // about who is signed in right now, not about the report, so it waits for its own account.
  if (code === 409) return "blocked";
  if (code === 408 || code === 425 || code === 429 || code >= 500) return "retry";
  if (!response.ok) return "dropped";
  // The route answers 200 whether or not the row was written; only `ok` says it was. A body that is
  // not the route's JSON at all (a captive portal's page, an empty body) says nothing about it: we
  // were not talking to the server, so that is a moment to try again, not a failure it reported.
  const answer = (await response.json().catch(() => null)) as {
    ok?: unknown;
    status?: unknown;
  } | null;
  if (answer === null || typeof answer !== "object") return "retry";
  if (answer.ok === true) return "stored";
  if (answer.status === "ignored") return "dropped";
  if (answer.status === "rate_limited") return "retry";
  return "failed";
}

/** The session that was signed in when a report was about to be sent is not any more: another
 *  account signed in, or the session ended, while its token was being fetched. */
class SessionChanged extends Error {}

async function deliver(report: PendingReport): Promise<Outcome> {
  const body = composeBody(report.body);
  if (!body) return "dropped";
  const user = signedInUser();
  // Another account is signed in on this machine: this report waits for its own.
  if (user && report.owner && user !== report.owner) return "blocked";
  try {
    // Signed out: there is no account to file the row under and the server would answer 401.
    if (!(await hasSession())) return "blocked";
    const response = await authedFetch(
      `${apiBase()}/telemetry/export`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...body,
          event_id: report.id,
          occurred_at: report.at,
          ...(report.owner ? { owner_id: report.owner } : {}),
        }),
        // A background beacon must not be able to hang a shutdown drain on a stalled socket.
        signal: AbortSignal.timeout(10_000),
      },
      (target, request) => {
        // Fetching the session's token takes time, and in it another account can sign in or the
        // session can end: look again as late as possible, at the token this request carries. A
        // report is never sent without a session, and never under another account's: a server that
        // predates owner checks would file it under whoever's token it sees.
        const carried = new Headers(request.headers).has("Authorization");
        const now = signedInUser();
        if (!carried || (now && report.owner && now !== report.owner)) throw new SessionChanged();
        return fetch(target, request);
      },
    );
    return await classify(response);
  } catch (error) {
    // Offline, server down, a session that cannot be renewed right now. Deliberately NOT
    // notifyAuthFailure(): a background beacon must not be able to throw the sign-in screen at
    // someone mid-edit.
    return error instanceof SessionChanged ? "blocked" : "retry";
  }
}

function settle(report: PendingReport, outcome: Outcome): void {
  if (outcome === "stored" || outcome === "dropped") removeReport(report.id);
  else if (outcome === "failed") noteFailure(report.id);
}

// Where a report that was not delivered gets another try. Nothing here runs until
// installExportReportDelivery() has: a test, or a module that merely imports this file, starts no
// timer and listens for nothing.
const RETRY_AFTER_MS = [30_000, 120_000, 300_000, 900_000, 1_800_000];
const BLOCKED_RETRY_MS = 900_000;
const NEXT_BATCH_MS = 20_000;
/** Per flush, so a long backlog cannot spend the account's telemetry budget (30 events a minute,
 *  shared with everything else the app reports) in one minute: five every 20 seconds is 15. */
const FLUSH_BATCH = 5;

let removeDelivery: (() => void) | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDueAt = 0;
let retryStep = 0;
let flushing: Promise<void> | null = null;
let flushAgain = false;
const delivering = new Set<string>();

/** Look again later: soon after a failure, a long way off when nobody can send. One timer is ever
 *  armed, and a sooner request replaces a later one, so waiting for a sign-in never delays the retry
 *  of a server that was merely down. */
function scheduleRetry(why: "retry" | "failed" | "blocked" | "more"): void {
  if (!removeDelivery) return;
  const growing = why === "retry" || why === "failed";
  const delay =
    why === "more"
      ? NEXT_BATCH_MS
      : why === "blocked"
        ? BLOCKED_RETRY_MS
        : RETRY_AFTER_MS[Math.min(retryStep, RETRY_AFTER_MS.length - 1)];
  const due = Date.now() + delay;
  if (retryTimer) {
    if (retryDueAt <= due) return; // the one already armed fires soon enough
    clearTimeout(retryTimer);
  }
  if (growing) retryStep++;
  retryDueAt = due;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void flushExportReports();
  }, delay);
  (retryTimer as { unref?: () => void }).unref?.();
}

/** How many times in a row the server may say it cannot store a report before a pass stops asking:
 *  one that never goes through is skipped over, but a server that fails everything is not asked
 *  report after report. */
const FAILURES_PER_PASS = 2;

async function drain(): Promise<void> {
  let sent = 0;
  let failedInARow = 0;
  let anyFailed = false;
  // Reports the server failed to store go to the back, so one that never goes through cannot hold
  // up the rest (a stable sort: the rest keep their order, oldest first).
  const queue = pendingReports().sort((a, b) => a.failedAt - b.failedAt);
  for (const report of queue) {
    if (delivering.has(report.id)) continue;
    const user = signedInUser();
    if (user && user !== report.owner) continue; // waits for its own account
    if (sent >= FLUSH_BATCH) return scheduleRetry("more");
    delivering.add(report.id);
    let outcome: Outcome;
    try {
      outcome = await deliver(report);
    } finally {
      delivering.delete(report.id);
    }
    settle(report, outcome);
    if (outcome === "stored") {
      sent++;
      failedInARow = 0;
      retryStep = 0;
    } else if (outcome === "failed") {
      anyFailed = true;
      if (++failedInARow >= FAILURES_PER_PASS) return scheduleRetry("failed");
    } else if (outcome !== "dropped") {
      // Nobody who could send it is there, or the server is not: the rest would meet the same.
      return scheduleRetry(outcome);
    }
  }
  if (anyFailed) scheduleRetry("failed");
}

/** Send the reports still waiting. One pass at a time, oldest first. A call made while a pass is
 *  running is not folded into it: it may be exactly what changed (an account signed in, the network
 *  came back) after that pass had already decided what it could send, so it earns another pass once
 *  the running one ends. Never throws. */
export function flushExportReports(): Promise<void> {
  if (flushing) {
    flushAgain = true;
    return flushing;
  }
  flushing = (async () => {
    try {
      do {
        flushAgain = false;
        await drain();
      } while (flushAgain);
    } catch {
      /* the next trigger tries again */
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

/** Report one finished export. Never throws and never blocks anything: by the time this runs
 *  the user's file is already on disk, so a telemetry failure must be invisible to them.
 *
 *  The report is written to the outbox BEFORE it is sent and removed only when the server confirms
 *  it, so what cannot be delivered now is delivered later instead of lost. It is filed under the
 *  account that asked for the export (`ev.owner`, captured when it was admitted), else the account
 *  signed in now, else the one this device last saw. It is only kept under an account: with nobody
 *  known to have run the export it is sent now or not at all, because filing it under whoever signs
 *  in next would be a guess. */
export async function reportExport(ev: ExportEvent): Promise<void> {
  try {
    const user = signedInUser();
    if (user) rememberUser(user);
    const body = buildBody(ev);
    const report: PendingReport = {
      id: newReportId(),
      owner: ev.owner || user || lastKnownUser(),
      at: Date.now() / 1000,
      failedAt: 0,
      // An export that never started: worth reporting, never worth a place a real export needs.
      disposable: body.status === "blocked" || body.status === "declined",
      body,
    };
    if (report.owner) queueReport(report);
    delivering.add(report.id);
    let outcome: Outcome;
    try {
      outcome = await deliver(report);
    } finally {
      delivering.delete(report.id);
    }
    settle(report, outcome);
    if (outcome === "stored") void flushExportReports();
    else if (outcome !== "dropped") scheduleRetry(outcome);
  } catch {
    // A report that cannot even be built or kept is not worth an exception in the exporter.
  }
}

/** Start delivering kept reports whenever delivery has a chance: when someone signs in or the
 *  account changes, when the network returns, shortly after a failure, and once now for what the
 *  last run left behind. Also remembers which account is signed in, so a report built while no
 *  profile is loaded yet (an export a later launch finished) still names the right one. */
export function installExportReportDelivery(): () => void {
  if (removeDelivery) return removeDelivery;
  const note = () => {
    const user = signedInUser();
    if (user) rememberUser(user);
  };
  const flushNow = () => {
    retryStep = 0;
    void flushExportReports();
  };
  note();
  const unsubscribe = useAuth.subscribe((state, previous) => {
    note();
    if (state.status !== previous.status || state.profile?.user_id !== previous.profile?.user_id)
      flushNow();
  });
  globalThis.addEventListener?.("online", flushNow);
  const stop = () => {
    unsubscribe();
    globalThis.removeEventListener?.("online", flushNow);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    removeDelivery = null;
  };
  removeDelivery = stop;
  void flushExportReports();
  return stop;
}

/** Tests only. */
export function __resetExportReports(): void {
  removeDelivery?.();
  retryStep = 0;
  flushing = null;
  flushAgain = false;
  delivering.clear();
}
