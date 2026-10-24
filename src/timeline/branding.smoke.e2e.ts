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

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { brandRatio, endcardFile, watermarkFile, type Branding } from "./branding";
import type { Timeline } from "./model";
import { buildRenderCommand, exportBranding, finishRenderJob } from "./render";
import { shippedSidecar } from "../test/sidecars";
import { meanVolumeDb, mkCtx, nodeFs } from "../tools/__e2e";
import { setClerkTokenProvider } from "../api/auth";
import { useAuth } from "../store/auth";

vi.mock("@tauri-apps/api/path", () => ({
  resolveResource: async (resource: string) => path.resolve(process.cwd(), "src-tauri", resource),
}));
vi.mock("../tools/dataRoot", async (original) => ({
  ...(await original<typeof import("../tools/dataRoot")>()),
  appCacheRoot: async () => nodeFs.cacheDir!(),
}));
vi.mock("../tools/tauri", async (original) => ({
  ...(await original<typeof import("../tools/tauri")>()),
  TauriFs: class {
    constructor() {
      return nodeFs;
    }
  },
}));

afterEach(() => {
  setClerkTokenProvider(null);
  useAuth.setState({ status: "checking", profile: null });
  vi.unstubAllGlobals();
});

const FF = shippedSidecar("ffmpeg");
const FP = shippedSidecar("ffprobe");
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

type VideoColorInfo = {
  pix_fmt: string | null;
  color_range: string | null;
  color_space: string | null;
  color_transfer: string | null;
  color_primaries: string | null;
};

