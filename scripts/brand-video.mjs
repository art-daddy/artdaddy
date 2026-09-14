#!/usr/bin/env node
// End card + watermark, rendered from the brand tokens.
//
//   npm run brand:video            # the assets
//   npm run brand:video -- --demo  # ...plus a demo reel with both applied
//
// Outputs to brand/video/:
//   watermark-<ratio>.png       transparent corner bug, burned over the whole video
//   endcard-<ratio>.mp4         2.0s animation for the tail
//   endcard-<ratio>-still.png   its settled frame
//
// Colours come from src/brand.json, so a palette change moves these too instead of leaving a
// second, older brand living in a video file nobody re-renders.
//
// Both surfaces draw the BADGE — an amber plate with the lion knocked out of it — not the bare
// mark. The bare mark is line art whose face reads as gaps; small, it collapses into a smudge
// that nobody reads as a lion. The app icon already learned this (brand-assets.mjs appIcon,
// "unrecognisable as a lion at 32px") and the fix never reached here. The plate is opaque, so
// it survives arbitrary footage on its own — the old pure-white rule existed because a bare
// amber mark vanished into warm frames, and a plate does not.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = join(root, "brand", "video");
const framesDir = join(outDir, "_frames");

const cfg = JSON.parse(readFileSync(join(root, "src", "brand.json"), "utf8"));
const WORD = cfg.brand.displayName.toUpperCase();
// The card reads WORD + SUFFIX, so the domain has to come from the tokens too. Held as a
// literal here it became a second, older brand living in a video nobody re-renders: every
// export shipped ".in" for months after that domain stopped resolving.
const SUFFIX = cfg.brand.site.slice(cfg.brand.site.indexOf("."));
if (cfg.brand.site.slice(0, cfg.brand.site.indexOf(".")).toUpperCase() !== WORD) {
  throw new Error(`brand.site "${cfg.brand.site}" does not start with the wordmark "${WORD}"`);
}

const C = { bg: "#0F0F11", raised: "#1F1F24", brand: "#C98A3E", ink: "#F5F3F0", dim: "#A3A0A0" };

const FPS = 30;
const DUR = 2.0;
// `hMul` scales the bug against frame height. 16:9 is a wide, short frame, so a
// height-derived bug reads much smaller there than on vertical; 9:16 needs no boost.
const SIZES = [
  { id: "16x9", w: 1920, h: 1080, edgePct: 0.025, hMul: 2.25 },
  { id: "1x1", w: 1080, h: 1080, edgePct: 0.025, hMul: 1.5 },
  { id: "9x16", w: 1080, h: 1920, edgePct: 0.05, hMul: 1 },
];

function staged(prefix, fallback) {
  const dir = join(root, "src-tauri", "binaries");
  const hit = existsSync(dir) && readdirSync(dir).find((n) => n.startsWith(prefix));
  return hit ? join(dir, hit) : fallback;
}
const ffmpeg = () => staged("ffmpeg-", "ffmpeg");
const run = (args, opts = {}) => execFileSync(ffmpeg(), ["-v", "error", "-y", ...args], opts);

const b64 = (p) => readFileSync(p).toString("base64");
const MARK = b64(join(root, "brand", "artdaddy-mark-white.png"));
const FONT = b64(join(root, "src-tauri", "resources", "fonts", "Anton-Regular.ttf"));

/** Everything below runs INSIDE the page: canvas gives exact pixel dimensions, where a DOM
 *  screenshot would be at the mercy of layout rounding at three aspect ratios. */
const PAGE = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:#000}
@font-face{font-family:Wordmark;src:url(data:font/ttf;base64,${FONT}) format("truetype")}
</style><canvas id="c"></canvas><script>
const C = ${JSON.stringify(C)};
const WORD = ${JSON.stringify(WORD)}, SUFFIX = ${JSON.stringify(SUFFIX)};
const INSET = 0.05;

const markImg = new Image();
const markReady = new Promise((r) => { markImg.onload = () => r(true); markImg.src = "data:image/png;base64,${MARK}"; });

