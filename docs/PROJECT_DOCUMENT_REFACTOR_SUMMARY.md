# ProjectDocument Refactor — Implementation Summary (for review)

> Audience: the reviewer.
> Companion to the design spec [`PROJECT_DOCUMENT_ARCHITECTURE.md`](PROJECT_DOCUMENT_ARCHITECTURE.md)
> and [`adr/0001-project-document-scope-and-persistence.md`](adr/0001-project-document-scope-and-persistence.md).
> Baseline reviewed by the spec: `artdaddy@a1a33fd` (2026-07-26).
> **Everything below is committed LOCAL only — nothing has been pushed.**

> **Post-audit update (2026-07-28):** a follow-up review found real gaps — import / library / pack /
> duplicate / close-exit are not behind the gate / session / in-memory authority; a failed final save
> disposed memory instead of refusing close; `library_op add.path` re-opened a raw-path channel; and a
> full `tsc` + the smoke lane were never run (2 type errors + 22 smoke failures). These are being
> remediated per the agreed plan (see
> [ADR-0001 → Amendment](adr/0001-project-document-scope-and-persistence.md)): a **retryable close
> coordinator**, a **required project runtime**, and a **flat consistency bridge**. The per-phase notes
> below describe the pre-remediation state and are being updated as each fix lands.

### Remediation progress — Step 1: trustworthy baseline (2026-07-28)

All local, nothing pushed:

| Commit | Repo | What |
|---|---|---|
| `b45799a` | client | Fixed 2 `tsc` errors (`indexCoordinator.test.ts`, `store.test.ts`) that `get_errors` had missed |
| `d99ee08` | client | Migrated the smoke/golden e2e harness to a per-dir `ProjectDocument` + library refs |
| `336b080` | backend | Restored the v1 ideas clobbered by `46cf72e` (byte-safe) + deduped the pre-existing `IDEA-V4-001` |
| `50b714d` | client | Reconciled ADR / architecture / this summary with the locked post-review decisions |
| `c2896e0` | client | e2e harness drives the real `ProjectDocument` `open()`/`close()` phase transitions |
| `6689065` | client | Made §1.1 + §16 authoritative on the locked decisions; recorded Step-1 |
| `c6e4156` | client | e2e resolver **awaits** the real open before exposing a doc; **surfaces** close failures |
| `5da2406` | client | Rewrote the stale doc sections (alpha contract, capability rules, Phase 4, definition of done, caveman) to shipped behavior |

**Validation now:** `npm run typecheck` → **exit 0**; `npm run smoke` → **33 passed / 0 failed** (2 files, 3 skipped); unit +
property + component suites unchanged at **95.02% lines/statements**. The full `tsc` and the smoke lane
(a separate `vitest.smoke.config.ts` not in the coverage run) are now part of the per-slice loop.

This document explains what was actually built, phase by phase and sub-slice by sub-slice, with
the design choices, issues found and fixed, workarounds, justifications, caveats, and the deferred
items. It is deliberately detailed so the diff can be read against intent.

---

## 0. TL;DR

- **Goal.** Replace several independently-activated per-project stores with **one `ProjectDocument`
  per open project** that is the single authoritative in-memory owner of that project's lifecycle,
  mutations, jobs, and persistence.
- **Governing invariant.** *One open project has one authoritative in-memory owner. Every project
  mutation and every background result must be admitted by that owner. Close rejects new work,
  settles accepted work, persists one consistent revision, then disposes.*
- **Scope (ADR-0001).** Implement **Phases 0–5, 7, 8**. **Defer Phase 6** (revisioned /
  whole-project-atomic persistence + three-revision recovery, the `%LOCALAPPDATA%\ArtDaddy\Projects`
  relocation + copy-on-first-open migration, and the cross-process single-writer lock) to
  post-alpha (`ArtDaddy/ideas.md` → `IDEA-CLIENT-PERSIST-001`). Alpha keeps the current **flat
  per-file atomic saves**.
- **Accepted residual risk.** A **torn project on a crash mid-save** is possible until Phase 6 —
  we make **no "atomic project save" claim**. Each file write is individually atomic (temp+rename);
  a multi-file project is not one transaction.
- **Status.** Phases 0–5, 7, 8 implemented and green; **1668 tests pass**, coverage **95.02%
  lines/statements**. Mutation testing (Stryker, report-only) run on `engine.ts`.

---

## 1. How this maps to commits

The refactor was done as many small, single-purpose commits (spec rule 24.1.3: *one architectural
movement per commit*). Reverse-chronological highlights:

