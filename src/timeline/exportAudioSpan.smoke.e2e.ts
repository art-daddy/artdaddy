// An export whose sound ends before its picture (Phase 2 finding, slice 3e).
//
// The audio-length check exists for BRANDED exports, whose audio is padded through the end card;
// a broken pad there ships a file whose sound stops early. It was switched on for every export
// with audio (`brand !== undefined`, and brand is null when unbranded), so an unbranded export of
// a timeline whose last 0.2 s are silent rendered in full and was then refused. This goes
// through the real export door, which runs unbranded here (no bundled brand assets outside the
// app), and judges the delivered file.
//   npx vitest run --config vitest.smoke.config.ts src/timeline/exportAudioSpan.smoke.e2e.ts
import os from "node:os";
import { promises as fsp } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ClientToolContext } from "../tools/context";
import {
  ff,
  installE2EDocuments,
  libRef,
  meanVolumeDb,
  mkCtx,
  nodeFs,
  openE2EDoc,
  probe,
  resetE2EDocuments,
} from "../tools/__e2e";
import { joinPath } from "../tools/store";
import { ensureTimeline } from "./engine";
import { setCanvasTool } from "./ops";
import { addClipsTool } from "./placement";
import { exportTimelineTool } from "./render";
import { whenExportEnds } from "./exportQueue";

type Rec = Record<string, unknown>;

const ROOT = joinPath(os.tmpdir(), `artdaddy-audiospan-${Date.now()}`);

beforeAll(() => installE2EDocuments());
afterAll(async () => {
  await resetE2EDocuments();
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
});

async function project(name: string): Promise<{ dir: string; ctx: ClientToolContext }> {
  const dir = joinPath(ROOT, name);
  await nodeFs.mkdir(dir);
  await openE2EDoc(dir);
  const ctx = mkCtx(dir);
  await ensureTimeline(ctx.store);
  return { dir, ctx };
}

describe("an unbranded export whose audio ends before its picture", () => {
  it("delivers the file: 4 s of picture, sound only where the timeline has it", async () => {
    const { dir, ctx } = await project("early-audio");
    expect(((await setCanvasTool({ width: 160, height: 90, fps: 30 }, ctx)) as Rec).ok).toBe(true);
    const pic = joinPath(dir, "pic.mp4");
    await ff(["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=30:d=4", pic]);
    const tone = joinPath(dir, "tone.wav");
    await ff(["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", tone]);
    const picRef = await libRef(ctx, pic, "video");
    const toneRef = await libRef(ctx, tone, "audio");
    // The common shape: a 2 s sting under the first half, nothing under the rest.
    const placed = (await addClipsTool(
      {
        entries: [
          { media_ref: picRef, timeline_in: 0, timeline_out: 120 },
          { media_ref: toneRef, timeline_in: 0, timeline_out: 60 },
        ],
      },
      ctx,
    )) as Rec;
    expect(placed.ok, JSON.stringify(placed)).toBe(true);

    const res = (await exportTimelineTool({ name: "early-audio" }, ctx)) as Rec;
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const ended = await whenExportEnds(String(res.job_id));
    expect(ended?.state, JSON.stringify(ended)).toBe("done");

    const out = await ctx.store.exportPath("early-audio.mp4");
    const got = await probe(out);
    expect(got.vDurationS).toBeGreaterThan(3.9);
    expect(got.vDurationS).toBeLessThan(4.1);
    expect(got.aDurationS, "the sound must be in the file").toBeGreaterThan(1.9);
    // Two points that must differ: the sting, then the silent half.
    expect(await meanVolumeDb(out, { ss: 0.5, dur: 1 })).toBeGreaterThan(-40);
  }, 120_000);
});
