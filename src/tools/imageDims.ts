// Raster size read straight from an image file's header, plus the size ffmpeg will
// actually decode.
//
// libavutil rejects an oversized image BEFORE producing any pixels, so such a file is
// not "slow" — it never decodes at all. With `-loop 1` (how the renderer feeds a still)
// ffmpeg retries instead of failing, so a 6864x41754 full-page screenshot spun for 29
// minutes with no output and no error. Pure + synchronous on purpose: the library import
// boundary has no command runner, and a guard that only runs where a sidecar happens to
// be installed does not hold the invariant.

export interface ImageSize {
  width: number;
  height: number;
}

/** libavutil's `av_image_check_size2`: (w+128)*(h+128) must stay under INT_MAX/8. */
const FFMPEG_MAX_AREA = 0x7fffffff / 8;

/** Whether ffmpeg's decoders will accept an image of this size. NaN/Infinity fall out as false
 *  through the comparison below, so they need no separate guard. */
export function ffmpegCanDecodeSize(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false;
  return (width + 128) * (height + 128) < FFMPEG_MAX_AREA;
}

const u16be = (b: Uint8Array, o: number): number => (b[o] << 8) | b[o + 1];
const u16le = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8);
const u24le = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32be = (b: Uint8Array, o: number): number =>
  b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
const u32le = (b: Uint8Array, o: number): number =>
  (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
const i32le = (b: Uint8Array, o: number): number => u32le(b, o) | 0;

const ascii = (b: Uint8Array, o: number, s: string): boolean => {
  // Past the end reads as undefined, which matches no char code, so no length guard is needed.
  for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false;
  return true;
};

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngSize(b: Uint8Array): ImageSize | null {
  if (b.length < 24) return null;
  for (let i = 0; i < PNG_SIG.length; i++) if (b[i] !== PNG_SIG[i]) return null;
  if (!ascii(b, 12, "IHDR")) return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function jpegSize(b: Uint8Array): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null; // desynced from the segment chain
    let marker = b[i + 1];
    while (marker === 0xff && i + 2 < b.length) marker = b[++i + 1]; // fill bytes
    // SOF0..SOF15 carry the frame size; C4/C8/CC are huffman/JPEG-LS/arithmetic tables.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > b.length) return null;
      return { width: u16be(b, i + 7), height: u16be(b, i + 5) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // standalone marker, no length field
      continue;
    }
    // EOI / start of entropy-coded scan / a stuffed 0x00: no frame header will follow.
    if (marker === 0xd9 || marker === 0xda || marker === 0x00) return null;
    const len = u16be(b, i + 2);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function gifSize(b: Uint8Array): ImageSize | null {
  if (b.length < 10 || !ascii(b, 0, "GIF8")) return null;
  return { width: u16le(b, 6), height: u16le(b, 8) };
}

function webpSize(b: Uint8Array): ImageSize | null {
  if (b.length < 16 || !ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return null;
  if (ascii(b, 12, "VP8X"))
    return b.length >= 30 ? { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) } : null;
  if (ascii(b, 12, "VP8L")) {
    if (b.length < 25 || b[20] !== 0x2f) return null;
    const bits = u32le(b, 21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (ascii(b, 12, "VP8 ")) {
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null; // sync code
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  return null;
}

function bmpSize(b: Uint8Array): ImageSize | null {
  if (b.length < 26 || b[0] !== 0x42 || b[1] !== 0x4d) return null;
  // BITMAPCOREHEADER is 12 bytes with 16-bit dimensions; every later DIB header is 32-bit.
  if (u32le(b, 14) === 12) return { width: u16le(b, 18), height: u16le(b, 20) };
  // A negative height means top-down row order, not a negative size.
  return { width: i32le(b, 18), height: Math.abs(i32le(b, 22)) };
}

/** Pixel dimensions AS THE HEADER STATES THEM, or null when the bytes are not one of the
 *  formats parsed here (avif/tiff/svg) or the header is truncated. A stated 0 is reported,
 *  not filtered: ffprobe reports exactly that for the file this guard exists for. Null means
 *  UNKNOWN, never "fine" — callers must not treat it as a pass. */
export function readImageSize(bytes: Uint8Array): ImageSize | null {
  return pngSize(bytes) ?? jpegSize(bytes) ?? gifSize(bytes) ?? webpSize(bytes) ?? bmpSize(bytes);
}

/** The one rule: a still ffmpeg refuses to decode must never reach the renderer.
 *  Returns a human-readable reason, or null when the image is fine OR unparseable. */
export function undecodableImageReason(bytes: Uint8Array): string | null {
  const size = readImageSize(bytes);
  if (!size || ffmpegCanDecodeSize(size.width, size.height)) return null;
  return `${size.width}x${size.height} is past the video renderer's decode limit (~268 megapixels) — ffmpeg produces no frames at all from it. Crop or downscale it first`;
}
