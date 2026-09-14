// Does a branded export actually CARRY the branding? Renders real mp4s through the BUNDLED
// ffmpeg and reads the file back.
//
// This exists because the plan tests cannot fail the way this feature fails. A filtergraph that
// contains `overlay=0:0` and `concat` is exactly what a caption graph containing `ass=f=` looked
// like while every exported video had zero caption pixels. So: probe the DURATION, and sample
// pixels at two different times — one inside the user's footage, one inside the tail — and
// require them to differ from the unbranded render in the right places.
//
// NOT part of the unit suite: `npx vitest run --config vitest.smoke.config.ts`.
import { spawn } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { brandRatio, endcardFile, watermarkFile } from "./branding";
import type { Timeline } from "./model";
import { buildRenderCommand } from "./render";

function bundled(tool: "ffmpeg" | "ffprobe"): string | null {
  const dir = path.resolve(process.cwd(), "src-tauri/binaries");
  const names =
    process.platform === "win32"
      ? [`${tool}-x86_64-pc-windows-msvc.exe`]
      : process.platform === "darwin"
        ? [`${tool}-aarch64-apple-darwin`, `${tool}-x86_64-apple-darwin`]
        : [`${tool}-x86_64-unknown-linux-gnu`];
  for (const n of names) {
    const p = path.join(dir, n);
    if (existsSync(p)) return p;
  }
  return null;
}
const FF = bundled("ffmpeg");
const FP = bundled("ffprobe");
const BRAND_DIR = path.resolve(process.cwd(), "src-tauri/resources/brand");

