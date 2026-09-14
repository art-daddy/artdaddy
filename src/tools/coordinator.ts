// Per-project serial write coordinator — the TS analog of other NLEs' macOS
// `ProjectPackageCoordinator` (NSFileCoordinator + NSDocument). It serializes the
// read-modify-write of a project's shared manifests (timeline.json, library.json,
// project.json) so that the three writers that can overlap —
//   • an agent turn (a tool mutating the timeline / library / project),
//   • a manual UI edit or drag-drop import, and
//   • the background IndexCoordinator's follow-on work,
// can't interleave two RMWs and silently drop one's update (a LOST UPDATE).
//
// Atomic temp+rename (`writeTextAtomic`) already prevents TORN reads (a reader
// never sees a half-written file); this queue is the missing half — it prevents
// two concurrent load→mutate→save cycles from clobbering each other.
//
// Contract: gate at the OPERATION boundary (the whole load→mutate→save), NEVER at
// the write primitive, so the lock is never re-entered inside one op (the serial
// chain would otherwise deadlock on a nested acquire). Reads stay lock-free:
// atomic writes + loadTimeline's retry make a standalone read see old-complete or
// new-complete, and every mutation re-reads under the lock, so a stale read can't
// corrupt a subsequent edit.

/** Tail of the in-flight chain per normalized project dir. The next op `.then`s
 *  off this; it is kept non-rejecting so one failed op never breaks the chain. */
const tails = new Map<string, Promise<unknown>>();

/** Normalize a project dir to a stable key so callers that pass POSIX- vs
 *  backslash-separated (or trailing-slashed) forms of the SAME dir land on the
 *  same queue. */
