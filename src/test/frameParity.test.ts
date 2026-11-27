// The measuring rule both parity lanes stand on (frameParity.ts): if it answered "the same" for
// pictures that differ, every whole-frame parity test would pass while the preview drew nothing.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { type Picture, describe as told, difference, fromRgba, pool, within } from "./frameParity";

/** A random picture `k` blocks across and down, each block `size` pixels square. */
const picture = (size: number) =>
  fc
    .record({ bw: fc.integer({ min: 1, max: 6 }), bh: fc.integer({ min: 1, max: 6 }) })
    .chain(({ bw, bh }) =>
      fc
        .uint8Array({ minLength: bw * size * bh * size * 3, maxLength: bw * size * bh * size * 3 })
        .map((rgb): Picture => ({ w: bw * size, h: bh * size, rgb })),
    );

const solid = (w: number, h: number, [r, g, b]: [number, number, number]): Picture => {
  const rgb = new Uint8Array(w * h * 3);
  for (let p = 0; p < w * h; p++) rgb.set([r, g, b], p * 3);
  return { w, h, rgb };
};

describe("difference: how far two pictures are apart", () => {
  it("is zero for a picture and itself, and symmetric, and never past 255", () => {
    fc.assert(
      fc.property(
        picture(1).chain((a) =>
          fc
            .uint8Array({ minLength: a.rgb.length, maxLength: a.rgb.length })
            .map((rgb) => [a, { ...a, rgb }] as const),
        ),
        ([a, b]) => {
          expect(difference(a, a)).toMatchObject({ mean: 0, max: 0 });
          const ab = difference(a, b);
          const ba = difference(b, a);
          expect([ab.mean, ab.max]).toEqual([ba.mean, ba.max]);
          expect(ab.mean).toBeGreaterThanOrEqual(0);
          expect(ab.mean).toBeLessThanOrEqual(ab.max);
          expect(ab.max).toBeLessThanOrEqual(255);
        },
      ),
    );
  });

  it("sees one changed channel of one pixel: the max is that change, and it says where", () => {
    fc.assert(
      fc.property(
        picture(1),
        fc.nat(),
        fc.integer({ min: 0, max: 2 }),
        fc.integer({ min: 1, max: 255 }),
        (a, at, channel, by) => {
          const p = at % (a.w * a.h);
          const b = { ...a, rgb: Uint8Array.from(a.rgb) };
          const was = b.rgb[p * 3 + channel];
          b.rgb[p * 3 + channel] = was + by <= 255 ? was + by : was - by;
          const d = difference(a, b);
          expect(d.max).toBe(Math.abs(b.rgb[p * 3 + channel] - was));
          expect(d.at).toEqual([p % a.w, Math.floor(p / a.w)]);
          expect(d.mean).toBeCloseTo(d.max / (a.w * a.h), 9);
        },
      ),
    );
  });

  it("refuses pictures of two sizes rather than comparing part of one", () => {
    expect(() => difference(solid(4, 4, [0, 0, 0]), solid(4, 8, [0, 0, 0]))).toThrow(
      /4x4 against 4x8/,
    );
    expect(() => difference(solid(4, 4, [0, 0, 0]), solid(8, 4, [0, 0, 0]))).toThrow(
      /4x4 against 8x4/,
    );
  });
});

