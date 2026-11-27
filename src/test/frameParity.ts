// Whole-frame picture comparison for the preview <-> export parity lanes (art-daddy/backlog#83).
// Pure and browser-safe: the smoke lane runs it on frames ffmpeg decoded from the exported file,
// the browser lane on what the preview's canvas shows, and both against the same frozen references.
//
// A frame is compared as a grid of BLOCK MEANS, never pixel by pixel: the two painters sample and
// convert colour differently (bilinear vs ffmpeg's scaler, the webview's YUV->RGB vs ffmpeg's), and
// draw text with two rasterisers, so single pixels at an edge always differ. A block mean keeps what
// a person sees (a region's colour, whether a caption, a bar or a box is there, where it is) and
// drops the sub-pixel detail neither painter promises.

/** An 8-bit RGB picture, rows top to bottom. */
export interface Picture {
  w: number;
  h: number;
  rgb: Uint8Array;
}

/** RGBA pixels (canvas ImageData, a decoded frame) as a Picture: alpha dropped. */
export function fromRgba(rgba: ArrayLike<number>, w: number, h: number): Picture {
  if (rgba.length !== w * h * 4) throw new Error(`${rgba.length} RGBA bytes for ${w}x${h}`);
  const rgb = new Uint8Array(w * h * 3);
  for (let p = 0; p < w * h; p++) {
    rgb[p * 3] = rgba[p * 4];
    rgb[p * 3 + 1] = rgba[p * 4 + 1];
    rgb[p * 3 + 2] = rgba[p * 4 + 2];
  }
  return { w, h, rgb };
}

/** The mean of every `k` x `k` block, rounded: a picture `k` times smaller each way. A partial
 *  block at the right or bottom edge is dropped. */
export function pool(picture: Picture, k: number): Picture {
  if (!Number.isInteger(k) || k < 1) throw new Error(`block size ${k}`);
  const { w, h, rgb } = picture;
  if (rgb.length !== w * h * 3) throw new Error(`${rgb.length} RGB bytes for ${w}x${h}`);
  const ow = Math.floor(w / k);
  const oh = Math.floor(h / k);
  const out = new Uint8Array(ow * oh * 3);
  const area = k * k;
  for (let by = 0; by < oh; by++)
    for (let bx = 0; bx < ow; bx++)
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let y = by * k; y < (by + 1) * k; y++)
          for (let x = bx * k; x < (bx + 1) * k; x++) sum += rgb[(y * w + x) * 3 + c];
        out[(by * ow + bx) * 3 + c] = Math.round(sum / area);
      }
  return { w: ow, h: oh, rgb: out };
}

/** How far apart two pictures of one size are, block by block: each block's distance is its
 *  largest channel difference (0-255). */
export interface Difference {
  /** The mean block distance over the whole frame: a colour or level shift everywhere. */
  mean: number;
  /** The largest block distance: one thing missing, moved or drawn differently. */
  max: number;
  /** Where the largest is, in blocks. */
  at: [number, number];
}

export function difference(a: Picture, b: Picture): Difference {
  if (a.w !== b.w || a.h !== b.h) throw new Error(`${a.w}x${a.h} against ${b.w}x${b.h}`);
  let sum = 0;
  let max = -1;
  let at: [number, number] = [0, 0];
  for (let p = 0; p < a.w * a.h; p++) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a.rgb[p * 3 + c] - b.rgb[p * 3 + c]));
    sum += d;
    if (d > max) {
      max = d;
      at = [p % a.w, Math.floor(p / a.w)];
    }
  }
  return { mean: sum / (a.w * a.h), max: Math.max(0, max), at };
}

/** How close two pictures must be. */
export interface Tolerance {
  /** Largest allowed mean block distance. */
  mean: number;
  /** Largest allowed single block distance. */
  max: number;
}

export function within(d: Difference, t: Tolerance): boolean {
  return d.mean <= t.mean && d.max <= t.max;
}

export function describe(d: Difference): string {
  return `mean ${d.mean.toFixed(2)}, max ${d.max} at block (${d.at[0]}, ${d.at[1]})`;
}
