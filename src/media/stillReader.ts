// Which of ffmpeg's readers opens a still, decided from its first bytes the way ffmpeg's own probe
// decides it (libavformat: apngdec.c apng_probe, webp_anim_dec.c webp_anim_probe, format.c
// av_probe_input_buffer2), and how the export loops it. A still plays as many passes as the file
// says, the way Chromium plays it (measured with ImageDecoder in the app's own WebView): GIF without
// a NETSCAPE loop extension once, with loop count 0 forever, with N N+1 times; APNG num_plays and
// WebP loop count: 0 forever, N N times. Each pass starts on a cleared canvas, as in a browser.
// Measured on the shipped ffmpeg, frame by frame over 20 s at 25 and 30 fps:
//   - picture (image2 and the *_pipe readers: JPEG, PNG, WebP, BMP, TIFF): `-loop 1` only.
//     `-stream_loop -1` HANGS on a JPEG.
//   - gif, mov (AVIF/HEIC): `-stream_loop`, exact. They refuse `-loop` ("Option loop not found"),
//     which failed the whole export. `-stream_loop` ignores the file's count, so it is given it.
//   - webp_anim: `-ignore_loop 0`, its reader's own loop, which honours the count exactly.
//     `-stream_loop -1` HANGS on it.
//   - apng: `-stream_loop` HANGS on 2..8 frames with the default decoder threads (on 4 threads from
//     2 frames), and with one thread it STOPS after a pass when the first frame is not a key frame
//     (Pillow writes them so). `-ignore_loop 0` drifts after ~5 s and leaves earlier frames on the
//     canvas. So an APNG is decoded once and its frames looped in the graph (`loop`), exact for
//     every encoder; it holds one pass in memory, at its own size or the size it is drawn at,
//     whichever is smaller. Past a budget, one with a key first frame loops by single-threaded
//     `-stream_loop` instead (exact, never hangs).
// The file's NAME is not consulted: ffmpeg probes content, so a GIF saved as .png is a GIF to it.
// stillReader.smoke.e2e.ts holds this to the shipped ffmpeg, file by file.

import { ffmpegCanDecodeSize } from "../tools/imageDims";

export type StillReader = "picture" | "gif" | "apng" | "webp_anim" | "mov";

/** ffmpeg's first probe reads this much and stops as soon as a reader scores high, which a PNG's
 *  own signature always does. An animation chunk further in is never seen. */
export const PROBE_BYTES = 2048;

/** Most pixels (frames x width x height, at the size it is drawn) the export holds to loop an APNG
 *  in its graph: 256 MB of RGBA. A full-canvas 1080p APNG of 30 frames fits. */
export const APNG_LOOP_PIXELS = 64e6;

/** What a still's bytes say about its animation. Each is null when they do not say. */
export interface StillFacts {
  /** False when they could not be read: the still then loops for its clip, as it always did. */
  known: boolean;
  /** Its own count as written: GIF NETSCAPE loop count (null: no extension), APNG num_plays, WebP
   *  ANIM loop count (null: not found). 0 = forever. */
  plays: number | null;
  /** Frames in one pass (APNG: acTL). */
  frames: number | null;
  /** Picture size (APNG: IHDR). */
  width: number | null;
  height: number | null;
  /** APNG: its first frame replaces the canvas (dispose/blend), which ffmpeg needs to seek back to it. */
  keyFirst?: boolean;
}

export const NO_FACTS: StillFacts = {
  known: false,
  plays: null,
  frames: null,
  width: null,
  height: null,
};

/** Counts this high are forever in practice (65535, the GIF field's largest, is written to mean it),
 *  and past ffmpeg's int range. */
const FOREVER_FROM = 65_535;

/** Passes a browser plays: Infinity = forever. A GIF with no loop extension plays once. */
export function browserPasses(reader: StillReader, facts: StillFacts): number {
  if (!facts.known) return Infinity;
  const p = facts.plays;
  const passes = (n: number) => (n >= FOREVER_FROM ? Infinity : n);
  switch (reader) {
    case "gif":
      return p === null ? 1 : p === 0 ? Infinity : passes(p + 1);
    case "apng":
    case "webp_anim":
      return p === null || p === 0 ? Infinity : passes(p);
    case "picture":
    case "mov":
      return Infinity;
  }
}

/** How the export reads and loops a still. One answer for the export (its command and graph) and
 *  the preview (which frame shows when). */
export interface StillLoop {
  /** Input options, before `-t` and `-i`. */
  input: string[];
  /** A `loop` filter over one decoded pass; null: the input loops. */
  graph: string | null;
  /** The graph loop runs once the still is fitted to its box (smaller there than as decoded), not
   *  on its frames as decoded: it holds them at whichever size is smaller. */
  graphAfterFit?: true;
  /** Passes played: Infinity = loops for the whole clip. */
  passes: number;
  /** Its stream can end before its clip does, so the export holds its last frame (else it vanishes). */
  hold: boolean;
}

/** How the export loops a still, given what its bytes say (stillProbe.ts). `drawnPixels` is one
 *  frame's size once the export has fitted it to its box; it bounds an APNG's loop. */
