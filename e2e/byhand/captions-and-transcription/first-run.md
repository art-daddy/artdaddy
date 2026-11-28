# By hand: the speech model's first download, and the first captions on a new PC

The one wait no automated lane can time: a PC with no speech model downloads it (465 MiB, once) and
then transcribes for the first time. The browser lane fakes the download's places
(`e2e/ui/captions-and-transcription/modelDownload.spec.ts`: progress, Cancel, failure, Retry) and the
real-app lane (`e2e/desktop/captions-and-transcription/firstRun.desktop.mjs`) needs the model already
on the PC, because a dev build shares the app's data folder and must never change it. Run this script
from the script, not from memory, and time each wait it names.

## Before you start

- **Where:** a Windows PC, or a Windows user account, whose `%APPDATA%\ArtDaddy\models` folder has no
  `ggml-small.bin` (open the folder in File Explorer; if the file is there this is not a first run:
  stop). Never delete or move the model on a PC that has it to make one.
- **Which build:** the release candidate's installer, built from the commit under test. Write down
  its version (Help > About, or the installer's name) and the commit.
- **Account:** an installed build talks to the live service. If it is signed in with a real account,
  send no prompt to the in-app assistant and use no paid tool. Captions here come over MCP from an
  outside assistant using only local tools.
- **Media:** a copy of `e2e/ui/captions-and-transcription/fixtures/media/spoken_scenes.mp4` (12 s,
  three spoken sentences: "Captions should follow the voice. Every word appears while it is spoken.
  The picture and the sound stay together.").
- **A clock:** a stopwatch, or note the times shown by the PC's clock to the second.

## Steps

1. **Start ArtDaddy.** Start the clock when the window appears.
   - After about 3 seconds a card appears at the bottom left: "Downloading the speech model (one
     time, about 465 MB) - N%", a line under it, and **Cancel**.
   - Time: window appears to the card appearing (expect under 10 s).
2. **Watch the card.** The percentage rises; the time left is shown.
   - Time: card appears to the card going away by itself (the download, about 465 MiB).
   - After it goes: `%APPDATA%\ArtDaddy\models` holds `ggml-small.bin` (487,601,967 bytes) and
     `ggml-small.bin.verified.json`. No "Could not download the speech model." card is shown.
3. **File > New Project**, name it `sweep_qa_firstrun`, **Create**.
4. **File > Import Media…**, choose the copy of `spoken_scenes.mp4`. Start the clock when the clip
   shows in the library.
   - The app transcribes it in the background. If that lasts more than 15 s, a chip appears in the
     status bar at the bottom ("Transcribing…"); clicking it shows the file's name, its progress and
     **Cancel**. Do not cancel.
   - Time: clip in the library to the chip going away (or, with no chip, 15 s).
   - No "Transcription failed" item appears in the status bar.
5. **Drag the clip** from the library onto the timeline at the start.
6. **From the outside assistant over MCP**, ask: "Add captions to the clip on my timeline." It calls
   `add_captions` (local, free). Time: the request to captions showing on the timeline.
   - A **captions** text track appears with three or more captions; together they read the three
     sentences above (a word or two may differ).
   - Play from the start: each caption shows while its words are spoken.
7. **Cancel on a first download** (only on a second clean PC or account, or after the owner agrees to
   reinstall): start ArtDaddy, press **Cancel** on the download card. The card goes, no failure card
   appears, and after closing and opening ArtDaddy the download does not start again by itself. Asking
   for captions later starts it again.

## Record

- The four times, each as one line with the timing helper, from a client checkout:
  `node -e "import('./e2e/lib/timing.mjs').then((m) => m.record('<name>', <ms>))"` with the names
  `captions: launch to the speech model download showing (installed build)`,
  `captions: first speech model download, 465 MiB (installed build)`,
  `captions: import a 12 s spoken clip to its first transcript (installed build)` and
  `captions: add_captions over MCP to captions shown, first run (installed build)`.
  Say whether the PC was quiet and what network it was on: the download time is mostly the network's.
- Pass or fail per step, the build's version and commit, and a screenshot of any card or status item
  that was not as written.

## Clean up

Remove the project `sweep_qa_firstrun` (File > Open Project, then remove it from the list). Keep the
model: an installed app keeps it too.
