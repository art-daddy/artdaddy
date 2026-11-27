# Agent and models: browser tests on scripted replies

These tests drive the assistant pane the way a person does (type, Send, Stop, Continue, Try again,
the model picker, Allow or Deny) and judge what the person gets: the screen, the saved project
(`internals/timeline.json`, `transcript.json`, `library.json`) and what the app sent to the server.
No test reaches a real model or any paid service.

Run them like the rest of the browser lane:

```
npm run e2e:ui -- e2e/ui/agent-and-models
```

## How it works

Two stand-ins, both started fresh for every test by the fixture in `lib/qa.ts`:

- **A fake ArtDaddy server** (`lib/fakeServer.ts`): a real HTTP server on `127.0.0.1` (a port the
  system picks). It answers the routes the app calls at start (session renewal, `/auth/verify`,
  `/usage`, `/client/compatibility`, telemetry) and answers each model round
  (`POST /inference/stream`) with the next scripted reply, in the server's own SSE format. The app
  is pointed at it through its own runtime server setting (`artdaddy.api_base`). Because the socket
  is real, a slow first token, a connection cut mid-answer and the app hanging up on Stop behave as
  they do on a network. Every request is kept (`qa.server.seen`, `modelRounds()`, `requests(path)`),
  so a test can check what the app asked for. A model round with no reply scripted fails the test:
  an extra round (a duplicate, a retry nobody asked for) cannot pass unnoticed.
- **A QA shell** (`lib/qaShell.ts`): the desktop app's native side, installed as
  `window.__TAURI_INTERNALS__` before the app loads. Without it no project can be opened in a
  browser. Files live in a real folder under the test's output folder (the app sees it as
  `/qa-home/...`), `sidecar_run` runs the shipped ffprobe/ffmpeg from `src-tauri/binaries`, the OS
  file dialog answers what the test queued (`qa.shell.pickFiles`), the keychain holds a saved
  session, and the internet is cut off (only the fake server answers). An unknown native command is
  refused and listed in the test's `qa-shell.json` attachment.

What the shell does not cover: the real Rust commands, WebView2 and WKWebView themselves, real OS
dialogs and the MCP server. Those belong to `e2e/desktop`.

Do not point a real dev build at the fake server. A dev build reads the PC's own keychain entry
(`com.artdaddy.app`), which on a shared PC is the installed app's saved session. The fake server
answers any token that is not the shell's own `qa-refresh-...` with "unavailable" (which never
rotates or clears it) and never records it, but it is a stand-in for the browser lane, not for the
real app.

## Adding a scripted reply

One small file in `fixtures/replies/` that exports a function returning a `Reply`, built with the
helpers in `lib/reply.ts`:

```ts
// fixtures/replies/askForMusic.ts
// The model asks for a generated music bed (a paid call, so the default mode asks first).
import { callTools, type Reply } from "../../lib/reply";

export function askForMusic(prompt = "calm piano, 30 seconds"): Reply {
  return callTools([{ name: "generate_music", arguments: { prompt } }], "I'll make a music bed.");
}
```

The helpers: `say(text, { gapMs, firstTokenMs, usage, refusedFrames })` streams words then the
result; `callTools(calls, prose)` asks for tool calls; `httpAnswer(status, detail)` answers an HTTP
error the way the server does (`{"detail": ...}`); `stream(note, ...steps)` writes any sequence of
`{ delta }`, `{ wait }`, `{ ping }`, `{ result }`, `{ cut }` (the connection drops), `{ hold }` (the
line stays open, carrying only keepalive comments, until the test calls `qa.server.release()`) and
`{ hang }` (the same, never released: open until Stop). The result shape is the app's own
`RoundResultDTO` (`src/agent/types.ts`), so a reply cannot drift from what the app reads.

In a test, queue the replies in the order the rounds will come. A reply can also be a function of
the round it answers, to read the tool results the app sent back:

```ts
qa.server.script(addTrack("video"), (round) =>
  addClips(ref, 90, String(round.toolResults[0].result.track_id)),
);
```

## Wait for events, never for a time

These tests run on Chromium and WebKit on four systems, and a pause that suits one is a red run on
another. So a test waits for a state the app shows or an event a stand-in saw, never for a number
of milliseconds:

- What the server has sent: each model round in `qa.server.seen` keeps the answer's text written so
  far (`written`) and whether its line is held open (`holding`). A pause in a stream is a `hold` (or
  a `hang`) that carries keepalive comments, as the real server's line does: in CI, Linux WebKit
  showed two words of seven for 15 s once a stream went silent, so a silent pause can hide words the
  server has already sent.
- What the shell ran: `qa.shell.sidecarRuns` lists each ffmpeg/ffprobe run with its arguments and
  whether it is `running`, was `killed` or has `ended`.
- What the app saved: read it with the rig's helpers (`savedTranscript`, `savedMessages`,
  `savedAnswers`, `savedTimeline`...) inside `expect.poll`. The shell makes the app's file changes
  and these reads take turns, so a read never meets half a file.
- "Nothing was sent by itself": script the next reply only just before the click that should send
  it. A round the app sends on its own then finds no reply and fails the test, whenever it comes.

A test that shows a known bug is marked with `knownBug(issue, shows)` from `lib/qa.ts`, not with
`test.fail`: `shows` must match the error the test fails with, so a failure for any other reason
(a timeout, a broken step) is reported as a failure instead of passing as "the bug is still there".
When the bug is fixed the test passes, which Playwright reports as a failure until the mark goes.

## Waits

`lib/waits.ts` records the waits a person feels (`measure`, `startTimer`, `record`) under names like
`agent: first visible reply [chromium]`. It has the same calls as the shared helper `e2e/lib/timing`
being built for every QA lane; moving to it is a change of one import.
