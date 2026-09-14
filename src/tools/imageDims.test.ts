// The rule under test: an image ffmpeg cannot decode must be RECOGNISED as such from its
// header alone. Both enforcement points (library import, render pre-flight) are inert if
// this module reports "unknown" for a real file, so the tests assert dimensions parsed back
// from headers built here — not that the parser was called.
//
// The witness: a full-page screenshot at 6864x41754. ffprobe on that exact file exits 0 and
// reports width=0 height=0, and ffmpeg logs "Picture size 6864x41754 is invalid" — pinned
// below so a change to the limit has to face the real observation.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ffmpegCanDecodeSize, readImageSize, undecodableImageReason } from "./imageDims";

const bytes = (...v: number[]): Uint8Array => new Uint8Array(v);
const chars = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const be32 = (n: number): number[] => [
  (n >>> 24) & 255,
  (n >>> 16) & 255,
  (n >>> 8) & 255,
  n & 255,
];
const le32 = (n: number): number[] => [
  n & 255,
  (n >>> 8) & 255,
  (n >>> 16) & 255,
  (n >>> 24) & 255,
];
const le24 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const le16 = (n: number): number[] => [n & 255, (n >>> 8) & 255];

function png(w: number, h: number): Uint8Array {
  return bytes(
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be32(13),
    ...chars("IHDR"),
    ...be32(w),
    ...be32(h),
  );
}
/** SOI, an APP0 segment the walker must SKIP over, then SOF0 carrying the size. */
function jpeg(w: number, h: number): Uint8Array {
  return bytes(
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    ...chars("JFIF"),
    0,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (h >> 8) & 255,
    h & 255,
    (w >> 8) & 255,
    w & 255,
    3,
    1,
    0x11,
    0,
    2,
    0x11,
    0,
    3,
    0x11,
    0,
  );
}
function gif(w: number, h: number): Uint8Array {
  return bytes(...chars("GIF89a"), ...le16(w), ...le16(h), 0, 0, 0);
}
function bmp(w: number, h: number): Uint8Array {
  return bytes(
    ...chars("BM"),
    ...le32(0),
    ...le32(0),
    ...le32(54),
    ...le32(40),
    ...le32(w),
    ...le32(h),
  );
}
function webpX(w: number, h: number): Uint8Array {
  return bytes(
    ...chars("RIFF"),
    ...le32(0),
    ...chars("WEBP"),
    ...chars("VP8X"),
    ...le32(10),
    0x10,
    0,
    0,
    0,
    ...le24(w - 1),
    ...le24(h - 1),
  );
}
function webpL(w: number, h: number): Uint8Array {
  return bytes(
    ...chars("RIFF"),
    ...le32(0),
    ...chars("WEBP"),
    ...chars("VP8L"),
    ...le32(10),
    0x2f,
    ...le32((w - 1) | ((h - 1) << 14)),
  );
}
function webpLossy(w: number, h: number): Uint8Array {
  return bytes(
    ...chars("RIFF"),
    ...le32(0),
    ...chars("WEBP"),
    ...chars("VP8 "),
    ...le32(10),
    0,
    0,
    0,
    0x9d,
    0x01,
    0x2a,
    ...le16(w),
    ...le16(h),
  );
}

