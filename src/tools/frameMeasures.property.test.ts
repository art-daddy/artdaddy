// Properties of the two frame measures inspect_media reports (sharpness, noise). Rules that hold
// for ANY image, so a rewrite of the arithmetic cannot pass by restating it.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { laplacianVariance, noiseSigma } from "./frameMeasures";

const W = 96;
const H = 64;

/** Deterministic Gaussian noise (Box-Muller over a seeded LCG), so a failure reproduces. */
function gaussian(seed: number): () => number {
  let s = seed >>> 0 || 1;
  const u = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s + 1) / 4294967297;
  };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

function image(f: (x: number, y: number) => number, w = W, h = H): Uint8Array {
  const px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = clamp(f(x, y));
  return px;
}

function boxBlur(px: Uint8Array, w = W, h = H): Uint8Array {
  return image(
    (x, y) => {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          s += px[yy * w + xx];
          n++;
        }
      return s / n;
    },
    w,
    h,
  );
}

describe("noiseSigma", () => {
  it("reads 0 on a flat frame, and no more than 8-bit rounding on a smooth ramp", () => {
    expect(
      noiseSigma(
        image(() => 77),
        W,
        H,
      ),
    ).toBe(0);
    // A ramp is exactly cancelled by the mask; what is left is the rounding to 8 bits, whose own
    // sigma is 1/sqrt(12) = 0.29. Visible noise starts around 2, so the gap is wide.
    fc.assert(
      fc.property(
        fc.integer({ min: 20, max: 230 }),
        fc.integer({ min: -1, max: 1 }),
        fc.integer({ min: -1, max: 1 }),
        (base, gx, gy) => {
          expect(
            noiseSigma(
              image((x, y) => base + gx * x * 0.3 + gy * y * 0.3),
              W,
              H,
            ),
          ).toBeLessThan(0.6);
        },
      ),
    );
  });

  it("recovers the sigma of added Gaussian noise within 15%", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 14 }),
        fc.integer({ min: 1, max: 1e6 }),
        (sigma, seed) => {
          const g = gaussian(seed);
          const px = image(() => 128 + sigma * g(), 256, 192);
          const est = noiseSigma(px, 256, 192);
          expect(Math.abs(est - sigma) / sigma).toBeLessThan(0.15);
        },
      ),
      { numRuns: 40 },
    );
  });

  it("rises with the noise: more noise never reads as less", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1e6 }), (seed) => {
        const g1 = gaussian(seed);
        const g2 = gaussian(seed);
        const low = noiseSigma(
          image(() => 128 + 3 * g1(), 128, 96),
          128,
          96,
        );
        const high = noiseSigma(
          image(() => 128 + 9 * g2(), 128, 96),
          128,
          96,
        );
        expect(high).toBeGreaterThan(low * 2);
      }),
      { numRuns: 30 },
    );
  });
});

describe("laplacianVariance", () => {
  it("is zero on a flat frame and grows with contrast", () => {
    expect(
      laplacianVariance(
        image(() => 90),
        W,
        H,
      ),
    ).toBe(0);
    const checker = (amp: number) =>
      image((x, y) => 128 + (((x >> 2) + (y >> 2)) & 1 ? amp : -amp));
    expect(laplacianVariance(checker(40), W, H)).toBeGreaterThan(
      laplacianVariance(checker(10), W, H) * 10,
    );
  });

  it("drops when the same frame is blurred, whatever the frame", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1e6 }),
        fc.integer({ min: 10, max: 60 }),
        (seed, amp) => {
          const g = gaussian(seed);
          const sharp = image(() => 128 + amp * g());
          expect(laplacianVariance(boxBlur(sharp), W, H)).toBeLessThan(
            laplacianVariance(sharp, W, H) * 0.5,
          );
        },
      ),
      { numRuns: 40 },
    );
  });

  it("answers 0 rather than throwing for frames too small to measure", () => {
    expect(laplacianVariance(new Uint8Array(4), 2, 2)).toBe(0);
    expect(noiseSigma(new Uint8Array(4), 2, 2)).toBe(0);
    expect(noiseSigma(new Uint8Array(3), 3, 3)).toBe(0); // short buffer
  });
});
