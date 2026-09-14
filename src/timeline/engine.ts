// apply_op — the command wrapper every mutating timeline tool routes through, plus
// two-stack undo/redo. Ports v4/tools/timeline_ops.py. "Atomic" here is the COMMAND on the
// in-memory timeline: an op either fully applies (after validation) or refuses without
// changing anything ({ok:false}) — it is NOT a synchronous disk transaction.
// Only timeline.json is persisted (project root, shared ProjectStoreAccess, writeTextAtomic
// temp+rename). Undo/redo history is IN-MEMORY (the open document's TimelineSession, or a
// per-DIR fallback stack for bare stores — keyed by project dir so the editor + agent stores
// share ONE history, never the store object) — like VS Code / Premiere / other NLEs, editor undo
// is a within-session affordance; the durable "restore to before a message" lives in the chat
// transcript checkpoints (chat.ts + replaceTimeline). Each op is serialized per project at the
// open document's MutationGate (the mandatory boundary), or the per-dir coordinator lock as a
// fallback, so concurrent edits can't interleave. In the live document path the edit notifies
// synchronously then persists ASYNC + coalesced via the document's autosave (flushed on close,
// so a deferred write is never lost); the bare-store fallback does a synchronous load->save.
import { INTERNAL_DIR, ProjectStoreAccess, joinPath } from "../tools/store";
import type { ClientToolContext } from "../tools/context";
import { beginProjectClose, runProjectMutation } from "../tools/coordinator";
import {
  MutationAbortedError,
  MutationConflictError,
  ProjectClosingError,
  type MutationContext,
  type MutationOrigin,
} from "../project/MutationGate";
import { openDocumentByDir } from "../project/openDocuments";
import { useProjectNotice } from "../store/projectNotice";
import type { ProjectDocument } from "../project/ProjectDocument";
import { emitTimelineChange } from "./bus";
import { clampTimelineValues } from "./clamp";
import { OpError } from "./errors";
import { normalizeLinks } from "./helpers";
import { emptyTimeline, starterTracks, type Timeline } from "./model";
import { diffTimeline } from "./shape";
import { validateTimeline } from "./validate";

type Result = Record<string, unknown>;
export type Mutate = (timeline: Timeline) => Result | void;

/** Serialize one timeline commit through the shared project-mutation executor
 *  (coordinator.runProjectMutation) — the OPEN document's MutationGate, or the per-dir coordinator
 *  lock when no document is registered (a bare test store, and the brief OPEN window before the
 *  registry publishes the document). Timeline is thus ONE client of the SAME boundary as library /
 *  settings, so every project mutation shares one serialization + close-admission + agent-origin
 *  domain. A gate rejection (project closing, or a SUPERSEDED agent origin) PROPAGATES so each caller
 *  maps it to its own outcome (applyOp -> {ok:false}, replaceTimeline -> false). */
function runTimelineCommit<T>(
  store: ProjectStoreAccess,
  label: string,
  op: (doc: ProjectDocument | null, ctx?: MutationContext) => Promise<T>,
  origin?: MutationOrigin,
  signal?: AbortSignal,
): Promise<T> {
  return runProjectMutation(store.projectDir, label, op, { origin, signal });
}

/** True for the MutationGate's submission-time rejections (project closing / superseded origin),
 *  which a timeline commit reports as a clean "not written" outcome rather than a thrown error. */
function isTimelineCommitClosed(e: unknown): boolean {
  return (
    e instanceof ProjectClosingError ||
    e instanceof MutationConflictError ||
    e instanceof MutationAbortedError
  );
}

function timelinePath(store: ProjectStoreAccess): string {
  return joinPath(store.projectDir, INTERNAL_DIR, "timeline.json");
}
function clone(timeline: Timeline): Timeline {
  return JSON.parse(JSON.stringify(timeline)) as Timeline;
}
/** Bounded retries for a TRANSIENT autosave write failure so close()'s flush can block on a
 *  disk hiccup rather than silently losing the last edit (see scheduleTimelinePersist). */
const MAX_PERSIST_RETRIES = 3;

const LOAD_RETRIES = 4;
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Return the CURRENT timeline — the open document's in-memory TimelineSession when the project is
 *  open (Phase 5.3c), else read + parse timeline.json from disk. Readers (get_timeline, inspect,
 *  video, preview, export, the editor) all funnel through here, so this ONE short-circuit makes them
 *  observe the same in-memory authority edits mutate — the prerequisite for autosave to lag disk
 *  (5.4) without readers going stale. Disk is still read when there is no open document (bare
 *  stores) OR before the first edit created the session (the lazy-create loader below + open-time
 *  seed both call in while `doc.timeline` is still null → they fall through to disk). The in-memory
 *  timeline is CLONED so a reader can't mutate the live one. Retries a racing disk read a few times
 *  (a concurrent write can momentarily bare an empty/partial file) before throwing. */
