# By hand: export through the real Save As dialog (computer use)

The export lane (`e2e/desktop/export/run.mjs`) answers Save As with UI Automation and window messages, so it
proves what the app does with the path the dialog returns. It cannot see what a person sees in the dialog
itself: its title, the name and type it suggests, the folder it opens in, and Windows' question before a file is
replaced. This script is that look, done with an AI agent's computer use (screen and input tools) on a dev build.
Run it from this page, step by step, not from memory. About 10 minutes.

## Before you start

- Rules: one real-app run at a time on a shared PC (take its lock if it has one); never drive an installed
  ArtDaddy (its window is also titled "ArtDaddy": tell them apart by the process path, see step 2); never call a
  paid tool.
- Start the lane's app and leave it running, from this worktree:
  `node --experimental-websocket e2e/desktop/export/run.mjs byhand-hold`. The `byhand-hold` scenario builds a
  project, `sweep_qa-export by hand`, with a red and a blue 3 s clip, prints the app's process id, and keeps the
  app open for up to 15 minutes; creating the file `reports/qa/export/byhand/stop` ends it, and the run then
  removes the project and stops the app.
- A folder for the result: `reports/qa/export/byhand/` in this worktree (create it; it is git-ignored). Put an
  old file there first, `reports/qa/export/byhand/by hand.mp4` (copy any fixture), so step 7 can be asked.

## Steps (each with what must be true after it)

1. `cua.listWindows()` alone, as the tool asks, and read its documentation.
   - True: a window titled "ArtDaddy" whose process is the one `byhand-hold` printed.
2. Bind that window only (by its process id, never by title alone).
   - True: the bound window's process path is under `cargo-target\debug\artdaddy.exe`, not
     `AppData\Local\artdaddy\artdaddy.exe` (an installed app).
3. Click File, then "Export Video (.mp4)…".
   - True: the Export dialog shows "Resolution: Same as project (1920 x 1080)", "Advanced settings",
     Cancel and Export, nothing cut off. Time from the click to the dialog.
4. Click Export.
   - True: a Windows "Export video" dialog opens; its File name box reads `sweep_qa-export by hand`
     (the project's title, not its folder name); "Save as type" reads "MP4 video (*.mp4)".
     Note the folder it opened in (the last folder exported to, or Downloads).
5. Press Escape (Cancel).
   - True: the Windows dialog closes; the Export dialog still shows its settings; nothing appears in the
     queue; no file appears in Downloads.
6. Click Export again. In the File name box, type the full path of `reports/qa/export/byhand/by hand.mp4`.
7. Press Enter.
   - True: Windows asks "by hand.mp4 already exists. Do you want to replace it?" with Yes and No.
8. Click No.
   - True: the question closes and the Save As dialog stays open with the name still typed.
9. Press Enter, then click Yes.
   - True: within seconds the Export dialog shows "Rendering and encoding · N%", then "Done" and
     "Saved to …\reports\qa\export\byhand\by hand.mp4" in full (not cut off). Time from Yes to Done.
10. On disk (a shell, not the screen): `by hand.mp4` is a new file (not the old one's size), and `probe()`
    from `e2e/desktop/export/media.mjs` says h264 and aac, about 8.03 s (6 s plus the end card);
    `colourAt()` at 1.5 s is red and at 4.5 s is blue. No `.by hand.mp4.*.partial` beside it.
11. Click Close in the Export dialog.

## Clean-up

Create `reports/qa/export/byhand/stop` (the run removes `sweep_qa-export by hand` and stops the app); then
delete `reports/qa/export/byhand/`.

## Record

In the receipt: the build (the run's `report.json` names it), each step pass or fail with a screenshot of any
failure, the two times (steps 3 and 9), and how long the session took.