| Phase | Commits (client unless noted) |
|---|---|
| Docs / ADR | `0d99a01` define refactor · `1fe3729` project contract · `7a0a6e9` caveman guide · `4c1f132` ADR-0001 |
| 0 — harness + seams | `c29460e` exclude `.stryker-tmp` from Vitest · `8f302da` typed `ProjectId`/`SessionId` brands + `ProjectResult` |
| 1 — document + registry | `2525a46` lifecycle foundation · `62a6827` close-while-opening · `089672c` route `Shell` through the registry · `302aa7c` close-before-open barrier |
| 2 — active-project UI | `25561dc` remove the switchboard state-mirror; UI reads the real instance |
| 3 — gate + job scope | `b494851` MutationGate (3a) · `94fedec` ProjectJobScope (3b) · `3b017be` document owns both; close drains both (3c) |
| 4 — containment (security subset) | `cd7ec5c`+server `9fa6e6d` drop `import_media.source.path` · `217015a` read-only media resolver · `2552b32` agent never touches absolute paths · `84d1e96` `store.fs` private + typed methods · `bef37b6`+server `7c3ee85` LUT gap · server `7891f9c` contract wording · `b2f47a5` OS Recycle-Bin delete · `de2d173` linked-local invariant · `572362e` duplicate copies authoritative only · `ebaa90e` staged library commit · `c16a338` broad-suite regression sweep |
| 5.1 | `8111992` extract pure `applyTimelineTransition` |
| 5.2 | `99949de` `TimelineSession` (in-memory timeline owner) |
| 5.3 | `0026bb8` route commits through the gate (a) · `4fe6c1e` in-memory authority (b) · `07c00ee` readers observe in-memory (c) |
| 5.4 | `50de211` `AutosaveController` (a) · `90e5a93` async coalesced autosave on the edit path (b) |
| 5.6 | `f3af54a` dirty signal through the bus (1) · `e38df53` Unsaved indicator in the menu bar (2) |
| 5.7 | `e7d5247` origin-fence mechanism (a) · `62b0993` wire to chat exec (b-1) · `d0da090` fence live end-to-end (b-2) · `0ed3871` re-check at final apply (c) |
| 7 — derived services | `64b2c97` algorithm-version cache keys (A) · `8fa38b5` cancel in-flight derived work on dispose + poster-path fix (B) · backend `3bf8e26` ideas for deferred #3/#4 |
| 8 — remove legacy | `f33504b` forbidden-dependency guard · `651f544` de-overclaim atomicity comments · `8dc43c5` declare done |
| 5.5 — drop legacy undo (done last) | `40af4b6` back `seededCtx` with an ephemeral document (1) · `b27a090` migrate `engine.test` (2a) · `7099b21` migrate `ops.test` (2b) · `e83a6b8` delete no-doc fallback + module-global undo (2c) · `9aa2ca7` final-save failure blocks close · `f0af469` flush transcript persistence on close |
| Tests — coverage + mutation | `8135492` fix stale `src/lib` mocks · `2f2f746` cover no-doc guards + `AuthProvider` · `368653f` cross the 95% gate · `e04035f` pin persist-retry bound · `ef3ffa7` pin load-retry bound |

**Sequencing note.** Phase 5.5 was intentionally completed **after** Phase 8, even though both
remove legacy. 5.5 (drop the module-global `editorHistory` undo stack) was flagged *premature* until
the timeline tests had migrated onto documents; doing it at the tail avoided silent coverage loss.

---

## 2. Pre-refactor hardening (context — why this refactor exists)

Before the formal refactor, three external-review rounds hardened the existing split-ownership
client/server and produced the **verified failure classes** the refactor's one-owner invariant is
meant to eliminate (spec §2). These are *context*, already merged, and not re-litigated here, but the
reviewer will see them in history:

- an accepted old-session write landing after close; a rapid reopen reading state before the old
  close drained; a stale chat load overwriting a newer transcript; an aborted URL import writing
  media/`library.json` after close reported idle; old-session state updating the frontmost project;
  undo history recreated after close.
- Round 1 (`F1`–`F14`), Round 2 (`R1`–`R12`), Round 3/4 follow-ups: project-id path containment,
  turn-execution encapsulation (`TurnExecution`), post-hoc billing with a max-cost hold, request
  size limits, atomic writes + corrupt-recovery, the `withProjectLock` per-project serial queue
  ("ProjectPackageCoordinator twin"), and the **single-owner undo saga** (`ddc401e` → `c5bcfba` →
  `2cfd11d` → `5f3b24f` → `2edaf15` → `9fc102b` → `ef2ad24` → `7ef2436`), which is the direct
  ancestor of the Phase 3/5 mutation gate.

The recurring lesson from that saga — *capture the currency token at submission not execution, key
by stable identity (projectDir) not object, and guard the side effect at its deepest boundary* — is
baked into the phases below.

---

## 3. Phase 0 — regression harness and architecture seams

**Commits:** `c29460e`, `8f302da`.

**Intent.** Lay type seams and test infrastructure with no behavior change.

**Delivered.**
- **Typed brands** (`8f302da`): `ProjectId` / `SessionId` opaque brands + a `ProjectResult`
  discriminated result type, so lifecycle APIs stop passing bare strings and unify their error shape.
- **Vitest discovery** (`c29460e`): exclude the `.stryker-tmp/**` mutation sandbox so a stale sandbox
  can't double-run the suite (this had previously produced confusing duplicate runs).

**Caveat / deferred.** The spec's full *Phase 0 publication acceptance* — prototyping the Windows
atomic replace/lock primitive, the child-process crash-injection harness, and the two-process writer
lease — is **tied to Phase 6 and deferred with it** (ADR-0001). It is not needed for the flat-file
alpha and would be dead scaffolding without the revisioned layout. Recorded in
`IDEA-CLIENT-PERSIST-001`.

