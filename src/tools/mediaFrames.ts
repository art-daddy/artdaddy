// What inspect_media shows of a source: frames from a video or the still itself, fitted to 512 px
// with the coordinate grid, plus, for video, each frame's sharpness and noise measured on a grey
// copy of exactly those pixels (never on the JPEG, whose grid and compression would move the
// numbers). One ffmpeg per frame decodes it once and writes both.
import { stderrExcerpt } from "./command";
import type { ClientToolContext } from "./context";
import { withAssScratch } from "./assScratch";
import { laplacianVariance, noiseSigma } from "./frameMeasures";
import { fitDims, gridAss, gridFilter, OVERLAY_FONT_FILE, OVERLAY_REV } from "./inspectOverlay";
import { shortHash } from "./media";

/** Longest edge of a frame inspect_media attaches (Palmier sends 512). */
export const MEDIA_FRAME_EDGE = 512;
/** ffmpeg's mjpeg quantizer (2 = best, 31 = worst) for frames the agent sees. */
const FRAME_JPEG_Q = "4";
/** Frame decodes at once: each is its own ffmpeg, and a low-core machine must not be thrashed. */
const LANES = 4;

function ratio(v: unknown): number {
  const m = /^(\d+)[:/](\d+)$/.exec(String(v ?? "").trim());
  return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : 0;
}

/** The shape a source is SHOWN in: the probe's rotation-aware width and height, with the width
 *  stretched by the pixel aspect when pixels are not square (HDV, DV, some broadcast files). A
 *  rotated source's pixel aspect turns with it. Null when the probe has no usable size. */
export function displaySize(
  video: Record<string, unknown> | null,
): { w: number; h: number } | null {
  const w = Number(video?.width);
  const h = Number(video?.height);
  if (!(w > 0) || !(h > 0)) return null;
  const sar = ratio(video?.sample_aspect_ratio);
  const rot = Number(video?.rotation);
  const turned = Number.isFinite(rot) && Math.abs(Math.round(rot)) % 180 === 90;
  const pixel = sar > 0 ? (turned ? 1 / sar : sar) : 1;
  return { w: Math.max(1, Math.round(w * pixel)), h };
}

export interface MediaFrame {
  /** Source seconds the frame was taken at. */
  t: number;
  /** The JPEG the model sees, when the frame could be read. */
  path?: string;
  /** Variance of the Laplacian of the 512 px grey frame. */
  sharpness?: number;
  /** Immerkaer noise sigma (edges excluded) of the 512 px grey frame, 0-255 luma. */
  noise?: number;
  error?: string;
}

let seq = 0;
const token = (): string => `${Date.now().toString(36)}${(seq = (seq + 1) % 1e6).toString(36)}`;

/** Move a finished temp file into place, unless an identical run got there first. */
async function settle(ctx: ClientToolContext, tmp: string, final: string): Promise<void> {
  if (tmp === final) return;
  if (await ctx.store.exists(final)) await ctx.store.remove(tmp).catch(() => undefined);
  else await ctx.store.rename(tmp, final);
}

/** Frames of `src` at `times` (source seconds), each a grid JPEG fitted into `dims` plus its
 *  measures. Cached by file, size, time and look, so a repeat costs a file read. A frame that
 *  cannot be read is reported, and the rest still return. */
