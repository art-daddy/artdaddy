import { MutationGate, type MutationOrigin } from "./MutationGate";
import { ProjectJobScope } from "./ProjectJobScope";
import { AutosaveController } from "./AutosaveController";
import { TimelineSession } from "../timeline/TimelineSession";
import type { Timeline } from "../timeline/model";
import { newSessionId, type ProjectId, type ProjectPhase, type SessionId } from "./types";

/** The project-scoped children a document owns. Phase 1 wraps the EXISTING per-project
 *  editor + chat stores + tool host behind this; the real close drain (MutationGate /
 *  JobScope) and in-memory authority arrive in Phases 3/5. Injected so the document is
 *  unit-testable without the stores, and so the registry — not a component — constructs
 *  them exactly once per open. */
/** The outcome of a close attempt: `ok:true` disposed + evicted; `ok:false` the final save failed,
 *  the document is kept ALIVE (memory + undo intact) in `close-failed`, and the caller must offer
 *  Retry / Discard / Cancel. */
export type CloseOutcome = { ok: true } | { ok: false };

/** Per-document injected dependencies. The pure lifecycle owner imports no stores; the composition
 *  layer (documentRegistry) wires these so the document stays unit-testable. */
export interface ProjectDocumentOpts {
  /** Origin fence for the mutation gate — a commit carrying a superseded execution's origin is rejected. */
  isOriginCurrent?: (o: MutationOrigin) => boolean;
  /** Reported when the final timeline save could not persist on close (a lost-edit risk). */
  onCloseSaveFailed?: (id: ProjectId) => void;
  /** Re-arm a FRESH timeline persist (reset retry budget) when the close SAVE finds the in-memory
   *  timeline still dirty (finding #3): a Retry must re-attempt the actual disk write, not just
   *  re-flush the already-drained autosave. Injected because the write needs the (store-bound) engine. */
  rearmTimelineSave?: (doc: ProjectDocument) => void;
  /** Reported when child teardown threw AFTER a successful save (data is durable; the teardown is
   *  best-effort). The close still COMPLETES — a partially-disposed document must never be presented as
   *  "editable" via close-failed (finding: Keep-editing can't restore already-disposed child stores). */
  onDisposeFailed?: (id: ProjectId, error: unknown) => void;
  /** Re-admit the project's producers (e.g. lower the chat admission fence) when a failed close is
   *  CANCELLED (Keep editing). Symmetric with the quiesce raised during the SAVE phase (finding #2). */
  onReopen?: (id: ProjectId) => void;
  /** Run synchronously the instant close BEGINS (before the gate/jobs drain) to CLOSE producer
   *  admission immediately — e.g. raise the chat fence + retire the turn — so no chat work is admitted
   *  once close starts, not just once the SAVE phase is reached (finding #2). Idempotent (retry re-runs). */
  onBeginClose?: (id: ProjectId) => void;
}

export interface ProjectChildren {
  /** Construct + load all children for this open. Resolves "loaded" once the project's
   *  own state committed, or "failed" (the registry then evicts the document so a retry
   *  rebuilds from scratch — a broken open is never cached). */
  open(ctx: { id: ProjectId; sessionId: SessionId }): Promise<"loaded" | "failed">;
  /** Persist the chat transcript as part of the close SAVE phase. Returns false on a real persist
   *  failure so close() offers Retry/Discard/Cancel. Re-runnable (a retry re-persists the latest).
   *  Optional: a document with no chat wiring (tests) skips it (treated as saved). */
  saveTranscript?(ctx: { id: ProjectId; sessionId: SessionId }): Promise<boolean>;
  /** Tear down all children (retire chat turn, dispose editor, evict host). Called at most once per
   *  document — only after the final save SUCCEEDS or the user explicitly Discards. */
  dispose(ctx: { id: ProjectId; sessionId: SessionId }): Promise<void>;
}

/** The single in-memory owner of one open project's lifecycle. Phase 1 establishes the
 *  ONE owner + the explicit phase machine + an idempotent close; it does not yet own
 *  timeline/undo/persistence state (those move under it in later phases). */
