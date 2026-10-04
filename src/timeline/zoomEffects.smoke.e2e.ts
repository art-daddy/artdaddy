// UJ-007: an export (or preview) of a clip that zooms in AND carries vignette, sharpen, clarity or
// denoise died with an access violation and wrote no video. The animated zoom resized every frame
// and the effects ran after it; those filters size their buffers on the first frame. This walks
// every video effect, plus rotate and a grade, across zoom in / zoom out / static, through the
// shipped ffmpeg, and judges the FILE.
//   npx vitest run --config vitest.smoke.config.ts src/timeline/zoomEffects.smoke.e2e.ts
import os from "node:os";
import { promises as fsp } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ClientToolContext } from "../tools/context";
import type { MediaKind } from "../media/formats";
import {
  ff,
  framePng,
  installE2EDocuments,
  libRef,
  measureColor,
  mkCtx,
  nodeFs,
  openE2EDoc,
  probe,
  renderMp4,
  resetE2EDocuments,
} from "../tools/__e2e";
import { joinPath } from "../tools/store";
import { ensureTimeline } from "./engine";
import { whenExportEnds } from "./exportQueue";
import { setCanvasTool } from "./ops";
import { addClipsTool } from "./placement";
import { applyColorTool, applyEffectsTool, setClipPropertiesTool, setKeyframesTool } from "./props";
import { exportTimelineTool } from "./render";

type Rec = Record<string, unknown>;

const ROOT = joinPath(os.tmpdir(), `artdaddy-zoomfx-${Date.now()}`);
const W = 540;
const H = 960;
const FRAMES = 30;
let photo = "";

beforeAll(async () => {
  installE2EDocuments();
  await nodeFs.mkdir(ROOT);
  // The user's source: a full-range (yuvj) portrait JPEG with real detail for the kernels to bite.
  photo = joinPath(ROOT, "photo.jpg");
  await ff([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=600x800:d=1",
    "-frames:v",
    "1",
    "-pix_fmt",
    "yuvj420p",
    photo,
  ]);
}, 60_000);
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
  expect(((await setCanvasTool({ width: W, height: H, fps: 30 }, ctx)) as Rec).ok).toBe(true);
  return { dir, ctx };
}

async function placePhoto(ctx: ClientToolContext): Promise<string> {
  const ref = await libRef(ctx, photo, "image");
  const r = (await addClipsTool(
    { entries: [{ media_ref: ref, timeline_in: 0, timeline_out: FRAMES }] },
    ctx,
  )) as Rec;
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return String((r.created as Rec[])[0].clip_id);
}

const ZOOMS: Record<string, { t: number; v: number }[] | number> = {
  "zoom-in": [
    { t: 0, v: 1.6 },
    { t: FRAMES - 1, v: 1.8 },
  ],
  "zoom-out": [
    { t: 0, v: 1.8 },
    { t: FRAMES - 1, v: 1.6 },
  ],
  static: 1.6,
};

/** Every look a clip can carry on its pixels: the nine video effects, a rotation and a grade. */
const LOOKS: Record<string, (ctx: ClientToolContext, id: string) => Promise<unknown>> = {
  ...Object.fromEntries(
    ["blur", "denoise", "sharpen", "grain", "vignette", "motion", "clarity", "chroma", "glow"].map(
      (type) => [type, (ctx, id) => applyEffectsTool({ clip_ids: [id], add: [{ type }] }, ctx)],
    ),
  ),
  rotate: (ctx, id) => setClipPropertiesTool({ clip_ids: [id], rotate: 12 }, ctx),
  grade: (ctx, id) => applyColorTool({ clip_ids: [id], contrast: 1.3, saturation: 1.4 }, ctx),
};

describe("UJ-007: every look renders on a zooming clip, in both directions", () => {
  for (const [look, apply] of Object.entries(LOOKS)) {
    for (const [zoom, scale] of Object.entries(ZOOMS)) {
      it(`${look} + ${zoom}`, async () => {
        const { dir, ctx } = await project(`${look}-${zoom}`);
        const id = await placePhoto(ctx);
        const r = (await apply(ctx, id)) as Rec;
        expect(r.ok, JSON.stringify(r)).toBe(true);
        if (typeof scale === "number")
          await setClipPropertiesTool({ clip_ids: [id], transform: { scale } }, ctx);
        else
          expect(
            (
              (await setKeyframesTool(
                { clip_id: id, property: "scale", keyframes: scale },
                ctx,
              )) as Rec
            ).ok,
          ).toBe(true);
        const mp4 = await renderMp4(ctx, dir);
        const p = await probe(mp4);
        expect([p.width, p.height]).toEqual([W, H]);
        expect(p.vDurationS).toBeGreaterThan(0.9);
        // Not black: the clip really drew (an overrun can also corrupt instead of crashing).
        const s = await measureColor(
          ctx,
          await framePng(mp4, joinPath(dir, "f.png"), { atSec: 0.8 }),
        );
        expect(s.luma).toBeGreaterThan(0.05);
      }, 120_000);
    }
  }
});

/** A white square on black, so the share of white in a frame is how much of the clip shows. */
async function whiteSquare(dir: string, video: boolean): Promise<string> {
  const out = joinPath(dir, video ? "white.mp4" : "white.png");
  const len = video ? ["-t", "4", "-r", "30", "-pix_fmt", "yuv420p"] : ["-frames:v", "1"];
  await ff(["-y", "-f", "lavfi", "-i", "color=c=white:s=400x400", ...len, out]);
  return out;
}

