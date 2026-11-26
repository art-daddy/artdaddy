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
`{ delta }`, `{ wait }`, `{ ping }`, `{ result }`, `{ cut }` (the connection drops) and `{ hang }`
(open and silent until Stop). The result shape is the app's own `RoundResultDTO`
(`src/agent/types.ts`), so a reply cannot drift from what the app reads.

In a test, queue the replies in the order the rounds will come. A reply can also be a function of
the round it answers, to read the tool results the app sent back:

```ts
qa.server.script(addTrack("video"), (round) => addClips(ref, 90, String(round.toolResults[0].result.track_id)));
```

## Waits

`lib/waits.ts` records the waits a person feels (`measure`, `startTimer`, `record`) under names like
`agent: first visible reply [chromium]`. It has the same calls as the shared helper `e2e/lib/timing`
being built for every QA lane; moving to it is a change of one import.
