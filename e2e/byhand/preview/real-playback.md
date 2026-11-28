# By hand: real playback, with sound, in the app (computer use, or a person)

The browser lane (`e2e/ui/preview/playback.spec.ts`) proves that the picture follows the playhead (it reads the
stage's pixels at each time the transport shows) and that sound reaches the master meter. It runs in Chromium and
WebKit, not in the WebView2 the Windows app uses, on a software or CI graphics chip, and nobody listens. This script
is the look and the listen on a dev build: smooth playback, the sound in time with the picture, a scrub that answers
at once. Run it from this page, step by step, not from memory. About 10 minutes. Sound is a person's part: computer
use cannot hear, so a run by an agent marks steps 4 and 9 "not run" and says so.

## Before you start

- Rules: one real-app run at a time on a shared PC (take the real-app slot); never drive an installed ArtDaddy (tell
  them apart by the process path); never call a paid tool.
- Start a dev app with a project of colour clips and keep it running, for example the export lane's hold:
  `node --experimental-websocket e2e/desktop/export/run.mjs byhand-hold` (a project `sweep_qa-export by hand` with a
  red 3 s clip then a blue 3 s clip, each with a tone; the app's process id printed; open for up to 15 minutes;
  creating `reports/qa/export/byhand/stop` ends it and removes the project).
- Keep the window visible and in front: the preview draws with WebGL2 and a hidden window may not draw.
- Speakers or headphones on, at a low level (for a person).

## Steps (each with what must be true after it)

1. Bind the app's window by its id after matching its process (as `e2e/byhand/export/save-as.md`, steps 1 and 2).
2. Close the project (File > Close Project) and open it again (File > Open Project…, the project). Time from the
   click on the project to the first picture.
   - True: the stage shows red (the first clip) within a few seconds; the transport reads `0.00s / 6.00s`.
3. Press the play button (▶) under the stage.
   - True: the playhead moves along the ruler and the transport's time counts up smoothly; the picture turns from red
     to blue at 3 s; no stall longer than a moment, no black flash at the cut. The master meter beside the time
     moves.
4. Listen while it plays (a person only).
   - True: a steady tone from the start; a change of pitch at the cut (the two clips carry different tones), in time
     with the change of colour; no clicks, gaps or doubled sound.
5. Press the pause button (❚❚).
   - True: the picture and the time stop at once and stay; the meter falls to rest; no sound.
6. Drag the transport's slider to the middle and let go; then to near the end.
   - True: the picture follows the slider while dragging (red before 3 s, blue after) and is the right colour where
     it stops, at once. Silent while dragging (there is no scrub sound).
7. Click on the timeline's ruler at about 1 s, press Space, then Space again after a second.
   - True: Space plays from 1 s and pauses; the picture and the time agree.
8. Press End, then Home, then the right arrow three times.
   - True: End shows the end of the timeline (black past the last clip is right); Home shows red at `0.00s`; each
     right arrow moves one frame (`0.03s`, `0.07s`, `0.10s`).
9. Click the red clip's tile in the Library; in its tab press play (a person listens).
   - True: the clip plays in its own tab with its own transport (`0:00 / 0:03` counting up), with its sound; the
     timeline's playhead does not move. Close the tab with its ×: the live preview is back, still paused.
10. Choose 50% in the stage's zoom list, then Fit.
    - True: at 50% the picture is half the project's size, with scroll bars if it does not fit; Fit fits it in the
      pane again. The picture stays sharp and the right colour.

## Clean-up

End the hold (create `reports/qa/export/byhand/stop`).

## Record

In the receipt: the build (the hold's `report.json` names it), each step pass, fail or not run (with why), a
screenshot of any failure (screenshots of the app window could not be captured on 26 Nov: judge from the
accessibility text and say so), the time in step 2, and how long the session took.
