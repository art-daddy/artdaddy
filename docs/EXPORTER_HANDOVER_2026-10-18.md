# Exporter Work Handover

Updated: 2026-10-18. Internal engineering handover, not release notes or a claim
that the exporter is finished. This document covers both the active rescoped
FFmpeg exporter and the original, now-deferred new-renderer effort.

Original handover facts in sections 1-15 were captured before this document's
first documentation-only commit. The continuation checkpoint below supersedes
their execution state, not the design, approval boundaries or deferred work.
Recheck current heads when resuming; documentation history is not a new exporter
build or qualification result.

## Continuation Checkpoint - 2026-10-18

**Strict acceptance remains 11/24 (46%). Built but unaccepted remains 10/13.**
No acceptance box was closed by the following short software/control runs.

### Completed Software And Local Gates

- Recovered the original "Code review for akaru project (RECOVERED 8)" transcript
  and confirmed the existing QA-branch/public-CI permission. Main pushes, releases,
  paid work, personal-media uploads and the deferred full-size/device runs remain
  outside that permission.
- Commit `53bfd6ee2fe83a949016d7cec8e84a9f37257330` repairs the caption cleanup
  smoke fixture at its actual owner. Legacy project-cache cleanup is still
  exercised. Actual caption staging additionally proves current-launch app-work
  retention, previous-launch orphan removal and ordinary staging cleanup.
  Production ownership was not moved back into the project to satisfy the test.
- Four real-filesystem cleanup cases and 35 existing ownership/safety cases pass.
  The subsequent QA-only push passed the unchanged hook: client build, 5,697 unit
  tests, ten Node exporter controls, 211 Rust tests (20 ignored separately),
  606 real-FFmpeg smoke passes (234 skips) and the backend bundle guard.
  The backend guard inspects its configured sibling main-client contract; it
  does not independently compare every isolated-QA contract byte.
- Current-source Windows evidence at `53bfd6e` includes 17 explicitly enabled
  real native worker/lifecycle cases, the eight-branch output matrix and actual
  native-app crash/recovery. Independent receipt inspection checked protocol 20,
  one recovery, 744 source-file hashes, actual worker/app/publication identities,
  complete decoded video/audio and four caption-pixel observations.
  This receipt predates the following memory-reader change; do not reuse it as
  current-source proof for that candidate.

### Exact-Source Remote Results - Failures Retained

- Native CI run `39105650057`, source `53bfd6e`: Linux passes all 18 portable
  artifact cases and real native-app recovery. Both Unix platforms pass the
  17 real worker/write-limit/lifecycle cases and eight-branch output matrix.
  Unguarded FFmpeg writes 265,663 bytes against a 65,536-byte request; Unix
  enforcement stops at 65,536 bytes, while the Windows guarded control writes
  48 bytes. Fitting movies are 671,963 bytes and decode all 90 moving frames.
  These are file-write observations, not complete allocated-space proof.
- That native run fails macOS with 16/18 portable cases passing. One native
  audio/denoise export loses a live-worker memory measurement despite a recorded
  peak around 89 MB. The other case fails the Standard/reference encode with
  swscaler "Resource temporarily unavailable" and libx264 initialization errors.
  Real macOS app recovery is consequently not executed. Neither failure is
  discarded or treated as resolved by a retry.
- Standard CI run `39105649969`, same source: build/unit, full Windows desktop
  build and Windows/macOS browser-pixel jobs pass. Full smoke fails on macOS
  (42 failed, 557 passed, 241 skipped), Linux (120 failed, 479 passed, 241 skipped)
  and Windows (four failed, 598 passed, 238 skipped).
- Both standard Unix Cargo jobs attempt the intentionally non-executable
  stand-in FFmpeg in the new real output-guard regression and fail with
  permission denied. Linux export smoke additionally lacks the native GTK
  development prerequisites required by the actual Rust sequence fixture:
  its repeated failures contain missing `gdk-3.0`/pkg-config diagnostics.
  Fix staging/compilation at the owning CI jobs, not by skipping real cases.
- Remaining artifact failures must still be diagnosed: macOS complete-stereo
  equality, Windows vibrance frame equality, resolution/cold-native-build
  timeouts and a Windows loudness timeout. Cold compilation is a confirmed
  fixture prerequisite, not yet proof of the cause of every timeout. Do not
  raise deadlines, normalize differences or update golden output to get green.

### Qualified Native Slice And Current Candidate

- QA commit `298f254` changes the
  mandatory native RSS sampler on macOS to a checked `PROC_PIDTASKINFO` query.
  Only a complete kernel structure is accepted; missing live-worker data stays
  an explicit failure, not a zero-memory observation or a metadata fallback.
  Other platforms retain their existing sampling. Limits and encoder/thread
  policies are unchanged.
- The same candidate requires three complete 18-case macOS portable executions;
  any execution or verification failure fails the job. Artifacts include the
  workflow attempt identity so reruns cannot collide with retained evidence.
  Windows memory controls pass three cases (one ignored separately), all 17
  explicit native lifecycle cases pass, and YAML/Bash/failure-aggregation controls
  pass. Native CI `39108805827` now also passes on macOS and Linux: all 17 real
  runtime cases, the eight-branch output matrix, actual app crash/recovery,
  Linux's 18 portable cases and all three distinct 18-case macOS executions.
  macOS actually executes positive/negative kernel-reader controls and the
  real owned-worker cutoff. Each platform's 744 source hashes matches the exact
  Git blobs. Downloaded artifacts contain logs/receipts, not media or executable
  bytes; their actual byte checks run inside the source-bound native harness.
  The earlier scaler failure did not recur, but its independent cause is not
  proven and is not declared closed.
- The unchanged QA push hook passed at both `298f254` and the last published
  candidate `ea12d7fd61a5e5b9e1c0fd2b8fcab6eef71478ec`: build, 5,697 unit cases,
  ten Node controls, 211 Rust cases (20 ignored), 606 real-FFmpeg smoke passes
  (234 skips) and the backend bundle guard. The latest smoke took 1,248.18 s.
- Standard CI `39108805696` at `298f254` still fails: macOS 40 failed/559
  passed/241 skipped, Linux 120/479/241, Windows 3/599/238. Both Unix Cargo
  jobs retain the stand-in FFmpeg failure. It also finds a real shared-name
  counterexample, `" .0."`, seed `-32425172`; trimming exposes a leading dot.
- `ea12d7f` stages real pinned FFmpeg in Unix Cargo jobs, installs the required
  Linux native packages and compiles the actual Rust smoke fixture before
  per-case deadlines. It always retains the full smoke JSON and bounded first
  failed transition/colour media, complete frame/PCM hashes and failed render
  plans. Assertions, references, deadlines, budgets and production threading
  are unchanged. Actual helper controls verify the saved bytes, ownership and
  size refusals; workflow preparation is not remote execution.
- Exact-source standard CI `39111883014` at `ea12d7f` proves the prerequisite
  repair: both Unix Cargo jobs pass, Linux full smoke passes 599 cases with
  241 skips, and Windows passes 602 with 238 skips. Both browser jobs, unit/build
  and the Windows desktop build pass. macOS still fails 44/555/241: seven
  resident-accounting failures and 37 other conformance failures.
- Native CI `39111883008` passes Linux's actual app recovery, all native controls
  and 18 portable cases. macOS passes its native controls and all three 18-case
  executions but the actual file-sequence app export fails with kernel `ESRCH`
  at about 300 MB resident memory. This reopens the worker-exit classification;
  do not cite the earlier green run as complete sampler-lifecycle qualification.
  The private partial is cleaned and publication refused, not delivered as success.
- Public XNU source explains the relevant distinction: task lookup excludes
  zombies; BSD-info argument 1 can confirm `SZOMB` before synchronizing with
  the same owned SharedChild. A QA candidate adds this classification, real
  zombie/live/concurrent-writer tests and three required macOS app executions.
  Windows still passes three memory controls (one ignored separately).
  Actual macOS compilation/execution of this new candidate remains pending;
  live or unconfirmed missing memory stays an error, never a zero fallback.
- Actual retained macOS crossfade/exposure media have identical complete
  196-frame hashes and equal audio lengths. Their 456 differing PCM samples
  differ by one 16-bit step, with the same expected/actual PCM hashes in both
  classes. Keep the original media and strict assertions while investigating
  integer-quantization versus the existing float64 transport oracle.
