# ADR 0002 — Export dialog: the Quality / Fast choice

- **Status:** Proposed (built, not yet released)
- **Date:** 2026-11-19
- **Baseline:** `akaru-client` @ `63ff3ead` (the 0.28.0 tree `32df78e3`, the Fast core and the new
  Export dialog without the choice)
- **Switch:** `quick_route` — client `src/api/exportFlags.ts` (`OFF_IN_THIS_BUILD`), server
  `config/export_flags.json`
- **Quality guard:** `src/timeline/exportFullGuard.test.ts` with its frozen fixture
  `src/timeline/__fixtures__/exportFullGuard.sha256.json`
- **Measurements:** one AMD laptop (16 processors, Radeon 780M), lab of 18 Nov 2026, figures as read
  from the lab's matrix on 19 Nov 2026 at 01:04 (tables are kept outside the repository)

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
   and the app's own restart keep the route of the export they continue; after a chip failure the
   restart of a Fast export runs on the processor's standard encoder.

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
- **Nothing new is reported.** The export record carries `route: "quick"`; the report builder picks
  named fields and does not read it (a journey test compares the key sets).

## Why Fast is a modest gain

Fast shrinks the picture after every frame is drawn at the project's own size: `render.ts` applies the
delivery size as one `scale` at the end of the composite and the delivery rate as the `-r` output
option. Reading and drawing cost what they cost for Quality; Fast shrinks only the compression share,
and the chip makes that share nearly free. Time ratios (Quality seconds divided by Fast seconds; above 1
Fast is faster), one laptop, strong profile, every run flagged busy (other programs used 3.5 to 11.3
cores):

| Project (length tested)              | Fast vs Quality, processor | Fast vs Quality's light compression | Fast vs Quality, chip |
| ------------------------------------ | -------------------------- | ----------------------------------- | --------------------- |
| Phone reel 1080x1920 at 30 (2 min)   | 1.40                       | 1.08                                | 0.89                  |
| Talking head, captions (2 min)       | 1.38                       | 1.00                                | 0.88                  |
| Horizontal HD, crossfades (2 min)    | 1.35                       | 1.04                                | 0.99                  |
| HD at 60 fps (2 min)                 | 2.10                       | (1.20)                              | 0.98                  |
| Zoom-heavy real reel (2 min)         | 1.07                       | not measured                        | 0.99                  |
| 4K at 30, 3 clips, streamed (30 s)   | 1.36                       | 0.98                                | 1.01                  |
| 4K at 60, 2 clips, streamed (20 s)   | 1.34                       | 1.01                                | not measured          |
| 36-clip HD edit, streamed (2 min)    | (2.39)                     | (1.11)                              | (0.99)                |

Brackets: every run of that figure is in a block the lab flagged or in an unfinished segment. A
slideshow block was flagged too and is left out. "Processor" is Quality as the app runs it there
(standard compression); "light compression" is what Quality's own rule already picks on a slow
project without a chip.

- Light compression alone is 1.27 to 1.38 times faster than standard on plain projects, the chip alone
  1.42 to 2.15 times (1.11 on the zoom-heavy reel). Fast without a chip is mostly the light
  compression; the smaller picture adds 0 to 8 percent beyond it on plain projects, and nothing
  beyond the chip (0.88 to 1.01).
- On 4K and many-clip projects Fast is no faster than Quality's own light compression (0.98 to 1.11).
  A second size step on 4K moved the chip time by under 1 percent (118.0 s to 118.1 s).
- On an emulated weak PC (the same laptop limited to 4 of 16 processors and 4.7 GB free; three valid
  blocks so far: a talking head, horizontal HD, HD at 60 fps) Fast without a chip was 1.8 to 2.6 times
  faster than Quality; Fast with the chip was slower than Quality with the chip (ratios 0.79 to 0.89).
- On a chip PC the Fast command differs from the Quality command in one step (and `-r` at 60 fps) on
  the one-pass engine: the lanczos `scale`. It costs about 7 to 10 processor-milliseconds per frame
  drawn, a little more than the chip saves by encoding the smaller picture, so Fast took up to about
  6 seconds longer than Quality on 2-minute exports. A cheaper resize filter was not tried.