export async function loadTimeline(store: ProjectStoreAccess): Promise<Timeline> {
  const doc = openDocumentByDir(store.projectDir);
  if (doc?.timeline) {
    const tl = clone(doc.timeline.current());
    canonicalizeTimeline(tl); // idempotent — the session is already canonical; match the disk contract
    return tl;
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < LOAD_RETRIES; attempt++) {
    try {
      const tl = JSON.parse(await store.readText(timelinePath(store))) as Timeline;
      canonicalizeTimeline(tl); // fill optional units + z at THE load boundary so every reader
      return tl; //  (edit, export, inspect, undo snapshot, add_track nextZ) is validateable (R10-4)
    } catch (e) {
      lastErr = e;
      if (attempt < LOAD_RETRIES - 1) await delay(15 * (attempt + 1));
    }
  }
  throw lastErr;
}
/** Persist a timeline to disk (canonicalize + atomic temp+rename), guarded by session liveness — a
 *  write for a closed/superseded session is ABANDONED (returns false) so nothing lands in a project
 *  the user left. Does NOT emit the change bus: the in-memory edit path notifies synchronously, and
 *  the async autosave (5.4) uses THIS half so it doesn't re-notify. */
async function writeTimelineToDisk(
  store: ProjectStoreAccess,
  timeline: Timeline,
): Promise<boolean> {
  canonicalizeTimeline(timeline);
  return store.writeTextAtomic(timelinePath(store), JSON.stringify(timeline, null, 2), () =>
    store.sessionLive(),
  );
}

/** Write to disk AND emit the change bus in ONE synchronous step — the fallback (no-document) commit
 *  path (bare stores + the open-time seed) still persists + notifies together. */
async function saveTimeline(store: ProjectStoreAccess, timeline: Timeline): Promise<boolean> {
  const committed = await writeTimelineToDisk(store, timeline);
  if (committed) emitTimelineChange(timeline, "engine", store.projectDir); // validateable, z-populated (R11-4)
  return committed;
}

/** Schedule the document's coalesced async autosave to persist its current in-memory timeline. A
 *  successful write markSaved(rev) clears dirty unless a newer edit already bumped the revision; a
 *  failed/abandoned write leaves it dirty (Unsaved) WITHOUT rolling back the valid in-memory edit.
 *  The edit already notified the bus synchronously, so this half writes disk without re-emitting.
 *  A TRANSIENT write failure is retried (bounded, while the session is live) by re-scheduling onto
 *  the SAME autosave, so the document's close() flush BLOCKS until the last edit lands; a newer edit
 *  supersedes the retry, and after the cap the document stays dirty so close() can surface it. */
function scheduleTimelinePersist(
  store: ProjectStoreAccess,
  doc: ProjectDocument,
  attempt = 0,
): void {
  doc.autosave.schedule(async () => {
    const session = doc.timeline;
    if (!session) return;
    const rev = session.revision();
    let committed = false;
    try {
      committed = await writeTimelineToDisk(store, session.current());
      if (committed) session.markSaved(rev);
    } catch {
      // A write error (disk failure) — treat as not-committed; the retry below re-attempts it.
    }
    // Notify the persistence state so the editor's Unsaved indicator clears on a successful save (and
    // stays on a failed one, or a newer edit that kept it dirty). Timeline unchanged -> persistence-only.
    emitTimelineChange(
      session.current(),
      committed ? "saved" : "save-failed",
      store.projectDir,
      session.isDirty(),
    );
    if (!committed && store.sessionLive() && session.isDirty() && attempt < MAX_PERSIST_RETRIES) {
      await delay(20 * (attempt + 1));
      if (session.isDirty()) scheduleTimelinePersist(store, doc, attempt + 1);
    } else if (!committed && store.sessionLive() && session.isDirty()) {
      // Budget spent: this is not a hiccup. A project on a removable or network drive can
      // simply GO AWAY mid-edit, and the edits only exist in memory. Keep them there and keep
      // trying, so the project saves itself when the folder comes back.
      scheduleWriteRecovery(store, doc);
    }
  });
}

/** Slow re-attempts while a project's folder is unreachable, one timer per project.
 *
 *  Deliberately OUTSIDE `doc.autosave`: rescheduling onto that queue would mean close()'s
 *  flush waits on a write that cannot succeed until someone replugs a drive, so closing the
 *  project would hang. A timer instead lets close proceed (it reports the unsaved timeline
 *  through the existing Retry/Discard/Cancel path) and no-ops once the session is gone. */
const RECOVERY_MS = 5000;
const recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleWriteRecovery(store: ProjectStoreAccess, doc: ProjectDocument): void {
  const key = store.projectDir;
  if (recoveryTimers.has(key)) return;
  useProjectNotice
    .getState()
    .notify(
      "Can't reach this project's folder, so your changes are unsaved. They are safe in the app — reconnect the drive and they will save themselves.",
    );
  const t = setTimeout(() => {
    recoveryTimers.delete(key);
    if (!store.sessionLive() || !doc.timeline?.isDirty()) return;
    rearmTimelinePersist(store, doc);
  }, RECOVERY_MS);
  recoveryTimers.set(key, t);
}

