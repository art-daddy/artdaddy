// 3j (UJ-023): a timeline clip exported as its own file is the whole export's frames and sound
// over that clip's span: every track, caption, transition and sound there, nothing else. Each case
// renders one timeline twice through buildRenderCommand, whole and as the span, losslessly (x264
// qp 0, PCM), and compares every frame's raw YUV and every audio sample. One frame or one sample
// off fails.
// Run: npx vitest run --config vitest.smoke.config.ts src/timeline/exportRange.smoke.e2e.ts
import { spawn } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ff, mkCtx } from "../tools/__e2e";
import type { ClientToolContext } from "../tools/context";
import { shippedSidecar, shippedSidecarPath } from "../test/sidecars";
import { brandRatio, watermarkFile } from "./branding";
import type { ExportOptions } from "./exportOptions";
import type { Timeline } from "./model";
import { buildRenderCommand, resolveClipSources, runRenderPlan } from "./render";

// Captions only prove anything if libass has the bundled fonts to draw with.
vi.mock("@tauri-apps/api/path", async () => {
  const p = await import("node:path");
  return { resolveResource: async (r: string) => p.resolve(process.cwd(), "src-tauri", r) };
});

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const W = 320;
const H = 180;
const FPS = 30;
const RATE = 48000;
const FRAME_BYTES = (W * H * 3) / 2;
const dir = path.join(os.tmpdir(), `artdaddy-range-${Date.now()}`);
let ctx: ClientToolContext;
const src: Record<string, string> = {};

function ffmpegPath(): string {
  return shippedSidecar("ffmpeg") ?? shippedSidecarPath("ffmpeg");
}

/** ffmpeg's stdout as BYTES. */
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

/** Every frame of a file as raw yuv420p, and its sound as 16-bit PCM at the mix's own rate. */
async function decoded(file: string): Promise<{ frames: Buffer[]; pcm: Buffer }> {
  const yuv = await ffBytes([
    "-i",
    file,
    "-map",
    "0:v",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "yuv420p",
    "-",
  ]);
  const frames: Buffer[] = [];
  for (let o = 0; o + FRAME_BYTES <= yuv.length; o += FRAME_BYTES)
    frames.push(yuv.subarray(o, o + FRAME_BYTES));
  const pcm = await ffBytes(["-i", file, "-map", "0:a", "-f", "s16le", "-"]);
  return { frames, pcm };
}

