#!/usr/bin/env node
// Generate every brand asset from ONE master mark.
//
//   npm run brand:assets                 # uses brand/artdaddy-mark.png
//   node scripts/brand-assets.mjs <file> # or an explicit .png / .svg
//
// The master must already be a CUT-OUT (transparent background, and the light areas inside
// the face as holes rather than white pixels). scripts/brand-import.mjs makes one from a
// flat artwork export.
//
// Emits, all with transparency preserved:
//   brand/artdaddy-mark-{brand,white,black}.png     the lion, square, for icons + watermarks
//   brand/artdaddy-lockup-{brand,white,black}.png   lion + wordmark, for larger surfaces
// then regenerates src-tauri/icons/* from the amber mark.
//
// White and black exist because a watermark has to survive arbitrary footage: white over
// dark, black over light. They are produced by replacing each pixel's RGB and KEEPING its
// alpha, which is what preserves the antialiased edges — and why the master must be a
// cut-out. If the light areas inside the face were white pixels rather than holes, the
// white variant would flatten into a solid block. `inspect()` refuses such a master
// instead of writing an asset that only fails at review.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const brandDir = join(root, "brand");
const master = resolve(process.argv[2] ?? join(brandDir, "artdaddy-mark.png"));

const { brand } = JSON.parse(readFileSync(join(root, "src", "brand.json"), "utf8"));

const VARIANTS = [
  { name: "brand", rgb: [0xc9, 0x8a, 0x3e] },
  { name: "white", rgb: [0xff, 0xff, 0xff] },
  { name: "black", rgb: [0x00, 0x00, 0x00] },
];

const MARK_PX = 1024;
const WORDMARK = brand.displayName.toUpperCase();

// The icon inverts the mark: an amber plate with the lion knocked out in the app background.
const ICON_PLATE = "#C98A3E";
const ICON_INK = [0x0f, 0x0f, 0x11];
const ICON_LION = 0.92;

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
  // ffprobe exits 0 and reports 0x0 on a file it cannot decode, so judge the numbers.
  if (!w || !h) throw new Error(`${file}: not a decodable image (reported ${w}x${h})`);
  return { w, h };
}

/** Decode to raw RGBA so the checks below look at PIXELS, not at metadata. */
const decode = (file, w, h) =>
  execFileSync(ffmpeg(), ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-frames:v", "1", "-"], {
    maxBuffer: w * h * 4 + 1024,
  });

const encode = (buf, w, h, dest) =>
  execFileSync(
    ffmpeg(),
    ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-i", "-", "-frames:v", "1", dest],
    { input: buf },
  );

/** Render markup with the chromium already staged for the browser sidecar. ffmpeg cannot
 *  decode SVG (no librsvg in these builds), and nothing else here rasterises. */
async function shoot(html, selector, dest, w, h, expectFont) {
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(root, "src-tauri", "resources", "ms-playwright");
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    if (expectFont) {
      // `fonts.ready` resolves even when the face failed and the text fell back to a serif,
      // so it says nothing on its own. Ask whether THIS family is usable.
      const ok = await page.evaluate((f) => document.fonts.check(`100px ${f}`), expectFont);
      if (!ok) throw new Error(`the ${expectFont} face did not load — the wordmark would ship in a fallback serif`);
    }
    // omitBackground keeps the page transparent, so alpha comes from the artwork alone.
    await page.locator(selector).screenshot({ path: dest, omitBackground: true });
  } finally {
    await browser.close();
  }
  return dest;
}

const RESET = `html,body{margin:0;padding:0;background:transparent}`;

/** The master is either a vector or an already cut-out raster; both go into the same page. */
const markMarkup = (file) =>
  file.toLowerCase().endsWith(".svg")
    ? readFileSync(file, "utf8")
    : `<img src="data:image/png;base64,${readFileSync(file).toString("base64")}">`;

const markPage = (markup, size) =>
  `<!doctype html><meta charset="utf-8"><style>${RESET}` +
  `svg,img{display:block;width:${size}px;height:${size}px}</style>${markup}`;

/** The wordmark is set in the Anton already bundled for the caption renderer, so this needs
 *  no network and no installed font. The face is INLINED as a data URI: `setContent` yields
 *  an about:blank origin, and Chromium refuses a file:// font from there — it renders in a
 *  serif fallback that still satisfies `document.fonts.ready`, so the failure is silent. */