const tintCache = new Map();
// The mark is white-on-transparent, so 'source-in' recolours it while LEAVING the cut-out
// holes transparent. Painting a rect behind it would flatten the face into a silhouette.
function tinted(color) {
  if (tintCache.has(color)) return tintCache.get(color);
  const c = document.createElement("canvas");
  c.width = markImg.width; c.height = markImg.height;
  const x = c.getContext("2d");
  x.drawImage(markImg, 0, 0);
  x.globalCompositeOperation = "source-in";
  x.fillStyle = color;
  x.fillRect(0, 0, c.width, c.height);
  tintCache.set(color, c);
  return c;
}

// The BADGE: an amber plate with the lion knocked out of it in the app's background colour —
// identical figure/ground to the app icon (brand-assets.mjs appIcon). The bare mark is line
// art whose face reads as gaps, so small it collapses into a smudge; the icon learned that at
// 32px and the lesson never reached the watermark, the end card or the site. Drawing the mark
// dark ON TOP of the plate leaves the face amber, which is what makes it read as a lion.
const BADGE_RADIUS = 0.224; // macOS icon curvature, same as the app icon
const BADGE_LION = 0.92;
function drawBadge(ctx, x, y, size) {
  const r = size * BADGE_RADIUS;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + size, y, x + size, y + size, r);
  ctx.arcTo(x + size, y + size, x, y + size, r);
  ctx.arcTo(x, y + size, x, y, r);
  ctx.arcTo(x, y, x + size, y, r);
  ctx.closePath();
  ctx.fillStyle = C.brand;
  ctx.fill();
  const lion = tinted(C.bg);
  const lh = size * BADGE_LION;
  const lw = lh * (lion.width / lion.height);
  ctx.drawImage(lion, x + (size - lw) / 2, y + (size - lh) / 2, lw, lh);
  ctx.restore();
}

const easeOut = (x) => 1 - Math.pow(1 - x, 3);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const seg = (t, from, to) => easeOut(clamp01((t - from) / (to - from)));

/** Bottom-right corner bug. Also baked as a standalone transparent PNG, so it must assume
 *  nothing about what sits underneath. */
function drawWatermark(ctx, s, opacity, hPct) {
  const { w, h } = s;
  const H = hPct * (s.hMul || 1) * h;
  const gap = H * 0.075;
  // The badge is square, so its width is its height — no aspect lookup.
  const lw = H;

  // Assembled at FULL strength offscreen, then faded ONCE. Fading the passes individually
  // lets the dark halo show through the white ink and the bug comes out grey on every
  // background - which is what happened when this drew straight onto the frame.
  const off = document.createElement("canvas");
  off.width = w; off.height = h;
  const o = off.getContext("2d");
  o.font = H * 0.92 + "px Wordmark, Impact, sans-serif";
  o.letterSpacing = H * 0.02 + "px";
  o.textBaseline = "middle";
  o.textAlign = "left";
  const m = o.measureText(WORD);
  const tw = m.width;
  const x = w * (1 - INSET) - (lw + gap + tw);
  const yMid = h * (1 - s.edgePct) - H / 2;
  const textY = yMid + H * 0.055;
  // All-caps Anton sits well above the "middle" baseline, so centring the mark on the draw y
  // left it low against the word. Centre it on the text's real ink box instead.
  const logoY = textY + (m.actualBoundingBoxDescent - m.actualBoundingBoxAscent) / 2;

  // A blurred dark spill under BOTH the badge and the word. The badge is opaque so it no
  // longer needs an outline to survive a blown-out frame, but the white wordmark still does.
  o.shadowColor = "rgba(0,0,0,.9)";
  o.shadowBlur = H * 0.3;
  o.shadowOffsetY = H * 0.05;
  o.fillStyle = "#000000";
  o.fillText(WORD, x + lw + gap, textY);
  o.fillText(WORD, x + lw + gap, textY);
  drawBadge(o, x, logoY - H / 2, H);
  o.shadowColor = "transparent"; o.shadowBlur = 0; o.shadowOffsetY = 0;

  drawBadge(o, x, logoY - H / 2, H);
  o.fillStyle = "#ffffff";
  o.fillText(WORD, x + lw + gap, textY);

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.drawImage(off, 0, 0);
  ctx.restore();
}

