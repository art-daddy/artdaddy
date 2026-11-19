# ADR 0002 — Export dialog: the Quality / Fast choice

- **Status:** Proposed (built, not yet released)
- **Date:** 2026-11-19
- **Baseline:** `akaru-client` @ `63ff3ead` (the 0.28.0 tree `32df78e3`, the Fast core and the new Export dialog without the choice)
- **Switch:** `quick_route` — client `src/api/exportFlags.ts` (`OFF_IN_THIS_BUILD`), server `config/export_flags.json`
- **Quality guard:** `src/timeline/exportFullGuard.test.ts` with its frozen fixture `src/timeline/__fixtures__/exportFullGuard.sha256.json`
- **Measurements:** one Windows laptop with an AMD chip (16 processors, Radeon 780M), lab of 18 Nov 2026, figures as read from the
  lab's tables on 19 Nov 2026 at 01:42, after its last run at 01:33 (kept outside the repository)

## Context

An export spends its time in three stages: reading the clips, drawing every frame, and compressing the result. Reading and drawing
always run on the processor (an export's command has no hardware decode); only the compression can move, to a graphics chip or to a
lighter processor setting (x264 `veryfast`, called "light compression" in the app). Quality, the default, delivers the project's own
size and frame rate, and the app already picks the chip or light compression by itself on a slow export (`chooseEncoder`). The 0.28.0
dialog showed every setting at once; the new dialog shows one row (Resolution), puts Frame rate, Quality and the Graphics chip behind
**Advanced settings**, offers only sizes and rates below the project's, and starts fresh at every opening. This ADR adds the choice
above that row and records the time-left rule that runs beside it.

## Decision

1. **Two named choices.** With `quick_route` on, the settings view starts with a radio row, **Quality** and **Fast**. Quality is
   selected at every opening; Fast is only ever selected by the person; picking a choice, the selected one included, puts that
   choice's own values back. Code keeps the `quick` name (`quick_route`, `QUICK_BUNDLE`, `exportRoute`); a person sees "Quality" and "Fast".
2. **Fast is one frozen bundle** (`QUICK_BUNDLE` in `src/timeline/exportRoute.ts`): a size one rung below the project's short side
   on the ladder 2160p, 1080p, 720p, 480p (none at or below 480p; never an enlargement); at most 30 frames a second (60 gives 30,
   50 gives 25, 48 gives 24; lower rates are kept); Medium quality; and the encoder: the graphics chip where it passed the app's own
   test and the person's Graphics chip switch is not Off, else light compression while the server switch `faster_x264` is on (plain
   x264 when it is off). A size, rate or quality the person set is never overridden: the dialog sends which of the three were
   touched (`explicit`) and Fast composes only the rest.
3. **One authority, read at the commit point.** The dialog hands the host `exportRoute = { route: "quick", explicit }`; `decideRoute`
   (`routeDecide.ts`) reads the switch when the export is asked for, and `prepareRender` / `encoderOptions` compose the bundle before
   the plan is built. A Fast slot while the switch is off (or held off by the build) is read as no pick.
4. **Doors.** Only the menu's whole-timeline export can take the Fast route; chat and MCP exports, clip exports and library copies
   carry no slot and run as Quality (a journey test pins it). Try again and the app's own restart keep the route of the export they
   continue. After a chip failure that restart of a Fast export runs on plain x264 (as a Quality restart does), which is slower than
   the light compression Fast uses on a processor; keeping light compression there is one line in `prepareRender`.