describe("readImageSize — dimensions come back out of a real header", () => {
  it.each([
    ["png", png, 6864, 41754],
    ["jpeg", jpeg, 4000, 3000],
    ["gif", gif, 640, 480],
    ["bmp", bmp, 1920, 1080],
    ["webp/VP8X", webpX, 12000, 30000],
    ["webp/VP8L", webpL, 800, 600],
    ["webp/lossy", webpLossy, 1280, 720],
  ])("%s", (_name, make, w, h) => {
    expect(readImageSize(make(w, h))).toEqual({ width: w, height: h });
  });

  it("reads a BMP stored bottom-up (negative height) as its absolute size", () => {
    expect(readImageSize(bmp(1920, -1080))).toEqual({ width: 1920, height: 1080 });
  });

  it("reports UNKNOWN (null) rather than a guess for formats it does not parse", () => {
    // avif/tiff/svg are accepted by the importer but not parsed here: null must NOT be read
    // as a pass by callers, and must never be a fabricated size.
    expect(readImageSize(bytes(...chars("II"), 42, 0, 8, 0, 0, 0))).toBeNull(); // tiff
    expect(readImageSize(bytes(...chars('<svg width="9">')))).toBeNull();
    expect(readImageSize(new Uint8Array(0))).toBeNull();
    expect(readImageSize(png(6864, 41754).slice(0, 18))).toBeNull(); // truncated header
  });

  it("reports a stated ZERO instead of hiding it — that is what ffprobe saw on the real file", () => {
    // ffprobe on the 6864x41754 screenshot exits 0 and prints width=0 height=0. A header that
    // states 0 is a definite "no frames", not an unknown, so it must reach the decode check.
    expect(readImageSize(png(0, 0))).toEqual({ width: 0, height: 0 });
    expect(undecodableImageReason(png(0, 1080))).not.toBeNull();
  });

  it("needs the real signature, not just a plausible layout", () => {
    // Every parser keys off its magic bytes; without that check any buffer of the right shape
    // would be read as an image and could be rejected on garbage dimensions.
    const notPng = png(9, 9);
    notPng[1] = 0x00; // "IHDR" still sits at offset 12
    expect(readImageSize(notPng)).toBeNull();
    const notWebp = webpX(9, 9);
    notWebp[9] = 0x00; // breaks "WEBP"
    expect(readImageSize(notWebp)).toBeNull();
    const notGif = gif(9, 9);
    notGif[3] = 0x00; // breaks "GIF8"
    expect(readImageSize(notGif)).toBeNull();
    const notBmp = bmp(9, 9);
    notBmp[0] = 0x00;
    expect(readImageSize(notBmp)).toBeNull();
  });

  it("rejects a webp whose codec chunk is corrupt rather than reading noise as a size", () => {
    const lossy = webpLossy(1280, 720);
    lossy[23] = 0x00; // sync code
    expect(readImageSize(lossy)).toBeNull();
    const lossless = webpL(800, 600);
    lossless[20] = 0x00; // VP8L signature byte
    expect(readImageSize(lossless)).toBeNull();
    const unknownChunk = webpX(9, 9);
    unknownChunk.set(chars("ANIM"), 12);
    expect(readImageSize(unknownChunk)).toBeNull();
  });

  it("parses each format at its MINIMUM length and gives up one byte short", () => {
    // The length guards are the difference between a size and an out-of-bounds read.
    const minimums: [Uint8Array, number][] = [
      [png(9, 9), 24],
      [gif(9, 9), 10],
      [bmp(9, 9), 26],
      [webpX(9, 9), 30],
      [webpL(9, 9), 25],
      [webpLossy(9, 9), 30],
    ];
    for (const [b, min] of minimums) {
      expect(readImageSize(b.slice(0, min))).toEqual({ width: 9, height: 9 });
      expect(readImageSize(b.slice(0, min - 1))).toBeNull();
    }
  });

  it("walks JPEG segments: skips a huffman table, gives up at the scan", () => {
    // 0xC4 sits inside the SOF marker range but is a TABLE — reading it as a frame header
    // would report the table's bytes as the image size.
    const dht = [0xff, 0xc4, 0x00, 0x06, 1, 2, 3, 4];
    const sof = [
      0xff, 0xc0, 0x00, 0x11, 0x08, 2, 0x58, 4, 0xb0, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0,
    ];
    expect(readImageSize(bytes(0xff, 0xd8, ...dht, ...sof))).toEqual({ width: 1200, height: 600 });
    expect(readImageSize(bytes(0xff, 0xd8, 0xff, 0xda, 0x00, 0x04, 0, 0))).toBeNull(); // scan, no frame
    expect(readImageSize(bytes(0xff, 0xd8, 0x11, 0x22, 0x33, 0x44))).toBeNull(); // desynced
  });

  it("reads every JPEG frame type a camera or browser actually emits", () => {
    // SOF2 is progressive JPEG — extremely common, and a marker-range slip would silently
    // stop reading those. SOF8/SOF12 are tables that must be skipped like SOF4.
    const frame = (marker: number) => [
      0xff,
      marker,
      0x00,
      0x11,
      0x08,
      2,
      0x58,
      4,
      0xb0,
      3,
      1,
      0x11,
      0,
      2,
      0x11,
      0,
      3,
      0x11,
      0,
    ];
    for (const m of [0xc0, 0xc1, 0xc2, 0xc3, 0xcf])
      expect(readImageSize(bytes(0xff, 0xd8, ...frame(m)))).toEqual({ width: 1200, height: 600 });
    for (const table of [0xc4, 0xc8, 0xcc])
      expect(
        readImageSize(bytes(0xff, 0xd8, 0xff, table, 0x00, 0x04, 1, 2, ...frame(0xc0))),
      ).toEqual({ width: 1200, height: 600 });
    // 0xff fill bytes before a marker are legal padding, and RST/TEM markers carry no length.
    expect(readImageSize(bytes(0xff, 0xd8, 0xff, 0xff, 0xff, ...frame(0xc0).slice(1)))).toEqual({
      width: 1200,
      height: 600,
    });
    expect(readImageSize(bytes(0xff, 0xd8, 0xff, 0x01, ...frame(0xc0)))).toEqual({
      width: 1200,
      height: 600,
    });
    expect(readImageSize(bytes(0xff, 0xd8, 0xff, 0xd0, ...frame(0xc0)))).toEqual({
      width: 1200,
      height: 600,
    });
  });

  it("gives up on a JPEG that ends, truncates or self-loops instead of reading past it", () => {
    expect(readImageSize(bytes(0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0))).toBeNull(); // EOI
    expect(readImageSize(bytes(0xff, 0xd8, 0xff, 0x00, 0, 0, 0, 0))).toBeNull(); // stuffed byte
    expect(readImageSize(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0, 0))).toBeNull(); // len < 2 would loop
    expect(readImageSize(bytes(0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 2))).toBeNull(); // SOF cut short
    expect(readImageSize(bytes(0xff, 0xd8, 0xff))).toBeNull();
  });

  it("never reads a JPEG's scan data as a frame header", () => {
    // Entropy-coded data is full of bytes that look like markers. Walking past SOS/EOI would
    // report that noise as the image size — and a garbage size gets a real photo REJECTED.
    const noiseThatLooksLikeSof = [
      0xff, 0xc0, 0x00, 0x11, 0x08, 0xff, 0xff, 0xff, 0xff, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0,
    ];
    for (const end of [0xda, 0xd9, 0x00])
      expect(
        readImageSize(bytes(0xff, 0xd8, 0xff, end, 0x00, 0x04, 1, 2, ...noiseThatLooksLikeSof)),
      ).toBeNull();
  });

  it("requires the SOI magic even when a valid frame header follows it", () => {
    const frame = [
      0xff, 0xc0, 0x00, 0x11, 0x08, 2, 0x58, 4, 0xb0, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0,
    ];
    expect(readImageSize(bytes(0xff, 0xd8, ...frame))).toEqual({ width: 1200, height: 600 });
    expect(readImageSize(bytes(0x00, 0xd8, ...frame))).toBeNull();
    expect(readImageSize(bytes(0xff, 0x00, ...frame))).toBeNull();
  });

  it("requires PNG's first chunk to be IHDR, not just any chunk", () => {
    const notIhdr = png(9, 9);
    notIhdr.set(chars("IDAT"), 12);
    expect(readImageSize(notIhdr)).toBeNull();
  });

  it("requires BOTH webp magics, and the right codec chunk for the layout it reads", () => {
    const notRiff = webpX(9, 9);
    notRiff.set(chars("XXXX"), 0); // "WEBP" still at offset 8
    expect(readImageSize(notRiff)).toBeNull();
    // An animation chunk whose bytes happen to sit where VP8's sync code and size do: reading
    // it as lossy VP8 would invent a size for a frame that is not there.
    const animation = webpLossy(1280, 720);
    animation.set(chars("ANMF"), 12);
    expect(readImageSize(animation)).toBeNull();
  });

  it("reads the legacy 12-byte BMP header as well as the modern one", () => {
    const core = bytes(
      ...chars("BM"),
      ...le32(0),
      ...le32(0),
      ...le32(26),
      ...le32(12),
      ...le16(640),
      ...le16(480),
      0,
      0,
      0,
      0,
    );
    expect(readImageSize(core)).toEqual({ width: 640, height: 480 });
  });
});

