// The preview's reading of a display matrix, held to the SHIPPED ffmpeg (UJ-015). The export, the
// agent's frames and the preview proxy are all ffmpeg, which turns a file by its display matrix;
// the preview decodes the file itself and turns it with orientation.ts. These tests are the bridge:
//
//  1. expected.json (what the browser lane holds the preview to) still says what this ffmpeg shows.
//  2. orientation.ts re-arranges the STORED frame into exactly ffmpeg's picture, byte for byte, for
//     every turn and mirror and for turns in the movie header - and a reading that ignored the
//     matrix would not (the check can fail).
//  3. The size the preview lays a clip out at is the size the export's probe reports.
//  4. The export itself shows expected.json's picture.
//  5. The preview PROXY (HEVC and other codecs the WebView cannot decode) is already upright and
//     declares no turn, so the preview can never turn it twice.
//   npx vitest run --config vitest.smoke.config.ts src/preview/orientation.smoke.e2e.ts
import os from "node:os";
import { existsSync, promises as fsp, readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CORNERS,
  ROTATION_FIXTURES,
  type RotationExpected,
  classify,
  parseMp4,
} from "./__rotationFixtures";
import { processImportedMedia } from "./mediaProxy";
import { type Orientation, UPRIGHT, displaySize, mp4Orientation, textureUv } from "./orientation";
import { proxyRel } from "./proxyPaths";
import { resolvePreviewUrl, setAssetAccessGrant, setAssetUrlConverter } from "./resolve";
import { ensureTimeline } from "../timeline/engine";
import { whenExportEnds } from "../timeline/exportQueue";
import { setCanvasTool } from "../timeline/ops";
import { addClipsTool } from "../timeline/placement";
import { exportTimelineTool } from "../timeline/render";
import { decodedSize } from "../test/pictureChecks";
import {
  ff,
  flushE2EDoc,
  installE2EDocuments,
  libRef,
  mkCtx,
  nodeFs,
  nodeRunner,
  openE2EDoc,
  resetE2EDocuments,
} from "../tools/__e2e";
import type { ClientToolContext } from "../tools/context";
import { probePath } from "../tools/media";
import { joinPath } from "../tools/store";

type Rec = Record<string, unknown>;

const DIR = path.resolve(process.cwd(), "e2e/ui/fixtures/rotation");
const EXPECTED = JSON.parse(
  readFileSync(path.join(DIR, "expected.json"), "utf8"),
) as RotationExpected;
const ROOT = joinPath(os.tmpdir(), `artdaddy-orient-${Date.now()}`);

beforeAll(async () => {
  installE2EDocuments();
  await fsp.mkdir(ROOT, { recursive: true });
});
afterAll(async () => {
  await resetE2EDocuments();
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
});

let seq = 0;
/** The first frame of `file` as rgb24, decoded with ffmpeg's autorotate (as the export decodes it)
 *  or without it (the frame as stored, which is what the preview's decoder hands the renderer). */
async function frame(file: string, autorotate: boolean): Promise<Buffer> {
  const out = joinPath(ROOT, `f${seq++}.rgb`);
  await ff([
    ...["-y", "-v", "error"],
    ...(autorotate ? [] : ["-noautorotate"]),
    ...["-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", out],
  ]);
  return readFileSync(out);
}

/** `stored` (w x h) shown through `o`, sampled at each shown pixel's centre. */
function reshape(stored: Buffer, w: number, h: number, o: Orientation): Buffer {
  const shown = displaySize({ w, h }, o);
  const out = Buffer.alloc(shown.w * shown.h * 3);
  for (let y = 0; y < shown.h; y++)
    for (let x = 0; x < shown.w; x++) {
      const [u, v] = textureUv(o, (x + 0.5) / shown.w, (y + 0.5) / shown.h);
      const s = (Math.floor(v * h) * w + Math.floor(u * w)) * 3;
      stored.copy(out, (y * shown.w + x) * 3, s, s + 3);
    }
  return out;
}

function cornersOf(rgb: Buffer, w: number, h: number): string[] {
  return CORNERS.map(([cx, cy]) => {
    const i = (Math.floor(cy * h) * w + Math.floor(cx * w)) * 3;
    return classify([rgb[i], rgb[i + 1], rgb[i + 2]]);
  });
}

