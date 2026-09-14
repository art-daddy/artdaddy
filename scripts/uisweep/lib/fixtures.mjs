// Deterministic fixture media for the UI sweep, generated with the BUNDLED ffmpeg so
// the rails a test asserts against (exact frame counts, exact pixel sizes) are known
// rather than probed. Regenerated only when missing — ffmpeg is slow enough to notice.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const BIN = path.join(ROOT, "src-tauri", "binaries");

function sidecar(name) {
  const hit = readdirSync(BIN).find((f) => f.startsWith(name) && /\.exe$/i.test(f));
  if (!hit) throw new Error(`${name} sidecar not found in ${BIN} — run npm run sidecars`);
  return path.join(BIN, hit);
}

/** Every fixture states the property that makes it worth having. */
export const FIXTURES = {
  // 300 frames exactly: the tail rail for a trim is a round number.
  "bars10s.mp4": (ff, out) =>
    run(ff, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=1920x1080:rate=30:duration=10",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=10",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      out,
    ]),
  // 90 frames: a short neighbour, so a ripple has something to push.
  "bars3s.mp4": (ff, out) =>
    run(ff, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=1920x1080:rate=30:duration=3",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      out,
    ]),
  // 726x612 into a 1080x1920 canvas — the exact aspect that exposed the letterbox bug.
  "still.png": (ff, out) =>
    run(ff, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=726x612:rate=1:duration=1",
      "-frames:v",
      "1",
      out,
    ]),
  // Audio only, 150 frames of timeline at 30fps.
  "tone5s.m4a": (ff, out) =>
    run(ff, ["-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=5", "-c:a", "aac", out]),
};

function run(ff, args) {
  execFileSync(ff, args, { stdio: "pipe" });
}

/** Absolute paths of every fixture, generating any that are missing. */
export function ensureFixtures(dir = path.join(ROOT, "reports", "uisweep", "media")) {
  mkdirSync(dir, { recursive: true });
  const ff = sidecar("ffmpeg");
  const out = {};
  for (const [name, make] of Object.entries(FIXTURES)) {
    const p = path.join(dir, name);
    if (!existsSync(p)) make(ff, p);
    out[name] = p;
  }
  return out;
}

/** Real duration in frames, straight from ffprobe — the oracle a rail assertion needs. */
export function durationFrames(file, fps = 30) {
  const probe = sidecar("ffprobe");
  const s = execFileSync(probe, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    file,
  ])
    .toString()
    .trim();
  return Math.round(parseFloat(s) * fps);
}
