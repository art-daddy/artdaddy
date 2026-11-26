// The parity references are PNG files this codec writes and both lanes read back: a codec that
// lost or moved pixels would make every whole-frame comparison wrong in the same way on both sides.
//
// __fixtures__/png holds one picture of noise (noise.rgb, 24x16) written by the shipped ffmpeg with
// each of PNG's row filters (`-pred none|sub|up|avg|paeth|mixed`), so the reader is checked against
// an encoder that is not this one:
//   ffmpeg -f lavfi -i "testsrc2=s=24x16:r=1,noise=alls=90:allf=u,format=rgb24" -frames:v 1
//          -f rawvideo -pix_fmt rgb24 noise.rgb
//   ffmpeg -f rawvideo -pix_fmt rgb24 -s 24x16 -i noise.rgb -pred <filter> noise-<filter>.png
import { readFileSync } from "node:fs";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { Picture } from "./frameParity";
import { decodePng, encodePng } from "./png";

const picture = fc
  .record({ w: fc.integer({ min: 1, max: 24 }), h: fc.integer({ min: 1, max: 12 }) })
  .chain(({ w, h }) =>
    fc
      .uint8Array({ minLength: w * h * 3, maxLength: w * h * 3 })
      .map((rgb): Picture => ({ w, h, rgb })),
  );

const NOISE = path.resolve(process.cwd(), "src/test/__fixtures__/png");
const PARITY = path.resolve(process.cwd(), "e2e/ui/fixtures/parity");
const at = (p: Picture, x: number, y: number) =>
  Array.from(p.rgb.subarray((y * p.w + x) * 3, (y * p.w + x) * 3 + 3));

