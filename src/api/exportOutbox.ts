// Export reports the app could not deliver yet, kept on this device until they can be.
//
// A report that fails to send was simply lost: no session at that moment (an export that a later
// launch finished, the app offline with a stored session, a session that lapsed mid-export), a
// server waking from idle, a dropped connection. This is where such a report waits.
//
// The rules that keep it honest:
//  - WRITE FIRST. A report is stored before it is sent and removed only once the server confirms it
//    stored it, so a crash or a quit between the two loses nothing. The send can then happen twice
//    (the answer never arrived); the server writes one row per (account, `id`), so a second send of
//    the same report counts once.
//  - AN ACCOUNT'S OWN. Every report names the account that ran the export, and is only ever sent
//    under that account's session. Another account signing in on the same machine neither sends nor
//    sees it.
//  - BOUNDED. At most MAX_PENDING_REPORTS, none older than MAX_REPORT_AGE_MS (expired ones are
//    erased from storage, not merely ignored), so nothing here can grow without limit or retry
//    forever. A report of an export that really ran is never pushed out by refusal telemetry
//    (`disposable`), which a single agent call can produce 50 of at once. A report is NOT given up
//    on because the server failed to store it: that is usually the server's trouble, not the
//    report's. It goes to the back of the queue (`failedAt`) and is tried again until it expires.
//  - NEVER FATAL. Storage that is full, disabled or corrupt means a report is not kept; it never
//    means the export fails, and one unreadable entry never costs the others.
//
// Holds only what the report already says (counts, sizes, a bounded error text) plus the account's
// id, the same fields the app sends, for at most 14 days (the account id: 30 days since last seen).
// One window is assumed (the desktop app has one): a second context writing in the same instant
// could lose a write, as with any read-modify-write over localStorage.

export const OUTBOX_KEY = "artdaddy.exportReports.v1";

/** The server believes a report's own clock only for 15 days (EXPORT_LATE_WINDOW_S), so one held
 *  longer could no longer be filed under the day it happened. */
export const MAX_REPORT_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_PENDING_REPORTS = 50;
/** How long the last signed-in account is remembered without being seen again. */
export const LAST_USER_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const LAST_USER_REFRESH_MS = 24 * 60 * 60 * 1000;

const MAX_BODY_KEYS = 40;
const MAX_BODY_TEXT = 400;
const REPORT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export type ReportBody = Record<string, string | number | boolean>;

export interface PendingReport {
  /** The report's name (`event_id` on the wire): the server writes one row per account and id. */
  id: string;
  /** The account that ran the export. */
  owner: string;
  /** When the export ended, epoch seconds. */
  at: number;
  /** When the server last answered that it could not store this report, epoch ms; 0 = never. A
   *  report that keeps failing sorts after the ones that do not, so it cannot hold them up. */
  failedAt: number;
  /** Refusal telemetry: an export that never started. First out when the outbox is full, and never
   *  admitted at the cost of a report of an export that really ran. */
  disposable: boolean;
  body: ReportBody;
}

