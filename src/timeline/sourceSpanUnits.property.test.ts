import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";

import { makeRunner, seededCtx } from "../test/timelineKit";
import { applyOp, loadTimeline } from "./engine";
import {
  addClipsTool,
  clearDurationCache,
  clearHasAudioCache,
  clearHasVideoCache,
} from "./placement";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// source_span (SECONDS) sits beside timeline_in/timeline_out (FRAMES) in one add_clips entry.
// Across real frame rates, both directions of the unit guard:
//   - a CORRECT seconds span with the frame length it implies is never refused and lands at
//     that length — a guard that fires on good input would break every well-formed call;
//   - raw FRAME numbers passed as seconds, alongside the frame length they imply, are always
//     refused and nothing lands — including when both numbers fall inside the media, the case
//     that used to succeed silently with a clip ~fps times too long.
// And the EOF clamp: a span running past the end lands at the length that actually exists, and
// says so only when it was shortened.

const MEDIA_S = 600;
const FPS = fc.constantFrom(24, 25, 30, 60);

const runner = makeRunner((p, a) => {
  if (p !== "ffprobe") return { code: 0, stdout: "", stderr: "" };
  if (a.includes("-select_streams")) {
    return { code: 0, stdout: a[a.indexOf("-select_streams") + 1] === "v" ? "1" : "", stderr: "" };
  }
  return { code: 0, stdout: `${MEDIA_S}\n`, stderr: "" };
});

beforeEach(() => {
  clearHasAudioCache();
  clearHasVideoCache();
  clearDurationCache();
});

async function project(fps: number) {
  const { ctx, store } = await seededCtx(runner);
  await applyOp(store, "fps", (t) => {
    t.canvas.fps = fps;
  });
  return { ctx, store };
}

async function lengths(store: Any): Promise<number[]> {
  const tl = await loadTimeline(store);
  return tl.tracks.flatMap((t) =>
    (t.clips ?? []).map((c) => (c.timeline_out as number) - (c.timeline_in as number)),
  );
}

describe("source_span units across frame rates", () => {
  it("never refuses a correct seconds span, and lands it at the length it implies", async () => {
    await fc.assert(
      fc.asyncProperty(
        FPS,
        fc.integer({ min: 0, max: 5000 }).map((n) => n / 10), // start, 0.1s steps
        fc.integer({ min: 1, max: 600 }).map((n) => n / 10), // length 0.1s..60s
        async (fps, s0, len) => {
          fc.pre(s0 + len <= MEDIA_S);
          const { ctx, store } = await project(fps);
          const want = Math.round(len * fps);
          fc.pre(want >= 1);
          const r = (await addClipsTool(
            {
              entries: [
                {
                  media_ref: "clip.mp4",
                  timeline_in: 0,
                  timeline_out: want,
                  source_span: [s0, s0 + len],
                },
              ],
            },
            ctx,
          )) as Any;
          expect(r.ok, String(r.error)).toBe(true);
          const [got] = await lengths(store);
          expect(Math.abs(got - want)).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("always refuses frame numbers passed as seconds, and places nothing", async () => {
    await fc.assert(
      fc.asyncProperty(
        FPS,
        fc.integer({ min: 0, max: 500 }),
        fc.integer({ min: 2, max: 90 }),
        async (fps, a, n) => {
          const b = a + n; // both inside the media when read as seconds: the silent case
          fc.pre(b <= MEDIA_S);
          const { ctx, store } = await project(fps);
          const r = (await addClipsTool(
            {
              entries: [
                { media_ref: "clip.mp4", timeline_in: 0, timeline_out: n, source_span: [a, b] },
              ],
            },
            ctx,
          )) as Any;
          expect(r.ok).toBe(false);
          expect(String(r.error)).toMatch(/look like FRAMES/);
          expect(await lengths(store)).toEqual([]);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("lands a span running past the end at the length that exists, noting it only then", async () => {
    await fc.assert(
      fc.asyncProperty(
        FPS,
        fc.integer({ min: 0, max: 5900 }).map((n) => n / 10),
        fc.integer({ min: 1, max: 1200 }).map((n) => n / 10),
        async (fps, s0, len) => {
          const { ctx, store } = await project(fps);
          const r = (await addClipsTool(
            { entries: [{ media_ref: "clip.mp4", timeline_in: 0, source_span: [s0, s0 + len] }] },
            ctx,
          )) as Any;
          expect(r.ok, String(r.error)).toBe(true);
          const exists = Math.round(Math.min(s0 + len, MEDIA_S) * fps) - Math.round(s0 * fps);
          const [got] = await lengths(store);
          expect(Math.abs(got - exists)).toBeLessThanOrEqual(1);
          const noted = /past the media/.test(((r.notes ?? []) as string[]).join(" "));
          expect(noted).toBe(Math.round((s0 + len) * fps) > Math.round(MEDIA_S * fps));
        },
      ),
      { numRuns: 60 },
    );
  });
});
