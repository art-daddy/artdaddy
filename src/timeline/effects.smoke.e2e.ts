// Pixel-level effect smoke: renders REAL mp4s through the BUNDLED ffmpeg and asserts
// each effect changes actual PIXELS. The unit tests assert the filtergraph STRING
// contains the right filter — which is exactly the assertion that passed while
// captions composited nothing, and while `{type:"glow"}` rendered no glow at all.
//
// Every case is DIFFERENTIAL: the same timeline rendered with and without the
// effect, comparing luma statistics. That survives codec/ffmpeg-version drift in a
// way an absolute threshold would not.
//
// NOT part of the unit suite: `npx vitest run --config vitest.smoke.config.ts`.
import { spawn } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { resolveEffect } from "./effectRegistry";
import type { Timeline } from "./model";
import { buildRenderCommand } from "./render";

function bundledFfmpeg(): string | null {
  const dir = path.resolve(process.cwd(), "src-tauri/binaries");
  const names =
    process.platform === "win32"
      ? ["ffmpeg-x86_64-pc-windows-msvc.exe"]
      : process.platform === "darwin"
        ? ["ffmpeg-aarch64-apple-darwin", "ffmpeg-x86_64-apple-darwin"]
        : ["ffmpeg-x86_64-unknown-linux-gnu"];
  for (const n of names) {
    const p = path.join(dir, n);
    if (existsSync(p)) return p;
  }
  return null;
}
const FF = bundledFfmpeg();

