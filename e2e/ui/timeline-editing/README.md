# Timeline editing: browser tests of the gestures people use most

These tests edit a real project in a real browser the way a person does (drag, trim handles, keys,
right-click menus, the Edit menu, the Inspector, a drag from the Library) and judge what the person
gets: the saved `internals/timeline.json`, read from disk after every gesture, and what the screen
shows. Each edit is also undone: one gesture must be one Undo step that gives back exactly the
document it changed.

```
npm run e2e:ui -- e2e/ui/timeline-editing
```

## How it works

- **The app's native side and server** are the agent lane's stand-ins (`../agent-and-models/lib`):
  the QA shell keeps the project on a real folder and runs the shipped ffprobe/ffmpeg, and the fake
  server answers the app's start-up calls and, where a test asks the agent for a title, scripted
  replies. No test reaches a model or any paid service.
- **Media** comes in through File > Import Media… (the OS dialog is answered with copies of the tiny
  files in `fixtures/media`: a 2 s picture-only video, a 2 s video with sound, a 2 s tone, a still).
- **Setup that is not under test** (a clip at an exact frame, the zoom) goes through the editor's own
  commands, the dev-only seam the real-app sweep uses (`window.__artdaddyTest`, `src/main.tsx`). The
  rig zooms to four pixels a frame and turns snapping off, so a pointer aimed at a frame lands on it;
  the snapping test turns it back on.
- **Positions** are worked out from a drawn clip against its saved frames (`lib/timeline.ts`,
  `xOf`), never from a copy of the app's own pixel arithmetic.
- **The app's questions** (delete a track with clips?) are answered per test: `answerNextDialog`
  queues the button the dialog returns, and `dialogsAsked` reads what was asked.
- **One engine per system:** each test runs on the engine the desktop app ships there (Chromium,
  as WebView2, on Windows; WebKit on macOS and Linux) and is skipped on the other, which no user
  has; CI's macOS minutes are scarce. `QA_TIMELINE_ALL_ENGINES=1` runs both.

## What is covered

| File                | Scenarios                                                                                                                                                                                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `place.spec.ts`     | drag from the Library onto a lane (the landing frame shown while dragging is the saved one); a video with sound brings its sound, linked; a sound file on the audio lane; a sound file never lands on a video lane; a drop outside the timeline places nothing; Undo of the first drop (expected failure)            |
| `move.spec.ts`      | drag along a lane; a linked pair moves together; to another video track, never onto a sound lane; overwrite and Undo; Alt+drag copies; Alt+arrow nudges; snapping on and off; a press is not an edit; a drag that changes nothing (expected failures)                                                                |
| `trim.spec.ts`      | end and start handles; both stop at the ends of the footage; a still stretches; Shift+drag ripple trim; Q and W to the playhead                                                                                                                                                                                      |
| `split.spec.ts`     | Ctrl+K at the playhead; the razor tool; right-click and Edit menu; a video with sound splits with its sound                                                                                                                                                                                                          |
| `delete.spec.ts`    | Delete leaves a gap; Shift+Delete and right-click Ripple delete close it; click a gap and Delete; trailing space is not a gap; a video's sound goes with it; ripple across sync-locked tracks, and a released track stays                                                                                            |
| `tracks.spec.ts`    | +V +A +T; hide, mute, solo; lock refuses move, trim, split and delete; a lock against the agent's edits (expected failure); delete an empty track; delete a track with clips asks first; restack by dragging a header                                                                                                                                                     |
| `keys.spec.ts`      | click, Shift+click, Esc; Ctrl+A then Delete; a box drawn over empty lanes; copy and paste; Ctrl+D; Shift+E; keys typed in the chat box never edit the timeline; after typing in the chat box, a click on a clip moves the keyboard (expected failure); Home, End, arrows; zoom and Fit; Edit > Undo and Redo, Ctrl+Y |
| `inspector.spec.ts` | a transition chosen in the Inspector and resized on the timeline; an opacity curve keyed in clip frames; the fade-in knob; an agent's title moved and trimmed by hand; title words in the Inspector (expected failures); typing speed and Undo in the Text box                                                       |
| `persist.spec.ts`   | a moved and trimmed clip after the app restarts                                                                                                                                                                                                                                                                      |

Tests that show a known bug are marked with `knownBug` (from the agent lane's `lib/qa.ts`): the
test passes only while it fails the way the bug shows, and turns red the day the bug is fixed (then
remove the mark).

Not covered here (they need the real window): a file dropped from Explorer onto a lane
(`e2e/desktop/osdropTimeline.desktop.mjs`), the Library drag in WebView2 (`npm run e2e:drag`), the
real Windows dialogs and the keys Windows also uses (`e2e/byhand/timeline-editing/native-side.md`).

## Waits

The waits a person feels are recorded with the shared helper (`e2e/lib/timing`) under
`timeline: <what> [<browser>]`: a drop from the Library, a drag, a trim, a split, a delete, and a
restart back to the timeline. They have no budget yet; take one from a quiet lab PC.
