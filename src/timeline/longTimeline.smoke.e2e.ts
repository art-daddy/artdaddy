// A long timeline exports (3f). Each clip is its own ffmpeg input with its own filter chain, so
// the command grows with the clip count: 80 clips passed Windows' 32,767-character limit on a
// command line, and every export of a montage that long failed to START ("The filename or
// extension is too long. (os error 206)"), reproduced in the app with 120 clips. This drives the
// real export door with that shape and reads every clip back out of the delivered file.
//
// It cannot show UJ-020 (the macOS open-file limit): Node raises its own limit at startup and its
// children inherit that, so an ffmpeg spawned here never sees the 256 an app gets. The Rust test
// in src-tauri/src/fdlimit.rs is that proof.
//   npx vitest run --config vitest.smoke.config.ts src/timeline/longTimeline.smoke.e2e.ts
import os from "node:os";
import { promises as fsp } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ff,
  installE2EDocuments,
  libRef,
  mkCtx,
  nodeFs,
  nodeRunner,
  openE2EDoc,
  resetE2EDocuments,
} from "../tools/__e2e";
import { joinPath } from "../tools/store";
import { ensureTimeline } from "./engine";
import { setCanvasTool } from "./ops";
import { addClipsTool } from "./placement";
import { exportTimelineTool } from "./render";
import { whenExportEnds } from "./exportQueue";

type Rec = Record<string, unknown>;

const ROOT = joinPath(os.tmpdir(), `artdaddy-longtl-${Date.now()}`);
const CLIPS = 120;
const LEN = 5; // frames per clip

beforeAll(() => installE2EDocuments());
afterAll(async () => {
  await resetE2EDocuments();
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
});

/** Mean chroma of each frame of `file`, in order. */
async function chroma(file: string): Promise<{ u: number; v: number }[]> {
  const r = await nodeRunner.run("ffmpeg", [
    "-v",
    "error",
    "-i",
    file,
    "-vf",
    "signalstats,metadata=print:file=-",
    "-f",
    "null",
    "-",
  ]);
  const out: { u: number; v: number }[] = [];
  let u = NaN;
  for (const line of r.stdout.split(/\r?\n/)) {
    const mu = /UAVG=([\d.]+)/.exec(line);
    if (mu) u = Number(mu[1]);
    const mv = /VAVG=([\d.]+)/.exec(line);
    if (mv) out.push({ u, v: Number(mv[1]) });
  }
  return out;
}

describe("a montage of 120 short clips", () => {
  it("exports, and every clip is in the file where the timeline puts it", async () => {
    const dir = joinPath(ROOT, "montage");
    await nodeFs.mkdir(dir);
    await openE2EDoc(dir);
    const ctx = mkCtx(dir);
    await ensureTimeline(ctx.store);
    expect(((await setCanvasTool({ width: 160, height: 90, fps: 30 }, ctx)) as Rec).ok).toBe(true);
    const red = joinPath(dir, "a phone clip from the summer holiday (red).mp4");
    const blue = joinPath(dir, "a phone clip from the winter holiday (blue).mp4");
    for (const [file, c] of [
      [red, "red"],
      [blue, "blue"],
    ] as const)
      await ff(["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${c}:s=160x90:r=30:d=1`, file]);
    const refs = [await libRef(ctx, red, "video"), await libRef(ctx, blue, "video")];
    const entries = Array.from({ length: CLIPS }, (_, i) => ({
      media_ref: refs[i % 2],
      timeline_in: i * LEN,
      timeline_out: (i + 1) * LEN,
      with_audio: false,
    }));
    const placed = (await addClipsTool({ entries }, ctx)) as Rec;
    expect(placed.ok, JSON.stringify(placed).slice(0, 400)).toBe(true);

    const res = (await exportTimelineTool({ name: "montage" }, ctx)) as Rec;
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const ended = await whenExportEnds(String(res.job_id));
    expect(ended?.state, JSON.stringify(ended)).toBe("done");

    const frames = await chroma(await ctx.store.exportPath("montage.mp4"));
    expect(frames.length).toBeGreaterThanOrEqual(CLIPS * LEN);
    const wrong: string[] = [];
    for (let i = 0; i < CLIPS; i++) {
      const f = frames[i * LEN + 2]; // mid-clip
      const seen = f.v > f.u + 40 ? "red" : f.u > f.v + 40 ? "blue" : "other";
      const want = i % 2 ? "blue" : "red";
      if (seen !== want) wrong.push(`clip ${i}: ${seen} (want ${want})`);
    }
    expect(wrong, wrong.join("\n")).toEqual([]);
  }, 300_000);
});
