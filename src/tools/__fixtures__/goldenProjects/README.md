# Golden projects

Project folders written by older releases of the app, used by `src/tools/project.goldens.test.ts` to prove
that every project people saved still opens with everything it held.

Each `<release>/appdata/<data folder>/` is the app-data folder exactly as that release's own code left it
on a Windows PC (`C:/Users/golden/AppData/Roaming/<data folder>`): `projects.json` and two projects,
one with a full edit (owned video, audio and a still, a linked file outside the project, a split,
linked audio, colour, a transform, keyframes, a crossfade, an effect, a muted track and a title) and one
with only a title on the default canvas. The media files are placeholder bytes, not media: opening a
project never decodes them. `golden.json` records which commit wrote the folder, the clock it was given,
and what that same release read back when it reopened each project; the test expects this build to read
back the same.

Do not edit these files and never regenerate one to make a test pass: a test that fails here means a
project someone saved no longer opens the way it did. Find out why.

## How they were made

For a release whose commit is `<commit>`:

1. `git archive --format=tar -o r.tar <commit> src scripts vitest.config.ts tsconfig.json package.json`
   (and `src-tauri/resources/brand` where the commit has it), extracted into a scratch folder inside a
   checkout, so the checkout's `node_modules` resolve.
2. `generator.ts.txt` (in this folder) copied into that tree as `src/__golden_gen.test.ts`.
3. `npx vitest run --root <scratch> src/__golden_gen.test.ts` with `GOLDEN_VERSION`, `GOLDEN_REF` (the
   commit), `GOLDEN_DATE` (the commit's date: the clock the old code sees), `GOLDEN_OUT` and
   `GOLDEN_FEATURES` (`hold` from 0.3.0, `stretch` from 0.21.6, `auto` from 0.23.0: what the release
   could do that 0.2.0 could not).

The generator calls only the old release's own code: its `dataRoot.ts` (which names the data folder),
`ProjectRegistry.createProject`, `register` and `setActive`, `ensureStarterTimeline`,
`registerLibraryClip` and the timeline tools through its `ClientToolRegistry`. `golden.json` is its
`generated.json` without the second read.

## Which releases

The generator was run on 43 releases, 0.2.0 to 0.29.1: every one whose source was available to build.
They wrote six formats; the folder kept for each is the first release that wrote it, plus the release in
use today. `sameFormatAs` in each `golden.json` lists the releases whose output had the same files,
fields and track layout.

| Folder | Commit | Same format | What changed |
| --- | --- | --- | --- |
| 0.2.0 | 9a30d5b2 | 0.2.0 to 0.2.3 | the first release that updates itself; data folder `Akaru`; four starter tracks |
| 0.3.0 | be5ba652 | 0.3.0 to 0.6.0 | keyframes can `hold` |
| 0.7.0 | 15f32766 | 0.7.0, 0.8.0 | data folder renamed `ArtDaddy` |
| 0.12.1 | 3ae78fba | 0.12.1 to 0.21.5 | two starter tracks |
| 0.21.6 | 2b66e6ad | 0.21.6 to 0.22.1 | a clip can `stretch` to fill the frame |
| 0.23.0 | 830a3b01 | 0.23.0 to 0.29.1 | a new project can leave its canvas to the first video (`canvas_auto`) |
| 0.29.1 | 3911d9b5 | 0.29.1 | the release in use today |

Not covered: releases 0.9.0 to 0.12.0, whose source was not available to build (their formats lie
between 0.7.0's and 0.12.1's, both kept); development builds from before 21 July 2026, which kept a
project's files in a `.akaru` folder that no release reads; and chats, which the generator does not write.
