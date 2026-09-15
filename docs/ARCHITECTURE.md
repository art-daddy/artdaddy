# ArtDaddy Client — Architecture (per-module reference)

> The **Tauri desktop app** — the client half of ArtDaddy (TS/React). This document
> is a per-module reference of the client's internals. For the **system-level**
> picture (client⊕cloud topology, the orchestrator loop, the shared contract seam,
> auth/billing, phased plan), see the **ArtDaddy backend repo's `docs/ARCHITECTURE.md`**;
> this doc deliberately does not duplicate it.

> **Architecture status:** This document describes the current implementation. The
> pre-alpha target for project ownership, lifecycle, jobs, commands, and persistence is
> [Project Document Architecture](PROJECT_DOCUMENT_ARCHITECTURE.md). During that migration,
> the target document governs those cross-cutting concerns; this reference remains
> authoritative for unchanged domain engines and module behavior.

---

## 1. Role & boundaries

The client is not a thin front-end — it owns the **authoritative editing state and
all heavy media work**:

- **One source of truth: `timeline.json`, client-side.** The **agent** (via tool
  calls) and the **human** (via UI gestures) mutate it through the **same** atomic
  op layer (`applyOp`). They are peers on shared state.
- **The client owns**: the timeline model + op engine, validation, the ffmpeg
  **render/export**, the WebGL **realtime preview**, the asset **library**, and the
  local tool runtime (ffmpeg / yt-dlp / Playwright / fs).
- **The server is stateless**: orchestration (LLM turn loop), vision (Gemini/
  frames), and generation (image/video/music/voice) only. Heavy media never
  crosses the wire — client tools return small JSON + file paths.

The unit of correctness is therefore mostly here, which is why the client carries
the heaviest test suite (see §14).

---

## 2. Tech stack & entry points

- **Shell**: Tauri (Rust) desktop wrapper; bundled sidecar binaries (ffmpeg,
  ffprobe, yt-dlp) fetched/built at release time.
- **UI**: React + Vite + TypeScript.
- **Preview**: WebGL compositor + WebCodecs/`<video>` sources + WebAudio, run in a
  worker.
- **Entry**: `src/main.tsx` → `src/App.tsx`. Capability detection in
  `src/platform/` (desktop vs web — web disables the client-only tools).

---

## 3. Source map (`src/`)

| Dir | Responsibility |
|---|---|
| `timeline/` | The data model, `applyOp` engine, validation, edit tools, and the ffmpeg render/export builders. **The core.** |
| `tools/` | The client tool runtime: registry + every locally-executed tool (ffmpeg/yt-dlp/library/generation-proxy/fs) + the project store. |
| `preview/` | The realtime WebGL compositor + audio engine + playback transport (the live player). |
| `contract/` | The shared seam: timeline JSON Schema, tool-name snapshot, per-tool arg clamps, conformance test. |
| `agent/` | The client side of the orchestrator turn loop (SSE stream, message compose, tool dispatch). |
| `store/` | App/UI state stores (editor view state, projects, chat/session, indexing). |
| `api/` | Typed cloud HTTP/SSE client (auth, ai, usage, feedback, config). |
| `components/` | React UI (shell, timeline editor, inspector, preview canvas, chat, menus). |
| `lib/`, `platform/`, `observability/`, `types/`, `test/` | Desktop/file helpers, capability detection, Sentry, shared types, test fixtures. |

---

## 4. `timeline/` — model, op engine, edit tools, render

The client's core. **All times are integer PROJECT FRAMES at `canvas.fps`** (never
seconds) except inside a transient "seconds view" used to build the ffmpeg graph.