- Main now has the qualified native output guard/shared Control wiring,
  checked macOS reader and existing output/restart outcome regressions.
  Main remains 0.21.2. The three native modules match qualified Git source
  after explicit CRLF normalization, with only one additional EOF newline.
  Focused combined-main `cargo --locked` refused before compilation because
  the pre-existing dirty root lock adds `reqwest`/`rustls` absent from the
  manifest. Preserve those unrelated edits: combined-main execution is blocked,
  not passed. Other qualified exporter slices still require surgical backport.
- QA local commit `400457d` fixes the shared dot/whitespace boundary invariant,
  including project-name fallback and post-truncation Unicode boundaries.
  Its exact CI witness, properties, returned default destination, invalid-folder
  refusal and existing media/clip regressions pass 81 cases; formatting passes.
  The same bounded naming slice is in main; complete component-byte/device-name
  qualification remains explicitly separate. See architecture decision D080.
- Next: qualify the owned-worker exit candidate on actual macOS, resolve the
  remaining audio-comparison precision evidence without weakening assertions,
  and continue qualified exporter-owned integration without wholesale merges.
- Larger residuals remain: complete allocated temporary-space/20 GB coverage,
  Linux 8 GB and other complete software-profile evidence, combined-main gates,
  complete UI/agent/MCP/copy/lifecycle/filesystem coverage, visual/audio/preview
  parity and estimate/reporting qualification. Owner-deferred full-size/stress,
  physical devices, pilot, release and deployment remain separate.

Continuation evidence is under the isolated QA worktree's `reports/qa/exporter`:
`continuation-cleanup-before.json`, `continuation-cleanup-after.json`,
`continuation-cleanup-owners.json`, `continuation-windows-receipt-inspection-53bfd6e.json`,
`ci-39105650057`, `continuation-standard-ci-39105649969-failed.log`,
`continuation-memory-reader-controls.log`,
`continuation-native-workflow-controls.json`,
`continuation-native-receipt-inspection-298f254.json`,
`continuation-macos-memory-reader-proof-298f254.json`,
`continuation-conformance-diagnostic-controls.json`,
`continuation-standard-ci-prerequisite-controls.json` and
`continuation-qa-push-ea12d7f-1792310798097.json`,
`ci-39111883008`, `ci-39111883014`,
`continuation-standard-smoke-ea12d7f-summary.json`,
`continuation-macos-comparison-inspection-ea12d7f.json` and
`continuation-export-name-boundaries.json`. Main's own reports include
`continuation-native-backport-equivalence-298f254.json` and
`continuation-main-native-integration-1792312282490.json`.
Preserve failed evidence and exact
source identities. Native/profile success is still not physical-device,
full-duration, whole-space or 99% promise qualification.

## 1. Start Here

The owner asked to finish implementation of the approved rescoped design without
routine approval pauses, recording assumptions and decisions for later review.
This original handover was requested because the previous chat was too long.
Do not resume the old new-renderer plan by mistake.

At handover the next action was the failing cleanup smoke test, not another
renderer project. Use the continuation checkpoint for the current next action;
the following table preserves the original handover state.

| Item | State At Handover |
| --- | --- |
| Active product scope | Reliable background MP4 export using existing FFmpeg rendering |
| Strict V2 acceptance | 11 of 24 checks, rounded to 46% |
| Historical V1 tracker | 13 of 30, rounded to 43%; retained history, not the active denominator |
| Built but not accepted | 10 of the 13 open V2 boxes, per the maintained tracker |
| Main implementation baseline, before handover-only commit | `540dd3e00cef9f91649dc3eb357f7ce7d6602753` |
| Latest isolated QA HEAD | `a75812697554a17d8736aa4c913f328aea8944f0` |
| Last successfully pushed QA revision | `2bc972116aa3ef827087077ee4f567c1e1fadef0` |
| Latest push attempt | Failed locally in pre-push smoke; exit 1; later commits are not published |
| Immediate failure | Caption-folder cleanup test expected a stale folder to be removed; got an empty result |
| Current native export protocol | 20 |
| Current remote qualification | Earlier Mac/Linux CI failed; the latest fixes have not reached a new run |
| Main integration | Later QA-only changes still need a scoped backport/integration |
| Release/deployment | Not performed for this exporter work; not authorized by QA push consent |
| Full-size, stretch, physical devices | Deferred by the owner until software changes are finished |

These percentages measure accepted checks, not coding hours or a measured success
rate. Do not add accepted and built/proof-pending counts and advertise an 88%
completion figure. New local tests do not automatically close acceptance boxes.

The last communicated planning estimate was 2-4 focused working days for software
closure, explicitly not a commitment. It excludes waiting for owner-provided
devices and deferred full-size qualification. Re-estimate after the cleanup failure
and current-source CI are resolved; do not present that estimate as a release date.

## 2. Authority And Reading Order

1. The active V2 section, tracker and decision ledger in
   [EXPORTER_ARCHITECTURE.md](EXPORTER_ARCHITECTURE.md) are the design authority.
   Its historical V1 section is not authority for conflicting V2 requirements.
2. Read [PROJECT_DOCUMENT_ARCHITECTURE.md](PROJECT_DOCUMENT_ARCHITECTURE.md)
   before changing job, lifecycle, mutation, persistence or project-filesystem
   ownership. Keep the existing owners; Phase 6 is deferred.
3. Read [MANUAL_EDITING_PARITY.md](MANUAL_EDITING_PARITY.md) before changing
   editor/agent parity, preview geometry or shared edit semantics.
4. Read this handover for execution state, evidence, parked work and next steps.
5. Read the current repository instructions and
   [DEVELOPMENT.md](DEVELOPMENT.md) before tests, packaging or release work.
6. Inspect current Git state before editing. Saved reports describe their captured
   source revisions, not whatever happens to be in the main working directory.

No secret values belong in this handover. Private source maps and personal test
media stay local. Do not publish this operational document or ignored evidence
wholesale as public release material.

## 3. Workspaces And Preservation Rules

Known workspace locations:

```text
C:/Users/akshaydagar/akaru-client
C:/Users/akshaydagar/Akaru
C:/Users/akshaydagar/akaru-landing
C:/Users/akshaydagar/qa-exporter-v2-20261017
```

The first is the main client worktree. It has substantial pre-existing modified,
staged/untracked and unrelated auth, catalog, preview and updater work. At the
verified snapshot it is ahead 34 and behind 10 relative to its remote. Do not
push it, reset it, merge the entire QA history into it or copy its whole working
tree to another branch.

The isolated QA worktree is on `qa/exporter-v2-20261017`. It shares dependencies
through a local node_modules junction but has its own native target directory.
Its package/native manifests are 0.21.4 as a QA-baseline property, not an instruction
to set main or the next release to that version.

The other workspace HEADs checked for this handover are:

| Repository | Verified HEAD | Relevant Local Work |
| --- | --- | --- |
| Backend | `5ff64a6671b8f3e92198b17675970edd7028cef6` | Separate anonymous render/copy outcomes; earlier reporting changes also need deployment review |
| Landing | `ff1b035fd5e8e9b31899d78a9313055b30f9fe1f` | Anonymous-outcome privacy disclosure; deployment was not performed by this exporter work |

These HEADs are not evidence of deployment or a clean worktree. Preserve unrelated
changes in all repositories and verify current state again when resuming.

The following dirty QA entries were deliberately left outside commits:

- A generated parity reference image.
- Native manifest line-ending/stat changes.
- Preview scene/transition snapshots and render/corpus snapshots showing modified
  status, previously associated with checkout line endings or generated output.

Do not stage, regenerate, reset or discard these merely to make Git status clean.
Verify bytes and ownership when a relevant file changes. Do not overwrite user work.

There is a separate updater-hotfix worktree. It is not exporter work and must not
be edited, merged or reset as part of this continuation. The 18 unshared browser
pages are also out of scope. No subagents were authorized.

## 4. Active V2 Product Contract

The owner's controlling request was an exporter behaving like a mature editor:
background execution, no bad or half final file, recovery after an app crash, and
large projects that do not fail. The owner explicitly did not ask for a new engine.

### 4.1 Independent Promise Lines

| Line | Standard 16 GB Laptop | Minimum 8 GB Laptop |
| --- | --- | --- |
| Ordinary HD/social/YouTube work | Correct complete output; normal HD up to 2 times output duration | Same correctness promise; no speed guarantee; honest estimate |
| Long HD | Up to 2 hours and about 1,000 clips; up to 2 times output duration | Same project-size correctness promise; no speed guarantee |
| 4K | Up to 30 minutes and four simultaneous visual things; up to 4 times output duration | Same correctness promise; no guessed speed guarantee |
| Heavy 1080p | Up to eight simultaneous visual things; up to 4 times output duration | Same correctness promise; no speed guarantee |
| Frame rate | Assume 30 fps; HD60 should work; measure and publish 4K60 limits | Same declared correctness coverage |
| Extra export disk | At most 20 GB, cleaned after settlement | Same 20 GB requirement |
| Platforms | Windows, macOS and Linux independently | Physical minimum-device proof still required |