/** A composite command's library-side companion: the document runs `onUndo` when the coupled undo
 *  slot is undone and `onRedo` when it is redone, so a cascade delete's timeline + library halves
 *  move as ONE undo entry. Opaque to the document (the cascade delete supplies the closures). */
export interface CompositeCompanion {
  onUndo: () => Promise<void>;
  onRedo: () => Promise<void>;
}

export class ProjectDocument {
  readonly id: ProjectId;
  readonly sessionId: SessionId;
  /** The mandatory boundary for this document's authoritative mutations. REPLACED with a fresh
   *  drained instance by cancelClose() (the gate is one-way closed during a close drain). */
  gate: MutationGate;
  /** This document's tracked long-running work. REPLACED with a fresh instance by cancelClose(). */
  jobs: ProjectJobScope;
  /** Coalesced asynchronous persistence of the in-memory timeline (Phase 5.4). */
  readonly autosave: AutosaveController;
  private _phase: ProjectPhase = "opening";
  private _closeRun: Promise<CloseOutcome> | null = null;
  /** The in-memory timeline authority while this project is open (Phase 5). Created LAZILY on the
   *  first gated commit (seeded from disk under the gate lease), so editor + agent edits then share
   *  ONE in-memory timeline + history instead of reloading timeline.json per edit. Null until the
   *  first edit; readers fall back to disk until then. Discarded with the document on close. */
  private _timeline: TimelineSession | null = null;
  /** Composite-command companions keyed by the undo slot's `tag` (see TimelineSession). Registered by
   *  a cascade delete; the document runs one on undo/redo of its slot. Bounded by the session's cascade
   *  deletes; a slot that falls off the stacks is simply unreachable (never re-run) and dies with the
   *  document on dispose. Survives cancelClose (the undo history it belongs to survives too). */
  private readonly _companions = new Map<string, CompositeCompanion>();
  /** Reported when the final save could not persist on close (a lost-edit risk). Injected so this
   *  pure lifecycle owner needn't import observability. */
  private readonly onCloseSaveFailed?: (id: ProjectId) => void;
  /** Kept so cancelClose() can rebuild an identical gate (same id / session / origin fence). */
  private readonly isOriginCurrent?: (o: MutationOrigin) => boolean;
  /** Re-arm a fresh timeline persist on the close SAVE / Retry (finding #3). */
  private readonly rearmTimelineSave?: (doc: ProjectDocument) => void;
  /** Report best-effort teardown failure (finding #4) + re-admit producers on cancel (finding #2). */
  private readonly onDisposeFailed?: (id: ProjectId, error: unknown) => void;
  private readonly onReopen?: (id: ProjectId) => void;
  /** Close producer admission synchronously the instant close begins (finding #2). */
  private readonly onBeginClose?: (id: ProjectId) => void;

  constructor(
    id: ProjectId,
    private readonly children: ProjectChildren,
    opts: ProjectDocumentOpts = {},
  ) {
    this.id = id;
    this.sessionId = newSessionId(); // fresh per open/reopen — a same-id reopen is distinguishable
    this.isOriginCurrent = opts.isOriginCurrent;
    this.gate = new MutationGate(id, this.sessionId, opts.isOriginCurrent);
    this.jobs = new ProjectJobScope();
    this.autosave = new AutosaveController();
    this.onCloseSaveFailed = opts.onCloseSaveFailed;
    this.rearmTimelineSave = opts.rearmTimelineSave;
    this.onDisposeFailed = opts.onDisposeFailed;
    this.onReopen = opts.onReopen;
    this.onBeginClose = opts.onBeginClose;
  }

  phase(): ProjectPhase {
    return this._phase;
  }

  /** The in-memory timeline, or null before the first gated commit created it. Readers use this
   *  when present (Phase 5.3c+) and fall back to disk otherwise. */
  get timeline(): TimelineSession | null {
    return this._timeline;
  }

  /** The in-memory timeline session, created ONCE from `load()` (seeded from disk on the first
   *  gated commit) and reused thereafter. Callers run this UNDER the mutation-gate lease, so the
   *  create-or-reuse is serialized — no two commits race the lazy load. */
  async timelineSession(load: () => Promise<Timeline>): Promise<TimelineSession> {
    if (!this._timeline) this._timeline = new TimelineSession(await load());
    return this._timeline;
  }