/** The filter byte of every row of a (non-interlaced, 8-bit RGB) PNG, read off its image data. */
function rowFilters(file: Uint8Array, w: number, h: number): number[] {
  const bytes = Buffer.from(file);
  const data: Buffer[] = [];
  for (let i = 8; i < bytes.length;) {
    const length = bytes.readUInt32BE(i);
    if (bytes.toString("ascii", i + 4, i + 8) === "IDAT")
      data.push(bytes.subarray(i + 8, i + 8 + length));
    i += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  return Array.from({ length: h }, (_, y) => raw[y * (w * 3 + 1)]);
}

/** The CRC-32 every PNG chunk carries (ISO 3309), written out here so the test owes nothing to png.ts. */
function crc(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** An 8-bit RGB PNG made from raw scanlines (each its filter byte, then its bytes), by hand. */
function handMade(w: number, h: number, rows: number[][]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from(rows.flat()))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("png", () => {
  it("reads back exactly the picture it wrote", () => {
    fc.assert(
      fc.property(picture, (p) => {
        const back = decodePng(encodePng(p));
        expect([back.w, back.h]).toEqual([p.w, p.h]);
        expect(Array.from(back.rgb)).toEqual(Array.from(p.rgb));
      }),
      { numRuns: 300 },
    );
  });

  it("reads every row filter another encoder writes, pixel for pixel", () => {
    const truth = Array.from(readFileSync(path.join(NOISE, "noise.rgb")));
    const seen = new Set<number>();
    for (const [name, filter] of [
      ["none", 0],
      ["sub", 1],
      ["up", 2],
      ["avg", 3],
      ["paeth", 4],
      ["mixed", -1],
    ] as const) {
      const file = readFileSync(path.join(NOISE, `noise-${name}.png`));
      const filters = rowFilters(file, 24, 16);
      if (filter >= 0)
        expect(filters.slice(1), `${name}: rows after the first`).toEqual(Array(15).fill(filter));
      filters.forEach((f) => seen.add(f));
      const p = decodePng(file);
      expect([p.w, p.h]).toEqual([24, 16]);
      expect(Array.from(p.rgb), name).toEqual(truth);
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it("reads ffmpeg's PNGs, RGB and RGBA alike, as the picture ffmpeg wrote", () => {
    // still.png: 400x300 RGB, a light border, a teal/purple split and an orange disc.
    const still = decodePng(readFileSync(path.join(PARITY, "still.png")));
    expect([still.w, still.h]).toEqual([400, 300]);
    expect(at(still, 2, 2)).toEqual([235, 235, 235]);
    expect(at(still, 200, 150)).toEqual([240, 150, 40]);
    expect(at(still, 30, 280)).toEqual([40, 150, 160]);
    expect(at(still, 370, 20)).toEqual([90, 40, 120]);
    // logo.png: 160x160 RGBA; alpha is dropped and the colour kept.
    const logo = decodePng(readFileSync(path.join(PARITY, "logo.png")));
    expect([logo.w, logo.h]).toEqual([160, 160]);
    expect(at(logo, 80, 80)).toEqual([250, 220, 40]);
    expect(at(logo, 80, 20)).toEqual([250, 250, 250]);
  });

  it("writes a file other readers take: an RGB PNG with its chunks named and checked", () => {
    const file = encodePng({ w: 3, h: 2, rgb: Uint8Array.from({ length: 18 }, (_, i) => i * 14) });
    expect(file.toString("ascii", 12, 16)).toBe("IHDR");
    expect([file.readUInt32BE(16), file.readUInt32BE(20), file[24], file[25]]).toEqual([
      3, 2, 8, 2,
    ]);
    expect(file.toString("ascii", file.length - 8, file.length - 4)).toBe("IEND");
  });

  it("predicts a Paeth row by the specification's order, the first row included", () => {
    // Two RGB pixels a row, each row stored with the Paeth filter (PNG spec 9.4: p = a + b - c, the
    // nearest of a, b, c, ties going to a, then b). The first row has nothing above it (b = c = 0).
    // Row 1, pixel 1 holds a tie in red (pb = pc: b wins over c) and in blue (pa = pc: a wins).
    const file = handMade(2, 2, [
      [4, 20, 20, 20, 20, 22, 10], // decodes to (20,20,20) (40,42,30)
      [4, 246, 20, 236, 5, 2, 3], // decodes to (10,40,0) then red 5+40, green 2+42, blue 3+0
    ]);
    expect(Array.from(decodePng(file).rgb)).toEqual([20, 20, 20, 40, 42, 30, 10, 40, 0, 45, 44, 3]);
  });

  it("refuses what it cannot read rather than misreading it", () => {
    const ok = encodePng({ w: 2, h: 2, rgb: new Uint8Array(12).fill(7) });
    const withHeader = (patch: (header: Buffer) => void) => {
      const file = Buffer.from(ok);
      patch(file.subarray(16, 29));
      file.writeUInt32BE(crc(file.subarray(12, 29)), 29);
      return file;
    };
    expect(() => decodePng(withHeader((h) => (h[8] = 16)))).toThrow(/only 8-bit/); // 16-bit
    expect(() => decodePng(withHeader((h) => (h[9] = 3)))).toThrow(/only 8-bit/); // palette
    expect(() => decodePng(withHeader((h) => (h[12] = 1)))).toThrow(/only 8-bit/); // interlaced
    expect(() => decodePng(withHeader((h) => h.writeUInt32BE(3, 4)))).toThrow(/wrong length/);
    expect(() => decodePng(handMade(1, 1, [[5, 1, 2, 3]]))).toThrow(/unknown filter 5/);
    expect(() =>
      decodePng(Buffer.concat([ok.subarray(0, 8), ok.subarray(ok.length - 12)])),
    ).toThrow(/no IHDR/);
  });

  it("drops alpha from an RGBA file: three bytes a pixel", () => {
    const logo = decodePng(readFileSync(path.join(PARITY, "logo.png")));
    expect(logo.rgb.length).toBe(160 * 160 * 3);
  });

  it("refuses bytes that do not make the picture it is told, and a damaged file", () => {
    expect(() => encodePng({ w: 3, h: 2, rgb: new Uint8Array(17) })).toThrow(/17 bytes for 3x2/);
    const file = encodePng({ w: 2, h: 2, rgb: new Uint8Array(12).fill(7) });
    const damaged = Buffer.from(file);
    damaged[damaged.length - 20] ^= 0xff;
    expect(() => decodePng(damaged)).toThrow(/CRC/);
    expect(() => decodePng(Buffer.from("not a png"))).toThrow(/not a PNG/);
  });
});
