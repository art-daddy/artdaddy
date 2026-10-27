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
import { type Browser, type Page, expect, test } from "@playwright/test";

import type { StreamShot, WorkerSeekResult } from "../../src/preview/__probeStream";
import { ProbeStalled, retryStalledProbe, seekStall } from "../../src/test/probeRetry";

let page: Page;
let shots: Record<string, StreamShot>;
let liveSeek: WorkerSeekResult;

// macos-14's decoders stall, and a page that drew nothing is no verdict (CI, 2026-10-20 and
// 2026-10-27: a black canvas after the seek to 2.9 s, on the worker and on the main thread alike).
// Such a page is replaced and asked once more. A wrong picture, an error the preview reported, a
// probe that fails to run, or a page that draws nothing on EVERY try still fails.
const TRIES = 2;
const PROBE_LIMIT_MS = 60_000;

/** A fresh probe page, loaded until it has reported. One that reports nothing in time stalled. */
async function openProbe(browser: Browser, query = ""): Promise<Page> {
  const probe = await browser.newPage();
  try {
    await probe.goto(`/preview-probe-stream.html${query}`);
    try {
      await probe.waitForFunction(() => "__stream" in window, undefined, {
        timeout: PROBE_LIMIT_MS,
      });
    } catch (error) {
      throw new ProbeStalled(
        `the probe reported nothing in ${PROBE_LIMIT_MS / 1000} s: ${String(error)}`,
        "load",
      );
    }
    return probe;
  } catch (error) {
    await probe.close();
    throw error;
  }
}

async function readProbe(probe: Page) {
  const { streams, seek } = await probe.evaluate(() => {
    const reported = window as unknown as {
      __stream: Record<string, StreamShot>;
      __workerSeek: WorkerSeekResult;
    };
    return { streams: reported.__stream, seek: reported.__workerSeek };
  });
  expect((streams as { error?: string }).error, "the probe failed to run").toBeUndefined();
  return { streams, seek };
}

const stalledAt = (stall: { time: number; waitedMs: number }) =>
  new ProbeStalled(
    `no picture at ${stall.time} s after ${stall.waitedMs} ms`,
    `seek-${stall.time}`,
  );

const logStall = async (stalled: ProbeStalled, tryNumber: number) => {
  console.log(
    `stream-probe-stalled try=${tryNumber} stage=${stalled.stage}: ${stalled.message}; trying again on a fresh page`,
  );
};

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  const loaded = await retryStalledProbe(
    async (tryNumber) => {
      const probe = await openProbe(browser);
      let kept = false;
      try {
        const { streams, seek } = await readProbe(probe);
        // The last try keeps what it saw: a worker that never draws then fails its own test, and
        // not every test in the file.
        const stall = tryNumber < TRIES ? seekStall(seek) : null;
        if (stall) throw stalledAt(stall);
        kept = true;
        return { probe, streams, seek };
      } finally {
        if (!kept) await probe.close();
      }
    },
    logStall,
    TRIES,
  );
  page = loaded.probe;
  shots = loaded.streams;
  liveSeek = loaded.seek;
});
test.afterAll(async () => {
  await page?.close();
});

const FRAME_US = 1e6 / 30;

test("backward seek replaces the live worker picture with the original early frame", async () => {
  const result = liveSeek;
  await test.info().attach("live-worker-seek-pixels", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  expect(result.errors).toEqual([]);
  expect(["worker", "main-thread"]).toContain(result.backend);
  expect(result.shots).toHaveLength(5);
  for (const shot of result.shots) {
    expect(shot.matched, `seek ${shot.time}: actual pixel ${shot.pixel}`).toBe(true);
  }
});

test("unavailable worker graphics use the same live preview frames on the main thread", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const actual = await retryStalledProbe(
    async (tryNumber) => {
      const fallback = await openProbe(browser, "?forceWorkerUnavailable=1");
      try {
        const { seek } = await readProbe(fallback);
        await test.info().attach(`fallback-seek-pixels-try-${tryNumber}`, {
          body: JSON.stringify(seek, null, 2),
          contentType: "application/json",
        });
        const stall = seekStall(seek);
        if (stall) throw stalledAt(stall);
        return seek;
      } finally {
        await fallback.close();
      }
    },
    logStall,
    TRIES,
  );
  expect(actual.backend).toBe("main-thread");
  expect(actual.errors).toEqual([]);
  expect(actual.shots).toHaveLength(5);
  expect(actual.shots.every((shot) => shot.matched)).toBe(true);
  expect(actual.shots.map(({ time, pixel }) => ({ time, pixel }))).toEqual(
    liveSeek.shots.map(({ time, pixel }) => ({ time, pixel })),
  );
});

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