**Coordinate boundary — `clip_id` → project frames, `media_ref` → source seconds.**
A placed clip has a timeline position, so any tool handed a `clip_id` reports (and
consumes) PROJECT FRAMES; a raw library asset has none, so a tool handed a
`media_ref` reports SOURCE seconds. The perception readers honor this: `get_transcript`
is always frames; `inspect_media` / `video_ask` / `video_find_moment` return frames
when given a `clip_id` (mapping source-seconds → frames via the clip's
trim/speed/position with `clipSpanToFrames`, dropping moments outside its visible
span) and source seconds when given a `media_ref`. Two self-consistent domains so the
model never does fps math itself: the **source** workflow (media → seconds →
`add_clips`/`insert_clips` `source_span`) and the **timeline** workflow (clip → frames
→ edit tools). Every time-typed param is FRAMES or SECONDS by this rule; guards keep it
honest — `src/timeline/units.test.ts` (the tools compute the right unit) + `src/contract/timeUnits.test.ts`
(contract-snapshot drift canary), with the authoritative description/classification guard in
`../Akaru/tests/unit/test_time_units_contract.py`.

- **`model.ts`** — `Timeline` / `Track` / `Clip` / `Keyframe` / `Canvas` types.
  `Animatable = number | Keyframe[]`. Clips carry span (`timeline_in/out`), source
  window (`source_in/out`), `speed`, `transform` (normalized centre + scale),
  `rotate`/`opacity`/`volume` (animatable), `crop`, `fade`, `transition_in`,
  `color`, `effects`, `link_group`, text `content`/`style`/`animation`.
- **`engine.ts`** — the **`applyOp` pipeline**, every mutation's single path:
  `load → clone(before) → mutate → normalizeTimeline → validate → (reject or)
  push history → save`. Rejection is atomic (nothing written). Also:
  `normalizeTimeline` (the canonicalizing pass = `normalizeClipOrder` →
  `normalizeLinks` → `clampTimelineValues` → `deriveSourceSpans`, each idempotent
  so it's a fixed point), `deriveSourceSpans` (source_out is DERIVED, exempting
  loop/stretch), `loadTimeline`/`ensureTimeline`/`ensureStarterTimeline`/
  `replaceTimeline`, undo/redo with `HISTORY_CAP`, transient-read retry.