/** Drop a project's pending recovery timer (close). */
export function cancelWriteRecovery(projectDir: string): void {
  const t = recoveryTimers.get(projectDir);
  if (t === undefined) return;
  clearTimeout(t);
  recoveryTimers.delete(projectDir);
}

/** Re-arm a FRESH timeline persist (attempt 0, full retry budget) for an open document whose
 *  in-memory timeline is still dirty. The close SAVE phase calls this so a Retry re-attempts the
 *  ACTUAL disk write after the async autosave already exhausted its retries (finding #3) — it
 *  schedules onto the SAME autosave, so the document's flush() then blocks until this settles.
 *  No-op when nothing is open/dirty. */
export function rearmTimelinePersist(store: ProjectStoreAccess, doc: ProjectDocument): void {
  if (doc.timeline?.isDirty()) scheduleTimelinePersist(store, doc, 0);
}

/** Ensure a timeline.json exists (seed an empty one). Idempotent. */
export async function ensureTimeline(store: ProjectStoreAccess): Promise<void> {
  // Under the project lock so the exists-check + seed are ONE serialized read-modify-write (not
  // racing a concurrent commit) AND so a close drain waits for this write (it's no longer outside
  // the lock — finding #3).
  await runTimelineCommit(store, "ensure_timeline", async (_doc, ctx) => {
    if (await store.exists(timelinePath(store))) return; // already exists -> a no-op, no revision bump
    if (!(await saveTimeline(store, emptyTimeline()))) {
      throw new Error("could not create timeline.json — the project was closed");
    }
    ctx?.markCommitted(); // seeded a fresh timeline.json -> a real state change
  });
}

/** Overwrite the timeline with a full snapshot and emit on the bus (so the
 *  editor refreshes). Used by client-owned turn undo/redo to restore the
 *  per-turn checkpoint the server used to restore server-side. */
export async function replaceTimeline(
  store: ProjectStoreAccess,
  timeline: Timeline,
): Promise<boolean> {
  const commit = runTimelineCommit(store, "restore", async (doc, ctx) => {
    if (doc) {
      // In-memory restore (Phase 5): swap the document's live timeline + reset ITS history (a restore
      // is a new branch); notify + async persist. No module-global history to clear — doc.timeline
      // owns the stacks. session.replace validates the snapshot; an invalid one surfaces as a throw.
      const session = await doc.timelineSession(() => loadTimeline(store));
      const r = session.replace(timeline);
      if (!r.ok) throw new Error(`refusing to restore an invalid timeline snapshot — ${r.error}`);
      emitTimelineChange(session.current(), "engine", store.projectDir, session.isDirty());
      scheduleTimelinePersist(store, doc);
      ctx?.markCommitted(); // a real restore swapped the timeline -> advance the revision
      return true;
    }
    // No open document (a bare store or the pre-publish window): there is no live session to
    // restore into — report "not written" so the caller leaves its state untouched.
    return false;
  });
  try {
    return await commit;
  } catch (e) {
    // The project began closing mid-restore: like an abandoned save, report "not written" (false)
    // so the caller (chat undo/redo/restore) leaves its state untouched.
    if (isTimelineCommitClosed(e)) return false;
    throw e;
  }
}

/** Load the timeline, seeding Premiere-style starter tracks (2 video + 2 audio)
 *  when it is genuinely empty (no file yet, or a valid file with 0 tracks) — so
 *  the editor always opens onto real tracks that map to timeline.json 1:1.
 *
 *  CRITICAL: a read/parse FAILURE of an existing file must NOT fall back to
 *  seeding — that would overwrite the user's real timeline (a transient read,
 *  e.g. racing a concurrent write, would destroy hundreds of clips). We throw
 *  instead, so the caller surfaces an error / retries rather than clobbering. */
/** Seed a timeline UNDER the project lock (serializing it with normal edits, which
 *  hold the same lock) and recheck freshness AFTER acquiring it, so a stale
 *  activation's seed can't land its rename after a newer activation edited the same
 *  project (R8-3). */
