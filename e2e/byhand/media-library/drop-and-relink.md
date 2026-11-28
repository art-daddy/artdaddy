# By hand: files dropped from Explorer, and a moved folder relinked through the real Open dialog (computer use)

The browser lane (`e2e/ui/media-library/`) raises the drop the way Tauri does (`tauri://drag-drop` with the file's
path) and answers the Open dialog for the app, so it proves what the app does with a dropped path or a picked file.
It cannot see the parts Windows owns: the drag itself from Explorer (does the drop arrive as a path, does the zone
light up under the cursor), and the real Open dialog the app shows for Relink. This script is that look, done with
an AI agent's computer use (screen and input tools) or by a person, on a dev build. Run it from this page, step by
step, not from memory. About 15 minutes.

The real OLE drag moves the PC's mouse and holds its button: run it only when nobody else is using the PC.

## Before you start

- Rules: one real-app run at a time on a shared PC (take the real-app slot); never drive an installed ArtDaddy (tell
  them apart by the process path, step 2); never call a paid tool; never open or change a project that is not
  `sweep_…`.
- Start a dev app from this worktree and keep it running, for example the export lane's hold:
  `node --experimental-websocket e2e/desktop/export/run.mjs byhand-hold` (a project `sweep_qa-export by hand`,
  the app's process id printed, open for up to 15 minutes; creating `reports/qa/export/byhand/stop` ends it and
  removes the project).
- A folder of footage: `reports/qa/media/byhand/shoot/` in this worktree (git-ignored) holding copies of
  `e2e/ui/media-library/fixtures/media/rgb_3s.mp4` named `wide.mp4`, `tone_2s.wav` named `room tone.wav`, and
  `notes.pdf` named `shot list.pdf`.
- The project's folder: `%APPDATA%\ArtDaddy\projects\<project id>` (the id is in the app's address, `/p/<id>`).
  Each check "on disk" below reads its `internals\library.json` and `internals\timeline.json` from a shell.

## Steps (each with what must be true after it)

1. `cua.listWindows()` alone, as the tool asks.
   - True: a window titled "ArtDaddy" whose process is the one the hold printed. The tool names any ArtDaddy build
     `com.artdaddy.app`, so match the window id to the process first (EnumWindows by process id from a shell).
2. Bind that window only, by its id.
   - True: its process path is under `cargo-target\debug\artdaddy.exe`, not `AppData\Local\artdaddy\artdaddy.exe`.
3. Open Explorer at `reports\qa\media\byhand\shoot`, side by side with the app. Drag `wide.mp4` over the Library pane
   and hold it there.
   - True: the Library pane shows a ring and "Drop to import" while the file is over it.
4. Release it.
   - True: a tile "wide.mp4" appears within seconds. On disk: `library.json` has a row with `filename` "wide.mp4",
     `external: true` and `path` naming the file in `shoot` (linked in place); the project's `library\` folder holds
     no copy of it. Time from the release to the tile.
5. Drag `room tone.wav` over the a1 track, near its start, and hold it.
   - True: the track lights up and a dashed landing line shows where it would start.
6. Release it.
   - True: an audio clip appears on a1 where the line was. On disk: `timeline.json` has a clip on track "a1" whose
     `media_ref` is the new row's `id`.
7. Drag `shot list.pdf` onto the Library pane and release it.
   - True today: nothing at all happens and nothing is said (a known bug: "Dropping a file the app does not import
     shows nothing"). What a person needs: a word that it was not imported and why. Record what you see. On disk:
     `library.json` has no row for it.
8. Drag `wide.mp4` onto the Assistant's message box and release it.
   - True: the message box shows an attachment "wide.mp4". Do not send the message.
9. File > Close Project. In Explorer rename `shoot` to `shoot moved`. File > Open Project…, then the project.
   - True: a notice "2 media files are offline — the source moved or was deleted. Relink from the library panel.";
     both tiles read "Media Offline"; with the playhead over the clip the stage says
     "Media offline: … — relink it in the library."
10. Right-click the "wide.mp4" tile, then "Relink…".
    - True: a Windows dialog titled `Locate "wide.mp4"` opens. Note the folder it opens in.
11. Pick `shoot moved\wide.mp4` and press Open.
    - True: "Relinked 2 files." in the Library pane; no tile reads "Media Offline"; the stage message is gone and
      the picture is back. On disk: both rows' `path` now name files in `shoot moved`.
12. Right-click "room tone.wav", then "Relink…", and press Cancel in the dialog.
    - True: nothing changes, and no message says anything failed.

## Clean-up

End the hold (create `reports/qa/export/byhand/stop`); delete `reports/qa/media/byhand/`.

## Record

In the receipt: the build (the hold's `report.json` names it), each step pass or fail with a screenshot of any
failure (screenshots of the app window could not be captured on 26 Nov: judge from the accessibility text and say
so), the time in step 4, and how long the session took.