async function project(name: string): Promise<ClientToolContext> {
  const dir = joinPath(ROOT, name);
  await nodeFs.mkdir(dir);
  const ctx = mkCtx(dir);
  await openE2EDoc(dir);
  await ensureTimeline(ctx.store);
  return ctx;
}

describe("the preview's orientation equals ffmpeg's", () => {
  for (const fx of ROTATION_FIXTURES) {
    it(`${fx.file}: same size, same picture, byte for byte`, async () => {
      const file = path.join(DIR, fx.file);
      const want = EXPECTED.fixtures[fx.file];
      const { mp4, info } = parseMp4(readFileSync(file));
      const track = info.videoTracks[0];
      const [w, h] = [track.video.width, track.video.height];
      const o = mp4Orientation(mp4, track);
      const shown = displaySize({ w, h }, o);

      // 1. expected.json is still what this ffmpeg shows.
      const [dw, dh] = await decodedSize(file);
      expect([dw, dh], "ffmpeg's shown size moved: npm run fixtures:rotation").toEqual(
        want.display,
      );
      const upright = await frame(file, true);
      expect(
        cornersOf(upright, dw, dh),
        "ffmpeg's picture moved: npm run fixtures:rotation",
      ).toEqual(want.corners);

      // 2. The stored frame, re-arranged by the preview's reading, IS ffmpeg's picture.
      expect([shown.w, shown.h]).toEqual([dw, dh]);
      const stored = await frame(file, false);
      expect(stored.length).toBe(w * h * 3);
      expect(reshape(stored, w, h, o).equals(upright), "pixels differ from ffmpeg's").toBe(true);
      // ...and the check can fail: read without its matrix, a turned file is NOT ffmpeg's picture.
      if (o.m.join() !== UPRIGHT.m.join()) {
        const ignored = reshape(stored, w, h, UPRIGHT);
        expect(ignored.equals(upright) && w === dw).toBe(false);
      }

      // 3. The export lays the clip out at the size the preview does.
      const probed = (await probePath(nodeRunner, file)).video as Rec;
      expect([probed.width, probed.height]).toEqual([shown.w, shown.h]);
    });
  }
});

describe("the export shows expected.json's picture", () => {
  // A phone's portrait clip, a mirrored half turn, and the mirror-then-movie-turn that pins the
  // order the two matrices multiply in.
  for (const name of ["h264_rot270.mp4", "h264_rot180_hflip.mp4", "h264_rot0_hflip_movie90.mp4"]) {
    it(name, async () => {
      const want = EXPECTED.fixtures[name];
      const ctx = await project(name.replace(/\W/g, "_"));
      const ref = await libRef(ctx, path.join(DIR, name), "video");
      const [w, h] = want.display;
      expect(((await setCanvasTool({ width: w, height: h, fps: 30 }, ctx)) as Rec).ok).toBe(true);
      const placed = (await addClipsTool(
        { entries: [{ media_ref: ref, timeline_in: 0, timeline_out: 2 }] },
        ctx,
      )) as Rec;
      expect(placed.ok, JSON.stringify(placed)).toBe(true);
      const res = (await exportTimelineTool({ name: "out" }, ctx)) as Rec;
      expect(res.ok, JSON.stringify(res)).toBe(true);
      const ended = await whenExportEnds(String(res.job_id));
      expect(ended?.state, String(ended?.error)).toBe("done");
      const out = await ctx.store.exportPath("out.mp4");
      expect(await decodedSize(out)).toEqual([w, h]);
      expect(cornersOf(await frame(out, true), w, h)).toEqual(want.corners);
    });
  }
});