Each limit stands alone. Do not silently promise a combination of every maximum.
Out-of-promise combinations get a warning and an honest estimate, not an invented
success or speed guarantee. A short pilot is not a full-duration promise case.

### 4.2 Required User Workflow

- Default to Full quality. Preserve the existing MP4 workflow and continuous audio.
- Estimate RAM, temporary/final disk and time before every export request.
- Show a full warning for outside-promise, non-fitting or unknown conditions.
- For an otherwise fitting in-promise request estimated over twice output duration,
  show the lighter estimate notice. The 4 times target still applies to 4K/heavy.
- Offer continuation and practical alternatives such as lower resolution or a
  smaller range. Unknown must say unknown, not zero or a fabricated estimate.
- User continuation never bypasses validation, source identity or hard native guards.
- Report queue/preparation time separately from measured encoding/saving time.
- Keep safe staging/publication, cancellation, recovery and cleanup across all entry
  points, including ordinary exports, clip/range exports, copies and batches.

### 4.3 Anonymous Reporting

Collect only allow-listed outcome/reason, coarse workload size band and elapsed
time. No names, paths, filenames, project/account IDs, content or raw diagnostics.
Distinguish render, copy and unknown operations so successful copies cannot inflate
the render success rate. Preserve early refusals, unknown readiness and failed runs.

The desktop installer privacy policy and landing-site privacy policy both need to
agree with enabled collection. Client, backend and landing reporting/privacy work
exists locally, but do not assume every required change has been deployed.

### 4.4 Not Authorized By V2

- A new native GPU compositor, MLT integration or persistent-decoder renderer.
- New output formats or Premiere/DaVinci hand-off.
- Raising the established resource limits to obtain a green test.
- Unmeasured Fast modes on arbitrary hardware or silent fallback from Fast.
- Calling pilots, simulated profiles or a green unit suite physical qualification.
- Publishing releases, pushing main, paid calls or uploading personal test sources.

The owner later delegated ordinary in-scope decisions and comparison-adapter
repairs for later review. Record those decisions; do not stop for routine approvals.
The exception for the existing QA branch and standard CI does not authorize release.

## 5. Architecture That Must Be Preserved

| Concern | Existing Authority |
| --- | --- |
| Project lifecycle and project writes | ProjectDocument and MutationGate |
| Captured export admission | Shared export submission/queue boundary |
| Durable intents, execution and recovery | Existing Rust jobs Supervisor |
| Source/stage/destination identity and leases | Native delivery owner |
| Temporary payload and retained-stage capacity | Existing pooled Workspace |
| Timeline/range/filter computation | Existing FFmpeg compiler and shared render plan |
| Preview | Separate existing scene/compositor implementation |
| Project persistence | Current flat per-file atomic layout; not Phase-6 revisioned persistence |

Small jobs can use one FFmpeg command. Larger/heavier jobs use bounded lossless
video pieces through native NUT pipes, one continuous audio graph and one final
MP4 encode. File-piece support remains where needed. Avoid materializing a full
lossless movie on disk. This native supervision and transport code is part of V2;
do not remove it because the separate new rendering engine was parked.

Accepted jobs capture immutable workload, commands, dependencies, destination,
request/snapshot fingerprints and encoder identity. Recovery uses that captured
identity, not the newest UI settings. Refuse unsupported protocol combinations.

Timeline positions are project frames; raw source spans are seconds. Keep the
existing conversion helpers and never invent manual frame-rate math in tool APIs.
Tools resolve library references rather than accepting arbitrary local media paths.

## 6. What Has Been Implemented

### 6.1 Admission, Queue And User Consent

- Shared submission paths for normal, range/clip, copy and batch export requests.
- One request/batch consent before output-folder creation, reservations, ledger
  writes or native preparation effects.
- Post-await checks for project session, origin, cancellation and mutation lease.
- Retirement of unstarted intents when native preparation ignores cancellation.
- Earlier accepted batch jobs remain identifiable if a later submission refuses.
- Explicit Full-quality request defaults; a hidden dialog selection cannot change
  agent/MCP export defaults.
- Native resource snapshots plus bounded local successful-export calibration.
- Honest unknown estimates, resource warnings and captured encoder-specific history.

### 6.2 Rendering And Quality Policy

- Automatic routing between existing Standard and bounded FFmpeg transport paths.
- Continuous audio across video partitions, with exact sample/frame regressions.
- Supported visual/effect/caption/transition/animation/delivery conformance tests
  read actual artifacts, not merely generated filter strings.
- Above-HD composed streamed Full-quality output uses the approved two final x264
  threads. Other policy defaults are not globally changed.
- Fast is a local-debug Windows AMD 780M candidate only, using a runtime supported-
  dimension AMF probe and measured AMF CQP18 profile. It is not universal hardware
  acceleration. Larger files and possible picture differences were acknowledged.
- Failed Fast availability does not silently export with a different encoder.

Encoder calibration identities distinguish `x264-crf`, `x264-crf-threads2` and
`amf-cqp18`. Do not mix observations from those modes.

### 6.3 Durable Native Delivery

- Persistent prepared/render/copy intents and bounded restart/recovery attempts.
- Source identities, executable identity, command fingerprints and staged receipts.
- Source/stage/physical-alias leases and volume-aware publication.
- Producer completion is distinct from a process exit and a file merely existing.
- Verified publication precedes registration/follow-up acknowledgement.
- Sticky cancellation, owned-child settlement and refusal to publish capped output.
- Copy and final-MP4 stages share pooled capacity; retained bytes are charged after
  restart before admitting new work.
- Capacity waits are outside project mutation/publication locks.
- Exclusive writer claims are not confused with retained byte charges.

### 6.4 Source Audio Clock Repair

An original screen recording had Opus audio starting 44 ms after video. Resetting
timestamps first erased that gap and advanced sound by 2,112 stereo sample frames.
The shared audio compiler now normalizes source timing before its clip-relative
reset, trimming, looping, effects and mixing:

```text
aresample=48000:async=1:first_pts=0
```

The pre-fix delayed-source check failed with 93,888 rather than 96,000 stereo
sample frames. The corrected check preserves both the leading gap and full span.
Original screen and phone sibling outputs were checked, not replaced with generated
media. Failed artifacts and pinned original source hashes were retained.

### 6.5 Chromakey Repair

The retained compressed source produced a few different chromakey edge samples
under different FFmpeg graph thread counts. Only the authored chromakey filter is
limited to `threads=1`; graph-wide threading is unchanged. Actual partition frame
and floating-audio comparisons pass. The two affected graph-comparison adapters
augment frozen expected strings without normalizing actual output or rewriting
the original snapshot bytes.

### 6.6 Output-Length Guard, Not Yet A Physical-Disk Guarantee

The existing FinalOutput/worker-group owner now installs an OS guard before spawn:

- Windows: a held exclusive byte-range lock beyond the admitted file limit.
- Unix: child `RLIMIT_FSIZE`, retaining any stricter inherited limit.
- Worker-group ownership configures the guard; individual spawn callers cannot
  opt out. Failed terminal producers clean private partials and retain structured
  limit/observed-byte diagnostics without hiding the original failure.

Real Windows probe: `-fs 65536` alone produced 265,663 bytes; with the guard it
stopped at 48 bytes. A fitting guarded output decoded all 90 frames. The eight-
branch live/recovered, single/streamed, fitting/capped matrix passed locally.

This does NOT prove the complete 20 GB allocated-space requirement. Open issues
include filesystem allocation/metadata, all temporary categories, cleanup failures,
Windows parent-crash lock-release versus child-kill ordering, and actual Unix proof.
Do not claim an exact physical disk ceiling from a payload or file-length bound.

### 6.7 Software Profile Inputs

- Existing Windows whole-tree kernel-commit receipts remain supported.
- Unix measured-host evidence must bind run ID/platform to both Node and native
  total-memory observations; both must be valid and within the requested bound.
- Unknown, over-bound, mismatched and malformed measurements remain unqualified.
- A self-reported profile label or enforcement flag is insufficient.
- Physical and promise qualification remain separate and false by default.
- On this approximately 64 GB host, the measured-host 8/16 GB flags correctly stay
  false. This validates refusal, not minimum-device performance.

