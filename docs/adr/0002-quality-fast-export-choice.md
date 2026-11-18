# ADR 0002 — Export dialog: the Quality / Fast choice

- **Status:** Proposed (built, not yet released)
- **Date:** 2026-11-19
- **Baseline:** `akaru-client` @ `63ff3ead` (the 0.28.0 tree `32df78e3`, the Fast core and the new
  Export dialog without the choice)
- **Switch:** `quick_route` — client `src/api/exportFlags.ts` (`OFF_IN_THIS_BUILD`), server
  `config/export_flags.json`
- **Quality guard:** `src/timeline/exportFullGuard.test.ts` with its frozen fixture
  `src/timeline/__fixtures__/exportFullGuard.sha256.json`
- **Measurements:** one Windows laptop with an AMD chip (16 processors, Radeon 780M), lab of 18 Nov
  2026, figures as read from the lab's tables on 19 Nov 2026 at 01:42, after its last run at 01:33
  (kept outside the repository)

## Context

An export spends its time in three stages: reading the clips, drawing every frame, and compressing
the result. Reading and drawing always run on the processor (an export's command has no hardware
decode); only the compression can move, to a graphics chip or to a lighter processor setting (x264
`veryfast`, called "light compression" in the app). Quality, the default, delivers the project's own
size and frame rate, and the app already picks the chip or light compression by itself on a slow
export (`chooseEncoder`).

The 0.28.0 dialog showed every setting at once. The new dialog shows one row (Resolution) and puts
Frame rate, Quality and the Graphics chip behind **Advanced settings**; its lists offer only sizes and
rates below the project's, and it starts fresh at every opening. This ADR adds the choice above that row.

## Decision

1. **Two named choices.** With `quick_route` on, the settings view starts with **Quality** and
   **Fast**. Quality is selected at every opening; Fast is only ever selected by the person; picking a
   choice puts that choice's own values back. Code keeps the `quick` name (`quick_route`,
   `QUICK_BUNDLE`, `exportRoute`); a person sees only "Quality" and "Fast".
2. **Fast is one frozen bundle** (`QUICK_BUNDLE` in `src/timeline/exportRoute.ts`):
   - a size one rung below the project's short side on the ladder 2160p, 1080p, 720p, 480p (none for a
     project at or below 480p; never an enlargement);
   - at most 30 frames a second (60 gives 30, 50 gives 25, 48 gives 24; lower rates are kept);
   - Medium quality;
   - the encoder: the graphics chip where it passed the app's own test and the person's Graphics chip
     switch is not Off, else light compression while the server switch `faster_x264` is on (plain
     x264 when it is off).
   A size, rate or quality the person set in the dialog is never overridden: the dialog sends which of
   the three were touched (`explicit`) and Fast composes only the rest.
3. **One authority, read at the commit point.** The dialog hands the host
   `exportRoute = { route: "quick", explicit }`; `decideRoute` (`routeDecide.ts`) reads the switch when
   the export is asked for, and `prepareRender` / `encoderOptions` compose the bundle before the plan
   is built. A Fast slot while the switch is off (or held off by the build) is read as no pick.
4. **Doors.** Only the menu's whole-timeline export can take the Fast route. Chat and MCP exports,
   clip exports and library copies carry no slot and run as Quality (a journey test pins it). Try again
   and the app's own restart keep the route of the export they continue. After a chip failure that
   restart of a Fast export runs on plain x264 (as a Quality restart does), which is slower than the
   light compression Fast uses on a processor; keeping light compression there is one line in
   `prepareRender`.

### What Fast is not

- **No speed figure** on the label ("Fast", not "Fast (4x)") and no tooltip. `QUICK_BUNDLE.speedup`
  stays empty, so `fastSpeedupLabel` answers null.
- **No "Are you sure?" question.** `needsSlowConfirm` exists as a pure rule and never asks while that
  table is empty; a guard test fails if the table is filled before the question screen exists.
- **No time or size before the click.** The held estimate stays off and in the code
  (`estimate_v2`, `pc_check`); while an export runs the time left comes from its own progress.
- **No assistant preset.** The `export` tool and the assistant's prompt are unchanged.
- **No change to Quality.** A Quality export is byte for byte what 0.28.0 produced: the frozen
  differential `exportFullGuard.test.ts` holds 10,192 SHA-256 hashes made once on `32df78e3` (command
  builder, encoder choice, the real `export` tool); the fixture is never regenerated, and a changed
  hash is a change in what an export does. Quality sends no `route`, and the dialog's Quality object
  equals the 0.28.0 dialog's for the same inputs (`ExportSettingsView.quality.test.tsx`).