describe("the preview proxy is upright and declares no turn", () => {
  // HEVC is what Samsung and iPhone portrait clips are; the WebView cannot decode it, so the
  // preview plays an H.264 proxy made by ffmpeg. The proxy must carry ffmpeg's turned picture and
  // no matrix, or the preview - which now honours a matrix - would turn it a second time.
  for (const name of ["h264_rot270.mp4", "h264_rot90_hflip.mp4", "h264_rot0_movie90.mp4"]) {
    it(`${name} as HEVC`, async () => {
      const want = EXPECTED.fixtures[name];
      const hevc = joinPath(ROOT, name.replace("h264", "hevc"));
      // -noautorotate keeps the stored frames AND the matrix, so this is the same file in HEVC.
      await ff([
        ...["-y", "-v", "error", "-noautorotate", "-i", path.join(DIR, name)],
        ...["-c:v", "libx265", "-x265-params", "log-level=error", "-tag:v", "hvc1", hevc],
      ]);
      const src = parseMp4(readFileSync(hevc));
      const declared = mp4Orientation(src.mp4, src.info.videoTracks[0]);
      const h264 = parseMp4(readFileSync(path.join(DIR, name)));
      expect(declared).toEqual(mp4Orientation(h264.mp4, h264.info.videoTracks[0]));

      const ctx = await project(`proxy_${name.replace(/\W/g, "_")}`);
      const ref = await libRef(ctx, hevc, "video");
      const abs = (await ctx.store.resolveRef(ref))!;
      await processImportedMedia(ctx.store, ctx.runner, abs);
      const proxy = joinPath(ctx.store.projectDir, proxyRel(abs));
      expect(existsSync(proxy), "no proxy was made for HEVC").toBe(true);

      const p = parseMp4(readFileSync(proxy));
      const track = p.info.videoTracks[0];
      expect(track.codec.startsWith("avc1.42"), "the proxy is not Baseline H.264").toBe(true);
      expect(mp4Orientation(p.mp4, track)).toEqual(UPRIGHT);
      // Upright in its STORED pixels: decoded without autorotate it is already ffmpeg's picture.
      const [pw, ph] = [track.video.width, track.video.height];
      expect([pw, ph], "a small proxy must not enlarge its source").toEqual(want.display);
      expect(Math.sign(pw - ph)).toBe(Math.sign(want.display[0] - want.display[1]));
      expect(cornersOf(await frame(proxy, false), pw, ph)).toEqual(want.corners);
    });
  }
});

it.skipIf(!process.env.ARTDADDY_PIXEL_REPORT)(
  "prepares normalized fixtures for the native pixel gate",
  async () => {
    const projectDir = process.env.ARTDADDY_PIXEL_PROJECT!.replace(/\\/g, "/");
    await nodeFs.mkdir(projectDir);
    await openE2EDoc(projectDir);
    const ctx = mkCtx(projectDir);
    await ensureTimeline(ctx.store);
    await flushE2EDoc(projectDir);
    const timelinePath = path.join(projectDir, "internals", "timeline.json");
    const timelineBefore = readFileSync(timelinePath);
    setAssetAccessGrant(async () => {});
    setAssetUrlConverter(
      (file) =>
        new URL(
          `/${path.relative(process.cwd(), file).replace(/\\/g, "/")}`,
          process.env.ARTDADDY_PIXEL_BASE_URL!,
        ).href,
    );
    const urls: Record<string, string> = {};
    for (const file of [
      ...ROTATION_FIXTURES.map((fixture) => fixture.file),
      "h264_size_control.mp4",
      "h264_baseline_control.mp4",
      "h264_tagged_control.mp4",
    ]) {
      const original = path.join(DIR, file);
      const bytesBefore = readFileSync(original);
      const ref = await libRef(ctx, original, "video");
      const libraryBefore = JSON.stringify(await ctx.store.listClips());
      const abs = (await ctx.store.resolveRef(ref))!;
      await processImportedMedia(ctx.store, ctx.runner, abs);
      const url = await resolvePreviewUrl(ctx.store, ref);
      expect(url, `no normalized preview for ${file}`).toBeTruthy();
      expect(url, `the original escaped normalization for ${file}`).toContain(".r4.mp4");
      urls[file] = url!;
      expect(readFileSync(original).equals(bytesBefore), `original media changed: ${file}`).toBe(
        true,
      );
      expect(
        JSON.stringify(await ctx.store.listClips()),
        `library changed during normalization: ${file}`,
      ).toBe(libraryBefore);
    }
    await flushE2EDoc(projectDir);
    expect(
      readFileSync(timelinePath).equals(timelineBefore),
      "normalization changed the timeline",
    ).toBe(true);
    await fsp.writeFile(process.env.ARTDADDY_PIXEL_REPORT!, JSON.stringify(urls));
  },
);
