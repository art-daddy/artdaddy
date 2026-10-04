// Phase 2 (UJ-012): a look at ONE frame renders a window around that frame, never the timeline from
// frame 0, and it must still be exactly what the export shows at that instant. Every case renders the
// same timeline twice through buildRenderCommand: the full graph (lossless, the reference) and the
// frame window. It then compares raw YUV bytes. A difference of one source frame fails.
// Run: npx vitest run --config vitest.smoke.config.ts src/timeline/frameWindow.smoke.e2e.ts
import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ff, mkCtx } from "../tools/__e2e";
import type { ClientToolContext } from "../tools/context";
import { shippedSidecar, shippedSidecarPath } from "../test/sidecars";
import type { Timeline } from "./model";
import { buildRenderCommand, runRenderPlan } from "./render";

// Captions only prove anything if libass has the bundled fonts to draw with.
vi.mock("@tauri-apps/api/path", async () => {
  const p = await import("node:path");
  return { resolveResource: async (r: string) => p.resolve(process.cwd(), "src-tauri", r) };
});

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const W = 320;
const H = 180;
const FPS = 30;
const dir = path.join(os.tmpdir(), `artdaddy-framewin-${Date.now()}`);
let ctx: ClientToolContext;
const src: Record<string, string> = {};

/** ffmpeg's stdout as BYTES (the shared runner decodes stdout as text). */
function ffBytes(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ["-hide_banner", "-loglevel", "error", ...args], {
      windowsHide: true,
    });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg ${code}: ${err}`)),
    );
  });
}

/** The ffmpeg the app ships. */
function ffmpegPath(): string {
  return shippedSidecar("ffmpeg") ?? shippedSidecarPath("ffmpeg");
}

/** Frame `n` of a rendered file as raw yuv420p bytes. */
async function yuvOf(file: string, n: number): Promise<Buffer> {
  return ffBytes([
    "-i",
    file,
    "-vf",
    `select=eq(n\\,${n})`,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "yuv420p",
    "-",
  ]);
}

/** The export's own graph, rendered losslessly, then frame `n` of it. */
async function referenceFrames(
  tl: Timeline,
  frames: number[],
  tag: string,
  singleThread = false,
): Promise<Map<number, Buffer>> {
  const out = path.join(dir, `${tag}_full.mkv`);
  const plan = buildRenderCommand(tl, out, {});
  const args = threads([...plan.args], singleThread);
  const i = args.indexOf("-c:v");
  args.splice(i, 2, "-c:v", "libx264", "-qp", "0", "-preset", "ultrafast");
  const r = await runRenderPlan(ctx, { ...plan, args });
  expect(r.code, r.stderr.slice(-600)).toBe(0);
  const got = new Map<number, Buffer>();
  for (const f of new Set(frames.flatMap((f) => [f, f + 1]))) got.set(f, await yuvOf(out, f));
  return got;
}

/** A blend-mode clip with opacity is not deterministic in ffmpeg's threaded filtering: three
 *  renders of the same export graph differed by up to 10 levels; with one filter thread they were
 *  identical. That case compares both sides single-threaded, so it still catches a wrong frame. */
function threads(args: string[], single: boolean): string[] {
  if (single) args.splice(1, 0, "-filter_threads", "1", "-filter_complex_threads", "1");
  return args;
}

/** The frame window: one frame, written as raw yuv420p so nothing converts it. */
async function windowFrame(
  tl: Timeline,
  frame: number,
  tag: string,
  singleThread = false,
): Promise<Buffer> {
  const out = path.join(dir, `${tag}_w${frame}.yuv`);
  const plan = buildRenderCommand(
    tl,
    out,
    {},
    {
      frame,
      outputArgs: ["-f", "rawvideo", "-pix_fmt", "yuv420p"],
    },
  );
  const r = await runRenderPlan(ctx, { ...plan, args: threads([...plan.args], singleThread) });
  expect(r.code, r.stderr.slice(-600)).toBe(0);
  return fsp.readFile(out);
}

function maxDiff(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

/** Every sampled frame equals the export's; and the export's NEXT frame differs from it, so a window
 *  that landed one frame off could not pass. `moving: false` for content that does not move. */
async function expectSameAsExport(
  tag: string,
  tl: Timeline,
  frames: number[],
  o: { tolerance?: number; moving?: boolean; singleThread?: boolean } = {},
): Promise<void> {
  const ref = await referenceFrames(tl, frames, tag, o.singleThread);
  let distinguishable = 0;
  for (const f of frames) {
    const w = await windowFrame(tl, f, tag, o.singleThread);
    expect(w.length, `${tag} frame ${f}: size`).toBe((W * H * 3) / 2);
    expect(maxDiff(w, ref.get(f)!), `${tag} frame ${f}`).toBeLessThanOrEqual(o.tolerance ?? 0);
    if (maxDiff(ref.get(f)!, ref.get(f + 1)!) > (o.tolerance ?? 0)) distinguishable++;
  }
  if (o.moving !== false) expect(distinguishable, `${tag}: frames must differ`).toBeGreaterThan(0);
}

const sec = (frames: number): number => frames / FPS;
const track = (id: string, z: number, clips: Any[], kind = "video"): Any => ({
  id,
  kind,
  z,
  clips,
});
const timeline = (tracks: Any[]): Timeline =>
  ({ canvas: { width: W, height: H, fps: FPS }, tracks }) as Timeline;
/** A video clip by FRAMES, in the seconds view buildRenderCommand reads. */
function vclip(media: string, tin: number, tout: number, srcIn = 0, extra: Any = {}): Any {
  const speed = extra.speed ?? 1;
  return {
    media_ref: media,
    timeline_in: sec(tin),
    timeline_out: sec(tout),
    source_in: sec(srcIn),
    source_out: sec(srcIn + (tout - tin) * speed),
    ...extra,
  };
}

beforeAll(async () => {
  await fsp.mkdir(dir, { recursive: true });
  ctx = mkCtx(dir);
  // Long GOPs, so a seek really has to decode forward from a keyframe that is seconds away.
  const enc = ["-c:v", "libx264", "-g", "120", "-pix_fmt", "yuv420p"];
  src.a = path.join(dir, "a.mp4");
  await ff([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${W}x${H}:rate=30:duration=14`,
    ...enc,
    src.a,
  ]);
  src.b = path.join(dir, "b.mp4");
  await ff([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${W}x${H}:rate=30:duration=14,hue=h=140`,
    ...enc,
    src.b,
  ]);
  src.c60 = path.join(dir, "c60.mp4");
  await ff([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${W}x${H}:rate=60:duration=14`,
    ...enc,
    src.c60,
  ]);
  src.still = path.join(dir, "still.png");
  await ff([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=480x360:rate=1",
    "-frames:v",
    "1",
    src.still,
  ]);
  // A screen recording with nothing to send for a second: frames 100-129 are missing, and the
  // export repeats frame 99 through the gap.
  src.vfr = path.join(dir, "vfr.mp4");
  await ff([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${W}x${H}:rate=30:duration=14`,
    "-vf",
    "select='not(between(n,100,129))'",
    "-fps_mode",
    "passthrough",
    ...enc,
    src.vfr,
  ]);
});

afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("a frame window is the export's frame at that instant", () => {
  it("plain cuts, deep into a clip and right at its edges", async () => {
    const tl = timeline([
      track("v", 0, [
        vclip(src.a, 0, 150, 0),
        vclip(src.b, 150, 300, 60),
        vclip(src.a, 300, 390, 240),
      ]),
    ]);
    await expectSameAsExport("cuts", tl, [0, 1, 74, 148, 149, 150, 151, 299, 300, 301, 389]);
  });

  it("a centred crossfade: inside the lead-in, at the cut, and after it", async () => {
    const b = vclip(src.b, 150, 300, 30, {
      transition_in: { kind: "crossfade", duration: sec(16) },
    });
    const tl = timeline([track("v", 0, [vclip(src.a, 0, 150, 0), b])]);
    await expectSameAsExport("xfade", tl, [100, 141, 142, 145, 149, 150, 151, 157, 158, 200, 299]);
  });

  it("whip, wipe and dip transitions", async () => {
    const tl = timeline([
      track("v", 0, [
        vclip(src.a, 0, 90, 0),
        vclip(src.b, 90, 180, 0, { transition_in: { kind: "whip", duration: sec(12) } }),
        vclip(src.a, 180, 270, 120, { transition_in: { kind: "wipe-l", duration: sec(10) } }),
        vclip(src.b, 270, 360, 200, { transition_in: { kind: "dip-to-black", duration: sec(14) } }),
      ]),
    ]);
    await expectSameAsExport("trans", tl, [86, 90, 93, 177, 182, 265, 268, 270, 275, 330]);
  });

  it("keyframed position, scale, opacity and rotation over a base layer", async () => {
    const top = vclip(src.b, 30, 270, 15, {
      transform: {
        position: {
          x: [
            { t: 0, v: 0.25 },
            { t: sec(240), v: 0.75 },
          ],
          y: 0.5,
        },
        scale: [
          { t: 0, v: 0.4 },
          { t: sec(240), v: 0.8 },
        ],
      },
      opacity: [
        { t: 0, v: 0.3 },
        { t: sec(120), v: 1 },
      ],
      rotate: [
        { t: 0, v: 0 },
        { t: sec(240), v: 45 },
      ],
    });
    const tl = timeline([track("base", 0, [vclip(src.a, 0, 300, 0)]), track("top", 1, [top])]);
    await expectSameAsExport("keys", tl, [30, 31, 77, 150, 151, 268, 269]);
  });

  it("speed 1.5 and speed 0.5 clips", async () => {
    const tl = timeline([
      track("v", 0, [
        vclip(src.a, 0, 120, 0, { speed: 1.5 }),
        vclip(src.b, 120, 240, 30, { speed: 0.5 }),
      ]),
    ]);
    await expectSameAsExport("speed", tl, [0, 1, 59, 118, 119, 120, 121, 200, 239]);
  });

  it("a 60 fps source on a 30 fps canvas, deep in", async () => {
    const tl = timeline([track("v", 0, [vclip(src.c60, 0, 330, 61)])]);
    await expectSameAsExport("fps60", tl, [0, 33, 101, 271, 329]);
  });

  it("a variable-frame-rate source, sampled inside a one-second gap in its frames", async () => {
    const tl = timeline([track("v", 0, [vclip(src.vfr, 0, 300, 0)])]);
    await expectSameAsExport("vfr", tl, [95, 105, 120, 129, 130, 131, 200]);
  });

  it("a still with a Ken Burns zoom", async () => {
    const tl = timeline([
      track("v", 0, [
        {
          media_ref: src.still,
          timeline_in: 0,
          timeline_out: sec(240),
          transform: {
            scale: [
              { t: 0, v: 1 },
              { t: sec(240), v: 1.6 },
            ],
          },
        },
      ]),
    ]);
    await expectSameAsExport("kenburns", tl, [0, 100, 101, 238, 239]);
  });

  it("captions: plain, phrase-chunks and word-highlight, over video", async () => {
    const style = { color: "white", font: "Poppins", fontsize: 28 };
    const captions = track(
      "cap",
      1,
      [
        { kind: "text", text: "Plain caption", timeline_in: sec(30), timeline_out: sec(90), style },
        {
          kind: "text",
          content: [
            { text: "one two", t_in: 0, t_out: 1 },
            { text: "THREE", t_in: 1, t_out: 2, emphasis: true },
          ],
          timeline_in: sec(90),
          timeline_out: sec(150),
          animation: { build: "phrase-chunks", timing: "explicit" },
          style,
        },
        {
          kind: "text",
          content: [
            { text: "ALPHA", t_in: 0, t_out: 1 },
            { text: "BETA", t_in: 1, t_out: 2 },
          ],
          timeline_in: sec(150),
          timeline_out: sec(210),
          animation: {
            build: "word-highlight",
            timing: "explicit",
            emphasis: { kind: "color", color: "#ffd400" },
          },
          style,
        },
      ],
      "text",
    );
    const tl = timeline([track("v", 0, [vclip(src.a, 0, 240, 0)]), captions]);
    await expectSameAsExport("captions", tl, [30, 60, 89, 90, 119, 120, 150, 165, 195, 209]);
  });

  it("a blend mode, a glow and motion blur", async () => {
    const top = vclip(src.b, 0, 240, 40, { blend: "screen" });
    const glowy = vclip(src.a, 240, 330, 100, { glow: 0.6 });
    const blur = vclip(src.b, 330, 420, 200, {
      effects: [{ type: "motion", params: { frames: 6 } }],
    });
    const tl = timeline([
      track("base", 0, [vclip(src.a, 0, 240, 0), glowy, blur]),
      track("top", 1, [top]),
    ]);
    await expectSameAsExport("fx", tl, [10, 200, 239, 260, 329, 330, 333, 336, 400]);
  });

  it("a blend mode with opacity (compared single-threaded; see threads())", async () => {
    const top = vclip(src.b, 0, 240, 40, { blend: "screen", opacity: 0.8 });
    const tl = timeline([track("base", 0, [vclip(src.a, 0, 240, 0)]), track("top", 1, [top])]);
    await expectSameAsExport("blendop", tl, [10, 100, 239], { singleThread: true });
  });

  // Windows used to render such a clip from its first frame: rotate's size came from it. Since
  // UJ-007 everything before the zoom runs at the box's peak size, so a window seeks in like any other.
  it("a zooming clip that also rotates, deep in", async () => {
    const spin = vclip(src.b, 0, 330, 30, {
      transform: {
        scale: [
          { t: 0, v: 0.4 },
          { t: sec(330), v: 0.9 },
        ],
      },
      rotate: 20,
    });
    const tl = timeline([track("base", 0, [vclip(src.a, 0, 330, 0)]), track("top", 1, [spin])]);
    await expectSameAsExport("zoomrot", tl, [5, 160, 320]);
  });

  it("denoise is temporal, so a window may differ by a little, never by a frame", async () => {
    const tl = timeline([
      track("v", 0, [
        vclip(src.a, 0, 300, 0, { effects: [{ type: "denoise", params: { strength: 4 } }] }),
      ]),
    ]);
    await expectSameAsExport("denoise", tl, [12, 150, 290], { tolerance: 3 });
  });
});