---

## 4. Phase 1 — ProjectDocument shell and registry

**Commits:** `2525a46` (foundation), `62a6827` (close-while-opening), `089672c` (Shell wiring),
`302aa7c` (close-before-open barrier).

**Invariant established.** One authoritative owner per open project; the registry single-flights
`open(id)` and `close(id)` so concurrent consumers await the same promise.

**Design choices.**
- `ProjectDocument` **owns and constructs its children exactly once** from the open path (editor
  store, chat, tool host, `ProjectStoreAccess`). Compatibility `useEditor`/`useChat` adapters only
  *select/forward* to those children — they never call an independent `load`/`deactivate`/close. This
  is what prevents a second authoritative lifecycle from sneaking back in.
- **Switch = close + durable-save the old document *before* opening the next** (`302aa7c`), enforcing
  the alpha contract "exactly one project document loaded at a time." Alpha therefore never has two
  loaded documents.

**Issues found & fixed.**
- **Close-while-opening** (`62a6827`): a close arriving mid-open could orphan the open. The registry
  now makes a doomed open await the in-flight close (the open path observes the close and unwinds),
  so there is no orphaned half-open document.

**Justification.** Adding more optional guards to the old split lifecycle could not remove the root
cause (spec §2). The registry is the single open/close chokepoint that later phases build on.

---

## 5. Phase 2 — active-project UI and per-document binding

**Commit:** `25561dc`.

**Invariant.** A delayed project-A operation cannot change project-B UI or state.

**Delivered.** Removed the writable one-way *switchboard* state-mirror. The application store now
holds only the **active project id + project list**; every UI surface (menu bar, always-mounted
components, chat) resolves the **real child store from the registry** for the active document rather
than reading a mirrored copy. Chat uses its owning document's timeline/library, never a dynamic
"frontmost" global.

**Justification / caveat.** Tests here exercise **real document instances**, not mirror-only
`setState` fixtures (spec Phase 2 acceptance), because the whole bug class was the mirror drifting
from the instance.

---

## 6. Phase 3 — MutationGate and ProjectJobScope

**Commits:** `b494851` (3a MutationGate), `94fedec` (3b ProjectJobScope), `3b017be` (3c document
owns both, close drains both).

**Invariant.** No public manually-paired begin/end API; **no optional liveness callback on an
authoritative write**; close cannot report idle while a pre-close job is untracked; late results
fail both a session-identity check and a final admission check.

**Design.**
- **`MutationGate` (3a).** The *mandatory* mutation boundary. Callers submit a mutation; the gate
  admits or rejects it against the document's lifecycle phase. There is no `begin()`/`end()` pair a
  caller can forget to close — admission is the API. This is the structural fix for the earlier
  "optional `stillValid` param only the placement callers passed" gap.
- **`ProjectJobScope` (3b).** The tracked work board: background jobs register, receive abort
  signals, and report terminal status. Close waits on the scope so it cannot report idle while a
  pre-close job is still settling.
- **Ownership (3c).** `ProjectDocument` owns one gate + one job scope; `close()` drains **both** —
  reject new admissions, settle the admitted-and-in-flight work, then dispose.

**Justification.** This is the "one mandatory mutation boundary" the spec demands, replacing the
per-call-site guards that the pre-refactor rounds kept whack-a-mole-ing.

---

## 7. Phase 4 — filesystem containment (the security subset that was done)

Phase 4 as specified is a large epic (a full `ProjectPackageRepository` port + whole-project atomic
persistence). Per ADR-0001 the **repository/whole-project-atomic part is Phase 6 and deferred**. What
was implemented is the **owner-prioritized security/containment subset** plus the create/duplicate/
delete hygiene the alpha contract requires. Each slice states its invariant.

**7.1 Drop `import_media.source.path`** — client `cd7ec5c` + backend `9fa6e6d`.
- **Invariant.** The **agent can never import an arbitrary local file.** `import_media.source` is now
  `url | bytes` only. Local files are imported by the **human** (picker / drag-drop via `upload.ts`)
  which creates a linked library item; agent tools only ever see its stable media id.
- Backend removed the `source.path` property + path language; `CONTRACT_VERSION 1.0.0 → 1.1.0`; a
  mixed-version **drift-rejection test** was added (old 1.0.0 server flagged against a 1.1.0 client).
- **Caveat (owner action before push):** `npm run codegen` must be run with the server up to refresh
  the bundled `src/contract/tools.json`; the hand-bumped `params.snapshot.json` version is identical
  to what codegen produces (only the version differs, since the removed field was *nested*).

**7.2 Narrow read-only media resolver** — `217015a`.
- **Invariant.** An **agent-supplied** `media_ref` resolves only to registered library media or a
  contained project-relative path — never a bare absolute path or a `..` escape.
- **Load-bearing subtlety.** `toRef` leaves out-of-project absolutes unchanged, so an *external*
  (referenced-in-place) clip's `media_ref` legitimately **is** an absolute path. Therefore
  **clip-derived** resolution must keep using the trusting `resolveRef`; only the **agent-arg** path
  uses the new `resolveMediaRef`. `video_ask`/`inspect_media` branch on a `fromClip` flag so an
  external-clip inspect still works while a typed absolute `media_ref` is rejected.

