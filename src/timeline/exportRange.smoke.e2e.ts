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

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ff, mkCtx } from "../tools/__e2e";
import type { ClientToolContext } from "../tools/context";
import { shippedSidecar, shippedSidecarPath } from "../test/sidecars";
import { FakeJobs } from "../test/fakeJobs";
import { supervisedRunner } from "../tools/jobSupervisor";
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
  native = false,
): Promise<string> {
  const out = path.join(dir, `${tag}.mkv`);
  const plan = buildRenderCommand(tl, out, options);
  const args = [...plan.args];
  args.splice(args.indexOf("-c:v"), 2, "-c:v", "libx264", "-qp", "0", "-preset", "ultrafast");
  args.splice(args.indexOf("-c:a"), 2, "-c:a", "pcm_s16le");
  const f = args.indexOf("-f");
  if (f >= 0 && args[f + 1] === "mp4") args.splice(f, 2, "-f", "matroska");
  let renderContext = ctx;
  if (native) {
    const jobs = new FakeJobs();
    jobs.onStart = async (spec) => {
      try {
        const file = path.join(spec.cwd!, "native-spec.json");
        await fsp.writeFile(file, JSON.stringify(spec));
        const result = await new Promise<{ code: number | null; stderr: string }>(
          (resolve, reject) => {
            const child = spawn(
              "cargo",
              [
                "test",
                "--lib",
                "jobs::tests::render_sequence_real_artifact",
                "--",
                "--ignored",
                "--exact",
                "--nocapture",
              ],
              {
                cwd: path.resolve(process.cwd(), "src-tauri"),
                env: {
                  ...process.env,
                  ARTDADDY_QA_RENDER_SPEC: file,
                  ARTDADDY_QA_FFMPEG: ffmpegPath(),
                },
                windowsHide: true,
              },
            );
            let stderr = "";
            child.stdout.on("data", (chunk) => {
              stderr += String(chunk);
            });
            child.stderr.on("data", (chunk) => {
              stderr += String(chunk);
            });
            child.on("error", reject);
            child.on("close", (code) => resolve({ code, stderr }));
          },
        );
        jobs.exit(spec.id, result.code, result.stderr);
      } catch (error) {
        jobs.exit(spec.id, -1, String(error));
      }
    };
    renderContext = {
      ...ctx,
      runner: supervisedRunner(ctx.runner, jobs, { id: `real-${tag}`, lane: "export", meta: {} }),
    };
  }
  const r = await runRenderPlan(renderContext, { ...plan, args });
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
  src.stereo = path.join(dir, "stereo.wav");
  await wav("stereo.wav", `aevalsrc=0.10*sin(2*PI*440*t)|0.08*sin(2*PI*880*t):s=${RATE}:d=14`);
});

afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("long timelines stay renderable on Windows", () => {
  it.each(["whole", "range", "branded"])(
    "capped %s output declares and emits only its requested span",
    async (kind) => {
      const tl = timeline([
        track("v", 0, [vclip(src.a, 0, 90)]),
        track("music", 0, [aclip(src.stereo, 0, 90)], "audio"),
      ]);
      const options: ExportOptions = { maxDurationSec: 1 };
      if (kind === "range") options.range = { from: 30, to: 90 };
      if (kind === "branded") {
        const card = path.join(dir, "capped-card.mp4");
        await ff([
          "-y",
          "-f",
          "lavfi",
          "-i",
          `color=white:s=${W}x${H}:r=${FPS}:d=1`,
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          card,
        ]);
        options.branding = { watermark: null, endcard: card, endcardDuration: 1 };
      }
      const plan = buildRenderCommand(tl, path.join(dir, `capped-${kind}.mkv`), options);
      const output = await decoded(await renderLossless(tl, `capped-${kind}`, options));
      const expectedFrames = kind === "branded" ? 60 : 30;
      expect(plan.duration * FPS).toBe(expectedFrames);
      expect(output.frames).toHaveLength(expectedFrames);
      expect(output.pcm.length).toBe((expectedFrames * RATE * 2 * 2) / FPS);
      const reference = await decoded(await renderLossless(tl, `capped-${kind}-reference`));
      const first = kind === "range" ? 30 : 0;
      for (let frame = 0; frame < 30; frame++)
        expect(
          output.frames[frame].equals(reference.frames[first + frame]),
          `main frame ${frame}`,
        ).toBe(true);
      const start = (first * RATE * 2 * 2) / FPS;
      expect(
        output.pcm
          .subarray(0, RATE * 2 * 2)
          .equals(reference.pcm.subarray(start, start + RATE * 2 * 2)),
      ).toBe(true);
      if (kind === "branded") {
        expect(
          output.frames[45][Math.floor((W * H) / 2)],
          "end card paints after the capped main span",
        ).toBeGreaterThan(200);
        expect(
          output.pcm.subarray(RATE * 2 * 2).every((byte) => byte === 0),
          "card carries silence, not the unrendered source tail",
        ).toBe(true);
      }
    },
    60_000,
  );

  it("delivers all 349 clips at long source paths, in order, with the full stereo mix", async () => {
    const mediaDir = path.join(dir, `original-export-${"project-".repeat(10)}`);
    await fsp.mkdir(mediaDir, { recursive: true });
    const clips: Any[] = [];
    for (let index = 0; index < 349; index++) {
      const source = index % 2 === 0 ? src.a : src.b;
      const file = path.join(
        mediaDir,
        `${String(index).padStart(3, "0")}-${"source-".repeat(10)}.mp4`,
      );
      await fsp.link(source, file);
      clips.push({ ...vclip(file, index, index + 1), id: `video-${index}` });
    }
    const tl = timeline([
      track("v", 0, clips),
      track("music", 0, [aclip(src.stereo, 0, 349)], "audio"),
    ]);
    const before = JSON.stringify(tl);
    const expected = await Promise.all(
      [src.a, src.b].map(async (file, index) =>
        decoded(
          await renderLossless(
            timeline([
              track("v", 0, [vclip(file, 0, 1)]),
              track("music", 0, [aclip(src.music, 0, 1)], "audio"),
            ]),
            `reference-${index}`,
          ),
        ),
      ),
    );
    const delivered = await decoded(await renderLossless(tl, "long-timeline", {}, true));
    expect(delivered.frames).toHaveLength(349);
    for (let index = 0; index < 349; index++)
      expect(delivered.frames[index].equals(expected[index % 2].frames[0]), `clip ${index}`).toBe(
        true,
      );
    expect(expected[0].frames[0].equals(expected[1].frames[0])).toBe(false);
    expect(delivered.pcm.length).toBe((349 * RATE * 2 * 2) / FPS);
    const sound = await decoded(
      await renderLossless(
        timeline([track("music", 0, [aclip(src.stereo, 0, 349)], "audio")]),
        "long-sound-reference",
      ),
    );
    expect(delivered.pcm.equals(sound.pcm)).toBe(true);
    expect(
      Array.from({ length: 1600 }, (_, sample) => delivered.pcm.readInt16LE(sample * 4)).some(
        (left, sample) => left !== delivered.pcm.readInt16LE(sample * 4 + 2),
      ),
    ).toBe(true);
    const capped = await decoded(
      await renderLossless(tl, "long-timeline-capped", { maxDurationSec: 1 }, true),
    );
    expect(capped.frames).toHaveLength(FPS);
    for (let index = 0; index < FPS; index++)
      expect(
        capped.frames[index].equals(delivered.frames[index]),
        `capped native frame ${index}`,
      ).toBe(true);
    expect(capped.pcm.length).toBe(RATE * 2 * 2);
    expect(capped.pcm.equals(delivered.pcm.subarray(0, RATE * 2 * 2))).toBe(true);
    expect(JSON.stringify(tl)).toBe(before);
  });

  it("also delivers 349 separate audio inputs without losing the mix history", async () => {
    const mediaDir = path.join(dir, `Director's-original-audio-export-${"project-".repeat(10)}`);
    await fsp.mkdir(mediaDir, { recursive: true });
    const clips: Any[] = [];
    for (let index = 0; index < 349; index++) {
      const file = path.join(
        mediaDir,
        `${String(index).padStart(3, "0")}-${"source-".repeat(10)}.wav`,
      );
      await fsp.link(src.music, file);
      clips.push({ ...aclip(file, index * 3, (index + 1) * 3), id: `audio-${index}` });
    }
    const tl = timeline([track("sound", 0, clips, "audio")]);
    const before = JSON.stringify(tl);
    const reference = await decoded(
      await renderLossless(
        timeline([track("sound", 0, [aclip(src.music, 0, 3)], "audio")]),
        "audio-reference",
      ),
    );
    const delivered = await decoded(await renderLossless(tl, "audio-heavy-timeline"));
    expect(delivered.frames).toHaveLength(349 * 3);
    expect(delivered.pcm.length).toBe(reference.pcm.length * 349);
    for (let index = 0; index < 349; index++)
      expect(
        delivered.pcm
          .subarray(index * reference.pcm.length, (index + 1) * reference.pcm.length)
          .equals(reference.pcm),
        `audio ${index}`,
      ).toBe(true);
    expect(JSON.stringify(tl)).toBe(before);
  });

  it("stages legitimate quoted paths without changing their bytes and refuses directive injection", async () => {
    const directory = path.join(dir, `path-fuzz-${"original-project-".repeat(6)}`);
    await fsp.mkdir(directory, { recursive: true });
    const make = (source: string): Timeline =>
      timeline([
        track(
          "a",
          0,
          Array.from({ length: 349 }, (_, index) => ({
            ...aclip(source, index * 3, (index + 1) * 3),
            id: `fuzz-${index}`,
          })),
          "audio",
        ),
      ]);
    const expected = await ffBytes(["-i", src.stereo, "-t", "0.1", "-f", "s16le", "-"]);
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("'", " ", "#", ";", "&", "(", ")", "%", "_", "\u00e9"), {
          minLength: 1,
          maxLength: 8,
        }),
        async (characters) => {
          const source = path.join(
            directory,
            `${"long-source-".repeat(5)}${characters.join("")}.wav`,
          );
          if (!existsSync(source)) await fsp.link(src.stereo, source);
          const plan = buildRenderCommand(make(source), path.join(dir, "fuzz.mp4"));
          const manifest = plan.assFiles.find((file) => file.name.endsWith("_i0.ffconcat"))!;
          expect(manifest).toBeDefined();
          const file = path.join(dir, "fuzz-input.ffconcat");
          await fsp.writeFile(file, manifest.content);
          const decoded = await ffBytes([
            "-safe",
            "0",
            "-i",
            file,
            "-t",
            "0.1",
            "-f",
            "s16le",
            "-",
          ]);
          expect(decoded.equals(expected)).toBe(true);
        },
      ),
      { numRuns: 12 },
    );
    fc.assert(
      fc.property(
        fc.constantFrom("\n", "\r", "\0"),
        fc.string({ maxLength: 20 }),
        (separator, suffix) => {
          const source = `${directory}/${"source-".repeat(10)}${separator}file 'https://invalid.example/${suffix}'`;
          expect(() => buildRenderCommand(make(source), path.join(dir, "injection.mp4"))).toThrow(
            "cannot be staged",
          );
          expect(existsSync(path.join(dir, "injection.mp4"))).toBe(false);
        },
      ),
      { numRuns: 30 },
    );
  });
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

  it("chunk seams preserve every crossfade, caption, animated still and ducked sample", async () => {
    const reference = busy();
    reference.tracks.push(
      track(
        "transparent",
        3,
        Array.from({ length: 160 }, (_, index) => ({
          ...vclip(src.a, index * 2, index * 2 + 2),
          id: `filler-${index}`,
          opacity: 0,
        })),
      ),
    );
    await resolveClipSources(ctx, reference);
    const expected = await decoded(await renderLossless(reference, "seams-reference"));
    const long = structuredClone(reference);
    const mediaDir = path.join(dir, `Director's-original-export-${"project-".repeat(10)}`);
    await fsp.mkdir(mediaDir, { recursive: true });
    const linked = new Map<string, string>();
    for (const track of long.tracks) {
      for (const clip of track.clips ?? []) {
        if (!clip.media_ref) continue;
        const source = String(clip.media_ref);
        let target = linked.get(source);
        if (!target) {
          target = path.join(mediaDir, `${"long-source-".repeat(6)}${path.basename(source)}`);
          await fsp.link(source, target);
          linked.set(source, target);
        }
        clip.media_ref = target;
      }
    }
    const before = JSON.stringify(long);
    const delivered = await decoded(await renderLossless(long, "seams-delivered"));
    expect(delivered.frames).toHaveLength(expected.frames.length);
    for (let index = 0; index < expected.frames.length; index++)
      expect(delivered.frames[index].equals(expected.frames[index]), `seam frame ${index}`).toBe(
        true,
      );
    expect(delivered.frames[150].equals(delivered.frames[160])).toBe(false);
    expect(delivered.pcm.length, "complete seam audio").toBe(expected.pcm.length);
    let firstDifference = -1;
    let maxDifference = 0;
    let differences = 0;
    for (let offset = 0; offset < expected.pcm.length; offset += 2) {
      const difference = Math.abs(
        delivered.pcm.readInt16LE(offset) - expected.pcm.readInt16LE(offset),
      );
      if (difference) {
        if (firstDifference < 0) firstDifference = offset / 4;
        differences++;
        maxDifference = Math.max(maxDifference, difference);
      }
    }
    expect({ firstDifference, differences, maxDifference }, "identical mixed samples").toEqual({
      firstDifference: -1,
      differences: 0,
      maxDifference: 0,
    });
    expect(JSON.stringify(long)).toBe(before);
  });

  it("applies delivery FPS and exactly one end card after all chunks", async () => {
    const reference = busy();
    reference.tracks.push(
      track(
        "transparent",
        3,
        Array.from({ length: 160 }, (_, index) => ({
          ...vclip(src.a, index * 2, index * 2 + 2),
          id: `brand-filler-${index}`,
          opacity: 0,
        })),
      ),
    );
    await resolveClipSources(ctx, reference);
    const card = path.join(dir, "one-card.mp4");
    await ff([
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=green:s=${W}x${H}:r=24:d=0.5`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      card,
    ]);
    const options: ExportOptions = {
      fps: 24,
      branding: { watermark: null, endcard: card, endcardDuration: 0.5 },
    };
    const expected = await decoded(await renderLossless(reference, "brand-reference", options));
    const long = structuredClone(reference);
    const mediaDir = path.join(dir, `brand-project-${"source-folder-".repeat(7)}`);
    await fsp.mkdir(mediaDir, { recursive: true });
    const linked = new Map<string, string>();
    for (const track of long.tracks)
      for (const clip of track.clips ?? []) {
        if (!clip.media_ref) continue;
        const source = String(clip.media_ref);
        if (!linked.has(source)) {
          const target = path.join(mediaDir, `${"long-source-".repeat(6)}${path.basename(source)}`);
          await fsp.link(source, target);
          linked.set(source, target);
        }
        clip.media_ref = linked.get(source)!;
      }
    const delivered = await decoded(await renderLossless(long, "brand-delivered", options));
    expect(delivered.frames).toHaveLength(13 * 24 + 12);
    for (let index = 0; index < expected.frames.length; index++)
      expect(delivered.frames[index].equals(expected.frames[index]), `branded frame ${index}`).toBe(
        true,
      );
    expect(delivered.pcm.equals(expected.pcm)).toBe(true);
    expect(delivered.frames[310].equals(delivered.frames[320])).toBe(false);
  });

  it("never assembles after a failed chunk or a chunk that ignores cancellation, and removes its scratch files", async () => {
    const source = path.join(dir, `failure-${"source-".repeat(15)}.mp4`);
    await fsp.link(src.a, source);
    const large = timeline([
      track(
        "v",
        0,
        Array.from({ length: 220 }, (_, index) => ({
          ...vclip(source, index, index + 1),
          id: `failure-${index}`,
        })),
      ),
    ]);
    for (const cancel of [false, true]) {
      const out = path.join(dir, `not-published-${cancel}.mp4`);
      const plan = buildRenderCommand(large, out);
      const stop = new AbortController();
      let scratch = "";
      let runs = 0;
      const interrupted: ClientToolContext = {
        ...ctx,
        signal: stop.signal,
        runner: {
          run: async (_program, args, _signal, cwd) => {
            runs++;
            scratch = cwd!;
            await fsp.writeFile(path.join(cwd!, args.at(-1)!), "partial intermediate bytes");
            if (cancel) stop.abort();
            return {
              code: cancel ? 0 : -1,
              stdout: "",
              stderr: cancel ? "" : "injected render failure",
            };
          },
        },
      };
      const result = await runRenderPlan(interrupted, plan);
      expect(result.code).not.toBe(0);
      expect(runs).toBe(1);
      expect(existsSync(scratch)).toBe(false);
      expect(existsSync(out)).toBe(false);
    }
  });

  // The ducker dropped whatever it still held of the music when the music ended before its padded
  // key caught up, and how much it held depended on thread timing: run beside the rest of this
  // suite, 3 of 20 whole exports came out 2832 samples short (2026-10-07). Many at once here, so
  // the timing varies; every one must hold exactly the timeline's sound.
  it("the whole export's sound is exactly the timeline's length, however many render at once", async () => {
    const want = (390 / FPS) * RATE * 2 * 2; // stereo s16
    const lengths = await Promise.all(
      Array.from(
        { length: 16 },
        async (_, i) => (await decoded(await renderLossless(tl, `again${i}`))).pcm.length,
      ),
    );
    expect(lengths).toEqual(lengths.map(() => want));
  }, 300_000);
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
