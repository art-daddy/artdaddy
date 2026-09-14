// TimelineSession — the in-memory owner of ONE document's timeline (Phase 5). While a project is
// open this is the single source of truth: edits apply HERE (through the shared pure
// applyTimelineTransition) instead of reloading timeline.json before every edit, and autosave
// persists snapshots asynchronously (wired by the document). Undo/redo live here too, so manual +
// agent edits share ONE timeline AND one history — the single-document model other NLEs/VS Code get
// from one shared in-memory document. Pure/in-memory: no disk I/O, no coordinator, no bus; the
// ProjectDocument wires persistence + eventing around it in later slices.
import {
  applyTimelineTransition,
  canonicalizeAndValidate,
  type Mutate,
  type TimelineTransitionResult,
} from "./engine";
import type { Timeline } from "./model";

const HISTORY_CAP = 50;

/** One history slot: a whole-timeline snapshot plus an optional `tag` that couples a COMPOSITE
 *  command (e.g. a cascade delete: remove a library item + its using clips as ONE undo entry) to a
 *  side effect the document restores on undo / re-applies on redo. A plain edit has no tag. */
interface UndoEntry {
  readonly timeline: Timeline;
  readonly tag?: string;
}

/** The outcome of an undo/redo/replace: `ok` plus the remaining stack depths (for the UI enablement
 *  + a receipt), or `ok:false` with a reason (empty stack, or an invalid snapshot refused). */
export interface TimelineHistoryResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly remainingUndo?: number;
  readonly remainingRedo?: number;
  /** The moved slot's composite `tag`, if any — the document runs its companion (undo restores the
   *  library side, redo re-applies it) so timeline + library move as ONE undo entry. */
  readonly tag?: string;
}

export class TimelineSession {
  private _timeline: Timeline;
  private readonly _undo: UndoEntry[] = [];
  private readonly _redo: UndoEntry[] = [];
  private _revision = 0;
  private _dirty = false;
  private _tx: { before: Timeline; tags: string[] } | null = null;

  /** @param initial the timeline loaded from disk at open (in sync with disk => not dirty). */
  constructor(initial: Timeline) {
    this._timeline = initial;
  }

  /** The live in-memory timeline. Treat as immutable — mutate ONLY through apply/undo/redo/replace,
   *  which run the canonicalization + validation pipeline and record history. */
  current(): Timeline {
    return this._timeline;
  }

  /** Monotonic in-memory revision — bumps on every successful state change (apply/undo/redo/replace).
   *  Autosave captures it at the read and only clears dirty if it is unchanged at markSaved. */
  revision(): number {
    return this._revision;
  }

  /** True when the in-memory timeline has edits not yet persisted (autosave clears it via markSaved). */
  isDirty(): boolean {
    return this._dirty;
  }

  canUndo(): boolean {
    return this._undo.length > 0;
  }

  canRedo(): boolean {
    return this._redo.length > 0;
  }

  /** Every timeline currently reachable by undo or redo — the snapshots a restore could bring back.
   *  The GC sweep unions these (plus the live timeline + chat checkpoints) so it never collects owned
   *  media a pending undo/redo could reference again. */
  historySnapshots(): Timeline[] {
    return [...this._undo, ...this._redo].map((e) => e.timeline);
  }

  /** Apply one mutation to the in-memory timeline via the SAME pure pipeline as disk-based applyOp.
   *  On success: records the before-snapshot for undo, clears redo, bumps the revision, marks dirty,
   *  and returns the diff receipt. On failure (OpError / validation): state is untouched and the
   *  structured error returns — the caller reports it without mutating anything. */
  apply(label: string, mutate: Mutate, tag?: string): TimelineTransitionResult {
    const r = applyTimelineTransition(this._timeline, label, mutate);
    if (!r.ok) return r;
    if (this._tx) {
      // Inside a transaction the individual steps register NO history: the transaction pushes ONE
      // entry for the whole intent when it closes. A tagged composite is still recorded, because the
      // document must run its library companion on undo (see `transaction`, which refuses a second).
      if (tag !== undefined) this._tx.tags.push(tag);
    } else {
      this._pushUndo({ timeline: r.before, tag });
      this._redo.length = 0; // a fresh edit invalidates the redo branch (its composite tags become unreachable)
    }
    this._timeline = r.next;
    this._revision++;
    this._dirty = true;
    return r;
  }

  /** Run `work` so the whole thing costs exactly ONE undo entry.
   *
   *  other NLEs' `undo.perform(name) { ... }`: one coherent intent is one Ctrl+Z, by construction
   *  rather than by every call site remembering. Steps inside register nothing; the entry is pushed
   *  once at the end, and ONLY if the timeline actually changed — a refused or no-op intent costs
   *  nothing, so undo never eats an unrelated earlier edit.
   *
   *  A throw restores the pre-transaction timeline and pushes nothing, so a half-applied multi-step
   *  intent cannot survive. Nested calls JOIN the outer transaction (one intent, one entry).
   *
   *  The CALLER must hold the mutation lease for the whole call — `MutationGate.run` is exclusive,
   *  so the steps inside must not re-enter it. Without that, another edit could land between two
   *  steps and this entry's snapshot would revert it too. */
  async transaction<T>(label: string, work: () => Promise<T> | T): Promise<T> {
    if (this._tx) return await work(); // joined: the outer transaction owns the entry
    const before = this._timeline;
    const revisionBefore = this._revision;
    this._tx = { before, tags: [] };
    try {
      return await work();
    } catch (e) {
      this._timeline = before; // a partial multi-step intent must not survive its own failure
      if (this._revision !== revisionBefore) this._revision++;
      throw e;
    } finally {
      const tx = this._tx;
      this._tx = null;
      if (tx && this._timeline !== before) {
        // More than one tagged composite in one intent cannot be expressed: an entry carries ONE tag,
        // so the document would run only one library companion on undo and silently strand the other.
        if (tx.tags.length > 1) {
          this._timeline = before;
          this._revision++;
          throw new Error(
            `${label}: a transaction may contain at most one composite (library-coupled) edit, got ${tx.tags.length}`,
          );
        }
        this._pushUndo({ timeline: before, tag: tx.tags[0] });
        this._redo.length = 0;
      }
    }
  }