const lockupPage = (markup, size) => {
  const ttf = readFileSync(join(root, "src-tauri", "resources", "fonts", "Anton-Regular.ttf")).toString("base64");
  const mark = Math.round(size * 0.72);
  return (
    `<!doctype html><meta charset="utf-8"><style>${RESET}` +
    `@font-face{font-family:Wordmark;src:url(data:font/ttf;base64,${ttf}) format("truetype")}` +
    `#lockup{display:inline-flex;flex-direction:column;align-items:center;gap:${Math.round(size * 0.04)}px;padding:2px}` +
    `.art{width:${mark}px;height:${mark}px}.art svg,.art img{display:block;width:100%;height:100%}` +
    `#word{font-family:Wordmark;font-size:${Math.round(size * 0.19)}px;line-height:0.82;color:#C98A3E;` +
    `letter-spacing:${Math.round(size * 0.012)}px;white-space:nowrap}` +
    `</style><div id="lockup"><div class="art">${markup}</div><div id="word">${WORDMARK}</div></div>`
  );
};

/** Refuse a master that would silently produce a blob. */
function inspect(px, w, h, label) {
  let opaque = 0;
  let transparent = 0;
  for (let i = 3; i < px.length; i += 4) {
    if (px[i] > 250) opaque++;
    else if (px[i] < 5) transparent++;
  }
  const total = w * h;
  const corners = [0, (w - 1) * 4, (h - 1) * w * 4, (total - 1) * 4].map((o) => px[o + 3]);
  const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;

  console.log(`[brand] ${label} ${w}x${h}  opaque ${pct(opaque)}  transparent ${pct(transparent)}`);
  if (corners.some((a) => a > 250)) {
    throw new Error(
      `${label} has OPAQUE CORNERS (alpha ${corners.join(",")}) — it still has a background.\n` +
        `        Export a cut-out, and make the light areas inside the face HOLES rather than\n` +
        `        white pixels, or the white watermark will be a solid block.`,
    );
  }
  if (transparent / total < 0.05) {
    throw new Error(`${label} is only ${pct(transparent)} transparent — that is not a cut-out.`);
  }
}

/** One raster -> the three colourways. */
function colourways(source, stem) {
  const { w, h } = probe(source);
  const px = decode(source, w, h);
  if (px.length < w * h * 4) throw new Error(`short decode: ${px.length} bytes for ${w}x${h}`);
  inspect(px, w, h, stem);

  for (const { name, rgb } of VARIANTS) {
    const out = Buffer.from(px);
    for (let i = 0; i < out.length; i += 4) {
      out[i] = rgb[0];
      out[i + 1] = rgb[1];
      out[i + 2] = rgb[2];
      // out[i + 3] deliberately untouched: alpha is the artwork.
    }
    const dest = join(brandDir, `${stem}-${name}.png`);
    encode(out, w, h, dest);
    console.log(`[brand] wrote ${dest}`);
  }
}

/** The alpha bounding box: where the artwork actually is inside its canvas. Measured rather
 *  than assumed — the master carries ~16% empty gutters left and right, which is a sixth of
 *  every icon size thrown away before the artwork starts. */
function alphaBox(px, w, h) {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error("the mark is fully transparent");
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Recolour a cut-out in place, keeping alpha — the same trick colourways() uses. */
function tint(px, [r, g, b]) {
  const out = Buffer.from(px);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
  }
  return out;
}

/** Crop a mark to its own artwork, optionally recolouring it. The bounding box is MEASURED
 *  every run: writing it down as a constant is how the second caller ends up cropping to where
 *  the artwork used to be. */
function cropToArt(markPng, dest, rgb) {
  const { w, h } = probe(markPng);
  const px = decode(markPng, w, h);
  const box = alphaBox(px, w, h);
  execFileSync(ffmpeg(), [
    "-v", "error", "-y", "-i", markPng,
    "-vf", `crop=${box.w}:${box.h}:${box.x}:${box.y}`,
    "-frames:v", "1", dest,
  ]);
  if (rgb) encode(tint(decode(dest, box.w, box.h), rgb), box.w, box.h, dest);
  return { dest, box, canvas: { w, h } };
}

/**
 * The app icon: the mark INVERTED onto a filled plate.
 *
 * The bare mark is line art — amber strokes with the face read as gaps — and at the 24-32px a
 * taskbar draws, those strokes thin out into a pale smudge next to solid neighbours like
 * WhatsApp or Edge. Rendered side by side at 32px it was unrecognisable as a lion. Inverting
 * figure and ground fixes that: the plate carries the brand amber and the lion is knocked out
 * of it in the app's background colour, so the silhouette is what the eye gets first.
 *
 * The lion is sized to 92% of the icon, and the master's dead space (16% each side, 6% top
 * and bottom) is trimmed off first, so almost none of the box is spent on nothing.
 *
 * 22.4% corner radius is the macOS icon curvature; `tauri icon` derives the .icns and .ico
 * from this one file.
 */