**7.3 Agent never reads or writes absolute paths** — `2552b32` (owner directive: "absolute paths are
INTERNAL only").
- `isUnsafeAgentRef(ref)` (single source of the rule: bare-absolute OR `..`) gates ~11 agent-arg
  sites (`probe_media`, `run_ffmpeg` inputs, vision `image_path`/`artifact_id`, `find_content`,
  generation `reference_images`/frames, style refs, `add_clips`/`insert_clips`).
- **Workaround preserved.** Placement rejects an unsafe raw ref up front but still falls through to
  `?? raw` for a *non-absolute, unresolved* filename, because the placement test harness places bare
  filenames against a mock ffprobe. The invariant (no absolute placed) holds; the named residual (a
  bare relative unresolved ref reaches ffprobe cwd-relative) is pre-existing and not a
  system-absolute read.

**7.4 `ProjectStoreAccess.fs` made private + narrow typed methods** — `84d1e96`.
- **Invariant.** Raw fs access is internal to the store; feature/tool code goes through narrow typed
  methods (`remove`/`rename`/`readDir`/`downloadDir`/`readJson` + capability getters
  `canRename`/`canRescanLibrary`/`canWriteBytes`). TS now rejects external `store.fs`.
- ~20 call sites migrated (mediaProxy, library, pack, import, transcribe, project). **One documented
  hatch remains**: `fsForProjectRegistry()` for `ProjectRegistry` (which lives in `project.ts` and
  would create an import cycle if the store constructed it). Extracting `ProjectRegistry` to seal
  this is **deferred** (`IDEA-CLIENT-FS-001`) — it needs a runtime DI-ordering change a type-check
  can't validate, and the fs is already private with a single greppable hatch.

**7.5 LUT gap** — client `bef37b6` + backend `7c3ee85`.
- Discovered while rewording the contract: `color_grade.lut` was fed **raw to ffmpeg**
  (`lut3d=file=`), bypassing `resolveMediaRef` — an agent absolute-path channel. Fixed at two
  boundaries: the deepest (`resolveClipSources` resolves `clip.color.lut` via `resolveMediaRef`,
  unsafe → dropped) and the earliest (`applyColorTool` rejects an unsafe lut at set-time).

**7.6 Contract wording → refs** — backend `7891f9c`. Reworded ~13 media tool descriptions from
"local/absolute path" to "media_ref / clip_id" so the model-facing contract matches the runtime
rule. No `CONTRACT_VERSION` bump (descriptions only; param names unchanged) — owner `npm run codegen`
pending.

**7.7 Project delete → OS Recycle Bin** — `b2f47a5`. Added the `trash` crate + a `trash_path` Tauri
command; `trashProjectDir` now prefers the **OS Recycle Bin**, falls back to the app `.trash/`
rename, then hard-remove. The earlier `R12` safety (never silently hard-delete on a failed trash) is
preserved on both paths.

**7.8 Linked-local read-only** — `de2d173` (test-only). The invariant "deletion/GC never follows the
external path" already held (library delete/rescan skip external sources; the agent can't create an
external ref); this slice added the missing **adversarial test** for `delete_folder`'s external-skip.

**7.9 Derived-cache vs authoritative** — `572362e`. `duplicateProject` copied the whole project
including the regeneratable cache; `copyDir` gained a `skip` predicate so duplicate copies
**authoritative state only** and the cache rebuilds.

**7.10 Staged library commit** — `ebaa90e`. `registerLibraryClip` wrote owned bytes directly to the
content-addressed `media_<hash>.<ext>` path, so a crash left a partial file that `exists()` treats as
complete (re-import skips forever). Added `atomicWriteBytes` / `store.writeBytesAtomic` (temp
`.tmp-<rand>` **after** the ext so a rescan skips a leftover → atomic rename).

**7.11 Broad-suite regression sweep** — `c16a338`. A broad run after 7.2–7.4 surfaced 10 failures in
3 distant files (render seed used an absolute placement ref now rejected; a vision test asserted old
wording; a transcript mock lacked the new `readJson`). **Lesson (recorded):** run the broad suite
after a cross-cutting API/contract change, not just the targeted tests — a shared-API change breaks
distant mocks/seeds.

**Phase 4 caveat.** The big repository epic (move *all* authoritative reads/writes behind a
`ProjectPackageRepository`, whole-project atomic, staging APIs) is **not** done — it is Phase 6 /
`IDEA-CLIENT-PERSIST-001`. What ships is containment + create/duplicate/delete hygiene.

---

## 8. Phase 5 — in-memory state and shared commands (the core of the refactor)

Phase 5 makes the document's in-memory snapshot the authority while open, moves undo into the
document, and adds async autosave + an Unsaved indicator. It was done as fine sub-slices.

**5.1 — pure transition** (`8111992`). Extracted `applyTimelineTransition` (a pure
timeline→timeline function, no I/O) out of `applyOp`. This isolates the timeline math so the
in-memory session and the disk path can share one canonicalize/validate pipeline.

