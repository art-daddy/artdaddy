// AutosaveController — coalesces ASYNCHRONOUS persistence for one open document (Phase 5). Edits
// apply to in-memory state synchronously and each schedules a save here; the actual timeline.json
// write happens off the edit's critical path. COALESCING: while one save runs, further schedules
// collapse into a SINGLE follow-up (every save closure persists the document's CURRENT state, so only
// the latest need run) — a burst of edits yields the latest state written once, not one write per
// edit. flush() resolves once the in-flight save AND any coalesced follow-up have settled; the
// document's close() awaits it (AFTER the mutation gate drains) so the last dirty revision is
// persisted before teardown. A save closure owns its own success/failure semantics: on failure it
// leaves the document dirty (surfaced as "Unsaved") WITHOUT rolling back the valid in-memory edit. A
// thrown save is swallowed here so it can never break the drain loop or reject flush().
export class AutosaveController {
  private inFlight: Promise<void> | null = null;
  private next: (() => Promise<void>) | null = null;

  /** Queue a save. The newest closure supersedes any not-yet-started one (they all persist the
   *  CURRENT state, so only the latest need run), and the drain starts if idle. Returns immediately
   *  — the write runs off the edit's critical path. */
  schedule(save: () => Promise<void>): void {
    this.next = save;
    this.inFlight ??= this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (this.next) {
        const save = this.next;
        this.next = null; // a schedule() during `await save()` re-arms this and loops once more
        try {
          await save();
        } catch {
          // A failed persist leaves the document dirty (the closure does NOT markSaved on failure);
          // it is surfaced as Unsaved. Never break the drain or reject flush() on a save error.
        }
      }
    } finally {
      this.inFlight = null;
    }
  }

  /** Resolve once the in-flight save and any coalesced follow-up have settled. close() awaits this
   *  after the mutation gate drains, so the latest dirty revision is persisted before teardown. */
  flush(): Promise<void> {
    return this.inFlight ?? Promise.resolve();
  }

  /** True while a save is running or queued (observability/tests). */
  isSaving(): boolean {
    return this.inFlight !== null;
  }
}
