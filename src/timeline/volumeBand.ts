// The volume rubber band's axis: level <-> vertical position within a clip.
//
// One owner, because three things read it — the line that is drawn, the key handles placed on it,
// and the value a click or drag commits. Two copies of "which pixel is 0.5 gain" is the S-series
// defect in miniature: the handle would sit where the line is not.
//
// The level is a LINEAR gain multiplier, matching `clip.volume` and the Inspector's slider. The
// band's top is MAX_BAND_GAIN rather than the model's unbounded ceiling: an axis needs a finite
// top to draw, and a drag simply cannot express more than this (the Inspector's number field
// still can). Unity sits proportionally, not centred, so 1.0 reads as a real level rather than a
// midpoint.

/** Loudest level the band can express. The Inspector's slider shares it. */
export const MAX_BAND_GAIN = 2;

/** Fraction from the TOP of the band for `gain` — 0 at the top, 1 at the bottom. */
export function bandFrac(gain: number): number {
  const g = Number.isFinite(gain) ? gain : 1;
  return 1 - Math.max(0, Math.min(MAX_BAND_GAIN, g)) / MAX_BAND_GAIN;
}

/** The gain a pointer at `frac` (0 = top, 1 = bottom) of the band means. */
export function bandGain(frac: number): number {
  const f = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0));
  return (1 - f) * MAX_BAND_GAIN;
}
