# ADR 0001 — ProjectDocument refactor: scope and persistence deferral

- **Status:** Accepted
- **Date:** 2026-07-26
- **Baseline:** `artdaddy` @ `a1a33fd`
- **Owner decision:** confirmed 2026-07-26
- **Full design:** [PROJECT_DOCUMENT_ARCHITECTURE.md](../PROJECT_DOCUMENT_ARCHITECTURE.md)
- **Deferred-work queue:** `ArtDaddy/ideas.md` → `IDEA-CLIENT-PERSIST-001`

## Context

A long external-review cycle traced our recurring lifecycle bugs (writes landing after
close, a rapid reopen reading state before the old close drained, a stale chat load
overwriting a newer transcript, an aborted URL import writing after close reported idle,
an old session updating the frontmost project, undo history recreated after close) to one
root cause: **project ownership is split across many components, each implementing part of
close/cancellation/persistence, coordinated through optional guards and the on-disk file.**
Adding more optional guards did not remove the root cause — every fix needed another.

The agreed remedy is the `ProjectDocument` architecture: one authoritative in-memory owner
per open project, one mandatory mutation boundary, one job scope, one repository for file
access. The design is sound. Its **one unproven piece** is the Phase 6 persistence rewrite:
whole-project atomic publication depends on a crash-safe, same-volume rename + `CURRENT`
pointer swap on Windows that the doc itself says cannot be assumed from Tauri's JS FS API
and may require a native Rust primitive.

## Decision

1. **Implement the refactor Phases 0–5, 7, 8** — ownership + registry, mandatory
   `MutationGate`, `ProjectJobScope`, repository containment of raw FS access,
   **in-memory-authoritative state with a flat autosave (Phase 5)**, derived-service
   cleanup, and legacy removal.
2. **Defer Phase 6** — the revisioned-JSON format, exactly-three-revision retention,
   **whole-project atomic publish**, and corrupt-revision auto-fallback recovery — plus the
   two Phase-6-adjacent items: the `%LOCALAPPDATA%\ArtDaddy\Projects` relocation +
   copy-on-first-open migration + `PROJECT_FORMAT` marker, and the **cross-process
   single-writer lock**. Queued in `IDEA-CLIENT-PERSIST-001`.
3. **Keep the current durable path:** flat, per-file atomic writes (`writeTextAtomic`,
   tmp + rename) at the current project location.
4. **Keep external-file-change detection**, re-implemented on flat files via per-file
   hash/mtime comparison before a save (warn + offer Reload; never silently merge).
5. **Phase 5 is in.** In-memory `Timeline` is authoritative while the project is open;
   `timeline.json` is truth on close/reopen; autosave runs asynchronously and coalesced
   after each completed command; a save failure surfaces a persistent **Unsaved** state;
   close/switch waits for the latest save. (Standard editor model.)
6. **Include the `import_media.source.path` removal in Phase 4** — a co-shipped
   backend + client contract change (edit `definitions.py`, bump `CONTRACT_VERSION`,
   `npm run codegen`, add a client-side raw-path rejection guard). The Agent addresses
   media only by stable ID; a human picker/drop creates the linked library item.

### Amendment (2026-07-28 — post-implementation review)

