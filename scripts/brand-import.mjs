#!/usr/bin/env node
// Turn a FLAT artwork export into the cut-out master that brand-assets.mjs expects.
//
//   node scripts/brand-import.mjs <artwork.png> [--out brand/artdaddy-mark.png]
//
// The source is the logo as drawn: dark artwork on a light background, with the light
// areas inside the face painted rather than cut. Keying on luminance turns BOTH the
// background and those face markings into transparency in one pass, which is exactly the
// cut-out a watermark needs — the alternative, keying only the outer background, leaves a
// white-filled face that becomes a solid block the moment it is recoloured white.
//
// Alpha is a RAMP, not a threshold, so antialiased edges survive being rescaled to 32px.
//
// The wordmark is dropped here rather than cropped by hand: rows carrying ink are grouped
// into bands, and only the FIRST band (the mark) is kept, so re-running against a differently
// sized export still lands on the lion.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// Luma below OPAQUE is artwork, above CLEAR is background; between is the antialiased edge.
const OPAQUE = 95;
const CLEAR = 205;
const MARGIN = 0.07; // padding around the mark, as a fraction of its longest side

function staged(prefix, fallback) {
  const dir = join(root, "src-tauri", "binaries");
  const hit = existsSync(dir) && readdirSync(dir).find((n) => n.startsWith(prefix));
  return hit ? join(dir, hit) : fallback;
}
const ffmpeg = () => staged("ffmpeg-", "ffmpeg");
const ffprobe = () => staged("ffprobe-", "ffprobe");

function probe(file) {
  const out = execFileSync(
    ffprobe(),
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file],
    { encoding: "utf8" },
  );
  const [w, h] = out.trim().split(",").map(Number);
  if (!w || !h) throw new Error(`${file}: not a decodable image (reported ${w}x${h})`);
  return { w, h };
}

const args = process.argv.slice(2);
const src = resolve(args[0] ?? "");
const outIdx = args.indexOf("--out");
const out = resolve(outIdx >= 0 ? args[outIdx + 1] : join(root, "brand", "artdaddy-mark.png"));

if (!src || !existsSync(src)) {
  console.error("[import] usage: node scripts/brand-import.mjs <artwork.png> [--out master.png]");
  process.exit(1);
}

const { w, h } = probe(src);
const px = execFileSync(
  ffmpeg(),
  ["-v", "error", "-i", src, "-f", "rawvideo", "-pix_fmt", "rgba", "-frames:v", "1", "-"],
  { maxBuffer: w * h * 4 + 1024 },
);

/** Per-pixel alpha from luminance, 0 = background, 255 = artwork. */
const alpha = new Uint8Array(w * h);
for (let i = 0, p = 0; p < w * h; i += 4, p++) {
  const luma = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  const a = luma <= OPAQUE ? 1 : luma >= CLEAR ? 0 : (CLEAR - luma) / (CLEAR - OPAQUE);
  alpha[p] = Math.round(a * 255);
}

// Group rows carrying real ink into bands. A few stray pixels (grid lines that survived the
// ramp, JPEG noise) must not bridge the gap between the mark and the wordmark.
const MIN_INK = Math.max(2, Math.round(w * 0.004));
const inked = [];
for (let y = 0; y < h; y++) {
  let n = 0;
  for (let x = 0; x < w; x++) if (alpha[y * w + x] > 128) n++;
  inked.push(n >= MIN_INK);
}
const bands = [];
for (let y = 0; y < h; y++) {
  if (!inked[y]) continue;
  const last = bands[bands.length - 1];
  if (last && y - last.y1 <= 2) last.y1 = y;
  else bands.push({ y0: y, y1: y });
}
if (!bands.length) throw new Error("no artwork found — is the source light-on-dark?");
console.log(`[import] ${w}x${h}, ${bands.length} band(s): ${bands.map((b) => `${b.y0}-${b.y1}`).join(", ")}`);

const mark = bands[0];
if (bands.length > 1) console.log(`[import] keeping the first band as the mark; dropping ${bands.length - 1} below it`);

let x0 = w;
let x1 = 0;
for (let y = mark.y0; y <= mark.y1; y++) {
  for (let x = 0; x < w; x++) {
    if (alpha[y * w + x] > 128) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
    }
  }
}
const bw = x1 - x0 + 1;
const bh = mark.y1 - mark.y0 + 1;
const side = Math.round(Math.max(bw, bh) * (1 + MARGIN * 2));
console.log(`[import] mark bbox ${bw}x${bh} -> square canvas ${side}`);

// Centre the mark on a square, transparent canvas so the icon generator has no work to do.
const canvas = Buffer.alloc(side * side * 4, 0);
const offX = Math.round((side - bw) / 2);
const offY = Math.round((side - bh) / 2);
for (let y = 0; y < bh; y++) {
  for (let x = 0; x < bw; x++) {
    const a = alpha[(mark.y0 + y) * w + (x0 + x)];
    if (!a) continue;
    const d = ((offY + y) * side + (offX + x)) * 4;
    // RGB is irrelevant here — brand-assets.mjs replaces it per colourway. Alpha is the art.
    canvas[d] = 0xc9;
    canvas[d + 1] = 0x8a;
    canvas[d + 2] = 0x3e;
    canvas[d + 3] = a;
  }
}

// The source is often a screenshot rather than a vector export, so the mark can land well
// under icon size. Resampling the ALPHA of a flat two-tone shape upscales cleanly, but it
// invents no detail — say the real number so a soft icon is a known trade, not a surprise.
const TARGET = 1024;
if (side < TARGET) console.log(`[import] upscaling ${side} -> ${TARGET}; source detail is limited to ${side}px`);
const outSize = Math.max(side, TARGET);

execFileSync(
  ffmpeg(),
  [
    "-v", "error", "-y",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${side}x${side}`, "-i", "-",
    "-vf", `scale=${outSize}:${outSize}:flags=lanczos`,
    "-frames:v", "1", out,
  ],
  { input: canvas },
);
console.log(`[import] wrote ${out} (${outSize}x${outSize})`);
console.log(`[import] next: node scripts/brand-assets.mjs ${out}`);