describe("ffmpegCanDecodeSize — the limit ffmpeg actually enforces", () => {
  it("rejects the observed screenshot and accepts ordinary media", () => {
    // ffmpeg on the real file: "[png] Picture size 6864x41754 is invalid" -> zero frames out.
    expect(ffmpegCanDecodeSize(6864, 41754)).toBe(false);
    expect(ffmpegCanDecodeSize(1920, 1080)).toBe(true);
    expect(ffmpegCanDecodeSize(1080, 1920)).toBe(true);
    expect(ffmpegCanDecodeSize(8000, 8000)).toBe(true); // a long page capture still passes
  });

  it("is exact at the boundary and rejects degenerate sizes", () => {
    // av_image_check_size2: (w+128)*(h+128) < INT_MAX/8. Straddle it by ONE pixel of height.
    const w = 4096;
    const maxH = Math.floor(0x7fffffff / 8 / (w + 128)) - 128;
    expect(ffmpegCanDecodeSize(w, maxH)).toBe(true);
    expect(ffmpegCanDecodeSize(w, maxH + 1)).toBe(false);
    expect(ffmpegCanDecodeSize(0, 1080)).toBe(false);
    expect(ffmpegCanDecodeSize(1920, 0)).toBe(false);
    expect(ffmpegCanDecodeSize(-1920, 1080)).toBe(false);
    expect(ffmpegCanDecodeSize(1920, -1080)).toBe(false);
    expect(ffmpegCanDecodeSize(NaN, 1080)).toBe(false);
    expect(ffmpegCanDecodeSize(1920, Infinity)).toBe(false);
  });
});

