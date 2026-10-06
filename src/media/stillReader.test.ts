import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  APNG_LOOP_PIXELS,
  browserPasses,
  NO_FACTS,
  stillFacts,
  stillLoop,
  stillReader,
  webpChunk,
} from "./stillReader";

const bytes = (...parts: (number[] | string)[]): Uint8Array =>
  new Uint8Array(
    parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)),
  );
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
/** A PNG chunk with a zero CRC (the classifier reads structure, not checksums). */
const chunk = (type: string, len = 0, data: number[] = []) => [
  ...u32(len),
  ...[...type].map((c) => c.charCodeAt(0)),
  ...data,
  ...new Array(len - data.length).fill(0),
  0,
  0,
  0,
  0,
];
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** IHDR for a 200x200 picture, and an acTL declaring 20 frames: what a real APNG carries. */
const IHDR = chunk("IHDR", 13, [...u32(200), ...u32(200), 8, 6, 0, 0, 0]);
const acTL = chunk("acTL", 8, [...u32(20), ...u32(0)]);
/** RIFF/WEBP with one VP8X chunk carrying `flags`. */
const webpX = (flags: number) =>
  bytes("RIFF", le32(30), "WEBP", "VP8X", le32(10), [flags, 0, 0, 0], [0, 0, 0, 0, 0, 0]);

describe("stillReader: which of ffmpeg's readers opens a still", () => {
  it("names the single-picture reader for JPEG, PNG, static WebP, BMP and TIFF", () => {
    expect(stillReader(bytes([0xff, 0xd8, 0xff, 0xe0], new Array(20).fill(0)))).toBe("picture");
    expect(stillReader(bytes(PNG_SIG, IHDR, chunk("IDAT", 4)))).toBe("picture");
    expect(stillReader(bytes("RIFF", le32(30), "WEBP", "VP8 ", new Array(20).fill(0)))).toBe(
      "picture",
    );
    expect(stillReader(bytes("RIFF", le32(30), "WEBP", "VP8L", new Array(20).fill(0)))).toBe(
      "picture",
    );
    expect(stillReader(webpX(0x10))).toBe("picture"); // VP8X with alpha, not animated
    expect(stillReader(bytes("BM", new Array(30).fill(0)))).toBe("picture");
    expect(stillReader(bytes("II", [42, 0], new Array(8).fill(0)))).toBe("picture");
    expect(stillReader(bytes("MM", [0, 42], new Array(8).fill(0)))).toBe("picture");
  });

  it("names ffmpeg's own readers for GIF, animated PNG, animated WebP and HEIF/AVIF", () => {
    expect(stillReader(bytes("GIF89a", new Array(10).fill(0)))).toBe("gif");
    expect(stillReader(bytes("GIF87a", new Array(10).fill(0)))).toBe("gif");
    expect(stillReader(bytes(PNG_SIG, IHDR, acTL, chunk("IDAT", 4)))).toBe("apng");
    expect(stillReader(webpX(0x02))).toBe("webp_anim");
    expect(stillReader(webpX(0x12))).toBe("webp_anim");
    expect(stillReader(bytes(u32(24), "ftypavif", new Array(12).fill(0)))).toBe("mov");
    expect(stillReader(bytes(u32(24), "ftypheic", new Array(12).fill(0)))).toBe("mov");
  });

  // ffmpeg's APNG reader claims a PNG only when the animation control chunk comes before the
  // picture data; after it, the file is an ordinary PNG to every reader.
  it("reads a PNG whose animation chunk comes after the picture as a still", () => {
    expect(stillReader(bytes(PNG_SIG, IHDR, chunk("IDAT", 4), acTL))).toBe("picture");
  });

  // ffmpeg decides from the first 2048 bytes and stops there (its PNG reader already scored
  // enough), so an animation chunk behind a big colour profile is never seen: a still, to ffmpeg.
  it("reads it as a still when the animation chunk lies past ffmpeg's 2 KB probe", () => {
    const png = bytes(PNG_SIG, IHDR, chunk("iCCP", 3000), acTL, chunk("IDAT", 4));
    expect(stillReader(png)).toBe("picture");
    const near = bytes(PNG_SIG, IHDR, chunk("iCCP", 1000), acTL, chunk("IDAT", 4));
    expect(stillReader(near)).toBe("apng");
  });

  it("reads an animation chunk declaring no frames as a still, as ffmpeg does", () => {
    const acTL0 = chunk("acTL", 8, [...u32(0), ...u32(0)]);
    expect(stillReader(bytes(PNG_SIG, IHDR, acTL0, chunk("IDAT", 4)))).toBe("picture");
  });

  it("reads a PNG cut off before its picture data as a still", () => {
    expect(
      stillReader(
        bytes(PNG_SIG, IHDR, [0, 0, 0x10, 0, ...[..."iCCP"].map((c) => c.charCodeAt(0))]),
      ),
    ).toBe("picture");
  });

  it("says it cannot tell for content it does not know", () => {
    expect(stillReader(bytes("<svg xmlns"))).toBeNull();
    expect(stillReader(new Uint8Array(0))).toBeNull();
    expect(stillReader(bytes("RIFF", le32(4), "WAVE"))).toBeNull();
  });

  it("never throws on any bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (b) => {
        expect(["picture", "gif", "apng", "webp_anim", "mov", null]).toContain(stillReader(b));
        const { plays, frames, width, height } = stillFacts(b);
        for (const v of [plays, frames, width, height])
          expect(v === null || (Number.isInteger(v) && v >= 0)).toBe(true);
      }),
    );
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (tail) => {
        expect(() => stillReader(bytes(PNG_SIG, [...tail]))).not.toThrow();
        expect(() => stillReader(bytes("RIFF", le32(30), "WEBP", [...tail]))).not.toThrow();
        expect(() => stillFacts(bytes(PNG_SIG, IHDR, acTL, [...tail]))).not.toThrow();
        expect(() =>
          stillFacts(bytes("RIFF", le32(30), "WEBP", "VP8X", le32(10), [2], [...tail])),
        ).not.toThrow();
      }),
    );
  });
});