export async function ensureStarterTimeline(
  store: ProjectStoreAccess,
  opts?: { canWrite?: () => boolean },
): Promise<Timeline> {
  // A seed write from a SUPERSEDED activation must not land on disk (it could clobber a newer
  // same-project edit made after this load started); the caller passes its freshness check here
  // so a stale seed is skipped (R7-2).
  const canWrite = () => opts?.canWrite?.() ?? true;
  // The whole exists -> read -> validate -> seed runs UNDER the project lock, so the emptiness
  // check and the seed are ONE serialized read-modify-write. Otherwise a concurrent commit (an old
  // session's in-flight edit that just drained, or an agent write) could land BETWEEN a lock-free
  // "is it empty?" read and the seed, and the seed would clobber it (the reopen data-loss race #1).
  return runTimelineCommit(store, "ensure_starter", async (_doc, ctx) => {
    // Fresh project (no file yet): safe to seed starter tracks.
    if (!(await store.exists(timelinePath(store)))) {
      const seeded = emptyTimeline();
      seeded.tracks = starterTracks();
      if (canWrite()) {
        if (!(await saveTimeline(store, seeded)))
          throw new Error("could not seed the starter timeline — the project was closed");
        ctx?.markCommitted(); // seeded a fresh starter timeline -> a real state change (a stale-skip does not)
      }
      return seeded;
    }
    // The file exists — read it. Do NOT catch → seed here: a transient read failure must NOT fall
    // back to seeding, which would overwrite the user's real timeline.
    const tl = await loadTimeline(store);
    if (tl === null || typeof tl !== "object" || Array.isArray(tl)) {
      throw new Error("timeline.json is not a timeline object; refusing to overwrite it");
    }
    // `z` + `units` are optional in the model + schema but REQUIRED by validateTimeline;
    // loadTimeline already canonicalized them at the load boundary (R10-4). Truly-malformed
    // shapes (bad canvas, null/dup track) still fail.
    const errors = validateTimeline(tl);
    if (errors.length) {
      throw new Error(
        `timeline.json is malformed; refusing to overwrite it — ${errors.slice(0, 3).join("; ")}`,
      );
    }
    // Valid but empty (0 tracks): safe to seed starters onto it (re-checked under the lock).
    if (tl.tracks.length === 0) {
      tl.tracks = starterTracks();
      if (canWrite()) {
        if (!(await saveTimeline(store, tl)))
          throw new Error("could not seed the starter timeline — the project was closed");
        ctx?.markCommitted(); // seeded starters onto an empty timeline -> a real state change
      }
    }
    return tl;
  });
}

/** CLOSE a project's editing session (editor.dispose) — a serialized lifecycle barrier, other NLEs
 *  ProjectPackageCoordinator parity. Ends the session SYNCHRONOUSLY (so late commits + a reopen
 *  see the generation bump) and drains the project lock; a reopen awaits whenProjectIdle(dir)
 *  before reading/seeding, so no commit races the close. Undo/redo live in the document's
 *  TimelineSession, which is torn down with the document — no module-global stack to clear. */
export function closeProjectSession(projectDir: string): Promise<void> {
  return beginProjectClose(projectDir);
}

/** Fill each track's optional `z` (stacking order) by index when absent. `z` is
 *  OPTIONAL in the model + schema but REQUIRED by validateTimeline, so a persisted
 *  z-less timeline (external/legacy) must have it supplied before the validator.
 *  Shared by the open path (ensureStarterTimeline, in memory) AND the canonicalizing
 *  pass every edit runs (normalizeTimeline) so the default becomes DURABLE + edit-safe
 *  -- previously the open path filled it in memory only, so the first applyOp reloaded
 *  the z-less file and validation rejected it (R9-5). Idempotent: a present z is left
 *  untouched, so normalizeTimeline stays a fixed point. */
function fillTrackZ(timeline: Timeline): void {
  const tracks = (timeline as Timeline | null | undefined)?.tracks;
  if (!Array.isArray(tracks)) return;
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i] as { z?: number } | null;
    if (t !== null && typeof t === "object" && t.z === undefined) t.z = i;
  }
}

/** The single canonicalization applied at EVERY load boundary (loadTimeline): supply
 *  the optional `units` + track `z` that validateTimeline requires but the model +
 *  schema mark optional. Running it inside loadTimeline means edit, export, inspect,
 *  the undo `before` snapshot, and add_track's nextZ all operate on a validateable,
 *  z-populated timeline -- so a z-less external/legacy file no longer opens fine but
 *  breaks on export/undo/first-add (R10-4). Guards non-object JSON (a corrupt file
 *  parses to a primitive) so the caller's own shape check still runs. Idempotent. */
function canonicalizeTimeline(tl: Timeline): void {
  if (tl === null || typeof tl !== "object" || Array.isArray(tl)) return;
  if (tl.units === undefined) tl.units = "frames";
  fillTrackZ(tl);
}

/** Canonicalize (fill optional units + z) then validate a snapshot that is about to be
 *  persisted AND broadcast via saveTimeline — the same guard applyOp applies to edits.
 *  Returns [] when valid (the snapshot is now canonical), else the errors. Shared by
 *  replaceTimeline (AI turn checkpoints, restored from the persisted chat transcript) +
 *  doUndo/doRedo (in-memory editor history) so a snapshot from a tampered transcript or a
 *  corrupted in-memory stack can't push a bad canvas / duplicate track / overlap live. */
export function canonicalizeAndValidate(timeline: Timeline): string[] {
  if (timeline === null || typeof timeline !== "object" || Array.isArray(timeline)) {
    return ["snapshot is not a timeline object"];
  }
  canonicalizeTimeline(timeline);
  return validateTimeline(timeline);
}

