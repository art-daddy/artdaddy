# ArtDaddy client

Desktop editor for ArtDaddy — a React app shipped in a Tauri shell (WebView2) that
talks to the ArtDaddy FastAPI server over REST + SSE (streaming agent turns) +
WebSocket (a proxy that runs tools locally). It's the UI for the whole product:
projects, the chat/agent, a manual timeline editor, and a live WebGL preview.
The same bundle can also run as a plain web app in a browser, but desktop is the
primary target (local files, ffmpeg/yt-dlp sidecars, the asset protocol for media).

## Prerequisites

- Node 18+ (tested on Node 20)
- The ArtDaddy API server running (default `http://127.0.0.1:8000`):
  `python -m src.autoshot.server` in the backend repo.
- For the desktop build: the Rust toolchain + Tauri v2 system deps
  (WebView2 on Windows). Not needed for the web dev server.

## Setup

    npm install
    copy .env.example .env      # adjust VITE_API_BASE_URL if the server is elsewhere
    npm run codegen             # pulls typed API + contract from the running server
    npm run dev                 # http://localhost:5173

## Scripts

- `npm run dev` — Vite dev server (web preview at http://localhost:5173)
- `npx tauri dev` — run the desktop app (Vite + the Tauri shell)
- `npm run codegen` — regenerate `src/api/schema.d.ts` + `src/contract/*.json` from the running server (single source of truth)
- `npm run build` — typecheck + production build
- `npm test` / `npm run test:coverage` — unit tests (Vitest) / with the coverage gate
- `npm run release` — fetch/build sidecars + bundle browser + `tauri build`

## Releasing an update

The app self-updates: on launch it fetches the manifest in
`src-tauri/tauri.conf.json` → `plugins.updater.endpoints` and offers the user a
restart if a newer **signed** build is there. Users never reinstall by hand.

The check/download/install runs in Rust (`src-tauri/src/lib.rs`, commands
`check_for_update` / `install_update`); `src/update/updater.ts` just invokes them.
There is no updater JS package on purpose — npm's registry is unreachable from this
machine, and the Rust path needs no new dependency.

### Keys

| | |
| --- | --- |
| Private key | `~/.tauri/artdaddy-updater.key` — no password, **never commit**, back up offline |
| Public key | committed in `tauri.conf.json` → `plugins.updater.pubkey` |

**This is a one-way door.** Every installed app only accepts builds signed by the key
matching the committed `pubkey`. Lose the private key and the only way to ship again
is to make everyone reinstall. To regenerate from scratch (invalidates all installs):
`npx tauri signer generate --ci -w $env:USERPROFILE\.tauri\artdaddy-updater.key`.

### Steps

**1. Bump the version** in `src-tauri/tauri.conf.json` (mirror it in `Cargo.toml`,
`package.json`, `package-lock.json` and `mcpb/manifest.json`). The updater compares against
it — an unbumped build is invisible. `src/mcp/bundle.test.ts` fails on the mcpb one and
`src/brand.drift.test.ts` on the rest, so the suite catches a half-done bump; `Cargo.lock`
updates itself on the next build.

**2. Build, signed.** Set the key env var and expect to answer one prompt.

It must be `TAURI_SIGNING_PRIVATE_KEY` — the key's **content**. `tauri build` ignores
`TAURI_SIGNING_PRIVATE_KEY_PATH`; only `tauri signer sign` reads that one. Point at the
path and the build writes the installer and then exits 1 with "A public key has been
found, but no private key" — the same unsigned dud as below, from a different cause.

The `Password:` prompt is **unconditional** — the signer prints "Signing without
password" and then asks anyway. It is not conditional on the key having one, and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD=''` does not suppress it either (PowerShell drops
empty environment variables, so the child never sees it). The key has no password, so a
bare Enter is the right answer.

This matters because of *where* it stops: **after** the installers, **before** the
signatures. A build left unattended produces a plausible `.exe` with no `.sig` — a
release that installs fine and can never update anyone. It killed three builds here
before this was understood.

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content "$env:USERPROFILE\.tauri\artdaddy-updater.key" -Raw).Trim()
npx tauri build --bundles nsis    # nsis is the only bundle the updater uses
# at "Password:" press Enter
```

**If the build died before signing, do NOT rebuild** — sign the installer you already
have (seconds, not ~20 minutes):

```powershell
npx tauri signer sign -f "$env:USERPROFILE\.tauri\artdaddy-updater.key" `
  "src-tauri\target\release\bundle\nsis\artdaddy_0.2.1_x64-setup.exe"
# same unconditional prompt; press Enter
```