export function stillLoop(
  reader: StillReader,
  fps: number,
  facts: StillFacts = NO_FACTS,
  drawnPixels = Infinity,
): StillLoop {
  const passes = browserPasses(reader, facts);
  const finite = Number.isFinite(passes);
  const repeat = finite ? String(passes - 1) : "-1";
  switch (reader) {
    case "picture":
      return { input: ["-loop", "1", "-framerate", String(fps)], graph: null, passes, hold: false };
    case "gif":
      return {
        input: passes === 1 ? [] : ["-stream_loop", repeat],
        graph: null,
        passes,
        hold: finite,
      };
    case "mov":
      return { input: ["-stream_loop", "-1"], graph: null, passes, hold: false };
    case "webp_anim":
      // Its reader plays the count it reads itself: when ours is unknown, hold in case it ends.
      return {
        input: ["-ignore_loop", "0"],
        graph: null,
        passes,
        hold: finite || facts.plays === null,
      };
    case "apng": {
      if (passes === 1) return { input: [], graph: null, passes, hold: true };
      const frames = facts.frames ?? Infinity;
      const source = (facts.width ?? Infinity) * (facts.height ?? Infinity);
      if (frames * Math.min(drawnPixels, source) > APNG_LOOP_PIXELS && facts.keyFirst)
        return {
          input: ["-threads", "1", "-stream_loop", repeat],
          graph: null,
          passes,
          hold: finite,
        };
      // 32767 is the filter's largest window: it loops what one pass decoded, however many frames.
      const graph = `loop=loop=${repeat}:size=32767:start=0`;
      return drawnPixels < source
        ? { input: [], graph, graphAfterFit: true, passes, hold: finite }
        : { input: [], graph, passes, hold: finite };
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
      ascii(head, 12, "VP8X") &&
      head.length > 20 &&
      u32le(head, 16) === 10 &&
      (head[20] & 0x02) !== 0;
    return animated ? "webp_anim" : "picture";
  }
  if (PNG_SIG.every((v, i) => head[i] === v)) return isApng(head) ? "apng" : "picture";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "picture";
  if (ascii(head, 0, "BM")) return "picture";
  if (ascii(head, 0, "II*\0") || ascii(head, 0, "MM\0*")) return "picture";
  return null;
}

/** What a still's first bytes say about its animation, read where ffmpeg reads it; {@link NO_FACTS}
 *  when they do not say it all (stillProbe.ts reads further, or asks ffprobe).
 *  - APNG: acTL (frames, num_plays), IHDR (size), and whether the first fcTL makes a key frame
 *    (apngdec.c decode_fctl_chunk) -- all inside the probe window, or ffmpeg would not have called
 *    the file an APNG.
 *  - WebP: the ANIM loop count, after VP8X and any ICCP (webp_anim_dec.c reads chunks in order
 *    until the first frame), when the head reaches it. */
export function stillFacts(head: Uint8Array): StillFacts {
  const reader = stillReader(head);
  if (reader === "apng") {
    const width = u32be(head, 16);
    const height = u32be(head, 20);
    let facts: StillFacts | null = null;
    for (let at = 8; at + 8 <= head.length;) {
      const len = u32be(head, at);
      const body = at + 8;
      if (ascii(head, at + 4, "acTL")) {
        if (body + 8 > head.length) return NO_FACTS;
        facts = {
          known: true,
          plays: u32be(head, body + 4),
          frames: u32be(head, body),
          width,
          height,
        };
      } else if (ascii(head, at + 4, "fcTL") && facts) {
        if (len !== 26 || body + 26 > head.length) return facts;
        // A frame covering the whole canvas is a key frame when it disposes to the background (or,
        // as the first frame, to "previous", which ffmpeg reads as background) or replaces pixels.
        const whole =
          u32be(head, body + 4) === width &&
          u32be(head, body + 8) === height &&
          u32be(head, body + 12) === 0 &&
          u32be(head, body + 16) === 0;
        const dispose = head[body + 24];
        const blend = head[body + 25];
        return { ...facts, keyFirst: whole && (dispose === 1 || dispose === 2 || blend === 0) };
      }
      if (len > 0x7fffffff) return facts ?? NO_FACTS;
      at = body + len + 4;
    }
    return facts ?? NO_FACTS;
  }
  if (reader === "webp_anim") {
    for (let at = 12; at + 8 <= head.length;) {
      const size = u32le(head, at + 4);
      if (ascii(head, at, "ANIM")) {
        if (size !== 6 || at + 14 > head.length) return NO_FACTS;
        return webpFacts(head[at + 12] | (head[at + 13] << 8));
      }
      if (ascii(head, at, "ANMF")) return webpFacts(1); // a frame before any ANIM: ffmpeg plays it once
      at += 8 + size + (size & 1);
    }
  }
  return NO_FACTS;
}

export const webpFacts = (plays: number): StillFacts => ({ ...NO_FACTS, known: true, plays });

/** The next RIFF chunk of an animated WebP, from its 8-byte header at `offset`: its loop count when
 *  it is ANIM (`anim` holds the 6 payload bytes), a frame before any ANIM (plays once), or where the
 *  next chunk starts. stillProbe.ts walks a file this way, a few bytes per chunk. */
export function webpChunk(
  header: Uint8Array,
  offset: number,
  anim?: Uint8Array,
): { plays: number } | { next: number } | null {
  if (header.length < 8) return null;
  const size = u32le(header, 4);
  if (ascii(header, 0, "ANIM")) {
    if (size !== 6 || !anim || anim.length < 6) return null;
    return { plays: anim[4] | (anim[5] << 8) };
  }
  if (ascii(header, 0, "ANMF")) return { plays: 1 };
  return { next: offset + 8 + size + (size & 1) };
}