- Only drawing at the delivery size from the start moved a big project: 4K at 30 fps from about 120 s
  to about 13 s with the chip, the phone reel from about 51 s to 48 s. That is an upper bound: the
  canvas was set small by hand, text and effects were not rescaled, picture quality was not judged, and
  part of the 4K gain is the app leaving its slower streamed engine.
- The explanation above is read from the code and the timings. A direct read, draw and compress time
  split has not been measured.

## Consequences

- **We get:** a named choice for a smaller picture and file; on processor-only PCs, plain projects
  export 1.3 to 1.4 times faster on the strong laptop (2.1 at 60 fps) and 1.8 to 2.6 times on the
  emulated weak one; Quality unchanged to the byte; the 0.28.0 dialog as a fallback.
- **We do not get:** a speed claim. With a working chip Fast takes about as long as Quality on the
  strong laptop (0.88 to 1.01) and longer on the emulated weak one (0.79 to 0.89), and only delivers
  a smaller picture and file; on 4K and many-clip projects it adds nothing to Quality's own light
  compression.
- **Residual:** the unit tests assert the command handed to the app process, not rendered pixels (the
  real-ffmpeg smoke suite is where output files are checked); one laptop and one chip maker; slower
  cores, NVIDIA and Intel chips, macOS and Linux are not measured; the figure and the question screens
  are not built (only their pure rules).

## Rejected alternatives

- **A speed figure on the label.** No figure holds across the projects and PCs measured (0.79 to 2.6),
  so none is claimed.
- **An "Are you sure?" question before a big Quality export.** It needs that figure and targets the
  projects where Fast adds least (4K, 60 fps, many clips).
- **A Fast preset in the assistant's `export` tool.** A new parameter changes the tool contract (server
  first, a new catalog snapshot, evals) for a small gain; the tool already accepts a smaller
  `resolution`, a lower `fps` and a lower `quality`.
- **A "Switch to Fast" button on the slow-export banner.** A restart discards the progress already
  made, and Fast gains about 1.4 times at best on typical projects (2.1 at 60 fps);
  `quickAvailable()` stays false.
- **Build small** (draw at the delivery size from the start). The one lever that moved 4K, but it
  changes the draw stage (text sizes and pixel-valued effects need care, Quality must stay
  byte-identical): deferred, with its upper-bound measurement recorded.
- **Light compression only inside Fast.** Moving it out of Quality's policy would slow Quality for
  everyone (1.27 to 1.38 times on plain projects) and break the byte-identity pin.

## How to turn it off

1. **Server, no release:** set `"quick_route": false` in `config/export_flags.json` and deploy the
   server. The next opening of the dialog is the 0.28.0 dialog (the app reads the switch once per
   opening), and a Fast slot already on its way is read as no pick, so the export is Quality.
2. **Client, next release:** revert the one commit that removes `"quick_route"` from
   `OFF_IN_THIS_BUILD` (with the test that pins the set); the build then holds the choice off
   whatever the server says.
3. The Fast pieces are additive: the 0.28.0 dialog stays in `ExportDialog.tsx` and is drawn whenever
   the switch is off, and Quality's encoder policy (`exportEncoder.ts`) is untouched.

To add the figure or the question later: fill `QUICK_BUNDLE.speedup`, build the question screen first
(the guard test says so), and re-measure on more than one laptop.

## References

- `src/timeline/exportRoute.ts` (bundle and rules), `routeDecide.ts`, `exportEncoder.ts`, `render.ts`
- `src/components/ExportSettingsView.tsx`, `ChoiceRow.tsx`, `AdvancedSettings.tsx`, `ExportDialog.tsx`,
  `MenuBar.tsx`; `src/timeline/exportChoiceView.ts`, `exportChoiceWords.ts`
- Tests: `exportFullGuard.test.ts`, `exportFast.journey.test.ts`, `routeDecide.test.ts`,
  `exportRoute.test.ts`, `ExportSettingsView.quality.test.tsx`