A fully non-interactive build needs a key that has a REAL password (a non-empty env var
survives). That means regenerating the keypair, which is a one-way door — every existing
install stops accepting updates — so it is a deliberate decision, not a quick fix.

Then **confirm the signed artifacts exist** — installers alone are not a release:

```powershell
Get-ChildItem src-tauri\target\release\bundle\nsis\*0.2.0*
# expect: artdaddy_0.2.0_x64-setup.exe  AND  artdaddy_0.2.0_x64-setup.exe.sig
```

Tauri v2 signs the INSTALLER itself; there is no separate `.nsis.zip` (that was v1).
The same `.exe` serves both a first-time install and an update.

**3. Upload the bundle FIRST**, then publish the manifest:

```powershell
$v = "0.2.0"; $b = "src-tauri\target\release\bundle\nsis"; $acct = "artdaddyreleases"
$key = az storage account keys list -n $acct -g ArtDaddyAI --query "[0].value" -o tsv
az storage blob upload --account-name $acct --account-key $key -c updates --overwrite `
  -f "$b\artdaddy_${v}_x64-setup.exe" -n "artdaddy_${v}_x64-setup.exe"

$sig = (Get-Content "$b\artdaddy_${v}_x64-setup.exe.sig" -Raw).Trim()
$json = ([ordered]@{ version = $v; notes = "…"; pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{ "windows-x86_64" = [ordered]@{ signature = $sig
    url = "https://$acct.blob.core.windows.net/updates/artdaddy_${v}_x64-setup.exe" } }
 } | ConvertTo-Json -Depth 6)