**5.2 — `TimelineSession`** (`99949de`). The in-memory owner of one document's timeline: holds the
current timeline, a revision counter, dirty/`markSaved` state, and the undo/redo stacks. It is
created lazily on the first edit.

**5.3 — gate serialization + in-memory authority + readers.**
- **(a) `0026bb8`** route timeline commits through the open document's gate (admission before apply).
- **(b) `4fe6c1e`** the gated commit path mutates the in-memory `TimelineSession` (authority), not
  disk.
- **(c) `07c00ee`** **readers observe the in-memory timeline when a project is open.** `loadTimeline`
  short-circuits to `doc.timeline` (cloned + canonicalized) when a session exists; it still reads
  disk for a bare store or before the first edit created the session. This is the prerequisite for
  autosave to lag disk without readers (export/inspect/preview/editor) going stale.

**5.4 — async coalesced autosave.**
- **(a) `50de211`** `AutosaveController` — coalesced async persistence, owned by the document.
- **(b) `90e5a93`** the gated edit applies to memory immediately and **schedules** a background save;
  `close()` flushes the pending save first (data-loss-before-close fix). "Save" means "make the
  current revision durable now."

**5.6 — Unsaved indicator (the bus was deliberately KEPT).**
- **(1) `f3af54a`** thread a `dirty?` flag through the existing timeline change bus; a gated edit
  emits `dirty=true`, a successful autosave emits `saved`/`dirty=false`, a failed one emits
  `save-failed`.
- **(2) `e38df53`** an amber **Unsaved** badge in the menu bar bound to `useEditor(s => s.dirty)`.
- **Design decision (important).** The spec lists "replace the global timeline bus with
  document-local subscriptions." I **did not rip out the bus.** It has one production consumer
  (`editor.ts`) and elegantly solves a real ordering problem: the editor loads *during*
  `children.open`, **before** the registry publishes the document, so at load time it has no document
  reference to subscribe to; the global dir-filtered bus sidesteps that. A naive swap regresses the
  timing; a proper swap = re-architect the editor as a document *view* (a big separate effort). The
  owner chose the salvageable value (the dirty flag through the existing bus). This is a conscious
  divergence from the literal deliverable, justified in-line and in the ADR.

**5.7 — origin fence (agent-execution scoping).**
- **(a) `e7d5247`** mechanism: `applyOp` carries a `MutationOrigin` (`{chatSessionId, branchId,
  executionId}`) to the gate.
- **(b-1 `62b0993`, b-2 `d0da090`)** wire it to the live chat execution and carry it end-to-end
  (chat exec → host → ctx → commit → gate) across the 22 agent edit sites via a single `ctxApplyOp`
  helper. **Manual editor edits pass no origin → are never fenced** (ambient fencing would wrongly
  taint a human edit); the fence is execution-based (no branch concept yet → `branchId` always 0).
- **(c) `0ed3871`** re-check the origin at the **final apply** (not just at gate preflight),
  threading the gate's `MutationContext` into the lazy-load path so a supersede *during* the
  first-edit disk-load lease is rejected. Contained: only `applyOp` (which carries an origin) threads
  the context; undo/redo/restore ignore it; the no-doc fallback gets none.

**5.5 — drop the module-global undo history (done LAST).**
- **Why last.** 5.5 removes the legacy `editorHistory` module-global undo `Map` and the no-document
  fallback commit path. My own notes flagged it *premature* until the timeline tests migrated onto
  documents, so it was sequenced after Phase 8.
- **(1) `40af4b6`** back the shared `seededCtx` test kit with an ephemeral `ProjectDocument` so the
  bulk of timeline tests exercise the document path.
- **(2a `b27a090`, 2b `7099b21`)** migrate `engine.test`/`ops.test` to the document path (register a
  doc in `beforeEach`; delete the 8 fallback close-abandon tests whose intent is now covered by the
  gate tests; rewrite 3 disk-read tests to seed disk directly).
- **(2c `e83a6b8`)** **production deletion**: `applyOpLocked`/`doUndoLocked`/`doRedoLocked`/
  `replaceTimeline` now **require an open document** (`if (!doc) return {ok:false}/false`); deleted
  the no-doc disk-RMW branches, the `editorHistory` Map, `getHistory`, `clearProjectHistory`, the
  `History` interface, and `HISTORY_CAP`. Net −116 lines.
- **Task 2 `9aa2ca7`** — **a final-save failure blocks close** instead of silently completing. The
  autosave save-closure self-retries a transient/thrown timeline write (bounded, while `sessionLive`)
  by re-scheduling onto the same autosave, so `close()`'s flush **blocks** until it lands; after the
  cap the timeline stays dirty and `close()` surfaces it via an injected `onCloseSaveFailed(pid)`
  callback wired to `captureError(..., {scope:"project.close"})`.
- **Task 3 `f0af469`** — **flush pending transcript persistence through the document close.** The
  coalesced transcript write was `sessionLive`-fenced but nothing flushed it on close; the close now
  retires the chat turn first, `await flushPendingSession(dir)` (land the last write while
  `sessionLive` is true), then disposes the editor.

