// THE picture of a HEIF-family still (HEIC, HEIF, AVIF), for every consumer.
//
// ffmpeg opens these with its MP4 reader, and each image ITEM becomes a stream. Read naively, as
// `-i file` with a `-vf` or as `[N:v]`, that went wrong in four ways, all measured with the shipped
// build: a TILED picture (every iPhone photo: a 4032x3024 grid of 512px tiles) came through as its
// first tile, and any `-vf` on it failed outright ("Simple and complex filtering cannot be used
// together"); a thumbnail stored ahead of the photo was taken for the photo; an alpha plane, a
// separate auxiliary item, was dropped; and every probe reported the size of a tile. The preview's
// stand-in, the poster, the export, inspect_media, inspect_color, crop_image, the stills uploaded to a
// model (generation references, vision) and the scale clamp each read the file their own way, so each
// failed its own way.
//
// So the picture is decoded ONCE, here, into a lossless PNG: the primary item (ffmpeg marks it with
// the `default` disposition from `pitm`; a tile grid is a stream group), turned upright (`irot`/`imir`,
// applied by ffmpeg), its long edge bounded, its alpha plane merged when the file declares one
// (heifBoxes.ts: ffmpeg cannot tell alpha from depth). Every consumer reads that file. PNG because it
// is lossless and keeps alpha; lossy WebP measured 26 dB on a 12 MP photo, which is visible.
//
// A leaf module: the encoder that uploads stills to a model reads through it, and tools/media reaches
// that encoder through the import door, so nothing here may import tools/media.
import type { CommandRunner } from "../tools/command";
import type { ProjectStoreAccess } from "../tools/store";
import { imageProxyName } from "../preview/proxyPaths";
import { extOf, HEIF_EXTS } from "./formats";
import { readHeifLayout } from "./heifBoxes";
import { transcode } from "./transcode";

/** Stills whose picture must be decoded here before anything else reads them. */
export function isHeifStill(nameOrPath: string): boolean {
  return (HEIF_EXTS as readonly string[]).includes(extOf(nameOrPath));
}

/** Long-edge bound: a GPU texture (and av_image_check_size2) refuses huge frames, and nothing in
 *  the app draws or exports wider than 4K. Applied to the UPRIGHT picture. */
export const STILL_MAX_EDGE = 3840;

/** Leading bytes read for the box parser. An iPhone photo's meta is ~10 KB; this leaves headroom
 *  for large embedded metadata ahead of it. Bounded because the desktop probe returns the head over
 *  IPC as a JSON number array (~4x its size). */
const HEAD_BYTES = 256 * 1024;

export type StillPicture = { path: string } | { error: string };

/** How ffmpeg sees the file: streams and groups by index and id, and which one is the primary. */
interface Inventory {
  streams: { index: number; id: number; primary: boolean }[];
  groups: { index: number; id: number; primary: boolean }[];
}

async function inventory(runner: CommandRunner, abs: string): Promise<Inventory | string> {
  const r = await runner.run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=index,id:stream_disposition=default:stream_group=index,id:stream_group_disposition=default",
    "-of",
    "json",
    abs,
  ]);
  if (r.code !== 0) return r.stderr.trim().split(/\r?\n/).pop() || "ffprobe could not read it";
  try {
    const j = JSON.parse(r.stdout) as {
      streams?: { index?: number; id?: string | number; disposition?: { default?: number } }[];
      stream_groups?: {
        index?: number;
        id?: string | number;
        disposition?: { default?: number };
      }[];
    };
    const norm = (x: {
      index?: number;
      id?: string | number;
      disposition?: { default?: number };
    }) => ({
      index: Number(x.index),
      id: Number(x.id), // ffprobe prints ids as hex ("0x3ea"), which Number reads
      primary: x.disposition?.default === 1,
    });
    return { streams: (j.streams ?? []).map(norm), groups: (j.stream_groups ?? []).map(norm) };
  } catch {
    return "ffprobe output was not readable";
  }
}

/** The filtergraph label of the picture to decode: the primary tile grid when there is one (ffmpeg
 *  marks it `default`), else the first `default` stream, else the first stream. */
function primaryLabel(inv: Inventory): string | null {
  const group = inv.groups.find((g) => g.primary);
  if (group) return `[0:g:${group.index}]`;
  const stream = inv.streams.find((s) => s.primary) ?? inv.streams[0];
  return stream ? `[0:${stream.index}]` : null;
}