function drawEndCard(ctx, s, t) {
  const { w, h } = s;
  const u = Math.min(w, h) / 1080;

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, w, h);
  // A warm lift off-centre, so the card is not a flat black rectangle. Kept inside the
  // palette: it fades bg -> raised, never toward the blue it used to be.
  const g = ctx.createRadialGradient(w * 0.5, h * 0.46, 0, w * 0.5, h * 0.46, Math.max(w, h) * 0.72);
  g.addColorStop(0, C.raised);
  g.addColorStop(1, C.bg);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  const cy = h * 0.5;
  const logoH = 190 * u;
  const lw = logoH; // the badge is square
  const gap = logoH * 0.065;

  const bigPx = Math.round(126 * u);
  const smallPx = Math.round(30 * u);
  const sufPx = Math.round(bigPx * 0.34);
  const capH = bigPx * 0.73;

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = bigPx + "px Wordmark, Impact, sans-serif";
  ctx.letterSpacing = 0.02 * bigPx + "px";
  const mBig = ctx.measureText(WORD);
  const wordW = mBig.width;
  ctx.font = sufPx + "px Wordmark, Impact, sans-serif";
  ctx.letterSpacing = 0.02 * sufPx + "px";
  const sufW = ctx.measureText(SUFFIX).width;
  ctx.font = smallPx + "px Wordmark, Impact, sans-serif";
  ctx.letterSpacing = 0.38 * smallPx + "px";
  const mSmall = ctx.measureText("MADE WITH");

  // actualBoundingBoxLeft is positive-to-the-LEFT, so the ink starts at origin - value and
  // the origin must be textX + value. Subtracting it doubled the error instead of cancelling
  // it, and because "MADE WITH" is tracked 0.38em against the wordmark's 0.02em, the M landed
  // visibly right of the A.
  const inkBig = mBig.actualBoundingBoxLeft, inkSmall = mSmall.actualBoundingBoxLeft;
  const blockW = Math.max(wordW + sufW, mSmall.width);
  const x0 = (w - (lw + gap + blockW)) / 2;
  const textX = x0 + lw + gap;
  const baseY = cy + capH / 2;
  const madeY = baseY - capH - 38 * u;

  // The block has a line ABOVE the wordmark and nothing below it, so its ink centre sits above
  // cy. Centring the mark on cy left it hanging low against the text.
  const blockMid = (madeY - mSmall.actualBoundingBoxAscent + baseY + mBig.actualBoundingBoxDescent) / 2;

  const a1 = seg(t, 0.0, 0.55);
  ctx.save();
  ctx.globalAlpha = a1;
  const rise = (1 - a1) * 26 * u;
  drawBadge(ctx, x0, blockMid - logoH / 2 + rise, logoH);
  ctx.restore();

  const a2 = seg(t, 0.3, 0.78);
  ctx.save();
  ctx.globalAlpha = a2 * 0.85;
  ctx.fillStyle = C.dim;
  ctx.font = smallPx + "px Wordmark, Impact, sans-serif";
  ctx.letterSpacing = 0.38 * smallPx + "px";
  ctx.fillText("MADE WITH", textX + inkSmall, madeY);
  ctx.restore();

  const a3 = seg(t, 0.42, 0.95);
  ctx.save();
  ctx.globalAlpha = a3;
  ctx.translate(0, (1 - a3) * 14 * u);
  ctx.fillStyle = C.ink;
  ctx.font = bigPx + "px Wordmark, Impact, sans-serif";
  ctx.letterSpacing = 0.02 * bigPx + "px";
  ctx.fillText(WORD, textX + inkBig, baseY);
  // The single amber moment on the card.
  ctx.fillStyle = C.brand;
  ctx.font = sufPx + "px Wordmark, Impact, sans-serif";
  ctx.letterSpacing = 0.02 * sufPx + "px";
  ctx.fillText(SUFFIX, textX + inkBig + wordW, baseY);
  ctx.restore();
  ctx.letterSpacing = "0px";
}

