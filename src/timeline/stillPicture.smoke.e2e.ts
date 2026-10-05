// A HEIF-family still shows its WHOLE, UPRIGHT picture in every consumer (3g). The structure every
// iPhone photo has - a cropped tile grid, a thumbnail stored ahead of it, a depth image beside it,
// often a rotation - is built here byte by byte (test/heifWriter.ts, licence-clean), because the
// shipped ffmpeg cannot write HEIF image items and the public samples cannot be committed.
//
// Each consumer is judged by what it PRODUCES (pixels, sizes, the exported file), never by the
// command it builds: the preview's stand-in and poster, inspect_media, the export, crop_image,
// inspect_color, the encoder that uploads stills to a model, run_ffmpeg, and the scale clamp. Problems
// are collected, so one run names every consumer that is wrong.
//
// Real Nokia samples run too where present locally (they are not redistributable):
//   ARTDADDY_HEIC=<untiled .heic>  ARTDADDY_HEIC_GRID=<tiled .heic>  ARTDADDY_HEIC_ALPHA=<alpha .heic>
//   npx vitest run --config vitest.smoke.config.ts src/timeline/stillPicture.smoke.e2e.ts
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { processImportedMedia } from "../preview/mediaProxy";
import { imageProxyRel, posterRel } from "../preview/proxyPaths";
import { alphaHeic, flatPng, iphoneLikeHeic, quadrantPng } from "../test/heifFixtures";
import { differs, dims, fmt, meanColour, quadrants, sameLayout } from "../test/pictureChecks";
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
import type { ClientToolContext } from "../tools/context";
import { encodeImageForGemini } from "../tools/geminiEncode";
import { inspectColorTool, inspectMediaTool } from "../tools/inspect";
import { cropImageTool, runFfmpegTool } from "../tools/media";
import { joinPath } from "../tools/store";
import { ensureTimeline, loadTimeline, replaceTimeline } from "./engine";
import { whenExportEnds } from "./exportQueue";
import { addTrackTool, setCanvasTool } from "./ops";
import { addClipsTool } from "./placement";
import { exportTimelineTool } from "./render";
import { sourceDims } from "./sourceDims";

type Rec = Record<string, unknown>;

const ROOT = joinPath(os.tmpdir(), `artdaddy-still-${Date.now()}`);
const PLAIN = process.env.ARTDADDY_HEIC ?? "";
const GRID = process.env.ARTDADDY_HEIC_GRID ?? "";
const ALPHA = process.env.ARTDADDY_HEIC_ALPHA ?? "";

beforeAll(() => installE2EDocuments());
afterAll(async () => {
  await resetE2EDocuments();
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
});

/** Alpha (0-255) min and max over a region of the first frame of a PNG. */
async function alphaRange(file: string, crop: string): Promise<[number, number]> {
  const r = await nodeRunner.run("ffmpeg", [
    "-v",
    "error",
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    `crop=${crop},alphaextract,signalstats,metadata=print:file=-`,
    "-f",
    "null",
    "-",
  ]);
  const num = (k: string) => Number(new RegExp(`${k}=([\\d.]+)`).exec(r.stdout)?.[1] ?? NaN);
  return [num("YMIN"), num("YMAX")];
}

async function project(name: string): Promise<ClientToolContext> {
  const dir = joinPath(ROOT, name);
  await nodeFs.mkdir(dir);
  const ctx = mkCtx(dir);
  await openE2EDoc(dir);
  await ensureTimeline(ctx.store);
  return ctx;
}

async function exportFile(ctx: ClientToolContext, name: string): Promise<string | string[]> {
  const res = (await exportTimelineTool({ name }, ctx)) as Rec;
  const ended = res.ok === true ? await whenExportEnds(String(res.job_id)) : null;
  if (ended?.state !== "done")
    return [`export: ${String(ended?.error ?? res.error ?? "did not finish").slice(0, 200)}`];
  return ctx.store.exportPath(`${name}.mp4`);
}