  /** True while a transaction is open — the window in which `revertLastApply` has no slot to revert
   *  and undo/redo would fight the entry being built. */
  inTransaction(): boolean {
    return this._tx !== null;
  }

  /** Restore the previous snapshot. Validates it first (defensive — an in-memory stack could be
   *  corrupted, or a snapshot restored from a tampered transcript), so an invalid one is refused
   *  and state stays intact. Returns the remaining stack depths. */
  undo(): TimelineHistoryResult {
    if (this._tx) return { ok: false, error: "undo: an edit is still in progress" };
    if (!this._undo.length) return { ok: false, error: "nothing to undo" };
    const entry = this._undo[this._undo.length - 1];
    const errors = canonicalizeAndValidate(entry.timeline);
    if (errors.length)
      return {
        ok: false,
        error: `undo: invalid timeline snapshot — ${errors.slice(0, 3).join("; ")}`,
      };
    this._pushRedo({ timeline: this._timeline, tag: entry.tag }); // redo re-applies the SAME composite
    this._undo.pop();
    this._timeline = entry.timeline;
    this._revision++;
    this._dirty = true;
    return {
      ok: true,
      remainingUndo: this._undo.length,
      remainingRedo: this._redo.length,
      tag: entry.tag,
    };
  }

  redo(): TimelineHistoryResult {
    if (this._tx) return { ok: false, error: "redo: an edit is still in progress" };
    if (!this._redo.length) return { ok: false, error: "nothing to redo" };
    const entry = this._redo[this._redo.length - 1];
    const errors = canonicalizeAndValidate(entry.timeline);
    if (errors.length)
      return {
        ok: false,
        error: `redo: invalid timeline snapshot — ${errors.slice(0, 3).join("; ")}`,
      };
    this._pushUndo({ timeline: this._timeline, tag: entry.tag });
    this._redo.pop();
    this._timeline = entry.timeline;
    this._revision++;
    this._dirty = true;
    return {
      ok: true,
      remainingUndo: this._undo.length,
      remainingRedo: this._redo.length,
      tag: entry.tag,
    };
  }

  /** CLEANLY revert the most-recent apply, erasing its undo slot and restoring the before-snapshot,
   *  leaving NO phantom history entry — for a COMPOSITE command (a cascade delete) whose coupled side
   *  effect (the catalog write) FAILS after the timeline mutation already applied: the command must
   *  roll back as if it never happened, so the tool's {ok:false} is truthful. Unlike undo(), it records
   *  NO redo entry (a normal undo would leave the failed command redoable — owner Q5). The top undo slot
   *  MUST be the expected tagged one (the caller applied it moments earlier inside the SAME gate lease,
   *  so nothing can have interleaved); returns false without touching state if it isn't, so a caller can
   *  never silently corrupt an unrelated edit's history. Does NOT restore the redo branch the apply
   *  cleared (standard apply semantics clear redo) — the failed command simply leaves an empty redo. */
  revertLastApply(tag: string): boolean {
    // Inside a transaction there is no slot to pop — the steps registered none. The composite's
    // coupled side effect failed, so the whole INTENT is void: restore the transaction's own
    // snapshot, which leaves nothing for it to push when it closes.
    if (this._tx) {
      if (!this._tx.tags.includes(tag)) return false;
      this._timeline = this._tx.before;
      this._tx.tags.length = 0;
      this._revision++;
      this._dirty = true;
      return true;
    }
    const top = this._undo[this._undo.length - 1];
    if (!top || top.tag !== tag) return false;
    this._undo.pop();
    this._timeline = top.timeline; // restore the pre-apply snapshot
    this._revision++;
    this._dirty = true;
    return true;
  }

  /** Replace the whole timeline (a checkpoint restore). Validates first, then RESETS undo/redo — a
   *  restore jumps to a DIFFERENT branch, so the old stacks describe an abandoned branch and a
   *  post-restore Ctrl+Z must not jump onto it (the chat transcript is the undo path for restores). */
  replace(next: Timeline): TimelineHistoryResult {
    if (this._tx) return { ok: false, error: "restore: an edit is still in progress" };
    const errors = canonicalizeAndValidate(next);
    if (errors.length)
      return {
        ok: false,
        error: `restore: invalid timeline snapshot — ${errors.slice(0, 3).join("; ")}`,
      };
    this._timeline = next;
    this._undo.length = 0;
    this._redo.length = 0;
    this._revision++;
    this._dirty = true;
    return { ok: true, remainingUndo: 0, remainingRedo: 0 };
  }

  /** Autosave calls this AFTER a successful persist, passing the revision it wrote. Dirty clears
   *  only if that is still the current revision — an edit that landed DURING the async write bumped
   *  the revision, so the newer state stays dirty (there is something newer to save). */
  markSaved(savedRevision: number): void {
    if (savedRevision === this._revision) this._dirty = false;
  }

  private _pushUndo(entry: UndoEntry): void {
    this._undo.push(entry);
    if (this._undo.length > HISTORY_CAP) this._undo.splice(0, this._undo.length - HISTORY_CAP);
  }

  private _pushRedo(entry: UndoEntry): void {
    this._redo.push(entry);
    if (this._redo.length > HISTORY_CAP) this._redo.splice(0, this._redo.length - HISTORY_CAP);
  }
}
