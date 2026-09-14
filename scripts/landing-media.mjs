// Prepare landing-page video assets from the demo folder.
//
// Two encodes per hero film: a SILENT ~12s loop that autoplays in the hero (small, so the
// page paints fast) and the full film with audio, fetched only when someone asks for it.
// The source files are 9-48 MB each; shipping them directly makes the page unusable on
// mobile data.
//
//   node scripts/landing-media.mjs            # skips anything already built
//   node scripts/landing-media.mjs --force

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, readdirSync } from "node:fs";
import path from "node:path";

// Source clips for the landing reels. Set ARTDADDY_DEMO_DIR; this was a hardcoded home directory,
// so the script only ran on one machine.
const SRC = process.env.ARTDADDY_DEMO_DIR ?? "";
if (!SRC) {
  console.error("set ARTDADDY_DEMO_DIR to the folder holding the demo source clips");
  process.exit(2);
}
const OUT = path.join(process.cwd(), "landing", "assets", "video");
const BIN = path.join(process.cwd(), "src-tauri", "binaries");
const FF = path.join(BIN, "ffmpeg-x86_64-pc-windows-msvc.exe");
const FP = path.join(BIN, "ffprobe-x86_64-pc-windows-msvc.exe");
const FORCE = process.argv.includes("--force");

// Screen recordings carry small UI text, so they get a lower CRF than the cinematic
// pieces even though they compress better — legibility is the whole point of showing them.
const HERO = [
  { src: "artdaddy-wild-film.mp4", slug: "wild", label: "Wildlife film" },
  { src: "artdaddy-odyssey-film.mp4", slug: "odyssey", label: "Odyssey trailer" },
  { src: "artdaddy-podcast-film.mp4", slug: "podcast", label: "Podcast clip" },
  { src: "artdaddy-launch-film.mp4", slug: "launch", label: "Launch film" },
];

const REEL = [
  { src: "wild-trailer.mp4", slug: "reel-wild", label: "Wild" },
  { src: "lion-teaser.mp4", slug: "reel-lion", label: "Lion" },
  { src: "odyssey-trailer.mp4", slug: "reel-odyssey", label: "Odyssey" },
  { src: "artdaddy-savannah-film.mp4", slug: "reel-savannah", label: "Savannah" },
  { src: "viral-short.mp4", slug: "reel-vertical", label: "Vertical short", vertical: true },
];

if (!existsSync(FF)) throw new Error(`ffmpeg not staged at ${FF} — run npm run fetch:sidecars`);
mkdirSync(OUT, { recursive: true });

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(2);
const ff = (args) => execFileSync(FF, ["-v", "error", "-y", ...args], { stdio: "pipe" });

function duration(file) {
  const out = execFileSync(FP, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    file,
  ]);
  return parseFloat(String(out).trim());
}

const H264 = ["-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-pix_fmt", "yuv420p"];
// faststart moves the moov atom to the front; without it the browser must download the whole
// file before the first frame, which defeats the point of compressing at all.
const WEB = ["-movflags", "+faststart"];

let built = 0;
let skipped = 0;

function encode(label, out, args) {
  if (existsSync(out) && !FORCE) {
    console.log(`  skip   ${path.basename(out)} (${mb(out)} MB)`);
    skipped++;
    return;
  }
  ff(args);
  console.log(`  ${label.padEnd(6)} ${path.basename(out).padEnd(26)} ${mb(out).padStart(6)} MB`);
  built++;
}

console.log("HERO — silent loop + full film\n");
for (const f of HERO) {
  const src = path.join(SRC, f.src);
  if (!existsSync(src)) {
    console.log(`  MISSING ${f.src}`);
    continue;
  }
  const d = duration(src);
  const start = Math.max(0, d * 0.35);

  const loop = path.join(OUT, `${f.slug}-loop.mp4`);
  encode("loop", loop, [
    "-ss",
    start.toFixed(2),
    "-t",
    "12",
    "-i",
    src,
    "-vf",
    "scale=1280:-2:flags=lanczos",
    ...H264,
    "-crf",
    "30",
    "-an",
    ...WEB,
    loop,
  ]);

  const full = path.join(OUT, `${f.slug}.mp4`);
  encode("full", full, [
    "-i",
    src,
    "-vf",
    "scale=1280:-2:flags=lanczos",
    ...H264,
    "-crf",
    "28",
    "-c:a",
    "aac",
    "-b:a",
    "112k",
    ...WEB,
    full,
  ]);

  const poster = path.join(OUT, `${f.slug}.jpg`);
  encode("poster", poster, [
    "-ss",
    start.toFixed(2),
    "-i",
    src,
    "-frames:v",
    "1",
    "-vf",
    "scale=1280:-2:flags=lanczos",
    "-q:v",
    "4",
    poster,
  ]);
}

console.log("\nSHOWREEL — finished films\n");
for (const f of REEL) {
  const src = path.join(SRC, f.src);
  if (!existsSync(src)) {
    console.log(`  MISSING ${f.src}`);
    continue;
  }
  const d = duration(src);
  const scale = f.vertical ? "scale=-2:1280:flags=lanczos" : "scale=1280:-2:flags=lanczos";

  const full = path.join(OUT, `${f.slug}.mp4`);
  encode("full", full, [
    "-i",
    src,
    "-vf",
    scale,
    ...H264,
    "-crf",
    "26",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    ...WEB,
    full,
  ]);

  const poster = path.join(OUT, `${f.slug}.jpg`);
  encode("poster", poster, [
    "-ss",
    (d * 0.4).toFixed(2),
    "-i",
    src,
    "-frames:v",
    "1",
    "-vf",
    scale,
    "-q:v",
    "4",
    poster,
  ]);
}

const total = readdirSync(OUT).reduce((n, f) => n + statSync(path.join(OUT, f)).size, 0);
console.log(`\nbuilt ${built}, skipped ${skipped}`);
console.log(`total in landing/assets/video: ${(total / 1024 / 1024).toFixed(1)} MB`);
console.log(`first paint cost: ${mb(path.join(OUT, "wild-loop.mp4"))} MB (hero loop only)`);