export async function sampleFrames(
  ctx: ClientToolContext,
  src: string,
  times: readonly number[],
  dims: { w: number; h: number },
  sizeKey: string,
): Promise<MediaFrame[]> {
  const grid = { name: `grid_${dims.w}x${dims.h}.ass`, content: gridAss(dims.w, dims.h) };
  const shots: MediaFrame[] = [];
  const one = async (t: number, cwd: string | undefined): Promise<MediaFrame> => {
    const key = shortHash(`${src}|${sizeKey}|${t.toFixed(3)}|${dims.w}x${dims.h}|g${OVERLAY_REV}`);
    const jpg = await ctx.store.prepareArtifact(`inspect/mf_${key}.jpg`);
    const grey = jpg.replace(/\.jpg$/, ".gray");
    if (!((await ctx.store.exists(jpg)) && (await ctx.store.exists(grey)))) {
      if (ctx.signal?.aborted) return { t, error: "cancelled" };
      // Written under temporary names and renamed into place: a parallel look at the same frame
      // never reads half a file, and a frame a round has shown is never rewritten under it.
      const tmp = ctx.store.canRename ? `.${token()}.tmp` : "";
      const tmpJpg = jpg.replace(/\.jpg$/, `${tmp}.jpg`);
      const tmpGrey = `${grey}${tmp}`;
      const r = await ctx.runner.run(
        "ffmpeg",
        [
          "-y",
          "-hide_banner",
          "-loglevel",
          "error",
          "-ss",
          Math.max(0, t).toFixed(3),
          "-i",
          src,
          "-filter_complex",
          `[0:v]scale=${dims.w}:${dims.h},setsar=1,split=2[s][m];[s]${gridFilter(grid.name)}[g];[m]format=gray[k]`,
          "-map",
          "[g]",
          "-frames:v",
          "1",
          "-q:v",
          FRAME_JPEG_Q,
          tmpJpg,
          "-map",
          "[k]",
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          tmpGrey,
        ],
        ctx.signal,
        cwd,
      );
      if (r.code !== 0 || !(await ctx.store.exists(tmpJpg)) || !(await ctx.store.exists(tmpGrey))) {
        if (tmp) {
          await ctx.store.remove(tmpJpg).catch(() => undefined);
          await ctx.store.remove(tmpGrey).catch(() => undefined);
        }
        const why = stderrExcerpt(r.stderr, 200).split(/\r?\n/).filter(Boolean).pop();
        return {
          t,
          error: `the frame at ${t.toFixed(2)}s could not be read${why ? ` — ${why}` : ""}`,
        };
      }
      await settle(ctx, tmpGrey, grey);
      await settle(ctx, tmpJpg, jpg);
    }
    const shot: MediaFrame = { t, path: jpg };
    const px = await ctx.store.readBytes(grey).catch(() => null);
    if (px && px.length === dims.w * dims.h) {
      shot.sharpness = laplacianVariance(px, dims.w, dims.h);
      shot.noise = noiseSigma(px, dims.w, dims.h);
    }
    return shot;
  };
  await withAssScratch(ctx, [grid], [OVERLAY_FONT_FILE], async (cwd) => {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(LANES, times.length) }, async () => {
        for (let i = next++; i < times.length; i = next++) shots[i] = await one(times[i], cwd);
      }),
    );
  });
  return shots;
}

/** A still fitted into `dims` with the grid drawn on, as a JPEG; null when ffmpeg cannot read it
 *  (the caller then falls back to the plain downscale). Cached like the frames. */
export async function stillWithGrid(
  ctx: ClientToolContext,
  src: string,
  dims: { w: number; h: number },
  sizeKey: string,
): Promise<string | null> {
  const grid = { name: `grid_${dims.w}x${dims.h}.ass`, content: gridAss(dims.w, dims.h) };
  const key = shortHash(`${src}|${sizeKey}|still|${dims.w}x${dims.h}|g${OVERLAY_REV}`);
  const jpg = await ctx.store.prepareArtifact(`inspect/mi_${key}.jpg`);
  if (await ctx.store.exists(jpg)) return jpg;
  const tmp = ctx.store.canRename ? jpg.replace(/\.jpg$/, `.${token()}.tmp.jpg`) : jpg;
  const r = await withAssScratch(ctx, [grid], [OVERLAY_FONT_FILE], (cwd) =>
    ctx.runner.run(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        src,
        "-filter_complex",
        `[0:v]scale=${dims.w}:${dims.h},setsar=1,${gridFilter(grid.name)}[g]`,
        "-map",
        "[g]",
        "-frames:v",
        "1",
        "-q:v",
        FRAME_JPEG_Q,
        tmp,
      ],
      ctx.signal,
      cwd,
    ),
  );
  if (r.code !== 0 || !(await ctx.store.exists(tmp))) {
    if (tmp !== jpg) await ctx.store.remove(tmp).catch(() => undefined);
    return null;
  }
  await settle(ctx, tmp, jpg);
  return jpg;
}

/** The size frames of a `display`-shaped source come out at. */
export function mediaFrameDims(display: { w: number; h: number }): { w: number; h: number } {
  return fitDims(display.w, display.h, MEDIA_FRAME_EDGE);
}