/** Every consumer of `src` shows the picture `reference` shows, at `w`x`h`. */
async function checkAllConsumers(
  name: string,
  src: string,
  reference: string,
  [w, h]: [number, number],
): Promise<string[]> {
  const ctx = await project(name);
  const ref = await libRef(ctx, src, "image");
  const abs = (await ctx.store.resolveRef(ref))!;
  const want = await quadrants(reference);
  const problems: string[] = [];

  // The preview's stand-in and the timeline poster, made by the real import-time producer.
  await processImportedMedia(ctx.store, ctx.runner, abs);
  const stand = joinPath(ctx.store.projectDir, imageProxyRel(abs));
  if (!existsSync(stand)) problems.push("preview: no stand-in was made (the photo shows nothing)");
  else {
    const [sw, sh] = await dims(stand);
    if (sw !== w || sh !== h) problems.push(`preview: stand-in is ${sw}x${sh}, want ${w}x${h}`);
    problems.push(...sameLayout("preview", await quadrants(stand), want));
  }
  if (!existsSync(joinPath(ctx.store.projectDir, posterRel(abs))))
    problems.push("thumbnail: no poster was made");

  // inspect_media reports the picture's own size.
  const look = (await inspectMediaTool({ media_ref: ref }, ctx)) as Rec;
  if (look.ok !== true) problems.push(`inspect_media: ${String(look.error).slice(0, 160)}`);
  else if (look.width !== w || look.height !== h)
    problems.push(
      `inspect_media: reports ${String(look.width)}x${String(look.height)}, want ${w}x${h}`,
    );

  // crop_image: the top-right quadrant, in the picture's own pixels, is that quadrant's colour.
  const crop = (await cropImageTool(
    { media_ref: ref, bbox: { x: w / 2 + 8, y: 8, w: w / 2 - 16, h: h / 2 - 16 } },
    ctx,
  )) as Rec;
  if (crop.ok !== true) problems.push(`crop_image: ${String(crop.error).slice(0, 160)}`);
  else {
    const out = (await ctx.store.resolveRef(String(crop.media_ref)))!;
    const got = await meanColour(out);
    if (differs(got, want[1], 14))
      problems.push(`crop_image: got ${fmt(got)}, want ${fmt(want[1])}`);
  }

  // inspect_color on the media measures the picture, not a tile or a thumbnail.
  const refRef = await libRef(ctx, reference, "image");
  const [mine, theirs] = [
    (await inspectColorTool({ media_ref: ref }, ctx)) as Rec,
    (await inspectColorTool({ media_ref: refRef }, ctx)) as Rec,
  ];
  const luma = (r: Rec) => Number((r.scopes as Rec | undefined)?.mean_luma);
  if (mine.ok !== true) problems.push(`inspect_color: ${String(mine.error).slice(0, 160)}`);
  else if (!(Math.abs(luma(mine) - luma(theirs)) <= 0.04))
    problems.push(`inspect_color: mean luma ${luma(mine)}, the picture's is ${luma(theirs)}`);

  // The encoder every model upload goes through (generation references, vision): a JPEG of the
  // picture, never the raw file.
  try {
    const enc = await encodeImageForGemini(ctx, abs, { maxDim: 256, quality: 90, tag: "t" });
    if (!/\.jpg$/i.test(enc))
      problems.push(`model upload: sends ${enc.split(/[\\/]/).pop()}, not a JPEG of the picture`);
    else problems.push(...sameLayout("model upload", await quadrants(enc), want, 18));
  } catch (e) {
    problems.push(`model upload: ${String(e).slice(0, 160)}`);
  }

  // run_ffmpeg: a plain scale over the input works, and shows the picture.
  const ran = (await runFfmpegTool(
    {
      inputs: [ref],
      args: ["-i", "{in0}", "-vf", "scale=iw/2:-2", "{out}"],
      output_name: "half.png",
    },
    ctx,
  )) as Rec;
  if (ran.ok !== true)
    problems.push(`run_ffmpeg: ${String(ran.error ?? ran.stderr_tail).slice(0, 160)}`);
  else {
    const out = (await ctx.store.resolveRef(String(ran.media_ref)))!;
    problems.push(...sameLayout("run_ffmpeg", await quadrants(out), want, 16));
  }

  // The export, on a canvas of the picture's own shape: every quadrant where it belongs.
  expect(((await setCanvasTool({ width: w, height: h, fps: 30 }, ctx)) as Rec).ok).toBe(true);
  const placed = (await addClipsTool(
    { entries: [{ media_ref: ref, timeline_in: 0, timeline_out: 30 }] },
    ctx,
  )) as Rec;
  expect(placed.ok, JSON.stringify(placed)).toBe(true);
  const out = await exportFile(ctx, name);
  if (Array.isArray(out)) problems.push(...out);
  else problems.push(...sameLayout("export", await quadrants(out), want, 16));

  // The scale clamp measures the picture, not a tile or the thumbnail.
  const tl = await loadTimeline(ctx.store);
  const clipId = String(tl.tracks.flatMap((t) => t.clips)[0]?.id);
  const sd = (await sourceDims(ctx, [clipId])).get(clipId);
  if (sd?.w !== w || sd?.h !== h)
    problems.push(`scale clamp: measures ${sd ? `${sd.w}x${sd.h}` : "nothing"}, want ${w}x${h}`);

  return problems;
}

