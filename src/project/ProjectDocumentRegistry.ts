import {
  ProjectDocument,
  type CloseOutcome,
  type ProjectChildren,
  type ProjectDocumentOpts,
} from "./ProjectDocument";
import type { ProjectId } from "./types";

/** An in-flight open. `doomed` is set when a close arrives while the project is still
 *  opening: the open runs to completion (so its children can be torn down cleanly) but is
 *  never published as "open", and the close chains off it. */
interface PendingOpen {
  promise: Promise<ProjectDocument>;
  doomed: boolean;
}

/** The source of truth for which projects are open. Deduplicates `open` (single-flight),
 *  owns `close`, and enforces the full set of lifecycle transitions:
 *  - concurrent open(id) share one document;
 *  - open while closing waits for the close, then builds ONE fresh instance;
 *  - close while OPENING dooms the in-flight open and tears it down when it settles, so a
 *    leave-during-open can never orphan a live document;
 *  - a reopen during a close-while-opening waits for that teardown, then opens fresh.
 *  Mirrors the coordinator's closing/closePromises drain pattern. */
export class ProjectDocumentRegistry {
  private readonly openDocs = new Map<ProjectId, ProjectDocument>(); // reached phase "open" (+ retained close-failed)
  private readonly pending = new Map<ProjectId, PendingOpen>(); // in-flight open
  private readonly closing = new Map<ProjectId, Promise<CloseOutcome>>(); // in-flight close (promise)
  /** The document mid-close (from close start until settleClose resolves). It is NO LONGER "open" for
   *  the UI (removed from openDocs), but it REMAINS the runtime AUTHORITY — its (closing) gate must
   *  still receive + REJECT mutations, so a write during close can't slip past the gate via the
   *  executor's no-document fallback (reviewer blocker 1). Ownership ≠ UI open-visibility. */
  private readonly closingDocs = new Map<ProjectId, ProjectDocument>();

  /** @param makeChildren builds the (injected) child lifecycle for a given project id.
   *  @param makeDocumentOpts optional per-document options (e.g. the origin-fence isOriginCurrent
   *         bound to that project's live chat execution). */
  constructor(
    private readonly makeChildren: (id: ProjectId) => ProjectChildren,
    private readonly makeDocumentOpts?: (id: ProjectId) => ProjectDocumentOpts,
  ) {}

  /** The open document for `id`, or undefined if it isn't open (opening/closing/closed). */
  get(id: ProjectId): ProjectDocument | undefined {
    return this.openDocs.get(id);
  }

  /** The RUNTIME-AUTHORITY document for `id` — open, close-failed (retained), OR mid-close — for the
   *  mutation executor + readers, so a commit during close routes through the still-live (closing)
   *  gate and is REJECTED, instead of falling back to a bare lock and slipping past admission. This is
   *  the OWNERSHIP view (who owns the runtime state), distinct from `get()`'s open-VISIBILITY view. */
  getAuthority(id: ProjectId): ProjectDocument | undefined {
    return this.openDocs.get(id) ?? this.closingDocs.get(id);
  }

  listOpen(): readonly ProjectDocument[] {
    return [...this.openDocs.values()];
  }

  /** The first document whose final save FAILED on close — it is retained (live, editable, memory +
   *  undo intact) in `close-failed`. Shell uses this to VETO opening a second project over a failed
   *  close no matter how the route changed (menu OR browser back/forward), then routes back to it +
   *  raises the Retry/Discard/Cancel modal (finding #4). Undefined when no close is unresolved. */
  firstCloseFailed(): ProjectDocument | undefined {
    return [...this.openDocs.values()].find((d) => d.phase() === "close-failed");
  }

  /** Single-flight open. Concurrent callers share one document; an open issued while the
   *  same id is closing (or being torn down mid-open) waits for that teardown, then builds
   *  ONE fresh instance. */
  open(id: ProjectId): Promise<ProjectDocument> {
    const existing = this.openDocs.get(id);
    if (existing) return Promise.resolve(existing);
    const pend = this.pending.get(id);
    if (pend && !pend.doomed) return pend.promise; // share a healthy in-flight open
    // No open in flight, or the in-flight one is doomed (a close is tearing it down): start
    // a fresh open. doOpen waits for any in-flight close first (open-awaits-close).
    const entry: PendingOpen = {
      promise: undefined as unknown as Promise<ProjectDocument>,
      doomed: false,
    };
    entry.promise = this.doOpen(id, entry).finally(() => {
      if (this.pending.get(id) === entry) this.pending.delete(id);
    });
    this.pending.set(id, entry);
    return entry.promise;
  }