# NO BOM: Set-Content -Encoding utf8 writes one in Windows PowerShell, and the Rust
# JSON parser rejects it -> the app fetches 200 OK and then fails to read the manifest.
[System.IO.File]::WriteAllText("latest.json", $json, (New-Object System.Text.UTF8Encoding($false)))
az storage blob upload --account-name $acct --account-key $key -c updates --overwrite -f latest.json -n latest.json --content-type application/json
```

`latest.json` goes **last** — it is the switch that makes a release live, so a
half-uploaded bundle can never be handed to clients. `signature` is the *contents* of
the `.sig` file, not a path.

**4. Verify** the way the app does — a 200 is not enough, it has to PARSE:

```powershell
$r = Invoke-WebRequest -UseBasicParsing https://artdaddyreleases.blob.core.windows.net/updates/latest.json
([System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray()) | ConvertFrom-Json).version
```

### Caveats

- **`npm run release` cannot complete on this machine.** `scripts/bundle-browser.mjs`
  shells `npm install --no-save playwright`, which the blocked npm registry rejects.
  Workaround: reuse the already-staged `src-tauri/resources/` + `binaries/` and run
  `npx tauri build` directly. Re-staging sidecars needs registry access.
- **`src-tauri/resources/artdaddy-browser.mjs` is a build artifact, not the source.**
  `npm run build:sidecar` (esbuild, no registry needed) generates it from
  `scripts/artdaddy-browser.mjs`, and `tauri build` does not. Skipping it after editing the
  script ships the OLD browser behaviour while the repo shows the fix. Run it, then grep
  the STAGED file for a string from your change before building.
- **`src-tauri/resources/artdaddy.mcpb` is the same trap**, and it bit 0.12.0. Only
  `npm run build:mcpb` regenerates it; `tauri build` embeds whatever is already staged. Since
  the workaround above skips `npm run release`, BOTH staged resources have to be rebuilt by
  hand first — 0.12.0 shipped an MCP bundle still declaring 0.11.0 (cosmetic: the bundle is a
  loopback proxy and its code was unchanged, so only the version Claude Desktop displays was
  wrong). Run `npm run build:sidecar && npm run build:mcpb` before `npx tauri build`, and
  confirm the staged mtimes moved.
- **Host:** Azure Blob `artdaddyreleases` / `updates` (public read). Not GitHub Releases —
  both repos are private, so release assets need a token, and shipping one inside a
  desktop app would leak repo access.
- **Updates are a full ~200 MB download** because sidecars are bundled. See
  `IDEA-UPDATE-001` in `../Akaru/ideas.md`.
- **0.1.0 predates the updater**, so anyone on it must install 0.2.0 by hand once.

## Testing

Suites are **co-located** (`*.test.ts(x)` next to each module); which suite a file
belongs to is decided by its name + the config that runs it. Full strategy in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §14.

| Suite | Command | Notes |
|---|---|---|
| Unit + component | `npm test` | Fast (happy-dom). Includes the property/fuzz + integration + contract tests below. |
| Unit + coverage gate | `npm run test:coverage` | Adds the **95%** line/statement gate. |
| Property / fuzz (fast-check) | *in `npm test`* | `timeline/invariants.property.test.ts` (apply_op invariants) + `fuzz.property.test.ts` (validator crash-safety). |
| Contract conformance | *in `npm test`* | client tool registry == served `/contract/tools`; `contract/timeUnits.test.ts` drift canary. |
| Integration | *in `npm test`* | `agent/loop.integration.test.ts` + `contract/dispatch.integration.test.ts` (no live model). |
| E2E goldens (real ffmpeg) | `npm run smoke` | `*.e2e.ts` measured pixels/dB. Needs `ffmpeg`+`ffprobe`; network tools need `ARTDADDY_SMOKE_NET=1`. |
| Real audio (real browser) | `npm run test:audio` | Runs the production meter graph in an `OfflineAudioContext` in headless Chromium over raw CDP. No Playwright, no new dependency. ~5s. |
| Mutation | `npm run mutation` | Stryker over `timeline/**`+`tools/**` → `reports/mutation/`. Slow; scope with `npx stryker run --mutate <path>`. |
| Model eval (live model) | `npm run eval` · `npm run eval:mini` | Via `/inference`; server up + metering OFF. Non-gating. |
| Transcript mining (offline) | `npm run mine` | Replays recorded sessions through the friction analyzer; zero spend. |
| One file | `npx vitest run <path>` | — |

**Run everything (practical):** `npm run test:all` = unit **then** e2e goldens. Mutation +
eval are slow / paid / manual and aren't in it. Server tests are a separate suite in the
backend repo (`pytest`) — no single command spans both. The `.githooks/pre-push` hook runs
`npm run build && npm test` (+ the e2e goldens when ffmpeg is present).

**Coverage** (our logic only — generated/type-only + Tauri-glue seams are excluded on purpose):
- **Well covered** (95% gate + both fuzzers): the whole `timeline/**` algebra (model, apply_op,
  edit/ops/props/placement, clamp/validate/normalize, keyframes/anim, render-command builder,
  pack), `tools/**` logic (registry/dispatch, library/import/store/**coordinator**/project,
  media/style/gen arg-building), `contract/**`, `agent/**`, `store/**`, `api/**`, and the
  **pure preview** layer (resolve, scene/geometry, parity, protocol, text, waveform).
- **Needs coverage** (our logic, currently only indirect or manual): the **browser-only
  preview/render runtime** — `preview/renderer.ts` (WebGL2 compositor), `videoSource`/
  `audioEngine` **decode + scheduling** (WebCodecs; its metering graph IS covered, by
  `npm run test:audio`), `previewWorker`, `mediaProxy` (proxy/poster), `usePlayback`,
  and the canvas components (`PreviewCanvas`, `SourceMonitor`, `ClipWaveform`, `ClipThumbnail`)
  — verified only via the preview↔render **parity** tests + **e2e goldens**, not unit tests;
  and the **Tauri-native** features (file/save dialogs, external-media preview, fs/asset
  scopes, thumbnail-capture write) have **no automated coverage** (manual `npx tauri dev`).

## Layout

- `src/api` — REST client, POST-SSE reader, domain types, generated OpenAPI schema
- `src/contract` — tool catalog + timeline schema pulled from the server
- `src/platform` — web/tauri capability abstraction (one bundle, both targets)
- `src/store` — Zustand stores (projects, chat, editor)
- `src/timeline` — timeline model + edit operations (frames, clips, tracks)
- `src/preview` — WebGL2 compositor + WebCodecs decode, run on a Web Worker
- `src/tools` — client-side tool runtime (fs store + shell runner over the WS proxy)
- `src/lib` — desktop/web helpers (file import, file tree)
- `src/components` — menu bar, sidebar, chat, stage (preview + timeline editor)

On desktop the client reads/writes the co-located project files directly (fs),
falling back to the server's HTTP endpoints on web. The timeline is edited
locally with a live worker-driven preview; rendered exports come from the server.