interface Stored {
  v: 1;
  /** The account the app last saw signed in: who a report belongs to when none is signed in now. */
  lastUser: string;
  /** When it was last seen, epoch ms. */
  lastUserAt: number;
  reports: PendingReport[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** A body this module could have written: flat, primitive, bounded. Anything else is not ours. */
function flatBody(value: unknown): ReportBody | null {
  if (!isRecord(value)) return null;
  const out: ReportBody = {};
  let keys = 0;
  for (const [key, field] of Object.entries(value)) {
    if (++keys > MAX_BODY_KEYS || key === "__proto__") return null;
    if (typeof field === "string") {
      if (field.length > MAX_BODY_TEXT) return null;
      out[key] = field;
    } else if (
      typeof field === "boolean" ||
      (typeof field === "number" && Number.isFinite(field))
    ) {
      out[key] = field;
    } else {
      return null;
    }
  }
  return out;
}

function asReport(value: unknown): PendingReport | null {
  if (!isRecord(value)) return null;
  const { id, owner, at, failedAt, disposable } = value;
  if (typeof id !== "string" || !REPORT_ID.test(id)) return null;
  if (typeof owner !== "string" || owner.length < 1 || owner.length > 200) return null;
  if (typeof at !== "number" || !Number.isFinite(at) || at < 0 || at > 253_402_300_799) return null;
  // Absent is fine (nothing failed yet, a real export); present and not what we wrote is not.
  if (
    failedAt !== undefined &&
    (typeof failedAt !== "number" || !Number.isFinite(failedAt) || failedAt < 0)
  )
    return null;
  if (disposable !== undefined && typeof disposable !== "boolean") return null;
  const body = flatBody(value.body);
  return body
    ? {
        id,
        owner,
        at,
        failedAt: (failedAt as number | undefined) ?? 0,
        disposable: disposable === true,
        body,
      }
    : null;
}

/** What is stored, each report checked on its own: an entry that is unreadable, expired or not what
 *  this module wrote is dropped alone, never at the cost of the others. `changed` says the stored
 *  text is not what it should be (something was dropped, or it was damaged), so a caller that only
 *  reads can still erase it: an expired report must not outlive its retention on disk. */
function load(store: Storage, now: number): { state: Stored; changed: boolean } {
  let text: string | null = null;
  let parsed: unknown = null;
  try {
    text = store.getItem(OUTBOX_KEY);
    parsed = JSON.parse(text ?? "null");
  } catch {
    parsed = null;
  }
  const root = isRecord(parsed) ? parsed : {};
  const seenAt =
    typeof root.lastUserAt === "number" && Number.isFinite(root.lastUserAt) ? root.lastUserAt : 0;
  const remembered =
    typeof root.lastUser === "string" && root.lastUser.length <= 200 ? root.lastUser : "";
  const fresh = now - seenAt <= LAST_USER_LIFETIME_MS;
  const seen = new Set<string>();
  const reports: PendingReport[] = [];
  for (const entry of Array.isArray(root.reports) ? root.reports : []) {
    const report = asReport(entry);
    if (!report || seen.has(report.id)) continue;
    if (now - report.at * 1000 > MAX_REPORT_AGE_MS) continue;
    seen.add(report.id);
    reports.push(report);
  }
  const state: Stored = {
    v: 1,
    lastUser: fresh ? remembered : "",
    lastUserAt: fresh && remembered ? seenAt : 0,
    reports: reports.slice(-MAX_PENDING_REPORTS),
  };
  return { state, changed: text !== null && text !== JSON.stringify(state) };
}

function read(store: Storage, now: number): Stored {
  return load(store, now).state;
}

function write(store: Storage, state: Stored): boolean {
  try {
    store.setItem(OUTBOX_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false; // full or disabled: the report is not kept, and nothing else suffers
  }
}

/** Read, and erase whatever should no longer be there. */
function readAndPrune(store: Storage, now: number): Stored {
  const { state, changed } = load(store, now);
  if (changed) write(store, state);
  return state;
}

/** Keep `report` until it is confirmed delivered. False when it could not be kept: storage is
 *  unavailable, it is not a report this module could read back, or it is refusal telemetry and the
 *  outbox is full of reports of exports that really ran. */
export function queueReport(report: PendingReport, now = Date.now()): boolean {
  const store = storage();
  const valid = asReport(report);
  if (!store || !valid) return false;
  try {
    const state = read(store, now);
    const others = state.reports.filter((existing) => existing.id !== valid.id);
    const kept = [...others, valid];
    while (kept.length > MAX_PENDING_REPORTS) {
      // Refusal telemetry goes first, oldest first; a report of a real export is only ever pushed
      // out by a newer one of the same kind.
      const victim = kept.findIndex((existing) => existing.disposable && existing !== valid);
      if (victim >= 0) kept.splice(victim, 1);
      else if (valid.disposable) return false;
      else kept.shift();
    }
    return write(store, { ...state, reports: kept });
  } catch {
    return false;
  }
}

/** Every report still waiting, oldest first. */
export function pendingReports(now = Date.now()): PendingReport[] {
  const store = storage();
  if (!store) return [];
  try {
    return readAndPrune(store, now).reports;
  } catch {
    return [];
  }
}

export function removeReport(id: string, now = Date.now()): void {
  const store = storage();
  if (!store) return;
  try {
    const state = read(store, now);
    if (state.reports.some((report) => report.id === id))
      write(store, { ...state, reports: state.reports.filter((report) => report.id !== id) });
  } catch {
    /* nothing to undo */
  }
}

/** The server answered that it could not store `id`. The report is kept, and sorts after the ones
 *  that have not failed, so it is tried again without holding anything up. */
export function noteFailure(id: string, now = Date.now()): void {
  const store = storage();
  if (!store) return;
  try {
    const state = read(store, now);
    if (!state.reports.some((report) => report.id === id)) return;
    write(store, {
      ...state,
      reports: state.reports.map((report) =>
        report.id === id ? { ...report, failedAt: now } : report,
      ),
    });
  } catch {
    /* best effort */
  }
}

export function rememberUser(userId: string, now = Date.now()): void {
  if (!userId || userId.length > 200) return;
  const store = storage();
  if (!store) return;
  try {
    const state = read(store, now);
    // Written when it changes, and about daily while it stays the same: it only has to outlive
    // LAST_USER_LIFETIME_MS between sightings.
    if (state.lastUser !== userId || now - state.lastUserAt > LAST_USER_REFRESH_MS)
      write(store, { ...state, lastUser: userId, lastUserAt: now });
  } catch {
    /* best effort */
  }
}

export function lastKnownUser(now = Date.now()): string {
  const store = storage();
  if (!store) return "";
  try {
    return readAndPrune(store, now).lastUser;
  } catch {
    return "";
  }
}

/** Tests only. */
export function clearOutbox(): void {
  try {
    storage()?.removeItem(OUTBOX_KEY);
  } catch {
    /* nothing to clear */
  }
}