  /** Couple a library side effect to the timeline undo slot `tag` (a cascade delete registers this so
   *  undoing the slot re-adds the deleted catalog item and redoing it re-removes it). */
  registerComposite(tag: string, companion: CompositeCompanion): void {
    this._companions.set(tag, companion);
  }

  /** Run the companion's undo side for a just-undone slot's `tag` (re-add the deleted library item).
   *  No-op for a plain edit (no tag) or an evicted slot (no companion). */
  async runCompositeUndo(tag: string | undefined): Promise<void> {
    if (tag) await this._companions.get(tag)?.onUndo();
  }

  /** Run the companion's redo side for a just-redone slot's `tag` (re-remove the library item). */
  async runCompositeRedo(tag: string | undefined): Promise<void> {
    if (tag) await this._companions.get(tag)?.onRedo();
  }

  /** Open the children once. Called by the registry immediately after construction. */
  async open(): Promise<"loaded" | "failed"> {
    if (this._phase !== "opening") throw new Error(`open() called on a ${this._phase} document`);
    let outcome: "loaded" | "failed";
    try {
      outcome = await this.children.open({ id: this.id, sessionId: this.sessionId });
    } catch {
      outcome = "failed";
    }
    if (outcome === "failed") {
      // A failed open must leave NOTHING running: tear down whatever children.open partially
      // activated (e.g. chat activated but the editor load failed). children.close is
      // idempotent; the registry then evicts this document so a retry rebuilds from scratch.
      try {
        await this.children.dispose({ id: this.id, sessionId: this.sessionId });
      } catch {
        /* teardown is best-effort — the open already failed */
      }
    }
    // A close cannot begin before the registry publishes this doc (post-open), so the phase
    // is still "opening" here; guard defensively anyway rather than resurrect over a close.
    if (this._phase === "opening") this._phase = outcome === "loaded" ? "open" : "failed";
    return outcome;
  }

  /** Attempt to close: drain new work (`closing`), SAVE the timeline + transcript (`saving`), and
   *  ONLY THEN dispose. A save failure keeps the document ALIVE (memory + undo intact) in
   *  `close-failed` and returns `{ ok: false }`; the caller shows Retry / Discard / Cancel. The
   *  document + its children are NEVER disposed on a failed save. Idempotent while an attempt is in
   *  flight; re-callable after a failure (that is a retry). */
  close(): Promise<CloseOutcome> {
    if (this._phase === "closed") return Promise.resolve({ ok: true });
    if (this._closeRun) return this._closeRun;
    this._closeRun = this.saveThenDispose().finally(() => {
      this._closeRun = null; // cleared even on failure, so retryClose() can run a fresh attempt
    });
    return this._closeRun;
  }

  /** Retry a failed close — re-attempt the SAVE. Same path as close(); the drain is idempotent. */
  retryClose(): Promise<CloseOutcome> {
    return this.close();
  }

  /** Discard: tear down DESPITE a dirty/unsaved state. Destructive — the caller confirms first. */
  async discardClose(): Promise<void> {
    if (this._phase === "closed") return;
    try {
      await Promise.all([this.gate.beginClose(), this.jobs.beginClose()]); // idempotent if already drained
      await this.children.dispose({ id: this.id, sessionId: this.sessionId });
    } catch (e) {
      // Destructive intent: a partial-teardown throw must NOT leave the doc close-failed (the dialog
      // would then offer Keep-editing on a half-destroyed doc, finding #3). Report the leak; the finally
      // still finalizes as closed so the registry evicts it — never editable again.
      this.safeReport(() => this.onDisposeFailed?.(this.id, e));
    } finally {
      this._phase = "closed";
    }
  }

  /** Cancel a failed close and RETURN TO EDITING. The gate + job scope were one-way closed during the
   *  drain, so replace them with FRESH drained instances (old jobs stay cancelled — they were aborted
   *  during the drain). No-op unless a close actually failed. */
  cancelClose(): void {
    if (this._phase !== "close-failed") return;
    this.gate = new MutationGate(this.id, this.sessionId, this.isOriginCurrent);
    this.jobs = new ProjectJobScope();
    this._phase = "open";
    this.safeReport(() => this.onReopen?.(this.id)); // re-admit producers — a throw must NOT undo the transition
  }