/** RIFF/WEBP: animated VP8X, then `chunks` ([fourcc, payload bytes]) in order. */
const webpAnim = (...chunks: [string, number[]][]) =>
  bytes(
    "RIFF",
    le32(0),
    "WEBP",
    "VP8X",
    le32(10),
    [0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ...chunks.flatMap(([cc, data]): (number[] | string)[] => [
      cc,
      le32(data.length),
      data,
      data.length & 1 ? [0] : [],
    ]),
  );
const ANIM = (loops: number) =>
  ["ANIM", [0, 0, 0, 0, loops & 255, loops >> 8]] as [string, number[]];
const actlOf = (frames: number, plays: number) => chunk("acTL", 8, [...u32(frames), ...u32(plays)]);
/** fcTL for a 200x200 frame at (x, y) with dispose/blend ops (sequence 0, 1/10 s). */
const fctlOf = (w: number, h: number, x: number, y: number, dispose: number, blend: number) =>
  chunk("fcTL", 26, [
    ...u32(0),
    ...u32(w),
    ...u32(h),
    ...u32(x),
    ...u32(y),
    0,
    1,
    0,
    10,
    dispose,
    blend,
  ]);
const playsOf = (head: Uint8Array) => stillFacts(head).plays;

describe("stillFacts: what a still's bytes say about its animation, where ffmpeg reads it", () => {
  it("reads an APNG's frame count, play count and size", () => {
    for (const n of [0, 1, 2, 7, 65536])
      expect(stillFacts(bytes(PNG_SIG, IHDR, actlOf(20, n), chunk("IDAT", 4)))).toEqual({
        known: true,
        plays: n,
        frames: 20,
        width: 200,
        height: 200,
      });
  });

  // apngdec.c decode_fctl_chunk: a whole-canvas first frame is a key frame when it disposes to the
  // background (or to "previous", read as background for the first) or replaces the canvas. Without
  // one, single-threaded -stream_loop STOPS after the first pass (measured on a Pillow file).
  it("reads whether an APNG's first frame is a key frame, as ffmpeg decides it", () => {
    const key = (fctl: number[]) =>
      stillFacts(bytes(PNG_SIG, IHDR, actlOf(3, 0), fctl, chunk("IDAT", 4))).keyFirst;
    expect(key(fctlOf(200, 200, 0, 0, 0, 0))).toBe(true); // replaces the canvas (ffmpeg's encoder)
    expect(key(fctlOf(200, 200, 0, 0, 1, 1))).toBe(true); // disposes to background
    expect(key(fctlOf(200, 200, 0, 0, 2, 1))).toBe(true); // "previous" on the first frame
    expect(key(fctlOf(200, 200, 0, 0, 0, 1))).toBe(false); // blends over, keeps (Pillow, blend=1)
    expect(key(fctlOf(100, 200, 0, 0, 1, 0))).toBe(false); // not the whole canvas
  });

  it("reads an animated WebP's loop count from ANIM, past a colour profile", () => {
    expect(playsOf(webpAnim(ANIM(0), ["ANMF", new Array(16).fill(0)]))).toBe(0);
    expect(playsOf(webpAnim(ANIM(1)))).toBe(1);
    expect(playsOf(webpAnim(ANIM(513)))).toBe(513);
    expect(playsOf(webpAnim(["ICCP", new Array(1001).fill(7)], ANIM(3)))).toBe(3);
  });

  // webp_anim_dec.c: a frame with no ANIM before it sets loop_count = 1.
  it("reads a WebP whose first frame comes before any ANIM as playing once", () => {
    expect(playsOf(webpAnim(["ANMF", new Array(16).fill(0)], ANIM(0)))).toBe(1);
  });

  it("says nothing it does not know: the head stops short, or the file is not animated", () => {
    expect(
      stillFacts(webpAnim(["ICCP", new Array(5000).fill(7)], ANIM(3)).subarray(0, 2048)),
    ).toEqual(NO_FACTS);
    expect(stillFacts(webpAnim(["ANIM", [0, 0, 0, 0, 1]]))).toEqual(NO_FACTS); // not the 6 bytes ffmpeg requires
    expect(stillFacts(bytes("GIF89a", new Array(10).fill(0)))).toEqual(NO_FACTS); // a GIF's count needs ffprobe
    expect(stillFacts(bytes(PNG_SIG, IHDR, chunk("IDAT", 4)))).toEqual(NO_FACTS); // a plain PNG
    expect(stillFacts(webpX(0x10))).toEqual(NO_FACTS); // a still WebP
  });
});

describe("browserPasses: as many passes as Chromium plays (ImageDecoder in the app's WebView)", () => {
  const facts = (plays: number | null) => ({ ...NO_FACTS, known: true, plays });
  // Measured on files written with each count: [reader, count in the file, passes Chromium plays].
  it.each([
    ["gif", null, 1], // no NETSCAPE extension
    ["gif", 0, Infinity],
    ["gif", 1, 2],
    ["gif", 2, 3],
    ["gif", 3, 4],
    ["apng", 0, Infinity],
    ["apng", 1, 1],
    ["apng", 2, 2],
    ["apng", 3, 3],
    ["webp_anim", 0, Infinity],
    ["webp_anim", 1, 1],
    ["webp_anim", 2, 2],
    ["webp_anim", 3, 3],
  ] as const)("%s with count %s plays %s times", (reader, plays, passes) => {
    expect(browserPasses(reader, facts(plays))).toBe(passes);
  });

  it("loops for the clip when the file could not be read, as every still did before", () => {
    for (const r of ["gif", "apng", "webp_anim"] as const)
      expect(browserPasses(r, NO_FACTS)).toBe(Infinity);
  });

  it("treats an absurd count as forever", () => {
    expect(browserPasses("gif", facts(65535))).toBe(Infinity);
    expect(browserPasses("apng", facts(4_000_000_000))).toBe(Infinity);
  });
});

describe("stillLoop: how the export reads and loops each still", () => {
  const apng = (frames: number, plays: number, keyFirst: boolean, w = 200, h = 200) => ({
    known: true,
    plays,
    frames,
    width: w,
    height: h,
    keyFirst,
  });
  const gif = (plays: number | null) => ({ ...NO_FACTS, known: true, plays });

  // -stream_loop HANGS on 2..8-frame APNGs with several decoder threads, and STOPS after a pass when
  // the first frame is not a key frame: an APNG only ever gets it single-threaded, with a key frame.
  it("never gives an APNG -stream_loop unless single-threaded with a key first frame", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 0, max: 5 }),
        fc.boolean(),
        fc.integer({ min: 1, max: 4000 }),
        (frames, plays, keyFirst, drawn) => {
          const { input } = stillLoop("apng", 30, apng(frames, plays, keyFirst), drawn * drawn);
          if (input.includes("-stream_loop")) {
            expect(keyFirst).toBe(true);
            expect(input.slice(0, 2)).toEqual(["-threads", "1"]);
          }
        },
      ),
    );
  });

  it("loops an APNG's decoded pass in the graph, as many times as the file says", () => {
    expect(stillLoop("apng", 30, apng(6, 0, true))).toEqual({
      input: [],
      graph: "loop=loop=-1:size=32767:start=0",
      passes: Infinity,
      hold: false,
    });
    expect(stillLoop("apng", 30, apng(6, 3, false))).toEqual({
      input: [],
      graph: "loop=loop=2:size=32767:start=0",
      passes: 3,
      hold: true,
    });
    expect(stillLoop("apng", 30, apng(6, 1, true))).toEqual({
      input: [],
      graph: null,
      passes: 1,
      hold: true,
    });
    expect(stillLoop("apng", 30, NO_FACTS).graph).toBe("loop=loop=-1:size=32767:start=0");
  });

  // The loop holds one decoded pass at the size it is DRAWN, so memory follows the clip's box.
  it("past the memory budget, loops a key-first APNG by its single-threaded reader instead", () => {
    const big = apng(150, 0, true, 3840, 2160);
    expect(stillLoop("apng", 30, big, 200 * 200).graph).not.toBeNull(); // drawn small: fits
    expect(stillLoop("apng", 30, big, 1920 * 1080)).toEqual({
      input: ["-threads", "1", "-stream_loop", "-1"],
      graph: null,
      passes: Infinity,
      hold: false,
    });
    expect(stillLoop("apng", 30, apng(150, 2, true, 3840, 2160), 1920 * 1080).input).toEqual([
      "-threads",
      "1",
      "-stream_loop",
      "1",
    ]);
    // Not key-first: its reader cannot seek back, so the graph loop stays (correct, and costs memory).
    expect(
      stillLoop("apng", 30, apng(150, 0, false, 3840, 2160), 1920 * 1080).graph,
    ).not.toBeNull();
  });

  // Where the graph loop runs decides what it holds: a sticker drawn full-screen must loop its own
  // small frames (looped after the fit, 300 frames of 64 px held as 1080p are 2.5 GB), and a 4K
  // picture drawn small must loop once fitted. The rule: it holds each frame at the SMALLER size, so
  // a loop within budget at that size is the only kind it ever runs unless it has no other option.
  it("holds an APNG's looped pass at the smaller of its own size and its drawn size", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 3000 }),
        fc.integer({ min: 1, max: 4096 }),
        fc.integer({ min: 1, max: 4096 }),
        fc.integer({ min: 1, max: 8192 }),
        fc.integer({ min: 1, max: 8192 }),
        fc.boolean(),
        (frames, w, h, dw, dh, keyFirst) => {
          const loop = stillLoop("apng", 30, apng(frames, 0, keyFirst, w, h), dw * dh);
          if (loop.graph === null) return;
          const held = loop.graphAfterFit ? dw * dh : w * h;
          expect(held).toBe(Math.min(dw * dh, w * h));
          if (keyFirst) expect(frames * held).toBeLessThanOrEqual(APNG_LOOP_PIXELS);
        },
      ),
    );
    expect(
      stillLoop("apng", 30, apng(300, 0, false, 64, 64), 1920 * 1080).graphAfterFit,
    ).toBeUndefined();
    expect(stillLoop("apng", 30, apng(30, 0, false, 3840, 2160), 640 * 360).graphAfterFit).toBe(
      true,
    );
  });

  it("gives a GIF its own count the way a browser plays it", () => {
    expect(stillLoop("gif", 30, gif(null))).toEqual({
      input: [],
      graph: null,
      passes: 1,
      hold: true,
    });
    expect(stillLoop("gif", 30, gif(0))).toEqual({
      input: ["-stream_loop", "-1"],
      graph: null,
      passes: Infinity,
      hold: false,
    });
    expect(stillLoop("gif", 30, gif(2))).toEqual({
      input: ["-stream_loop", "2"],
      graph: null,
      passes: 3,
      hold: true,
    });
    expect(stillLoop("gif", 30)).toEqual({
      input: ["-stream_loop", "-1"],
      graph: null,
      passes: Infinity,
      hold: false,
    });
  });

  it("plays what the export plays for every other reader", () => {
    expect(stillLoop("webp_anim", 30, { ...NO_FACTS, known: true, plays: 0 })).toEqual({
      input: ["-ignore_loop", "0"],
      graph: null,
      passes: Infinity,
      hold: false,
    });
    expect(stillLoop("webp_anim", 30, { ...NO_FACTS, known: true, plays: 2 })).toEqual({
      input: ["-ignore_loop", "0"],
      graph: null,
      passes: 2,
      hold: true,
    });
    expect(stillLoop("webp_anim", 30).hold).toBe(true); // its reader reads a count we could not: hold in case
    expect(stillLoop("picture", 25)).toEqual({
      input: ["-loop", "1", "-framerate", "25"],
      graph: null,
      passes: Infinity,
      hold: false,
    });
    expect(stillLoop("mov", 30).input).toEqual(["-stream_loop", "-1"]);
  });
});

describe("webpChunk: one step of walking a WebP's chunks to its loop count", () => {
  const head = (cc: string, size: number) => bytes(cc, le32(size));
  it("steps over a chunk, padded to even, and reads ANIM's count", () => {
    expect(webpChunk(head("ICCP", 70001), 30)).toEqual({ next: 30 + 8 + 70002 });
    expect(webpChunk(head("EXIF", 10), 100)).toEqual({ next: 118 });
    expect(webpChunk(head("ANIM", 6), 70040, new Uint8Array([0, 0, 0, 0, 3, 0]))).toEqual({
      plays: 3,
    });
    expect(webpChunk(head("ANMF", 400), 64)).toEqual({ plays: 1 });
    expect(webpChunk(head("ANIM", 7), 64, new Uint8Array(6))).toBeNull();
    expect(webpChunk(new Uint8Array(3), 64)).toBeNull();
  });
});