window.shoot = async (s, kind, t, opacity, hPct) => {
  await markReady;
  await document.fonts.load("100px Wordmark");
  if (!document.fonts.check("100px Wordmark")) throw new Error("the Wordmark face did not load");
  const c = document.getElementById("c");
  c.width = s.w; c.height = s.h;
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, s.w, s.h);
  if (kind === "card") drawEndCard(ctx, s, t);
  else drawWatermark(ctx, s, opacity, hPct);
  return c.toDataURL("image/png").slice("data:image/png;base64,".length);
};
</scr` + `ipt>`;

async function withPage(fn) {
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(root, "src-tauri", "resources", "ms-playwright");
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(PAGE);
    return await fn(page);
  } finally {
    await browser.close();
  }
}

const write = (dest, base64) => writeFileSync(dest, Buffer.from(base64, "base64"));

/** The two assets per ratio the APP ships. brand/video also holds the stills and the demo
 *  reels, which are documentation; only these six are bundled, and `tauri build` reads them
 *  from src-tauri/resources — nothing regenerates that copy, so it is staged here rather than
 *  left to be remembered at release time. */
export const SHIPPED = SIZES.flatMap((s) => [`watermark-${s.id}.png`, `endcard-${s.id}.mp4`]);
export const STAGE_DIR = join(root, "src-tauri", "resources", "brand");

function stage() {
  mkdirSync(STAGE_DIR, { recursive: true });
  for (const name of SHIPPED) {
    copyFileSync(join(outDir, name), join(STAGE_DIR, name));
  }
  console.log(`[video] staged ${SHIPPED.length} files -> src-tauri/resources/brand`);
}

async function main() {
  const demo = process.argv.includes("--demo");
  mkdirSync(outDir, { recursive: true });

  await withPage(async (page) => {
    for (const s of SIZES) {
      write(join(outDir, `watermark-${s.id}.png`), await page.evaluate(
        ([s]) => window.shoot(s, "wm", 0, 0.6, 0.045), [s],
      ));
      console.log(`[video] watermark-${s.id}.png`);

      rmSync(framesDir, { recursive: true, force: true });
      mkdirSync(framesDir, { recursive: true });
      const total = Math.round(DUR * FPS);
      for (let i = 0; i <= total; i++) {
        const t = (i / total) * DUR;
        const png = await page.evaluate(([s, t]) => window.shoot(s, "card", t), [s, t]);
        write(join(framesDir, `f${String(i).padStart(4, "0")}.png`), png);
        if (i === total) write(join(outDir, `endcard-${s.id}-still.png`), png);
      }
      run([
        "-framerate", String(FPS), "-i", join(framesDir, "f%04d.png"),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart",
        join(outDir, `endcard-${s.id}.mp4`),
      ]);
      console.log(`[video] endcard-${s.id}.mp4 + still`);
    }
    rmSync(framesDir, { recursive: true, force: true });
  });

  if (demo) buildDemo();
  stage();
  console.log(`[video] done -> ${outDir}`);
}

/** A reel that proves both assets on real pixels: the watermark burned over moving footage
 *  that includes a BLANK-WHITE stretch (the case a white bug disappears into), then the end
 *  card concatenated on the tail. Every ratio, because the bug is sized off frame HEIGHT and
 *  inset differently per platform — 16:9 alone would prove nothing about the vertical cut. */
function buildDemo() {
  for (const s of SIZES) {
    const clip = join(outDir, "_demo-src.mp4");
    run([
      "-f", "lavfi", "-i", `testsrc2=size=${s.w}x${s.h}:rate=${FPS}:duration=4`,
      "-f", "lavfi", "-i", `color=c=white:size=${s.w}x${s.h}:rate=${FPS}:duration=2`,
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", clip,
    ]);
    const burned = join(outDir, "_demo-burned.mp4");
    run([
      "-i", clip, "-i", join(outDir, `watermark-${s.id}.png`),
      "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto[v]", "-map", "[v]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", burned,
    ]);
    run([
      "-i", burned, "-i", join(outDir, `endcard-${s.id}.mp4`),
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart",
      join(outDir, `demo-${s.id}.mp4`),
    ]);
    rmSync(clip, { force: true });
    rmSync(burned, { force: true });
    console.log(`[video] demo-${s.id}.mp4 — watermark burned over footage, end card on the tail`);
  }
}

await main();