async function place(
  ctx: ClientToolContext,
  file: string,
  kind: MediaKind,
  entry: Rec,
): Promise<string> {
  const ref = await libRef(ctx, file, kind);
  const r = (await addClipsTool({ entries: [{ media_ref: ref, ...entry }] }, ctx)) as Rec;
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return String((r.created as Rec[])[0].clip_id);
}

async function lumaAt(
  ctx: ClientToolContext,
  mp4: string,
  dir: string,
  atSec: number,
  vf?: string,
) {
  const png = await framePng(mp4, joinPath(dir, `l${atSec}${vf ? "c" : ""}.png`), { atSec, vf });
  return (await measureColor(ctx, png)).luma;
}

describe("the zoom no longer moves what the filters before it see", () => {
  // rotate's output size is fixed when it is configured, and it used to sit AFTER the zoom: a
  // rotated clip zooming in was cut to its first frame's size for the rest of the clip.
  it("a rotated clip zooming in is not cropped to its starting size", async () => {
    const { dir, ctx } = await project("rotate-crop");
    await setCanvasTool({ width: 640, height: 640, fps: 30 }, ctx);
    const id = await place(ctx, await whiteSquare(dir, false), "image", {
      timeline_in: 0,
      timeline_out: 30,
    });
    await setClipPropertiesTool({ clip_ids: [id], fit: "contain", rotate: 45 }, ctx);
    await setKeyframesTool(
      {
        clip_id: id,
        property: "scale",
        keyframes: [
          { t: 0, v: 0.5 },
          { t: 29, v: 1 },
        ],
      },
      ctx,
    );
    const mp4 = await renderMp4(ctx, dir);
    // The left-middle edge: inside the full-size diamond, outside the quarter-size start.
    const edge = "crop=60:40:30:300";
    expect(await lumaAt(ctx, mp4, dir, 0.05, edge)).toBeLessThan(0.1);
    expect(await lumaAt(ctx, mp4, dir, 0.95, edge)).toBeGreaterThan(0.8);
  }, 120_000);

  // The zoom ran before setpts, on the SOURCE clock: at 2x it finished halfway through the clip.
  it("a zoom on a 2x clip follows the timeline, not the source", async () => {
    const { dir, ctx } = await project("speed-zoom");
    await setCanvasTool({ width: 400, height: 400, fps: 30 }, ctx);
    const id = await place(ctx, await whiteSquare(dir, true), "video", {
      timeline_in: 0,
      source_span: [0, 4],
    });
    expect(((await setClipPropertiesTool({ clip_ids: [id], speed: 2 }, ctx)) as Rec).ok).toBe(true);
    await setKeyframesTool(
      {
        clip_id: id,
        property: "scale",
        keyframes: [
          { t: 0, v: 0.5 },
          { t: 60, v: 1 },
        ],
      },
      ctx,
    );
    const mp4 = await renderMp4(ctx, dir);
    // White share = scale squared: 0.25 at the start, 0.5625 at the timeline midpoint (1.0 if the
    // zoom ran on the source clock), all of it by the end.
    expect(await lumaAt(ctx, mp4, dir, 0.02)).toBeLessThan(0.33);
    const mid = await lumaAt(ctx, mp4, dir, 1.0);
    expect(mid).toBeGreaterThan(0.45);
    expect(mid).toBeLessThan(0.7);
  }, 120_000);
});

// The user's case, through the EXPORT queue: the same photo four times, zooming, with vignette,
// sharpen, glow and grain on every clip. All three of their exports died. Which direction crashes
// depends on the build (theirs died zooming in; N-126655 dies zooming out), so both are here.
describe("UJ-007: the reported timeline exports", () => {
  it("four zooming photos with vignette + sharpen + glow + grain export, and show", async () => {
    const { dir, ctx } = await project("user-case");
    const ref = await libRef(ctx, photo, "image");
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = (await addClipsTool(
        { entries: [{ media_ref: ref, timeline_in: i * FRAMES, timeline_out: (i + 1) * FRAMES }] },
        ctx,
      )) as Rec;
      ids.push(String((r.created as Rec[])[0].clip_id));
    }
    for (const [i, id] of ids.entries()) {
      await applyEffectsTool(
        { clip_ids: [id], add: ["vignette", "sharpen", "glow", "grain"].map((type) => ({ type })) },
        ctx,
      );
      const keyframes = ZOOMS[i % 2 ? "zoom-out" : "zoom-in"];
      await setKeyframesTool({ clip_id: id, property: "scale", keyframes }, ctx);
    }
    const res = (await exportTimelineTool({ name: "uj007" }, ctx)) as Rec;
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const ended = await whenExportEnds(String(res.job_id));
    expect(ended?.state, JSON.stringify(ended)).toBe("done");
    const out = await ctx.store.exportPath("uj007.mp4");
    const p = await probe(out);
    expect(p.vDurationS).toBeGreaterThan(3.9);
    expect(await lumaAt(ctx, out, dir, 0.5)).toBeGreaterThan(0.05);
    expect(await lumaAt(ctx, out, dir, 3.5)).toBeGreaterThan(0.05);
  }, 240_000);
});