Actual current-source Mac/Linux profile evidence is still pending. A roughly
15.6 GiB Linux VM cannot establish an 8 GiB profile without additional real evidence.

### 6.8 Code Ownership Map

These links refer to the main workspace. The QA versions of several files are
newer; compare revisions before copying or interpreting a link as tested source.

| Area | Primary Surface |
| --- | --- |
| Compile/render/range execution | [../src/timeline/render.ts](../src/timeline/render.ts) |
| Shared layout/visibility/workload rules | [../src/timeline/renderPlan.ts](../src/timeline/renderPlan.ts) |
| Captured backend and encoder options | [../src/timeline/exportOptions.ts](../src/timeline/exportOptions.ts) |
| Admission, preflight, queue, adoption and follow-ups | [../src/timeline/exportQueue.ts](../src/timeline/exportQueue.ts) |
| Render/copy item routing | [../src/timeline/exportItems.ts](../src/timeline/exportItems.ts) |
| Local job display/history/calibration | [../src/store/exportJob.ts](../src/store/exportJob.ts) |
| Confirmation behavior | [../src/lib/confirm.ts](../src/lib/confirm.ts) |
| Native bridge/protocol/runner ownership | [../src/tools/jobSupervisor.ts](../src/tools/jobSupervisor.ts), [../src/tools/command.ts](../src/tools/command.ts), [../src/tools/tauri.ts](../src/tools/tauri.ts) |
| Caption/font/graph scratch | [../src/tools/assScratch.ts](../src/tools/assScratch.ts) |
| Native durable intents and delivery | [../src-tauri/src/jobs.rs](../src-tauri/src/jobs.rs) |
| Streamed worker group | [../src-tauri/src/jobs/stream.rs](../src-tauri/src/jobs/stream.rs) |
| Pooled payload, retained charges and entry bounds | [../src-tauri/src/jobs/workspace.rs](../src-tauri/src/jobs/workspace.rs) |
| Platform memory enforcement | [../src-tauri/src/jobs/budget.rs](../src-tauri/src/jobs/budget.rs) |
| Preview geometry/pixels | [../src/preview/scene.ts](../src/preview/scene.ts), [../src/preview/renderer.ts](../src/preview/renderer.ts) |
| Current cleanup failure owner | [../src/tools/projectTemps.ts](../src/tools/projectTemps.ts) |

The new `jobs::stream::output` module is currently QA-only. Its platform output
guard must be included in the later scoped main integration, along with its
worker-group wiring and tests. Copying the module alone is not the change.

## 7. Current Resource Limits

| Limit | Meaning |
| --- | --- |
| 4 GiB | Windows aggregate worker commit budget, enforced by Job Object |
| 3.5 GiB | Sampled aggregate owned-worker resident cutoff |
| 18 GB | Pooled temporary payload allowance |
| 2 GB | Reserved headroom toward the 20 GB export-space goal, not allocated-space proof |
| 16,384 entries | Existing workspace entry limit |
| 8 hours | Existing active execution deadline |
| 12 minutes | Disposable native QA outcome wait, not a product render promise |
| 6 GiB | Existing Windows whole-process-tree QA pressure cap used in short pilots |

Do not conflate Windows kernel commit, sampled RSS, total host RAM and physical
laptop qualification. Unix sampled RSS is not a Windows-style aggregate commit cap.
The local Ryzen 7840U/Radeon 780M host has about 64 GB RAM, not 8 or 16 GB.

## 8. Exact Resume Point

Latest failed pre-push attempt, for QA revision `a758126`:

| Gate | Result |
| --- | --- |
| Client build/typecheck | Passed |
| Unit tests | 5,697 passed |
| Node reporter/source controls | Passed |
| Rust suite | 211 passed; 20 ignored reported separately |
| Smoke | 604 passed; 1 failed; 234 skipped |
| Backend contract gate | Not reached in this attempt |
| Push | Refused by the unchanged hook; no new remote revision |

Failure:

```text
src/tools/projectTemps.smoke.e2e.ts
a caption folder left behind is judged by the folder's own time, and goes whole
expected: the stale renderer/caps folder
actual: []
```

The fixture calls `quietFor(folder, TEMP_STALE_MS + 1000)` and fails around its
cleanup-result assertion. Do not assume the cause has been established. A useful
first hypothesis is a mismatch between the fixture's legacy caption-folder
location and the restored scratch helper's app-work ownership, or a timestamp
eligibility issue. Read the actual cleanup owner and fixture before choosing.

Read-only findings from preparing this handover sharpen that lead:

- The failing fixture actually calls `withAssScratch` with the real Node runner
  and never resolves its callback, simulating a lost page.
- The restored helper uses `store.prepareWork` for unsupervised scratch, outside
  the project; supervised exports use the admitted native scratch owner.
- `sweepProjectTemps` scans owned names under the project, deliberately excludes
  deliverable exports, and preserves foreign-locked, held or unjudgeable paths.
- The fixture expects removal using `folder.slice(proj.length + 1)`, which is not
  a sound project-relative path if the scratch folder is outside `proj`.

This is a strong ownership-mismatch lead, not a validated repair. A likely clean
resolution is to test legacy project-folder cleanup with an explicitly authored
legacy fixture and test app-work orphan cleanup through its actual owner. First
confirm the intended supported behavior and coverage. Do not reintroduce project-
owned scratch solely to satisfy an outdated test, or quietly lose orphan cleanup.

First narrow check, from the QA worktree:

```powershell
node node_modules/vitest/vitest.mjs run --config vitest.smoke.config.ts src/tools/projectTemps.smoke.e2e.ts --testNamePattern 'a caption folder left behind' --reporter=json --outputFile=reports/qa/exporter/handover-cleanup-repro.json
```

This is a documented command, not a test run performed while preparing handover.
Preserve production ownership and staleness guards. Do not disable the test,
blindly lengthen sleeps, weaken cleanup assertions or regenerate references.

Durable result/log in the isolated QA reports directory:

```text
qa-push-envelope-profile-v2.json
pre-push-envelope-profile-v2.log
```

The former background terminal `4416a09d-4f84-413b-af41-b536b6eacc6e` completed.
It is not an active push to wait on or restart. Check for any new out-of-band
execution before running another build/push. Never use an OS PID as a terminal ID.

## 9. Remote CI And Pending Repairs

Last pushed source: `2bc972116aa3ef827087077ee4f567c1e1fadef0`.

- General CI: https://github.com/art-daddy/artdaddy/actions/runs/39070080978
- Native exporter QA: https://github.com/art-daddy/artdaddy/actions/runs/39070081086

Both failed. They are preserved failure evidence, not current-source passes.

| Earlier Failure | Local Repair | Remaining Proof |
| --- | --- | --- |
| macOS native capture had no admitted scratch reservation | Restore main's native-owned scratch staging helper | New exact-SHA macOS Tauri artifact |
| Linux expired-restart fixture retained queued-time credit | Give the fixture a consistent expired clock | Linux rerun |
| Six source formatting failures, then restored scratch-helper formatting | Format only affected owned source files | Current full style gate already passes locally; fresh CI still required |
| Native library fixtures requested unstaged production MCP/whisper resources | Export CI uses FFmpeg/probe-only test bundle config | Three-platform export-suite rerun |
| Linux process-wide descriptor test raced another limit raiser | Isolate its mutation in a subprocess; preserve exact assertions | Actual Unix runtime check |
| ARM floating samples differed from Windows-only byte pins | Exact same-platform allocating-delay oracle on all OSes, plus unchanged Windows pins | Actual ARM/Linux waveform checks |

Native workflow requires real ignored lifecycle/output-bound tests explicitly,
not a green command that ignored them. It also requires exactly 18 portable
source-clock/DSP/chroma/delay/native-piece cases, not zero matched tests.

Do not stop at a green workflow badge. Download the exact-SHA artifacts and inspect
protocol, source/app/worker identities, native receipts, recovery count, complete
frame/sample counts, caption pixels, publication identity and cleanup outcomes.
Keep omitted/skipped environmental branches visible.

## 10. Testing And Qualification Still Required

### 10.1 Immediate Software Closure

