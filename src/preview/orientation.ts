// How a video file's STORED pixels map to the picture it SHOWS (UJ-015).
//
// A phone records sideways and says so in the container: a display matrix in the track header
// (ISO 14496-12 `tkhd`), times the movie header's (`mvhd`), as ffmpeg's mov demuxer multiplies
// them. ffmpeg applies that turn for the export, `inspect_media` / `inspect_timeline` and the
// preview proxy, so the preview - which decodes the file itself - has to apply the same one or it
// plays a portrait clip on its side. This module is the preview's one reading of it: the decoder
// (videoSource.ts) learns a file's orientation, the shown size follows from it, and the renderer
// samples the decoded frame through it. ORIENT_GLSL below is the same mapping for the shader.
//
// Measured against the shipped ffmpeg rather than read off its source: for every turn and mirror
// (and for turns in the movie header) ffmpeg's picture is the stored one re-arranged by exactly
// this mapping, byte for byte (orientation.smoke.e2e.ts).

/** texture uv = 0.5 + M (shown uv - 0.5); `m` is M row-major [m00, m01, m10, m11], each -1, 0 or 1. */
export interface Orientation {
  readonly m: readonly [number, number, number, number];
  /** A quarter turn: the picture is shown as tall as it is stored wide. */
  readonly swap: boolean;
}

export const UPRIGHT: Orientation = { m: [1, 0, 0, 1], swap: false };

/** ffmpeg rounds a file's turn to whole degrees and applies a quarter turn only when that is exactly
 *  one (fftools get_rotation): measured with the shipped build, 90.49 degrees turns a quarter and
 *  90.51 does not. sin(0.5 degrees) of the matrix's scale is that window on a component. */
const SNAP = Math.sin(Math.PI / 360);

/** The 2x2 part of a stored matrix (a b u / c d v / x y w, a-d in 16.16 fixed point) in units of
 *  1.0, or null for anything that is not a whole matrix of numbers. Every entry is read as SIGNED
 *  32-bit: mp4box reads the movie header's matrix unsigned, and a quarter turn's -1.0 would
 *  otherwise be 65535.0. */
function linear(m: ArrayLike<number> | null | undefined): [number, number, number, number] | null {
  if (!m || m.length < 9) return null;
  const raw = [m[0], m[1], m[3], m[4]].map(Number);
  if (!raw.every(Number.isFinite)) return null;
  return raw.map((x) => (x | 0) / 65536) as [number, number, number, number];
}

/** The orientation of a track whose matrix is `track`, in a movie whose matrix is `movie`. A
 *  missing or malformed matrix counts as no turn; a turn that is not a whole quarter shows the
 *  frame as stored - ffmpeg turns such a file by the exact angle, which a texture lookup cannot. */
export function orientationOf(
  track: ArrayLike<number> | null | undefined,
  movie?: ArrayLike<number> | null,
): Orientation {
  const t = linear(track) ?? [1, 0, 0, 1];
  const mv = linear(movie) ?? [1, 0, 0, 1];
  // Row vectors, as the format and ffmpeg's mov_read_tkhd use them: shown = stored x track x movie.
  const a = t[0] * mv[0] + t[1] * mv[2];
  const b = t[0] * mv[1] + t[1] * mv[3];
  const c = t[2] * mv[0] + t[3] * mv[2];
  const d = t[2] * mv[1] + t[3] * mv[3];
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
  const zero = (x: number) => Math.abs(x) < scale * SNAP;
  // Stored -> shown is the matrix's transpose acting on column vectors; for a turn or a mirror the
  // inverse of that is the matrix itself, read row-major, which is the shown -> stored lookup.
  if (zero(b) && zero(c) && !zero(a) && !zero(d))
    return { m: [Math.sign(a), 0, 0, Math.sign(d)], swap: false };
  if (zero(a) && zero(d) && !zero(b) && !zero(c))
    return { m: [0, Math.sign(b), Math.sign(c), 0], swap: true };
  return UPRIGHT;
}

/** The orientation mp4box's parse of a file declares for `track`: its header times the movie's. */
export function mp4Orientation(
  file: { moov?: { mvhd?: { matrix?: ArrayLike<number> } } },
  track: { matrix?: ArrayLike<number> },
): Orientation {
  return orientationOf(track.matrix, file.moov?.mvhd?.matrix);
}

/** The size a frame stored at `coded` is shown at. */
export function displaySize(
  coded: { w: number; h: number },
  o: Orientation,
): { w: number; h: number } {
  return o.swap ? { w: coded.h, h: coded.w } : { w: coded.w, h: coded.h };
}

/** Where in the stored frame (0..1, top-left origin) the shown point (u, v) comes from. */
export function textureUv(o: Orientation, u: number, v: number): [number, number] {
  const [m00, m01, m10, m11] = o.m;
  return [0.5 + m00 * (u - 0.5) + m01 * (v - 0.5), 0.5 + m10 * (u - 0.5) + m11 * (v - 0.5)];
}

/** textureUv for the shader, with `m` passed as a vec4 (m00, m01, m10, m11). */
export const ORIENT_GLSL = `vec2 artdaddy_tex_uv(vec2 uv, vec4 m) {
  vec2 q = uv - 0.5;
  return 0.5 + vec2(m.x * q.x + m.y * q.y, m.z * q.x + m.w * q.y);
}`;
