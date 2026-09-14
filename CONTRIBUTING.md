# Contributing

Thanks for taking the time. A few things worth knowing before you open a pull request.

## Contributor License Agreement

Every contributor must accept the CLA before their first pull request can be merged.
A bot will comment on your PR with a link; accepting takes one click and applies to
all your future contributions.

The CLA asks you to grant us a broad license to your contribution, including the right
to relicense it. You keep the copyright to what you write. We ask for this so the
project's licensing can change in future without having to track down every past
contributor — a situation that has left other projects permanently stuck.

## Getting set up

```bash
npm install
cp .env.example .env      # then read the comments in it
npm run dev               # web app only
npx tauri dev             # the real desktop app
```

`.env.development` is loaded only by the dev server, never by a build. If you develop
against the deployed API rather than a local one, use the proxy form described in
`.env.example` — the deployed server's CORS allowlist deliberately excludes
`http://localhost:5173`, so calling it directly fails as "Failed to fetch".

## Before you push

```bash
npm test                  # unit suite
npx tsc --noEmit          # types
cargo test --locked       # in src-tauri/
npm run smoke             # only if you touched rendering; needs real ffmpeg
```

A pre-push hook runs the build, the unit suite and the cargo tests, and refuses the
push if any fail. Please don't bypass it with `--no-verify`; if a test is wrong, fix
the test in the same change and say why.

## What we look for in a change

This codebase has a specific attitude to tests, learned the hard way: a test should be
able to **fail** if the feature stops working.

- Assert the **outcome**, not the instruction. If the code writes a file, inspect the
  file — not the command that was supposed to produce it. Thirty-eight caption tests
  once asserted the ffmpeg filtergraph contained `ass=...` while exports shipped with
  zero caption pixels, and the suite stayed green.
- Assert a **rule that survives a rewrite**, not a restatement of the implementation.
- Challenge the **failure direction**: the opposite ordering, the cancelled case, the
  input that isn't in the catalog.
- For time-varying behaviour (animation, transitions), sample two points and assert
  they differ. A single frame cannot tell "rendered" from "inert".

`docs/ARCHITECTURE.md` explains how the pieces fit together. Two conventions that
surprise people:

- **Media is addressed by reference, never by filesystem path.** Tools take a
  `media_ref` (a library asset) or a `clip_id` (something already on the timeline).
  A local file becomes usable by being imported first.
- **Units follow the address space.** A `clip_id` means project frames at the canvas
  fps; a `media_ref` means seconds in the source. Never make the caller do fps math.

## Reporting a security issue

Please don't open a public issue. Email the address in the README and give us a
reasonable window to ship a fix before disclosing.
