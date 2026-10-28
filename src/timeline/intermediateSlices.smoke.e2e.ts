// The sliced lossless intermediate of a streamed export, held to the real ffmpeg.
//
// A partition producer's last stage is an FFV1 encode, and intermediateSlices() decides how many slices it is cut into. ffv1
// REFUSES a slice count it dislikes ("Unsupported number 4 of slices requested") and a refusal ends the export, so the rule
// is only as good as what the shipped ffmpeg accepts. For every size the rule slices, the sliced encode must succeed and
// must decode to exactly the frames the single-thread encode decodes to; every size it leaves alone must still encode on one
// thread (that is the fallback, and what every export did before). Frames carry noise so a slice cannot be trivially empty,
// and several sizes span the encoder's keyframe interval so state carried from frame to frame is exercised too.
//   npx vitest run --config vitest.smoke.config.ts src/timeline/intermediateSlices.smoke.e2e.ts
import os from "node:os";
import { promises as fsp } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { nodeRunner } from "../tools/__e2e";
import { joinPath } from "../tools/store";
import { intermediateSlices } from "./render";

const ROOT = joinPath(os.tmpdir(), `artdaddy-slices-${Date.now()}`);

beforeAll(() => fsp.mkdir(ROOT, { recursive: true }));
afterAll(() => fsp.rm(ROOT, { recursive: true, force: true }).catch(() => undefined));

// [width, height, frames]; 13+ frames cross ffv1's default keyframe interval of 12
const sizes: [number, number, number][] = [
  // the edges of the window the rule slices
  [64, 64, 26],
  [66, 66, 26],
  [64, 1080, 14],
  [1080, 64, 14],
  [4096, 4096, 2],
  [8192, 2048, 2],
  [2048, 8192, 2],
  // what people export, 4K being the promised line
  [1280, 720, 14],
  [1366, 768, 14],
  [1920, 1080, 14],
  [1080, 1920, 14],
  [3840, 2160, 4],
  [4096, 2160, 4],
  [2160, 3840, 4],
  [5120, 2880, 2],
  // outside the window: the single-thread fallback must still work
  [2, 2, 14],
  [62, 62, 14],
  [63, 1080, 14],
  [4098, 4096, 1],
  [7680, 4320, 1],
];

const source = (width: number, height: number, frames: number): string[] => [
  "-f",
  "lavfi",
  "-i",
  `testsrc2=s=${width}x${height}:r=30:d=${(frames / 30).toFixed(6)},format=yuv420p,noise=alls=20:allf=t:all_seed=7`,
];

async function encode(
  width: number,
  height: number,
  frames: number,
  output: string[],
  file: string,
): Promise<void> {
  const r = await nodeRunner.run("ffmpeg", [
    "-y",
    "-nostdin",
    "-v",
    "error",
    ...source(width, height, frames),
    "-an",
    "-c:v",
    "ffv1",
    "-pix_fmt",
    "yuv420p",
    ...output,
    "-f",
    "nut",
    file,
  ]);
  expect(r.code, r.stderr.slice(-600)).toBe(0);
}

async function frameHashes(file: string): Promise<string[]> {
  const r = await nodeRunner.run("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-i",
    file,
    "-f",
    "framemd5",
    "-",
  ]);
  expect(r.code, r.stderr.slice(-600)).toBe(0);
  return r.stdout
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(",").at(-1)!.trim());
}

describe("sliced lossless intermediate against the shipped ffmpeg", () => {
  it("the walk reaches both sides of the rule, or it proves nothing about the boundary", () => {
    const sliced = sizes.filter(([w, h]) => intermediateSlices(w, h) > 0).length;
    expect(sliced).toBeGreaterThan(10);
    expect(sizes.length - sliced).toBeGreaterThanOrEqual(5);
  });

  it.each(sizes)("%ix%i (%i frames)", async (width, height, frames) => {
    const slices = intermediateSlices(width, height);
    const label = `${width}x${height}`;
    const reference = joinPath(ROOT, `${label}-reference.nut`);
    const sliced = joinPath(ROOT, `${label}-sliced.nut`);
    try {
      await encode(width, height, frames, ["-threads:v", "1"], reference);
      const expected = await frameHashes(reference);
      expect(expected.length, label).toBe(frames);
      if (slices === 0) return;
      await encode(
        width,
        height,
        frames,
        ["-slices", String(slices), "-threads:v", String(slices)],
        sliced,
      );
      expect(await frameHashes(sliced), label).toEqual(expected);
    } finally {
      await fsp.rm(sliced, { force: true });
      await fsp.rm(reference, { force: true });
    }
  });
});
