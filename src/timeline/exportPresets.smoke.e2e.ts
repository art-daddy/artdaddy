// Export delivery presets, through the BUNDLED ffmpeg and against the real file it writes.
//
// This lane exists because the unit tests could not have caught the bug that shipped here: the
// scale was emitted as `-vf`, which ffmpeg REFUSES to combine with a `-map` out of a
// `-filter_complex` (EINVAL, -22, before a single frame is encoded). The args string looked
// perfectly reasonable. Only running it told the truth.
//
// NOT part of the unit suite: `npx vitest run --config vitest.smoke.config.ts`.
import { spawn } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

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

function bundledFfprobe(): string | null {
  const dir = path.resolve(process.cwd(), "src-tauri/binaries");
  const names =
    process.platform === "win32"
      ? ["ffprobe-x86_64-pc-windows-msvc.exe"]
      : process.platform === "darwin"
        ? ["ffprobe-aarch64-apple-darwin", "ffprobe-x86_64-apple-darwin"]
        : ["ffprobe-x86_64-unknown-linux-gnu"];
  for (const n of names) {
    const p = path.join(dir, n);
    if (existsSync(p)) return p;
  }
  return null;
}
const FP = bundledFfprobe();

function run(
  program: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

const scratches: string[] = [];
async function scratch(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-export-"));
  scratches.push(d);
  return d;
}
afterAll(async () => {
  for (const d of scratches)
    await fsp.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const CANVAS = { width: 1280, height: 720, fps: 30 };

async function source(dir: string): Promise<string> {
  const src = path.join(dir, "src.mp4");
  const r = await run(FF!, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=1280x720:rate=30:duration=2",
    "-pix_fmt",
    "yuv420p",
    src,
  ]);
  expect(r.code, `source render failed: ${r.stderr.slice(-400)}`).toBe(0);
  return src;
}

function timeline(src: string): Timeline {
  return {
    canvas: CANVAS,
    tracks: [
      {
        id: "v0",
        kind: "video",
        z: 0,
        clips: [
          {
            id: "a",
            kind: "video",
            media_ref: src,
            timeline_in: 0,
            timeline_out: 60,
            source_in: 0,
            source_out: 60,
          },
        ],
      },
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** Actual encoded dimensions + frame rate of a written file. */
async function probe(file: string): Promise<{ w: number; h: number; fps: number }> {
  const r = await run(FP!, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,r_frame_rate",
    "-of",
    "default=noprint_wrappers=1",
    file,
  ]);
  const get = (k: string) => new RegExp(`${k}=(.+)`).exec(r.stdout)?.[1]?.trim() ?? "";
  const [num, den] = get("r_frame_rate").split("/");
  return {
    w: Number(get("width")),
    h: Number(get("height")),
    fps: Math.round(Number(num) / Number(den || 1)),
  };
}

const maybe = FF && FP ? describe : describe.skip;

maybe("export delivery presets (real ffmpeg)", () => {
  it("renders at the project's own size with no options", async () => {
    const dir = await scratch();
    const src = await source(dir);
    const out = path.join(dir, "src-size.mp4");
    const plan = buildRenderCommand(timeline(src), out);
    const r = await run(FF!, plan.args);
    expect(r.code, `render failed: ${r.stderr.slice(-600)}`).toBe(0);
    expect(await probe(out)).toEqual({ w: 1280, h: 720, fps: 30 });
  }, 120_000);

  it("actually writes the requested resolution, not just the requested ARGS", async () => {
    // The regression: this exact command was rejected with EINVAL because the scale went
    // through `-vf`. Asserting the args contained "scale=" would have passed anyway.
    const dir = await scratch();
    const src = await source(dir);
    const out = path.join(dir, "480p.mp4");
    const plan = buildRenderCommand(timeline(src), out, { resolution: "480p" });
    const r = await run(FF!, plan.args);
    expect(r.code, `render failed: ${r.stderr.slice(-600)}`).toBe(0);
    const p = await probe(out);
    expect(p.h).toBe(480);
    expect(p.w).toBe(854); // 1280x720 -> short side 480, aspect kept, rounded even
  }, 120_000);

  it("honours a frame-rate override in the written file", async () => {
    const dir = await scratch();
    const src = await source(dir);
    const out = path.join(dir, "24fps.mp4");
    const plan = buildRenderCommand(timeline(src), out, { fps: 24 });
    const r = await run(FF!, plan.args);
    expect(r.code, `render failed: ${r.stderr.slice(-600)}`).toBe(0);
    expect((await probe(out)).fps).toBe(24);
  }, 120_000);

  it("makes a low-quality export SMALLER than a high-quality one", async () => {
    // The outcome the setting promises, rather than "-crf appeared in the args".
    const dir = await scratch();
    const src = await source(dir);
    const hi = path.join(dir, "hi.mp4");
    const lo = path.join(dir, "lo.mp4");
    const a = await run(FF!, buildRenderCommand(timeline(src), hi, { quality: "high" }).args);
    const b = await run(FF!, buildRenderCommand(timeline(src), lo, { quality: "low" }).args);
    expect(a.code, a.stderr.slice(-400)).toBe(0);
    expect(b.code, b.stderr.slice(-400)).toBe(0);
    const [sa, sb] = [(await fsp.stat(hi)).size, (await fsp.stat(lo)).size];
    expect(sb).toBeLessThan(sa);
  }, 180_000);

  it("emits the -progress stream the dialog reads", async () => {
    // The bar is fed by ffmpeg's stdout. If the flags ever stop being emitted, the dialog goes
    // silent and nothing else in the suite would notice.
    const dir = await scratch();
    const src = await source(dir);
    const out = path.join(dir, "prog.mp4");
    const plan = buildRenderCommand(timeline(src), out);
    expect(plan.args).toContain("-progress");
    const r = await run(FF!, plan.args);
    expect(r.code, r.stderr.slice(-400)).toBe(0);
    expect(r.stdout).toMatch(/progress=(continue|end)/);
    expect(r.stdout).toMatch(/out_time_us=\d+/);
  }, 120_000);
});