**5.5 KEY DECISION — `sessionLive` was RETAINED (reviewer-endorsed).** The literal spec/Phase-8 goal
"remove module-global state" would also drop the coordinator's `sessionLive()` fence. I surfaced that
**`sessionLive` is not redundant**: it is the **async-write fence** complementary to the gate's
*admission* fence — the gate fences whether a mutation is *admitted*, but an already-admitted async
autosave / open-time seed / transcript write still races the close/reopen, and `sessionLive` (a
per-dir generation bumped by `endProjectSession ← closeProjectSession ← editor.dispose`) is the
store-level projection of the document close that guards those. It is also **document-reference-free**,
which the open-time seed needs (it runs before the document is published). Dropping it requires the
**document-owned open-seed re-plumb** (Phase 4/6 territory). The reviewer agreed verbatim: *"Declare
Phase 5.5 done and retain sessionLive… only afterward consider replacing it with an equivalent
document-owned guard."* So **Phase 5.5 = done** (editorHistory removed, sessionLive kept); the
replacement is a deferred future-Phase-4 item.

**5.5 workaround (MemFs).** `MemFs` has no rename, so a "close DURING the write" via a
`writeTextFile` override isn't caught by the pre-rename guard (the guard already passed). The tests
therefore simulate close via `endProjectSession` *before* the commit or a queued-behind-a-lock edit;
the temp→rename window is tested at the store level with a rename-capable fake fs whose guard flips
between temp-write and rename.

---

## 9. Phase 6 — revisioned persistence and recovery — **DEFERRED**

**Not implemented** (ADR-0001). This covers: the revisioned JSON package layout, three-verified-
revision crash/corruption recovery, hash verification + previous-revision fallback, the
`%LOCALAPPDATA%\ArtDaddy\Projects` canonical root with staged copy-on-first-open migration (never an
in-place move) + immutable metadata backup, staging/orphan cleanup, and the cross-process
single-writer lease.

**Why deferred.** It is the largest, highest-risk slice and needs a proven Windows atomic
replace/lock primitive + a crash-injection harness (Phase 0 publication acceptance) before it can be
trusted. Alpha keeps flat per-file atomic saves.

**Consequences the reviewer should hold us to.**
- **No code or comment may claim "atomic project save" / "transactional" / "single consistent
  revision" for the whole project** until Phase 6 (Phase 8 acceptance c; enforced by `651f544`).
- The accepted residual is a **torn multi-file project on a crash mid-save**. Individual files are
  atomic (temp+rename) and corrupt single files degrade-and-recover, but the project is not one
  transaction.
- External-file-change detection stays on flat files.

Tracked in `ArtDaddy/ideas.md → IDEA-CLIENT-PERSIST-001`.

---

## 10. Phase 7 — derived services, preview, and tool cleanup

**Commits:** `64b2c97` (A), `8fa38b5` (B), backend `3bf8e26` (ideas for the deferred pieces).

**Slice A — algorithm-version cache keys** (`64b2c97`). Added revision constants so a recipe change
invalidates the on-disk cache: `GEMINI_VIDEO_ENCODE_REV`, `GEMINI_AUDIO_REV`, `TRANSCODE_WAV_REV`,
`POSTER_REV` (proxy already had `PROXY_REV`). **Left unversioned with rationale:** the whisper
transcript is keyed by `canonicalRef|size` — size *is* the algorithm variable and re-transcribing is
a costly one-time cost.

**Slice B — cancel in-flight derived work on dispose** (`8fa38b5`). `IndexCoordinator` (an
editor-owned child, disposed on `doc.close`) previously only cleared its *queues* and stopped
*between* jobs — the in-flight ffmpeg/whisper ran to completion, so "dispose cancels active derived
work" was unmet. It now owns an `AbortController`; `dispose()` aborts it, threaded through
`processImportedMedia → transcode → runner.run("ffmpeg", …, signal)` and
`ensureTranscript → runWhisper`. `TauriCommandRunner` already kills the child on abort.
- **Residual (named, not overclaimed):** not routed through the central `ProjectJobScope` — the
  editor child owning the coordinator has no `doc.jobs` reference (the same lifecycle-ordering reason
  the bus/openDocuments needed DI); the acceptance *outcome* is met via the coordinator's own
  controller. A sub-second ffprobe isn't aborted; a transcode finishing just before abort may rename
  onto the old cache — harmless (the tombstone drops it if the project was deleted).
- **Poster bug fixed within the same commit.** Slice A bumped the poster *reader* to `.r1.jpg` but
  the *generator* still wrote `${key}.jpg` → posters would never resolve. Fixed with a shared
  `posterName()` helper used by both. **Lesson (recorded):** when versioning a cache *path*, version
  the generator and reader together via one shared name helper — a reader-only rev silently breaks
  resolution and isolated reader tests won't catch it.

**Deferred (documented, backend `3bf8e26`).** `IDEA-CLIENT-SVC-001` (tool handlers → narrow domain
service interfaces — internal wiring, contract unchanged) and `IDEA-CLIENT-RENDER-001` (a shared
canonical `buildRenderPlan` consumed by both the WebGL preview and the ffmpeg export, folding only
*verified* duplication). Both are dedup nice-to-haves, not Phase-7 acceptance blockers.

