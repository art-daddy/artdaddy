// Every size the app reports or reasons with is the size of the picture a decoder SHOWS (3g).
//
// A portrait phone JPEG stores a landscape frame plus EXIF Orientation 6; a portrait phone video
// stores a landscape frame plus a display matrix. ffmpeg and the WebView both show them upright,
// but ffprobe's STREAM keeps the stored size. Read that way, inspect_media told the model a portrait
// photo was landscape and squashed the frame it showed into that shape, crop_image refused the
// lower half of the picture (its clamp used the stored height while ffmpeg cropped the upright
// picture), and the zoom ceiling measured both on their sides.
//
// Each consumer is judged by what it PRODUCES, against what ffmpeg itself decodes: the size
// inspect_media reports, the shape of the frame the model is shown, the pixels crop_image returns,
// and the size the zoom ceiling measures. All 8 EXIF orientations for JPEG, the less common PNG
// (eXIf), and a rotated phone video.
//   npx vitest run --config vitest.smoke.config.ts src/tools/stillOrientation.smoke.e2e.ts
import { promises as fsp } from "node:fs";
import os from "node:os";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { jpegWithOrientation, pngWithOrientation } from "../test/exifFixtures";
import { quadrantPng } from "../test/heifFixtures";
import { decodedSize, differs, dims, fmt, meanColour, quadrants } from "../test/pictureChecks";
import { ensureTimeline } from "../timeline/engine";
import { addClipsTool } from "../timeline/placement";
import { clearSourceDimsCache, sourceDims } from "../timeline/sourceDims";
import {
  ff,
  installE2EDocuments,
  libRef,
  mkCtx,
  nodeFs,
  openE2EDoc,
  resetE2EDocuments,
} from "./__e2e";
import type { ClientToolContext } from "./context";
import { inspectMediaTool } from "./inspect";
import { cropImageTool } from "./media";
import { joinPath } from "./store";

type Rec = Record<string, unknown>;

const ROOT = joinPath(os.tmpdir(), `artdaddy-orient-${Date.now()}`);
/** The stored picture: landscape, four quadrants, so a turn and a mirror are both visible. */
const W = 320;
const H = 160;

beforeAll(() => installE2EDocuments());
afterAll(async () => {
  await resetE2EDocuments();
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
});

async function project(name: string): Promise<ClientToolContext> {
  const dir = joinPath(ROOT, name);
  await nodeFs.mkdir(dir);
  const ctx = mkCtx(dir);
  await openE2EDoc(dir);
  await ensureTimeline(ctx.store);
  return ctx;
}

/** What ffmpeg decodes `src` as, written to a PNG (which carries no orientation of its own). */
async function upright(src: string, out: string): Promise<string> {
  await ff(["-y", "-v", "error", "-i", src, "-frames:v", "1", out]);
  return out;
}

