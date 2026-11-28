# Captions and transcription: browser tests on a speech stand-in

These tests do what a person does with captions and speech (ask the assistant for captions, read a
clip's words, wait for a long transcription, cancel it, retry a failed one, meet the speech model's
first download) and judge what the person gets: the saved project (`internals/timeline.json`), what
the app told the model, what it asked the speech engine, and the screen. No test reaches a model, a
vendor or the internet.

```
npm run e2e:ui -- e2e/ui/captions-and-transcription
```

## How it works

They run on the agent lane's rig (`../agent-and-models/lib`: the fake ArtDaddy server with scripted
model replies, and the QA shell that stands in for the desktop side) plus one stand-in of their own,
`lib/speech.ts`:

- **The job supervisor and the speech engine.** In the app, whisper-cli runs as a job of the app
  process (`src-tauri/src/jobs.rs`). The stand-in answers the page's job commands (`jobs_submit`,
  `jobs_list`, `jobs_kill`...) and raises the job events (`jobs:changed`, `jobs:stdout`) the way the
  Rust side does. Everything before and after the engine is real: the page plans the run, the shipped
  ffmpeg extracts the clip's sound, the page reads the JSON the engine wrote, keeps the words, cuts and
  places the captions.
- **What the engine says.** A whisper-cli job writes, at the path its `-of` names, what the REAL engine
  wrote for this clip (`fixtures/speech/spoken.whisper.json`), cut to the stretch of sound the app
  handed it, with times from that stretch's start, as the engine writes them. So a trim, a window or a
  clip placed later is mapped by the app, not by the test.
- **How a launch ends** is queued per test: `words` (the default), `silence`, `fail` (an exit code and
  stderr) or `hold` (it keeps running until `release()` or a Cancel). Every launch is recorded
  (`speech.launches`: arguments, the stretch, how it ended), so a test checks what the app ASKED the
  engine (the language, the window), not only what it showed.
- **The speech model** is "on disk" as the app checks it: an empty file per manifest entry, the size
  the manifest says (the shell's `stat` answers it) and a checksum marker that matches. `model: false`
  leaves it off, for the download scenarios, whose two download places are answered by `page.route`.

The fixtures are made by `fixtures/make-fixtures.mjs` from the speech lane's recording
(`src/tools/__fixtures__/speech/spoken.ogg`, Windows' own voice): a 12 s clip, red then green then
blue, with three spoken sentences, and the engine's real output for it (the shipped whisper-cli and the
speech model on the lab PC). Run it again only when the recording or the engine changes.

What this lane does not cover: the real engine and model (the speech lane, `npm run smoke:speech`, and
the real-app run in `e2e/desktop/captions-and-transcription/`), a finished 465 MiB download (the
by-hand script `e2e/byhand/captions-and-transcription/first-run.md`), and the exported pixels
(`src/tools/captionsWholePath.e2e.ts` and `src/timeline/caption.smoke.e2e.ts` in the export suite).

## Which engine

Tests of what the person sees and clicks (the captions on the timeline and one Undo, the status bar's
chip and Cancel, a failed transcription and Retry, the model download's card, the Inspector, the
Delete key) run in Chromium and WebKit. Tests of tool logic that runs the same in every engine (what
the app asks the speech engine, the times it computes, what it tells the model) call
`chromiumCovers()` and run in Chromium only, to spare CI's shared macOS runners.

## Waits

Each wait a person feels is recorded with the shared helper (`e2e/lib/timing`), named
`captions: <what the person waits for> [<browser>]`. With the speech stand-in the times are the app's
own work around the engine, not the engine's.
