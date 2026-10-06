import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { stillReader } from "./stillReader";

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
      }),
    );
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (tail) => {
        expect(() => stillReader(bytes(PNG_SIG, [...tail]))).not.toThrow();
        expect(() => stillReader(bytes("RIFF", le32(30), "WEBP", [...tail]))).not.toThrow();
      }),
    );
  });
});
