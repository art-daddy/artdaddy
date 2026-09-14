// What `similarity` MEANS for a chroma key — one definition, shared by the preview shader and the
// exporter's `chromakey` filter.
//
// They used to disagree completely. The shader keyed on plain RGB euclidean distance (range 0..√3);
// ffmpeg keys on distance in the CHROMA plane alone, normalised to 0..1. The same number therefore
// described two very different keys, and a real session (feedback d03ab792) walked straight into it:
// the user's preview still showed green backing, so the model raised similarity 0.30 -> 0.42 to get
// rid of it. In the preview that barely changed anything. In the export, 0.42 is past the point
// where WHITE is inside the key — so every white patch of an orange-and-white cat became
// transparent and the delivered video showed a floating nose and mouth.
//
// The constants below are MEASURED against the bundled ffmpeg (binary search on the alpha plane,
// see chromaKey.smoke.e2e.ts), not derived from the docs. The asymmetry is real and is ffmpeg's:
// the FRAME's chroma is limited range (tv, 16..240) because that is what yuv420p video carries,
// while the KEY colour's chroma is computed at FULL range from its RGB. Modelling both the same
// way is wrong for every saturated colour — blue lands at 0.634 instead of its true 0.597.
//
//   colour     measured flip   this model
//   #FFFFFF       0.3773         0.3776
//   #FFA500       0.4381         0.4384
//   #0000FF       0.5968         0.5977

/** BT.601 luma-difference chroma, the basis yuv420p frames are already in. */
const U_COEFF = [-0.168736, -0.331264, 0.5] as const;
const V_COEFF = [0.5, -0.418688, -0.081312] as const;
/** Limited-range chroma occupies 224 of 255 codes, centred on 128. */
const TV_CHROMA = 224 / 255;

/** GLSL for the same maths, so the shader cannot drift from the numbers above. `toFixed` is not
 *  cosmetic: a coefficient that ever became an integer would emit `1`, which GLSL ES rejects as a
 *  float, and the whole compositor would fail to compile. */
const f = (n: number): string => n.toFixed(8);
export const KEY_GLSL = `vec2 artdaddy_uv(vec3 c) {
  return vec2(
    ${f(U_COEFF[0])} * c.r + ${f(U_COEFF[1])} * c.g + ${f(U_COEFF[2])} * c.b,
    ${f(V_COEFF[0])} * c.r + ${f(V_COEFF[1])} * c.g + ${f(V_COEFF[2])} * c.b);
}
float artdaddy_key_dist(vec3 c, vec3 k) {
  vec2 d = ${f(TV_CHROMA)} * artdaddy_uv(c) - artdaddy_uv(k);
  return sqrt(dot(d, d) / 2.0);
}`;

function uv(r: number, g: number, b: number): [number, number] {
  return [
    U_COEFF[0] * r + U_COEFF[1] * g + U_COEFF[2] * b,
    V_COEFF[0] * r + V_COEFF[1] * g + V_COEFF[2] * b,
  ];
}

/** ffmpeg's normalised chroma distance between a sampled colour and the key: 0 = same hue, 1 =
 *  as far apart as the plane allows. Both arguments are 0..1 RGB. */
export function keyDistance(rgb: [number, number, number], key: [number, number, number]): number {
  const [uc, vc] = uv(rgb[0], rgb[1], rgb[2]);
  const [uk, vk] = uv(key[0], key[1], key[2]);
  const du = TV_CHROMA * uc - uk;
  const dv = TV_CHROMA * vc - vk;
  return Math.sqrt((du * du + dv * dv) / 2);
}

/** Alpha multiplier a chroma key applies, matching `chromakey`'s own ramp: a hard cut when blend
 *  is ~0, otherwise linear across `blend` above the threshold. NOT a smoothstep — that was the
 *  shader's other divergence, and it softens edges the export leaves hard. */
export function keyAlpha(
  rgb: [number, number, number],
  key: [number, number, number],
  similarity: number,
  blend: number,
): number {
  const d = keyDistance(rgb, key);
  if (blend > 0.0001) return Math.min(1, Math.max(0, (d - similarity) / blend));
  return d > similarity ? 1 : 0;
}
