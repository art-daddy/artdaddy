# Media library, import and preview: browser tests

These tests bring media in and look at it the way a person does: the library's + button, File > Import Media (linked
or copied), a file dropped from Explorer onto the library or a track, a damaged file, a file the app does not open,
Cancel, a folder that moved and one Relink for it, Copy into project, the List view, a clip opened in its own tab, a
clip sent to the chat; and the live preview: the first picture, the transport, the ruler, the step keys, Play, Pause,
Space, playing to the end, the sound on the master meter, a cut, the zoom, an HEVC phone video, an empty project and a
machine with no WebGL2. They judge what the person gets: the screen (the stage's pixels, read from a screenshot) and
the saved project (`internals/library.json`, `internals/timeline.json`, the project's own `library/` folder).

```
npm run e2e:ui -- e2e/ui/media-library e2e/ui/preview
```

## How it works

They run on the agent lane's rig (`../agent-and-models/lib/qa.ts`: a fake ArtDaddy server and a QA shell standing in
for the desktop side; its README says how) with these additions, in `lib/media.ts`:

- **A drop from the OS** is raised the way Tauri raises it: `tauri://drag-enter`, `-over` and `-drop` with the file's
  path and the position in physical pixels, so the app's own router (`src/lib/osDrop.ts`) finds the zone under that
  point. The real OLE drag from Explorer is the desktop lane's (`e2e/desktop/osdrop*.desktop.mjs`) and a by-hand script
  (`e2e/byhand/media-library/drop-and-relink.md`).
- **The asset protocol is served as Tauri serves it** (`serveAssetsLikeTauri`): a byte range gets a 206, at most 1 MB
  at a time, readable from the preview's worker. The shell's own route sends the whole file for every request, so the
  decoder read the wrong bytes and the stage kept showing the poster.
- **The internet is shut for the whole browser context**, not only the page: the speech model's download (the app asks
  for it when a video comes in) got past the shell's page route and fetched up to 100 MB from huggingface.co per test.
- **Moving a folder** behind the app's back (`moveFolder`), after the project is closed and every ffmpeg run has ended,
  as a person tidying their drive does.

The media are made by `fixtures/make.mjs` with the shipped ffmpeg. The main clip, `rgb_3s.mp4`, is red for its first
second, green for its second and blue for its third, with a tone: a picture says which second is on screen, so the
preview is checked against the time the transport reads, with no reference image. Whole-frame preview against export
is the parity lane's (`e2e/ui/parity.spec.ts`).

The preview tests skip WebKit on Windows (no WebGL2, no WebCodecs there), as the config does for the older pixel
specs. Known bugs are marked with `knownBug` (from the agent lane's rig): the test fails today for that reason only,
and turns red the day the bug is fixed.

## Waits

Recorded with the shared helper (`e2e/lib/timing`): `import: one video linked to its library tile`, `import: a dropped
video to its library tile`, `preview: open a project to its first picture`, `preview: seek to a new picture` and
`preview: an HEVC clip to its first true picture`, each with the browser in its name.