async function videoColorInfo(file: string): Promise<VideoColorInfo> {
  const r = await run(FP!, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=pix_fmt,color_range,color_space,color_transfer,color_primaries",
    "-of",
    "json",
    file,
  ]);
  expect(r.code, `ffprobe failed: ${r.stderr.slice(-300)}`).toBe(0);
  const payload = JSON.parse(r.stdout) as { streams?: Partial<VideoColorInfo>[] };
  const video = payload.streams?.[0];
  if (!video) throw new Error(`ffprobe reported no video stream for ${file}`);
  return {
    pix_fmt: video.pix_fmt ?? null,
    color_range: video.color_range ?? null,
    color_space: video.color_space ?? null,
    color_transfer: video.color_transfer ?? null,
    color_primaries: video.color_primaries ?? null,
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
async function source(cwd: string, duration = DUR): Promise<string> {
  const src = path.join(cwd, "src.mp4");
  const r = await run(FF!, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=gray:s=${W}x${H}:r=30:d=${duration}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:sample_rate=48000:duration=${duration}`,
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

function timeline(
  src: string,
  withAudio = false,
  canvas = { width: W, height: H },
  duration = DUR,
): Timeline {
  return {
    canvas: { ...canvas, fps: 30 },
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
            source_out: duration,
            timeline_in: 0,
            timeline_out: duration,
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
                  source_out: duration,
                  timeline_in: 0,
                  timeline_out: duration,
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
  opts: {
    withAudio?: boolean;
    endcard?: string;
    branding?: Branding;
    canvas?: { width: number; height: number };
    lossless?: boolean;
  } = {},
): Promise<string> {
  const out = path.join(cwd, `${tag}.mp4`);
  const ratio = brandRatio(W, H);
  const endcard = opts.endcard ?? path.join(BRAND_DIR, endcardFile(ratio));
  const plan = buildRenderCommand(timeline(src, opts.withAudio, opts.canvas), out, {
    branding:
      opts.branding ??
      (branded
        ? {
            watermark: path.join(BRAND_DIR, watermarkFile(ratio)),
            endcard,
            endcardDuration: await durationOf(endcard),
          }
        : undefined),
  });
  const args = [...plan.args];
  if (opts.lossless) {
    expect(args[args.indexOf("-c:v") + 1], "lossless fixture requires libx264").toBe("libx264");
    const crf = args.indexOf("-crf");
    if (crf >= 0) args[crf + 1] = "0";
    else args.splice(args.length - 1, 0, "-crf", "0");
  }
  const r = await run(FF!, args, cwd);
  if (opts.lossless)
    await fsp.writeFile(
      path.join(cwd, `${tag}.render.json`),
      JSON.stringify({ args, stderr: r.stderr }, null, 2),
    );
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
  it.each([12, 24, 25, 30, 60])(
    "delivers every planned end-card frame with and without audio at %i fps",
    async (fps) => {
      const cwd = await scratch();
      const src = await source(cwd, 4.5);
      const endcard = path.join(BRAND_DIR, endcardFile("16x9"));
      const frameCounts: number[] = [];
      for (const withAudio of [false, true]) {
        const file = path.join(cwd, `complete-${fps}-${withAudio}.mp4`);
        const plan = buildRenderCommand(
          timeline(src, withAudio, { width: 320, height: 180 }, 4.5),
          file,
          {
            fps,
            branding: {
              watermark: path.join(BRAND_DIR, watermarkFile("16x9")),
              endcard,
              endcardDuration: await durationOf(endcard),
            },
          },
        );
        const encoded = await run(FF!, plan.args, cwd);
        expect(encoded.code, encoded.stderr.slice(-800)).toBe(0);
        const accepted = await finishRenderJob(mkCtx(cwd), { plan, stagePath: file }, encoded);
        expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
        const counted = await run(FP!, [
          "-v",
          "error",
          "-count_frames",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=nb_read_frames",
          "-of",
          "csv=p=0",
          file,
        ]);
        expect(counted.code, counted.stderr).toBe(0);
        frameCounts.push(Number(counted.stdout.trim()));
        if (fps === 30) expect(frameCounts.at(-1)).toBe(196);
        if (withAudio) {
          const durations = await streamDurations(file);
          expect(Number.isFinite(durations.audio)).toBe(true);
          expect(Math.abs(durations.video - durations.audio)).toBeLessThanOrEqual(1 / fps);
          expect(await meanVolumeDb(file, { ss: 0.5, dur: 0.5 })).toBeGreaterThan(-30);
          expect(await meanVolumeDb(file, { ss: 5.25, dur: 0.5 })).toBeLessThan(-65);
        }
      }
      expect(frameCounts[1]).toBe(frameCounts[0]);
    },
    60_000,
  );

  it("bounds a capped branded export and pads only the card's sound", async () => {
    const cwd = await scratch();
    const src = await source(cwd, 4.5);
    const endcard = path.join(BRAND_DIR, endcardFile("16x9"));
    const file = path.join(cwd, "capped-complete.mp4");
    const plan = buildRenderCommand(timeline(src, true, { width: 320, height: 180 }, 4.5), file, {
      maxDurationSec: 1.5,
      branding: { watermark: null, endcard, endcardDuration: await durationOf(endcard) },
    });
    const encoded = await run(FF!, plan.args, cwd);
    const accepted = await finishRenderJob(mkCtx(cwd), { plan, stagePath: file }, encoded);
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    expect(await durationOf(file)).toBeCloseTo(106 / 30, 2);
    expect(await meanVolumeDb(file, { ss: 0.5, dur: 0.25 })).toBeGreaterThan(-30);
    expect(await meanVolumeDb(file, { ss: 2, dur: 0.25 })).toBeLessThan(-65);
  }, 60_000);

  it("does not conceal an end card that is genuinely shorter than its plan", async () => {
    const cwd = await scratch();
    const src = await source(cwd);
    const endcard = path.join(BRAND_DIR, endcardFile("16x9"));
    const file = path.join(cwd, "short-card.mp4");
    const plan = buildRenderCommand(timeline(src, true, { width: 320, height: 180 }), file, {
      branding: { watermark: null, endcard, endcardDuration: (await durationOf(endcard)) + 1 },
    });
    const encoded = await run(FF!, plan.args, cwd);
    expect(encoded.code, encoded.stderr.slice(-800)).toBe(0);
    const accepted = await finishRenderJob(mkCtx(cwd), { plan, stagePath: file }, encoded);
    expect(accepted.ok).toBe(false);
    expect(String(accepted.error)).toContain("rendered video failed validation");
  }, 60_000);

  it.each([
    { width: 640, height: 360 },
    { width: 480, height: 480 },
    { width: 360, height: 640 },
  ])(
    "a fresh account exemption removes only corner pixels at $width x $height",
    async (canvas) => {
      const cwd = await scratch();
      const src = await source(cwd);
      setClerkTokenProvider(async () => "account-token");
      useAuth.setState({
        status: "unlocked",
        profile: {
          user_id: "user_exempt",
          email: "",
          display_name: "",
          image_url: "",
          metered: true,
        },
      });
      let watermark = true;
      const send = vi.fn(async (url: string) => {
        expect(new URL(url).pathname).toBe("/exports/policy");
        return new Response(JSON.stringify({ user_id: "user_exempt", watermark, end_card: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      vi.stubGlobal("fetch", send);
      const assets = { exists: async (file: string) => existsSync(file) };
      const runner = {
        run: async (program: string, args: string[]) =>
          run(program === "ffprobe" ? FP! : FF!, args),
      };
      const ordinary = await exportBranding(assets, runner, canvas);
      expect(ordinary.branding).not.toBeNull();
      const baseline = await render(cwd, src, true, "ordinary", {
        branding: ordinary.branding!,
        canvas,
        withAudio: true,
      });
      watermark = false;
      const exempt = await exportBranding(assets, runner, canvas);
      expect(exempt.branding).not.toBeNull();
      const clean = await render(cwd, src, true, "exempt", {
        branding: exempt.branding!,
        canvas,
        withAudio: true,
      });
      watermark = true;
      const restored = await exportBranding(assets, runner, canvas);
      const revoked = await render(cwd, src, true, "revoked", {
        branding: restored.branding!,
        canvas,
        withAudio: true,
      });
      const plain = await render(cwd, src, false, "plain-exempt", { canvas });
      const width = Math.round(canvas.width * 0.35);
      const height = Math.round(canvas.height * 0.2);
      const corner = `crop=${width}:${height}:${canvas.width - width}:${canvas.height - height}`;
      const normalCorner = await lumaAt(baseline, DUR / 2, corner);
      const cleanCorner = await lumaAt(clean, DUR / 2, corner);
      expect(normalCorner - cleanCorner).toBeGreaterThan(2);
      expect(cleanCorner).toBeCloseTo(await lumaAt(plain, DUR / 2, corner), 0);
      expect(await lumaAt(revoked, DUR / 2, corner)).toBeCloseTo(normalCorner, 0);
      const total = await durationOf(clean);
      expect(total).toBeCloseTo(await durationOf(baseline), 1);
      expect(total).toBeGreaterThan(DUR + 1);
      const center = `crop=${canvas.width}:${Math.round(canvas.height * 0.15)}:0:${Math.round(canvas.height * 0.425)}`;
      expect(
        Math.abs(
          (await lumaAt(clean, DUR / 2, center)) - (await lumaAt(clean, DUR + (total - DUR) / 2)),
        ),
      ).toBeGreaterThan(20);
      const streams = await streamDurations(clean);
      expect(Math.abs(streams.audio - streams.video)).toBeLessThan(0.2);
      const clip = await render(cwd, src, true, "clip-exempt", {
        branding: { ...exempt.branding!, endcard: null, endcardDuration: 0 },
        canvas,
      });
      expect(await durationOf(clip)).toBeCloseTo(DUR, 1);
      expect(await lumaAt(clip, DUR / 2, corner)).toBeCloseTo(
        await lumaAt(plain, DUR / 2, corner),
        0,
      );
      expect(send).toHaveBeenCalledTimes(3);
    },
    180_000,
  );

  it.each([
    { width: 640, height: 360 },
    { width: 480, height: 480 },
    { width: 360, height: 640 },
  ])(
    "recovers real branded pixels and retains an exempt end card at $width x $height",
    async (canvas) => {
      const cwd = await scratch();
      const src = await source(cwd);
      const cache = await nodeFs.cacheDir!();
      await nodeFs.remove!(path.join(cache, "branding"));
      setClerkTokenProvider(async () => "recovery-token");
      useAuth.setState({
        status: "unlocked",
        profile: {
          user_id: "recovery",
          email: "",
          display_name: "",
          image_url: "",
          metered: true,
        },
      });
      let watermark = true;
      const requested: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const pathname = new URL(url).pathname;
          if (pathname === "/exports/policy")
            return new Response(
              JSON.stringify({ user_id: "recovery", watermark, end_card: true }),
              {
                headers: { "Content-Type": "application/json" },
              },
            );
          expect(pathname).toMatch(
            /^\/exports\/branding\/v1\/(?:endcard|watermark)-(?:16x9|1x1|9x16)\.(?:mp4|png)$/,
          );
          const name = pathname.split("/").at(-1)!;
          requested.push(name);
          return new Response(await fsp.readFile(path.join(BRAND_DIR, name)));
        }),
      );
      const runner = {
        run: async (program: string, args: string[]) =>
          run(program === "ffprobe" ? FP! : FF!, args),
      };
      const recovered = await exportBranding({ exists: async () => false }, runner, canvas);
      expect(recovered.warning).toBeUndefined();
      expect(path.relative(cache, recovered.branding!.watermark!)).toBe(
        path.join("branding", "v1", watermarkFile(brandRatio(canvas.width, canvas.height))),
      );
      expect(path.relative(cache, recovered.branding!.endcard!)).toBe(
        path.join("branding", "v1", endcardFile(brandRatio(canvas.width, canvas.height))),
      );
      const ordinary = await render(cwd, src, true, "recovered", {
        branding: recovered.branding!,
        canvas,
        withAudio: true,
      });
      watermark = false;
      const exempt = await exportBranding({ exists: async () => false }, runner, canvas);
      expect(exempt.warning).toBeUndefined();
      expect(exempt.branding?.watermark).toBeNull();
      expect(requested).toEqual([
        endcardFile(brandRatio(canvas.width, canvas.height)),
        watermarkFile(brandRatio(canvas.width, canvas.height)),
      ]);
      const clean = await render(cwd, src, true, "recovered-exempt", {
        branding: exempt.branding!,
        canvas,
        withAudio: true,
      });
      const plain = await render(cwd, src, false, "recovery-plain", { canvas, withAudio: true });
      const width = Math.round(canvas.width * 0.35),
        height = Math.round(canvas.height * 0.2);
      const corner = `crop=${width}:${height}:${canvas.width - width}:${canvas.height - height}`;
      expect(
        (await lumaAt(ordinary, DUR / 2, corner)) - (await lumaAt(clean, DUR / 2, corner)),
      ).toBeGreaterThan(2);
      expect(await lumaAt(clean, DUR / 2, corner)).toBeCloseTo(
        await lumaAt(plain, DUR / 2, corner),
        0,
      );
      expect(await durationOf(clean)).toBeCloseTo(await durationOf(ordinary), 2);
      expect(await durationOf(clean)).toBeGreaterThan(DUR + 1);
      const center = `crop=${canvas.width}:${Math.round(canvas.height * 0.15)}:0:${Math.round(canvas.height * 0.425)}`;
      expect(
        Math.abs((await lumaAt(clean, DUR / 2, center)) - (await lumaAt(clean, DUR + 1, center))),
      ).toBeGreaterThan(20);
      expect(await meanVolumeDb(clean, { ss: 0.25, dur: 0.5 })).toBeGreaterThan(-30);
      const streams = await streamDurations(clean);
      expect(Math.abs(streams.audio - streams.video)).toBeLessThan(0.2);
    },
    120000,
  );

  it("continues rendering after exhausted branding recovery with an explicit warning", async () => {
    const cwd = await scratch();
    const src = await source(cwd);
    await nodeFs.remove!(path.join(await nodeFs.cacheDir!(), "branding"));
    const request = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", request);
    const result = await exportBranding(
      { exists: async () => false },
      {
        run: async (program, args) => run(program === "ffprobe" ? FP! : FF!, args),
      },
      { width: W, height: H },
    );
    expect(result.branding).toBeNull();
    expect(result.warning).toContain("exported unbranded");
    expect(request).toHaveBeenCalledTimes(4);
    const output = await render(cwd, src, false, "fallback", { withAudio: true });
    expect(await durationOf(output)).toBeCloseTo(DUR, 2);
    expect(await lumaAt(output, 0.5)).toBeCloseTo(await lumaAt(src, 0.5), 0);
    expect(await lumaAt(output, 1.5)).toBeCloseTo(await lumaAt(src, 1.5), 0);
    expect(await meanVolumeDb(output, { ss: 0.25, dur: 0.5 })).toBeGreaterThan(-30);
  }, 60000);

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

  it("keeps chromatic portrait footage unchanged outside the watermark", async () => {
    const cwd = await scratch();
    const src = path.resolve("e2e/ui/fixtures/mac-recording-preview.mp4");
    const canvas = { width: 360, height: 640 };
    const endcard = path.join(BRAND_DIR, endcardFile("9x16"));
    const base = { endcard, endcardDuration: await durationOf(endcard) };
    const branded = await render(cwd, src, true, "chromatic-portrait-branded", {
      canvas,
      withAudio: true,
      lossless: true,
      branding: { ...base, watermark: path.join(BRAND_DIR, watermarkFile("9x16")) },
    });
    const exempt = await render(cwd, src, true, "chromatic-portrait-exempt", {
      canvas,
      withAudio: true,
      lossless: true,
      branding: { ...base, watermark: null },
    });
    const version = await run(FF!, ["-version"]);
    expect(version.code, version.stderr).toBe(0);
    const ffmpegVersion = `${version.stdout}\n${version.stderr}`
      .split(/\r?\n/)
      .find((line) => line.startsWith("ffmpeg version "));
    expect(ffmpegVersion).toMatch(/^ffmpeg version /);
    const rest = "crop=360:384:0:0";
    const corner = "crop=126:128:234:512";
    const measured = {
      brandedRest: await lumaAt(branded, 1.55, rest),
      exemptRest: await lumaAt(exempt, 1.55, rest),
      brandedCorner: await lumaAt(branded, 1.55, corner),
      exemptCorner: await lumaAt(exempt, 1.55, corner),
      videoEncoding: { encoder: "libx264", crf: 0 },
      ffmpegVersion,
      videoStreams: {
        branded: await videoColorInfo(branded),
        exempt: await videoColorInfo(exempt),
      },
    };
    const evidence = path.resolve(
      "reports/qa/exporter/branding",
      `chromatic-portrait-${Date.now()}`,
    );
    await fsp.mkdir(evidence, { recursive: true });
    await fsp.copyFile(branded, path.join(evidence, "branded.mp4"));
    await fsp.copyFile(exempt, path.join(evidence, "exempt.mp4"));
    for (const tag of ["branded", "exempt"])
      await fsp.copyFile(
        path.join(cwd, `chromatic-portrait-${tag}.render.json`),
        path.join(evidence, `${tag}.render.json`),
      );
    await fsp.writeFile(path.join(evidence, "measured.json"), JSON.stringify(measured, null, 2));
    const diagnostic = JSON.stringify(measured, null, 2);
    expect(measured.brandedCorner - measured.exemptCorner, diagnostic).toBeGreaterThan(2);
    // Windows/Linux ffmpeg is 0.52 off with either graph; the macOS RGB round trip this guards against is 1.04 off.
    expect(Math.abs(measured.brandedRest - measured.exemptRest), diagnostic).toBeLessThan(0.75);
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