1. Diagnose and repair the single cleanup smoke failure at its owning boundary.
2. Rerun its narrow existing test immediately after the repair.
3. Keep all frozen references unchanged; verify snapshot-update counts are zero.
4. Commit the finished slice locally, excluding unrelated dirty files.
5. Retry only the already-approved QA branch with every committed hook enabled.
6. Verify actual remote SHA and completed CI outcomes, not queued status.
7. Inspect downloaded artifact contents and preserve all failed runs.
8. Integrate qualified QA-only changes back into main conservatively; do not
   wholesale merge/reset or assume the two worktrees have the same source.
9. Rerun meaningful integration gates on the combined source before release.

### 10.2 Required Hook Lanes

The committed pre-push hook runs client build/unit tests, the Node reporter/source
controls, Cargo tests, real-FFmpeg smoke and the backend bundled-contract guard
when prerequisites/checkouts are present. Verify prerequisites so an optional
environment check cannot silently skip a required lane here.

- Do not use `--no-verify`, disable hooks or hide a failed subprocess exit.
- Keep `core.hooksPath` set to `.githooks`.
- Have Cargo, FFmpeg and ffprobe on PATH; stage the shipped sidecars/resources.
- Use the backend virtual environment for its contract guard.
- The backend contract test has used the sibling main-client checkout in some
  paths; document that scope rather than assuming it proves isolated QA.
- Clear private benchmark/generation/source-map overrides and snapshot-update
  switches for broad gates. Keep API calls on loopback and Sentry disabled.
- Do not run two builds/pushes concurrently against the owned test tree.

Normal work does not run full suites unprompted. Use narrow checks and diagnostics;
all hook and release lanes are mandatory at their actual gates. External QA files
may receive false-clean editor diagnostics; the real build/typecheck is required.

### 10.3 Full Promise Library

The library has 11 full promise cases, two profiles and three platforms: 66 planned
promise variants. Pilot, measurement and stretch cases are separate categories.
It includes ordinary/social HD, 2-hour/1,000-clip HD, 30-minute 4K shapes,
seven-video-plus-caption and eight-video heavy HD, HD60, phone VFR/rotation,
screen recording and licensed web media. 4K60 is measured separately.

For every required variant, inspect the complete delivered MP4:

- Correct duration, resolution, frame rate, complete frame count and moving picture.
- Correct source selection, trim, rotation, VFR timing, gaps, loops and range edges.
- Stereo/mono behavior, channel identity, source clock, continuity, effects and ducking.
- Actual caption pixels at multiple times; changing animations must differ.
- Exactly the intended watermark/end card; no duplicated end cards or missing tails.
- Validated publication/registration identity and preserved previous destinations.
- Applicable speed target, a genuine estimate and bounded extra temporary space.
- Cleanup after success, failure, cancellation, crash/recovery and failed cleanup.

Keep attempted, ready, blocked-source/storage, unknown-readiness, declined and
cancelled denominators explicit. A slow 16 GB artifact is not a speed-qualified
promise pass. A missing denominator is null, not 100%. Do not erase failures or
reinterpret pilots as promise successes. 99% is the controlled library metric,
not a measured population claim.

### 10.4 Lifecycle, Filesystem And Failure Matrix

Still qualify the class of operations, not just the easiest member:

- Ordinary/range/clip, batch and copy; UI, agent and MCP entry points.
- Close/switch/reopen, failed close, Stop/supersede, retry/discard and ignored abort.
- Failure before/after admission, native prepare, journal persistence, write,
  producer completion, verification, publish, catalog registration and acknowledgement.
- Crash between effects in both orderings; retained charges and old destinations.
- Cross-volume/destination behavior, physical aliases, case-sensitive paths,
  simultaneous exports, source mutation/offline media and failed cleanup.
- Every registry/catalog-driven effect, transition, caption, fit, animation and
  delivery option against the actual model and actual rendered output.

### 10.5 Resource Qualification

Complete allocated temporary-space coverage across scratch, staging, copy temps,
normalization, fonts/graphs, manifests/journals, validation/recovery and pending
outputs. Account for volume allocation units, metadata and concurrent retained
files. Demonstrate cleanup and failure-safe refusal on each supported filesystem.

Prove or explicitly constrain Windows crash ordering for byte-range locks versus
worker-group termination. Execute Unix file-size enforcement on real Unix hosts.
Do not equate file length, sampled RSS or headroom with an exact physical ceiling.

Finish profile paths for all variants, including Linux 8 GB evidence. Full-size,
full-duration, stress and physical-machine execution remain owner-deferred until
software changes are complete. Reconfirm readiness before that expensive phase.
The owner supplies physical devices; do not invent equivalent hardware or paid VMs.

### 10.6 Acceptance Closure Matrix

The 11 accepted V2 IDs are E0.1, E1.1-E1.4, E2.1-E2.3 and E3.1-E3.3. Preserve
their regressions during every remaining change. The 13 open boxes are:

| Box | Current Implementation / Residual | Evidence Needed To Close |
| --- | --- | --- |
| E0.5 | FFmpeg choice exists; full measured promise/profile and 4K60 limits do not | Accepted limits from complete applicable runs, not short extrapolation |
| E1.5 | Shared admission/consent/session fences built | Full UI/agent/MCP, batch/copy, refusal and lifecycle matrix |
| E2.4 | Pooled payload and new file-length guard built; allocated-space envelope incomplete | Every temporary category, actual filesystem allocation, all platforms and crash/failure ordering within 20 GB |
| E2.5 | Broad visual/caption/quality artifact coverage exists | Remaining admitted feature classes and complete current-source integration |
| E3.4 | Leases, identities and native publication built | Cross-volume, case-sensitive, alias, concurrency and failure-order proof |
| E3.5 | Real isolated native crash recovery passes locally | Current real-app/project/follow-up/fault library on all platforms |
| E4.2 | Separate preview/export painters plus parity regressions | Complete relevant real-media timing, image/alpha/text and visual parity |
| E4.3 | Continuous audio and source-clock fix built | Full-duration/source/platform audio continuity, DSP and channel outcomes |
| E4.4 | Shared estimates/warnings/calibration and approved local Fast mode built | Cold/repeated/full-case estimate accuracy, warning behavior and device-specific quality evidence |
| E5.1 | Current platform code paths and CI definitions exist | Actual completed protocol-20 sidecar/native/packaged outcomes for all three OSes |
| E5.2 | Library, Windows cap and new Unix host-evidence inputs exist | Complete profile coverage, including Linux 8 GB, full workloads and later owner-supplied devices |
| E5.3 | Shared UI/MCP/export workflows built | Real workflow, cancellation, close/reopen and failure journeys |
| E5.5 | Anonymous collection and denominator/report tooling built | Verified reporting/privacy/deployment plus per-line complete library outcomes meeting the agreed metric |

The maintained tracker excludes E0.5, E2.4 and E5.2 from its ten built/proof-pending
boxes. Recent partial implementation must not silently change that classification
or acceptance count. Reconcile the tracker explicitly when a gate truly closes.

The old giant combined case E0.4 and beyond-promise qualification E4.5 are stretch.
Engine research/plan E0.2/E0.3 is historical parked work; new-engine E4.1 is deferred;
real-user/cohort E5.4 is owner-run later. These are not missing V2 implementation
items to resurrect in order to increase a percentage.

## 11. Deferred Original New-Exporter Effort

V1 was a larger renderer/active-source redesign intended to address decode,
retained-frame, descriptor and memory pressure beyond the ordinary FFmpeg path.
The old combined shape was a 2-hour 4K60 timeline, around 5,000 clip placements
and 16 visible layers on an 8 GB class machine, with an 8-hour target. It is not
the active V2 promise and was not achieved by a six-second pilot.

Alternative-engine research, a native GPU worker, MLT/GPU probes, prototype
benchmark/memory modes and related scaffolding were preserved and parked. They
are not integrated product behavior and do not establish a qualified replacement
renderer, persistent-decoder ceiling or cross-platform GPU implementation.

Archive branch:

```text
archive/exporter-prototypes-v2-2026-10-16T15-55-26-193Z
```

Archive checkpoint: `69bc93fc74b8944111caeaa505a951ea7caa9e89`.
Prototype separation from active work: `1ae8fe1`.

Preserved worktree/backups are under:

```text
C:/Users/akshaydagar/Akaru/_scratch/analytics/exporter-chat-analysis/
  parked-prototypes-v2-2026-10-16T15-55-26-193Z/
```

Keep those assets and archive history. Do not delete, merge or reactivate them
as an incidental cleanup. Do not confuse native job supervision, pipes, crash
recovery and the shared Workspace with the parked new rendering engine.

### 11.1 What Is Actually Preserved

The archive checkpoint contains these eight changed experiment/mixed-snapshot
files, verified from Git rather than inferred from their names:

```text
scripts/qa/exporterGpuProbe.mjs
scripts/qa/exporterMemory.ps1
scripts/qa/exporterMltProbe.ps1
scripts/qa/exporterNative.mjs
scripts/qa/exporterNative.ts
scripts/qa/exporterNativeWorker.cpp
scripts/qa/exporterNativeWorker.ps1
src/tools/bench_render.e2e.ts
```

Separation commit `1ae8fe1` retained the useful native FFmpeg QA/memory harness
and changed the benchmark surface. The archive branch preserves the mixed files
before that separation. Current files with the same names are not necessarily the
same experiment. Do not restore an archived mixed harness wholesale over V2.

Additional recovery locations:

```text
C:/Users/akshaydagar/Akaru/_scratch/analytics/exporter-chat-analysis/
  prototype-backups/2026-10-16T15-55-26-193Z/
  parked-prototypes-v2-2026-10-16T15-55-26-193Z/
  live-backups/
  recovery-snapshots/
```

Private runtime/SDK and generated media evidence were also staged under OS temp
directories. Those are not guaranteed to survive cleanup. Archive source does not
prove the old DLLs, SDK, executable, headers and frozen fixture bytes still exist.
Inspect before execution, and preserve provenance/failed reports before any rebuild.

The original worker used a pinned private Shotcut/FFmpeg runtime and matching public
headers, not arbitrary system DLL layouts. Recorded pins:

- Shotcut Windows portable 26.9.27; MLT 7.41.0.
- Runtime archive SHA256:
  `1f8c50ce7b125a2f0dcb60777b358e86baf03b8515982612b6adae10a83d93a5`.
- Matching FFmpeg source revision:
  `c867e135494d97b27158d17837d254bbbb8d4f7b`.
- Matching library versions included avcodec/avformat 63.1.102, avutil 61.1.102,
  avfilter 12.1.102, swscale 10.1.102 and swresample 7.1.102.
- Worker provenance bound headers, generated consumer configuration, source/binary
  and runtime libraries. The source-archive digest was observed, not an independently
  published upstream checksum. GPL distribution/licensing and complete build/release
  integration remain decisions to revisit before any product use.

The parked PowerShell launcher has Stage/Build/Run actions and can fetch SDK source
when missing. Do not execute it merely to inspect the archive. Engine experiments
remain deferred until the owner explicitly resumes them.

### 11.2 Historical Prototype Results And Their Limits

These are the ledger's historical bounded-fixture measurements, not V2 release
acceptance, current-driver guarantees or two-hour extrapolations. Process peaks
exclude unmeasured GPU/driver/system/producer allocations unless explicitly stated.

| Candidate / Experiment | Work Completed / Observed | Why It Was Not A Product Solution |
| --- | --- | --- |
| MLT reuse | Verified basic 3-second HD/4K60 frames and independent stereo; bounded queues reduced one measured process peak from about 763 MB to 569 MB | Dense 16-reader mode either exceeded the unchanged 4 GiB guard or timed out; feature parity was not established |
| Browser GPU/WebCodecs | Actual Radeon/ANGLE drawing, readback, direct encode and pump-vs-seek scheduling measurements | Full-frame readback was about 75.6 ms/frame; independent-reader startup and reference-color gates failed or were too slow |
| FFmpeg hardware interoperability | D3D11/AMF and Vulkan one-source and dense artifact probes | CLI scalers failed or crashed; some Vulkan dense paths exceeded memory or timing; capability listings were not functional proof |
| Custom library decoder/resize worker | Pinned C++/D3D11 worker, explicit frame/packet/device ownership, GPU resize before readback and bounded batching | Decoder/resize-only timings exclude composition/audio/encode; Windows fixture work, not portable engine integration |
| Sustained decoder batch | 16 readers, 30 seconds/1,800 frames, 78.384 seconds, about 2.317 GB process peak; reader/frame/rewind checks passed | No full-canvas composition, effects, caption/audio pipeline or minimum-machine qualification in that timing |
| Opaque GPU composition/encode | Shared-scene 16-reader 30-second MP4; 86.426-second worker, 92.677-second measured worker/mux/verification sum | Opaque fixture and copied/sample-window audio, not arbitrary timeline semantics or total-job resource proof |
| Overlap/animated opacity | Initial video-processor route failed; alternate NV12 shader passed forward/reversed order, opacity checkpoints and negative opacity artifacts | No blanket media-alpha/HDR/color/effect/platform parity; little budget headroom in sustained measurements |
| Fixed encoder output pool | Three precreated output textures/descriptors; forced fourth refusal, reuse and release counters; sustained reuse | Bounds application-supplied encoder outputs only, not decoder, codec-internal, driver or total GPU memory |
| Static PNG alpha | Actual alpha/hidden-RGB fixtures, reversed order, pixel-alpha times clip-opacity; hidden-RGB leakage repaired and challenged with wrong-alpha MP4s | One video plus static layers is not 16 video readers; HDR/general media-alpha still unqualified |
| Caption bridge | Shared ASS/fonts, shipped libass producer, bounded backpressured raw/QTRLE transport, actual caption-region/time-direction checks | Private runtime lacked libass; bridge/alpha conventions, transfer/state memory and full job integration remained nontrivial |
| Compressed caption transfer | Same dense short MP4 bytes with transfer shrinking from about 5.972 GB raw to 6.525 MB; worker time improved in bounded trials | Different load samples are not calibrated speed guarantees; decoder/internal allocations remain outside buffer-only claims |
| Dense 30-second caption case | All 1,800 frames/caption crops and 1,440,000 stereo frames passed; measured sum 130.783 seconds in one run | Exceeded four-times output duration; not the combined eight-hour/8 GB goal |
| Output-only/cached verifier trial | Byte-identical dense output; measured sum 119.412 seconds per 30 seconds after verifier reuse | Less than one second below four-times duration on the development host is not sustained qualification or safe headroom |

Useful adversarial gates already existed: wrong source/time direction, missing or
frozen captions, wrong alpha, output-quota failure, truncated caption input,
wrong caption clocks, producer-first failure, descriptor exhaustion and resource
release. Retain those negative artifacts and receipts. Earlier broad mean-color
checks accepted wrong output; caption-region and signed temporal checks caught it.

The native prototype's audio mostly used independently checked sample-window
repetition/remux, not a complete replacement for the editor's mixer, arbitrary
effects, ducking or active audio-source scheduling. Do not overstate that work.

### 11.3 What Resuming V1 Would Still Require

1. Renew the product decision and measured target; V2 limits do not authorize V1.
2. Verify/archive provenance, SDK/runtime compatibility and reproducible builds.
3. Choose MLT reuse, custom library execution or another measured approach rather
   than automatically continuing a failed scaler/compositor branch.
4. Integrate persistent active-source decoders and bounded active-audio scheduling,
   with persistent filter/effect state and bounded queues, or prove an equivalent.
5. Route immutable shared timeline/render/caption rules into the backend; do not
   fork manual/agent semantics or hand-copy preview layout.
6. Complete all admitted visual, blend, text/caption, alpha, crop/fit, color/HDR,
   source-format, VFR/speed/range and audio-effect behavior, with refusal for
   unsupported capabilities rather than silent fallback.
7. Provide complete workload/capability/resource-based planning, not just input counts.
8. Preserve current native admission, source leases, crash recovery, cancellation,
   verification/publication and original-project registration contracts.
9. Prove whole-job memory, temporary allocation, time, failure cleanup and resource
   release, including producer/decoder/codec/driver costs and late repeated cycles.
10. Re-run the original combined target on an actual qualified minimum machine;
    then qualify independent Windows/macOS/Linux implementation and packaging.
11. Decide distribution/licensing, stable backend/protocol versioning, migration,
    rollback/switch-back, cohort rollout and release support separately.

Reusable GPU-library extraction was itself deferred; no reusable production GPU
component was delivered by parking the worker. Keep that separate from the V2
native transport and OS-budget modules that are real product infrastructure.

If the owner explicitly resumes V1 later, first reassess the remaining measured
V2 gap, compare alternatives against current-source full artifacts, and propose
the smallest justified approach. A replacement would still need the shared
admission/lifecycle/delivery contracts, complete visual/audio/caption conformance,
cross-platform packaging/licensing, recovery, memory/disk/time proof and a
separate approved migration. No release or acceptance credit carries over from
prototype existence alone.

## 12. Release And Deployment Are Separate Unfinished Work

No exporter release is authorized or shipped by the isolated QA push. Unrelated
updater work may exist elsewhere; do not modify it or infer exporter delivery
from its releases.

