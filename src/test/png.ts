// A small PNG reader and writer for the whole-frame parity references (e2e/ui/fixtures/parity/ref):
// 8-bit RGB written, 8-bit RGB or RGBA read, no interlace. Node only (zlib). The references are read
// by the smoke lane and by the browser lane's Node side, so neither needs ffmpeg to load one.
import { deflateSync, inflateSync } from "node:zlib";

import type { Picture } from "./frameParity";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** `picture` as a PNG file (8-bit RGB). Every row is stored against the row above (PNG's "Up"
 *  filter): a reference is flat regions and ramps, which that keeps small. */
export function encodePng(picture: Picture): Buffer {
  const { w, h, rgb } = picture;
  if (rgb.length !== w * h * 3) throw new Error(`png: ${rgb.length} bytes for ${w}x${h} RGB`);
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 2; // Up
    for (let i = 0; i < stride; i++) {
      const above = y > 0 ? rgb[(y - 1) * stride + i] : 0;
      raw[y * (stride + 1) + 1 + i] = (rgb[y * stride + i] - above) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ]);
}

/** The RGB pixels of an 8-bit RGB or RGBA PNG (alpha dropped), whoever wrote it. */
export function decodePng(file: Uint8Array): Picture {
  const bytes = Buffer.from(file);
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error("png: not a PNG file");
  let at = 8;
  let w = 0;
  let h = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (at < bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("ascii", at + 4, at + 8);
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (bytes.readUInt32BE(at + 8 + length) !== crc32(bytes.subarray(at + 4, at + 8 + length)))
      throw new Error(`png: bad CRC in ${type}`);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      const [depth, colour, , , interlace] = data.subarray(8, 13);
      if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6))
        throw new Error(`png: only 8-bit non-interlaced RGB/RGBA (depth ${depth}, type ${colour})`);
      channels = colour === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  if (!w || !h || !channels) throw new Error("png: no IHDR");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  if (raw.length !== (stride + 1) * h) throw new Error("png: image data has the wrong length");
  const pixels = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? pixels[y * stride + i - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const c = i >= channels && y > 0 ? pixels[(y - 1) * stride + i - channels] : 0;
      const predicted =
        filter === 0
          ? 0
          : filter === 1
            ? a
            : filter === 2
              ? b
              : filter === 3
                ? (a + b) >> 1
                : filter === 4
                  ? paeth(a, b, c)
                  : NaN;
      if (Number.isNaN(predicted)) throw new Error(`png: unknown filter ${filter}`);
      pixels[y * stride + i] = (line[i] + predicted) & 0xff;
    }
  }
  if (channels === 3) return { w, h, rgb: pixels };
  const rgb = new Uint8Array(w * h * 3);
  for (let p = 0; p < w * h; p++) rgb.set(pixels.subarray(p * 4, p * 4 + 3), p * 3);
  return { w, h, rgb };
}
