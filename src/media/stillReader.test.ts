import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { NO_FACTS, stillFacts, stillLoop, stillReader } from "./stillReader";

const bytes = (...parts: (number[] | string)[]): Uint8Array =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
/** A PNG chunk with a zero CRC (the classifier reads structure, not checksums). */
const chunk = (type: string, len = 0, data: number[] = []) => [...u32(len), ...[...type].map((c) => c.charCodeAt(0)), ...data, ...new Array(len - data.length).fill(0), 0, 0, 0, 0];
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** IHDR for a 200x200 picture, and an acTL declaring 20 frames: what a real APNG carries. */
const IHDR = chunk("IHDR", 13, [...u32(200), ...u32(200), 8, 6, 0, 0, 0]);
const acTL = chunk("acTL", 8, [...u32(20), ...u32(0)]);
/** RIFF/WEBP with one VP8X chunk carrying `flags`. */
const webpX = (flags: number) => bytes("RIFF", le32(30), "WEBP", "VP8X", le32(10), [flags, 0, 0, 0], [0, 0, 0, 0, 0, 0]);

describe("stillReader: which of ffmpeg's readers opens a still", () => {
  it("names the single-picture reader for JPEG, PNG, static WebP, BMP and TIFF", () => {
    expect(stillReader(bytes([0xff, 0xd8, 0xff, 0xe0], new Array(20).fill(0)))).toBe("picture");
    expect(stillReader(bytes(PNG_SIG, IHDR, chunk("IDAT", 4)))).toBe("picture");
    expect(stillReader(bytes("RIFF", le32(30), "WEBP", "VP8 ", new Array(20).fill(0)))).toBe("picture");
    expect(stillReader(bytes("RIFF", le32(30), "WEBP", "VP8L", new Array(20).fill(0)))).toBe("picture");
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
    expect(stillReader(bytes(PNG_SIG, IHDR, [0, 0, 0x10, 0, ...[..."iCCP"].map((c) => c.charCodeAt(0))]))).toBe("picture");
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
        for (const v of Object.values(stillFacts(b))) expect(v === null || (Number.isInteger(v) && v >= 0)).toBe(true);
      }),
    );
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (tail) => {
        expect(() => stillReader(bytes(PNG_SIG, [...tail]))).not.toThrow();
        expect(() => stillReader(bytes("RIFF", le32(30), "WEBP", [...tail]))).not.toThrow();
        expect(() => stillFacts(bytes(PNG_SIG, IHDR, acTL, [...tail]))).not.toThrow();
        expect(() => stillFacts(bytes("RIFF", le32(30), "WEBP", "VP8X", le32(10), [2], [...tail]))).not.toThrow();
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
    ...chunks.flatMap(([cc, data]): (number[] | string)[] => [cc, le32(data.length), data, data.length & 1 ? [0] : []]),
  );
const ANIM = (loops: number) => ["ANIM", [0, 0, 0, 0, loops & 255, loops >> 8]] as [string, number[]];
const actlOf = (frames: number, plays: number) => chunk("acTL", 8, [...u32(frames), ...u32(plays)]);
const playsOf = (head: Uint8Array) => stillFacts(head).plays;

describe("stillFacts: what a still's bytes say about its animation, where ffmpeg reads it", () => {
  it("reads an APNG's frame count, play count and size", () => {
    for (const n of [0, 1, 2, 7, 65536])
      expect(stillFacts(bytes(PNG_SIG, IHDR, actlOf(20, n), chunk("IDAT", 4)))).toEqual({
        plays: n,
        frames: 20,
        width: 200,
        height: 200,
      });
  });

  it("reads an animated WebP's loop count from ANIM, past a colour profile", () => {
    expect(playsOf(webpAnim(ANIM(0), ["ANMF", new Array(16).fill(0)]))).toBe(0);
    expect(playsOf(webpAnim(ANIM(1)))).toBe(1);
    expect(playsOf(webpAnim(ANIM(513)))).toBe(513);
    expect(playsOf(webpAnim(["ICCP", new Array(3001).fill(7)], ANIM(3)))).toBe(3);
  });

  // webp_anim_dec.c: a frame with no ANIM before it sets loop_count = 1.
  it("reads a WebP whose first frame comes before any ANIM as playing once", () => {
    expect(playsOf(webpAnim(["ANMF", new Array(16).fill(0)], ANIM(0)))).toBe(1);
  });

  it("says nothing when the bytes do not say, or the file is not animated", () => {
    expect(stillFacts(webpAnim(["ICCP", new Array(5000).fill(7)], ANIM(3)).subarray(0, 4096))).toEqual(NO_FACTS);
    expect(stillFacts(webpAnim(["ANIM", [0, 0, 0, 0, 1]]))).toEqual(NO_FACTS); // not the 6 bytes ffmpeg requires
    expect(stillFacts(bytes("GIF89a", new Array(10).fill(0)))).toEqual(NO_FACTS);
    expect(stillFacts(bytes(PNG_SIG, IHDR, chunk("IDAT", 4)))).toEqual(NO_FACTS); // a plain PNG
    expect(stillFacts(webpX(0x10))).toEqual(NO_FACTS); // a still WebP
  });
});

describe("stillLoop: how the export reads and loops each still", () => {
  const apng = (frames: number, plays: number, w = 200, h = 200) => ({ plays, frames, width: w, height: h });

  // `-stream_loop -1` HANGS on every APNG of 1 to 8 frames (measured; stillReader.smoke.e2e.ts and
  // animatedStills.smoke.e2e.ts hold it to the shipped ffmpeg), so no APNG is ever given it.
  it("never gives an APNG -stream_loop", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 1, max: 4000 }),
        fc.integer({ min: 1, max: 4000 }),
        (frames, plays, w, h) => {
          expect(stillLoop("apng", 30, apng(frames, plays, w, h)).input).not.toContain("-stream_loop");
        },
      ),
    );
    expect(stillLoop("apng", 30).input).not.toContain("-stream_loop");
  });

  // Its reader's own loop loses the file's timing after ~5 s, so an APNG that fits is looped in the
  // graph from one decoded pass, its count honoured (a browser plays a play-twice file twice).
  it("loops an APNG that fits from one decoded pass, as many times as the file says", () => {
    expect(stillLoop("apng", 30, apng(6, 0))).toEqual({ input: [], graph: "loop=loop=-1:size=6:start=0", passes: Infinity });
    expect(stillLoop("apng", 30, apng(6, 1))).toEqual({ input: [], graph: null, passes: 1 });
    expect(stillLoop("apng", 30, apng(6, 3))).toEqual({ input: [], graph: "loop=loop=2:size=6:start=0", passes: 3 });
  });

  // Every decoded frame is held in memory to loop it (528 MB for 60 frames of 1080p, measured).
  it("falls back past the memory budget: its reader's loop, or one pass held", () => {
    expect(stillLoop("apng", 30, apng(60, 0, 1920, 1080))).toEqual({ input: ["-ignore_loop", "0"], graph: null, passes: Infinity });
    expect(stillLoop("apng", 30, apng(60, 2, 1920, 1080))).toEqual({ input: [], graph: null, passes: 1 });
    expect(stillLoop("apng", 30, apng(30, 0, 1920, 1080)).graph).not.toBeNull(); // 62 M pixels: fits
    expect(stillLoop("apng", 30, NO_FACTS)).toEqual({ input: ["-ignore_loop", "0"], graph: null, passes: Infinity });
  });

  it("plays what the export plays for every other reader", () => {
    expect(stillLoop("gif", 30, { ...NO_FACTS, plays: 1 })).toEqual({ input: ["-stream_loop", "-1"], graph: null, passes: Infinity });
    expect(stillLoop("webp_anim", 30, { ...NO_FACTS, plays: 0 }).passes).toBe(Infinity);
    expect(stillLoop("webp_anim", 30, { ...NO_FACTS, plays: 2 })).toEqual({ input: ["-ignore_loop", "0"], graph: null, passes: 2 });
    expect(stillLoop("webp_anim", 30).passes).toBeNull();
    expect(stillLoop("picture", 25)).toEqual({ input: ["-loop", "1", "-framerate", "25"], graph: null, passes: Infinity });
    expect(stillLoop("mov", 30).input).toEqual(["-stream_loop", "-1"]);
  });
});