/** A still with a declared alpha plane (left half opaque, right half transparent) shows the layer
 *  below through its transparent half, in the preview's stand-in and in the export. */
async function checkAlpha(name: string, src: string, w: number, h: number): Promise<string[]> {
  const ctx = await project(name);
  const ref = await libRef(ctx, src, "image");
  const abs = (await ctx.store.resolveRef(ref))!;
  const problems: string[] = [];

  await processImportedMedia(ctx.store, ctx.runner, abs);
  const stand = joinPath(ctx.store.projectDir, imageProxyRel(abs));
  if (!existsSync(stand)) problems.push("preview: no stand-in was made");
  else {
    const [lo, hi] = [
      await alphaRange(stand, `iw/2-8:ih:4:0`),
      await alphaRange(stand, `iw/2-8:ih:iw/2+4:0`),
    ];
    if (!(lo[0] >= 240)) problems.push(`preview: opaque half has alpha down to ${lo[0]}`);
    if (!(hi[1] <= 15)) problems.push(`preview: transparent half has alpha up to ${hi[1]}`);
  }

  // Over a blue layer: the left half is the picture (red), the right half is the blue below.
  const blue = await flatPng(joinPath(ctx.store.projectDir, "blue.png"), w, h, "blue");
  const blueRef = await libRef(ctx, blue, "image");
  expect(((await setCanvasTool({ width: w, height: h, fps: 30 }, ctx)) as Rec).ok).toBe(true);
  expect(
    (
      (await addClipsTool(
        { entries: [{ media_ref: blueRef, timeline_in: 0, timeline_out: 30 }] },
        ctx,
      )) as Rec
    ).ok,
  ).toBe(true);
  expect(((await addTrackTool({ id: "top", kind: "video" }, ctx)) as Rec).ok).toBe(true);
  const placed = (await addClipsTool(
    { entries: [{ media_ref: ref, track_id: "top", timeline_in: 0, timeline_out: 30 }] },
    ctx,
  )) as Rec;
  expect(placed.ok, JSON.stringify(placed)).toBe(true);
  const out = await exportFile(ctx, name);
  if (Array.isArray(out)) return [...problems, ...out];
  // Independent references for what each half must be: the picture's red, the layer's blue.
  const redC = await meanColour(
    await flatPng(joinPath(ctx.store.projectDir, "red.png"), 64, 64, "red"),
  );
  const blueC = await meanColour(blue);
  const left = await meanColour(out, `iw/2-8:ih:4:0`);
  const right = await meanColour(out, `iw/2-8:ih:iw/2+4:0`);
  if (differs(left, redC, 16))
    problems.push(`export: the opaque half is ${fmt(left)}, want the picture's red (${fmt(redC)})`);
  if (differs(right, blueC, 16))
    problems.push(
      `export: the transparent half is ${fmt(right)}, want the blue below (${fmt(blueC)})`,
    );
  return problems;
}