- **`validate.ts`** — structural + timing checks: track/clip shape, no same-track
  overlap (except a transition's required overlap), timeline/source **parity**
  (`(source_out-source_in)/speed == span`, **exempt for loop/stretch**),
  transition duration ≤ both clips.
- **`clamp.ts`** — NLE-style nearest-bound clamping of scalar knobs
  (opacity/volume/glow/crop/duck/**fade**). Fade is clamped to the clip's **frame**
  span.
- **`helpers.ts`** — track resolution (`resolveTrack` with a kind guard),
  `linkPartners`, **`normalizeLinks`** (same-source A/V share speed **and** length),
  **`splitClipAt`** (partitions keyframes at the cut so the right half keeps its own
  origin), `clearRegion` / `rippleOpenGap` / `rippleDeleteRange` (overwrite/ripple),
  media-kind detection.
- **`ops.ts`** — structural ops: `get_timeline` (windowed/compacted read),
  **`set_canvas`** (fps change **rebases** every frame coord via `rescaleTimelineFps`),
  add/remove/set track, `undo`/`redo`.
- **`placement.ts`** — `add_clips` / `insert_clips` / `add_text_clips`. Probes a
  video source for audio (`sourceHasAudio`) and **splits A/V into a linked audio
  clip**.
- **`edit.ts`** — `move_clips` (overwrite), `trim_clips` (guards degenerate spans),
  `split_clips`, `ripple_delete`, `link`/`unlink`, `set_transition` /
  `apply_transition` (non-shifting crossfade).
- **`props.ts`** — `set_clip_properties` (props + speed-rescale + **fade/volume
  propagation to the linked audio partner**), `set_keyframes` (sort + last-write
  dedupe via `normalizeKeyframes`), `apply_color`, `apply_effects`, `set_transition`.
- **`render.ts`** — **`buildRenderCommand`** (deterministic ffmpeg `filter_complex`
  builder: inputs, transform/crop/flip/rotate/opacity, blend, colour grade,
  centered crossfade, audio adelay/volume/fade/atempo/loop/mix, drawtext),
  `renderTimelineTool` (regeneratable cache render), **`exportTimelineTool`**
  (mp4 deliverable to Downloads; fcpxml deferred), `resolveClipSources`.
- **Supporting**: `anim.ts` (`sampleAnim`/`compileAnim` — keyframe interpolation +
  easing, **shared by preview and render** so they agree), `keyframe.ts` (editing
  helpers + `normalizeKeyframes`), `frames.ts` (frame↔seconds↔timecode, `canvasFps`,
  `toFrames`, `toSecondsView`), `shape.ts` (`compactClip` drops defaults;
  `diffTimeline` → the **mutation delta** the model patches its picture from),
  `transition.ts`, `geometry.ts`, `mentions.ts`/`mentionOptions.ts` (chat @-mentions
  of clips/ranges), `bus.ts` (timeline-change event bus → preview), `errors.ts`
  (`OpError`), `zoombar.ts`.
- **`invariants.property.test.ts`** — the fast-check **fuzzer** over `applyOp` (see
  §14).

---

## 5. `tools/` — the client tool runtime

Every tool the model can call that executes locally.

- **`registry.ts`** — `ClientToolRegistry` (`register` / `has` / `names` / `run`).
  `run` clamps args to the contract before dispatch.
- **`index.ts`** — `createToolRegistry(getCtx)` wires every tool onto a registry.
- **`context.ts`** — `ClientToolContext` = `{ store, runner }` (the project store +
  a `CommandRunner`). **`command.ts`** — the `CommandRunner` interface (spawn a
  binary). `host.ts` / `tauri.ts` / `dataRoot.ts` — platform host + Tauri bindings.
- **`store.ts`** — `ProjectStoreAccess`: `timeline.json` IO (atomic write), artifact
  paths, export paths (OS Downloads, cache fallback), portable ↔ absolute media
  refs. **`editorContext.ts`** — ambient playhead/selection snapshot for reads.
- **Media / ffmpeg**: `media.ts` (`probe_media`, `run_ffmpeg`, `clip_video`,
  `crop_image`), `inspect.ts` (`inspect_media` / `inspect_timeline` / `inspect_color`
  → colour **scopes**), `decode.ts`, `geminiEncode.ts` (low-res proxy for the model).
- **Net / library**: `net.ts` (yt-dlp `download_video` / `youtube_search` /
  `video_get_metadata`), `import.ts` (`import_media`), `library.ts` (`library_op`),
  `artifacts.ts` (`read_file` / `write_file` / `patch_file`), `attachments.ts`,
  `sidecar.ts`.
- **Generation (server-proxied)**: `generation.ts` + `genModels.ts` (`generate_image`
  / `generate_video`, `list_models`), `audio.ts` (`generate_music` /
  `generate_voiceover`), `transcribe.ts`, `video.ts`, `vision.ts`, `web.ts`
  (`web_search`), `style.ts` / `styleSchema.ts`.
- **Projects**: `project.ts` (`new`/`open`/`list`/`duplicate`/`delete` +
  `ProjectRegistry`).
- **E2e harness**: `__e2e.ts` (runner/fs + `srcSolid`/`srcTone`/`srcSplit`,
  `framePng`, `measureColor`, `meanVolumeDb`, `probe`, `renderMp4`), `smoke.e2e.ts`,
  `render_golden.e2e.ts`.

---

## 6. `preview/` — the realtime WebGL compositor

The live player; must **pixel-match** the ffmpeg export (the hardest correctness
constraint).

- **`scene.ts`** — **`buildScene(timeline, tSeconds, assetDims) → Scene`**: a
  z-ordered draw list. Each `Layer` carries geometry (`dst`/`src` rects via the same
  contain/cover fit math as ffmpeg), `opacity`, `rotate`, `blend`, transition
  progress, and a **grade approximation** (eq/exposure/wb/levels/hs). Wheels/curves/
  LUT are **export-only**. `TextLayer` for captions.
- **`renderer.ts`** — the WebGL draw of a `Scene`. `previewWorker.ts` /
  `previewClient.ts` / `protocol.ts` — the scene is built + drawn in a **worker**;
  `protocol.ts` is the message contract.
- **Playback**: `transport.ts` + `usePlayback.ts` (the clock / play-head),
  `audioEngine.ts` (WebAudio mix with per-clip volume/fade; the video clip's
  embedded track is muted to avoid double audio).
- **Sources**: `videoSource.ts` / `mediaProxy.ts` / `proxyPaths.ts` / `loader.ts` /
  `resolve.ts` (resolve a `media_ref` to a decodable source / proxy), `waveform.ts`,
  `text.ts`.
- **`parity.test.ts` + `__parity.ts`** — the preview↔render **parity matrix**.

---

## 7. `contract/` — the shared seam

The only real coupling to the server (see the backend doc §9).

- **`timeline.schema.json`** — the timeline JSON Schema (mirrored by `model.ts`).
- **`tools.snapshot.json`** — the checked-in tool-name snapshot (regenerated by
  `npm run codegen` from the server's `/contract/tools`).
- **`index.ts`** — contract types. **`clamp.ts`** — per-tool numeric arg
  min/max (applied by `registry.run`). **`useContractVersion.ts`** — version pin.
- **`conformance.test.ts`** — the split-brain guard: the client registry set equals
  the served contract set.

---

## 8. `agent/` — the turn-loop client

- **`loop.ts`** — drives one agent turn: opens the orchestrator SSE stream, applies
  streamed tool calls by dispatching them through the client registry, streams
  results back. **`api.ts`** — orchestrator endpoints. **`compose.ts`** — builds the
  outgoing message (prompt + context + attachments). **`attachments.ts`**,
  **`flag.ts`**, **`types.ts`**. `synclock.e2e.ts` — an agent-loop e2e.

---

## 9. `store/` — app & UI state

- **`editor.ts`** / **`editorCommands.ts`** — editor view state (playhead,
  selection, the UI's timeline mirror) and command dispatch; UI gestures ultimately
  call the same `timeline/` ops as the agent.
- **`projects.ts`** / **`projectConfig.ts`** — open project + settings.
- **`chat.ts`** / **`chatSession.ts`** / **`chatTranscript.ts`** — chat state and
  persisted transcript. **`indexCoordinator.ts`** — media/search indexing.
  **`transcriptFile.ts`**, **`feedbackBundle.ts`**.

---

## 10. `api/` — cloud client

Typed HTTP/SSE to the ArtDaddy cloud: `client.ts` (transport), `auth.ts`, `ai.ts`
(model/turn endpoints), `sse.ts` (stream parsing), `usage.ts` (billing/credits),
`feedback.ts`, `config.ts`, `schema.d.ts` / `types.ts`.

---

## 11. `components/` — React UI

`Shell.tsx` (resizable Premiere-style workspace) hosts: `TimelineEditor.tsx`
(+ `components/timeline/` — tracks, clips, ruler, labels, zoom), `Inspector.tsx`
(keyframable property fields), `PreviewCanvas.tsx` (the WebGL player surface),
`SourceMonitor.tsx` / `LeftColumn.tsx` (library + source preview), `ChatView.tsx` /
`MessagePart.tsx` (agent chat), `MenuBar.tsx`, `ProjectSidebar.tsx`,
`StagePanel.tsx`, `FileTree.tsx`, `AuthGate.tsx`, `ScrubInput.tsx`, `ui.tsx`,
`ClipThumbnail`/`ClipWaveform`. **UI gestures call the same timeline ops as the
agent** — never a parallel edit path.

---

## 12. `lib/`, `platform/`, `observability/`, `types/`, `test/`

- **`lib/`** — `desktop.ts` (Tauri window/OS glue), `files.ts`, `upload.ts`.
- **`platform/`** — desktop-vs-web capability detection (web disables client-only
  tools).
- **`observability/`** — Sentry init.
- **`test/`** — shared fixtures: `setup.ts` (vitest setup) and **`timelineKit.ts`**
  (`seededCtx`, `MemFs`, `videoRunner`/`audioRunner`, `findClipById`).

---

## 13. Cross-cutting flows

- **Agent edit**: orchestrator emits a tool call → `agent/loop` → `registry.run` →
  the `timeline/` op → `applyOp` writes `timeline.json` → `bus` event refreshes the
  preview → the op's **mutation delta** returns to the model.
- **Human edit**: a UI gesture in `components/` → `store/editor` command → the
  **same** `timeline/` op → same pipeline → same preview refresh.
- **Preview vs export**: `preview/scene.ts` (`buildScene` → WebGL, live) and
  `timeline/render.ts` (`buildRenderCommand` → ffmpeg, export) are two renderers of
  one timeline, kept aligned by the parity tests and the **shared `anim.ts`**.

---

## 14. Testing

Tests are **co-located** (`*.test.ts` next to each module); the real-ffmpeg goldens
are `*.e2e.ts` selected by `vitest.smoke.config.ts`. The suite spans the co-located
unit tests (95% gate), the `applyOp` **property fuzzer** (`invariants.property.test.ts`),
the **validator-input fuzzer** (`fuzz.property.test.ts` — hurls structured + blind
garbage at every untrusted-input guard: `validateTimeline`, `normalizeTimeline`, the
clamps, `parseProbe`, `applyOp` on a corrupt timeline.json, and dispatch for every tool;
strict contract = pure guards never throw, dispatch always resolves to `{ ok:boolean }`),
structural render goldens (`render.test.ts`), the preview↔render parity tests, the
contract conformance + tool-dispatch harness, the **agent-loop integration test**
(`loop.integration.test.ts` — scripted multi-round build/undo/approval flows), and the
measured render/audio **e2e goldens** (gated on pre-push when ffmpeg is present). The
full testing strategy is in the **backend repo's `docs/ARCHITECTURE.md` §14**.

**Mutation testing** (Stryker, `stryker.config.mjs`) mutates `src/timeline/**` +
`src/tools/**` with the vitest runner (per-test coverage) to surface loosely-asserted
logic. Read `timeline/**` as the signal; the IO-heavy `tools/**` mutants mostly survive
by design (their real coverage is the e2e lane the unit runner doesn't execute).
**Baseline**: `clamp.ts` scores **94.96%** (residual survivors are equivalent mutants);
the full scope is ~12.6k mutants (~3.5 h), so it's a run-occasionally tool, not a
per-commit gate. Scope it with `--mutate <file>`; consider `--ignoreStatic` (≈11% static
mutants take ≈82% of the wall-clock). Reports land in `reports/mutation/` (gitignored).

**Model eval** (`src/eval/`, `npm run eval` — manual/nightly, gated by `vitest.eval.config.ts`)
drives natural-language prompts × seeded projects through the **live model** (/inference) + the
real agent loop + real timeline tools, scoring Tier 0 (result safety) + Tier 1 (expected
geometry) and mining **friction signals** (failed calls, undeclared-param attempts = the
missing-feature backlog, workarounds, silent corruption) that fire even on passing tasks. $10
budget guard; models gpt-5.4 + gpt-5.4-mini; JSON + md scorecard in `reports/eval/` (gitignored).
Non-gating. An **offline transcript miner** (`npm run mine`, "Mode A") replays recorded sessions'
`.artdaddy/transcript.json` through the same friction analyzer (zero spend, no media) →
`reports/eval/transcript-mining.md` — it mined the real t001–t009 into the recurring-bug report.
Full contract in the backend repo's `docs/ARCHITECTURE.md` §14.

**Run**: `npm test` (unit) · `npm run test:coverage` (unit + gate) · `npm run smoke`
(e2e, needs ffmpeg) · `npm run test:all` (both) · `npm run mutation` (Stryker, slow —
or `npx stryker run --mutate <path>`) · `npm run eval` / `npm run eval:mini` (model eval,
needs the server + live model) · `npm run mine` (offline transcript friction report) ·
`npx vitest run <path>` (one file). `test:all` is the practical "run everything"; mutation +
eval are slow/paid/manual and stay out of it.

**Coverage map** (our logic only; `*.d.ts`/generated + the Tauri-glue seams — `tauri.ts`,
`command.ts`, `context.ts`, `dataRoot.ts`, `host.ts`, `lib/desktop.ts` — are excluded from the
gate by design). **Well covered** (95% gate + both fuzzers): `timeline/**` (the core algebra),
`tools/**` logic (incl. the new `coordinator`), `contract/**`, `agent/**`, `store/**`, `api/**`,
and the **pure** preview layer (`resolve`, `scene`, `parity`, `protocol`, `transport`,
`previewClient`, `text`, `waveform`). **Not unit-covered** (leans on parity + e2e, or manual
only): the **browser-only render runtime** — `renderer.ts` (WebGL2), `videoSource`/`audioEngine`
(WebCodecs), `previewWorker`, `mediaProxy`, `usePlayback`, and the canvas components
(`PreviewCanvas`, `SourceMonitor`, `ClipWaveform`, `ClipThumbnail`); and the **Tauri-native**
surface (dialogs, external-media preview, fs/asset scopes, thumbnail-capture) — manual
`npx tauri dev` only.

---

## 15. Build & run

- **Dev**: `npm run dev` (Vite). **Type-check**: `npm run typecheck` (`tsc --noEmit`).
- **Build**: `npm run build` (`tsc --noEmit && vite build`).
- **Sidecars**: `npm run fetch:sidecars` / `build:sidecar` (ffmpeg/yt-dlp).
- **Release**: `npm run release` (sidecars + browser bundle + `tauri build`).
- **Codegen**: `npm run codegen` (pull `/contract/tools` → `tools.snapshot.json`).
- **Git hooks**: `.githooks/pre-push` runs build + unit tests, then the e2e goldens
  when ffmpeg is present (`git config core.hooksPath .githooks` after a fresh clone).

## 16. Shipping: distribution & auto-update

The desktop app **updates itself**. On launch `UpdateBanner` calls
`src/update/updater.ts`, which invokes two RUST commands (`check_for_update` /
`install_update` in `src-tauri/src/lib.rs`); the Rust side owns the whole
check → download → verify → install → relaunch cycle via `tauri-plugin-updater`.

**Why Rust and not the updater JS package:** npm's registry is unreachable from the
build machine (SNI filtering), so a new JS dependency cannot be installed. Driving
the plugin from Rust needs none — `invoke` comes from `@tauri-apps/api`, already
present. Keep it that way unless the registry situation changes.

### The pieces

| Piece | Where | Notes |
| --- | --- | --- |
| Version | `src-tauri/tauri.conf.json` `version` | What the updater COMPARES. Mirror it in `Cargo.toml` + `package.json`. |
| Public key | `tauri.conf.json` `plugins.updater.pubkey` | Committed. Every update is verified against it. |
| Private key | `~/.tauri/artdaddy-updater.key` | **Never committed.** No password. `tauri build` reads only `TAURI_SIGNING_PRIVATE_KEY` (the key's CONTENT); `TAURI_SIGNING_PRIVATE_KEY_PATH` works for `tauri signer sign` only. |
| Manifest | `https://artdaddy.app/updates/latest.json` | Static JSON served by the landing site. Deliberately on a domain we OWN: the endpoint is compiled in and polled forever by every install, and a vendor hostname cannot be redirected when we leave it. |
| Artifacts | `src-tauri/target/release/bundle/nsis/` | `artdaddy_<v>_x64-setup.exe` + `.exe.sig`. Tauri v2 signs the INSTALLER itself — no separate `.nsis.zip` (that was v1). |
| Host | GitHub Releases, `art-daddy/artdaddy` | Version-less asset names so `/releases/latest/download/<name>` is stable. Free and unmetered while the repo is public. The manifest's URLs are data — moving the artifacts never touches an installed client. |

### Invariants

1. **The signing key is a one-way door.** Only builds signed by the key matching the
   committed `pubkey` are accepted. Lose it and every installed app must be manually
   reinstalled to ever update again. Back it up offline.
2. **Bump the version or the release is invisible.** The updater compares against
   `tauri.conf.json`; an unbumped build is silently ignored by clients.
3. **Publish `latest.json` LAST.** It is the switch that makes a release live — upload
   the bundle first, or clients get handed a URL that 404s. Write it **without a BOM**
   (Windows PowerShell's `-Encoding utf8` adds one and the Rust parser rejects it), and
   verify by PARSING the published URL rather than checking for a 200.
4. **A failed update CHECK must never surface as an error** (`updater.ts` resolves it to
   `null`): an unreachable release host must not stop someone using the app they already
   installed. `installUpdate` deliberately does the opposite and propagates — the user
   asked for that one, so silence would leave a dead button.
5. **Install is always user-initiated.** It relaunches the app; nothing restarts under an
   unsaved edit.

### Traps already paid for

- **`tauri build` ignores `TAURI_SIGNING_PRIVATE_KEY_PATH`.** The variable exists and
  `tauri signer sign -f` honours it, so it looks right; the build reads only
  `TAURI_SIGNING_PRIVATE_KEY` (the key's content). Set the path and the build writes the
  installer, then exits 1 with "A public key has been found, but no private key" — the
  same unsigned dud as the prompt trap below, from a different cause. Cost one 0.2.2 build.
- **`src-tauri/resources/artdaddy-browser.mjs` is a BUILD ARTIFACT.** `npm run build:sidecar`
  (esbuild) generates it from `scripts/artdaddy-browser.mjs`; nothing in `tauri build`
  regenerates it. Since `npm run release` cannot run here, that step is easy to skip — and
  then the release ships the OLD browser behaviour while the repo shows the fix. Caught
  only because the staged file was 6.9 KB against a 10.4 KB source. Grep the STAGED file
  for a string from your change before building.
- **The signing `Password:` prompt is UNCONDITIONAL.** The signer prints "Signing without
  password" and then asks anyway — it does not depend on the key having one, and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=''` does not suppress it (Windows drops empty env
  vars, so the child never sees the variable). It blocks AFTER the installers and BEFORE
  the signatures, so an unattended build yields a plausible `.exe` with no `.sig`: a
  release that installs fine and can never update anyone. Three builds died this way.
  A bare Enter is the correct answer; a fully non-interactive build would need a key with
  a REAL password, and regenerating the keypair is a one-way door (see invariant 1).
- **A build that died before signing does NOT need rebuilding.**
  `npx tauri signer sign -f <key> <installer.exe>` produces the `.sig` in seconds. Prefer
  it over a ~20-minute rebuild, and prefer `--bundles nsis` when rebuilding at all — the
  MSI is 277 MB the updater never uses.
- **`npm run release` cannot run end-to-end here.** `scripts/bundle-browser.mjs` shells
  `npm install --no-save playwright`, which the blocked registry rejects. The staged
  `src-tauri/resources/` + `binaries/` from a previous run are reused and `npx tauri build`
  is invoked directly. Re-staging sidecars needs a machine with registry access.
- **Updates ship the WHOLE bundle** (~200 MB), because sidecars are bundled. See
  `IDEA-UPDATE-001` in `../Akaru/ideas.md` for the split, and the whisper-stub guard that
  has to move with it.

Step-by-step release commands live in the README (`Releasing an update`).
