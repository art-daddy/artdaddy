// Q7 probe: does the LAST timeline frame of a sped-up clip render black?
//
// Reported live: a clip at speed 1.2 rendered frame 909 pure black while 908 was fine. The
// hypothesis is that `length * speed` is not an integer, so the last timeline frame falls past
// the end of the retimed stream and the black base shows through. Measured on real pixels,
// because the filtergraph containing `setpts` proves nothing about what came out.
import { spawn } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { Clip, Timeline } from "./model";
import { buildRenderCommand } from "./render";

function bundled(name: string): string | null {
  const dir = path.resolve(process.cwd(), "src-tauri/binaries");
  const suffix =
    process.platform === "win32"
      ? "-x86_64-pc-windows-msvc.exe"
      : process.platform === "darwin"
        ? "-aarch64-apple-darwin"
        : "-x86_64-unknown-linux-gnu";
  const p = path.join(dir, `${name}${suffix}`);
  return existsSync(p) ? p : null;
}
const FF = bundled("ffmpeg");
const FP = bundled("ffprobe");

function run(program: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += String(d)));
    child.stderr?.on("data", (d) => (err += String(d)));
    child.on("error", (e) => resolve({ code: -1, out, err: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

const scratches: string[] = [];
async function scratch(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-q7-"));
  scratches.push(d);
  return d;
}
afterAll(async () => {
  for (const d of scratches)
    await fsp.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const FPS = 30;

/** A WHITE source: any black frame in the output therefore came from the compositor, not the media. */
async function whiteSource(dir: string, seconds: number): Promise<string> {
  const src = path.join(dir, "white.mp4");
  const r = await run(FF!, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=white:s=320x240:r=${FPS}:d=${seconds}`,
    "-pix_fmt",
    "yuv420p",
    src,
  ]);
  expect(r.code, r.err.slice(-300)).toBe(0);
  return src;
}

/** Mean luma of one frame, read back from the artifact. 0 = black, 255 = white. */
async function lumaAtFrame(file: string, frame: number): Promise<number> {
  const r = await run(FF!, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    file,
    "-vf",
    `select='eq(n\\,${frame})',signalstats,metadata=print:file=-`,
    "-frames:v",
    "1",
    "-f",
    "null",
    "-",
  ]);
  const m = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(r.out + r.err);
  expect(m, `no YAVG for frame ${frame}: ${(r.out + r.err).slice(-400)}`).toBeTruthy();
  return Number(m![1]);
}

async function frameCount(file: string): Promise<number> {
  const r = await run(FP!, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-count_frames",
    "-show_entries",
    "stream=nb_read_frames",
    "-of",
    "default=nk=1:nw=1",
    file,
  ]);
  return Number(r.out.trim());
}

function spedUpTimeline(src: string, srcFrames: number, speed: number): Timeline {
  // Seconds view: buildRenderCommand consumes seconds, so a "frame" here is n/FPS.
  const lengthFrames = Math.round(srcFrames / speed);
  const clip = {
    id: "a",
    kind: "video",
    media_ref: src,
    timeline_in: 0,
    timeline_out: lengthFrames / FPS,
    source_in: 0,
    source_out: srcFrames / FPS,
    speed,
  } as unknown as Clip;
  return {
    canvas: { width: 320, height: 240, fps: FPS },
    tracks: [{ id: "v1", kind: "video", z: 0, clips: [clip] }],
  } as unknown as Timeline;
}

describe.runIf(FF && FP)("the last frame of a sped-up clip", () => {
  // 206 source frames at 1.2x is 171.67 timeline frames, which rounds UP to 172 — the reported
  // shape exactly. The 172nd frame has no retimed source behind it.
  it("is not black when length*speed does not divide evenly (repro of the 1.2x black frame)", async () => {
    const dir = await scratch();
    const srcFrames = 206;
    const src = await whiteSource(dir, srcFrames / FPS);
    const out = path.join(dir, "out.mp4");

    const plan = buildRenderCommand(spedUpTimeline(src, srcFrames, 1.2), out);
    const r = await run(FF!, plan.args);
    expect(r.code, r.err.slice(-600)).toBe(0);

    const n = await frameCount(out);
    expect(n).toBe(172); // 206 source frames / 1.2, rounded — the slot the black frame fell in

    const last = await lumaAtFrame(out, n - 1);
    const prev = await lumaAtFrame(out, n - 2);
    // The source is pure white throughout. A dark final frame means the compositor ran out of
    // retimed source and exposed its own background.
    expect(prev).toBeGreaterThan(200);
    expect(last, `last frame luma ${last} vs previous ${prev}`).toBeGreaterThan(200);
  });

  it("is not black at a speed that divides evenly either (control)", async () => {
    const dir = await scratch();
    const srcFrames = 200;
    const src = await whiteSource(dir, srcFrames / FPS);
    const out = path.join(dir, "out2.mp4");

    const plan = buildRenderCommand(spedUpTimeline(src, srcFrames, 2), out);
    expect((await run(FF!, plan.args)).code).toBe(0);

    const n = await frameCount(out);
    expect(await lumaAtFrame(out, n - 1)).toBeGreaterThan(200);
  });
});