function normalizeClipOrder(timeline: Timeline): void {
  const tracks = (timeline as Timeline | null | undefined)?.tracks;
  if (!Array.isArray(tracks)) return;
  for (const track of tracks) {
    if (track === null || typeof track !== "object") continue;
    const clips = track.clips;
    if (Array.isArray(clips) && clips.length > 1) {
      clips.sort((a, b) => {
        const av =
          a !== null && typeof a === "object" && typeof a.timeline_in === "number"
            ? a.timeline_in
            : 0;
        const bv =
          b !== null && typeof b === "object" && typeof b.timeline_in === "number"
            ? b.timeline_in
            : 0;
        return av - bv;
      });
    }
  }
}

/** source_out is DERIVED, never authoritative: for any clip with a source window
 *  (source_in set), the out-point is fixed by the timeline span and speed --
 *  source_out = source_in + round((timeline_out - timeline_in) * speed). Deriving
 *  it on every save makes it a single source of truth: it can't be stored inverted
 *  or out of parity (the split-a-time-stretched-clip source-collapse bug), and the
 *  timing-parity invariant validateTimeline checks is satisfied by construction. */
function deriveSourceSpans(timeline: Timeline): void {
  const tracks = (timeline as Timeline | null | undefined)?.tracks;
  if (!Array.isArray(tracks)) return;
  for (const track of tracks) {
    if (track === null || typeof track !== "object") continue;
    const clips = track.clips;
    if (!Array.isArray(clips)) continue;
    for (const clip of clips) {
      if (clip === null || typeof clip !== "object") continue;
      // loop/stretch clips fill the slot from a source whose length is deliberately
      // independent of the timeline span (loop repeats, stretch retimes) — leave
      // their source_out alone, or deriving would collapse the loop unit to the slot.
      if (clip.loop === true || clip.stretch === true) continue;
      const sIn = clip.source_in;
      const tIn = clip.timeline_in;
      const tOut = clip.timeline_out;
      if (typeof sIn === "number" && typeof tIn === "number" && typeof tOut === "number") {
        const speed = Number(clip.speed ?? 1) || 1;
        clip.source_out = sIn + Math.round((tOut - tIn) * speed);
      }
    }
  }
}

/** The canonicalizing pass every op runs after mutating: order clips, re-lock
 *  linked A/V, clamp scalar knobs, derive source_out. Returns clamp notes. Every
 *  step is idempotent, so on an already-canonical timeline this is a no-op (a
 *  fixed point) -- the property invariants.property.test asserts. */
export function normalizeTimeline(timeline: Timeline): string[] {
  fillTrackZ(timeline); // supply optional track z (validateTimeline requires it) so the edit persists it (R9-5)
  normalizeClipOrder(timeline);
  normalizeLinks(timeline); // re-lock linked A/V (speed+length) -- link is a real invariant
  const clampNotes = clampTimelineValues(timeline);
  deriveSourceSpans(timeline); // source_out = source_in + round(timeline-span * speed) -- derived, never stored inconsistently
  return clampNotes;
}

/** The result of the PURE timeline transition (no disk I/O, no undo side effects): the
 *  post-mutation `next` timeline + the `before` snapshot (for the undo record) + the diff
 *  `receipt`, or a structured failure. Extracted from applyOp so the SAME pipeline
 *  (mutate -> normalize -> validate -> diff) backs the disk-based applyOp today AND the
 *  in-memory document command adapter (Phase 5). `current` is never mutated. */
export interface TimelineTransitionOk {
  readonly ok: true;
  readonly before: Timeline; // pre-mutation snapshot (the undo record)
  readonly next: Timeline; // post-mutation, canonicalized + validated
  readonly receipt: Result; // { ok:true, op, ...info, ...diff, clamped? }
}
export interface TimelineTransitionErr {
  readonly ok: false;
  readonly error: string;
  readonly validation_errors?: string[];
}
export type TimelineTransitionResult = TimelineTransitionOk | TimelineTransitionErr;

/** Apply one mutation to a COPY of `current` and run the full normalize -> validate -> diff
 *  pipeline, returning the new timeline + undo snapshot + receipt (or a structured failure).
 *  PURE: no disk read/write, no undo-stack mutation, and `current` is left untouched — the
 *  caller owns persistence + history. On an OpError or a validation error nothing is produced,
 *  so the caller leaves its state unchanged. Shared by applyOp (disk) and the in-memory
 *  document command path so both apply IDENTICAL frame-domain rules + canonicalization. */