function run(
  program: string,
  args: string[],
  cwd?: string,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { cwd, windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) => resolve({ code: -1, stderr: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

interface Stats {
  avg: number;
  min: number;
  max: number;
}

/** Luma stats over the whole file, optionally through a `pre` filter (e.g. a crop). */
async function lumaStats(file: string, pre = ""): Promise<Stats> {
  const vf = pre ? `${pre},signalstats,metadata=print` : "signalstats,metadata=print";
  const r = await run(FF!, ["-hide_banner", "-i", file, "-vf", vf, "-f", "null", "-"]);
  const pick = (re: RegExp): number[] => [...r.stderr.matchAll(re)].map((m) => Number(m[1]));
  const avg = pick(/lavfi\.signalstats\.YAVG=([\d.]+)/g);
  const min = pick(/lavfi\.signalstats\.YMIN=(\d+)/g);
  const max = pick(/lavfi\.signalstats\.YMAX=(\d+)/g);
  expect(avg.length, "signalstats produced no frames").toBeGreaterThan(0);
  return {
    avg: avg.reduce((a, b) => a + b, 0) / avg.length,
    min: Math.min(...min),
    max: Math.max(...max),
  };
}

/** Positive means redder/warmer, negative means bluer/cooler. */
async function warmth(file: string): Promise<number> {
  const r = await run(FF!, [
    "-hide_banner",
    "-i",
    file,
    "-vf",
    "signalstats,metadata=print",
    "-f",
    "null",
    "-",
  ]);
  const u = [...r.stderr.matchAll(/lavfi\.signalstats\.UAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  const v = [...r.stderr.matchAll(/lavfi\.signalstats\.VAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  expect(u.length, "signalstats produced no chroma frames").toBeGreaterThan(0);
  expect(v).toHaveLength(u.length);
  return v.reduce((sum, value, i) => sum + value - u[i], 0) / u.length;
}

const scratches: string[] = [];
async function scratch(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-fx-"));
  scratches.push(d);
  return d;
}
afterAll(async () => {
  for (const d of scratches)
    await fsp.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const CANVAS = { width: 320, height: 240, fps: 30 };

/** A hard-edged source: high spatial frequency + a bright patch on black, so blur,
 *  glow and vignette all have something to measurably act on. */
async function source(cwd: string): Promise<string> {
  const src = path.join(cwd, "src.mp4");
  const r = await run(FF!, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=320x240:r=30:d=1",
    "-vf",
    // A white square dead centre — sharp edges for blur, bright energy for glow.
    "drawbox=x=120:y=80:w=80:h=80:color=white:t=fill",
    "-pix_fmt",
    "yuv420p",
    src,
  ]);
  expect(r.code, `source render failed: ${r.stderr.slice(-400)}`).toBe(0);
  return src;
}

/** Render the source with an optional effect stack applied to the clip. */
async function renderWith(
  cwd: string,
  src: string,
  effects: unknown[],
  tag: string,
  color?: Record<string, unknown>,
) {
  const out = path.join(cwd, `${tag}.mp4`);
  const timeline = {
    canvas: CANVAS,
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
            source_out: 1,
            timeline_in: 0,
            timeline_out: 1,
            ...(effects.length ? { effects } : {}),
            ...(color ? { color } : {}),
          },
        ],
      },
    ],
  } as unknown as Timeline;
  const plan = buildRenderCommand(timeline, out);
  const r = await run(FF!, plan.args, cwd);
  expect(r.code, `ffmpeg failed: ${r.stderr.slice(-600)}`).toBe(0);
  return out;
}

/** Author the effect exactly as the tool would, so the test exercises the REAL
 *  default/clamp path rather than a hand-written stack the tool would never produce. */
const authored = (type: string, params?: Record<string, unknown>): unknown => {
  const { effect, error } = resolveEffect(params ? { type, params } : { type }, "video");
  expect(error, `resolveEffect refused '${type}'`).toBeUndefined();
  return effect;
};

describe.skipIf(!FF)("effect pixel smoke (bundled ffmpeg)", () => {
  it("higher temperature produces warmer pixels, as the tool contract promises", async () => {
    const cwd = await scratch();
    const src = await source(cwd);
    const cool = await warmth(await renderWith(cwd, src, [], "temp-cool", { temperature: 5000 }));
    const warm = await warmth(await renderWith(cwd, src, [], "temp-warm", { temperature: 8000 }));
    expect(warm, `warmth ${warm} vs ${cool}`).toBeGreaterThan(cool + 2);
  }, 120_000);

  it("a BARE glow emits real bloom pixels (the regression: ok:true, zero glow)", async () => {
    const cwd = await scratch();
    const src = await source(cwd);
    const plain = await lumaStats(await renderWith(cwd, src, [], "plain"));
    // No params at all — the exact call that used to be stored and render nothing.
    const glow = await lumaStats(await renderWith(cwd, src, [authored("glow")], "glow"));
    // Bloom spreads the white square's energy into the black surround: mean luma rises.
    expect(glow.avg, `glow ${glow.avg} vs plain ${plain.avg}`).toBeGreaterThan(plain.avg + 1);
  }, 120_000);

  it("blur bleeds the square's edge into the black margin beside it", async () => {
    const cwd = await scratch();
    const src = await source(cwd);
    // A 20px band immediately LEFT of the white square (x 100..120, y 80..160): pure
    // black while the edge is sharp, lit once the edge is blurred. Measuring the whole
    // frame would not work — a σ20 blur never reaches the frame border.
    const band = "crop=20:80:100:80";
    const plain = await lumaStats(await renderWith(cwd, src, [], "p2"), band);
    const blurred = await lumaStats(
      await renderWith(cwd, src, [authored("blur", { radius: 20 })], "blur"),
      band,
    );
    expect(blurred.avg, `band ${blurred.avg} vs plain ${plain.avg}`).toBeGreaterThan(plain.avg + 2);
  }, 120_000);

  it("vignette darkens the corners specifically, not the whole frame", async () => {
    const cwd = await scratch();
    // Measure a bright ring near a corner by cropping the top-left quadrant of a WHITE frame.
    const white = path.join(cwd, "white.mp4");
    await run(FF!, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=white:s=320x240:r=30:d=1",
      "-pix_fmt",
      "yuv420p",
      white,
    ]);
    const plain = await lumaStats(await renderWith(cwd, white, [], "p3"), "crop=80:60:0:0");
    const vig = await lumaStats(
      await renderWith(cwd, white, [authored("vignette")], "vig"),
      "crop=80:60:0:0",
    );
    expect(vig.avg, `corner ${vig.avg} vs plain ${plain.avg}`).toBeLessThan(plain.avg - 2);
  }, 120_000);

  it("enabled:false really bypasses: pixels match the un-effected render", async () => {
    const cwd = await scratch();
    const src = await source(cwd);
    const plain = await lumaStats(await renderWith(cwd, src, [], "p4"));
    const off = await lumaStats(
      await renderWith(
        cwd,
        src,
        [resolveEffect({ type: "blur", params: { radius: 20 }, enabled: false }, "video").effect],
        "off",
      ),
    );
    expect(off.min).toBe(plain.min);
    expect(Math.abs(off.avg - plain.avg)).toBeLessThan(0.5);
  }, 120_000);
});