  private async doOpen(id: ProjectId, entry: PendingOpen): Promise<ProjectDocument> {
    const priorClose = this.closing.get(id);
    if (priorClose) await priorClose; // open-awaits-close: settle the old teardown first
    // Doomed FIRST (finding #1): a close that arrived while we awaited the prior teardown CANCELS this
    // reopen — throw so it never returns a (retained or fresh) live document the user asked to close.
    // The chained close then tears down the CURRENT doc (its onRejected closes a retained one); a
    // reopen caller (Shell) is mid-route-change and ignores the rejection.
    if (entry.doomed) throw new Error(`open of ${id} was cancelled by a close`);
    // ONE live document per project: a FAILED prior close RE-INSERTS its still-live document
    // (close-failed, memory + undo intact). Never construct a SECOND over it — return the retained one
    // so the registry keeps pointing at a single instance (the close-failed modal drives Retry /
    // Discard / Cancel; the dirty original is never left unreachable and later overwritten).
    const retained = this.openDocs.get(id);
    if (retained) return retained;
    const doc = new ProjectDocument(id, this.makeChildren(id), this.makeDocumentOpts?.(id));
    const outcome = await doc.open();
    if (outcome !== "loaded") {
      // Evict a failed open (never stored) so a retry rebuilds from scratch.
      throw new Error(`could not open project ${id}`);
    }
    // If a close arrived while we were opening, do NOT publish as open — the close path
    // (which chained off this promise) tears the doc down. Checking THIS entry's flag (not
    // the current pending, which a reopen may have replaced) keeps the two opens distinct.
    if (entry.doomed) return doc;
    this.openDocs.set(id, doc);
    return doc;
  }

  /** Idempotent close. After it settles, the project is NOT open — including any reopen that slipped in.
   *  - If open: remove from the open set SYNCHRONOUSLY (no longer "open" the instant close starts),
   *    tear down, settle (retained on a failed save).
   *  - If a NON-doomed open is in flight (a fresh open OR a reopen that arrived after an earlier close):
   *    doom it and tear it down when it settles — this runs EVEN IF an earlier close is already in
   *    flight, so a repeat close can't leave the project reopened (finding #1).
   *  - Otherwise an in-flight (or already-doomed) close is reused. */
  close(id: ProjectId): Promise<CloseOutcome> {
    const doc = this.openDocs.get(id);
    if (doc) {
      // Remove from the open set SYNCHRONOUSLY (a closing project is no longer "open", so a concurrent
      // open() dedup sees it gone and awaits this close); settleClose RE-INSERTS it on a FAILED save so
      // it stays live + editable for Retry / Discard / Cancel. Disposed/evicted only on a clean close.
      this.openDocs.delete(id);
      const p = this.settleClose(id, doc).finally(() => {
        if (this.closing.get(id) === p) this.closing.delete(id);
      });
      this.closing.set(id, p);
      return p;
    }

    const pend = this.pending.get(id);
    if (pend && !pend.doomed) {
      // A NON-doomed in-flight open: doom it so it won't publish, and tear it down when it settles. This
      // runs BEFORE reusing any in-flight close (finding #1: a reopen that slipped in after an earlier
      // close would otherwise publish a live doc AFTER the user closed the project — the earlier close's
      // promise never doomed it). doOpen internally awaits any prior close, so pend.promise already
      // sequences after it; a doomed open that never built rejects and is treated as "nothing to close".
      pend.doomed = true;
      const p = pend.promise
        .then(
          (opened) => this.settleClose(id, opened), // opened but never published -> tear it down (retain a failed save)
          () => {
            // The doomed open threw (cancelled while awaiting a prior close, or never built). If an
            // EARLIER failed close RE-INSERTED a retained doc for this id, THIS close must still tear
            // THAT down — otherwise a repeat close leaves the retained close-failed doc stuck as open
            // (finding #1). Otherwise there is nothing to close.
            const retained = this.openDocs.get(id);
            return retained ? this.settleClose(id, retained) : ({ ok: true } as CloseOutcome);
          },
        )
        .finally(() => {
          if (this.closing.get(id) === p) this.closing.delete(id);
        });
      this.closing.set(id, p);
      return p;
    }

    // No open document and no fresh open to doom: reuse an in-flight (or already-doomed) close, else done.
    const inFlight = this.closing.get(id);
    if (inFlight) return inFlight;

    return Promise.resolve({ ok: true });
  }

