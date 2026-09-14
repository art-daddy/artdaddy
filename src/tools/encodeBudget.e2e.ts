// The analysis encode must fit the budget of the thing that will READ it — measured, with real
// ffmpeg, because a `-maxrate` argument is not a file size.
//
// The bug this pins: `video_find_moment` accepts up to 30 minutes, but its encode was written with
// a fixed CRF and no size discipline, so a 12-minute film produced a 77.6 MB file and the 64 MB
// heap ceiling refused it — ten times in one real session, reported to the model as a refusal to
// read a cache filename it had never heard of. The two limits were set independently, which left a
// band the tool accepts and then cannot use.
//
// Uses a SMALL budget over a SHORT source rather than a 12-minute render: the rule under test is
// "the output fits the budget", and a source that overflows a small budget exercises it identically
// while staying a few seconds long. The control (no budget) is what proves the cap is doing the
// work rather than the source simply being small.
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encodeVideoForGemini } from "./geminiEncode";
import { ff, have, mkCtx, nodeRunner } from "./__e2e";

const DUR = 8;
const BUDGET = 400 * 1024; // small enough that an unconstrained encode of this source overshoots

let dir = "";
let src = "";
let ok = false;

beforeAll(async () => {
  ok = (await have("ffmpeg")) && (await have("ffprobe"));
  if (!ok) return;
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-encbudget-"));
  src = path.join(dir, "src.mp4");
  // Noise, not a solid colour: a flat source compresses to almost nothing and would fit ANY budget,
  // so the control would pass against a broken cap.
  await ff([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=1280x720:rate=30:duration=${DUR}`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    src,
  ]);
});

afterAll(async () => {
  if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

const sizeOf = async (p: string): Promise<number> => (await fsp.stat(p)).size;

describe("gemini encode budget (real ffmpeg)", () => {
  it("lands the encoded file inside the byte budget it was given", async () => {
    if (!ok) return;
    const ctx = mkCtx(dir);
    const out = await encodeVideoForGemini(ctx, src, {
      fps: 8,
      maxDim: 720,
      keepAudio: false,
      tag: "budget",
      budget: { maxBytes: BUDGET, durationS: DUR },
    });
    expect(await sizeOf(out)).toBeLessThanOrEqual(BUDGET);
  });

  // Without this the test above would pass on any source that happens to be small, and the cap
  // could be a no-op. The same encode WITHOUT a budget must overshoot.
  it("...and the same encode without a budget does NOT", async () => {
    if (!ok) return;
    const ctx = mkCtx(dir);
    const out = await encodeVideoForGemini(ctx, src, {
      fps: 8,
      maxDim: 720,
      keepAudio: false,
      tag: "nobudget",
    });
    expect(await sizeOf(out)).toBeGreaterThan(BUDGET);
  });

  it("still decodes: the capped file is a real video, not a truncated one", async () => {
    if (!ok) return;
    const ctx = mkCtx(dir);
    const out = await encodeVideoForGemini(ctx, src, {
      fps: 8,
      maxDim: 720,
      keepAudio: false,
      tag: "budget",
      budget: { maxBytes: BUDGET, durationS: DUR },
    });
    const r = await nodeRunner.run("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "format=duration:stream=width,height",
      "-of",
      "json",
      out,
    ]);
    expect(r.code).toBe(0);
    const probe = JSON.parse(r.stdout) as {
      format: { duration: string };
      streams: { width: number; height: number }[];
    };
    // A cap that silently truncated the video would be worse than the refusal it replaced.
    expect(Number(probe.format.duration)).toBeGreaterThan(DUR - 1);
    expect(probe.streams[0].height).toBe(720);
  });
});