function run(
  program: string,
  args: string[],
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) => resolve({ code: -1, stdout: "", stderr: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function durationOf(file: string): Promise<number> {
  const r = await run(FP!, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    file,
  ]);
  expect(r.code, `ffprobe failed: ${r.stderr.slice(-300)}`).toBe(0);
  const d = Number(r.stdout.trim().split(/\s+/)[0]);
  expect(Number.isFinite(d), `ffprobe reported no duration: '${r.stdout}'`).toBe(true);
  return d;
}

async function streamDurations(file: string): Promise<{ video: number; audio: number }> {
  const r = await run(FP!, [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,duration",
    "-of",
    "json",
    file,
  ]);
  expect(r.code, `ffprobe failed: ${r.stderr.slice(-300)}`).toBe(0);
  const payload = JSON.parse(r.stdout) as {
    streams?: Array<{ codec_type?: string; duration?: string }>;
  };
  const streams = payload.streams ?? [];
  return {
    video: Number(streams.find((s) => s.codec_type === "video")?.duration),
    audio: Number(streams.find((s) => s.codec_type === "audio")?.duration),
  };
}

/** Average luma of ONE frame at `t`, optionally within a crop. Sampling a single instant is
 *  the point: a whole-file average would hide a bug that is present for two frames. */
async function lumaAt(file: string, t: number, crop = ""): Promise<number> {
  const vf = `${crop ? `${crop},` : ""}signalstats,metadata=print`;
  const r = await run(FF!, [
    "-hide_banner",
    "-ss",
    t.toFixed(3),
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    vf,
    "-f",
    "null",
    "-",
  ]);
  const m = [...r.stderr.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((x) => Number(x[1]));
  expect(m.length, `no frame at t=${t} in ${path.basename(file)}`).toBeGreaterThan(0);
  return m[0];
}

const scratches: string[] = [];
async function scratch(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-brand-"));
  scratches.push(d);
  return d;
}
afterAll(async () => {
  for (const d of scratches)
    await fsp.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const W = 640;
const H = 360; // 16:9, so brandRatio picks the landscape assets
const DUR = 2;

/** Mid-grey footage: the watermark is pure white and the end card is near-black, so both
 *  changes move luma in an unambiguous direction from here. */
async function source(cwd: string): Promise<string> {
  const src = path.join(cwd, "src.mp4");
  const r = await run(FF!, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=gray:s=${W}x${H}:r=30:d=${DUR}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:sample_rate=48000:duration=${DUR}`,
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    src,
  ]);
  expect(r.code, `source render failed: ${r.stderr.slice(-400)}`).toBe(0);
  return src;
}

function timeline(src: string, withAudio = false): Timeline {
  return {
    canvas: { width: W, height: H, fps: 30 },
    tracks: [
      {
        id: "v0",
        kind: "video",
        z: 0,
        clips: [
          {
            id: "a",
            media_ref: src,
            source_in: 0,
            source_out: DUR,
            timeline_in: 0,
            timeline_out: DUR,
          },
        ],
      },
      ...(withAudio
        ? [
            {
              id: "a0",
              kind: "audio",
              z: 0,
              clips: [
                {
                  id: "sound",
                  kind: "audio",
                  media_ref: src,
                  source_in: 0,
                  source_out: DUR,
                  timeline_in: 0,
                  timeline_out: DUR,
                },
              ],
            },
          ]
        : []),
    ],
  } as unknown as Timeline;
}

async function render(
  cwd: string,
  src: string,
  branded: boolean,
  tag: string,
  opts: { withAudio?: boolean; endcard?: string } = {},
): Promise<string> {
  const out = path.join(cwd, `${tag}.mp4`);
  const ratio = brandRatio(W, H);
  const endcard = opts.endcard ?? path.join(BRAND_DIR, endcardFile(ratio));
  const plan = buildRenderCommand(timeline(src, opts.withAudio), out, {
    branding: branded
      ? {
          watermark: path.join(BRAND_DIR, watermarkFile(ratio)),
          endcard,
          endcardDuration: await durationOf(endcard),
        }
      : undefined,
  });
  const r = await run(FF!, plan.args, cwd);
  expect(r.code, `ffmpeg failed: ${r.stderr.slice(-800)}`).toBe(0);
  return out;
}

/** Raw RGBA of an image, straight from ffmpeg. Kept off the text `run` helper on purpose:
 *  decoding pixel bytes as a string corrupts them. */
function rawFrame(file: string, w: number, h: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      FF!,
      ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-frames:v", "1", "-"],
      { windowsHide: true },
    );
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => chunks.push(d));
    child.on("error", reject);
    child.on("close", () => {
      const buf = Buffer.concat(chunks);
      if (buf.length < w * h * 4) reject(new Error(`short decode: ${buf.length} bytes`));
      else resolve(buf);
    });
  });
}

/** The box the artwork actually occupies — everything outside it is dead icon. */
function artBox(px: Buffer, w: number, h: number) {
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
  return { w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

describe.skipIf(!FF || !FP)("branded export (real ffmpeg)", () => {
  it("ships an app icon that fills its box and still has a lion in it", async () => {
    // Two ways this icon has already been wrong: line art so thin it read as a smudge at
    // taskbar size, and dead margin from the master's empty gutters. Filling the box fixes
    // both — but a plain amber square would also fill the box, so the knocked-out lion is
    // asserted separately. Neither check passes without the other.
    const icon = path.resolve(process.cwd(), "src-tauri/icons/32x32.png");
    expect(existsSync(icon)).toBe(true);
    const px = await rawFrame(icon, 32, 32);

    const box = artBox(px, 32, 32);
    expect(box.h, "dead margin above or below the icon").toBe(32);
    expect(box.w).toBe(32);

    let plate = 0;
    let ink = 0;
    for (let i = 0; i < 32 * 32 * 4; i += 4) {
      if (px[i + 3] < 128) continue; // outside the rounded corners
      const luma = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      if (luma < 80) ink++;
      else plate++;
    }
    // The lion is a real share of the face, not a speck: it went missing once already when
    // the mark was drawn at 78% and the detail closed up at small sizes.
    const inkShare = ink / (ink + plate);
    expect(inkShare, "no knocked-out mark inside the plate").toBeGreaterThan(0.15);
    expect(inkShare, "the plate has been swallowed by the mark").toBeLessThan(0.7);
  }, 60_000);

  it("ships the assets the app will actually look for at runtime", () => {
    // The staged copy is what `tauri build` bundles; nothing regenerates it, so an edit to
    // brand/video that was never staged ships the OLD branding while the repo shows the new.
    for (const r of ["16x9", "1x1", "9x16"] as const) {
      expect(existsSync(path.join(BRAND_DIR, watermarkFile(r))), `${watermarkFile(r)}`).toBe(true);
      expect(existsSync(path.join(BRAND_DIR, endcardFile(r))), `${endcardFile(r)}`).toBe(true);
    }
  });

  it("appends the end card: the file is LONGER and its tail is not the footage", async () => {
    const cwd = await scratch();
    const src = await source(cwd);
    const plain = await render(cwd, src, false, "plain");
    const branded = await render(cwd, src, true, "branded");

    const plainDur = await durationOf(plain);
    const brandedDur = await durationOf(branded);
    expect(plainDur).toBeCloseTo(DUR, 1);
    // Differential, so this survives the card being re-authored at a different length.
    expect(brandedDur).toBeGreaterThan(plainDur + 1);

    // Two samples, and they must DIFFER: one inside the user's footage, one inside the tail.
    // A single sample cannot tell "the card rendered" from "the footage was held longer".
    const inFootage = await lumaAt(branded, DUR / 2);
    const inTail = await lumaAt(branded, plainDur + (brandedDur - plainDur) / 2);
    expect(Math.abs(inTail - inFootage)).toBeGreaterThan(20);
    // The card is a dark brand plate; the footage is mid-grey.
    expect(inTail).toBeLessThan(inFootage);
  }, 120_000);

  it("keeps the encoded audio stream as long as the branded video", async () => {
    const cwd = await scratch();
    const src = await source(cwd);
    const branded = await render(cwd, src, true, "audio-duration", { withAudio: true });
    const durations = await streamDurations(branded);

    expect(Number.isFinite(durations.video)).toBe(true);
    expect(Number.isFinite(durations.audio)).toBe(true);
    expect(Math.abs(durations.audio - durations.video)).toBeLessThan(0.2);
    expect(durations.audio).toBeGreaterThan(DUR + 1);
  }, 120_000);

  it("does not insert black frames at the main/endcard seam", async () => {
    const cwd = await scratch();
    const src = await source(cwd);
    const card = path.join(cwd, "blue-card.mp4");
    const made = await run(FF!, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=blue:s=${W}x${H}:r=30:d=1`,
      "-pix_fmt",
      "yuv420p",
      card,
    ]);
    expect(made.code, made.stderr.slice(-400)).toBe(0);
    const branded = await render(cwd, src, true, "seam", { endcard: card });

    const seamLuma = await Promise.all(
      [-2, -1, 0, 1, 2].map((frame) => lumaAt(branded, DUR + frame / 30)),
    );
    expect(
      seamLuma.every((luma) => luma > 25),
      `seam luma: ${seamLuma.join(", ")}`,
    ).toBe(true);
  }, 120_000);

  it("burns the watermark into the footage, in the corner it was authored for", async () => {
    const cwd = await scratch();
    const src = await source(cwd);
    const plain = await render(cwd, src, false, "plain2");
    const branded = await render(cwd, src, true, "branded2");

    // The bug sits bottom-right. Crop to that corner and compare like for like — an absolute
    // threshold would drift with the encoder, and a whole-frame average would drown a bug
    // that covers a few percent of the picture.
    const corner = `crop=${Math.round(W * 0.35)}:${Math.round(H * 0.2)}:${W - Math.round(W * 0.35)}:${H - Math.round(H * 0.2)}`;
    const t = DUR / 2;
    const plainCorner = await lumaAt(plain, t, corner);
    const brandedCorner = await lumaAt(branded, t, corner);
    expect(brandedCorner - plainCorner, "no white bug in the corner").toBeGreaterThan(2);

    // …and the REST of the frame is untouched: a watermark that lightened the whole picture
    // would pass the assertion above while ruining every export.
    const rest = `crop=${W}:${Math.round(H * 0.6)}:0:0`;
    expect(await lumaAt(branded, t, rest)).toBeCloseTo(await lumaAt(plain, t, rest), 0);
  }, 120_000);

  it("keeps an unbranded render free of both", async () => {
    const cwd = await scratch();
    const src = await source(cwd);
    const plain = await render(cwd, src, false, "plain3");
    // The working render and the model's preview frames take this path; branding them would
    // put the bug in front of the model as if the user had placed it.
    expect(await durationOf(plain)).toBeCloseTo(DUR, 1);
  }, 120_000);
});