  /** Close a document and settle the open set: RETAIN it (re-insert) on a FAILED save or an unexpected
   *  rejection so it stays reachable (live, editable) for Retry / Discard / Cancel; EVICT it on a clean
   *  close so the id is never left registered as open. The ONE settlement boundary shared by every
   *  close path (open + pending-open) so they can never drift on retention/eviction. */
  private settleClose(id: ProjectId, doc: ProjectDocument): Promise<CloseOutcome> {
    // The closing doc STAYS the runtime authority (getAuthority) until it settles, so a mutation during
    // the drain routes through its (closing) gate and is rejected — not slipped past via the fallback.
    this.closingDocs.set(id, doc);
    return doc
      .close()
      .then(
        (outcome) => {
          if (outcome.ok) {
            // Disposed + closed: it must NOT stay registered as open. A CONCURRENT failed close may have
            // re-inserted this same instance (finding #1) — evict it, IDENTITY-checked so a freshly
            // published reopen is never clobbered, so a successful close always leaves the id empty.
            if (this.openDocs.get(id) === doc) this.openDocs.delete(id);
          } else {
            this.openDocs.set(id, doc); // retained: live + editable for Retry / Discard / Cancel
          }
          return outcome;
        },
        () => {
          // Defensive: ProjectDocument.close() is designed to always resolve, but a future change (or an
          // unexpected throw it doesn't catch) must still NOT orphan the doc — re-insert it and report
          // failure so a later Retry finds it instead of falsely returning ok.
          this.openDocs.set(id, doc);
          return { ok: false } as CloseOutcome;
        },
      )
      .finally(() => {
        // No longer mid-close: a retained close-failed doc is now reachable via openDocs; a clean close
        // left the id empty. Identity-checked so a repeat close's newer settle isn't dropped.
        if (this.closingDocs.get(id) === doc) this.closingDocs.delete(id);
      });
  }

  /** Retry a failed close (drives the same close path — the doc is still in openDocs, `close-failed`). */
  retryClose(id: ProjectId): Promise<CloseOutcome> {
    return this.close(id);
  }

  /** Discard a failed close: tear down DESPITE dirty state (the UI confirms first), then evict. */
  async discardClose(id: ProjectId): Promise<void> {
    const doc = this.openDocs.get(id);
    if (!doc) return;
    await doc.discardClose();
    this.openDocs.delete(id);
  }

  /** Cancel a failed close: return the document to editing (fresh gate/job scope); it stays open. */
  cancelClose(id: ProjectId): void {
    this.openDocs.get(id)?.cancelClose();
  }

  /** Resolve once every in-flight close has settled. Shell awaits this before opening the
   *  next project, so a switch fully tears the previous one down first — deterministic
   *  teardown ordering (the active editor/chat pointer never flips the wrong way). Drains to a
   *  STABLE closing set: a repeat close REPLACES the per-id promise (a later close2 overwrites
   *  close1 in `closing`), so a single snapshot could resolve while the LATEST close is still saving
   *  (finding #2). Re-snapshot after each round — a settled close removes itself (identity-checked
   *  finally), so any promise still present is newer; loop until none remain. */
  async whenIdle(): Promise<CloseOutcome> {
    let ok = true;
    while (this.closing.size > 0) {
      const results = await Promise.allSettled([...this.closing.values()]);
      for (const r of results) if (!(r.status === "fulfilled" && r.value.ok)) ok = false;
    }
    return ok ? { ok: true } : { ok: false };
  }
}