/** The export's own plan, encoded losslessly so nothing but the graph can differ. */
async function renderLossless(
  tl: Timeline,
  tag: string,
  options: ExportOptions = {},
): Promise<string> {
  const out = path.join(dir, `${tag}.mkv`);
  const plan = buildRenderCommand(tl, out, options);
  const args = [...plan.args];
  args.splice(args.indexOf("-c:v"), 2, "-c:v", "libx264", "-qp", "0", "-preset", "ultrafast");
  args.splice(args.indexOf("-c:a"), 2, "-c:a", "pcm_s16le");
  const f = args.indexOf("-f");
  if (f >= 0 && args[f + 1] === "mp4") args.splice(f, 2, "-f", "matroska");
  const r = await runRenderPlan(ctx, { ...plan, args });
  expect(r.code, r.stderr.slice(-800)).toBe(0);
  return out;
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
function aclip(media: string, tin: number, tout: number, extra: Any = {}): Any {
  return {
    kind: "audio",
    media_ref: media,
    timeline_in: sec(tin),
    timeline_out: sec(tout),
    source_in: 0,
    source_out: sec(tout - tin),
    ...extra,
  };
}

/** The span's file holds exactly the whole export's frames [from, to) and its samples there. */
async function expectSpanOfWhole(
  whole: { frames: Buffer[]; pcm: Buffer },
  tl: Timeline,
  from: number,
  to: number,
  tag: string,
): Promise<void> {
  const span = await decoded(await renderLossless(tl, tag, { range: { from, to } }));
  expect(span.frames.length, `${tag}: frame count`).toBe(to - from);
  for (let k = 0; k < to - from; k++)
    expect(span.frames[k].equals(whole.frames[from + k]), `${tag}: frame ${from + k}`).toBe(true);
  // Moving content, so a span that landed a frame off could not pass the loop above.
  expect(span.frames[0].equals(span.frames[to - from - 1]), `${tag}: frames must differ`).toBe(
    false,
  );
  const bytesPerFrame = (RATE / FPS) * 2 * 2; // stereo s16
  const want = whole.pcm.subarray(from * bytesPerFrame, to * bytesPerFrame);
  expect(span.pcm.length, `${tag}: samples`).toBe(want.length);
  let first = -1;
  for (let i = 0; i < want.length && first < 0; i += 2)
    if (span.pcm.readInt16LE(i) !== want.readInt16LE(i)) first = i;
  expect(
    first,
    `${tag}: sound differs from ${(from + first / bytesPerFrame).toFixed(2)} frames on`,
  ).toBe(-1);
}

beforeAll(async () => {
  await fsp.mkdir(dir, { recursive: true });
  ctx = mkCtx(dir);
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
  // A sticker that plays its six irregular frames forever, so a span opens mid-animation.
  src.gif = path.join(dir, "loops.gif");
  await ff([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=black@0:s=${W}x${H}:r=100:d=0.6,format=rgba[bg];color=c=red:s=40x40:r=100:d=0.6,format=rgba[sq];[bg][sq]overlay=x='n*5':y=70`,
    "-vf",
    "select='eq(n\\,0)+eq(n\\,7)+eq(n\\,20)+eq(n\\,25)+eq(n\\,45)+eq(n\\,52)'",
    "-fps_mode",
    "passthrough",
    src.gif,
  ]);
  const wav = (name: string, graph: string): Promise<void> =>
    ff(["-y", "-f", "lavfi", "-i", graph, "-ac", "2", "-c:a", "pcm_s16le", path.join(dir, name)]);
  src.music = path.join(dir, "music.wav");
  await wav("music.wav", `sine=frequency=220:sample_rate=${RATE}:duration=14`);
  // Half-second bursts: the music ducks under each one, so the ducker's state at a span's start
  // depends on what came before it.
  src.voice = path.join(dir, "voice.wav");
  await wav(
    "voice.wav",
    `sine=frequency=880:sample_rate=${RATE}:duration=14,volume='if(lt(mod(t,1),0.5),1,0)':eval=frame`,
  );
});

afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("a clip exported on its own is the whole export over its span", () => {
  // Cuts, a centred crossfade, a retimed clip, an animated still and a caption crossing the span's
  // edges, and music ducked under a voice that started before the span.
  const busy = (): Timeline =>
    timeline([
      track("v", 0, [
        vclip(src.a, 0, 150, 0),
        vclip(src.b, 150, 300, 30, { transition_in: { kind: "crossfade", duration: sec(16) } }),
        vclip(src.a, 300, 390, 100, { speed: 1.5 }),
      ]),
      track("top", 1, [
        {
          media_ref: src.gif,
          timeline_in: sec(120),
          timeline_out: sec(260),
          transform: { scale: 0.5, position: { x: 0.75, y: 0.5 } },
        },
      ]),
      track(
        "cap",
        2,
        [
          {
            kind: "text",
            text: "Over the cut",
            timeline_in: sec(140),
            timeline_out: sec(220),
            style: { color: "white", font: "Poppins", fontsize: 28 },
          },
        ],
        "text",
      ),
      track(
        "music",
        0,
        [aclip(src.music, 0, 390, { fade: { in: 15, out: 15 }, duck: { against: "vo" } })],
        "audio",
      ),
      track("vo", 0, [aclip(src.voice, 100, 250)], "audio"),
    ]);

  let whole: { frames: Buffer[]; pcm: Buffer };
  let tl: Timeline;
  beforeAll(async () => {
    tl = busy();
    expect(await resolveClipSources(ctx, tl), "nothing unresolved").toEqual([]);
    whole = await decoded(await renderLossless(tl, "whole"));
    expect(whole.frames.length).toBe(390);
  });

  it("the span of a clip that opens on a crossfade, under a caption and a sticker", async () => {
    await expectSpanOfWhole(whole, tl, 150, 300, "clipB");
  });

  it("a span at the very start and one at the very end", async () => {
    await expectSpanOfWhole(whole, tl, 0, 60, "head");
    await expectSpanOfWhole(whole, tl, 330, 390, "tail");
  });

  it("a span that starts and ends on odd frames, inside clips", async () => {
    await expectSpanOfWhole(whole, tl, 143, 211, "odd");
  });
});

const BRAND_DIR = path.resolve(process.cwd(), "src-tauri/resources/brand");
const FP = shippedSidecar("ffprobe");

describe.runIf(FP && existsSync(path.join(BRAND_DIR, watermarkFile("16x9"))))(
  "a clip export carries the watermark and no end card",
  () => {
    function probe(file: string): Promise<{ video: number; audio: number }> {
      return new Promise((resolve, reject) => {
        const child = spawn(
          FP!,
          ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", file],
          { windowsHide: true },
        );
        let out = "";
        child.stdout.on("data", (d) => (out += String(d)));
        child.on("error", reject);
        child.on("close", () => {
          const s = (JSON.parse(out).streams ?? []) as { codec_type?: string; duration?: string }[];
          resolve({
            video: Number(s.find((x) => x.codec_type === "video")?.duration),
            audio: Number(s.find((x) => x.codec_type === "audio")?.duration),
          });
        });
      });
    }

    it("lasts exactly its span, sound included, with the bug burned in", async () => {
      const BW = 640;
      const BH = 360;
      const grey = path.join(dir, "grey.mp4");
      await ff([
        "-y",
        "-f",
        "lavfi",
        "-i",
        `color=c=gray:s=${BW}x${BH}:r=30:d=6`,
        "-pix_fmt",
        "yuv420p",
        grey,
      ]);
      const tl = {
        canvas: { width: BW, height: BH, fps: FPS },
        tracks: [
          track("v", 0, [vclip(grey, 0, 180, 0)]),
          track("music", 0, [aclip(src.music, 0, 180)], "audio"),
        ],
      } as unknown as Timeline;
      const wm = path.join(BRAND_DIR, watermarkFile(brandRatio(BW, BH)));
      const render = async (tag: string, branded: boolean): Promise<string> => {
        const out = path.join(dir, `${tag}.mp4`);
        const plan = buildRenderCommand(tl, out, {
          range: { from: 30, to: 90 },
          ...(branded ? { branding: { watermark: wm, endcard: null, endcardDuration: 0 } } : {}),
        });
        const r = await runRenderPlan(ctx, plan);
        expect(r.code, r.stderr.slice(-800)).toBe(0);
        return out;
      };
      const plain = await render("wm_plain", false);
      const marked = await render("wm_marked", true);

      // Two seconds: the span, and no end card after it.
      const d = await probe(marked);
      expect(d.video).toBeGreaterThan(1.95);
      expect(d.video).toBeLessThan(2.05);
      expect(Math.abs(d.audio - d.video)).toBeLessThan(0.05);

      // The bug sits bottom-right and nowhere else.
      const yOf = async (file: string): Promise<Buffer> =>
        ffBytes([
          "-ss",
          "1",
          "-i",
          file,
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "gray",
          "-",
        ]);
      const [p, m] = [await yOf(plain), await yOf(marked)];
      const mean = (b: Buffer, x0: number, y0: number, x1: number, y1: number): number => {
        let s = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s += b[y * BW + x];
        return s / ((x1 - x0) * (y1 - y0));
      };
      const corner = [Math.round(BW * 0.65), Math.round(BH * 0.8), BW, BH] as const;
      expect(mean(m, ...corner) - mean(p, ...corner), "no bug in the corner").toBeGreaterThan(2);
      const rest = [0, 0, BW, Math.round(BH * 0.6)] as const;
      expect(Math.abs(mean(m, ...rest) - mean(p, ...rest))).toBeLessThan(0.5);
    });
  },
);