describe("pool: the block means a reference holds", () => {
  it("keeps a flat picture flat and a block of 1 unchanged", () => {
    fc.assert(
      fc.property(
        fc.tuple(fc.nat(255), fc.nat(255), fc.nat(255)),
        fc.integer({ min: 1, max: 5 }),
        (colour, k) => {
          const flat = solid(k * 3, k * 2, colour);
          const pooled = pool(flat, k);
          expect([pooled.w, pooled.h]).toEqual([3, 2]);
          expect(difference(pooled, solid(3, 2, colour)).max).toBe(0);
        },
      ),
    );
    fc.assert(
      fc.property(picture(1), (a) => {
        expect(pool(a, 1)).toEqual(a);
      }),
    );
  });

  it("keeps the picture's mean colour, to rounding", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }).chain((k) => picture(k).map((a) => [k, a] as const)),
        ([k, a]) => {
          const pooled = pool(a, k);
          for (let c = 0; c < 3; c++) {
            let full = 0;
            let small = 0;
            for (let p = 0; p < a.w * a.h; p++) full += a.rgb[p * 3 + c];
            for (let p = 0; p < pooled.w * pooled.h; p++) small += pooled.rgb[p * 3 + c];
            expect(Math.abs(full / (a.w * a.h) - small / (pooled.w * pooled.h))).toBeLessThan(
              0.5 + 1e-9,
            );
          }
        },
      ),
    );
  });

  it("shows a missing square as large as a block at its full contrast", () => {
    // A caption, a logo or a bar that is not drawn leaves at least one whole block of the other
    // colour: pooling must not average it away.
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 6 }),
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (k, bx, by, ground, ink) => {
          fc.pre(ink !== ground);
          const without = solid(4 * k, 4 * k, [ground, ground, ground]);
          const withIt = { ...without, rgb: Uint8Array.from(without.rgb) };
          for (let y = by * k; y < (by + 1) * k; y++)
            for (let x = bx * k; x < (bx + 1) * k; x++)
              withIt.rgb.set([ink, ink, ink], (y * 4 * k + x) * 3);
          const d = difference(pool(withIt, k), pool(without, k));
          expect(d.max).toBe(Math.abs(ink - ground));
          expect(d.at).toEqual([bx, by]);
        },
      ),
    );
  });

  it("drops a partial block at the right and bottom edges", () => {
    const pooled = pool(solid(10, 7, [9, 9, 9]), 4);
    expect([pooled.w, pooled.h]).toEqual([2, 1]);
  });

  it("refuses a block size that is not a whole number of pixels, and bytes that are not the picture", () => {
    for (const k of [0, -1, 1.5, Number.NaN])
      expect(() => pool(solid(4, 4, [0, 0, 0]), k)).toThrow(/block size/);
    expect(() => pool({ w: 4, h: 4, rgb: new Uint8Array(47) }, 2)).toThrow(/47 RGB bytes for 4x4/);
  });
});

describe("within: the tolerance", () => {
  it("says what it measured, so a failing parity test names the size and the place", () => {
    expect(told({ mean: 3.14159, max: 51, at: [40, 7] })).toBe(
      "mean 3.14, max 51 at block (40, 7)",
    );
  });

  it("allows a difference up to both limits and nothing past either", () => {
    expect(within({ mean: 5, max: 64, at: [0, 0] }, { mean: 5, max: 64 })).toBe(true);
    expect(within({ mean: 5, max: 65, at: [0, 0] }, { mean: 5, max: 64 })).toBe(false);
    expect(within({ mean: 5.01, max: 64, at: [0, 0] }, { mean: 5, max: 64 })).toBe(false);
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 255, noNaN: true }),
        fc.integer({ min: 0, max: 255 }),
        fc.double({ min: 0, max: 255, noNaN: true }),
        fc.integer({ min: 0, max: 255 }),
        (mean, max, tMean, tMax) => {
          const d = { mean, max, at: [0, 0] as [number, number] };
          expect(within(d, { mean: tMean, max: tMax })).toBe(mean <= tMean && max <= tMax);
        },
      ),
    );
  });
});

describe("fromRgba: a canvas's pixels as a picture", () => {
  it("keeps red, green and blue in order, drops alpha, and refuses bytes that are not the picture", () => {
    const rgba = Array.from({ length: 2 * 3 * 4 }, (_, i) => i);
    const p = fromRgba(rgba, 2, 3);
    expect([p.w, p.h]).toEqual([2, 3]);
    expect(Array.from(p.rgb)).toEqual(rgba.filter((_, i) => i % 4 !== 3));
    expect(() => fromRgba([1, 2, 3], 1, 1)).toThrow(/3 RGBA bytes for 1x1/);
  });
});