/** Every size consumer of the still `src` agrees with what ffmpeg decodes it as. */
async function checkSizes(name: string, src: string, kind: "image" | "video"): Promise<string[]> {
  const [w, h] = await decodedSize(src);
  const problems: string[] = [];
  const ctx = await project(name);
  const ref = await libRef(ctx, src, kind);

  // inspect_media: the size it reports, and the shape of the frame the model is shown.
  const look = (await inspectMediaTool({ media_ref: ref, max_frames: 1 }, ctx)) as Rec;
  if (look.ok !== true) problems.push(`inspect_media: ${String(look.error).slice(0, 160)}`);
  else {
    const v = (kind === "image" ? look : (look.metadata as Rec).video) as Rec;
    if (v.width !== w || v.height !== h)
      problems.push(
        `inspect_media: reports ${String(v.width)}x${String(v.height)}, shows ${w}x${h}`,
      );
    if (kind === "image") {
      const shown = ((look._attachments as Rec[] | undefined) ?? [])[0]?.path;
      if (typeof shown !== "string") problems.push("inspect_media: attached no picture");
      else {
        const [sw, sh] = await dims(shown);
        if (Math.abs(sw / sh - w / h) > 0.03)
          problems.push(
            `inspect_media: the model is shown ${sw}x${sh}, a picture shaped ${w}x${h}`,
          );
      }
    }
  }

  // crop_image: the bottom-right quadrant, in the picture's own (upright) pixels.
  if (kind === "image") {
    const want = (await quadrants(await upright(src, joinPath(ROOT, `${name}_up.png`))))[3];
    const crop = (await cropImageTool(
      { media_ref: ref, bbox: { x: w / 2 + 6, y: h / 2 + 6, w: w / 2 - 12, h: h / 2 - 12 } },
      ctx,
    )) as Rec;
    if (crop.ok !== true) problems.push(`crop_image: ${String(crop.error).slice(0, 160)}`);
    else {
      const got = await meanColour((await ctx.store.resolveRef(String(crop.media_ref)))!);
      if (differs(got, want, 16))
        problems.push(`crop_image: bottom-right is ${fmt(got)}, the picture's is ${fmt(want)}`);
    }
  }

  // The zoom ceiling measures the picture it limits.
  clearSourceDimsCache();
  const placed = (await addClipsTool(
    { entries: [{ media_ref: ref, timeline_in: 0, timeline_out: 30, with_audio: false }] },
    ctx,
  )) as Rec;
  const id = String(((placed.created as Rec[] | undefined) ?? [])[0]?.clip_id ?? "");
  const sd = id ? (await sourceDims(ctx, [id])).get(id) : null;
  if (sd?.w !== w || sd?.h !== h)
    problems.push(`zoom ceiling: measures ${sd ? `${sd.w}x${sd.h}` : "nothing"}, shows ${w}x${h}`);
  return problems;
}

describe("every size the app reports is the size a decoder shows", () => {
  it("a JPEG in each of the 8 EXIF orientations", async () => {
    const pic = await quadrantPng(joinPath(ROOT, "src", "pic.png"), W, H);
    const jpg = joinPath(ROOT, "src", "pic.jpg");
    await ff(["-y", "-v", "error", "-i", pic, "-q:v", "2", jpg]);
    const problems: string[] = [];
    for (let o = 1; o <= 8; o++) {
      const file = joinPath(ROOT, "src", `IMG_o${o}.jpg`);
      await fsp.writeFile(file, jpegWithOrientation(await fsp.readFile(jpg), o));
      // The fixture is what it claims: orientations 5-8 turn the picture, 1-4 do not.
      expect(await decodedSize(file), `orientation ${o}`).toEqual(o >= 5 ? [H, W] : [W, H]);
      problems.push(...(await checkSizes(`jpg_o${o}`, file, "image")).map((p) => `o${o} ${p}`));
    }
    expect(problems, problems.join("\n")).toEqual([]);
  }, 300_000);

  it("a PNG turned by its eXIf orientation", async () => {
    const pic = await quadrantPng(joinPath(ROOT, "src-png", "pic.png"), W, H);
    const file = joinPath(ROOT, "src-png", "scan.png");
    await fsp.writeFile(file, pngWithOrientation(await fsp.readFile(pic), 6));
    expect(await decodedSize(file)).toEqual([H, W]);
    const problems = await checkSizes("png_o6", file, "image");
    expect(problems, problems.join("\n")).toEqual([]);
  }, 120_000);

  it("a portrait phone video (a landscape frame plus a display matrix)", async () => {
    const dir = joinPath(ROOT, "src-video");
    await nodeFs.mkdir(dir);
    const plain = joinPath(dir, "plain.mp4");
    await ff([
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=${W}x${H}:rate=30:duration=1`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      plain,
    ]);
    const file = joinPath(dir, "IMG_0001.mp4");
    await ff(["-y", "-v", "error", "-display_rotation", "90", "-i", plain, "-c", "copy", file]);
    expect(await decodedSize(file)).toEqual([H, W]);
    const problems = await checkSizes("video_r90", file, "video");
    expect(problems, problems.join("\n")).toEqual([]);
  }, 120_000);
});
