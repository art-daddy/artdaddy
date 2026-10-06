import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { missingIndexReason } from "./mp4Index";

/** A top-level box: 32-bit size (0 = "to the end of the file"), type, payload. */
function box(type: string, payload = 0, sizeField?: number): Uint8Array {
  const size = sizeField ?? 8 + payload;
  const b = new Uint8Array(8 + payload);
  new DataView(b.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
  return b;
}
/** A box with a 64-bit size (the size field is 1 and the real size follows the type). */
function bigBox(type: string, size: number): Uint8Array {
  const b = new Uint8Array(16);
  const v = new DataView(b.buffer);
  v.setUint32(0, 1);
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
  v.setUint32(8, Math.floor(size / 2 ** 32));
  v.setUint32(12, size % 2 ** 32);
  return b;
}
const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};

describe("missingIndexReason", () => {
  // Measured: ffmpeg killed 4 s into a recording leaves exactly this, 786,480 bytes long, and
  // ffprobe answers "moov atom not found".
  it("refuses the file a recorder leaves when it is killed mid-write", () => {
    const head = cat(box("ftyp", 24), box("free"), box("mdat", 100, 0));
    expect(missingIndexReason(head, 786_480)).toMatch(/no index/i);
  });

  it("refuses a copy cut off inside its media, before the index at the end", () => {
    const head = cat(box("ftyp", 24), box("mdat", 100, 10_000_000));
    expect(missingIndexReason(head, 5_000_000)).toMatch(/no index/i);
  });

  it("refuses media that runs exactly to the end, leaving no room for an index", () => {
    const head = cat(box("ftyp", 24), box("mdat", 100, 4_000));
    expect(missingIndexReason(head, 32 + 4_000)).toMatch(/no index/i);
  });

  it("refuses a 64-bit media box that overruns the file", () => {
    const head = cat(box("ftyp", 24), bigBox("mdat", 6 * 2 ** 32));
    expect(missingIndexReason(head, 5 * 2 ** 32)).toMatch(/no index/i);
  });

  it("refuses an old QuickTime movie with no ftyp and no index", () => {
    const head = cat(box("wide"), box("mdat", 100, 0));
    expect(missingIndexReason(head, 1_000_000)).toMatch(/no index/i);
  });

  it("accepts a file whose index comes first", () => {
    const head = cat(box("ftyp", 24), box("moov", 500), box("mdat", 100, 0));
    expect(missingIndexReason(head, 900_000)).toBeNull();
  });

  // The usual camera/phone layout: the index is written last, far past the head. That is not
  // evidence of anything missing, so it must pass.
  it("accepts a file whose index lies past the bytes it can see", () => {
    const head = cat(box("ftyp", 24), box("free"), box("mdat", 100, 50_000_000));
    expect(missingIndexReason(head, 50_000_000 + 40 + 2_000_000)).toBeNull();
    const big = cat(box("ftyp", 24), bigBox("mdat", 5 * 2 ** 32));
    expect(missingIndexReason(big, 5 * 2 ** 32 + 32 + 1_000_000)).toBeNull();
  });

  it("accepts a fragmented recording: its index is at the start", () => {
    const head = cat(box("ftyp", 24), box("moov", 300), box("moof", 50), box("mdat", 100, 0));
    expect(missingIndexReason(head, 2_000_000)).toBeNull();
  });

  // ffmpeg reads the content, not the name: a file that is not an MP4 inside plays as what it
  // is, so it is never this check's to refuse, whatever it is called.
  it("leaves alone a file that is not an MP4 inside", () => {
    const ts = new Uint8Array(188 * 4).fill(0xff);
    for (let i = 0; i < 4; i++) ts[i * 188] = 0x47;
    expect(missingIndexReason(ts, ts.length)).toBeNull();
    const webm = cat(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), new Uint8Array(60));
    expect(missingIndexReason(webm, 10_000_000)).toBeNull();
  });

  // An iPhone photo is ISO-BMFF too, with its picture described by a top-level `meta` and no
  // `moov` at all: a still whatever it is named, never a movie missing its index.
  it("leaves alone a HEIF or AVIF still", () => {
    const heic = cat(box("ftyp", 24), box("meta", 200), box("mdat", 100, 0));
    expect(missingIndexReason(heic, 3_000_000)).toBeNull();
  });

  it("never throws, and never refuses a file whose index appears before the end", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), fc.nat(), (bytes, size) => {
        const withIndex = cat(box("ftyp", 24), box("moov", 16), bytes);
        expect(missingIndexReason(withIndex, Math.max(size, withIndex.length))).toBeNull();
        expect(() => missingIndexReason(bytes, size)).not.toThrow();
      }),
    );
  });
});