describe("undecodableImageReason", () => {
  it("names the size so the caller can act, and stays silent on good media", () => {
    expect(undecodableImageReason(png(6864, 41754))).toMatch(/6864x41754/);
    expect(undecodableImageReason(png(1920, 1080))).toBeNull();
  });

  it("catches an oversized still in EVERY parsed format, not just the reported png", () => {
    // The witness was a screenshot; the rule is about size, so a generated/dragged-in asset in
    // any other format must be caught by the same call.
    expect(undecodableImageReason(bmp(20000, 20000))).not.toBeNull();
    expect(undecodableImageReason(webpX(16000, 16800))).not.toBeNull();
    expect(undecodableImageReason(gif(65535, 65535))).not.toBeNull();
    expect(undecodableImageReason(jpeg(65500, 65500))).not.toBeNull();
  });

  it("does NOT reject an unparseable file (blocking a legitimate import is the worse failure)", () => {
    expect(undecodableImageReason(bytes(...chars("II"), 42, 0))).toBeNull();
  });
});

describe("properties", () => {
  it("round-trips any representable size, for every format that carries one", () => {
    const cases: [(w: number, h: number) => Uint8Array, number][] = [
      [png, 0x7fffffff],
      [jpeg, 0xffff],
      [gif, 0xffff],
      [bmp, 0x7fffffff],
      [webpX, 0x1000000],
      [webpL, 0x4000],
      [webpLossy, 0x3fff],
    ];
    for (const [make, max] of cases) {
      fc.assert(
        fc.property(fc.integer({ min: 1, max }), fc.integer({ min: 1, max }), (w, h) => {
          expect(readImageSize(make(w, h))).toEqual({ width: w, height: h });
        }),
        { numRuns: 200 },
      );
    }
  });

  it("flags a size if and ONLY if it breaks ffmpeg's area rule — same verdict in every format", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 0x3fff }),
        fc.integer({ min: 1, max: 0x3fff }),
        (w, h) => {
          const expected = (w + 128) * (h + 128) >= 0x7fffffff / 8;
          for (const make of [png, jpeg, gif, bmp, webpX, webpL, webpLossy])
            expect(undecodableImageReason(make(w, h)) !== null).toBe(expected);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("never throws on arbitrary bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (b) => {
        readImageSize(b);
        undecodableImageReason(b);
      }),
      { numRuns: 1000 },
    );
  });

  it("never throws on a CORRUPTED real header (the parsers walk attacker-shaped input)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(png, jpeg, gif, bmp, webpX, webpL, webpLossy),
        fc.nat({ max: 40 }),
        fc.integer({ min: 0, max: 255 }),
        fc.nat({ max: 40 }),
        (make, at, value, truncateBy) => {
          const b = make(1024, 768);
          if (at < b.length) b[at] = value;
          readImageSize(b.slice(0, Math.max(0, b.length - truncateBy)));
        },
      ),
      { numRuns: 1000 },
    );
  });
});