---

## 11. Phase 8 — remove legacy architecture

**Commits:** `f33504b`, `651f544`, `8dc43c5` (then the 5.5 legacy-removal completed the intent).

- **`f33504b`** — a **forbidden-dependency guard test** that statically enforces the architectural
  boundaries (e.g. no re-introduction of the removed lifecycle owners / import directions).
- **`651f544`** — swept comments/commit language to **stop overclaiming atomicity/persistence**
  beyond what the flat-file implementation guarantees (Phase 8 acceptance c). This is the honesty
  guard that keeps Phase 6's absence explicit.
- **`8dc43c5`** — arch-doc completion notes (Phases 0–5, 7, 8 implemented).
- The module-global undo history removal that Phase 8 also calls for was completed in **Phase 5.5
  (`e83a6b8`)**, sequenced last as explained above.

**Acceptance reached.** One open/close path (the registry), one mutation gate, one project identity
map; forbidden-dependency tests in place; no comment claims atomicity beyond the guarantee. The one
explicit exception is that a single package-repository is **not** unified (Phase 6 deferred), which
is called out rather than hidden.

---

## 12. Testing, coverage, and mutation (final push)

**Commits:** `8135492`, `2f2f746`, `368653f`, `e04035f`, `ef3ffa7`.

**Coverage gate MET.** `vitest.config.ts` thresholds are `statements/lines 95`, `functions 90`,
`branches 82`. Final: **95.02% lines/statements, 85.99% branches, 92.16% functions; 1668 tests / 125
files green.**
- New tests target the refactor's own new paths: the no-open-document commit guards, `AuthProvider`
  (was 0%), the per-project editor registry + activation, the tools registry (non-object args +
  throwing handler), `truncate` circular-ref, `http` Retry-After/abort, and upload-by-reference.
- **Config change:** excluded `src/tools/__e2e.ts` (a 220-line harness that is imported but never run
  as a suite, 0% → dragged global down ~1%; mirrors Stryker's `!src/tools/__e2e.ts`).
- Fixed **pre-existing** stale `src/lib` test mocks (`8135492`) that predated the Round 21/24 store
  API — surfaced only because the full-suite run was the first to exercise `src/lib`. Not
  refactor regressions.
- **Honest scope note.** The files still under 95% are pre-existing-low UI/store surfaces (MenuBar,
  TimelineEditor, StagePanel, SignInDialog, FileTree, ChatView) whose runtime is covered by
  parity/e2e per the documented coverage map. The refactor's own new code (engine / ProjectDocument /
  registry / gate / documentRegistry / transcriptFile) is well covered.

**Mutation testing (Stryker on `engine.ts`, report-only, never gates).** Three runs:
**76.91% → 74.83% → 75.06%.** Two genuine retry-*bound* assertion gaps were closed with **adversarial
(not mirror) assertions**:
- **Persist-retry (`e04035f`).** The Task-2 close-barrier retry `attempt < MAX_PERSIST_RETRIES` (=3)
  survived because no test pinned the attempt *count* — a `<=` off-by-one passed. Strengthened the
  persistent-final-save-failure test to count `timeline.json` writes and assert exactly **4** (initial
  + 3). Confirmed kill (survivors on that line 5 → 4).
- **Load-retry (`ef3ffa7`).** `loadTimeline`'s transient-read loop (`LOAD_RETRIES` = 4) had no test
  pinning its upper bound/exhaustion. Added "gives up after exactly `LOAD_RETRIES` reads then throws"
  (`reads === 4`). Confirmed kill.
- **Honest caveat on the score.** It dipped ~1.85 pts **not** from weaker tests but from a Stryker
  **timeout-reclassification artifact**: the two new tests' real backoff delays raised Stryker's
  dynamic per-mutant timeout ceiling, so ~10 retry-loop mutants flipped from *timeout-killed* (luck)
  to *survived*. Net effect: two fragile timeout-kills were replaced by deterministic
  assertion-kills. The remaining survivors are **equivalent/defensive** (null-guard `?:` fallbacks,
  backoff-*timing* arithmetic, seed/canonicalize guards, error-string literals) and are deliberately
  **not** mirror-tested.

---

## 13. Cross-cutting design principles applied throughout

These recurred across the refactor and explain many of the smaller choices:

1. **Prove you're still current before the side effect.** Every lifecycle-sensitive write proves
   liveness at the deepest boundary (inside the lock, right before the write), not at a pre-check a
   later `await` can invalidate.
2. **Enforce cross-cutting invariants at the shared boundary, mandatorily.** The close/liveness guard
   lives inside the shared commit primitive / the mutation gate — from required context (the store /
   the gate), never an optional per-caller param. (This directly fixed the earlier opt-in `stillValid`
   gap.)
3. **Capture tokens at submission, key by stable identity.** Generation/origin tokens are captured
   when work is *submitted*, and undo/session state is keyed by **`projectDir`** (stable), never an
   object identity — because the editor store and the agent tool-host store are *different instances*
   for the same project; the shared identity is the directory/file.
