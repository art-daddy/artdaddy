// Playback shows every frame of a video, to its last, in a REAL browser engine (UJ-034).
//
// preview-probe-stream.html drives the preview's own decoder (mp4box + WebCodecs) the way the
// preview worker does while playing - pump then nearestFrame, every tick - and reports which frame
// each source time showed. A clip two frames long never drew at all in playback: an H.264 decoder
// holds the last frames of a stream back to reorder them, and nothing told it the stream had ended.
//
// Fixtures: e2e/ui/fixtures/rotation/h264_rot0.mp4 (2 frames, npm run fixtures:rotation) and
// e2e/ui/fixtures/stream/ten_frames.mp4, made with the shipped ffmpeg:
//   ffmpeg -f lavfi -i testsrc2=s=64x48:r=30 -frames:v 10 -c:v libx264 -profile:v high -bf 3
//          -pix_fmt yuv420p -movflags +faststart ten_frames.mp4
// (frame types I B B B P B B B P P, has_b_frames=2, 512 ticks of 1/15360 s per frame).
import { type Page, expect, test } from "@playwright/test";

import type { StreamShot } from "../../src/preview/__probeStream";

let page: Page;
let shots: Record<string, StreamShot>;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("/preview-probe-stream.html");
  await page.waitForFunction(() => "__stream" in window, undefined, { timeout: 60_000 });
  shots = await page.evaluate(
    () => (window as unknown as { __stream: Record<string, StreamShot> }).__stream,
  );
  expect((shots as { error?: string }).error, "the probe failed to run").toBeUndefined();
});
test.afterAll(async () => {
  await page?.close();
});

const FRAME_US = 1e6 / 30;

test.describe("playback shows every frame of a video (real WebCodecs)", () => {
  for (const [name, frames] of [
    ["ten_frames", 10],
    ["two_frames", 2],
  ] as const) {
    test(`${name}: frame k is on screen at k/30 s, to the last`, () => {
      const shot = shots[name];
      expect(shot.error, shot.error).toBeUndefined();
      expect(shot.shown.length).toBe(frames);
      const missing = shot.shown.flatMap((ts, k) => (ts === null ? [k] : []));
      expect(missing, "frames never drawn in playback").toEqual([]);
      // Each the RIGHT frame: k frame-times after the first one shown. (Timestamps carry the
      // file's own start offset, so they are compared to frame 0, not to zero.)
      const base = shot.shown[0]!;
      shot.shown.forEach((ts, k) => {
        expect(Math.abs(ts! - base - k * FRAME_US), `frame ${k}`).toBeLessThanOrEqual(1);
      });
    });

    test(`${name}: the decoder says the media ends after its last frame`, () => {
      // Read off the sample table: the last frame starts at (frames-1)/30 s and lasts 1/30 s.
      expect(shots[name].end).toBeCloseTo(frames / 30, 6);
    });
  }
});
