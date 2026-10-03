// Phase 2 (UJ-012): inspect_color on a clip renders the ONE frame it measures, with the clip's grade
// and nothing else. It used to render the whole clip at deliverable quality to pull that frame out
// (44 s median in production, every call). These tests drive the real tool against the ffmpeg the
// app ships and check both halves: the numbers describe the frame asked for, graded, and ffmpeg
// decodes a few seconds of source to get it however long the clip is.
// Run: npx vitest run --config vitest.smoke.config.ts src/tools/inspectColor.smoke.e2e.ts
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { inspectColorTool } from "./inspect";
import { joinPath } from "./store";
import { ensureTimeline } from "../timeline/engine";
import { setCanvasTool } from "../timeline/ops";
import { addClipsTool } from "../timeline/placement";
import { applyColorTool } from "../timeline/props";
import {
  decodeCountingRunner,
  ff,
  flushE2EDoc,
  installE2EDocuments,
  libRef,
  longFixture,
  mkCtx,
  openE2EDoc,
  resetE2EDocuments,
} from "./__e2e";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const FPS = 30;
const root = path.join(os.tmpdir(), `artdaddy-inspect-color-${Date.now()}`);

beforeAll(() => installE2EDocuments());
afterAll(async () => {
  await resetE2EDocuments();
  await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

/** A project at `name` with a 320x180 canvas and one clip of `media` placed at [tin, tout). */
async function placed(name: string, media: string, tin: number, tout: number): Promise<{ ctx: Any; clipId: string }> {
  const dir = joinPath(root, name);
  await fsp.mkdir(dir, { recursive: true });
  const ctx = mkCtx(dir);
  const ref = await libRef(ctx, media, "video");
  await openE2EDoc(dir);
  await ensureTimeline(ctx.store);
  expect(((await setCanvasTool({ width: 320, height: 180, fps: FPS }, ctx)) as Any).ok).toBe(true);
  const r = (await addClipsTool({ entries: [{ media_ref: ref, timeline_in: tin, timeline_out: tout }] }, ctx)) as Any;
  expect(r.ok, JSON.stringify(r)).toBe(true);
  await flushE2EDoc(dir);
  return { ctx, clipId: r.created[0].clip_id };
}

describe("inspect_color measures one frame of a clip (UJ-012)", () => {
  it("measures the frame it is asked for, with the clip's grade in it", async () => {
    await fsp.mkdir(root, { recursive: true });
    const redBlue = path.join(root, "redblue.mp4");
    await ff([
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `color=c=red:s=320x180:r=${FPS}:d=1`,
      "-f", "lavfi", "-i", `color=c=blue:s=320x180:r=${FPS}:d=1`,
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p",
      redBlue,
    ]);
    // Red for its first second, blue for its second, placed at frame 30.
    const { ctx, clipId } = await placed("grade", redBlue, 30, 90);
    const red = (await inspectColorTool({ clip_id: clipId, at_frame: 40 }, ctx)) as Any;
    const blue = (await inspectColorTool({ clip_id: clipId, at_frame: 75 }, ctx)) as Any;
    expect(red.ok, JSON.stringify(red)).toBe(true);
    expect(red.scopes.warm_cool).toBeGreaterThan(0.5);
    expect(blue.scopes.warm_cool).toBeLessThan(-0.5);
    const attached = (red._attachments as Array<{ path: string }>)[0].path;
    expect(attached).toMatch(/\.png$/);

    // The grade is part of what is measured.
    expect(((await applyColorTool({ clip_ids: [clipId], saturation: 0 }, ctx)) as Any).ok).toBe(true);
    await flushE2EDoc(joinPath(root, "grade"));
    const grey = (await inspectColorTool({ clip_id: clipId, at_frame: 40 }, ctx)) as Any;
    expect(grey.scopes.saturation).toBeLessThan(0.05);
    expect(Math.abs(grey.scopes.warm_cool)).toBeLessThan(0.05);
  });

  it("decodes a few seconds of a 14-minute clip to measure a frame near its end", async () => {
    const seconds = 14 * 60;
    const gop = 120;
    const total = seconds * FPS;
    const { ctx, clipId } = await placed("long", await longFixture({ seconds, fps: FPS, gop }), 0, total);
    const decoded: number[] = [];
    const t0 = performance.now();
    const r = (await inspectColorTool(
      { clip_id: clipId, at_frame: total - 77 },
      { ...ctx, runner: decodeCountingRunner(decoded) },
    )) as Any;
    const ms = performance.now() - t0;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    console.log(`[inspect_color] frame near the end of 14 min: ${Math.round(ms)} ms, ${decoded} frames decoded`); // eslint-disable-line no-console
    expect(decoded).toHaveLength(1); // one render, of one frame
    expect(decoded[0]).toBeLessThanOrEqual(gop + 2 * FPS + 60);
    // The decode count above is the guarantee; time is a ceiling far under the old whole-clip
    // render (44 s median in production for clips much shorter than this), and must hold when the
    // pre-push hook runs every e2e file at once.
    expect(ms).toBeLessThan(20_000);
  });
});
