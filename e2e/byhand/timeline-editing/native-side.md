# By hand: the timeline's native side (computer use)

The browser lane (`e2e/ui/timeline-editing/`) drives every timeline gesture on the real page and judges the
saved `internals/timeline.json`, but it answers the app's questions itself and its keys never pass through
Windows or WebView2. The desktop lanes `e2e:drag` and `e2e/desktop/osdropTimeline.desktop.mjs` prove that a
library drag and a file dropped from Explorer reach a lane. This script is what is left: what a person sees in
the real window when the app asks before deleting a track, and whether the keys that Windows or WebView2 also
use (Alt, Alt+arrows, Delete after an Alt+drag) reach the timeline. Run it from this page, step by step, with an
AI agent's computer use (screen and input tools) on a dev build. About 15 minutes.

## Before you start

- Rules: one real-app run at a time on a shared PC (take the real-app slot); never drive an installed ArtDaddy
  (tell the windows apart by process path, step 2); never call a paid tool; name the project `sweep_qa-timeline
  by hand` and delete it at the end.
- Build and start the app from this worktree with its own identity and a stand-in server, as the export lane
  does (`e2e/desktop/export/app.mjs`), or with the set-up in the qa skill ("Set up the real app"). Keep the
  window visible.
- Media: copy `e2e/ui/timeline-editing/fixtures/media/bars_2s.mp4` and `talk_2s.mp4` to a scratch folder
  outside the projects folder.

## Steps (each with what must be true after it)

1. `cua.listWindows()` alone, and read its documentation.
   - True: a window whose process is the app you started. The tool names any ArtDaddy build
     `com.artdaddy.app`: match the window to your process id, then bind to its window id.
2. Bind that window only, by its window id.
   - True: the bound window's process path is under `cargo-target\debug\artdaddy.exe`, not
     `AppData\Local\artdaddy\artdaddy.exe` (an installed app).
3. File > New Project…, name `sweep_qa-timeline by hand`, Create. Then File > Import Media… and pick both files
   in the Windows "Open" dialog.
   - True: both appear in the Library pane; the Timeline header reads "2 tracks · 0 clips".
4. Drag `talk_2s.mp4` from the Library onto the v1 lane, about a quarter of the way along.
   - True: while dragging, a dashed box shows where it will land; after release the header reads
     "2 tracks · 2 clips" (the picture on v1, its sound on a1). On disk, `internals/timeline.json` has both
     clips with the same `link_group`. Time from release to the clips on screen.
5. Click +V (Add video track). Drag `bars_2s.mp4` onto the new lane (v2).
   - True: "3 tracks · 3 clips".
6. On the v2 header, click ✕ (Delete track).
   - True: a Windows dialog titled "ArtDaddy" asks "Delete v2 and its 1 clip(s)?" with OK and Cancel
     (screenshot it). Nothing is deleted yet.
7. Click Cancel.
   - True: the dialog closes; v2 and its clip are still there, on screen and in `internals/timeline.json`.
8. Click ✕ on v2 again, then OK.
   - True: v2 and its clip are gone ("2 tracks · 2 clips"); Ctrl+Z brings both back.
9. Hold Alt, drag the clip on v1 to the right by about its own length, release, then release Alt.
   - True: a copy sits where it was dropped and the original stays (Alt is the copy key); the window's
     own menu did not open and the page still has the keyboard.
10. With the copy selected, press Delete.
    - True: the copy is removed (the keys still reach the timeline after the Alt+drag).
11. Click the clip on v1, then press Alt+→ three times and Alt+← once.
    - True: the clip (and its sound on a1) moved right by two frames in `internals/timeline.json`; the window
      did not go back to the project list (in a browser, Alt+← is Back).
12. Click in the chat box, type "trim the start", press Backspace twice and Ctrl+Z.
    - True: only the text changed; the timeline and `internals/timeline.json` are unchanged.

## Clean-up

File > Close Project; delete the project folder `sweep_qa-timeline by hand_*` under the app's projects folder
(only that one); stop the app by its process id; release the slot; delete the scratch media.

## Record

In the receipt: the build (worktree folder, `git rev-parse HEAD`, clean or not, the version the app reports),
each step pass or fail with a screenshot of any failure, the time in step 4, and how long the session took.