- **Nothing new is reported, so there is no signal.** The export record carries `route: "quick"`, but
  the report builder picks named fields and does not read it (a journey test compares the key sets):
  after release nothing says whether Fast is used or helps. The `mode_shown` trace step is no longer
  written either, because the new dialog tells the store the old Mode row was never on screen.

## Why Fast is a modest gain

Fast shrinks the picture after every frame is drawn at the project's own size: `render.ts` applies the
delivery size as one `scale` at the end of the composite and the delivery rate as the `-r` output
option. Reading and drawing cost what they cost for Quality; Fast shrinks only the compression share,
and the chip makes that share nearly free. Time ratios (Quality seconds divided by Fast seconds; above
1 the Fast export took less time), one Windows laptop, strong profile, rounded to one decimal because
every run was made on a PC that other programs were also using (the lab flags all of them as busy,
3.5 to 12 cores):

| Project (length tested)              | Fast vs Quality, processor | Fast vs Quality's light compression | Fast vs Quality, chip |
| ------------------------------------ | -------------------------- | ----------------------------------- | --------------------- |
| Phone reel 1080x1920 at 30 (2 min)   | 1.3 to 1.4                 | 1.0                                 | 0.9                   |
| Talking head, captions (2 min)       | 1.4                        | 1.0                                 | 0.9                   |
| Horizontal HD, crossfades (2 min)    | 1.3 to 1.4                 | 1.0                                 | 0.9 to 1.0            |
| HD at 60 fps (2 min)                 | 1.9 to 2.1                 | (1.2)                               | 1.0                   |
| Photo slideshow, zoom (2 min)        | (1.05)                     | not measured                        | (0.9)                 |
| Zoom-heavy real reel (2 min)         | 1.1                        | not measured                        | 0.9 to 1.0            |
| 4K at 30, 3 clips, streamed (30 s)   | 1.4                        | 1.0                                 | 1.0                   |
| 4K at 60, 2 clips, streamed (20 s)   | 1.3 to 1.4                 | 1.0                                 | not measured          |
| 36-clip HD edit, streamed (2 min)    | (2.4)                      | (1.1)                               | (1.0)                 |

Brackets: every run of that figure is in a block the lab flagged or in an unfinished segment. A range
is the lab's two readings (ratio of the means of the valid runs; paired median of the blocks).
"Processor" is Quality as the app runs it there (standard compression); "light compression" is what
Quality's own rule already picks on a slow project without a chip. The lab's paired medians for the
five typical projects (the first five rows) read 1.36, 1.39, 1.38, 1.88 and 1.05 without a chip and
0.89, 0.90, 0.97, 0.98 and 0.92 with one, all flagged busy. The blocks are not steady: on the phone
reel, horizontal HD and 60 fps projects they are 22, 13 and 26 percent apart, and the lab asks for a
third block on the 60 fps project. So three of the five typical projects sit at 1.3 to 1.4 without a
chip, the 60 fps project at 1.9 to 2.1 and the slideshow at 1.05; with a chip none is above 1.0.

- Light compression alone is 1.3 to 1.4 times faster than standard on plain projects, the chip alone
  1.4 to 2.15 (1.1 on the zoom-heavy reel). Fast without a chip is mostly the light compression:
  beside Quality's own light compression it reads 0.96 to 1.04 on the plain two-minute and the 4K
  projects ((1.2) at 60 fps), and with a chip it adds nothing (0.85 to 1.01).
- On 4K and many-clip projects Fast took no less time than Quality's own light compression (0.98 to
  1.01 on the two 4K tests, (1.1) on the 36-clip edit). A second size step on 4K moved the chip time
  by under 1 percent (118.0 s to 118.1 s).
