// Writes the rotated-video fixtures the preview is tested with (UJ-015) and what the SHIPPED ffmpeg
// shows for each: e2e/ui/fixtures/rotation/*.mp4 + expected.json. Described in
// src/preview/__rotationFixtures.ts.
//
//   npm run fixtures:rotation
//
// expected.json is not written by hand: it is what ffmpeg decodes, the picture the export, the
// agent's frames and the preview proxy all show. orientation.smoke.e2e.ts re-decodes every fixture
// with the shipped ffmpeg and fails when this file no longer says what ffmpeg shows, and
// e2e/ui/rotation.spec.ts holds the preview to it.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  CORNERS,
  PALETTE,
  ROTATION_FIXTURES,
  type RotationExpected,
  classify,
} from "../src/preview/__rotationFixtures";
import { shippedSidecarPath } from "../src/test/sidecars";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "e2e", "ui", "fixtures", "rotation");
const ff = shippedSidecarPath("ffmpeg");
const W = 160;
const H = 96;

function run(args: string[]): { stdout: Buffer; stderr: string } {
  const r = spawnSync(ff, args, { maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}\n${String(r.stderr)}`);
  return { stdout: r.stdout, stderr: String(r.stderr) };
}

/** The movie header's matrix set to a turn of `deg` counter-clockwise, in the form ffmpeg writes a
 *  track's for -display_rotation (a = cos, b = -sin, c = sin, d = cos; 16.16 fixed point). ffmpeg
 *  has no option for the movie matrix, and real files rarely set it, which is why it is tested. */
function patchMovieMatrix(file: Buffer, deg: number): Buffer {
  const out = Buffer.from(file);
  const at = out.indexOf("mvhd");
  if (at < 0) throw new Error("no mvhd box");
  const version = out[at + 4];
  // type, version+flags, times (v0: 4 x 4 bytes; v1: 8 + 8 + 4 + 8), rate, volume, reserved
  const matrix = at + 4 + 4 + (version === 1 ? 28 : 16) + 4 + 2 + 2 + 8;
  const rad = (deg * Math.PI) / 180;
  const fx = (v: number) => Math.round(v * 65536);
  const m = [
    fx(Math.cos(rad)),
    fx(-Math.sin(rad)),
    0,
    fx(Math.sin(rad)),
    fx(Math.cos(rad)),
    0,
    0,
    0,
    0x40000000,
  ];
  m.forEach((v, i) => out.writeInt32BE(v, matrix + i * 4));
  return out;
}

mkdirSync(outDir, { recursive: true });
const plain = path.join(outDir, "_plain.mp4");
const q = `s=${W / 2}x${H / 2}:r=30:d=0.1`;
run([
  ...["-y", "-v", "error"],
  ...["-f", "lavfi", "-i", `color=c=${PALETTE.red.hex}:${q}`],
  ...["-f", "lavfi", "-i", `color=c=${PALETTE.green.hex}:${q}`],
  ...["-f", "lavfi", "-i", `color=c=${PALETTE.blue.hex}:${q}`],
  ...["-f", "lavfi", "-i", `color=c=${PALETTE.white.hex}:${q}`],
  ...["-filter_complex", "[0][1]hstack[t];[2][3]hstack[b];[t][b]vstack"],
  // The profile phones and WhatsApp write: a decoder that cannot take it here cannot take theirs.
  ...["-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-crf", "12"],
  ...["-frames:v", "2", "-movflags", "+faststart", plain],
]);

const fixtures: RotationExpected["fixtures"] = {};
for (const fx of ROTATION_FIXTURES) {
  const out = path.join(outDir, fx.file);
  const flags = [
    ...(fx.trackRotation ? ["-display_rotation:v:0", String(fx.trackRotation)] : []),
    ...(fx.hflip ? ["-display_hflip:v:0"] : []),
  ];
  run(["-y", "-v", "error", ...flags, "-i", plain, "-c", "copy", "-movflags", "+faststart", out]);
  if (fx.movieRotation) writeFileSync(out, patchMovieMatrix(readFileSync(out), fx.movieRotation));
  // What ffmpeg SHOWS: decoded with its default autorotate, as the export decodes it.
  const size = / s:(\d+)x(\d+)/.exec(
    run(["-v", "info", "-i", out, "-frames:v", "1", "-vf", "showinfo", "-f", "null", "-"]).stderr,
  );
  if (!size) throw new Error(`no decoded size for ${fx.file}`);
  const [dw, dh] = [Number(size[1]), Number(size[2])];
  const rgb = run([
    "-v",
    "error",
    "-i",
    out,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ]).stdout;
  if (rgb.length !== dw * dh * 3)
    throw new Error(`${fx.file}: ${rgb.length} bytes for ${dw}x${dh}`);
  const corners = CORNERS.map(([cx, cy]) => {
    const i = (Math.floor(cy * dh) * dw + Math.floor(cx * dw)) * 3;
    return classify([rgb[i], rgb[i + 1], rgb[i + 2]]);
  });
  fixtures[fx.file] = {
    coded: [W, H],
    display: [dw, dh],
    corners: corners as RotationExpected["fixtures"][string]["corners"],
  };
}
rmSync(plain);

const version = String(spawnSync(ff, ["-version"]).stdout)
  .split("\n")[0]
  .trim();
const expected: RotationExpected = { ffmpeg: version, fixtures };
writeFileSync(path.join(outDir, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`);
console.log(`wrote ${Object.keys(fixtures).length} fixtures to ${outDir} (${version})`);