/** The label of the declared alpha plane, when the file declares one ffmpeg exposes. */
function alphaLabel(inv: Inventory, alphaItem: number | undefined): string | null {
  if (alphaItem === undefined) return null;
  const s = inv.streams.find((x) => x.id === alphaItem);
  if (s) return `[0:${s.index}]`;
  const g = inv.groups.find((x) => x.id === alphaItem);
  return g ? `[0:g:${g.index}]` : null;
}

/** ffmpeg args (between the global options and the output) decoding the picture to one PNG frame:
 *  `picture` is its label, `alpha` the alpha plane's (or null). Exported for the conformance test,
 *  which recognises the owner's own reads by them. */
export function stillDecodeArgs(abs: string, picture: string, alpha: string | null): string[] {
  const bound = `scale='trunc(iw*min(1,${STILL_MAX_EDGE}/max(iw,ih)))':-1`;
  const graph = alpha
    ? // Alpha is scaled to the colour's final size (an alpha plane may be coded smaller), then merged.
      `${picture}${bound},format=rgb24,split[c][cr];${alpha}format=gray[a0];[a0][cr]scale=rw:rh[a];[c][a]alphamerge,format=rgba[still]`
    : `${picture}${bound},format=rgb24[still]`;
  return ["-i", abs, "-filter_complex", graph, "-map", "[still]", "-frames:v", "1", "-update", "1"];
}

/** Identity of one decode: the source as the preview keys it, plus its size so a file replaced in
 *  place is decoded again. In-flight decodes are shared, so two consumers asking at once run ffmpeg
 *  once. */
const inFlight = new Map<string, Promise<StillPicture>>();

/** Where the decoded picture of `abs` lives: with the preview's stand-ins, keyed as the preview
 *  looks them up, so the preview draws the very file the export renders. */
export function stillPicturePath(store: ProjectStoreAccess, abs: string): Promise<string> {
  return store.prepareArtifact(`proxies/${imageProxyName(abs)}`);
}

/** The upright, whole picture of `abs` as a PNG path, made on first use. Anything that is not a
 *  HEIF-family still is its own picture and comes back unchanged. */
export async function stillPicture(
  store: ProjectStoreAccess,
  runner: CommandRunner,
  abs: string,
  signal?: AbortSignal,
): Promise<StillPicture> {
  if (!isHeifStill(abs)) return { path: abs };
  const png = await stillPicturePath(store, abs);
  if (await store.exists(png).catch(() => false)) return { path: png };
  const key = `${store.projectDir}\u0000${png}`;
  let job = inFlight.get(key);
  if (!job) {
    job = decode(store, runner, abs, png, signal).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
  }
  return job;
}

async function decode(
  store: ProjectStoreAccess,
  runner: CommandRunner,
  abs: string,
  png: string,
  signal?: AbortSignal,
): Promise<StillPicture> {
  const name = abs.split(/[\\/]/).pop() ?? abs;
  const inv = await inventory(runner, abs);
  if (typeof inv === "string") return { error: `'${name}' cannot be read: ${inv}` };
  const picture = primaryLabel(inv);
  if (!picture) return { error: `'${name}' has no picture in it` };
  // Alpha needs the boxes; a file whose head cannot be read just has no alpha plane merged.
  const head = await store.probeMedia(abs, HEAD_BYTES).catch(() => null);
  const layout = head ? readHeifLayout(head.head) : null;
  // The alpha plane is merged only when it is turned the way the picture is: ffmpeg orients each
  // stream by its own properties, and MIAF has the auxiliary carry the master's.
  const alphaItem = layout?.alpha.find(
    (a) =>
      JSON.stringify(layout.transforms.get(a) ?? []) ===
      JSON.stringify(layout.transforms.get(layout.primary) ?? []),
  );
  const alpha = alphaLabel(inv, alphaItem);
  if (await transcode(store, runner, png, stillDecodeArgs(abs, picture, alpha), signal))
    return { path: png };
  // A declared alpha plane that will not decode must not cost the user the picture itself.
  if (alpha && (await transcode(store, runner, png, stillDecodeArgs(abs, picture, null), signal)))
    return { path: png };
  return { error: `'${name}' could not be decoded` };
}