5. **What the view shows is what it sends.** One function resolves the shown values; the rows, the chip row and the payload all read
   it. The menu bar adds `exportRoute` for Fast only, so Quality's options object is 0.28.0's key for key; one constant
   (`FAST_CHOICE_OFFERED`) draws or removes the row and its line.
   - The line behind Advanced settings is built from the shown values, clause by clause, and never names the encoder: "One size
     smaller, up to 30 frames a second, Medium quality." (Fast on 4K at 60), "Project size and frame rate, Medium quality."
     (Quality at the start). Quality alone also gets "To save time, ArtDaddy will use light compression." where the app will use that
     setting.
   - One Frame rate list per project serves both choices and holds Fast's own rate where the ladder 60 / 50 / 30 / 25 / 24 has none
     (72 gives 18); a rate is kept only while the list holds it.
   - The chip row's note for a passed chip reads "Auto: used on this PC. ..." under Quality and under Fast alike: the chip is used
     whenever it passed its test for the picture's size, so the note names no saving and no kind of export.
   - Where the person switches the chip Off and it would have been used (it passed its test for the picture's size, nothing has set it
     aside, the server's switches allow it), the Off note gains one sentence in the same paragraph: "Without the graphics chip, exports
     are usually slower." Nowhere else is it said. The chat card has no switch for the chip of its own; it only says that the chip was
     turned off in the dialog. No screen and no text of the assistant says that the picture differs or is softer because of the chip or
     light compression (a guard reads every string, comment and tool text for it).
   - A key pressed in the dialog does not leave it (the panel stops every key but Escape). The editor behind it steps the playhead on
     an arrow key and cancels the browser's move between radios, plays on Space and deletes the selected clip on Delete: without this
     the radios could not be operated from the keyboard, and Delete in a dialog control removed a clip, in 0.28.0 as well.

### What Fast is not

- **No speed figure** on the label ("Fast", not "Fast (4x)") and no tooltip: `QUICK_BUNDLE.speedup` stays empty, the view passes no
  figure to the row, and a guard test (`exportRoute.questionGuard.test.ts`) fails if the table is filled before the question screen exists.
- **No "Are you sure?" question** (`needsSlowConfirm` exists as a pure rule and never asks while that table is empty), **no time or
  size before the click** (the held estimate, `estimate_v2` and `pc_check`, stays off and in the code) and **no assistant preset**
  (the `export` tool and the assistant's prompt are unchanged).
- **No change to Quality.** A Quality export is byte for byte what 0.28.0 produced: the frozen differential `exportFullGuard.test.ts`
  holds 10,192 SHA-256 hashes made once on `32df78e3` (command builder, encoder choice, the real `export` tool); the fixture is never
  regenerated, and a changed hash is a change in what an export does. Quality sends no `route`.
- **Nothing new is reported, so there is no signal.** The export record carries `route: "quick"`, but the report builder picks named
  fields and does not read it (a journey test compares the key sets): after release nothing says whether Fast is used or helps. The
  `mode_shown` trace step is no longer written either, because the new dialog tells the store the old Mode row was never on screen.

## Time left while an export runs

One pure module (`src/timeline/exportTimeLeft.ts`) is the only place that decides what may be said; the chat card, the dialog's running
view and the assistant's `time_left_s` read its answer. Nothing is said until 20 s have been rendered and either 15 % is made or 60 s have been rendered.
Then a figure from the slope of the share made over the last 20 s, rounded to a grid ("under a minute left", "about 4 min left",
"about 1 h 15 min left") and kept while the raw figure stays near its cell; from 90 % made "Finishing"; and "taking longer than
expected" once the average pace implies more than 1.5 times the first total. A render made in parts says nothing until its final
encode. The card no longer prints a guessed "Expected" line and the dialog's running line still shows the speed multiple as 0.28.0
did; the slow-export banner and the assistant's `projected_total_s` keep the raw pace on purpose (the new figure is rounded and
sometimes absent). Replayed on 88 recorded exports (16,109 reports at their half-second cadence, 20 s to 6.5 minutes, one laptop):
the first figure comes after a median 20 s of rendering (latest 48 s); at each checkpoint from 15 to 85 % done a figure is within 0.5
to 1.5 times the real time left for 82 to 100 % of the runs that show one (89 of about 940 figures were wrong, 88 of them too long);
no healthy run says "taking longer" (the closest reaches 1.48 of the 1.5 line).

## Why Fast is a modest gain

Fast shrinks the picture after every frame is drawn at the project's own size: `render.ts` applies the delivery size as one `scale`
at the end of the composite and the delivery rate as the `-r` output option. Reading and drawing cost what they cost for Quality;
Fast shrinks only the compression share, and the chip makes that share nearly free (read from the code and the timings; a direct
read, draw and compress split was not measured). Time ratios (Quality seconds divided by Fast seconds; above 1 the Fast export took
less time), one Windows laptop, strong profile, rounded to one decimal because every run was made on a PC that other programs were
also using (the lab flags all of them as busy, 3.5 to 12 cores):

| Project (length tested)            | Fast vs Quality, processor | Fast vs Quality's light compression | Fast vs Quality, chip |
| ---------------------------------- | -------------------------- | ----------------------------------- | --------------------- |
| Phone reel 1080x1920 at 30 (2 min) | 1.3 to 1.4                 | 1.0                                 | 0.9                   |
| Talking head, captions (2 min)     | 1.4                        | 1.0                                 | 0.9                   |
| Horizontal HD, crossfades (2 min)  | 1.3 to 1.4                 | 1.0                                 | 0.9 to 1.0            |
| HD at 60 fps (2 min)               | 1.9 to 2.1                 | (1.2)                               | 1.0                   |
| Photo slideshow, zoom (2 min)      | (1.05)                     | not measured                        | (0.9)                 |
| Zoom-heavy real reel (2 min)       | 1.1                        | not measured                        | 0.9 to 1.0            |
| 4K at 30, 3 clips, streamed (30 s) | 1.4                        | 1.0                                 | 1.0                   |
| 4K at 60, 2 clips, streamed (20 s) | 1.3 to 1.4                 | 1.0                                 | not measured          |
| 36-clip HD edit, streamed (2 min)  | (2.4)                      | (1.1)                               | (1.0)                 |

Brackets: every run of that figure is in a block the lab flagged or in an unfinished segment. A range is the lab's two readings (ratio
of the means of the valid runs; paired median of the blocks). "Processor" is Quality as the app runs it there (standard compression);
"light compression" is what Quality's own rule already picks on a slow project without a chip. The lab's paired medians for the five
typical projects (the first five rows) read 1.36, 1.39, 1.38, 1.88 and 1.05 without a chip and 0.89, 0.90, 0.97, 0.98 and 0.92 with
one, all flagged busy. The blocks are not steady: on the phone reel, horizontal HD and 60 fps projects they are 22, 13 and 26 percent
apart, and the lab asks for a third block on the 60 fps project. So three of the five typical projects sit at 1.3 to 1.4 without a
chip, the 60 fps project at 1.9 to 2.1 and the slideshow at 1.05; with a chip none is above 1.0.