async function appIcon(markPng) {
  const art = join(brandDir, "_icon-art.png");
  const { box, canvas } = cropToArt(markPng, art, ICON_INK);
  const size = 1024;
  const page =
    `<!doctype html><meta charset="utf-8"><style>${RESET}` +
    `#icon{width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;` +
    `background:${ICON_PLATE};border-radius:${Math.round(size * 0.224)}px}` +
    `img{display:block;height:${Math.round(size * ICON_LION)}px}</style>` +
    `<div id="icon"><img src="data:image/png;base64,${readFileSync(art).toString("base64")}"></div>`;

  const dest = join(brandDir, "artdaddy-icon.png");
  await shoot(page, "#icon", dest, size, size);
  rmSync(art, { force: true });
  console.log(
    `[brand] icon: trimmed ${box.w}x${box.h} of ${canvas.w}x${canvas.h}, knocked out at ` +
      `${Math.round(ICON_LION * 100)}% on an amber plate`,
  );
  return dest;
}

async function main() {  if (!existsSync(master)) {
    console.error(`[brand] no master at ${master}`);
    process.exit(1);
  }
  mkdirSync(brandDir, { recursive: true });

  const markup = markMarkup(master);

  // A raster master is already the mark; only a vector needs rendering to pixels.
  let markPng = master;
  if (master.toLowerCase().endsWith(".svg")) {
    markPng = await shoot(markPage(markup, MARK_PX), "svg", join(brandDir, "artdaddy-mark-1024.png"), MARK_PX, MARK_PX);
    console.log(`[brand] rasterised mark @${MARK_PX}px`);
  }

  const lockupPng = await shoot(
    lockupPage(markup, MARK_PX),
    "#lockup",
    join(brandDir, "artdaddy-lockup-1024.png"),
    Math.round(MARK_PX * 1.6),
    Math.round(MARK_PX * 1.4),
    "Wordmark",
  );
  console.log(`[brand] rasterised lockup`);
  colourways(lockupPng, "artdaddy-lockup");
  colourways(markPng, "artdaddy-mark");

  const icon = await appIcon(join(brandDir, "artdaddy-mark-brand.png"));

  // The web entry has its own icon: `tauri icon` only writes the desktop bundle's set, so
  // without this the browser tab and the dev server fall back to a default.
  const favicon = join(root, "public", "favicon.png");
  mkdirSync(join(root, "public"), { recursive: true });
  execFileSync(ffmpeg(), ["-v", "error", "-y", "-i", icon, "-vf", "scale=256:256:flags=lanczos", "-frames:v", "1", favicon]);
  console.log(`[brand] wrote ${favicon}`);

  // The plated icon for use INSIDE the app too. The bare mark is line art and at avatar
  // sizes people read it as a bearded man or a wolf; the knocked-out version is the one
  // that reads as a lion, so the UI uses the same treatment as the OS icon.
  const uiIcon = join(root, "public", "icon.png");
  execFileSync(ffmpeg(), ["-v", "error", "-y", "-i", icon, "-vf", "scale=256:256:flags=lanczos", "-frames:v", "1", uiIcon]);
  console.log(`[brand] wrote ${uiIcon}`);

  // The bare amber mark for use INSIDE the app, where there is already a dark surface behind
  // it and the plate would just be a second background. public/ so it is a plain URL in both
  // the dev server and the bundled app.
  const uiMark = join(root, "public", "mark.png");
  const trimmed = join(brandDir, "_ui-mark.png");
  cropToArt(join(brandDir, "artdaddy-mark-brand.png"), trimmed);
  execFileSync(ffmpeg(), ["-v", "error", "-y", "-i", trimmed, "-vf", "scale=-1:512:flags=lanczos", "-frames:v", "1", uiMark]);
  rmSync(trimmed, { force: true });
  console.log(`[brand] wrote ${uiMark}`);

  console.log(`[brand] regenerating src-tauri/icons from ${icon}…`);
  execFileSync("npx", ["tauri", "icon", icon], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  console.log(`[brand] done. ${brand.displayName} assets are in brand/ and src-tauri/icons/.`);
}

await main();