An external review of the merged phases confirmed the direction but found the gate / session /
in-memory authority was applied to the **timeline** path only, not propagated to import / library /
pack / duplicate / close-exit. The agreed remediation adds three shared pieces — a **retryable close
coordinator** (open → preparing-close → save → success | Retry/Discard/Cancel; the registry retains
the document until close succeeds or is discarded), a **required project runtime** that classifies
every tool's effect (`read | derived-job | project-job | project-mutation | app-operation |
deliverable`) and routes long work through `ProjectJobScope` + the final commit through
`MutationGate`, and a **flat project consistency bridge** that Pack / Duplicate / reference-checks
read instead of live disk. Two earlier decisions are superseded:

- **Decision 4 (external-file-change detection) is DEFERRED for alpha.** ArtDaddy ignores out-of-band
  edits to project JSON for alpha and documents the limitation (revisit with Phase 6). It is NOT
  implemented — do not claim conflict/Reload UX.
- **Decision 6 (import_media.source.path removal) is REVERSED (parity with established NLEs).**
  `import_media.source.path` accepts a file/directory and **links it in place**, returning a
  `media_ref`; the model may pass a local path to import, then addresses media by `media_ref` /
  `clip_id`. `import_media` is the single model-facing import door; `library_op add.path` is removed.
  Human local imports link by default; pasted / web / generated media stay project-owned copies.

Phase 6 remains deferred; §6 / definition-of-done clauses that assume revisioned persistence are
Phase-6 targets, not alpha requirements. `sessionLive` is retained as the deepest late-write fence.

## Accepted residual risk

Deferring whole-project atomic publish means a crash **between** two per-file writes can
leave a **torn project** (e.g. a new `timeline.json` next to an old `library.json`). The
per-file atomic writes remain, so no single file is ever half-written, but **cross-file
(whole-project) atomicity is not guaranteed for alpha.**

This is accepted because: alpha is single-user on a local internal drive; autosave is
coalesced (the torn window is small and rare); and this is the *current* behavior — we are
choosing not to *improve* it yet, not introducing a regression. Per rule 56, **no code,
comment, or commit will claim "atomic project save" until Phase 6 lands.** Crash/power-loss
durability is explicitly out of the alpha product claim.

## Consequences

- **We get now:** the lifecycle bug class is killed structurally — one owner, mandatory
  admission, a real close drain over commits *and* jobs, session/branch/execution identity
  carried to the final commit, and raw FS access contained to the repository.
- **We do not get (deferred):** whole-project atomic saves, three-revision crash recovery,
  the Local AppData relocation, and second-instance write protection.
- **Forward path is clean:** because Phase 4 introduces the `ProjectPackageRepository` port,
  Phase 6 later drops in as a new repository implementation **without changing document or
  domain interfaces**. The in-memory-authoritative model (Phase 5) is unaffected by the
  on-disk format, so it can land now on flat files.

## In-memory model (Phase 5), concretely

Today every edit round-trips through disk: `applyOp` does `loadTimeline` (read
`timeline.json`) → mutate → `saveTimeline` (write + emit on a global bus) → the editor
store reflects the change via its bus subscription. Disk is both the durable store **and**
the live coordination bus (Problem 5).

After Phase 5:

```text
edit (human OR agent) command
  -> read the in-memory Timeline (no disk read)
  -> apply the pure timeline transition + validate
  -> update in-memory state once, register one undo entry
  -> emit a document-local event (UI + agent see it immediately)
  -> schedule a coalesced background autosave (flat per-file writes)
  -> return a receipt
close/switch: wait for the latest autosave; on failure, hold "Unsaved" + recovery actions
```

Memory is truth while open; `timeline.json` is truth on reopen. The global timeline bus and
the module-global undo map are replaced by document-owned events + a `ProjectUndoManager`.

## Phase 0 plan (adjusted for the deferrals)

Phase 0 lays seams and pins behavior; it ships no new lifecycle owner yet. Because Phase 6
and the writer lock are deferred, the doc's Phase 0 FS/publication spike, `PROJECT_FORMAT`
compatibility gate, Local AppData allocator, and two-process/crash harness are **dropped
from Phase 0** and move to `IDEA-CLIENT-PERSIST-001`.

Deliverables:

1. **Test hygiene:** exclude `.stryker-tmp/**` from normal Vitest discovery (removes the
   duplicate sandbox test runs).
2. **Typed seams (types only, no behavior):** branded `ProjectId` / `SessionId`; the
   `ProjectResult<T>` + `ProjectFailureKind` outcome taxonomy.
3. **Deterministic test harness/builders:** deferred-promise gates + fakes for the future
   registry / document / mutation gate / job scope, so Phase 1–3 tests never rely on sleeps.
4. **Regression tests that pin the already-fixed behavior** (from Slices 1–3b this round),
   so the refactor cannot silently regress them:
   - close is idempotent and drains in-flight commits;
   - reopen waits for the prior close (no seed over an in-flight edit);
   - a write crossing a close is abandoned at the commit boundary;
   - per-instance: project A's chat `undo`/`redo`/`restoreTo` cannot mutate B;
   - a stale transcript persist is abandoned once the session ended.
5. **Scaffold still-open gaps as `.todo`/`.skip` (suite stays green)** with the phase that
   closes them — e.g. "an aborted URL import cannot write `library.json` after close"
   (closed by the Phase 3 `ProjectJobScope`).
6. **Perf baseline:** record open, first-preview, and a few common timeline-command timings
   for later comparison.

Each item is a focused commit; nothing here changes ownership or persistence format.

## References

- [PROJECT_DOCUMENT_ARCHITECTURE.md](../PROJECT_DOCUMENT_ARCHITECTURE.md) — full design (§19–20 = the deferred persistence detail; §22 = phases; §25–26 = forbidden shortcuts + review checklist)
- `ArtDaddy/ideas.md` → `IDEA-CLIENT-PERSIST-001` — deferred-work queue entry