export function applyTimelineTransition(
  current: Timeline,
  label: string,
  mutate: Mutate,
): TimelineTransitionResult {
  // A corrupted timeline.json can parse to a non-object (a bare number/string/array); reject
  // rather than crash on the first property write below.
  if (current === null || typeof current !== "object" || Array.isArray(current)) {
    return {
      ok: false,
      error: "timeline.json is not a timeline object; bootstrap the timeline first.",
    };
  }
  const before = clone(current);
  const timeline = clone(current); // mutate a COPY — never the caller's live/loaded timeline
  if (timeline.units === undefined) timeline.units = "frames";

  let info: Result | void;
  try {
    info = mutate(timeline);
  } catch (e) {
    if (e instanceof OpError) return { ok: false, error: e.message };
    throw e;
  }

  const clampNotes = normalizeTimeline(timeline);
  const errors = validateTimeline(timeline);
  if (errors.length) {
    return {
      ok: false,
      error: `${label}: rejected by validation; timeline left unchanged — ${errors.slice(0, 3).join("; ")}`,
      validation_errors: errors.slice(0, 20),
    };
  }

  // Mutation delta: what this edit changed (before -> after), in get_timeline vocabulary, so the
  // model patches its picture instead of re-reading.
  const receipt: Result = {
    ok: true,
    op: label,
    ...(info ?? {}),
    ...diffTimeline(before, timeline),
  };
  if (clampNotes.length) receipt.clamped = clampNotes;
  return { ok: true, before, next: timeline, receipt };
}

/** Load -> snapshot -> mutate -> normalize -> clamp -> validate -> save. On any
 *  OpError or validation error nothing is written. Serialized per project (see
 *  {@link withProjectLock}) so a concurrent edit can't clobber this RMW. */
export async function applyOp(
  store: ProjectStoreAccess,
  label: string,
  mutate: Mutate,
  origin?: MutationOrigin,
  signal?: AbortSignal,
): Promise<Result> {
  // Serialize through the open document's MutationGate (or the coordinator lock when no document is
  // registered — bare test stores + the open-time seed window). The in-flight write is still fenced
  // by saveTimeline's session-liveness guard; the gate adds the mandatory close ADMISSION (a commit
  // submitted after close begins is rejected here rather than racing to the write boundary), the
  // agent-origin fence — a commit carrying a superseded chat execution's `origin` is rejected too —
  // AND the agent-Stop fence: an edit still queued behind the gate when the turn is Stopped (its
  // `signal` aborted after the last await) is rejected instead of committing post-Stop.
  try {
    return await runTimelineCommit(
      store,
      label,
      (doc, ctx) => applyOpLocked(store, label, mutate, doc, ctx),
      origin,
      signal,
    );
  } catch (e) {
    if (isTimelineCommitClosed(e))
      return { ok: false, error: `${label}: not written — the project was closed` };
    throw e;
  }
}

/** applyOp for an AGENT tool: threads the tool context's `origin` (the initiating chat execution) so
 *  the gate rejects a commit from a SUPERSEDED execution, AND its `signal` (the turn Stop / job-close
 *  abort) so an edit still queued when the turn is Stopped is rejected rather than committed post-Stop.
 *  Manual editor edits call applyOp directly with no origin/signal (always current), so they are never
 *  fenced. */
export function ctxApplyOp(ctx: ClientToolContext, label: string, mutate: Mutate): Promise<Result> {
  return applyOp(ctx.store, label, mutate, ctx.origin, ctx.signal);
}

/** Apply one step of a gesture that is ALREADY holding the mutation lease. */
export type GestureApply = (label: string, mutate: Mutate) => Result;

/** A step of a gesture was refused. Carries the step's own failure so the gesture reports it. */
class GestureStepError extends Error {
  constructor(readonly result: Result) {
    super(String((result as { error?: string }).error ?? "step refused"));
  }
}

/** Run a multi-step gesture as ONE undo entry and ONE lease.
 *
 *  `applyOp` takes the gate per call, so a gesture built from several of them releases the lease
 *  between steps: another edit can land in the gap, and the gesture's single undo snapshot would
 *  then revert that edit too. This takes the lease ONCE for the whole intent and hands `work` an
 *  `apply` that does NOT re-enter it (`MutationGate.run` is exclusive — re-entering deadlocks).
 *
 *  Everything `work` calls must therefore be an OPERATION (see timeline/operations.ts), never a
 *  tool: a tool re-enters the gate through `ctxApplyOp` and would hang.
 *
 *  A throw rolls the whole intent back and records no history (TimelineSession.transaction). */
