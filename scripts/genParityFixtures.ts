// Writes the whole-frame parity fixtures (art-daddy/backlog#83): the media every case is built from,
// made with the SHIPPED ffmpeg, then the references, which are frames of the REAL export of each case
// (src/preview/parity.smoke.e2e.ts run with ARTDADDY_PARITY_WRITE=1). Described in
// src/preview/__parityCases.ts.
//
//   npm run fixtures:parity
//
// Never run to make a failing parity test pass: a reference that moved is a change in what the export
// shows, and the reason is found first. Run it when a case is added or changed on purpose, and commit
// the media and every reference together.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { PARITY_DIR, PARITY_MEDIA } from "../src/preview/__parityCases";
import { shippedSidecarPath } from "../src/test/sidecars";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, PARITY_DIR);
const ff = shippedSidecarPath("ffmpeg");

function run(args: string[]): void {
  const r = spawnSync(ff, ["-y", "-v", "error", ...args], { maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}\n${String(r.stderr)}`);
}

/** A geq colour for the region test: `when ? yes : no`, as nested if()s. */
const pick = (rules: Array<[string, number | string]>, otherwise: number | string): string =>
  rules.reduceRight((rest, [when, value]) => `if(${when},${value},${rest})`, String(otherwise));

/** H.264 the way phones write it (High profile, BT.709 tagged, B-frames), 60 frames, 320x180 unless
 *  sized otherwise. */
function clip(file: string, rgb: [string, string, string], size = "320x180"): void {
  run([
    ...["-f", "lavfi", "-i", `color=c=black:s=${size}:r=30:d=2,format=gbrp`],
    ...[
      "-vf",
      `geq=r='${rgb[0]}':g='${rgb[1]}':b='${rgb[2]}',scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`,
    ],
    ...["-c:v", "libx264", "-profile:v", "high", "-crf", "18", "-g", "30"],
    ...[
      "-colorspace",
      "bt709",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-color_range",
      "tv",
    ],
    ...["-movflags", "+faststart", path.join(outDir, file)],
  ]);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(path.join(outDir, "ref"), { recursive: true });

// clip_a: four quadrants (the bottom-left one a grey ramp) and a white bar moving 4 px a frame.
{
  const bar = "between(X,20+4*N,25+4*N)*between(Y,30,149)";
  const top = "lt(Y,90)";
  const left = "lt(X,160)";
  const quadrant = (tl: number, tr: number, br: number) =>
    `if(${top},if(${left},${tl},${tr}),if(${left},16+X*1.4,${br}))`;
  clip(PARITY_MEDIA.clipA, [
    `if(${bar},240,${quadrant(200, 60, 70)})`,
    `if(${bar},240,${quadrant(60, 170, 80)})`,
    `if(${bar},240,${quadrant(60, 90, 200)})`,
  ]);
}

// clip_b: six vertical stripes and a dark bar moving down 2 px a frame.
{
  const bar = "between(Y,10+2*N,15+2*N)*between(X,20,299)";
  const stripes: Array<[number, number, number]> = [
    [230, 200, 40],
    [40, 200, 220],
    [220, 60, 160],
    [90, 200, 70],
    [240, 130, 40],
    [120, 90, 220],
  ];
  const channel = (c: number) =>
    `if(${bar},20,${pick(
      stripes.slice(0, -1).map((s, i) => [`lt(X,${Math.round(((i + 1) * 320) / 6)})`, s[c]]),
      stripes[5][c],
    )})`;
  clip(PARITY_MEDIA.clipB, [channel(0), channel(1), channel(2)]);
}

// detail: fine grey stripes, 4 px light and 4 px dark, standing still, at the canvas size so neither
// painter scales it (two scalers on stripes this fine differ by 7 levels, hub mismatch 7).
{
  const stripe = "if(lt(mod(X,8),4),220,30)";
  clip(PARITY_MEDIA.detail, [stripe, stripe, stripe], "640x360");
}

// still: 400x300, a light border, a diagonal split and an orange disc.
{
  const border = "lt(min(min(X,Y),min(399-X,299-Y)),6)";
  const disc = "lt(hypot(X-200,Y-150),80)";
  const below = "gt(Y*4,X*3)";
  const c = (b: number, d: number, lo: number, hi: number) =>
    pick(
      [
        [border, b],
        [disc, d],
        [below, lo],
      ],
      hi,
    );
  run([
    ...["-f", "lavfi", "-i", "color=c=black:s=400x300:d=1,format=gbrp"],
    ...[
      "-vf",
      `geq=r='${c(235, 240, 40, 90)}':g='${c(235, 150, 150, 40)}':b='${c(235, 40, 160, 120)}'`,
    ],
    ...["-frames:v", "1", "-pix_fmt", "rgb24", path.join(outDir, PARITY_MEDIA.still)],
  ]);
}

// banner: a 640x120 lower third, a half-transparent white bar (its top and bottom edges soft over
// 3 px) with a solid yellow tab at its left end. Half transparency over a third of the frame is what
// shows how each painter composites such a pixel.
{
  const tab = "lt(X,16)";
  const bar = "0.5*clip(Y/3,0,1)*clip((119-Y)/3,0,1)";
  run([
    ...["-f", "lavfi", "-i", "color=c=black@0:s=640x120:d=1,format=gbrap"],
    ...[
      "-vf",
      `geq=r='250':g='${pick([[tab, 220]], 250)}':b='${pick([[tab, 40]], 250)}':a='255*${pick([[tab, 1]], bar)}'`,
    ],
    ...["-frames:v", "1", "-pix_fmt", "rgba", path.join(outDir, PARITY_MEDIA.banner)],
  ]);
}

// The references: frames of the real export of every case.
const smoke = spawnSync(
  process.execPath,
  [
    path.join(root, "node_modules", "vitest", "vitest.mjs"),
    "run",
    "--config",
    "vitest.smoke.config.ts",
    "src/preview/parity.smoke.e2e.ts",
  ],
  { cwd: root, stdio: "inherit", env: { ...process.env, ARTDADDY_PARITY_WRITE: "1" } },
);
if (smoke.status !== 0) throw new Error("writing the references failed");
console.log(`wrote the parity media and references to ${outDir}`);
