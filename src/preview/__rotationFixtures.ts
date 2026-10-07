// The rotated-video fixtures (UJ-015), described once for the three places that use them: the
// generator that writes them with the shipped ffmpeg (scripts/genRotationFixtures.ts), the smoke lane
// that holds expected.json to what that ffmpeg shows (orientation.smoke.e2e.ts), and the browser
// probe that holds the PREVIEW to the same expected.json (e2e/ui/rotation.spec.ts). Dev only.
//
// Every fixture carries the same coded frames - four quadrant colours on a 160x96 picture - and
// declares a different orientation. Four different corners tell the 8 orientations apart, and a
// frame that is not square shows a quarter turn whose size was not swapped.
import MP4Box, { type MP4ArrayBuffer, type MP4File, type MP4Info } from "mp4box";

export interface RotationFixture {
  file: string;
  /** -display_rotation: degrees counter-clockwise, written into the TRACK matrix (tkhd). */
  trackRotation: number;
  /** -display_hflip: a mirror after the turn, also in the track matrix. */
  hflip: boolean;
  /** Degrees counter-clockwise written into the MOVIE matrix (mvhd), which ffmpeg multiplies in. */
  movieRotation: number;
}

const variant = (trackRotation: number, hflip: boolean, movieRotation = 0): RotationFixture => ({
  file: `h264_rot${trackRotation}${hflip ? "_hflip" : ""}${movieRotation ? `_movie${movieRotation}` : ""}.mp4`,
  trackRotation,
  hflip,
  movieRotation,
});

export const ROTATION_FIXTURES: readonly RotationFixture[] = [
  ...[0, 90, 180, 270].flatMap((r) => [variant(r, false), variant(r, true)]),
  variant(0, false, 90),
  variant(90, false, 90),
  // A mirror and a turn do not commute, so this one pins the ORDER the two matrices multiply in.
  variant(0, true, 90),
];

export const PALETTE = {
  red: { hex: "0xE01010", rgb: [224, 16, 16] },
  green: { hex: "0x10E010", rgb: [16, 224, 16] },
  blue: { hex: "0x1010E0", rgb: [16, 16, 224] },
  white: { hex: "0xF0F0F0", rgb: [240, 240, 240] },
} as const;
export type Colour = keyof typeof PALETTE;

/** Where a corner's colour is read, as fractions of the SHOWN picture: the middle of each quadrant,
 *  clear of the edges a decoder's chroma blends. Top-left, top-right, bottom-left, bottom-right. */
export const CORNERS: ReadonlyArray<readonly [number, number]> = [
  [0.25, 0.25],
  [0.75, 0.25],
  [0.25, 0.75],
  [0.75, 0.75],
];

/** The palette colour nearest to `rgb`. */
export function classify(rgb: ArrayLike<number>): Colour {
  let best: Colour = "red";
  let bestD = Infinity;
  for (const [name, c] of Object.entries(PALETTE) as Array<[Colour, (typeof PALETTE)[Colour]]>) {
    const d = (rgb[0] - c.rgb[0]) ** 2 + (rgb[1] - c.rgb[1]) ** 2 + (rgb[2] - c.rgb[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}

/** expected.json: what the shipped ffmpeg decodes each fixture as. */
export interface RotationExpected {
  ffmpeg: string;
  fixtures: Record<
    string,
    {
      coded: [number, number];
      display: [number, number];
      corners: [Colour, Colour, Colour, Colour];
    }
  >;
}

/** A whole (small) MP4 parsed by mp4box, the parser the preview's decoder runs. */
export function parseMp4(bytes: Uint8Array): { mp4: MP4File; info: MP4Info } {
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as MP4ArrayBuffer;
  ab.fileStart = 0;
  const mp4 = MP4Box.createFile();
  let info: MP4Info | null = null;
  mp4.onReady = (i) => {
    info = i;
  };
  mp4.appendBuffer(ab);
  mp4.flush();
  if (!info) throw new Error("mp4box found no movie");
  return { mp4, info };
}
