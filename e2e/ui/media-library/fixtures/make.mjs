// Makes the media the media-library and preview QA specs import, with the shipped ffmpeg, so each
// file is what a real encoder writes and never bytes drawn by hand (test-authoring rule 9).
//
//   node e2e/ui/media-library/fixtures/make.mjs
//
// It needs src-tauri/binaries (`node scripts/fetch-sidecars.mjs --only ffmpeg,ffprobe`). The outputs are committed:
// run it again only to change a fixture, and say why in the commit.
//
//   rgb_3s.mp4       3 s, 160x90, 30 fps, H.264 Constrained Baseline: red for the first second, green for the second,
//                    blue for the third (one colour per second, so a picture says which second is on screen), with a
//                    440 Hz tone in AAC. A keyframe every second.
//   rgb_3s.hevc.mp4  the same picture in HEVC (hvc1), no sound: the kind of file the preview needs a copy of.
//   tone_2s.wav      2 s of 440 Hz, mono, 8 kHz.
//   orange.png       a 64x36 picture, all orange.
//   no_index.mp4     what a recorder that died mid-write leaves: an ftyp box, then an mdat box whose size is 0 ("runs
//                    to the end of the file") and no index after it. ffmpeg cannot open it either.
//   notes.pdf        a document the app does not import.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "media");
const root = path.resolve(here, "../../../..");

function triple() {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  return `${arch}-unknown-linux-gnu`;
}
const ffmpeg = path.join(
  root,
  "src-tauri",
  "binaries",
  `ffmpeg-${triple()}${process.platform === "win32" ? ".exe" : ""}`,
);
if (!existsSync(ffmpeg)) throw new Error(`no ffmpeg at ${ffmpeg}: stage the sidecars first`);
mkdirSync(out, { recursive: true });

const run = (args) =>
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });

const colours = ["red", "lime", "blue"];
const pictureInputs = colours.flatMap((c) => [
  "-f",
  "lavfi",
  "-i",
  `color=c=${c}:s=160x90:r=30:d=1`,
]);
const concat = `${colours.map((_, i) => `[${i}:v]`).join("")}concat=n=${colours.length}:v=1:a=0[v]`;

run([
  ...pictureInputs,
  ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=3"],
  ...["-filter_complex", concat, "-map", "[v]", "-map", "3:a"],
  ...["-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-g", "30", "-crf", "30"],
  ...["-c:a", "aac", "-b:a", "48k", "-ac", "1", "-shortest", "-movflags", "+faststart"],
  path.join(out, "rgb_3s.mp4"),
]);

run([
  ...pictureInputs,
  ...["-filter_complex", concat, "-map", "[v]"],
  ...[
    "-c:v",
    "libx265",
    "-tag:v",
    "hvc1",
    "-pix_fmt",
    "yuv420p",
    "-x265-params",
    "log-level=error",
  ],
  ...["-crf", "32", "-g", "30", "-movflags", "+faststart"],
  path.join(out, "rgb_3s.hevc.mp4"),
]);

run([
  ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000:duration=2"],
  ...["-c:a", "pcm_s16le", "-ac", "1"],
  path.join(out, "tone_2s.wav"),
]);

run([
  ...["-f", "lavfi", "-i", "color=c=orange:s=64x36", "-frames:v", "1"],
  path.join(out, "orange.png"),
]);

// ftyp (24 bytes: major brand isom, minor version 0x200, compatible brands isom and iso2), then an mdat of size 0.
const ftyp = Buffer.alloc(24);
ftyp.writeUInt32BE(24, 0);
ftyp.write("ftyp", 4, "ascii");
ftyp.write("isom", 8, "ascii");
ftyp.writeUInt32BE(0x200, 12);
ftyp.write("isomiso2", 16, "ascii");
const mdat = Buffer.alloc(8);
mdat.writeUInt32BE(0, 0);
mdat.write("mdat", 4, "ascii");
writeFileSync(
  path.join(out, "no_index.mp4"),
  Buffer.concat([ftyp, mdat, Buffer.alloc(4096, 0x5a)]),
);

writeFileSync(
  path.join(out, "notes.pdf"),
  "%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n",
);
console.log(`fixtures written to ${out}`);