- On an emulated weak PC (the same laptop limited to 4 of 16 processors and 4.7 GB free; single runs,
  and the lab's validity gate for that profile failed on its first block, so indications only) Fast
  without a chip read 1.8 to 2.6 on four projects and Fast with a chip 0.79 to 0.89 on three of them
  (the fourth, the phone reel, whose block the lab flagged, read 1.05).
- On a chip PC the Fast command differs from the Quality command in one step (and `-r` at 60 fps) on
  the one-pass engine: the lanczos `scale`. It costs about 7 to 10 processor-milliseconds per frame
  drawn, a little more than the chip saves by encoding the smaller picture, so Fast took up to about
  7 seconds longer than Quality on 2-minute exports (9 in one flagged block, and 5 seconds less in
  one horizontal-HD block: the noise is of that size). A cheaper resize filter was not tried.
- Only drawing at the delivery size from the start moved a big project: 4K at 30 fps from about 120 s
  to about 13 s with the chip, the phone reel from about 51 s to 48 s. That is an upper bound: the
  canvas was set small by hand, text and effects were not rescaled, picture quality was not judged, and
  part of the 4K gain is the app leaving its slower streamed engine.
- The explanation above is read from the code and the timings. A direct read, draw and compress time
  split has not been measured.

## Consequences

- **We get:** a named choice for a smaller picture (and with it a smaller file); Quality unchanged to
  the byte; the 0.28.0 dialog as a fallback.
- **Time:** where no chip passes its test, the lab measured shorter Fast exports on plain projects
  (table; 1.8 to 2.6 on the weak emulation, indications only). Where a chip passes, Fast saves no
  time and can take a little longer (0.9 to 1.0 on the strong laptop, 0.8 to 0.9 on the weak
  emulation, one flagged cell 1.05). On 4K and many-clip projects it adds nothing to Quality's own
  light compression. No speed is claimed.
- **Not measured or tested:** macOS and Linux; NVIDIA and Intel chips; slower cores; an upgrade from a
  copied 0.27.0 profile (its flag cache has no `quick_route`, so the compiled "on" applies); a real
  browser or screen reader (only the test environment's). The lab is one Windows laptop, AMD chip.
- **Residual:** the unit tests assert the command handed to the app process, not rendered pixels (the
  real-ffmpeg smoke suite is where output files are checked); the figure and the question screens
  are not built (only their pure rules).

## Open questions

- The word "Fast" where a chip passes its test: there it changes the picture and the file, not the
  time. Options: neutral words around the choice (the summary names what changes, never a speed),
  offering the choice only where no chip passed, or leaving it. Each is a small change at the choice row.

## Rejected alternatives

- **A speed figure on the label.** No figure holds across the projects and PCs measured (0.8 to 2.6);
  one would need data from more than one machine class.
- **An "Are you sure?" question before a big Quality export.** It needs that figure and targets the
  projects where Fast adds least (4K, 60 fps, many clips).
- **A Fast preset in the assistant's `export` tool.** A new parameter changes the tool contract (server
  first, a new catalog snapshot, evals) for a small gain; the tool already accepts a smaller
  `resolution`, a lower `fps` and a lower `quality`.
- **A "Switch to Fast" button on the slow-export banner.** A restart discards the progress already
  made, and Fast's best ratio on typical projects is about 1.4 (1.9 to 2.1 at 60 fps);
  `quickAvailable()` stays false.
- **Build small** (draw at the delivery size from the start). The one lever that moved 4K, but it
  changes the draw stage (text sizes and pixel-valued effects need care, Quality must stay
  byte-identical): deferred, with its upper-bound measurement recorded.
- **Light compression only inside Fast.** Moving it out of Quality's policy would slow Quality for
  everyone (1.3 to 1.4 times on plain projects) and break the byte-identity pin.

## How to reverse (turn it off)

The switch has two places, and neither is a toggle that reaches every app.

1. **Server.** `config/export_flags.json` carries `"quick_route": true`. That is one server commit, not
   part of this repository: it must be deployed before any client that ships the choice, and
   `GET /client/export-flags` must list the name. The file is part of the server image, so turning the
   choice off is a server redeploy with the file changed, or a new revision with the server's
   flags-off lever. An app hears the server only while signed in and online (at start, before an
   export and about every ten minutes while open; the privacy text says so) and keeps the last answer
   across restarts, so "off" takes effect from the next opening of the dialog after the app has heard
   it, up to about ten minutes later. An app that is offline, signed out, or talking to an older
   server that does not list the name keeps its compiled "on": only a client release reaches it. A
   Fast pick already on its way when the answer arrives runs as Quality with the values the dialog
   showed.
2. **Client.** Revert the one commit that removes `"quick_route"` from `OFF_IN_THIS_BUILD` (with the
   test edits it carries); the build then holds the choice off whatever the server says.
3. **What comes back.** Off restores the whole 0.28.0 dialog, not only "no Fast choice": a Mode row
   ("Full quality / Fast", where Fast means the graphics chip) can still appear in it where no
   Graphics chip row is drawn. The time-left rule, the plain failure sentence, the Resolution-list
   rule and the renamed words are not behind the switch and stay. Quality's encoder policy
   (`exportEncoder.ts`) is untouched.

## References

- `src/timeline/exportRoute.ts`, `routeDecide.ts`, `exportEncoder.ts`, `render.ts`;
  `src/api/exportFlags.ts`
- `src/components/ExportSettingsView.tsx`, `ChoiceRow.tsx`, `AdvancedSettings.tsx`, `ExportDialog.tsx`,
  `MenuBar.tsx`; `src/timeline/exportChoiceView.ts`, `exportChoiceWords.ts`
- Tests: `exportFullGuard.test.ts`, `exportFast.journey.test.ts`, `routeDecide.test.ts`,
  `exportRoute.test.ts`, `ExportSettingsView.quality.test.tsx`