function keyOf(projectDir: string): string {
  return projectDir.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Run `op` only after every previously-queued op for the same project has
 * settled, so all gated mutations for one project execute strictly one-at-a-time.
 * Returns `op`'s own result (or rejection) to the caller; a rejected op does not
 * poison later ones. Distinct projects run independently (no cross-project block).
 */
export function withProjectLock<T>(projectDir: string, op: () => Promise<T>): Promise<T> {
  const key = keyOf(projectDir);
  const prev = tails.get(key) ?? Promise.resolve();
  // Chain after `prev` regardless of how it settled — the caller that enqueued
  // `prev` already owns its result/rejection, so we ignore it here and just wait.
  const run = prev.then(op, op);
  // The tail the NEXT op waits on must never reject; swallow the outcome. Then GC
  // the map entry once the queue drains to idle (nothing newer took our slot).
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}

/** Test-only: number of projects with a live (not-yet-drained) queue. */
export function _pendingProjectLocks(): number {
  return tails.size;
}

// ── The mandatory project-mutation executor ────────────────────────────────
// The ONE shared boundary every project-mutation tool routes its FINAL commit through — timeline,
// library, and settings — so enforcement is STRUCTURAL, not each tool remembering to reach for the
// gate (or, worse, writing project state around it). It does NOT wrap the whole tool (that would hold
// the lease across the tool's reads/compute); the tool computes freely, then commits HERE.
import { openDocumentByDir } from "../project/openDocuments";
import {
  MutationAbortedError,
  MutationConflictError,
  ProjectClosingError,
  type MutationContext,
  type MutationOrigin,
} from "../project/MutationGate";
import type { ProjectDocument } from "../project/ProjectDocument";

/** Commit a project mutation through the AUTHORITY document's MutationGate — the single serialization +
 *  close-admission + agent-origin-fence + agent-Stop (`signal`) + revision boundary for ALL of the
 *  document's authoritative state. A CLOSING document is still the authority (openDocumentByDir returns
 *  it), so a late commit routes through its (closing) gate and is REJECTED — not slipped past on a bare
 *  lock. The plain-lock fallback runs ONLY for a genuinely document-less write (a never-opened /
 *  being-created project — renaming an INACTIVE project, project create/duplicate seeding, a bare test
 *  store), and even then fails CLOSED while the dir is mid-close. `commit` receives the gate ctx (null
 *  on the lock fallback) and MUST call `ctx.markCommitted()` on a real change so the revision advances
 *  only then. Pass `opts.signal` (the tool ctx's Stop/close signal) so a queued edit is rejected when
 *  the turn is Stopped after the last await; pass `opts.origin` for the superseded-execution fence. */
export function runProjectMutation<T>(
  projectDir: string,
  label: string,
  commit: (doc: ProjectDocument | null, ctx?: MutationContext) => Promise<T>,
  opts?: { origin?: MutationOrigin; signal?: AbortSignal },
): Promise<T> {
  const doc = openDocumentByDir(projectDir);
  if (!doc) {
    // No document owns this dir. Fail CLOSED while the project is mid-close (session ended, commits
    // draining): a late publish for a closing project must be rejected, not slipped past on a bare
    // lock (reviewer blocker 1 — a publish whose doc was already evicted but whose coordinator drain
    // is still running). Otherwise this is a genuinely document-less write (never opened / being
    // created — renaming an INACTIVE project, create/duplicate seeding, a bare test store): take the
    // plain lock. The stale-store belt still applies at the write primitive (writeTextAtomic honors
    // sessionLive), so a late commit whose store predates the close is abandoned there even after the
    // drain window ends, while a FRESH store for an idle project (a rename) has a live session and
    // proceeds — the distinction the owner required.
    if (isProjectClosing(projectDir)) {
      return Promise.reject(new ProjectClosingError(`cannot ${label}: the project is closing`));
    }
    return withProjectLock(projectDir, () => commit(null));
  }
  return doc.gate.run(
    {
      operation: label,
      documentSessionId: doc.sessionId,
      origin: opts?.origin,
      signal: opts?.signal,
    },
    (ctx) => commit(doc, ctx),
  );
}

/** True for the gate's submission/commit rejections (project closing, superseded origin, aborted, or a
 *  concurrent-revision conflict) — a tool reports these as a clean "not written" outcome, not a throw. */
export function isMutationRejected(e: unknown): boolean {
  return (
    e instanceof ProjectClosingError ||
    e instanceof MutationConflictError ||
    e instanceof MutationAbortedError
  );
}

// ── Project session lifecycle (established desktop NLEsjectPackageCoordinator parity) ───────
// A monotonic generation per project identifying the CURRENT editing session. Every
// ProjectStoreAccess captures the value live at its construction; a commit whose store's
// captured generation is stale (the project was CLOSED — and a fresh session begun — since) is
// abandoned at the write boundary. This is the mandatory, centralized "did the user leave?"
// guard: it reaches every mutation, undo, and redo (they all commit through saveTimeline),
// never an opt-in each caller must remember. A checkpoint RESTORE does NOT end the session (it
// stays the same editing session, a new branch), only a close/switch does — so a restore-queued
// edit still commits (close != restore). Mirrors other NLEs' coordinator beginClosing/waitUntilIdle
// rejecting late commits + one shared editor per project.
const projectSessions = new Map<string, number>();

/** The current session generation for a project (0 before any close). Captured by each
 *  ProjectStoreAccess at construction; compared at the commit boundary via sessionLive(). */
export function currentProjectSession(projectDir: string): number {
  return projectSessions.get(keyOf(projectDir)) ?? 0;
}

/** End the project's current editing session (close/switch): bump the generation so any commit
 *  still in-flight from the old session is abandoned before it writes, and a reopen (a new
 *  ProjectStoreAccess) starts a fresh, live session. */
export function endProjectSession(projectDir: string): void {
  const k = keyOf(projectDir);
  projectSessions.set(k, (projectSessions.get(k) ?? 0) + 1);
}

// A project being CLOSED is in `closingProjects` from the synchronous start of the close until its
// in-flight commits drain, and its drain promise is in `closePromises` so a REOPEN can AWAIT it
// (open-awaits-close) before it reads/seeds. Otherwise a reopen races the old session's still-
// committing edit and its starter seed clobbers it (data loss). other NLEs beginClosing/waitUntilIdle.
const closingProjects = new Set<string>();
const closePromises = new Map<string, Promise<void>>();

/** Begin closing a project: end its session SYNCHRONOUSLY (so late commits are rejected at their
 *  guard + a reopen sees a fresh live session) and DRAIN the project lock (so the returned promise
 *  resolves once every in-flight commit has settled). Idempotent while a close is pending;
 *  `whenProjectIdle` lets a reopen await it. */
export function beginProjectClose(projectDir: string): Promise<void> {
  const key = keyOf(projectDir);
  endProjectSession(projectDir); // sync generation bump — old-session commits abandon at the guard
  const pending = closePromises.get(key);
  if (pending) return pending;
  closingProjects.add(key);
  const drain = withProjectLock(projectDir, async () => {}).finally(() => {
    closePromises.delete(key);
    closingProjects.delete(key);
  });
  closePromises.set(key, drain);
  return drain;
}

/** Resolves once any in-flight close of this project has fully drained (idle). A REOPEN awaits
 *  this BEFORE reading/seeding so it never races the old session's still-committing edit. */
export function whenProjectIdle(projectDir: string): Promise<void> {
  return closePromises.get(keyOf(projectDir)) ?? Promise.resolve();
}

/** True while a project is mid-close (session ended, commits still draining). */
export function isProjectClosing(projectDir: string): boolean {
  return closingProjects.has(keyOf(projectDir));
}