Before a future owner-authorized exporter release:

1. Finish scoped main integration and all software/qualification gates.
2. Run all release lanes: client unit suite, real-FFmpeg smoke, native Cargo tests,
   TypeScript no-emit check, and backend pytest. A green unit suite is insufficient.
3. Verify actual packaged sidecars/resources and exported artifacts on each OS,
   including current protocol and recovery. A dev build is not installer proof.
4. Confirm telemetry allow-lists and both privacy-policy copies; keep private
   billing/operations facts out of public docs, catalogs and release notes.
5. Stage browser resources from their source, build the MCP bundle, and verify
   branded/font resources and sidecar capabilities. Do not ship stale generated files.
6. Coordinate client/backend/landing compatibility and versioning deliberately.
   Do not raise the capability generation floor for an optional release.
7. Use the existing signed release workflows for all three platforms only after
   release permission. Never regenerate the existing updater signing key.
8. Create the release as a prerelease before asset upload; verify every required
   installer/update artifact and signature, then promote only when complete.
9. Publish the update manifest last, after valid downloadable assets/signatures.
10. Deploy the landing site and verify the live manifest by parsing its JSON,
    checking signatures/platform entries and testing actual download/version links.
11. If backend code changed, use its committed deployment workflow; use its
    environment-deploy script for environment changes, not hand-built Azure edits.
12. Verify an installed old app can obtain the update and a new packaged app can
    complete the required exports. Keep rollback/recovery and failed-update
    behavior observable. No automatic success claim from queued Actions jobs.

Release traps to carry forward:

- An installer without its updater signature is not a publishable update.
- Updater minisign signatures are separate from Apple/Authenticode signing.
- A reused version can be invisible to installed clients.
- Landing/update manifest JSON must be BOM-free and deployed, not merely committed.
- The updater endpoint is `https://artdaddy.app/updates/latest.json`; a successful
  HTTP status alone is not JSON or version correctness.
- Cargo may not restage replaced sidecars without a build-script rerun; verify
  staged binary identity/size, not just a short successful rebuild.
- Browser sidecar resources are generated build artifacts; editing the source
  does not make a direct native build regenerate them automatically.
- Unsupported image dimensions can make looped FFmpeg spin rather than fail.
  Judge media metadata/pixels, not just a successful ffprobe exit.

Never send key contents, tokens, passwords or signing secrets through the model.
If a secret is required interactively, the human enters it directly in the terminal.

### 12.1 Practical Release Gates And Publication Order

Only after explicit release authorization, the required broad commands include:

```powershell
# Integrated client worktree, not the old isolated QA baseline.
npm run format:check
npm test
npm run smoke
cargo test --manifest-path src-tauri/Cargo.toml
npx tsc --noEmit

# Backend worktree, using its selected virtual environment.
C:/Users/akshaydagar/Akaru/.venv/Scripts/python.exe -m pytest
```

Also require current browser UI/compositor checks, real audio, portable native
lifecycle/output-bound/18-case lanes and packaged-app artifact checks where those
cover the changed risk. Property/fuzz, conformance and scoped mutation checks must
follow repository policy for newly introduced pure modules or sensitive transforms.
Do not create mirror tests that only restate commands. Keep skipped lanes explicit.

Use the existing Windows/macOS/Linux release workflows and current documented
inputs, including `publish` and `enable_auto_update`. No release workflow creates
the GitHub release for you. Create its tag/release at the verified integrated
commit as a prerelease first; keep it out of Latest until all required assets exist.

Version changes cover Tauri configuration, Cargo/package manifests and lockfiles,
and the MCP bundle manifest. Use current drift guards and an owner-approved new
version, not stale 0.2.x examples or this QA branch's 0.21.4 baseline.

The full release path must stage and verify actual shipped FFmpeg/ffprobe,
transcription/browser helpers, DLL dependencies, fonts, branding and MCP bundle.
Test configuration that excludes resources is for library CI only, never a release.

The local registry restriction can prevent the aggregate release script from
finishing. If reusing staged resources, rebuild the browser sidecar and MCP bundle
from current sources first; verify their generated content and runtime identities.
Do not treat a successful direct native build as proof they were regenerated.

For signing, preserve the existing trusted key. Native builds use signing-key
content, not merely a key-path variable; an installer can exist even when signing
failed. Resolve an interactive signing prompt rather than rebuilding a completed
installer. Verify actual artifact/signature pairs with the repository verifier.
Historical Windows header-type/signature-upload issues also require checking the
current workflow and actual published signature, not trusting an upload step badge.

For platform updates, verify Windows installer/signature, macOS app-update archive/
signature and Linux AppImage/signature. Linux package users outside the updater
path may still update manually. Apple/Authenticode first-launch trust is distinct
from the free updater signature; do not confuse missing notarization with inability
to deliver a signed updater package. Exercise the actual packaged applications.

After assets and signatures verify, promote the GitHub release. In the landing
repository, set the new manifest version/notes/date, update each platform with
the existing `update:platform` script and verified signature, update visible version
labels, and deploy. The script does not choose/bump the version for the operator.
Publishing the manifest is the final activation switch, not the earlier Git push.

Verify the deployed manifest parses, names the intended versions/platforms,
contains valid reachable artifacts/signatures, and that visible download labels
match the actual Latest release. A stale pinned URL can return 200 successfully.
Test update delivery from an older installed app and export/recovery from the
new installer. Never ship this exporter merely because unrelated updater work
has been released.

## 13. Continuation Rules And Completion Claim

Proceed independently within the approved V2 scope and record decisions in the
architecture ledger. Keep commits focused and local. Only the established QA
branch/standard-runner push exception is approved. No release, main push, paid
generation, extra engine, raised budgets or private-media upload is implied.

Before changing state/concurrency/persistence contracts, write an invariant
ledger covering authority, every producer/consumer/bypass, lifecycle, deepest
commit point and both failure orderings. Guard the shared mandatory boundary,
not callers that remember an optional argument.

After substantive edits, run the cheapest discriminating check immediately;
repair that slice before widening scope. Do not use graph strings, exit zero,
test counts or queue acceptance as substitutes for artifact effects. Keep
frozen references and compare before/after bytes where relevant.

At eventual closure, report these categories separately:

- Guaranteed: the narrowly established behavior on the tested source/platforms.
- Residual: uncovered paths and known unsupported conditions, with impact.
- Deferred: owner-deferred hardware, full-size/stress or V1 work.
- Proof: source identity, executed tests, artifact comparisons and failed attempts.

Do not say implementation, cross-platform qualification, 20 GB enforcement,
99% reliability or release is complete while the corresponding work above is open.

## 14. Commit And Evidence Map

### 14.1 Selected History

This is a navigation map, not permission to cherry-pick whole histories over dirty
main. Later QA commits are based on a deliberately isolated older baseline.

| Commit | Location / Purpose |
| --- | --- |
| `0bba45f` | Main: restore five authorized exporter snapshots after source/evidence drift |
| `69bc93f` | Archive: preserve engine/GPU experiments and mixed snapshots |
| `1ae8fe1` | Main: separate prototypes while retaining the existing FFmpeg QA path |
| `5f8917f` | Main: V2 re-scope and tracker |
| `ce1bc8f` | Main: promise-library/pilot infrastructure |
| `7299ad6` / `fca384e` / `ff1b035` | Client/backend/landing: initial anonymous reporting and privacy work |
| `5536b9b` / `5ff64a6` | Client/backend: early and operation-aware anonymous outcomes |
| `1323727` / `21dc34e` | Main: pooled copy/final-MP4 staging; protocol 20 |
| `ff20ddf` | Main: separate accepted checks from built/proof-pending work |
| `08cb75f` | Main: preserve source audio clock before mixing |
| `540dd3e` | Main tip: encoder identity type and scoped QA consent |
| `78abe2d` / `e109ae3` / `52a037b` | QA: current exporter snapshot and dependency/fixture/type closure |
| `8ec61e5` | QA: explicit headless smoke consent; production consent still fail-closed |
| `ad45898` | QA: chromakey-only threading and portable coverage |
| `ffd810a` | QA: 120-clip Automatic case through real native fixture |
| `2bc9721` | QA: frozen-corpus comparison adapter; last successfully pushed revision |
| `2ac8a93` | QA only: native OS output-write guards and real native CI lanes |
| `4bcc2e2` | QA only: deterministic expired-restart fixture clock |
| `0ea9ca4` | QA only: restore native-owned scratch staging dependency from main |
| `2be0682` | QA only: bind software profiles to host/native observations |
| `83bf374` | QA only: targeted source formatting gate repairs |
| `8f800f9` | QA only: export-CI resource config and isolated Unix descriptor fixture |
| `a758126` | QA only: portable allocating-delay oracle, unchanged Windows pins, 18-case CI selector |

