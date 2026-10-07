// The preview's reading of a video's display matrix (UJ-015), held to what ffmpeg shows.
//
// The fixtures are real files and the expectations are ffmpeg's: e2e/ui/fixtures/rotation holds
// one H.264 picture declared in 11 orientations (every turn and mirror, plus turns in the MOVIE
// header), and expected.json is what the shipped ffmpeg decodes each as - the picture the export
// shows. orientation.smoke.e2e.ts keeps expected.json honest against that ffmpeg. Parsing here is
// done by mp4box, the same parser the preview runs, so nothing below is a hand-made matrix except
// where a property says so.
import { readFileSync } from "node:fs";
import path from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type Orientation,
  UPRIGHT,
  displaySize,
  mp4Orientation,
  orientationOf,
  textureUv,
} from "./orientation";
import { CORNERS, ROTATION_FIXTURES, type RotationExpected, parseMp4 } from "./__rotationFixtures";

const DIR = path.resolve(process.cwd(), "e2e/ui/fixtures/rotation");
const EXPECTED = JSON.parse(
  readFileSync(path.join(DIR, "expected.json"), "utf8"),
) as RotationExpected;

const parse = (file: string) => parseMp4(readFileSync(path.join(DIR, file)));

/** The stored picture every fixture carries: red | green over blue | white. */
function storedColour(u: number, v: number): string {
  if (v < 0.5) return u < 0.5 ? "red" : "green";
  return u < 0.5 ? "blue" : "white";
}

const IDENTITY = [65536, 0, 0, 0, 65536, 0, 0, 0, 0x40000000];
/** The track matrices of the 8 track-only fixtures, as mp4box reads them from the files. */
const BASES = ROTATION_FIXTURES.filter((f) => !f.movieRotation).map((f) =>
  Array.from(parse(f.file).info.videoTracks[0].matrix ?? []),
);

const same = (a: Orientation, b: Orientation) => {
  expect(a.swap).toBe(b.swap);
  expect(a.m.map((x) => x + 0)).toEqual(b.m.map((x) => x + 0)); // -0 and 0 are the same turn
};

describe("orientation: the preview shows what ffmpeg shows", () => {
  it("covers the fixture set (11 files, 8 distinct pictures)", () => {
    expect(Object.keys(EXPECTED.fixtures).sort()).toEqual(
      ROTATION_FIXTURES.map((f) => f.file).sort(),
    );
    const pictures = new Set(Object.values(EXPECTED.fixtures).map((e) => e.corners.join()));
    expect(pictures.size).toBe(8); // every turn and mirror of a rectangle, none repeated
  });

  for (const fx of ROTATION_FIXTURES) {
    it(`${fx.file}: shown size and corners equal ffmpeg's`, () => {
      const want = EXPECTED.fixtures[fx.file];
      const { mp4, info } = parse(fx.file);
      const track = info.videoTracks[0];
      const o = mp4Orientation(mp4, track);
      const shown = displaySize({ w: track.video.width, h: track.video.height }, o);
      expect([shown.w, shown.h]).toEqual(want.display);
      const corners = CORNERS.map(([u, v]) => storedColour(...textureUv(o, u, v)));
      expect(corners).toEqual(want.corners);
    });
  }

  it("a turn declared only by the movie header is not ignored", () => {
    // The failure direction: reading the track matrix alone shows this file unturned.
    const { mp4, info } = parse("h264_rot0_movie90.mp4");
    const track = info.videoTracks[0];
    same(orientationOf(track.matrix), UPRIGHT);
    expect(mp4Orientation(mp4, track).swap).toBe(true);
  });
});