export async function runGesture<T>(
  store: ProjectStoreAccess,
  label: string,
  work: (apply: GestureApply) => Promise<T> | T,
  origin?: MutationOrigin,
  signal?: AbortSignal,
): Promise<T | { ok: false; error: string }> {
  try {
    return await runTimelineCommit(
      store,
      label,
      async (doc, ctx) => {
        if (!doc) return { ok: false as const, error: `${label}: no open project for this store` };
        let session: Awaited<ReturnType<ProjectDocument["timelineSession"]>>;
        try {
          session = await doc.timelineSession(() => loadTimeline(store));
        } catch (e) {
          return {
            ok: false as const,
            error: `${label}: could not read timeline.json: ${String(e)}`,
          };
        }
        ctx?.assertCanCommit(); // re-checked after the awaited lazy load, like applyOpLocked
        const revisionBefore = session.revision();
        try {
          const out = await session.transaction(label, () =>
            work((stepLabel, mutate) => {
              const r = session.apply(stepLabel, mutate);
              // A refused step voids the INTENT. `apply` reports a rejection rather than throwing,
              // so without this the gesture would sail past it and commit the steps that DID land
              // as one entry — a half-applied intent the user never asked for.
              if (!r.ok)
                throw new GestureStepError(
                  r.validation_errors
                    ? { ok: false, error: r.error, validation_errors: r.validation_errors }
                    : { ok: false, error: r.error },
                );
              return r.receipt;
            }),
          );
          // One emit, one persist, one revision bump for the whole intent — a per-step emit would
          // show the user a half-applied timeline that a later step or a rollback then contradicts.
          if (session.revision() !== revisionBefore) {
            emitTimelineChange(session.current(), "engine", store.projectDir, session.isDirty());
            scheduleTimelinePersist(store, doc);
            ctx?.markCommitted();
          }
          return out;
        } catch (e) {
          if (e instanceof GestureStepError) {
            // The transaction already restored the pre-gesture timeline; republish it so the editor
            // does not keep showing the rolled-back steps.
            emitTimelineChange(session.current(), "engine", store.projectDir, session.isDirty());
            return e.result as T;
          }
          throw e;
        }
      },
      origin,
      signal,
    );
  } catch (e) {
    if (isTimelineCommitClosed(e))
      return { ok: false as const, error: `${label}: not written — the project was closed` };
    throw e;
  }
}

async function applyOpLocked(
  store: ProjectStoreAccess,
  label: string,
  mutate: Mutate,
  doc: ProjectDocument | null,
  ctx?: MutationContext,
): Promise<Result> {
  // Every edit commits against the project's OPEN document (Phase 5.5: the no-document coordinator
  // fallback + module-global undo history are gone). A commit with no document is a bare test store
  // or the closed/pre-publish window — fail cleanly rather than write.
  if (!doc)
    return {
      ok: false,
      error: `${label}: this project has no open document, so it cannot be edited — reads (get_timeline, library_op, inspect_*) need no document and will keep answering, which is why everything else still looks healthy. Open it with manage_project action='open' and check the reply's 'ready' is true before retrying.`,
    };
  // In-memory authority (Phase 5): apply to the document's LIVE timeline — created lazily from disk
  // on the first edit, then reused, so no per-edit reload. NOTIFY synchronously (the editor refreshes
  // from memory immediately) then persist ASYNC + coalesced via the document's autosave; the edit
  // returns WITHOUT waiting for disk. close() flushes the autosave before teardown, so a deferred
  // write is never lost on close/switch.
  let session: Awaited<ReturnType<ProjectDocument["timelineSession"]>>;
  try {
    session = await doc.timelineSession(() => loadTimeline(store));
  } catch (e) {
    // A corrupt/unreadable timeline.json at the first edit — surface a clean failure, never crash.
    return { ok: false, error: `${label}: could not read timeline.json: ${String(e)}` };
  }
  ctx?.assertCanCommit(); // re-check origin/session AFTER any awaited lazy load — reject a supersede that landed mid-lease (the fence's second gate, past preflight)
  const r = session.apply(label, mutate);
  if (!r.ok)
    return r.validation_errors
      ? { ok: false, error: r.error, validation_errors: r.validation_errors }
      : { ok: false, error: r.error };
  emitTimelineChange(session.current(), "engine", store.projectDir, session.isDirty());
  scheduleTimelinePersist(store, doc);
  ctx?.markCommitted(); // a real in-memory change -> advance the document revision (a {ok:false} validation reject above does NOT)
  return r.receipt;
}

export async function doUndo(store: ProjectStoreAccess): Promise<Result> {
  try {
    return await runTimelineCommit(store, "undo", (doc, ctx) => doUndoLocked(store, doc, ctx));
  } catch (e) {
    if (isTimelineCommitClosed(e))
      return { ok: false, error: "undo: not written — the project was closed" };
    throw e;
  }
}

async function doUndoLocked(
  store: ProjectStoreAccess,
  doc: ProjectDocument | null,
  ctx?: MutationContext,
): Promise<Result> {
  if (!doc) return { ok: false, error: "nothing to undo" };
  // In-memory undo (Phase 5): revert the document's live timeline; notify + async persist. Editor
  // Ctrl+Z and agent edits share the ONE document session, so this is ONE undo stack.
  const session = await doc.timelineSession(() => loadTimeline(store));
  const before = clone(session.current()); // undo reverts in place; snapshot to diff against
  const r = session.undo();
  if (!r.ok) return { ok: false, error: r.error };
  // Composite (Phase 7): a cascade-delete slot also restores its library half (re-add the deleted
  // catalog item). The timeline already reverted in-memory; a rare library-write failure leaves the
  // restored clips transiently referencing an un-restored row until the next save/undo — report, not crash.
  let undoWarning: string | undefined;
  try {
    await doc.runCompositeUndo(r.tag);
  } catch (e) {
    undoWarning = `undo: timeline reverted but the coupled library restore failed (${String(e)}) — retry or save to reconcile`;
  }
  emitTimelineChange(session.current(), "engine", store.projectDir, session.isDirty());
  scheduleTimelinePersist(store, doc);
  ctx?.markCommitted(); // a real undo changed the timeline -> advance the revision (nothing-to-undo does not)
  // An undo can restore arbitrarily much; without the delta the model is left guessing
  // what came back (the one mutation path that used to say only "undone: true").
  const receipt: Result = {
    ok: true,
    undone: true,
    remaining_undo: r.remainingUndo,
    ...diffTimeline(before, session.current()),
  };
  if (undoWarning) receipt.warning = undoWarning;
  return receipt;
}

