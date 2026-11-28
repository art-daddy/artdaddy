# Video understanding: browser tests of the looks

What the assistant sees and is told when it looks at footage, judged on what the app SENT (the
pictures, measured for colour with the shipped ffmpeg; the clip a paid look sends, probed) and what it
told the model (the times, in project frames for a placed clip and source seconds for a library asset).

```
npm run e2e:ui -- e2e/ui/video-understanding
```

- **The free looks** (`looks.spec.ts`: `inspect_media`, `inspect_timeline`, `inspect_color`) run for
  real through the QA shell's shipped ffmpeg. The clip (`../captions-and-transcription/fixtures/media`)
  is red, then green, then blue, so a picture of the wrong moment, or one with no colour, shows.
- **The paid looks** (`paidLooks.spec.ts`: `video_ask`, `video_find_moment`) run for real up to the
  vision proxy: the app asks first, encodes the clip with the shipped ffmpeg and posts it. The proxy
  (`/ai/vision_video` on the agent lane's fake server) answers with what the vision model would have
  written (`lib/vision.ts`), in the server's own shape. No vendor is ever reached. The real service is
  checked only at a release, by hand and with the owner's yes
  (`e2e/byhand/video-understanding/paid-looks-real.md`).

The assistant runs on scripted replies (`../agent-and-models/lib`). These tests are tool logic that
runs the same in every engine, so they run in Chromium only; the approval card itself is tested in
both engines by the agent lane. Known bugs are expected failures marked with `knownBug`, which must
fail the way the bug shows.