describe("a HEIF-family still is its whole, upright picture everywhere", () => {
  it("an iPhone-structured HEIC: cropped tile grid, thumbnail stored first, depth beside it", async () => {
    const dir = joinPath(ROOT, "src-grid");
    const pic = await quadrantPng(joinPath(dir, "pic.png"), 360, 240);
    const heic = await iphoneLikeHeic(dir, joinPath(dir, "IMG_0001.HEIC"), pic, 360, 240, {
      tile: 128,
    });
    const problems = await checkAllConsumers("grid", heic, pic, [360, 240]);
    expect(problems, problems.join("\n")).toEqual([]);
  }, 240_000);

  it("the same photo taken in portrait (irot): every consumer sees it upright", async () => {
    const dir = joinPath(ROOT, "src-portrait");
    const pic = await quadrantPng(joinPath(dir, "pic.png"), 360, 240);
    // A portrait iPhone photo carries BOTH irot 1 and an Exif item with Orientation 6. HEIF readers
    // must ignore the Exif one; the shipped ffmpeg does (measured), but its version is not pinned,
    // and a build that honoured both would turn every portrait photo twice.
    const heic = await iphoneLikeHeic(dir, joinPath(dir, "IMG_0002.HEIC"), pic, 360, 240, {
      tile: 128,
      turns: 1,
      exif: 6,
    });
    // irot 1 = a quarter turn anticlockwise; transpose=2 is the same turn, done independently.
    const upright = joinPath(dir, "upright.png");
    await ff(["-y", "-v", "error", "-i", pic, "-vf", "transpose=2", upright]);
    const problems = await checkAllConsumers("portrait", heic, upright, [240, 360]);
    expect(problems, problems.join("\n")).toEqual([]);
  }, 240_000);

  it("an AVIF: every consumer shows its picture", async () => {
    const dir = joinPath(ROOT, "src-avif");
    const pic = await quadrantPng(joinPath(dir, "pic.png"), 320, 200);
    const avif = joinPath(dir, "photo.avif");
    await ff([
      "-y",
      "-v",
      "error",
      "-i",
      pic,
      "-c:v",
      "libaom-av1",
      "-still-picture",
      "1",
      "-cpu-used",
      "8",
      avif,
    ]);
    const problems = await checkAllConsumers("avif", avif, pic, [320, 200]);
    expect(problems, problems.join("\n")).toEqual([]);
  }, 240_000);

  it("a HEIC with a declared alpha plane is transparent where its alpha says", async () => {
    const dir = joinPath(ROOT, "src-alpha-heic");
    const red = await flatPng(joinPath(dir, "red.png"), 320, 200, "red");
    const mask = joinPath(dir, "mask.png");
    await ff([
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=320x200:d=1,drawbox=x=0:y=0:w=160:h=200:color=white:t=fill",
      "-frames:v",
      "1",
      mask,
    ]);
    const heic = await alphaHeic(dir, joinPath(dir, "sticker.heic"), red, mask, 320, 200);
    const problems = await checkAlpha("alpha-heic", heic, 320, 200);
    expect(problems, problems.join("\n")).toEqual([]);
  }, 240_000);

  it("an AVIF with alpha is transparent where its alpha says", async () => {
    const dir = joinPath(ROOT, "src-alpha-avif");
    await nodeFs.mkdir(dir);
    const rgba = joinPath(dir, "rgba.png");
    await ff([
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=320x200:d=1,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,160),255,0)'",
      "-frames:v",
      "1",
      rgba,
    ]);
    const avif = joinPath(dir, "sticker.avif");
    await ff([
      "-y",
      "-v",
      "error",
      "-i",
      rgba,
      "-filter_complex",
      "[0:v]format=yuva444p,split[c][a];[a]alphaextract[al]",
      "-map",
      "[c]",
      "-map",
      "[al]",
      "-frames:v",
      "1",
      "-c:v",
      "libaom-av1",
      "-cpu-used",
      "8",
      "-still-picture",
      "1",
      avif,
    ]);
    const problems = await checkAlpha("alpha-avif", avif, 320, 200);
    expect(problems, problems.join("\n")).toEqual([]);
  }, 240_000);

  it("a HEIC that cannot be decoded is refused by name, never rendered as something else", async () => {
    const dir = joinPath(ROOT, "src-broken");
    const pic = await quadrantPng(joinPath(dir, "pic.png"), 360, 240);
    const good = await iphoneLikeHeic(dir, joinPath(dir, "good.heic"), pic, 360, 240, {
      tile: 128,
    });
    // A photo still syncing from the cloud: its head is there, its picture data is not.
    const bytes = await fsp.readFile(good);
    const broken = joinPath(dir, "IMG_9999.HEIC");
    await fsp.writeFile(broken, bytes.subarray(0, Math.floor(bytes.length * 0.6)));
    const ctx = await project("broken");
    const ref = await libRef(ctx, broken, "image");
    expect(((await setCanvasTool({ width: 360, height: 240, fps: 30 }, ctx)) as Rec).ok).toBe(true);
    expect(
      (
        (await addClipsTool(
          { entries: [{ media_ref: ref, timeline_in: 0, timeline_out: 30 }] },
          ctx,
        )) as Rec
      ).ok,
    ).toBe(true);
    const out = await exportFile(ctx, "broken");
    expect(Array.isArray(out), "the export must not succeed").toBe(true);
    expect(String(out)).toContain("IMG_9999.HEIC");
  }, 240_000);

  it("a HEIC saved as a VIDEO clip (every HEIC placed before 3g) exports as its picture", async () => {
    // detectKind had no .heic, and a dropped file's probe sees its image items as video streams, so
    // existing documents hold these. A document is never rewritten on open: the render must read the
    // clip as the still its file is. Restored here through the chat-checkpoint door, the way an old
    // document comes back.
    const dir = joinPath(ROOT, "src-stored-video");
    const pic = await quadrantPng(joinPath(dir, "pic.png"), 360, 240);
    const heic = await iphoneLikeHeic(dir, joinPath(dir, "IMG_0003.HEIC"), pic, 360, 240, {
      tile: 128,
    });
    const ctx = await project("stored-video");
    const ref = await libRef(ctx, heic, "image");
    const tl = await loadTimeline(ctx.store);
    tl.canvas = { ...tl.canvas, width: 360, height: 240, fps: 30 };
    tl.tracks = [
      {
        id: "v1",
        kind: "video",
        z: 0,
        clips: [
          {
            id: "old",
            kind: "video",
            media_ref: ref,
            timeline_in: 0,
            timeline_out: 30,
            source_in: 0,
            source_out: 30,
          },
        ],
      },
    ] as typeof tl.tracks;
    expect(await replaceTimeline(ctx.store, tl)).toBe(true);
    const out = await exportFile(ctx, "stored-video");
    if (Array.isArray(out)) throw new Error(out.join("\n"));
    const problems = sameLayout("export", await quadrants(out), await quadrants(pic), 16);
    expect(problems, problems.join("\n")).toEqual([]);
    // The document itself is not rewritten by rendering it.
    const after = await loadTimeline(ctx.store);
    expect(after.tracks[0].clips?.[0]?.kind).toBe("video");
  }, 240_000);

  it.runIf(PLAIN && existsSync(PLAIN))(
    "a real untiled HEIC (local sample)",
    async () => {
      const dir = joinPath(ROOT, "src-plain");
      await nodeFs.mkdir(dir);
      const reference = joinPath(dir, "reference.png");
      await ff(["-y", "-v", "error", "-i", PLAIN, "-frames:v", "1", "-update", "1", reference]);
      const problems = await checkAllConsumers("plain", PLAIN, reference, await dims(reference));
      expect(problems, problems.join("\n")).toEqual([]);
    },
    240_000,
  );

  it.runIf(GRID && existsSync(GRID))(
    "a real tiled HEIC (local sample)",
    async () => {
      const dir = joinPath(ROOT, "src-real-grid");
      await nodeFs.mkdir(dir);
      // A plain `-i` (no filters) is ffmpeg's own pick of the assembled grid: an independent reference.
      const reference = joinPath(dir, "reference.png");
      await ff(["-y", "-v", "error", "-i", GRID, "-frames:v", "1", "-update", "1", reference]);
      const problems = await checkAllConsumers("real-grid", GRID, reference, await dims(reference));
      expect(problems, problems.join("\n")).toEqual([]);
    },
    240_000,
  );

  // Nokia's "alpha" sample is an OVERLAY (iovl) of two images whose alpha plane belongs to one of
  // the CONSTITUENTS (auxl 1008 -> 1005), not to the primary: an auxiliary of another item must never
  // make the photo transparent. And the shipped ffmpeg composes an overlay NON-DETERMINISTICALLY
  // (measured: 10 of 20 decodes differed, single-threaded too; a tile grid, which every iPhone photo
  // is, decoded identically 20 of 20), so no fresh decode is a fair reference. What the owner DOES
  // promise is one picture, decoded once: whole, opaque, and the very picture the export renders.
  it.runIf(ALPHA && existsSync(ALPHA))(
    "a real overlay HEIC (local sample): one picture, the same in the export, and no stray alpha",
    async () => {
      const ctx = await project("real-alpha");
      const ref = await libRef(ctx, ALPHA, "image");
      const abs = (await ctx.store.resolveRef(ref))!;
      await processImportedMedia(ctx.store, ctx.runner, abs);
      const stand = joinPath(ctx.store.projectDir, imageProxyRel(abs));
      expect(existsSync(stand), "a stand-in was made").toBe(true);
      const reference = joinPath(ctx.store.projectDir, "reference.png");
      await ff(["-y", "-v", "error", "-i", ALPHA, "-frames:v", "1", "-update", "1", reference]);
      const [w, h] = await dims(reference);
      expect(await dims(stand)).toEqual([w, h]);
      const [min] = await alphaRange(stand, "iw:ih:0:0");
      expect(Number.isNaN(min) || min >= 250, "no part of the photo is made transparent").toBe(
        true,
      );
      expect(((await setCanvasTool({ width: w, height: h, fps: 30 }, ctx)) as Rec).ok).toBe(true);
      const placed = (await addClipsTool(
        { entries: [{ media_ref: ref, timeline_in: 0, timeline_out: 30 }] },
        ctx,
      )) as Rec;
      expect(placed.ok, JSON.stringify(placed)).toBe(true);
      const out = await exportFile(ctx, "real-alpha");
      if (Array.isArray(out)) throw new Error(out.join("\n"));
      const problems = sameLayout("export", await quadrants(out), await quadrants(stand), 16);
      expect(problems, problems.join("\n")).toEqual([]);
    },
    240_000,
  );
});