export async function doRedo(store: ProjectStoreAccess): Promise<Result> {
  try {
    return await runTimelineCommit(store, "redo", (doc, ctx) => doRedoLocked(store, doc, ctx));
  } catch (e) {
    if (isTimelineCommitClosed(e))
      return { ok: false, error: "redo: not written — the project was closed" };
    throw e;
  }
}

async function doRedoLocked(
  store: ProjectStoreAccess,
  doc: ProjectDocument | null,
  ctx?: MutationContext,
): Promise<Result> {
  if (!doc) return { ok: false, error: "nothing to redo" };
  // In-memory redo (Phase 5): mirror of doUndo on the document's live timeline + history.
  const session = await doc.timelineSession(() => loadTimeline(store));
  const before = clone(session.current());
  const r = session.redo();
  if (!r.ok) return { ok: false, error: r.error };
  // Composite (Phase 7): mirror of undo — re-remove the cascade-deleted catalog item with its clips.
  let redoWarning: string | undefined;
  try {
    await doc.runCompositeRedo(r.tag);
  } catch (e) {
    redoWarning = `redo: timeline re-applied but the coupled library removal failed (${String(e)}) — retry or save to reconcile`;
  }
  emitTimelineChange(session.current(), "engine", store.projectDir, session.isDirty());
  scheduleTimelinePersist(store, doc);
  ctx?.markCommitted(); // a real redo changed the timeline -> advance the revision
  const receipt: Result = {
    ok: true,
    redone: true,
    remaining_redo: r.remainingRedo,
    ...diffTimeline(before, session.current()),
  };
  if (redoWarning) receipt.warning = redoWarning;
  return receipt;
}

/** Apply a timeline mutation to an ALREADY-GATED document's session — the caller HOLDS the gate (e.g.
 *  a `runProjectMutation` commit), so this must NOT re-enter it (re-entering the serial gate would
 *  deadlock). `tag` marks the undo slot so a COMPOSITE command (cascade delete) can couple a library
 *  side effect to it. Emits + schedules persist like a normal edit, but leaves `markCommitted` to the
 *  caller (one composite = one revision bump). Returns the transition result ({ok:false} = validation
 *  reject, nothing changed). */
export async function applyTaggedInGate(
  store: ProjectStoreAccess,
  doc: ProjectDocument,
  label: string,
  mutate: Mutate,
  tag: string,
): Promise<TimelineTransitionResult> {
  const session = await doc.timelineSession(() => loadTimeline(store));
  const r = session.apply(label, mutate, tag);
  if (!r.ok) return r;
  emitTimelineChange(session.current(), "engine", store.projectDir, session.isDirty());
  scheduleTimelinePersist(store, doc);
  return r;
}

/** CLEANLY revert the tagged apply that {@link applyTaggedInGate} just made — restore the pre-apply
 *  timeline, discard its undo slot, record NO redo entry — when a COMPOSITE command's coupled side
 *  effect (a cascade delete's catalog write) fails AFTER the timeline change. Emits + reschedules the
 *  persist so the editor + disk converge on the reverted timeline (the coalesced autosave writes the
 *  latest = reverted state). Runs INSIDE the caller's gate lease, right after the failed apply, so the
 *  top slot is guaranteed to be the tagged one; returns false only if there is no session/slot to
 *  revert (the caller then leaves history intact). */
export function revertTaggedInGate(
  store: ProjectStoreAccess,
  doc: ProjectDocument,
  tag: string,
): boolean {
  const session = doc.timeline;
  if (!session) return false;
  const reverted = session.revertLastApply(tag);
  if (reverted) {
    emitTimelineChange(session.current(), "engine", store.projectDir, session.isDirty());
    scheduleTimelinePersist(store, doc);
  }
  return reverted;
}

/** Overwrite the on-disk timeline directly (canonicalize + atomic write + emit), for the NO-document
 *  cascade-delete fallback — a bare store has no in-memory session to edit. Guarded by session
 *  liveness like every timeline write. */
export async function overwriteTimeline(
  store: ProjectStoreAccess,
  timeline: Timeline,
): Promise<boolean> {
  return saveTimeline(store, timeline);
}
