// Which of ffmpeg's readers opens a still, decided from its first bytes the way ffmpeg's own probe
// decides it (libavformat: apngdec.c apng_probe, webp_anim_dec.c webp_anim_probe, format.c
// av_probe_input_buffer2), and the loop option that reader takes. Measured on the shipped ffmpeg,
// looping a 1 s animation for 3.5 s:
//   - picture (image2 and the *_pipe readers: JPEG, PNG, WebP, BMP, TIFF): `-loop 1` only.
//     `-stream_loop -1` HANGS on a JPEG.
//   - gif, apng, mov (AVIF/HEIC): `-stream_loop -1`. They refuse `-loop` ("Option loop not found"),
//     which failed the whole export; apng under its own `-ignore_loop 0` drifts out of phase.
//   - webp_anim: `-ignore_loop 0`, its reader's own loop. `-stream_loop -1` HANGS on it.
// The file's NAME is not consulted: ffmpeg probes content, so a GIF saved as .png is a GIF to it.
// stillReader.smoke.e2e.ts holds this to the shipped ffprobe's own verdict, file by file.

import { ffmpegCanDecodeSize } from "../tools/imageDims";

export type StillReader = "picture" | "gif" | "apng" | "webp_anim" | "mov";

/** ffmpeg's first probe reads this much and stops as soon as a reader scores high, which a PNG's
 *  own signature always does. An animation chunk further in is never seen. */
export const PROBE_BYTES = 2048;

/** The input options that loop a still of this reader for as long as the clip asks. */
export function stillLoopArgs(reader: StillReader, fps: number): string[] {
  switch (reader) {
    case "picture":
      return ["-loop", "1", "-framerate", String(fps)];
    case "webp_anim":
      return ["-ignore_loop", "0"];
    case "gif":
    case "apng":
    case "mov":
      return ["-stream_loop", "-1"];
  }
}

const ascii = (b: Uint8Array, o: number, s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false;
  return true;
};
const u32be = (b: Uint8Array, o: number): number =>
  b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
const u32le = (b: Uint8Array, o: number): number =>
  (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** apng_probe: IHDR (13 bytes, a decodable size), then acTL (8 bytes, frames > 0), then IDAT,
 *  every chunk before IDAT wholly inside the probe buffer. */
function isApng(head: Uint8Array): boolean {
  const b = head.subarray(0, PROBE_BYTES);
  let at = 8;
  let state = 0;
  for (;;) {
    if (at + 8 > b.length) return false;
    const len = u32be(b, at);
    if (len > 0x7fffffff) return false;
    const type = String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7]);
    const body = at + 8;
    if (type !== "IDAT" && body + len + 4 > b.length) return false;
    if (type === "IHDR") {
      if (len !== 13 || !ffmpegCanDecodeSize(u32be(b, body), u32be(b, body + 4))) return false;
      state++;
    } else if (type === "acTL") {
      if (state !== 1 || len !== 8 || u32be(b, body) === 0) return false;
      state++;
    } else if (type === "IDAT") {
      return state === 2;
    }
    at = body + len + 4;
  }
}

/** The reader ffmpeg will open this still with, or null when the bytes are not a still format we
 *  know (the caller keeps its own rule then). */
export function stillReader(head: Uint8Array): StillReader | null {
  if (ascii(head, 0, "GIF87a") || ascii(head, 0, "GIF89a")) return "gif";
  if (ascii(head, 4, "ftyp")) return "mov";
  if (ascii(head, 0, "RIFF") && ascii(head, 8, "WEBP")) {
    const animated =
      ascii(head, 12, "VP8X") && head.length > 20 && u32le(head, 16) === 10 && (head[20] & 0x02) !== 0;
    return animated ? "webp_anim" : "picture";
  }
  if (PNG_SIG.every((v, i) => head[i] === v)) return isApng(head) ? "apng" : "picture";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "picture";
  if (ascii(head, 0, "BM")) return "picture";
  if (ascii(head, 0, "II*\0") || ascii(head, 0, "MM\0*")) return "picture";
  return null;
}
