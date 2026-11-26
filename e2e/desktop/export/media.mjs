// What the export lane knows about media: the fixtures it makes and the checks it runs on a delivered file.
// Everything runs the ffmpeg and ffprobe the app ships (src-tauri/binaries), on this PC, and sends nothing
// anywhere.
//
// A delivered file is judged the way the person would judge it: its streams, its length, and pictures
// decoded from it at known moments (the fixtures are solid colours, so each moment has one right colour).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { root } from "./app.mjs";

const TRIPLE = "x86_64-pc-windows-msvc";

function tool(name) {
  const shipped = path.join(root, "src-tauri", "binaries", `artdaddy-${name}-${TRIPLE}.exe`);
  if (existsSync(shipped)) return shipped;
  throw new Error(`no shipped ${name} at ${shipped}: copy src-tauri/binaries from a built checkout or run npm run sidecars`);
}
export const ffmpeg = () => tool("ffmpeg");
export const ffprobe = () => tool("ffprobe");

function run(bin, args, { input, maxBuffer = 256 * 1024 * 1024 } = {}) {
  const r = spawnSync(bin, args, { input, maxBuffer, windowsHide: true });
  if (r.status !== 0)
    throw new Error(`${path.basename(bin)} ${args.slice(0, 6).join(" ")}… exited ${r.status}: ${String(r.stderr).slice(-600)}`);
  return r.stdout;
}

/** The colours the fixtures are made of, as the 8-bit RGB a decoder gives back for each. */
export const COLOURS = {
  red: { lavfi: "0xE02020", rgb: [224, 32, 32] },
  blue: { lavfi: "0x2040E0", rgb: [32, 64, 224] },
  green: { lavfi: "0x20C040", rgb: [32, 192, 64] },
};

/** A solid-colour clip with a tone, `seconds` long. Made once per run folder and reused. */
export function colourClip(dir, { colour, seconds, width = 1920, height = 1080, fps = 30, tone = 440 }) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${colour}_${width}x${height}_${fps}_${seconds}s.mp4`);
  if (existsSync(file) && statSync(file).size > 0) return file;
  run(ffmpeg(), [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `color=c=${COLOURS[colour].lavfi}:s=${width}x${height}:r=${fps}:d=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=${tone}:sample_rate=48000:duration=${seconds}`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-g", String(fps),
    "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", file,
  ]);
  return file;
}

/** A busy picture (a moving test pattern under light grain) with a tone: slow enough to encode that an export of
 *  it runs for a while, which a cancel, a queue or a time-left reading needs, without the encoder spending a
 *  camera's worth of bits on pure noise (strong grain made a 12 s export 296 MB). */
export function busyClip(dir, { seconds, width = 1920, height = 1080, fps = 30 }) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `busy-n4_${width}x${height}_${fps}_${seconds}s.mp4`);
  if (existsSync(file) && statSync(file).size > 0) return file;
  run(ffmpeg(), [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=s=${width}x${height}:r=${fps}:d=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=523:sample_rate=48000:duration=${seconds}`,
    "-vf", "noise=alls=4:allf=t",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p", "-g", String(fps),
    "-c:a", "aac", "-b:a", "128k", "-shortest", file,
  ]);
  return file;
}

/** What ffprobe says about a file: its streams, its length and the video's size and rate. */
export function probe(file) {
  const out = JSON.parse(
    String(run(ffprobe(), ["-v", "error", "-show_streams", "-show_format", "-of", "json", file])),
  );
  const video = out.streams.find((s) => s.codec_type === "video");
  const audio = out.streams.find((s) => s.codec_type === "audio");
  const rate = (r) => {
    const [n, d] = String(r ?? "0/1").split("/").map(Number);
    return d ? n / d : 0;
  };
  return {
    duration: Number(out.format?.duration ?? 0),
    size: Number(out.format?.size ?? 0),
    video: video
      ? { codec: video.codec_name, width: video.width, height: video.height, fps: rate(video.avg_frame_rate), pixFmt: video.pix_fmt }
      : null,
    audio: audio ? { codec: audio.codec_name, rate: Number(audio.sample_rate), channels: audio.channels } : null,
    streams: out.streams.map((s) => s.codec_type),
  };
}

/** The mean colour of the picture at `seconds`, decoded from the file (16x16 average, so a watermark in a
 *  corner moves it by a few levels at most). */
export function colourAt(file, seconds) {
  const raw = run(ffmpeg(), [
    "-hide_banner", "-loglevel", "error", "-ss", String(seconds), "-i", file,
    "-frames:v", "1", "-vf", "scale=16:16:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ]);
  if (raw.length < 16 * 16 * 3) throw new Error(`no picture decoded at ${seconds}s of ${file}`);
  const sum = [0, 0, 0];
  for (let i = 0; i < 16 * 16 * 3; i += 3) for (let c = 0; c < 3; c++) sum[c] += raw[i + c];
  return sum.map((s) => Math.round(s / 256));
}

/** Is `rgb` the fixture colour `name` (within the tolerance an x264 round trip and a corner watermark leave)? */
export function isColour(rgb, name, tolerance = 40) {
  const want = COLOURS[name].rgb;
  return rgb.every((v, i) => Math.abs(v - want[i]) <= tolerance);
}

/** Decode every frame of the file and say whether ffmpeg met an error doing so. */
export function decodesCleanly(file) {
  const r = spawnSync(ffmpeg(), ["-v", "error", "-i", file, "-f", "null", "-"], { encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0 && !r.stderr.trim(), errors: r.stderr.trim().slice(0, 600) };
}

/** The hidden partials an export stages beside its destination (`.<name>.<rand>.partial`). */
export function partialsIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => /^\..+\.[a-z0-9]{1,8}\.partial$/i.test(n));
}

export function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

/** The end card's length for a picture of this shape, as the export will add it (resources/brand). */
export function endCardSeconds(width, height) {
  const ratio = width === height ? "1x1" : width > height ? "16x9" : "9x16";
  return probe(path.join(root, "src-tauri", "resources", "brand", `endcard-${ratio}.mp4`)).duration;
}
