// Which of ffmpeg's readers opens a still, decided from its first bytes the way ffmpeg's own probe
// decides it (libavformat: apngdec.c apng_probe, webp_anim_dec.c webp_anim_probe, format.c
// av_probe_input_buffer2), and how the export loops it. Measured on the shipped ffmpeg:
//   - picture (image2 and the *_pipe readers: JPEG, PNG, WebP, BMP, TIFF): `-loop 1` only.
//     `-stream_loop -1` HANGS on a JPEG.
//   - gif, mov (AVIF/HEIC): `-stream_loop -1`. They refuse `-loop` ("Option loop not found"), which
//     failed the whole export. A GIF keeps its own timing over 20 s of loops (0 frames off).
//   - webp_anim: `-ignore_loop 0`, its reader's own loop, which honours the file's count exactly
//     (0 frames off over 20 s, forever and play-3). `-stream_loop -1` HANGS on it.
//   - apng: NO input loop is right. `-stream_loop -1` HANGS on every APNG of 1 to 8 frames (whatever
//     its size; 9+ do not), so a blinking icon's export never ended. `-ignore_loop 0` never hangs
//     but loses the file's timing after ~5 s (the last frame of each later pass is held a frame too
//     long: 347 of 600 frames off over 20 s), and on a play-N file it stops after N passes or loops
//     on, depending on the file's length. So the export decodes ONE pass and loops the decoded
//     frames itself (the `loop` filter): 0 frames off, for loop-forever and play-N alike. That
//     holds every frame in memory (528 MB for 60 frames of 1080p), so past a budget it falls back:
//     loop-forever to `-ignore_loop 0`, play-N to one pass, held.
// The file's NAME is not consulted: ffmpeg probes content, so a GIF saved as .png is a GIF to it.
// stillReader.smoke.e2e.ts holds this to the shipped ffprobe's own verdict, file by file.

import { ffmpegCanDecodeSize } from "../tools/imageDims";

export type StillReader = "picture" | "gif" | "apng" | "webp_anim" | "mov";

/** ffmpeg's first probe reads this much and stops as soon as a reader scores high, which a PNG's
 *  own signature always does. An animation chunk further in is never seen. */
export const PROBE_BYTES = 2048;

/** What a caller reads to answer both questions here: which reader (decided on the first
 *  {@link PROBE_BYTES}, as ffmpeg decides it) and the file's own play count, which an animated WebP
 *  may keep behind a colour profile. */
export const STILL_HEAD_BYTES = 64 * 1024;

/** Most decoded pixels (frames x width x height) the export holds to loop an APNG exactly: 256 MB
 *  of RGBA. A sticker of 512x512 x 60 frames is 16 M; 1080p x 30 frames just fits. */
export const APNG_LOOP_PIXELS = 64e6;

/** What a still's first bytes say about its animation. Each is null when they do not say. */
export interface StillFacts {
  /** Its own play count; 0 = forever. */
  plays: number | null;
  /** Frames in one pass (APNG: acTL). */
  frames: number | null;
  /** Picture size (APNG: IHDR). */
  width: number | null;
  height: number | null;
}

export const NO_FACTS: StillFacts = { plays: null, frames: null, width: null, height: null };

/** How the export reads and loops a still. One answer for the export (its command and graph) and
 *  the preview (which frame shows when). */
export interface StillLoop {
  /** Input options, before `-t` and `-i`. */
  input: string[];
  /** A filter that loops the decoded frames, first on the clip's chain; null when the input loops. */
  graph: string | null;
  /** Passes played before the last frame is held: Infinity = loops for the whole clip; null =
   *  unknown (an animated WebP whose count was not in the bytes read: ffmpeg reads it itself). */
  passes: number | null;
}

/** How the export loops a still of this reader, given what its bytes say ({@link stillFacts}). */
export function stillLoop(reader: StillReader, fps: number, facts: StillFacts = NO_FACTS): StillLoop {
  switch (reader) {
    case "picture":
      return { input: ["-loop", "1", "-framerate", String(fps)], graph: null, passes: Infinity };
    case "gif":
    case "mov":
      // `-stream_loop` ignores a GIF's own count: it loops for the clip.
      return { input: ["-stream_loop", "-1"], graph: null, passes: Infinity };
    case "webp_anim":
      return {
        input: ["-ignore_loop", "0"],
        graph: null,
        passes: facts.plays === null ? null : facts.plays === 0 ? Infinity : facts.plays,
      };
    case "apng": {
      const { plays, frames, width, height } = facts;
      if (plays === 1) return { input: [], graph: null, passes: 1 }; // one pass is all it plays
      const forever = !plays; // 0, or a count the bytes did not give: ffmpeg's own default is forever
      const fits =
        frames !== null && width !== null && height !== null && frames * width * height <= APNG_LOOP_PIXELS;
      if (fits)
        return {
          input: [],
          graph: `loop=loop=${forever ? -1 : plays! - 1}:size=${frames}:start=0`,
          passes: forever ? Infinity : plays!,
        };
      return forever
        ? { input: ["-ignore_loop", "0"], graph: null, passes: Infinity }
        : { input: [], graph: null, passes: 1 };
    }
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

/** What a still's first bytes say about its animation, read where ffmpeg reads it; {@link NO_FACTS}
 *  for anything that is not an animated PNG or WebP.
 *  - APNG: acTL (frames, num_plays) and IHDR (size), both inside the probe window or ffmpeg would
 *    not have called the file an APNG (apngdec.c).
 *  - WebP: the ANIM chunk's loop count, after VP8X and any ICCP (webp_anim_dec.c reads chunks in
 *    order until the first frame). */
export function stillFacts(head: Uint8Array): StillFacts {
  const reader = stillReader(head);
  if (reader === "apng") {
    const width = u32be(head, 16);
    const height = u32be(head, 20);
    for (let at = 8; at + 8 <= head.length; ) {
      const len = u32be(head, at);
      if (ascii(head, at + 4, "acTL")) {
        if (at + 16 > head.length) return NO_FACTS;
        return { plays: u32be(head, at + 12), frames: u32be(head, at + 8), width, height };
      }
      if (len > 0x7fffffff) return NO_FACTS;
      at += 12 + len;
    }
    return NO_FACTS;
  }
  if (reader === "webp_anim") {
    for (let at = 12; at + 8 <= head.length; ) {
      const size = u32le(head, at + 4);
      if (ascii(head, at, "ANIM")) {
        if (size !== 6 || at + 14 > head.length) return NO_FACTS;
        return { ...NO_FACTS, plays: head[at + 12] | (head[at + 13] << 8) };
      }
      // A frame before any ANIM: ffmpeg plays it once.
      if (ascii(head, at, "ANMF")) return { ...NO_FACTS, plays: 1 };
      at += 8 + size + (size & 1);
    }
  }
  return NO_FACTS;
}
