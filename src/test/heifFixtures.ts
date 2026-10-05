// Real HEIF stills for the e2e lane: heifWriter.ts's boxes around HEVC the shipped x265 codes. Only
// e2e files import this (it runs ffmpeg).
import { promises as fsp } from "node:fs";

import { ff } from "../tools/__e2e";
import { joinPath } from "../tools/store";
import {
  ALPHA_HEVC,
  DEPTH_HEVC,
  auxC,
  exifOrientation,
  heifFile,
  irot,
  type Coded,
  type Item,
  type Ref,
} from "./heifWriter";

interface Box {
  type: string;
  body: number;
  end: number;
}
function kids(b: Buffer, start: number, end: number): Box[] {
  const out: Box[] = [];
  for (let at = start; at + 8 <= end;) {
    let size = b.readUInt32BE(at);
    let hdr = 8;
    if (size === 1) {
      size = Number(b.readBigUInt64BE(at + 8));
      hdr = 16;
    }
    if (size === 0) size = end - at;
    out.push({ type: b.toString("latin1", at + 4, at + 8), body: at + hdr, end: at + size });
    at += size;
  }
  return out;
}
function kid(b: Buffer, parent: { body: number; end: number }, type: string, skip = 0): Box {
  const found = kids(b, parent.body + skip, parent.end).find((c) => c.type === type);
  if (!found) throw new Error(`no ${type} box`);
  return found;
}

/** HEVC-code a still (any file ffmpeg reads) of size `w`x`h`: its hvcC and its one sample, lifted
 *  out of the MP4 x265 writes. */
export async function hevcStill(src: string, w: number, h: number): Promise<Coded> {
  const mp4 = `${src}.hevc.mp4`;
  await ff([
    "-y",
    "-v",
    "error",
    "-i",
    src,
    "-frames:v",
    "1",
    "-c:v",
    "libx265",
    "-x265-params",
    "log-level=error:info=0",
    "-pix_fmt",
    "yuv420p",
    "-tag:v",
    "hvc1",
    "-f",
    "mp4",
    mp4,
  ]);
  const b = await fsp.readFile(mp4);
  const top = { body: 0, end: b.length };
  let node: Box = kid(b, top, "moov");
  for (const t of ["trak", "mdia", "minf", "stbl", "stsd"]) node = kid(b, node, t);
  // stsd: version/flags + entry_count (8 bytes), then the hvc1 sample entry, whose child boxes
  // start after its 78-byte visual sample entry header.
  const entry = kids(b, node.body + 8, node.end)[0];
  const hvcC = kid(b, entry, "hvcC", 78);
  const mdat = kid(b, top, "mdat");
  return {
    hvcC: Buffer.from(b.subarray(hvcC.body, hvcC.end)),
    sample: Buffer.from(b.subarray(mdat.body, mdat.end)),
    w,
    h,
  };
}

/** Make the folder `file` will be written into. */
async function parentOf(file: string): Promise<void> {
  await fsp.mkdir(file.replace(/[\\/][^\\/]*$/, ""), { recursive: true });
}

/** A PNG of four flat quadrants (red, lime / blue, yellow) meeting at the centre. */
export async function quadrantPng(out: string, w: number, h: number): Promise<string> {
  await parentOf(out);
  const x = Math.floor(w / 2);
  const y = Math.floor(h / 2);
  await ff([
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=red:s=${w}x${h}:d=1,drawbox=x=${x}:y=0:w=${w - x}:h=${y}:color=lime:t=fill,drawbox=x=0:y=${y}:w=${x}:h=${h - y}:color=blue:t=fill,drawbox=x=${x}:y=${y}:w=${w - x}:h=${h - y}:color=yellow:t=fill`,
    "-frames:v",
    "1",
    out,
  ]);
  return out;
}

/** A flat-colour PNG (a thumbnail or auxiliary image that must NOT be shown as the photo). */
export async function flatPng(out: string, w: number, h: number, color: string): Promise<string> {
  await parentOf(out);
  await ff([
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=${w}x${h}:d=1`,
    "-frames:v",
    "1",
    out,
  ]);
  return out;
}