describe("orientationOf: properties", () => {
  const base = fc.constantFrom(...BASES);
  const fixed = (v: number) => Math.round(v * 65536);

  it("ignores scale, translation and fixed-point noise below ffmpeg's half-degree snap", () => {
    fc.assert(
      fc.property(
        base,
        fc.double({ min: 0.25, max: 4, noNaN: true }),
        fc.array(fc.double({ min: -0.004, max: 0.004, noNaN: true }), {
          minLength: 4,
          maxLength: 4,
        }),
        fc.integer({ min: -4000, max: 4000 }),
        fc.integer({ min: -4000, max: 4000 }),
        (m, k, noise, tx, ty) => {
          const [a, b, , c, d] = m.map((v) => v / 65536);
          const moved = [
            fixed(k * (a + noise[0])),
            fixed(k * (b + noise[1])),
            0,
            fixed(k * (c + noise[2])),
            fixed(k * (d + noise[3])),
            0,
            fixed(tx),
            fixed(ty),
            0x40000000,
          ];
          same(orientationOf(moved), orientationOf(m));
        },
      ),
    );
  });

  it("reads a matrix stored as UNSIGNED 32-bit (mp4box reads the movie header that way)", () => {
    fc.assert(
      fc.property(base, (m) => {
        const unsigned = m.map((v) => v >>> 0);
        same(orientationOf(unsigned), orientationOf(m));
        same(orientationOf(IDENTITY, unsigned), orientationOf(m));
      }),
    );
  });

  it("an identity on either side changes nothing", () => {
    fc.assert(
      fc.property(base, (m) => {
        same(orientationOf(m, IDENTITY), orientationOf(m));
        same(orientationOf(IDENTITY, m), orientationOf(m));
      }),
    );
  });

  it("the movie's turn applies AFTER the track's: a texel is found by undoing the movie, then the track", () => {
    // The order is ffmpeg's (h264_rot0_hflip_movie90 above pins it with ffmpeg's own picture).
    fc.assert(
      fc.property(
        base,
        base,
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (t, m, u, v) => {
          const both = textureUv(orientationOf(t, m), u, v);
          const [mu, mv] = textureUv(orientationOf(m), u, v);
          const stepwise = textureUv(orientationOf(t), mu, mv);
          expect(both[0]).toBeCloseTo(stepwise[0], 12);
          expect(both[1]).toBeCloseTo(stepwise[1], 12);
        },
      ),
    );
  });

  it("moves every stored pixel to exactly one shown pixel (nothing lost, nothing doubled)", () => {
    fc.assert(
      fc.property(
        base,
        fc.integer({ min: 1, max: 24 }),
        fc.integer({ min: 1, max: 24 }),
        (m, w, h) => {
          const o = orientationOf(m);
          const shown = displaySize({ w, h }, o);
          expect(shown.w * shown.h).toBe(w * h);
          const hit = new Set<number>();
          for (let y = 0; y < shown.h; y++)
            for (let x = 0; x < shown.w; x++) {
              const [tu, tv] = textureUv(o, (x + 0.5) / shown.w, (y + 0.5) / shown.h);
              const sx = Math.floor(tu * w);
              const sy = Math.floor(tv * h);
              expect(sx >= 0 && sx < w && sy >= 0 && sy < h).toBe(true);
              hit.add(sy * w + sx);
            }
          expect(hit.size).toBe(w * h);
        },
      ),
    );
  });

  const turned = (deg: number) => {
    const r = (deg * Math.PI) / 180;
    return [
      fixed(Math.cos(r)),
      fixed(-Math.sin(r)),
      0,
      fixed(Math.sin(r)),
      fixed(Math.cos(r)),
      0,
      0,
      0,
      0x40000000,
    ];
  };

  it("snaps only within half a degree of a quarter turn, as ffmpeg does", () => {
    // Measured with the shipped ffmpeg: -display_rotation 90.49 decodes 96x160, 90.51 decodes 160x96
    // (it rounds the angle to whole degrees, then turns a quarter only at exactly 90).
    fc.assert(
      fc.property(
        fc.constantFrom(0, 90, 180, 270),
        fc.double({ min: -0.45, max: 0.45, noNaN: true }),
        (q, e) => {
          same(orientationOf(turned(q + e)), orientationOf(turned(q)));
        },
      ),
    );
    expect(orientationOf(turned(90.49)).swap).toBe(true);
    expect(orientationOf(turned(90.51)).swap).toBe(false);
  });

  it("leaves any other angle as stored rather than guessing a quarter turn", () => {
    // ffmpeg turns such a file by the exact angle; the preview cannot, so it keeps today's picture.
    fc.assert(
      fc.property(
        fc.constantFrom(0, 90, 180, 270),
        fc.double({ min: 0.55, max: 89.45, noNaN: true }),
        (q, e) => {
          same(orientationOf(turned(q + e)), UPRIGHT);
        },
      ),
    );
  });

  it("never throws on a missing or malformed matrix, and shows it as stored", () => {
    const PORTRAIT = [0, 65536, 0, -65536, 0, 0, 0, 0, 0x40000000]; // a phone's "rotation -90"
    expect(orientationOf(PORTRAIT).swap).toBe(true);
    for (const bad of [
      undefined,
      null,
      [],
      [65536],
      PORTRAIT.slice(0, 8), // cut short: not a matrix, even though its first entries read as a turn
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      new Array(9).fill(NaN),
      [NaN, 65536, 0, -65536, NaN, 0, 0, 0, 0x40000000], // read as 0 those two would make a turn
      [Infinity, 65536, 0, -65536, 0, 0, 0, 0, 0x40000000],
    ])
      same(orientationOf(bad as never), UPRIGHT);
  });

  it("shows a matrix that is neither a turn nor a mirror as stored", () => {
    // Flattening (rank 1) and shearing matrices: a lookup built from them would smear the picture.
    for (const odd of [
      [0, 0, 0, 65536, 65536, 0, 0, 0, 0x40000000],
      [65536, 65536, 0, 0, 0, 0, 0, 0, 0x40000000],
      [65536, 0, 0, 65536, 65536, 0, 0, 0, 0x40000000],
      [-65536, 0, 0, 65536, 65536, 0, 0, 0, 0x40000000], // a shear with a mirror in it: still no mirror
      [0, 65536, 0, 65536, 65536, 0, 0, 0, 0x40000000],
    ])
      same(orientationOf(odd), UPRIGHT);
  });

  it("always answers one of the 8 turns and mirrors, whatever the matrices hold", () => {
    const int32 = fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 });
    const matrix = fc.array(fc.oneof(int32, fc.constantFrom(0, 65536, -65536)), {
      minLength: 9,
      maxLength: 9,
    });
    fc.assert(
      fc.property(matrix, matrix, (t, m) => {
        const [a, b, c, d] = orientationOf(t, m).m;
        const perm =
          (a !== 0 && d !== 0 && b === 0 && c === 0) || (a === 0 && d === 0 && b !== 0 && c !== 0);
        expect(perm).toBe(true);
        expect([a, b, c, d].every((x) => x === 0 || x === 1 || x === -1)).toBe(true);
      }),
    );
  });

  it("a turn in the movie header alone still applies when the track's matrix is unreadable", () => {
    same(orientationOf(undefined, turned(90)), orientationOf(turned(90)));
    expect(orientationOf(undefined, turned(90)).swap).toBe(true);
  });

  it("a file without a movie header is read from its track alone", () => {
    const portrait = { matrix: Int32Array.from(turned(270)) };
    same(mp4Orientation({}, portrait), orientationOf(turned(270)));
    same(mp4Orientation({ moov: {} }, portrait), orientationOf(turned(270)));
    same(mp4Orientation({ moov: { mvhd: {} } }, portrait), orientationOf(turned(270)));
  });

  it("swaps the shown size exactly when it turns a quarter", () => {
    fc.assert(
      fc.property(
        base,
        fc.integer({ min: 1, max: 9999 }),
        fc.integer({ min: 1, max: 9999 }),
        (m, w, h) => {
          const o = orientationOf(m);
          expect(displaySize({ w, h }, o)).toEqual(o.swap ? { w: h, h: w } : { w, h });
        },
      ),
    );
  });
});
