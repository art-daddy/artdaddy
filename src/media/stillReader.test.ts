import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { exportPasses, stillLoopArgs, stillPlays, stillReader } from "./stillReader";

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
        const plays = stillPlays(b);
        expect(plays === null || (Number.isInteger(plays) && plays >= 0)).toBe(true);
      }),
    );
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (tail) => {
        expect(() => stillReader(bytes(PNG_SIG, [...tail]))).not.toThrow();
        expect(() => stillReader(bytes("RIFF", le32(30), "WEBP", [...tail]))).not.toThrow();
        expect(() => stillPlays(bytes(PNG_SIG, IHDR, acTL, [...tail]))).not.toThrow();
        expect(() => stillPlays(bytes("RIFF", le32(30), "WEBP", "VP8X", le32(10), [2], [...tail]))).not.toThrow();
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
const actlPlays = (n: number) => chunk("acTL", 8, [...u32(20), ...u32(n)]);

describe("stillPlays: the file's own play count, where ffmpeg reads it", () => {
  it("reads an APNG's num_plays from acTL", () => {
    for (const n of [0, 1, 2, 7, 65536])
      expect(stillPlays(bytes(PNG_SIG, IHDR, actlPlays(n), chunk("IDAT", 4)))).toBe(n);
  });

  it("reads an animated WebP's loop count from ANIM, past a colour profile", () => {
    expect(stillPlays(webpAnim(ANIM(0), ["ANMF", new Array(16).fill(0)]))).toBe(0);
    expect(stillPlays(webpAnim(ANIM(1)))).toBe(1);
    expect(stillPlays(webpAnim(ANIM(513)))).toBe(513);
    expect(stillPlays(webpAnim(["ICCP", new Array(3001).fill(7)], ANIM(3)))).toBe(3);
  });

  // webp_anim_dec.c: a frame with no ANIM before it sets loop_count = 1.
  it("reads a WebP whose first frame comes before any ANIM as playing once", () => {
    expect(stillPlays(webpAnim(["ANMF", new Array(16).fill(0)], ANIM(0)))).toBe(1);
  });

  it("says it does not know when the count is not in the bytes, or the file has none", () => {
    expect(stillPlays(webpAnim(["ICCP", new Array(5000).fill(7)], ANIM(3)).subarray(0, 4096))).toBeNull();
    expect(stillPlays(webpAnim(["ANIM", [0, 0, 0, 0, 1]]))).toBeNull(); // not the 6 bytes ffmpeg requires
    expect(stillPlays(bytes("GIF89a", new Array(10).fill(0)))).toBeNull();
    expect(stillPlays(bytes(PNG_SIG, IHDR, chunk("IDAT", 4)))).toBeNull(); // a plain PNG
    expect(stillPlays(webpX(0x10))).toBeNull(); // a still WebP
  });
});

describe("how the export loops each still, and how many passes it plays", () => {
  // `-stream_loop -1` HANGS on every APNG of 1 to 8 frames (measured; stillReader.smoke.e2e.ts and
  // animatedStills.smoke.e2e.ts hold it to the shipped ffmpeg), so no APNG is ever given it.
  it("never gives an APNG -stream_loop", () => {
    for (const plays of [null, 0, 1, 2, 9])
      expect(stillLoopArgs("apng", 30, plays)).not.toContain("-stream_loop");
  });

  it("loops a loop-forever APNG with its own reader, and reads a play-N one once", () => {
    expect(stillLoopArgs("apng", 30, 0)).toEqual(["-ignore_loop", "0"]);
    expect(stillLoopArgs("apng", 30, null)).toEqual(["-ignore_loop", "0"]);
    expect(stillLoopArgs("apng", 30, 1)).toEqual([]);
    expect(stillLoopArgs("apng", 30, 3)).toEqual([]);
  });

  it("plays what the export plays: forever, or a set number of passes and then holds", () => {
    expect(exportPasses("gif", 1)).toBe(Infinity); // -stream_loop ignores a GIF's own count
    expect(exportPasses("apng", 0)).toBe(Infinity);
    expect(exportPasses("apng", 3)).toBe(1); // read once, plainly
    expect(exportPasses("webp_anim", 0)).toBe(Infinity);
    expect(exportPasses("webp_anim", 2)).toBe(2); // its reader honours the count exactly
    expect(exportPasses("webp_anim", null)).toBeNull();
    expect(exportPasses("picture", null)).toBe(Infinity);
  });
});