  /** Fire a REPORTING / re-admit callback that must NEVER derail the lifecycle state machine: a
   *  telemetry or fence-lowering hook that throws must not turn a durable close into a phantom
   *  failure, stick the phase, or abort a cancel (finding #3 — callbacks may not control phase
   *  completion). Invariant-bearing hooks (onBeginClose) instead run INSIDE the close error boundary. */
  private safeReport(fn: () => void): void {
    try {
      fn();
    } catch {
      /* best-effort — swallow so a reporting/re-admit callback can't control the phase */
    }
  }

  private async saveThenDispose(): Promise<CloseOutcome> {
    try {
      // Close producer admission the INSTANT close begins (synchronously, before the drain), so no chat
      // work is admitted from here on (finding #2). INSIDE the error boundary: this hook is
      // invariant-bearing (it raises the transcript fence), so if it throws the close lands in
      // close-failed (recoverable) instead of escaping with the doc still phase `open` and no
      // discoverable recovery state (finding #3).
      this.onBeginClose?.(this.id);
      // preparing-close: reject new commits + jobs, then drain the one leased commit + finishBeforeClose
      // jobs (cancelOnClose/resumable are aborted, not waited). Skip re-flagging on a retry (already drained).
      if (this._phase !== "close-failed") this._phase = "closing";
      await Promise.all([this.gate.beginClose(), this.jobs.beginClose()]);
      this._phase = "saving";
      if (!(await this.attemptFinalSave())) {
        // Final save failed: keep memory + undo alive, surface it (telemetry), and let the caller offer
        // Retry / Discard / Cancel. Do NOT dispose the children or evict the document.
        return this.enterCloseFailed();
      }
    } catch {
      // An unexpected throw DURING the begin-close hook, drain, or SAVE (before any teardown) is a
      // failed save: keep the document fully intact + recoverable. Children were NOT touched yet, so
      // Keep-editing is safe.
      return this.enterCloseFailed();
    }
    // The save SUCCEEDED — the data is durable. Teardown is now best-effort: a dispose throw must NOT
    // send the document to close-failed (finding #4), because children are already PARTIALLY disposed
    // and "Keep editing" cannot restore them. Complete the close (data is safe) and report the leak.
    try {
      await this.children.dispose({ id: this.id, sessionId: this.sessionId });
    } catch (e) {
      this.safeReport(() => this.onDisposeFailed?.(this.id, e)); // report the leak — a throwing reporter must not derail the durable close
    }
    this._phase = "closed";
    return { ok: true };
  }

  /** Enter (or stay in) close-failed: the document is kept alive (memory + undo intact) and the save
   *  failure is surfaced. Returns the {ok:false} outcome the registry keys retention on. */
  private enterCloseFailed(): CloseOutcome {
    this._phase = "close-failed";
    this.safeReport(() => this.onCloseSaveFailed?.(this.id)); // telemetry must never turn recovery into a throw
    return { ok: false };
  }

  /** Persist BOTH the in-memory timeline (autosave flush) and the chat transcript. Returns true only
   *  if both are durable — a dirty timeline after flush, or a transcript persist failure, fails it.
   *  The autosave flush runs BEFORE any dispose (which would bump the session generation), so the
   *  last edit lands on disk. */
  private async attemptFinalSave(): Promise<boolean> {
    // If the async autosave already exhausted its retries and left the timeline dirty, re-arm a FRESH
    // persist (finding #3) so a Retry re-attempts the ACTUAL write; the flush below then blocks on it.
    if (this._timeline?.isDirty()) this.rearmTimelineSave?.(this);
    await this.autosave.flush();
    const timelineOk = !this._timeline?.isDirty();
    const transcriptOk = this.children.saveTranscript
      ? await this.children.saveTranscript({ id: this.id, sessionId: this.sessionId })
      : true;
    return timelineOk && transcriptOk;
  }
}
