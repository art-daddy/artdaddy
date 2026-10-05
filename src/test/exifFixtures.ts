// Stills that carry an EXIF ORIENTATION, written byte by byte (pure). A phone stores a portrait photo
// as a landscape frame plus Orientation 6; every decoder shows it upright, but the stream size stays
// the stored one. The shipped ffmpeg honours it for JPEG (APP1) and PNG (eXIf) alike, measured.
import { exifOrientation } from "./heifWriter";

/** JPEG bytes with an EXIF APP1 segment (Orientation = `o`, 1-8) inserted right after SOI. */
export function jpegWithOrientation(jpg: Uint8Array, o: number): Buffer {
  const src = Buffer.from(jpg);
  if (src[0] !== 0xff || src[1] !== 0xd8) throw new Error("not a JPEG");
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), exifOrientation(o)]);
  const head = Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]);
  return Buffer.concat([src.subarray(0, 2), head, payload, src.subarray(2)]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** PNG bytes with an eXIf chunk (Orientation = `o`, 1-8) inserted before the first IDAT. */
export function pngWithOrientation(png: Uint8Array, o: number): Buffer {
  const src = Buffer.from(png);
  const body = Buffer.concat([Buffer.from("eXIf", "latin1"), exifOrientation(o)]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length - 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  let at = 8;
  while (at + 8 <= src.length && src.toString("latin1", at + 4, at + 8) !== "IDAT")
    at += 12 + src.readUInt32BE(at);
  if (at + 8 > src.length) throw new Error("not a PNG with image data");
  return Buffer.concat([src.subarray(0, at), len, body, crc, src.subarray(at)]);
}