4. **Single source of truth for capability knowledge.** The backend `definitions.py` contract and the
   client `tools.json` twin are drift-guarded; a contract change bumps `CONTRACT_VERSION` and/or adds
   a conformance test.
5. **Adversarial tests, not mirror tests.** Tests challenge the failure direction (opposite ordering,
   concurrent path, lifecycle transition, out-of-catalog input), and we don't assert exact error
   prose / equivalent-mutant details.
6. **Name the residual, never overclaim.** Where a fix is partial (Phase 7 job-scope routing, the
   MemFs rename gap, the flat-file non-atomicity), the residual is stated in code comments and here,
   not hidden behind "fixed/atomic."

---

## 14. Caveats & assumptions (consolidated)

- **Alpha is Windows-only, local internal drives only, one project document at a time.** Cloud /
  network / removable / multi-doc are out of scope.
- **Flat per-file atomic saves only** (Phase 6 deferred) → **no whole-project atomicity claim**;
  torn-project-on-crash is an accepted residual.
- **The timeline change bus was kept** (not replaced with document-local subscriptions) — a
  deliberate divergence from the literal Phase 5 deliverable, justified by the editor-load-before-
  publish ordering; the salvageable value (dirty/Unsaved) was taken.
- **`sessionLive` retained** as the async-write fence (reviewer-endorsed); its replacement by a
  document-owned guard is deferred to the persistence phase.
- **Coverage floor is dominated by UI-heavy files** whose runtime lives in parity/e2e, not unit
  tests; the refactor's own logic is well covered.
- **`get_errors` does not analyze the client from the backend workspace**; client changes are
  validated by `npx tsc --noEmit` in `artdaddy` (a guarded command) or the client's own language
  server, not the backend's.
- **PowerShell exit codes and the offline `[contract] failed to load the tool catalog` log are
  noise** in test runs (stderr writes; tests run offline against a bundled snapshot). Check "Tests N
  passed," not the exit code.
- **`npx stryker`/`npx vitest` must run with cwd = `artdaddy`** (an async-terminal invocation
  once stripped a `cd` prefix → npx hit the registry for `stryker` → SSL failure).

---

## 15. Deferred items (with pointers)

| Item | Status | Tracked as |
|---|---|---|
| **Phase 6** — revisioned/whole-project-atomic persistence, 3-revision recovery, `%LOCALAPPDATA%\ArtDaddy\Projects` relocation + copy-on-first-open, cross-process writer lock | Deferred (ADR-0001) | `IDEA-CLIENT-PERSIST-001` |
| Replace `sessionLive` with a document-owned open-seed guard | Deferred (reviewer-endorsed, with Phase 4/6) | notes in `engine.ts` / ADR |
| Extract `ProjectRegistry` to seal the last `fsForProjectRegistry()` hatch | Deferred | `IDEA-CLIENT-FS-001` |
| Full `ProjectPackageRepository` port (all authoritative reads/writes behind one port, staging APIs) | Deferred (= Phase 6) | `IDEA-CLIENT-PERSIST-001` |
| Tool handlers → narrow domain-service interfaces | Deferred (Phase 7 dedup) | `IDEA-CLIENT-SVC-001` |
| Shared `buildRenderPlan` for preview + export | Deferred (Phase 7 dedup) | `IDEA-CLIENT-RENDER-001` |
| Preview↔export fidelity gaps (blur/glow/color/audio-pitch) | Documented pre-beta | `IDEA-PARITY-001` |
| Server-side vendor-call cancel on Stop | Documented | `IDEA-CANCEL-001` |
| Durable/idempotent billing debit + single user+global txn | Documented | `IDEA-BILLING-001` |
| Request-validation tightening (`extra="forbid"`, dim ceiling, model allowlist) | Documented | `IDEA-VALIDATION-001` |
| Desktop webview e2e (tauri-driver + WebdriverIO), CI matrix, lint jobs | Documented | `IDEA-CI-001` |
| Conversation compaction / context-window budgeting | Documented | `IDEA-CONTEXT-001` |

> Note: `ArtDaddy/ideas.md` is the shared idea file for both repos and has pre-existing uncommitted
> content; the `IDEA-*` entries above that were added by this work are committed where noted
> (e.g. Phase 7 `3bf8e26`), others are working-tree-only by intent.

---

## 16. Validation status & owner actions before push

**Validated.**
- `1668` tests pass (`125` files); coverage `95.02%` lines/statements, `85.99%` branches, `92.16%`
  functions.
- `get_errors` clean on the changed client files (the client is a workspace root here, so its
  language server analyses them).
- Stryker on `engine.ts` completed (report-only).

**Pending owner actions before any push (I did not do these — they are guarded / need a running
server):**
1. `npm run codegen` in `artdaddy` **with the backend server up** — refreshes the bundled
   `src/contract/tools.json` for the Phase-4 contract wording/version changes (produces the identical
   hand-bumped `params.snapshot.json`; only the version differs).
2. A full `npx tsc --noEmit` in `artdaddy`.
3. The committed `.githooks/pre-push` runs `npm run build && npm test` (client) and `pytest`
   (backend) and blocks the push on failure.

**Nothing in this refactor has been pushed.** All commits are local, one architectural movement each.