/** `picture` (w x h) cut into `tile`-px HEVC tiles, padded so the edge tiles are full-size as a real
 *  encoder's are; the grid's output crops them back to w x h. Items are returned hidden, row-major. */
export async function tiles(
  dir: string,
  picture: string,
  w: number,
  h: number,
  tile: number,
): Promise<{ items: Item[]; rows: number; cols: number }> {
  const rows = Math.ceil(h / tile);
  const cols = Math.ceil(w / tile);
  const items: Item[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const png = joinPath(dir, `tile_${r}_${c}.png`);
      await ff([
        "-y",
        "-v",
        "error",
        "-i",
        picture,
        "-vf",
        `pad=${cols * tile}:${rows * tile}:0:0:black,crop=${tile}:${tile}:${c * tile}:${r * tile}`,
        "-frames:v",
        "1",
        png,
      ]);
      items.push({ coded: await hevcStill(png, tile, tile), hidden: true });
    }
  return { items, rows, cols };
}

/** What an iPhone writes, at test scale: a THUMBNAIL item stored first (a flat colour, so taking it
 *  for the photo is visible), then the photo as a cropped tile grid (primary, optionally rotated by
 *  `turns` quarter turns), and a DEPTH auxiliary (flat white, which would make the photo opaque-or-
 *  holey if taken for alpha). The picture is `w`x`h` before rotation. `exif` adds the Exif item an
 *  iPhone also writes, carrying that EXIF orientation (a portrait photo has irot 1 AND Orientation
 *  6; HEIF readers must ignore the Exif one). */
export async function iphoneLikeHeic(
  dir: string,
  out: string,
  picture: string,
  w: number,
  h: number,
  opts: { tile: number; turns?: number; exif?: number },
): Promise<string> {
  await fsp.mkdir(dir, { recursive: true });
  const thumb = await hevcStill(
    await flatPng(joinPath(dir, "thumb.png"), 64, 48, "magenta"),
    64,
    48,
  );
  const grid = await tiles(dir, picture, w, h, opts.tile);
  const depth = await hevcStill(await flatPng(joinPath(dir, "depth.png"), w, h, "white"), w, h);
  // Items: 1 thumbnail, 2..N+1 tiles, N+2 grid (primary), N+3 depth.
  const n = grid.items.length;
  const gridId = n + 2;
  const items: Item[] = [
    { coded: thumb },
    ...grid.items,
    {
      grid: {
        rows: grid.rows,
        cols: grid.cols,
        w,
        h,
        tiles: grid.items.map((_, i) => i + 2),
      },
      props: opts.turns ? [irot(opts.turns)] : [],
    },
    { coded: depth, props: [auxC(DEPTH_HEVC)], hidden: true },
    ...(opts.exif !== undefined ? [{ exif: exifOrientation(opts.exif), hidden: true }] : []),
  ];
  const refs: Ref[] = [
    { type: "thmb", from: 1, to: [gridId] },
    { type: "auxl", from: n + 3, to: [gridId] },
    ...(opts.exif !== undefined ? [{ type: "cdsc" as const, from: n + 4, to: [gridId] }] : []),
  ];
  await fsp.writeFile(out, heifFile(items, gridId, refs, { shareProps: true }));
  return out;
}

/** An untiled HEIC whose primary has a declared ALPHA plane: `alphaPng` (grey, white = opaque). */
export async function alphaHeic(
  dir: string,
  out: string,
  picture: string,
  alphaPng: string,
  w: number,
  h: number,
): Promise<string> {
  await fsp.mkdir(dir, { recursive: true });
  const items: Item[] = [
    { coded: await hevcStill(picture, w, h) },
    { coded: await hevcStill(alphaPng, w, h), props: [auxC(ALPHA_HEVC)], hidden: true },
  ];
  await fsp.writeFile(out, heifFile(items, 1, [{ type: "auxl", from: 2, to: [1] }]));
  return out;
}
