// Sharpness and noise of a frame, as plain numbers (owner decision 2026-10-03: numbers only, no
// verdict words). Both are computed on an 8-bit grey frame scaled to a 512 px long edge, so values
// compare across sources of different resolutions. Pure: the pixels in, two numbers out.

/** Variance of the 4-neighbour Laplacian over the interior pixels (Pech-Pacheco et al. 2000).
 *  Edges and fine detail raise it; defocus, motion blur and upscaling lower it. 0 for a flat frame. */
export function laplacianVariance(px: Uint8Array, w: number, h: number): number {
  if (w < 3 || h < 3 || px.length < w * h) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      const lap = px[i - w] + px[i + w] + px[i - 1] + px[i + 1] - 4 * px[i];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  return Math.max(0, sumSq / n - mean * mean);
}

/** Immerkaer's fast noise estimate (1996) with Tai & Yang's edge exclusion (2008): sigma of
 *  additive noise on 0-255 luma, from the response to a mask that cancels smooth structure,
 *  summed only where the Sobel gradient is below its 90th percentile. Without the exclusion, text
 *  and texture read as noise: a clean captioned export measured 3.5, more than a phone clip with
 *  added grain. */
export function noiseSigma(px: Uint8Array, w: number, h: number): number {
  if (w < 3 || h < 3 || px.length < w * h) return 0;
  const n = (w - 2) * (h - 2);
  const grad = new Float32Array(n);
  const resp = new Float32Array(n);
  let k = 0;
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      const a = px[i - w - 1];
      const b = px[i - w];
      const c = px[i - w + 1];
      const d = px[i - 1];
      const e = px[i];
      const f = px[i + 1];
      const g = px[i + w - 1];
      const hh = px[i + w];
      const j = px[i + w + 1];
      grad[k] = Math.abs(c + 2 * f + j - a - 2 * d - g) + Math.abs(g + 2 * hh + j - a - 2 * b - c);
      resp[k] = Math.abs(a - 2 * b + c - 2 * d + 4 * e - 2 * f + g - 2 * hh + j);
      k++;
    }
  }
  const limit = Float32Array.from(grad).sort()[Math.floor(n * 0.9)];
  let acc = 0;
  let used = 0;
  for (let i = 0; i < n; i++) {
    if (grad[i] > limit) continue;
    acc += resp[i];
    used++;
  }
  return used ? (Math.sqrt(Math.PI / 2) * acc) / (6 * used) : 0;
}