- Light compression alone is 1.3 to 1.4 times faster than standard on plain projects, the chip alone 1.4 to 2.15 (1.1 on the
  zoom-heavy reel). Fast without a chip is mostly the light compression: beside Quality's own light compression it reads 0.96 to
  1.04 on the plain two-minute and the 4K projects ((1.2) at 60 fps), and with a chip it adds nothing (0.85 to 1.01).
- On an emulated weak PC (the same laptop limited to 4 of 16 processors and 4.7 GB free; single runs, and the lab's validity gate for
  that profile failed on its first block, so indications only) Fast without a chip read 1.8 to 2.6 on four projects and Fast with a
  chip 0.79 to 0.89 on three of them (the fourth, the phone reel, whose block the lab flagged, read 1.05).
- On a chip PC the Fast command differs from the Quality command in one step (and `-r` at 60 fps) on the one-pass engine: the lanczos
  `scale`. It costs about 7 to 10 processor-milliseconds per frame drawn, a little more than the chip saves by encoding the smaller
  picture, so Fast took up to about 7 seconds longer than Quality on 2-minute exports (9 in one flagged block, and 5 seconds less in
  one horizontal-HD block: the noise is of that size). A cheaper resize filter was not tried.

## Consequences

- **We get:** a named choice for a smaller picture (and file); Quality unchanged to the byte; the 0.28.0 dialog as a fallback; one
  time-left answer wherever a time is said.
- **Time:** where no chip passes its test, the lab measured shorter Fast exports on plain projects (table; 1.8 to 2.6 on the weak
  emulation, indications only). Where a chip passes, Fast saves no time and can take a little longer (0.9 to 1.0 on the strong
  laptop, 0.8 to 0.9 on the weak emulation, one flagged cell 1.05); on 4K and many-clip projects it adds nothing to Quality's own
  light compression. No speed is claimed.