There are seven local QA commits after the last pushed revision. Not every QA
change belongs in main as a wholesale copy: some only repair the isolated
baseline's missing dependencies. Compare per file and preserve unrelated work.
The output guard, profile inputs, chroma policy and their regression coverage do
need deliberate integration where main does not already contain them.

### 14.2 Primary Evidence Locations

Most new integration evidence is in the isolated QA worktree, not main. The
following paths are relative to its reports/qa/exporter directory:

```text
qa-push-envelope-profile-v2.json
pre-push-envelope-profile-v2.log
qa-push-comparator-v2.json
pre-push-comparator-v2.log
profile-controls-final.log
profile-native-envelope.log
x86_64-pc-windows-msvc-1792274378973/report.json
portable-ci-eighteen.json
portable-allocating-audio-reference.json
format-corpus-export-controls.json
format-scratch-owner.json
ci-bundle-native-control.json
ci-39070080978-failed.log
```

| Evidence | What It Establishes | What It Does Not Establish |
| --- | --- | --- |
| Latest failed push JSON/log | Exact candidate SHA and the one cleanup smoke failure | Successful push or backend/current remote gate completion |
| Earlier comparator push JSON/log | The earlier 2bc9721 snapshot passed its complete local hook and reached the remote | Correctness of seven later commits |
| Native report 1792274378973 | Real Windows protocol-20 capture/recovery, identity-proven publication, all transport outputs and native resource envelope | Minimum-machine, Unix, full-duration or whole-space qualification |
| Profile controls | Ten reporter/source controls including malformed/mismatched/over-bound evidence and original-audio checks | A successful 8/16 GB workload on this 64 GB development host |
| Portable 18-case JSON | Eighteen actual clock/DSP/chroma/delay/native-piece cases passed locally | ARM/Linux execution before the new CI run |
| Allocating-delay JSON | Both ducked/unducked waveforms match the same-platform reference; original Windows SHA pins still pass | A new universal cross-architecture byte hash |
| Formatting/corpus controls | 145 focused cases, no snapshot updates; frozen corpus SHA unchanged | Whole-product acceptance |
| CI bundle native control | Real 120-clip native export works under the exact revised library-test config | Full packaged production resource staging |
| Old failed CI log | Concrete previous platform/setup failures and their diagnostics | Passing new fixes |

Expected artifacts from the next native CI run include source-clock-dsp.json
with exactly 18 executed passes, native-invariants.log, native-stream-runtime.log,
native-output-envelope.log, and the platform's generated native report/log directory.
Artifact names bind runner and full commit SHA. Inspect those exact files; do not
reuse an older matching-looking artifact directory.

Historical main evidence for original source audio:

| Run | Delivered Artifact Check |
| --- | --- |
| Failed screen 1792243122507 | Retained pre-fix timing failure; do not remove it from outcomes |
| Repaired screen 1792244769139 | Ten seconds, 300 frames, 480,000 clock-aligned stereo frames; about 3,137.4 ms; 80 windows, minimum correlation 0.9884562, maximum relative squared error 0.0229627 |
| Phone sibling 1792246084309 | Ten seconds, 300 portrait frames, 480,000 clock-aligned stereo frames; about 8,681.4 ms; 80 windows, minimum correlation 0.9844488013, maximum relative squared error 0.0309564706 |

Original source hashes were checked unchanged. The phone's complete MP4 identity
changed; there was no whole-file byte-identity claim. These are short measurements,
not complete media-class, speed, allocated-space or physical-device qualification.

Private source maps, original phone/screen files and their paths must remain local.
The map filenames and reports may be referenced during engineering work, but never
upload their contents/personal media in the public QA branch or artifact payload.
Licensed web source provenance and pinned hashes must also be preserved.

The report currently deliberately leaves complete temporary-space qualification
false. Do not flip that flag to improve pass rates after merely adding the file-
length guard or host-memory inputs. The required physical allocation evidence must
exist and be bound to the actual run before a full promise result can pass.

### 14.3 Evidence Freshness And Environment Traps

- Native reports include source-set, app, worker and command identities. Compare
  them against the source being discussed, including the new output-guard module.
- Older protocol 7/9/11/18/19 reports are historical; protocol 20 matching by itself
  is also not proof of identical source after later same-protocol changes.
- Some old main files were reset or differed from saved reports. Use Git/disk
  digests when editor reads and recorded evidence disagree; never infer blame.
- Mac's earlier CI VM reported 7 GiB and Linux about 15.6 GiB. Re-measure each new
  run; do not relabel either as an owner-supplied physical laptop.
- A test command matching zero cases or ignoring real subprocess cases is not
  meaningful success. Exact executed-case guards are intentional.
- Editor diagnostics can be false-clean for files in the external QA worktree.
  Use the real narrow executable check and required full hook build.
- On this Windows setup, ripgrep was unavailable; targeted PowerShell text search
  worked. The installed YAML parser is js-yaml, not a package named yaml.
- Use PowerShell 5.1 syntax, not shell `&&`. Avoid literal backticks in double-
  quoted Node-e payloads. Wrap top-level early returns in a function scope.
- Save full UTF-8 generated logs and structured results, then summarize failures.
  A terminal response containing only a prompt or initial progress is not completion.
- Record the exact opaque terminal handle if a command moves to background.
  Never use a PID as that handle; do not poll/sleep or restart an active gate.
- No Docker/container or total-system minimum-device proof was established.

## 15. Suggested New-Session Brief

The following can be used as a continuation prompt. Read the full handover and
current repository instructions before acting; this block is not a replacement
for the evidence and constraints above.

```text
Continue only the approved V2 FFmpeg MP4 exporter implementation.
Read docs/EXPORTER_HANDOVER_2026-10-18.md and the active V2 section of
docs/EXPORTER_ARCHITECTURE.md. Historical V1/new-engine work is parked.

Main implementation baseline is 540dd3e; handover-only commits may follow.
The main worktree is dirty/diverged.
The isolated QA worktree is C:/Users/akshaydagar/qa-exporter-v2-20261017,
branch qa/exporter-v2-20261017, remote HEAD ea12d7f and local HEAD 400457d
plus the owned-worker exit candidate at this checkpoint.
Recheck heads before acting; the checkpoint at the top is the current authority.

Caption cleanup and the native output slice are qualified. Later macOS app
ESRCH failures reopen resident-worker exit classification despite the earlier
green run; a zombie/live/concurrent-writer repair is awaiting actual macOS proof.
The last QA hook
passes build, 5697 unit cases, 10 Node controls, 211 Rust cases (20 ignored),
606 real-FFmpeg smoke cases (234 skips), and the backend bundle guard.
At ea12d7f, Linux/Windows full smoke and both Unix Cargo jobs pass. macOS full
smoke still fails 44 cases and native app recovery fails. Preserve the reports
from standard CI 39111883014 and native CI 39111883008, including actual media.

Main has the native slice, version 0.21.2, with source-equivalence evidence.
Its focused locked Cargo gate refuses before compilation because unrelated
pre-existing root-lock reqwest/rustls entries are absent from the manifest.
Preserve that work and do not call combined-main execution qualified.

The shared name-boundary repair passes 81 focused QA cases at 400457d.
Finish worker-exit and remaining PCM precision qualification. Commit each owned
slice locally; any already-approved
QA push must retain ALL hooks. Inspect exact-SHA standard and native outcomes.
Backport qualified exporter-only changes into main without overwriting unrelated
auth/catalog/updater work. Do not wholesale merge/reset dirty worktrees.

Finish allocated temporary-space coverage and cross-platform software-profile
inputs/evidence, the current UI/MCP/lifecycle/conformance matrix, and reporting.
The file-length guard is NOT a proven 20GB allocated-space ceiling.
Full-size/stress execution and owner-provided physical devices remain last.

Proceed without routine approval pauses inside approved V2 and record assumptions
and design decisions. Do not push main, release/deploy, spend credits, upload private
media/maps, alter frozen references, raise budgets, use unshared browser pages,
spawn subagents or resume the new renderer. No hook bypasses.

Strict acceptance remains 11/24 (46%), historical 13/30 (43%); ten open boxes have
implementations awaiting proof. Do not claim 99%, completion or shipment early.
```