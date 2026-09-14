// Waveform math for timeline audio clips: downsample decoded PCM to a small
// array of peak amplitudes, then turn those into an SVG path. Both are pure and
// unit-tested; the actual audio decode (AudioContext) lives in the browser-only
// ClipWaveform component. The path is drawn in a `peaks.length` x `height`
// viewBox with preserveAspectRatio="none", so it stretches to any clip width.

/** Downsample a PCM channel to `buckets` peak amplitudes in [0,1] (max abs per
 *  bucket). Empty input yields a zero-filled array so callers can render a flat line. */
export function computePeaks(channel: Float32Array, buckets: number): Float32Array {
  const n = Math.max(1, Math.floor(buckets));
  const out = new Float32Array(n);
  if (channel.length === 0) return out;
  const per = channel.length / n;
  for (let i = 0; i < n; i += 1) {
    const start = Math.floor(i * per);
    const end = Math.min(channel.length, Math.max(start + 1, Math.floor((i + 1) * per)));
    let peak = 0;
    for (let j = start; j < end; j += 1) {
      const a = Math.abs(channel[j]);
      if (a > peak) peak = a;
    }
    out[i] = peak > 1 ? 1 : peak;
  }
  return out;
}

/** Build a filled SVG path for `peaks`, mirrored around the vertical centre of a
 *  `peaks.length` x `height` box (top edge forward, bottom edge back, closed). */
export function peaksToPath(peaks: Float32Array, height = 100): string {
  const n = peaks.length;
  if (n === 0) return "";
  const mid = height / 2;
  const amp = (i: number) => Math.max(0, Math.min(1, peaks[i])) * mid;
  let d = "";
  for (let i = 0; i < n; i += 1) d += `${i === 0 ? "M" : "L"}${i} ${mid - amp(i)}`;
  for (let i = n - 1; i >= 0; i -= 1) d += `L${i} ${mid + amp(i)}`;
  return `${d}Z`;
}