- **Proof:** a real-ffmpeg smoke test (`exportFast.smoke.e2e.ts`) compares the delivered files of a Quality and a Fast export on
  both engines (size, rate, frame count, streams, the encoder named in the file's own x264 text); the dialog, menu bar and Fast
  tests also run in production mode (the build's holds on), red before the lift commit and green after it; the new view was driven
  in Edge 157 on a production build of the dialog alone: 28 of 32 checks pass.
- **Not measured or tested:** macOS and Linux; NVIDIA and Intel chips (`h264_nvenc` and `h264_qsv` never ran on a real file);
  slower cores; a 4K source on a real file; the app itself with the choice on, and Try again after a real chip failure; an upgrade
  from a copied 0.27.0 profile (its flag cache has no `quick_route`, so the compiled "on" applies); a screen reader. The lab is one
  Windows laptop, AMD chip.
- **Residual:** a 60 to 30 fps conversion shows the picture 50 ms behind the sound and never shows the last four source frames (a
  Quality export typed by hand at 30 fps does the same); a streamed export whose file is under about 32 KB did not finish in 2 of 2
  runs (cause unproven); a render made in parts shows no time until its final encode, and none of the 88 recorded runs is made in
  parts, so that rule is proven on feeds relabelled from real runs; the 5- and 15-minute steps and the slow-run alarm have no
  real-data proof (the runs are at most 6.5 minutes); the three lists show no focus ring and "Show details" has 3.77:1 contrast, both
  0.28.0's styles, not changed here; the assistant's `export` reply and `manage_exports` list say how long an export is expected to
  take only when that time comes from this PC's own earlier exports, and nothing for a guess (`expectationForAssistant`), while the
  tool text still says the reply's note gives that time and that `time_left_s` is there "while it renders" (it can now be absent).

## Open questions

- **The word "Fast" where a chip passes its test.** There it changes the picture and the file, not the time. Options: neutral words
  around the choice (the summary names what changes, never a speed), offering the choice only where no chip passed, or leaving it.
- **A stall inflates the shown time.** When the picture stops for s seconds the slope of the last 20 s drops and the figure is
  multiplied by about 20 / (20 - s). With a stall built into 53 real runs at 40 % made, 10 s raised it by a median 1.5 times (up to
  3), 15 s by 3 times, 19 s by 10; it falls back when the stall leaves the window, and neither the alarm (about 30 s on a 150 s
  render) nor the 60 s quiet rule hides it. Options: accept it; or keep the shown figure while the newest 3 s made no progress
  (one function, `leftFromPace`).
- **"taking longer than expected" trips on a short stall and never clears.** From 40 % made, a stall of 15 s trips it in 13 of 53
  real runs, 30 s in 39, 60 s in 51; a render 3 times slower for a while and then normal trips it in 42 of 53 and keeps it to the
  end; on healthy runs it never fired. Options: accept it (the export did take longer); or release it once the 20 s pace has been
  back under the first figure's pace for a minute (the `longer` lines of `advance`). Both effects were measured by construction;
  how often a stall of 10 to 60 s happens is not known (in the lab's runs the longest no-picture stretch was 4.5 s at the 90th
  percentile, and 3 of 89 had one of 60 s or more).

## Rejected alternatives

- **A speed figure on the label:** none holds across the projects and PCs measured (0.8 to 2.6); it would need data from more than one machine class.
- **An "Are you sure?" question before a big Quality export:** it needs that figure and targets the projects where Fast adds least.
- **A Fast preset in the assistant's `export` tool:** a contract change (server first, a new catalog snapshot, evals) for a small gain; the tool
  already accepts a smaller `resolution`, a lower `fps` and a lower `quality`.
- **A "Switch to Fast" button on the slow-export banner:** a restart discards the progress made, and Fast's best ratio on typical projects is about 1.4 (1.9 to 2.1 at 60 fps).
- **Build small** (draw at the delivery size from the start): the one lever that moved 4K (about 120 s to 13 s with the chip, an upper
  bound: canvas set small by hand, text and effects not rescaled, quality not judged), but it changes the draw stage: deferred.
- **Light compression only inside Fast:** it would slow Quality for everyone (1.3 to 1.4 times on plain projects) and break the byte-identity pin.

## How to reverse (turn it off)

The switch has two places, and neither is a toggle that reaches every app.

1. **Server.** `config/export_flags.json` carries `"quick_route": true`. That is one server commit, not part of this repository: it
   must be deployed before any client that ships the choice, and `GET /client/export-flags` must list the name. The file is part of
   the server image, so turning the choice off is a server redeploy with the file changed, or a new revision with the server's
   flags-off lever. An app hears the server only while signed in and online (at start, before an export and about every ten minutes
   while open; the privacy text says so) and keeps the last answer across restarts, so "off" takes effect from the next opening of
   the dialog after the app has heard it, up to about ten minutes later. An app that is offline, signed out, or talking to an older
   server that does not list the name keeps its compiled "on": only a client release reaches it. A Fast pick already on its way
   when the answer arrives runs as Quality with the values the dialog showed.
2. **Client.** Revert the one commit that removes `"quick_route"` from `OFF_IN_THIS_BUILD` (with the test edits it carries); a build
   made without that commit holds the choice off whatever the server says.
3. **What comes back.** Off restores the whole 0.28.0 dialog, not only "no Fast choice": a Mode row ("Full quality / Fast", where
   Fast means the graphics chip) can still appear in it where no Graphics chip row is drawn. The time-left rule, the plain failure
   sentence, the Resolution-list rule, the renamed words and the keyboard fix are not behind the switch and stay. Quality's encoder
   policy (`exportEncoder.ts`) is untouched.

## References

- `src/timeline/`: `exportRoute.ts`, `routeDecide.ts`, `exportEncoder.ts`, `render.ts`, `exportTimeLeft.ts`, `exportWords.ts`, `exportChoiceView.ts`,
  `exportChoiceWords.ts`; `src/api/exportFlags.ts`; `src/store/exportJob.ts`; `src/components/`: `ExportSettingsView.tsx`, `ChoiceRow.tsx`,
  `AdvancedSettings.tsx`, `ExportDialog.tsx`, `MenuBar.tsx`
- Tests: `exportFullGuard.test.ts`, `exportFast.journey.test.ts`, `exportFast.smoke.e2e.ts`, `exportRoute.questionGuard.test.ts`, `routeDecide.test.ts`,
  `MenuBar.shipped.test.tsx`, `ExportDialog.timelineKeys.test.tsx`, `exportTimeLeft.test.ts`, `exportTimeLeft.replay.test.ts`
