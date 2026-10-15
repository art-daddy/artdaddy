// BENCHMARK #1 — ffmpeg render wall-time vs the (near-instant) live preview.
//
// The live WebGL preview composites on the GPU in real time (scrub latency is
// effectively zero — buildScene is sub-millisecond), so the meaningful number is
// how long a FULL ffmpeg render takes, because that is the cost an "ffmpeg-only,
// no-preview" product would impose on every iteration.
//
// Matrix: {5s, 30s, 120s} x {simple, medium, complex} at 1080p. We time the real
// render (renderTimelineTool -> ffmpeg) and report wall-time + the realtime factor
// (renderSec / videoSec): >1 means the render takes LONGER than the clip's runtime.
//
// Run (needs ffmpeg): npx vitest run --config vitest.smoke.config.ts src/tools/bench_render.e2e.ts
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ff,
  have,
  installE2EDocuments,
  libRef,
  mkCtx,
  openE2EDoc,
  probe,
  renderMp4,
  resetE2EDocuments,
} from "./__e2e";
import { shippedSidecar } from "../test/sidecars";
import type { ClientToolContext } from "./context";
import { ensureTimeline, replaceTimeline } from "../timeline/engine";
import type { Animatable, Clip, Timeline, Track } from "../timeline/model";
import { buildScene } from "../preview/scene";
import {
  buildRenderCommand,
  finishRenderJob,
  loadForRender,
  queueRenderJob,
  RENDER_CONTRACT_VERSION,
  type ExportJobPlan,
} from "../timeline/render";
import { whenExportEnds } from "../timeline/exportQueue";
import { resolveRenderPlan } from "../timeline/renderPlan";

const EXPORT_PROBE = process.env.ARTDADDY_EXPORT_PROBE === "1";
const PROBE_4K = EXPORT_PROBE && process.env.ARTDADDY_EXPORT_PROBE_4K === "1";
const DURATIONS = EXPORT_PROBE ? [3] : [5, 30, 120];
const LEVELS = EXPORT_PROBE
  ? (["simple", "complex"] as const)
  : (["simple", "medium", "complex"] as const);
const W = PROBE_4K ? 3840 : 1920;
const H = PROBE_4K ? 2160 : 1080;
const FPS = PROBE_4K ? 60 : 30;

interface Row {
  level: string;
  videoSec: number;
  renderSec: number;
  realtimeFactor: number; // renderSec / videoSec
  outMB: number;
  clips: number;
  tracks: number;
  warnings: number;
  verificationSec?: number;
  artifact?: {
    sourceSha256: string;
    outputSha256: string;
    decodedFrameCount: number;
    movingFrames: boolean;
    stereoVerified: boolean;
    directoryBytes: number;
    sourcePath: string;
    outputPath: string;
  };
}

let dir = "";
let ctx: ClientToolContext;
const srcByDur = new Map<number, string>(); // duration -> absolute 1080p source path
const rows: Row[] = [];
let ffmpegAvailable = false;

const kf = (pts: Array<[number, number]>): Animatable => pts.map(([t, v]) => ({ t, v }));

function vclip(
  id: string,
  src: string,
  tin: number,
  tout: number,
  extra: Partial<Clip> = {},
): Clip {
  const len = tout - tin;
  return {
    id,
    kind: "video",
    media_ref: src,
    timeline_in: tin,
    timeline_out: tout,
    source_in: 0,
    source_out: len,
    ...extra,
  } as Clip;
}

/** simple = 1 straight clip; medium = 3 cuts + audio bed + fades; complex = 2 video
 *  tracks (crossfades + a keyframed/rotated PiP overlay) + a colour grade + audio. */
function buildTimeline(level: (typeof LEVELS)[number], src: string, durSec: number): Timeline {
  const total = Math.round(durSec * FPS);
  const canvas = { width: W, height: H, fps: FPS };

  if (level === "simple") {
    const v: Track = {
      id: "v1",
      kind: "video",
      z: 0,
      clips: [vclip("c0", src, 0, total)],
    } as Track;
    const audio: Track = {
      id: "a1",
      kind: "audio",
      z: 0,
      clips: [
        {
          ...vclip("a0", src, 0, total),
          kind: "audio",
        },
      ],
    };
    return { units: "frames", canvas, tracks: EXPORT_PROBE ? [v, audio] : [v] } as Timeline;
  }

  const third = Math.floor(total / 3);
  if (level === "medium") {
    const v: Track = {
      id: "v1",
      kind: "video",
      z: 0,
      clips: [
        vclip("c0", src, 0, third, { fade: { in: FPS, out: 0 } }),
        vclip("c1", src, third, third * 2),
        vclip("c2", src, third * 2, total, { fade: { in: 0, out: FPS } }),
      ],
    } as Track;
    const a: Track = {
      id: "a1",
      kind: "audio",
      z: 1,
      clips: [
        {
          ...vclip("a0", src, 0, total),
          kind: "audio",
          fade: { in: FPS, out: FPS },
          volume: 0.5,
        } as Clip,
      ],
    } as Track;
    return { canvas, tracks: [v, a] } as Timeline;
  }

  // complex: main 3 clips with crossfades + colour grade; overlay PiP with opacity
  // keyframes + rotate; an audio bed with fades.
  const dur = Math.max(FPS, Math.floor(FPS / 2)); // ~0.5s crossfade
  const main: Track = {
    id: "v1",
    kind: "video",
    z: 0,
    clips: [
      vclip("m0", src, 0, third, { color: { exposure: 0.2, saturation: 1.3 } as Clip["color"] }),
      vclip("m1", src, third, third * 2, {
        transition_in: { kind: "crossfade", duration: dur } as Clip["transition_in"],
      }),
      vclip("m2", src, third * 2, total, {
        transition_in: { kind: "crossfade", duration: dur } as Clip["transition_in"],
      }),
    ],
  } as Track;
  const pipLen = Math.min(total, FPS * 2);
  const overlay: Track = {
    id: "v2",
    kind: "video",
    z: 1,
    clips: [
      vclip("p0", src, 0, pipLen, {
        transform: { position: { x: 0.75, y: 0.25 }, scale: 0.3 } as Clip["transform"],
        opacity: kf([
          [0, 0],
          [FPS, 1],
          [pipLen - FPS, 1],
          [pipLen, 0],
        ]),
        rotate: 10,
      }),
    ],
  } as Track;
  const a: Track = {
    id: "a1",
    kind: "audio",
    z: 2,
    clips: [
      {
        ...vclip("a0", src, 0, total),
        kind: "audio",
        fade: { in: FPS, out: FPS },
        volume: 0.4,
      } as Clip,
    ],
  } as Track;
  return { canvas, tracks: [main, overlay, a] } as Timeline;
}

describe.skipIf(!process.env.ARTDADDY_BENCH && !EXPORT_PROBE)(
  `BENCH #1 — render wall-time vs preview (${W}x${H}/${FPS})`,
  () => {
    beforeAll(async () => {
      ffmpegAvailable = (await have("ffmpeg")) && (await have("ffprobe"));
      if (!ffmpegAvailable) {
        if (EXPORT_PROBE) throw new Error("export feasibility requires shipped ffmpeg/ffprobe");
        return;
      }
      dir = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-bench-render-"));
      installE2EDocuments();
      await openE2EDoc(dir);
      ctx = mkCtx(dir);
      await ensureTimeline(ctx.store);
      // One 1080p testsrc2 source per duration (motion => realistic encode load) + a tone.
      for (const d of DURATIONS) {
        const src = path.join(dir, `src${d}.mp4`);
        await ff([
          "-y",
          "-f",
          "lavfi",
          "-i",
          `testsrc2=size=${W}x${H}:rate=${FPS}:duration=${d}`,
          "-f",
          "lavfi",
          "-i",
          EXPORT_PROBE
            ? `aevalsrc=0.10*sin(2*PI*440*t)|0.08*sin(2*PI*880*t):s=48000:d=${d}`
            : `sine=frequency=440:duration=${d}`,
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-shortest",
          src,
        ]);
        srcByDur.set(d, src);
      }
    }, 600_000);

    for (const d of DURATIONS) {
      for (const level of LEVELS) {
        it(`${level} @ ${d}s`, async () => {
          if (!ffmpegAvailable) return;
          const src = srcByDur.get(d)!;
          const tl = buildTimeline(level, src, d);
          await replaceTimeline(ctx.store, tl);
          if (EXPORT_PROBE)
            await fsp.writeFile(
              path.join(dir, `${level}-timeline.json`),
              JSON.stringify(tl, null, 2),
            );
          const t0 = Date.now();
          const working = await renderMp4(
            { ...ctx, ...(EXPORT_PROBE ? { signal: AbortSignal.timeout(120_000) } : {}) },
            dir,
          );
          const renderSec = (Date.now() - t0) / 1000;
          const mp4 = EXPORT_PROBE ? path.join(dir, `baseline-${level}-${d}.mp4`) : working;
          if (EXPORT_PROBE) await fsp.copyFile(working, mp4);
          const pr = await probe(mp4);
          const st = await fsp.stat(mp4);
          let artifact: Row["artifact"];
          const verificationStart = Date.now();
          if (EXPORT_PROBE) {
            const frames = await bytesFromFfmpeg([
              "-i",
              mp4,
              "-map",
              "0:v",
              "-vf",
              "scale=32:18",
              "-pix_fmt",
              "rgb24",
              "-f",
              "rawvideo",
              "-",
            ]);
            const frameBytes = 32 * 18 * 3;
            expect(frames.length % frameBytes).toBe(0);
            const decodedFrameCount = frames.length / frameBytes;
            expect(decodedFrameCount).toBe(d * FPS);
            const movingFrames = !frames
              .subarray(0, frameBytes)
              .equals(frames.subarray((decodedFrameCount - 1) * frameBytes));
            expect(movingFrames).toBe(true);
            const samples = await bytesFromFfmpeg([
              "-ss",
              "1",
              "-i",
              mp4,
              "-map",
              "0:a",
              "-t",
              "0.5",
              "-ar",
              "48000",
              "-ac",
              "2",
              "-f",
              "f32le",
              "-",
            ]);
            const left440 = toneMagnitude(samples, 0, 440);
            const left880 = toneMagnitude(samples, 0, 880);
            const right440 = toneMagnitude(samples, 1, 440);
            const right880 = toneMagnitude(samples, 1, 880);
            const stereoVerified =
              left440 > 0.01 && right880 > 0.01 && left880 < left440 / 4 && right440 < right880 / 4;
            expect(
              stereoVerified,
              `channel tones ${JSON.stringify({ left440, left880, right440, right880 })}`,
            ).toBe(true);
            artifact = {
              sourceSha256: await hashFile(src),
              outputSha256: await hashFile(mp4),
              decodedFrameCount,
              movingFrames,
              stereoVerified,
              directoryBytes: await directoryBytes(dir),
              sourcePath: src,
              outputPath: mp4,
            };
          }
          const clips = tl.tracks.reduce((n, t) => n + (t.clips?.length ?? 0), 0);
          rows.push({
            level,
            videoSec: d,
            renderSec: Number(renderSec.toFixed(2)),
            realtimeFactor: Number((renderSec / d).toFixed(2)),
            outMB: Number((st.size / 1e6).toFixed(1)),
            clips,
            tracks: tl.tracks.length,
            warnings: 0,
            ...(artifact ? { artifact } : {}),
            ...(EXPORT_PROBE ? { verificationSec: (Date.now() - verificationStart) / 1000 } : {}),
          });
          // sanity: output is a real 1080p mp4 of ~the right length
          if (pr.width !== W || pr.height !== H)
            throw new Error(`bad dims ${pr.width}x${pr.height}`);
        }, 620_000);
      }
    }

    afterAll(async () => {
      if (rows.length) {
        const md = renderReport(rows);
        const outDir = path.resolve("reports/bench");
        await fsp.mkdir(outDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await fsp.writeFile(
          path.join(outDir, `render-${stamp}.json`),
          JSON.stringify(rows, null, 2),
        );
        await fsp.writeFile(path.join(outDir, "render-latest.md"), md);
        if (EXPORT_PROBE) {
          const ffmpeg = shippedSidecar("ffmpeg");
          for (const row of rows)
            if (row.artifact)
              expect(
                await hashFile(row.artifact.outputPath),
                `${row.level}: retained artifact identity`,
              ).toBe(row.artifact.outputSha256);
          await fsp.writeFile(
            path.join(outDir, "export-feasibility-baseline.json"),
            JSON.stringify(
              {
                status: rows.length === LEVELS.length ? "measured" : "incomplete",
                fixtureDir: dir,
                profile: { width: W, height: H, fps: FPS, durations: DURATIONS },
                createdAt: new Date().toISOString(),
                scope: "short synthetic development-host probe; not 8 GB or two-hour qualification",
                hardware: {
                  cpu: os.cpus()[0]?.model,
                  logicalCpus: os.cpus().length,
                  totalMemoryBytes: os.totalmem(),
                },
                backend: { ffmpeg, sha256: ffmpeg ? await hashFile(ffmpeg) : null },
                resources: {
                  peakWorkingSetBytes: null,
                  peakScratchBytes: null,
                  note: "directoryBytes is an end snapshot, not a peak resource measurement",
                },
                cases: rows,
              },
              null,
              2,
            ),
          );
        }
        // eslint-disable-next-line no-console
        console.log("\n" + md + "\n");
      }
      await resetE2EDocuments();
      if (dir && !EXPORT_PROBE)
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    });
  },
);

function renderReport(data: Row[]): string {
  const lines: string[] = [];
  lines.push(`# Benchmark #1 — Render wall-time vs preview (${W}x${H}, ${FPS}fps)`);
  lines.push("");
  lines.push("Preview = live WebGL scrub, effectively instant (buildScene is sub-ms).");
  lines.push(
    "`realtime x` = renderSec / videoSec — how many seconds of render per second of video.",
  );
  lines.push("");
  lines.push("| level | video | clips | tracks | render (s) | realtime x | out MB |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of data) {
    lines.push(
      `| ${r.level} | ${r.videoSec}s | ${r.clips} | ${r.tracks} | ${r.renderSec} | ${r.realtimeFactor}x | ${r.outMB} |`,
    );
  }
  return lines.join("\n");
}

function bytesFromFfmpeg(args: string[], program?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const binary = program ?? shippedSidecar("ffmpeg");
    if (!binary) return reject(new Error("shipped ffmpeg missing"));
    const child = spawn(binary, ["-hide_banner", "-loglevel", "error", ...args], {
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let stderr = "";
    const deadline = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > 64 * 1024 * 1024) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-8192);
    });
    child.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(deadline);
      if (code === 0 && receivedBytes <= 64 * 1024 * 1024) resolve(Buffer.concat(chunks));
      else reject(new Error(`artifact decode ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

async function framesFromFfmpeg(
  args: string[],
  frameBytes: number,
  expectedFrames: number,
  consume: (frame: Buffer, index: number) => void,
  cwd?: string,
): Promise<void> {
  if (
    !Number.isSafeInteger(frameBytes) ||
    frameBytes < 1 ||
    !Number.isSafeInteger(expectedFrames) ||
    expectedFrames < 1 ||
    !Number.isSafeInteger(frameBytes * expectedFrames)
  )
    throw new Error("invalid artifact frame budget");
  const binary = shippedSidecar("ffmpeg");
  if (!binary) throw new Error("shipped ffmpeg missing");
  const child = spawn(binary, ["-hide_banner", "-loglevel", "error", ...args], {
    windowsHide: true,
    cwd,
  });
  let stderr = "";
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  void closed.catch(() => undefined);
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-8192);
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 60_000);
  const frame = Buffer.allocUnsafe(frameBytes);
  let filled = 0;
  let frames = 0;
  try {
    for await (const chunk of child.stdout) {
      let offset = 0;
      while (offset < chunk.length) {
        if (frames >= expectedFrames) throw new Error("artifact decode emitted extra frames");
        const count = Math.min(frameBytes - filled, chunk.length - offset);
        chunk.copy(frame, filled, offset, offset + count);
        offset += count;
        filled += count;
        if (filled === frameBytes) {
          consume(frame, frames++);
          filled = 0;
        }
      }
    }
    const code = await closed;
    if (code !== 0 || filled !== 0 || frames !== expectedFrames)
      throw new Error(
        `artifact decode ${code}, frames ${frames}/${expectedFrames}, trailing ${filled}: ${stderr.slice(-1000)}`,
      );
  } catch (error) {
    child.kill("SIGKILL");
    await closed.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    total += entry.isDirectory() ? await directoryBytes(file) : (await fsp.stat(file)).size;
  }
  return total;
}

function toneMagnitude(samples: Buffer, channel: number, frequency: number): number {
  const count = samples.length / 8;
  let real = 0;
  let imaginary = 0;
  for (let index = 0; index < count; index++) {
    const value = samples.readFloatLE(index * 8 + channel * 4);
    const angle = (2 * Math.PI * frequency * index) / 48000;
    real += value * Math.cos(angle);
    imaginary += value * Math.sin(angle);
  }
  return count ? (2 * Math.hypot(real, imaginary)) / count : 0;
}

async function stereoTonesFromFfmpeg(args: string[], expectedSamples: number) {
  const real = [0, 0, 0, 0];
  const imaginary = [0, 0, 0, 0];
  let samples = 0;
  await framesFromFfmpeg(args, 8, expectedSamples, (pair, index) => {
    const left = pair.readFloatLE(0),
      right = pair.readFloatLE(4);
    for (let frequencyIndex = 0; frequencyIndex < 2; frequencyIndex++) {
      const angle = (2 * Math.PI * (frequencyIndex === 0 ? 440 : 880) * index) / 48000;
      const cosine = Math.cos(angle),
        sine = Math.sin(angle);
      real[frequencyIndex] += left * cosine;
      imaginary[frequencyIndex] += left * sine;
      real[frequencyIndex + 2] += right * cosine;
      imaginary[frequencyIndex + 2] += right * sine;
    }
    samples = index + 1;
  });
  const magnitude = real.map((value, index) => (2 * Math.hypot(value, imaginary[index])) / samples);
  return {
    samples,
    left440: magnitude[0],
    left880: magnitude[1],
    right440: magnitude[2],
    right880: magnitude[3],
  };
}

function temporalCorrelation(
  reference: Buffer,
  candidate: Buffer,
  first: number,
  last: number,
  frameBytes: number,
): number {
  const referenceLast = reference.length - frameBytes;
  let dot = 0;
  let referenceEnergy = 0;
  let candidateEnergy = 0;
  for (let pixel = 0; pixel < frameBytes; pixel++) {
    const expected = reference[referenceLast + pixel] - reference[pixel];
    const actual = candidate[last + pixel] - candidate[first + pixel];
    dot += expected * actual;
    referenceEnergy += expected * expected;
    candidateEnergy += actual * actual;
  }
  return referenceEnergy && candidateEnergy
    ? dot / Math.sqrt(referenceEnergy * candidateEnergy)
    : 0;
}

describe.skipIf(!process.env.ARTDADDY_ENGINE_REPORT && !process.env.ARTDADDY_MLT_REPORT)(
  "E0 frozen engine artifact comparison",
  () => {
    it("streams every actual frame and refuses incomplete, extra or failed decodes", async () => {
      const args = [
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=8x8:rate=4:duration=1",
        "-frames:v",
        "4",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "-",
      ];
      const frameBytes = 8 * 8 * 3;
      const expected = await bytesFromFfmpeg(args);
      expect(expected.length).toBe(4 * frameBytes);
      expect(
        expected.subarray(0, frameBytes).equals(expected.subarray(frameBytes, 2 * frameBytes)),
      ).toBe(false);
      const actual: Buffer[] = [];
      await framesFromFfmpeg(args, frameBytes, 4, (frame, index) => {
        expect(index).toBe(actual.length);
        actual.push(Buffer.from(frame));
      });
      expect(Buffer.concat(actual).equals(expected)).toBe(true);
      await expect(framesFromFfmpeg(args, frameBytes, 5, () => undefined)).rejects.toThrow(
        "frames 4/5",
      );
      await expect(framesFromFfmpeg(args, frameBytes, 3, () => undefined)).rejects.toThrow(
        "extra frames",
      );
      await expect(framesFromFfmpeg(args, frameBytes + 1, 4, () => undefined)).rejects.toThrow(
        "trailing",
      );
      await expect(
        framesFromFfmpeg(
          ["-f", "lavfi", "-i", "artdaddy_invalid_source", "-f", "rawvideo", "-"],
          frameBytes,
          4,
          () => undefined,
        ),
      ).rejects.toThrow("artifact decode");
    });

    it("streams changing video beyond the former whole-buffer limit", async () => {
      const frameBytes = 128 * 72 * 3;
      const expectedFrames = 2700;
      let frames = 0;
      let first: Buffer | undefined;
      let last: Buffer | undefined;
      await framesFromFfmpeg(
        [
          "-f",
          "lavfi",
          "-i",
          "testsrc=size=128x72:rate=60:duration=45",
          "-frames:v",
          String(expectedFrames),
          "-pix_fmt",
          "rgb24",
          "-f",
          "rawvideo",
          "-",
        ],
        frameBytes,
        expectedFrames,
        (frame, index) => {
          expect(frame.length).toBe(frameBytes);
          if (index === 0) first = Buffer.from(frame);
          if (index === expectedFrames - 1) last = Buffer.from(frame);
          frames++;
        },
      );
      expect(frames * frameBytes).toBeGreaterThan(64 * 1024 * 1024);
      expect(frames).toBe(expectedFrames);
      expect(first!.equals(last!)).toBe(false);
    });

    it("streams exact independent stereo measurements and refuses a missing sample", async () => {
      const args = [
        "-f",
        "lavfi",
        "-i",
        "aevalsrc=0.1*sin(2*PI*440*t)|0.08*sin(2*PI*880*t):s=48000:d=0.25",
        "-f",
        "f32le",
        "-",
      ];
      const reference = await bytesFromFfmpeg(args);
      const samples = reference.length / 8;
      const actual = await stereoTonesFromFfmpeg(args, samples);
      expect(actual).toEqual({
        samples,
        left440: toneMagnitude(reference, 0, 440),
        left880: toneMagnitude(reference, 0, 880),
        right440: toneMagnitude(reference, 1, 440),
        right880: toneMagnitude(reference, 1, 880),
      });
      expect(actual.samples).toBe(12000);
      expect(actual.left440).toBeGreaterThan(0.09);
      expect(actual.right880).toBeGreaterThan(0.07);
      expect(actual.left880).toBeLessThan(0.001);
      expect(actual.right440).toBeLessThan(0.001);
      await expect(stereoTonesFromFfmpeg(args, samples + 1)).rejects.toThrow(
        `frames ${samples}/${samples + 1}`,
      );
    });

    it("streams independent stereo beyond the former PCM buffer limit", async () => {
      const samples = 176 * 48000;
      const actual = await stereoTonesFromFfmpeg(
        [
          "-f",
          "lavfi",
          "-i",
          "aevalsrc=0.1*sin(2*PI*440*t)|0.08*sin(2*PI*880*t):s=48000:d=176",
          "-f",
          "f32le",
          "-",
        ],
        samples,
      );
      expect(actual.samples * 8).toBeGreaterThan(64 * 1024 * 1024);
      expect(actual.samples).toBe(samples);
      expect(actual.left440).toBeCloseTo(0.1, 5);
      expect(actual.right880).toBeCloseTo(0.08, 5);
      expect(actual.left880).toBeLessThan(0.001);
      expect(actual.right440).toBeLessThan(0.001);
    });

    it("preserves the frozen source's frames and independent stereo content", async () => {
      await verifyFrozenArtifact(
        (process.env.ARTDADDY_ENGINE_REPORT ?? process.env.ARTDADDY_MLT_REPORT)!,
      );
    });
  },
);

async function verifyFrozenArtifact(file: string): Promise<void> {
  const verificationStarted = Date.now();
  const report = JSON.parse(await fsp.readFile(file, "utf8")) as {
    source: string;
    sourceSha256: string;
    baseline: string;
    baselineSha256: string;
    output: string;
    outputSha256: string;
    expectedFrames: number;
    referenceFrames?: number;
    repeatCount?: number;
    visualLayers?: number;
    profile: { fps: number; width: number; height: number };
    sharedScene?: {
      mode?: string;
      timeline?: Timeline;
      readers?: number;
      renderReference?: { referenceFrames?: number };
      captionPlane?: { frames: number; fps: number };
    };
  };
  const root = await fsp.realpath(path.dirname(file));
  expect(path.basename(root)).toMatch(/^(?:(mlt|native)-probe|native-worker)-[a-f0-9]+$/);
  const fixture = path.dirname(root);
  expect(path.basename(fixture)).toMatch(/^artdaddy-bench-render-/);
  expect(fixture.startsWith((await fsp.realpath(os.tmpdir())) + path.sep)).toBe(true);
  for (const source of [report.source, report.baseline])
    expect((await fsp.realpath(source)).startsWith(fixture + path.sep)).toBe(true);
  expect((await fsp.realpath(report.output)).startsWith(root + path.sep)).toBe(true);
  expect(await hashFile(report.source)).toBe(report.sourceSha256);
  expect(await hashFile(report.baseline)).toBe(report.baselineSha256);
  expect(await hashFile(report.output)).toBe(report.outputSha256);
  const metadata = await probe(report.output);
  expect(metadata.width).toBe(report.profile.width);
  expect(metadata.height).toBe(report.profile.height);
  expect(metadata.vDurationS).toBeCloseTo(report.expectedFrames / report.profile.fps, 5);
  expect(metadata.hasAudio).toBe(true);
  if (report.sharedScene?.mode && report.sharedScene.mode !== "tiles") {
    const decoded = (source: string) =>
      bytesFromFfmpeg([
        "-i",
        source,
        "-map",
        "0:v",
        "-vf",
        "scale=128:72",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "-",
      ]);
    const frameBytes = 128 * 72 * 3;
    const referenceFrames =
      report.sharedScene.renderReference?.referenceFrames ?? report.expectedFrames;
    let reference: Buffer;
    const candidateEnds = Buffer.allocUnsafe(frameBytes * 2);
    const frameDifferences: number[] = [];
    let difference = 0;
    let candidateFrames = 0;
    const compareCanvas = (actual: Buffer, frame: number) => {
      expect(frame).toBe(candidateFrames);
      if (frame === 0) actual.copy(candidateEnds, 0);
      actual.copy(candidateEnds, frameBytes);
      let sum = 0;
      for (let pixel = 0; pixel < frameBytes; pixel++)
        sum += Math.abs(reference[(frame % referenceFrames) * frameBytes + pixel] - actual[pixel]);
      difference += sum;
      frameDifferences.push(sum / frameBytes);
      candidateFrames++;
    };
    let captionComparison: { meanRgbDifference: number; frameDifferences: number[] } | undefined;
    const hasCaptions =
      report.sharedScene.mode === "captions" || report.sharedScene.mode === "captions-overlap";
    if (hasCaptions && referenceFrames === 180) {
      const canvasRowBytes = 128 * 3;
      const combinedRowBytes = 640 * 3;
      const captionFrameBytes = 640 * 94 * 3;
      const captionOffset = combinedRowBytes * 72;
      const combinedFrameBytes = combinedRowBytes * (72 + 94);
      const combinedArgs = (source: string) => [
        "-i",
        source,
        "-filter_complex",
        "[0:v]split=2[canvas][caption];[canvas]scale=128:72,format=rgb24,pad=640:72:0:0:black[top];" +
          "[caption]crop=3840:560:0:800,scale=640:94,format=rgb24[bottom];[top][bottom]vstack=inputs=2[combined]",
        "-map",
        "[combined]",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "-",
      ];
      const old = await bytesFromFfmpeg(combinedArgs(report.baseline));
      expect(old.length).toBe(referenceFrames * combinedFrameBytes);
      reference = Buffer.allocUnsafe(referenceFrames * frameBytes);
      const canvas = Buffer.allocUnsafe(frameBytes);
      for (let frame = 0; frame < referenceFrames; frame++) {
        for (let row = 0; row < 72; row++) {
          const offset = frame * combinedFrameBytes + row * combinedRowBytes;
          old.copy(
            reference,
            frame * frameBytes + row * canvasRowBytes,
            offset,
            offset + canvasRowBytes,
          );
        }
      }
      const differences: number[] = [];
      await framesFromFfmpeg(
        combinedArgs(report.output),
        combinedFrameBytes,
        report.expectedFrames,
        (actual, frame) => {
          for (let row = 0; row < 72; row++) {
            const offset = row * combinedRowBytes;
            actual.copy(canvas, row * canvasRowBytes, offset, offset + canvasRowBytes);
          }
          compareCanvas(canvas, frame);
          const referenceOffset = (frame % referenceFrames) * combinedFrameBytes + captionOffset;
          let sum = 0;
          for (let pixel = 0; pixel < captionFrameBytes; pixel++)
            sum += Math.abs(old[referenceOffset + pixel] - actual[captionOffset + pixel]);
          differences.push(sum / captionFrameBytes);
        },
      );
      captionComparison = {
        meanRgbDifference: differences.reduce((sum, value) => sum + value, 0) / differences.length,
        frameDifferences: differences,
      };
    } else {
      reference = await decoded(report.baseline);
      expect(reference.length).toBe(referenceFrames * frameBytes);
      await framesFromFfmpeg(
        [
          "-i",
          report.output,
          "-map",
          "0:v",
          "-vf",
          "scale=128:72",
          "-pix_fmt",
          "rgb24",
          "-f",
          "rawvideo",
          "-",
        ],
        frameBytes,
        report.expectedFrames,
        compareCanvas,
      );
    }
    expect(reference.length).toBe(referenceFrames * frameBytes);
    expect(report.expectedFrames % referenceFrames).toBe(0);
    expect(candidateFrames).toBe(report.expectedFrames);
    const direction = temporalCorrelation(reference, candidateEnds, 0, frameBytes, frameBytes);
    const duration = report.expectedFrames / report.profile.fps;
    const { samples: audioSamples, ...tones } = await stereoTonesFromFfmpeg(
      [
        "-i",
        report.output,
        "-map",
        "0:a",
        "-t",
        String(duration),
        "-ar",
        "48000",
        "-ac",
        "2",
        "-f",
        "f32le",
        "-",
      ],
      Math.round(duration * 48000),
    );
    const checkpoints = Array.from(
      { length: report.expectedFrames / referenceFrames },
      (_, repeat) => [0, 60, 179].map((frame) => repeat * referenceFrames + frame),
    )
      .flat()
      .filter((frame) => frame < report.expectedFrames);
    const mean = difference / (candidateFrames * frameBytes);
    const sourceWindowComparisons: Array<{ frame: number; meanRgbDifference: number }> = [];
    if (
      report.sharedScene.mode === "motion-cover" ||
      report.sharedScene.mode === "motion-crop-flip"
    ) {
      expect(report.sharedScene.timeline).toBeDefined();
      const readers = report.sharedScene.readers;
      expect([1, 16]).toContain(readers);
      const dimensions = new Map(
        Array.from({ length: readers! }, (_, reader) => [
          `native-source-${reader}`,
          { w: report.profile.width, h: report.profile.height },
        ]),
      );
      for (const frame of [60, 90, 119]) {
        const scene = buildScene(
          report.sharedScene.timeline!,
          frame / report.profile.fps,
          dimensions,
        );
        const layer = scene.layers.find(
          (entry) => entry.source === `native-source-${readers! - 1}`,
        )!;
        expect(Math.abs(layer.src.h)).toBeLessThan(1);
        const crop = (source: string) =>
          bytesFromFfmpeg([
            "-ss",
            String(frame / report.profile.fps),
            "-i",
            source,
            "-map",
            "0:v",
            "-frames:v",
            "1",
            "-vf",
            `crop=${Math.round(layer.dst.w)}:${Math.round(layer.dst.h)}:${Math.round(layer.dst.x)}:${Math.round(layer.dst.y)},scale=128:72`,
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "-",
          ]);
        const [expected, actual] = await Promise.all([crop(report.baseline), crop(report.output)]);
        expect(expected.length).toBe(128 * 72 * 3);
        expect(actual.length).toBe(expected.length);
        let sum = 0;
        for (let pixel = 0; pixel < expected.length; pixel++)
          sum += Math.abs(expected[pixel] - actual[pixel]);
        sourceWindowComparisons.push({ frame, meanRgbDifference: sum / expected.length });
      }
    }
    if (hasCaptions) {
      expect(report.sharedScene.captionPlane).toMatchObject({
        frames: report.expectedFrames,
        fps: report.profile.fps,
      });
      expect(report.profile).toMatchObject({ width: 3840, height: 2160 });
    }
    if (hasCaptions && !captionComparison) {
      const crop = (source: string, frame: number, count: number) =>
        bytesFromFfmpeg([
          "-ss",
          String(frame / report.profile.fps),
          "-i",
          source,
          "-map",
          "0:v",
          "-frames:v",
          String(count),
          "-vf",
          "crop=3840:560:0:800,scale=640:94",
          "-pix_fmt",
          "rgb24",
          "-f",
          "rawvideo",
          "-",
        ]);
      const captionFrameBytes = 640 * 94 * 3;
      const differences: number[] = [];
      const repeatedCaption =
        referenceFrames === 180 ? await crop(report.baseline, 0, 180) : undefined;
      if (repeatedCaption) {
        expect(repeatedCaption.length).toBe(180 * captionFrameBytes);
        await framesFromFfmpeg(
          [
            "-i",
            report.output,
            "-map",
            "0:v",
            "-vf",
            "crop=3840:560:0:800,scale=640:94",
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "-",
          ],
          captionFrameBytes,
          report.expectedFrames,
          (actual, frame) => {
            let sum = 0;
            const offset = (frame % 180) * captionFrameBytes;
            for (let pixel = 0; pixel < captionFrameBytes; pixel++)
              sum += Math.abs(repeatedCaption[offset + pixel] - actual[pixel]);
            differences.push(sum / captionFrameBytes);
          },
        );
      } else
        for (let window = 0; window < report.expectedFrames; window += 180) {
          const count = Math.min(180, report.expectedFrames - window);
          const [expectedCaption, actualCaption] = await Promise.all([
            repeatedCaption ?? crop(report.baseline, window % referenceFrames, count),
            crop(report.output, window, count),
          ]);
          expect(expectedCaption.length).toBe(count * captionFrameBytes);
          expect(actualCaption.length).toBe(expectedCaption.length);
          for (let frame = 0; frame < count; frame++) {
            let sum = 0;
            for (let pixel = 0; pixel < captionFrameBytes; pixel++) {
              const offset = frame * captionFrameBytes + pixel;
              sum += Math.abs(expectedCaption[offset] - actualCaption[offset]);
            }
            differences.push(sum / captionFrameBytes);
          }
        }
      captionComparison = {
        meanRgbDifference: differences.reduce((sum, value) => sum + value, 0) / differences.length,
        frameDifferences: differences,
      };
    }
    const passed =
      mean < 3 &&
      checkpoints.every((frame) => frameDifferences[frame] < 3) &&
      direction > 0.5 &&
      sourceWindowComparisons.every((sample) => sample.meanRgbDifference < 3) &&
      audioSamples === Math.round(duration * 48000) &&
      tones.left440 > 0.07 &&
      tones.right880 > 0.05 &&
      tones.left880 < tones.left440 / 4 &&
      tones.right440 < tones.right880 / 4 &&
      (!captionComparison ||
        (captionComparison.meanRgbDifference < 3 &&
          Array.from({ length: report.expectedFrames / 180 }, (_, repeat) =>
            [12, 108, 179].map((frame) => repeat * 180 + frame),
          )
            .flat()
            .every((frame) => captionComparison!.frameDifferences[frame] < 3)));
    await fsp.writeFile(
      path.join(root, "artifact-comparison.json"),
      JSON.stringify(
        {
          status: passed ? "passed" : "failed",
          mode: report.sharedScene.mode,
          frames: candidateFrames,
          meanRgbDifference: mean,
          frameDifferences,
          temporalCorrelation: direction,
          sourceWindowComparisons,
          captionComparison,
          sourceSha256: report.sourceSha256,
          baselineSha256: report.baselineSha256,
          outputSha256: report.outputSha256,
          audio: { samples: audioSamples, ...tones },
          verificationSeconds: (Date.now() - verificationStarted) / 1000,
          scope:
            "full overlap canvas against pre-native existing-renderer reference, including animated opacity checkpoints; not general feature/alpha-media conformance",
        },
        null,
        2,
      ),
    );
    expect(mean, "full overlap canvas mean RGB difference").toBeLessThan(3);
    for (const sample of sourceWindowComparisons)
      expect(
        sample.meanRgbDifference,
        `source-window regional pixels at frame ${sample.frame}`,
      ).toBeLessThan(3);
    if (captionComparison) {
      expect(
        captionComparison.meanRgbDifference,
        "caption region cannot silently lose text",
      ).toBeLessThan(3);
      for (const frame of Array.from({ length: report.expectedFrames / 180 }, (_, repeat) =>
        [12, 108, 179].map((value) => repeat * 180 + value),
      ).flat())
        expect(
          captionComparison.frameDifferences[frame],
          `caption reveal checkpoint ${frame}`,
        ).toBeLessThan(3);
    }
    for (const frame of checkpoints)
      expect(frameDifferences[frame], `opacity checkpoint ${frame}`).toBeLessThan(3);
    expect(direction, "overlap animation follows independent time direction").toBeGreaterThan(0.5);
    expect(audioSamples).toBe(Math.round(duration * 48000));
    expect(tones.left440).toBeGreaterThan(0.07);
    expect(tones.right880).toBeGreaterThan(0.05);
    expect(tones.left880).toBeLessThan(tones.left440 / 4);
    expect(tones.right440).toBeLessThan(tones.right880 / 4);
    return;
  }
  const layers = report.visualLayers ?? 1;
  expect([1, 16]).toContain(layers);
  const axis = layers === 16 ? 4 : 1;
  const decoded = async (source: string, size = 1) =>
    bytesFromFfmpeg([
      "-i",
      source,
      "-map",
      "0:v",
      "-vf",
      `scale=${32 * size}:${18 * size}`,
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "-",
    ]);
  const reference = await decoded(report.baseline);
  const frameBytes = 32 * 18 * 3;
  const referenceFrames = report.referenceFrames ?? report.expectedFrames;
  const repeats = report.repeatCount ?? 1;
  expect([1, 10]).toContain(repeats);
  expect(report.expectedFrames).toBe(referenceFrames * repeats);
  expect(reference.length).toBe(referenceFrames * frameBytes);
  const candidateFrameBytes = frameBytes * layers;
  const candidateEnds = Buffer.allocUnsafe(candidateFrameBytes * 2);
  let candidateFrames = 0;
  const differences = Array.from({ length: layers }, () => 0);
  const boundaries = Array.from(
    { length: layers },
    () => [] as Array<{ tile: number; frame: number; meanRgbDifference: number }>,
  );
  await framesFromFfmpeg(
    [
      "-i",
      report.output,
      "-map",
      "0:v",
      "-vf",
      `scale=${32 * axis}:${18 * axis}`,
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "-",
    ],
    candidateFrameBytes,
    report.expectedFrames,
    (actual, frame) => {
      if (frame === 0) actual.copy(candidateEnds, 0);
      actual.copy(candidateEnds, candidateFrameBytes);
      candidateFrames++;
      for (let tile = 0; tile < layers; tile++) {
        let sum = 0;
        for (let row = 0; row < 18; row++) {
          for (let column = 0; column < 32; column++) {
            const expectedOffset = ((frame % referenceFrames) * 32 * 18 + row * 32 + column) * 3;
            const actualOffset =
              ((Math.floor(tile / axis) * 18 + row) * 32 * axis + (tile % axis) * 32 + column) * 3;
            for (let channel = 0; channel < 3; channel++)
              sum += Math.abs(reference[expectedOffset + channel] - actual[actualOffset + channel]);
          }
        }
        differences[tile] += sum;
        if (
          repeats > 1 &&
          (frame % referenceFrames === 0 || frame % referenceFrames === referenceFrames - 1)
        )
          boundaries[tile].push({ tile, frame, meanRgbDifference: sum / frameBytes });
      }
    },
  );
  expect(candidateFrames).toBe(report.expectedFrames);
  const tileDifferences: number[] = [];
  const loopBoundaryDifferences: Array<{ tile: number; frame: number; meanRgbDifference: number }> =
    [];
  const tileTemporalCorrelations: number[] = [];
  for (let tile = 0; tile < layers; tile++) {
    tileDifferences.push(differences[tile] / (candidateFrames * frameBytes));
    loopBoundaryDifferences.push(...boundaries[tile]);
    const endpoints = Buffer.alloc(2 * frameBytes);
    for (let endpoint = 0; endpoint < 2; endpoint++) {
      for (let row = 0; row < 18; row++) {
        const offset =
          endpoint * candidateFrameBytes +
          ((Math.floor(tile / axis) * 18 + row) * 32 * axis + (tile % axis) * 32) * 3;
        candidateEnds.copy(
          endpoints,
          endpoint * frameBytes + row * 32 * 3,
          offset,
          offset + 32 * 3,
        );
      }
    }
    tileTemporalCorrelations.push(
      temporalCorrelation(reference, endpoints, 0, frameBytes, frameBytes),
    );
  }
  const changingFrames = !candidateEnds
    .subarray(0, candidateFrameBytes)
    .equals(candidateEnds.subarray(candidateFrameBytes));
  const duration = report.expectedFrames / report.profile.fps;
  const {
    samples: audioSamples,
    left440,
    left880,
    right440,
    right880,
  } = await stereoTonesFromFfmpeg(
    [
      "-i",
      report.output,
      "-map",
      "0:a",
      "-t",
      String(duration),
      "-ar",
      "48000",
      "-ac",
      "2",
      "-f",
      "f32le",
      "-",
    ],
    Math.round(duration * 48000),
  );
  const passed =
    changingFrames &&
    tileDifferences.every((difference) => difference < 3) &&
    loopBoundaryDifferences.every((boundary) => boundary.meanRgbDifference < 3) &&
    tileTemporalCorrelations.every((correlation) => correlation > 0.5) &&
    audioSamples === Math.round(duration * 48000) &&
    left440 > 0.07 &&
    right880 > 0.05 &&
    left880 < left440 / 4 &&
    right440 < right880 / 4;
  await fsp.writeFile(
    path.join(root, "artifact-comparison.json"),
    JSON.stringify(
      {
        status: passed ? "passed" : "failed",
        scope:
          "frozen moving source across every tile plus complete stereo samples; not feature or hardware qualification",
        sourceSha256: report.sourceSha256,
        baselineSha256: report.baselineSha256,
        outputSha256: report.outputSha256,
        frames: candidateFrames,
        visualLayers: layers,
        repeatCount: repeats,
        loopBoundaryFramesVerified:
          repeats > 1 &&
          loopBoundaryDifferences.every((boundary) => boundary.meanRgbDifference < 3),
        loopBoundaryDifferences,
        changingFrames,
        tileMeanRgbDifferences: tileDifferences,
        tileTemporalCorrelations,
        meanRgbDifference: Math.max(...tileDifferences),
        audio: { samples: audioSamples, left440, left880, right440, right880 },
        verificationSeconds: (Date.now() - verificationStarted) / 1000,
      },
      null,
      2,
    ),
  );
  for (const difference of tileDifferences)
    expect(difference, "mean decoded tile RGB difference").toBeLessThan(3);
  for (const boundary of loopBoundaryDifferences)
    expect(
      boundary.meanRgbDifference,
      `tile ${boundary.tile} loop boundary frame ${boundary.frame}`,
    ).toBeLessThan(3);
  for (const correlation of tileTemporalCorrelations)
    expect(
      correlation,
      "encoded tile motion follows the independent source-time direction",
    ).toBeGreaterThan(0.5);
  expect(changingFrames).toBe(true);
  expect(audioSamples, "complete stereo sample count").toBe(Math.round(duration * 48000));
  expect(left440).toBeGreaterThan(0.07);
  expect(right880).toBeGreaterThan(0.05);
  expect(left880).toBeLessThan(left440 / 4);
  expect(right440).toBeLessThan(right880 / 4);
}

async function assertCaptionBandSafe(
  reference: {
    frames: number;
    sharedScene: {
      timeline: Timeline;
      captionPlane: {
        ass: string;
        sha256: string;
        fonts: Array<{ file: string; sha256: string }>;
        frames: number;
        fps: number;
      };
    };
  },
  producerArgs: string[],
) {
  const plane = reference.sharedScene.captionPlane;
  expect(plane).toMatchObject({ frames: reference.frames, fps: 60 });
  const tracks = reference.sharedScene.timeline.tracks.filter((track) => track.kind === "text");
  expect(tracks).toHaveLength(1);
  const clips = tracks[0].clips ?? [];
  expect(clips).toHaveLength(reference.frames / 180);
  const normalized = (clip: (typeof clips)[number]) => ({
    ...clip,
    id: "caption",
    timeline_in: 0,
    timeline_out: 180,
  });
  for (const [index, clip] of clips.entries()) {
    expect(clip.timeline_in).toBe(index * 180);
    expect(clip.timeline_out).toBe((index + 1) * 180);
    expect(normalized(clip)).toEqual(normalized(clips[0]));
  }
  const assets = [{ file: plane.ass, sha256: plane.sha256 }, ...plane.fonts];
  for (const asset of assets) expect(await hashFile(asset.file)).toBe(asset.sha256);
  const frameLimit = producerArgs.indexOf("-frames:v");
  expect(frameLimit).toBeGreaterThan(0);
  const args = [
    ...producerArgs.slice(0, frameLimit),
    "-frames:v",
    "180",
    "-pix_fmt",
    "argb",
    "-f",
    "rawvideo",
    "-",
  ];
  const filter = args.indexOf("-vf");
  expect(filter).toBeGreaterThan(0);
  const rowBytes = 3840 * 4;
  const zero = Buffer.alloc(800 * rowBytes);
  let frames = 0;
  await framesFromFfmpeg(
    args,
    2160 * rowBytes,
    180,
    (frame) => {
      if (
        !frame.subarray(0, zero.length).equals(zero) ||
        !frame.subarray(1360 * rowBytes).equals(zero)
      )
        throw new Error("caption pixels outside the declared band");
      frames++;
    },
    path.dirname(plane.ass),
  );
  for (const asset of assets) expect(await hashFile(asset.file)).toBe(asset.sha256);
  return { frames, width: 3840, y: 800, height: 560, outsideArgbZero: true };
}

describe.skipIf(
  !process.env.ARTDADDY_NATIVE_MUX_REFERENCE && !process.env.ARTDADDY_NATIVE_CAPTION_BAND_PROOF,
)("E0 caption band admission", () => {
  it("proves every omitted ARGB byte is zero and refuses real out-of-band ink", async () => {
    const proofFile = process.env.ARTDADDY_NATIVE_CAPTION_BAND_PROOF;
    const file = proofFile ?? process.env.ARTDADDY_NATIVE_MUX_REFERENCE!;
    const input = JSON.parse(await fsp.readFile(file, "utf8"));
    const reference = proofFile ? input.reference : input;
    const producer = proofFile
      ? input
      : JSON.parse(
          await fsp.readFile(path.join(path.dirname(file), "caption-execution.json"), "utf8"),
        );
    const proof = await assertCaptionBandSafe(reference, producer.arguments);
    expect(proof).toMatchObject({ frames: 180, outsideArgbZero: true });
    const wrong = [...producer.arguments];
    wrong[wrong.indexOf("-vf") + 1] += ",drawbox=x=10:y=10:w=32:h=32:color=white@1:t=fill";
    await expect(assertCaptionBandSafe(reference, wrong)).rejects.toThrow(
      "caption pixels outside the declared band",
    );
    if (proofFile)
      await fsp.writeFile(
        `${proofFile}.verified.json`,
        JSON.stringify({
          ...proof,
          captionSha256: reference.sharedScene.captionPlane.sha256,
          sceneFrames: reference.frames,
        }),
        { flag: "wx" },
      );
  }, 120000);
});

async function compactRepeatedCaptionScene(
  source: string,
  output: string,
  readers: number,
  frames: number,
) {
  const flat = await fsp.readFile(source);
  expect(flat.length).toBe(20 + readers * frames * 28);
  expect(Array.from({ length: 5 }, (_, index) => flat.readUInt32LE(index * 4))).toEqual([
    0x4e504c34,
    readers,
    frames,
    3840,
    2160,
  ]);
  if (frames % 180 !== 0) throw new Error("caption scene does not contain complete periods");
  const periodBytes = readers * 180 * 28;
  const pattern = flat.subarray(20, 20 + periodBytes);
  for (let offset = 20; offset < flat.length; offset += periodBytes)
    if (!flat.subarray(offset, offset + periodBytes).equals(pattern))
      throw new Error("caption scene does not repeat exactly");
  const binary = Buffer.alloc(24 + periodBytes);
  flat.copy(binary, 0, 0, 20);
  binary.writeUInt32LE(0x4e504c38, 0);
  binary.writeUInt32LE(180, 20);
  pattern.copy(binary, 24);
  await fsp.writeFile(output, binary, { flag: "wx" });
  return {
    format: "NPL8",
    frames,
    storedFrames: 180,
    originalBytes: flat.length,
    compactBytes: binary.length,
    sha256: await hashFile(output),
  };
}

describe.skipIf(!process.env.ARTDADDY_NATIVE_MUX_REFERENCE)(
  "E0 compact caption scene admission",
  () => {
    it("refuses nonrepeating input and malformed compact scenes before native output", async () => {
      const file = process.env.ARTDADDY_NATIVE_MUX_REFERENCE!;
      const reference = JSON.parse(await fsp.readFile(file, "utf8"));
      expect(reference.frames).toBeGreaterThan(180);
      const fixture = path.dirname(path.dirname(await fsp.realpath(file)));
      expect(path.basename(fixture)).toMatch(/^artdaddy-bench-render-/);
      const work = await fsp.mkdtemp(path.join(fixture, "native-compact-"));
      const compact = path.join(work, "scene.bin");
      await compactRepeatedCaptionScene(
        reference.sharedScene.file,
        compact,
        reference.readers,
        reference.frames,
      );
      const changed = await fsp.readFile(reference.sharedScene.file);
      changed[20 + reference.readers * 180 * 28 + 20] ^= 1;
      const varied = path.join(work, "varied.bin"),
        refused = path.join(work, "must-not-exist.bin");
      await fsp.writeFile(varied, changed);
      await expect(
        compactRepeatedCaptionScene(varied, refused, reference.readers, reference.frames),
      ).rejects.toThrow("does not repeat exactly");
      expect(await fsp.stat(refused).catch(() => null)).toBe(null);
      const sdk = JSON.parse(
        await fsp.readFile(
          path.join(os.tmpdir(), "artdaddy-export-native-sdk-c867e13549/sdk-provenance.json"),
          "utf8",
        ),
      );
      expect(await hashFile(sdk.worker)).toBe(sdk.workerSha256);
      expect(await hashFile(path.join(process.cwd(), "scripts/qa/exporterNativeWorker.cpp"))).toBe(
        sdk.workerSourceSha256,
      );
      const execution = JSON.parse(
        await fsp.readFile(path.join(path.dirname(file), "worker-execution.json"), "utf8"),
      );
      const valid = await fsp.readFile(compact);
      for (const kind of [
        "zero-period",
        "wrong-period",
        "duplicate-reader",
        "truncated",
        "trailing",
      ]) {
        let bytes = Buffer.from(valid);
        if (kind === "zero-period") bytes.writeUInt32LE(0, 20);
        if (kind === "wrong-period") bytes.writeUInt32LE(181, 20);
        if (kind === "duplicate-reader") bytes.writeUInt32LE(bytes.readUInt32LE(24), 24 + 28);
        if (kind === "truncated") bytes = bytes.subarray(0, bytes.length - 1);
        if (kind === "trailing") bytes = Buffer.concat([bytes, Buffer.from([1])]);
        const input = path.join(work, `${kind}.bin`),
          pixels = path.join(work, `${kind}.rgb`),
          video = path.join(work, `${kind}.h264`);
        await fsp.writeFile(input, bytes);
        const args: string[] = [...execution.arguments];
        args[2] = pixels;
        args[8] = input;
        args[9] = video;
        const outcome = await new Promise<{ code: number | null; stderr: string }>(
          (resolve, reject) => {
            const child = spawn(sdk.worker, args, {
              windowsHide: true,
              stdio: ["ignore", "ignore", "pipe"],
            });
            let stderr = "";
            const deadline = setTimeout(() => child.kill("SIGKILL"), 10000);
            child.stderr.on("data", (chunk) => {
              stderr = (stderr + String(chunk)).slice(-8192);
            });
            child.once("error", (error) => {
              clearTimeout(deadline);
              reject(error);
            });
            child.once("close", (code) => {
              clearTimeout(deadline);
              resolve({ code, stderr });
            });
          },
        );
        expect(outcome.code, kind).toBe(1);
        expect(outcome.stderr, kind).toContain("shared");
        expect(await fsp.stat(pixels).catch(() => null), kind).toBe(null);
        expect(await fsp.stat(video).catch(() => null), kind).toBe(null);
      }
    });
  },
);

describe.skipIf(!process.env.ARTDADDY_NATIVE_MUX_REFERENCE)(
  "E0 bounded encoded packet transport",
  () => {
    it.each(["complete", "producer-quota", "consumer-refusal"])(
      "owns the %s pipeline without an elementary scratch copy",
      async (mode) => {
        const referenceFile = await fsp.realpath(process.env.ARTDADDY_NATIVE_MUX_REFERENCE!);
        const previous = JSON.parse(await fsp.readFile(referenceFile, "utf8"));
        const fixture = await fsp.realpath(path.dirname(path.dirname(referenceFile)));
        expect(path.basename(fixture)).toMatch(/^artdaddy-bench-render-/);
        expect(fixture.startsWith((await fsp.realpath(os.tmpdir())) + path.sep)).toBe(true);
        expect([180, 1800, 3600]).toContain(previous.frames);
        expect([1, 16]).toContain(previous.readers);
        const sdk = JSON.parse(
          await fsp.readFile(
            path.join(os.tmpdir(), "artdaddy-export-native-sdk-c867e13549/sdk-provenance.json"),
            "utf8",
          ),
        );
        expect(await hashFile(sdk.worker)).toBe(sdk.workerSha256);
        expect(
          await hashFile(path.join(process.cwd(), "scripts/qa/exporterNativeWorker.cpp")),
        ).toBe(sdk.workerSourceSha256);
        for (const library of sdk.libraries)
          expect(await hashFile(library.binary)).toBe(library.binarySha256);
        const identities = [
          { file: previous.source, sha256: previous.sourceSha256 },
          { file: previous.baseline, sha256: previous.baselineSha256 },
          { file: previous.sharedScene.file, sha256: previous.sharedScene.sha256 },
        ];
        const caption = previous.sharedScene.captionPlane;
        if (caption)
          identities.push({ file: caption.ass, sha256: caption.sha256 }, ...caption.fonts);
        if (previous.sharedScene.alphaAsset) {
          const image = previous.sharedScene.alphaAsset;
          identities.push(
            { file: image.path, sha256: image.sha256 },
            { file: image.rgba, sha256: image.rgbaSha256 },
          );
        }
        for (const asset of identities) {
          expect((await fsp.realpath(asset.file)).startsWith(fixture + path.sep)).toBe(true);
          expect(await hashFile(asset.file)).toBe(asset.sha256);
        }
        const work = path.join(fixture, `native-worker-${randomUUID().replace(/-/g, "")}`);
        await fsp.mkdir(work);
        const pixels = path.join(work, "frames.rgb"),
          output = path.join(work, "video.mp4");
        const beforeExecution = JSON.parse(
          await fsp.readFile(
            path.join(path.dirname(referenceFile), "worker-execution.json"),
            "utf8",
          ),
        );
        const beforeMux = JSON.parse(
          await fsp.readFile(path.join(path.dirname(referenceFile), "mux-execution.json"), "utf8"),
        );
        const args: string[] = [...beforeExecution.arguments];
        args[2] = pixels;
        args[9] = "-";
        let compactScene: Awaited<ReturnType<typeof compactRepeatedCaptionScene>> | undefined;
        const admittedScene = structuredClone(previous.sharedScene);
        if (process.env.ARTDADDY_NATIVE_SCENE_COMPACT === "1") {
          const compactPath = path.join(work, "scene.bin");
          compactScene = await compactRepeatedCaptionScene(
            previous.sharedScene.file,
            compactPath,
            previous.readers,
            previous.frames,
          );
          args[8] = compactPath;
          identities.push({ file: compactPath, sha256: compactScene.sha256 });
          admittedScene.file = compactPath;
          admittedScene.sha256 = compactScene.sha256;
          admittedScene.storage = compactScene;
        }
        const byteBudget = mode === "producer-quota" ? 1048576 : 536870912;
        args[10] = String(byteBudget);
        const muxArgs: string[] = [...beforeMux.arguments];
        const elementary = muxArgs.indexOf(previous.elementary);
        expect(elementary).toBeGreaterThan(0);
        muxArgs[elementary] = "pipe:0";
        muxArgs[muxArgs.length - 1] = output;
        if (mode === "consumer-refusal")
          muxArgs.splice(muxArgs.indexOf("-c:v") + 1, 1, "artdaddy_invalid_encoder");
        const ffmpeg = shippedSidecar("ffmpeg");
        if (!ffmpeg) throw new Error("shipped muxer unavailable");
        const oldCaption = caption
          ? JSON.parse(
              await fsp.readFile(
                path.join(path.dirname(referenceFile), "caption-execution.json"),
                "utf8",
              ),
            )
          : undefined;
        if (previous.captionBand?.outsideArgbZero) {
          const flag = args.indexOf("--caption-qtrle-band-stdin");
          expect(flag).toBeGreaterThan(0);
          args[flag] = "--caption-qtrle-stdin";
          const filter = oldCaption.arguments.indexOf("-vf") + 1;
          const crop = ",crop=3840:560:0:800";
          expect(oldCaption.arguments[filter].endsWith(crop)).toBe(true);
          oldCaption.arguments[filter] = oldCaption.arguments[filter].slice(0, -crop.length);
        }
        const banded = process.env.ARTDADDY_NATIVE_CAPTION_BAND === "1";
        let bandProof: Awaited<ReturnType<typeof assertCaptionBandSafe>> | undefined;
        if (banded) {
          if (!caption || previous.captionTransport !== "Qtrle")
            throw new Error("caption band requires declared lossless captions");
          bandProof = await assertCaptionBandSafe(previous, oldCaption.arguments);
          const flag = args.indexOf("--caption-qtrle-stdin");
          expect(flag).toBeGreaterThan(0);
          args[flag] = "--caption-qtrle-band-stdin";
          oldCaption.arguments[oldCaption.arguments.indexOf("-vf") + 1] += ",crop=3840:560:0:800";
        }
        const worker = spawn(sdk.worker, args, {
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const mux = spawn(ffmpeg, muxArgs, {
          windowsHide: true,
          stdio: ["pipe", "ignore", "pipe"],
        });
        let workerErrors = "",
          muxErrors = "",
          captionErrors = "",
          bytes = 0,
          captionBytes = 0;
        const packetHash = createHash("sha256");
        worker.stderr.on("data", (chunk) => {
          workerErrors = (workerErrors + String(chunk)).slice(-65536);
        });
        mux.stderr.on("data", (chunk) => {
          muxErrors = (muxErrors + String(chunk)).slice(-8192);
        });
        const children: ChildProcess[] = [worker, mux];
        let captionTransfer: Promise<void> | undefined;
        if (caption) {
          const producer = spawn(ffmpeg, oldCaption.arguments, {
            cwd: path.dirname(caption.ass),
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          producer.stderr.on("data", (chunk) => {
            captionErrors = (captionErrors + String(chunk)).slice(-8192);
          });
          children.push(producer);
          const captionGate = new Transform({
            highWaterMark: 65536,
            transform(chunk: Buffer, _encoding, callback) {
              if (captionBytes + chunk.length > oldCaption.limitBytes) {
                callback(new Error("caption pipe byte budget exceeded"));
                return;
              }
              captionBytes += chunk.length;
              callback(null, chunk);
            },
          });
          captionTransfer = pipeline(producer.stdout, captionGate, worker.stdin);
          void captionTransfer.catch(() => undefined);
        } else worker.stdin.end();
        const closed = children.map(
          (child) =>
            new Promise<void>((resolve, reject) => {
              child.once("error", reject);
              child.once("close", (code) =>
                code === 0 ? resolve() : reject(new Error(`owned child failed: ${code}`)),
              );
            }),
        );
        const gate = new Transform({
          highWaterMark: 65536,
          transform(chunk: Buffer, _encoding, callback) {
            if (bytes + chunk.length > byteBudget) {
              callback(new Error("encoded pipe byte budget exceeded"));
              return;
            }
            bytes += chunk.length;
            packetHash.update(chunk);
            callback(null, chunk);
          },
        });
        const transfer = pipeline(worker.stdout, gate, mux.stdin);
        const tasks = [...closed, transfer, ...(captionTransfer ? [captionTransfer] : [])];
        for (const task of tasks) void task.catch(() => undefined);
        const clock = performance.now();
        let timedOut = false;
        const deadline = setTimeout(
          () => {
            timedOut = true;
            for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
          },
          previous.frames === 3600 ? 240000 : 120000,
        );
        let failed = false;
        try {
          await Promise.all(tasks);
        } catch {
          failed = true;
        } finally {
          for (const child of children)
            if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
          await Promise.allSettled(tasks);
          clearTimeout(deadline);
        }
        const native = workerErrors
          .split(/\r?\n/)
          .filter((line) => line.startsWith('{"status":'))
          .map((line) => JSON.parse(line))
          .at(-1);
        const reportFile = path.join(work, "worker-measurement.json");
        const accepted = !failed && !timedOut && native?.status === "artifact_pending";
        const packetSha256 = packetHash.digest("hex");
        await fsp.writeFile(
          path.join(work, "packet-pipe-execution.json"),
          JSON.stringify(
            {
              mode,
              accepted,
              timedOut,
              bytes,
              byteBudget,
              packetSha256,
              workerErrors,
              muxErrors,
              captionErrors,
              captionBytes,
              bandProof,
              compactScene,
              measurement: native,
              pipelineSeconds: (performance.now() - clock) / 1000,
            },
            null,
            2,
          ),
        );
        expect(await fsp.stat(path.join(work, "video.h264")).catch(() => null)).toBe(null);
        for (const asset of identities) expect(await hashFile(asset.file)).toBe(asset.sha256);
        if (mode !== "complete") {
          expect(accepted).toBe(false);
          expect(await fsp.stat(reportFile).catch(() => null)).toBe(null);
          if (mode === "producer-quota") {
            expect(workerErrors).toContain("private encoded-byte budget exceeded");
            expect(bytes).toBeGreaterThan(0);
            expect(bytes).toBeLessThanOrEqual(byteBudget);
          } else expect(muxErrors).toContain("artdaddy_invalid_encoder");
          return;
        }
        expect(accepted, workerErrors + muxErrors + captionErrors).toBe(true);
        expect(packetSha256).toBe(await hashFile(previous.elementary));
        expect(await hashFile(output)).toBe(previous.outputSha256);
        expect(await fsp.stat(pixels).then((entry) => entry.size)).toBe(0);
        await fsp.writeFile(
          reportFile,
          JSON.stringify(
            {
              ...previous,
              sourceCommit: sdk.commit,
              workerSha256: sdk.workerSha256,
              elementary: null,
              output,
              outputSha256: await hashFile(output),
              rawPixels: pixels,
              measurement: native,
              sharedScene: admittedScene,
              encodedTransport: "bounded-packet-pipe",
              packetSha256,
              captionBand: bandProof,
              pipelineSeconds: (performance.now() - clock) / 1000,
            },
            null,
            2,
          ),
        );
        const verify = process.env.ARTDADDY_NATIVE_MUX_VERIFY === "1";
        if (verify) await verifyFrozenArtifact(reportFile);
        console.log(
          JSON.stringify({
            mode,
            report: reportFile,
            bytes,
            packetSha256,
            elementaryScratchBytes: 0,
            artifactVerified: verify,
          }),
        );
      },
      270000,
    );
  },
);

describe.skipIf(!process.env.ARTDADDY_NATIVE_SCENE_SETUP)("E0 shared native scene fixture", () => {
  it("serializes the shared scene placement without inventing a second layout rule", async () => {
    const readers = Number(process.env.ARTDADDY_NATIVE_SCENE_READERS ?? 16);
    const frames = Number(process.env.ARTDADDY_NATIVE_SCENE_FRAMES ?? 180);
    const mode = process.env.ARTDADDY_NATIVE_SCENE_MODE ?? "tiles";
    const mediaAlpha = mode === "alpha" || mode === "alpha-reverse";
    const captions = mode === "captions" || mode === "captions-overlap";
    const offCanvas = mode === "motion-offcanvas";
    const rotation = mode === "motion-rotation";
    const cropFlip = mode === "motion-crop-flip";
    const sourceWindow = mode === "motion-cover" || cropFlip || offCanvas || rotation;
    const motion = mode === "motion" || mode === "motion-nonuniform" || sourceWindow;
    const nonuniform = mode === "motion-nonuniform" || sourceWindow;
    const overlap = mode !== "tiles";
    expect([
      "tiles",
      "overlap",
      "overlap-reverse",
      "alpha",
      "alpha-reverse",
      "captions",
      "captions-overlap",
      "motion",
      "motion-nonuniform",
      "motion-cover",
      "motion-crop-flip",
      "motion-offcanvas",
      "motion-rotation",
    ]).toContain(mode);
    expect([1, 16]).toContain(readers);
    expect([180, 1800, 3600]).toContain(frames);
    if (overlap)
      expect(readers).toBe(mode === "captions" || cropFlip || offCanvas || rotation ? 1 : 16);
    const baseline = JSON.parse(
      await fsp.readFile(
        path.join(process.cwd(), "reports/bench/export-feasibility-baseline.json"),
        "utf8",
      ),
    ) as {
      fixtureDir: string;
      profile: { width: number; height: number; fps: number };
      cases: Array<{
        level: string;
        artifact: {
          sourceSha256: string;
          outputSha256: string;
          sourcePath: string;
          outputPath: string;
        };
      }>;
    };
    expect(baseline.profile).toMatchObject({ width: 3840, height: 2160, fps: 60 });
    const fixture = await fsp.realpath(baseline.fixtureDir);
    expect(path.basename(fixture)).toMatch(/^artdaddy-bench-render-/);
    expect(fixture.startsWith((await fsp.realpath(os.tmpdir())) + path.sep)).toBe(true);
    const source = baseline.cases.find((entry) => entry.level === "simple")!.artifact;
    expect(await hashFile(source.sourcePath)).toBe(source.sourceSha256);
    expect(await hashFile(source.outputPath)).toBe(source.outputSha256);
    const timeline: Timeline = {
      units: "frames",
      canvas: { width: 3840, height: 2160, fps: 60 },
      tracks: Array.from({ length: readers }, (_, reader) => ({
        id: `native-track-${reader}`,
        kind: "video" as const,
        z: mode.endsWith("-reverse") && reader > 0 ? readers - reader : reader,
        clips: Array.from({ length: frames / 180 }, (_, repeat) => ({
          id: `native-clip-${reader}-${repeat}`,
          kind: mediaAlpha && reader > 0 ? ("image" as const) : ("video" as const),
          media_ref: `native-source-${reader}`,
          timeline_in: repeat * 180,
          timeline_out: (repeat + 1) * 180,
          source_in: 0,
          source_out: 180,
          ...(readers === 16 && (!overlap || reader > 0)
            ? {
                transform: {
                  scale: 0.25,
                  position: overlap
                    ? {
                        x: 0.375 + (reader % 3) * 0.0625,
                        y: 0.375 + Math.floor((reader - 1) / 3) * 0.125,
                      }
                    : { x: ((reader % 4) + 0.5) / 4, y: (Math.floor(reader / 4) + 0.5) / 4 },
                },
              }
            : {}),
          ...(overlap && reader > 0
            ? {
                opacity: kf([
                  [0, 0.9],
                  [60, 0.5],
                  [179, 0.2],
                ]),
              }
            : {}),
          ...(sourceWindow && reader === readers - 1 ? { fit: "cover" as const } : {}),
          ...(cropFlip && reader === readers - 1
            ? {
                crop: { left: 0.125, right: 0.25, top: 0.25, bottom: 0.125 },
                flip: { h: true, v: true },
              }
            : {}),
          ...(rotation
            ? {
                rotate: [
                  { t: 0, v: 0, ease: "hold" as const },
                  { t: 60, v: 45, ease: "hold" as const },
                  { t: 120, v: -30, ease: "hold" as const },
                ],
              }
            : {}),
          ...(motion && reader === readers - 1
            ? {
                transform: {
                  scale: [
                    { t: 0, v: 0.25, ease: "hold" },
                    { t: 60, v: 0.375, ease: "hold" },
                    { t: 120, v: 0.25, ease: "hold" },
                  ],
                  ...(nonuniform
                    ? {
                        scale_x: [
                          { t: 0, v: 0.25, ease: "hold" },
                          { t: 60, v: 0.375, ease: "hold" },
                          { t: 120, v: 0.25, ease: "hold" },
                        ],
                        scale_y: [
                          { t: 0, v: 0.25, ease: "hold" },
                          { t: 60, v: 0.125, ease: "hold" },
                          { t: 120, v: 0.25, ease: "hold" },
                        ],
                      }
                    : {}),
                  position: {
                    x: [
                      { t: 0, v: 0.25, ease: "hold" },
                      { t: 60, v: 0.625, ease: "hold" },
                      { t: 120, v: 0.25, ease: "hold" },
                    ],
                    y: [
                      { t: 0, v: 0.375, ease: "hold" },
                      { t: 60, v: 0.625, ease: "hold" },
                      { t: 120, v: 0.375, ease: "hold" },
                    ],
                  },
                },
              }
            : {}),
          ...(offCanvas
            ? {
                transform: {
                  scale: [
                    { t: 0, v: 0.25, ease: "hold" },
                    { t: 60, v: 0.375, ease: "hold" },
                    { t: 120, v: 0.25, ease: "hold" },
                  ],
                  position: {
                    x: [
                      { t: 0, v: 0.05, ease: "hold" },
                      { t: 60, v: 0.9, ease: "hold" },
                      { t: 120, v: 0.05, ease: "hold" },
                    ],
                    y: 0.5,
                  },
                },
              }
            : {}),
        })),
      })),
    };
    const dimensions = new Map(
      Array.from({ length: readers }, (_, reader) => [
        `native-source-${reader}`,
        { w: 3840, h: 2160 },
      ]),
    );
    if (captions) {
      timeline.tracks.push({
        id: "native-caption-track",
        kind: "text",
        z: readers,
        clips: Array.from({ length: frames / 180 }, (_, repeat) => ({
          id: `native-caption-clip-${repeat}`,
          kind: "text" as const,
          timeline_in: repeat * 180,
          timeline_out: (repeat + 1) * 180,
          content: [
            { text: "ALPHA", t_in: 0, t_out: 0.7 },
            { text: "CAPTION", t_in: 0.7, t_out: 1.4 },
            { text: "STREAM", t_in: 1.4, t_out: 3 },
          ],
          animation: { build: "typewriter", timing: "explicit" },
          style: {
            font: "Poppins",
            size: 180,
            color: "#ffffff",
            outline: { color: "#ffffff", width: 12 },
          },
        })),
      });
    }
    const initial = buildScene(timeline, 0, dimensions);
    expect(initial.textLayers).toHaveLength(captions ? 1 : 0);
    expect(initial.layers).toHaveLength(readers);
    const placements = initial.layers.map((layer) => {
      expect(layer.kind).toBe(mediaAlpha && layer.source !== "native-source-0" ? "image" : "video");
      if (!overlap) expect(layer.opacity).toBe(1);
      else expect(layer.opacity >= 0 && layer.opacity <= 1).toBe(true);
      expect(layer.rotate).toBe(0);
      expect(layer.blend).toBe("normal");
      if (cropFlip && layer.source === `native-source-${readers - 1}`) {
        expect(layer.src.w).toBeLessThan(0);
        expect(layer.src.h).toBeLessThan(0);
      } else expect(layer.src).toEqual({ x: 0, y: 0, w: 1, h: 1 });
      const reader = Number(layer.source.replace("native-source-", ""));
      expect(Number.isInteger(reader) && reader >= 0 && reader < readers).toBe(true);
      for (const value of Object.values(layer.dst)) expect(Number.isInteger(value)).toBe(true);
      if (!offCanvas) for (const value of Object.values(layer.dst)) expect(value % 2).toBe(0);
      return { reader, ...layer.dst };
    });
    const resolvedLayers: Array<{
      reader: number;
      x: number;
      y: number;
      w: number;
      h: number;
      opacity: number;
      sourceFrame: number;
    }> = [];
    const resolvedSources: Array<{ x: number; y: number; w: number; h: number }> = [];
    const resolvedAngles: number[] = [];
    for (let frame = 0; frame < frames; frame++) {
      const scene = buildScene(timeline, frame / 60, dimensions);
      expect(scene.textLayers).toHaveLength(captions ? 1 : 0);
      expect(
        scene.layers.map((layer) => ({
          source: layer.source,
          ...(motion ? {} : { dst: layer.dst }),
          ...(sourceWindow ? {} : { src: layer.src }),
          ...(overlap ? {} : { opacity: layer.opacity }),
          ...(rotation ? {} : { rotate: layer.rotate }),
          blend: layer.blend,
        })),
      ).toEqual(
        initial.layers.map((layer) => ({
          source: layer.source,
          ...(motion ? {} : { dst: layer.dst }),
          ...(sourceWindow ? {} : { src: layer.src }),
          ...(overlap ? {} : { opacity: layer.opacity }),
          ...(rotation ? {} : { rotate: layer.rotate }),
          blend: layer.blend,
        })),
      );
      for (const layer of scene.layers) {
        const image = mediaAlpha && layer.source !== "native-source-0";
        if (image) expect(layer.sourceTime).toBeUndefined();
        else expect(layer.sourceTime).toBeCloseTo((frame % 180) / 60, 8);
        expect(layer.opacity >= 0 && layer.opacity <= 1).toBe(true);
        resolvedLayers.push({
          reader: Number(layer.source.replace("native-source-", "")),
          ...layer.dst,
          opacity: layer.opacity,
          sourceFrame: image ? 0 : Math.round(layer.sourceTime! * 60),
        });
        resolvedSources.push({ ...layer.src });
        resolvedAngles.push(layer.rotate);
      }
    }
    if (overlap && readers > 1)
      expect(resolvedLayers.slice(0, readers).map((layer) => layer.opacity)).not.toEqual(
        resolvedLayers.slice(179 * readers, 180 * readers).map((layer) => layer.opacity),
      );
    if (motion) {
      const first = resolvedLayers[readers - 1];
      const moved = resolvedLayers[60 * readers + readers - 1];
      const returned = resolvedLayers[120 * readers + readers - 1];
      expect(moved.x).not.toBe(first.x);
      if (!offCanvas) expect(moved.y).not.toBe(first.y);
      if (offCanvas) {
        expect(first.x).toBeLessThan(0);
        expect(moved.x + moved.w).toBeGreaterThan(3840);
      } else if (sourceWindow) {
        expect(moved.w).toBeGreaterThan(first.w);
        expect(moved.h).toBeLessThan(first.h);
        expect(Math.abs(resolvedSources[60 * readers + readers - 1].h)).toBeLessThan(1);
      } else if (nonuniform) {
        expect(moved.w).toBeLessThan(first.w);
        expect(moved.h).toBeLessThan(first.h);
        expect(moved.w / moved.h).toBeCloseTo(first.w / first.h, 8);
      } else {
        expect(moved.w).toBeGreaterThan(first.w);
        expect(moved.h).toBeGreaterThan(first.h);
      }
      expect({ x: returned.x, y: returned.y, w: returned.w, h: returned.h }).toEqual({
        x: first.x,
        y: first.y,
        w: first.w,
        h: first.h,
      });
    }
    const work = await fsp.mkdtemp(path.join(fixture, "native-plan-"));
    if (rotation) {
      expect(resolvedAngles[0]).toBe(0);
      expect(resolvedAngles[60]).toBeCloseTo(Math.PI / 4, 8);
      expect(resolvedAngles[120]).toBeCloseTo(-Math.PI / 6, 8);
    }
    const binary = Buffer.alloc(
      overlap
        ? 20 + resolvedLayers.length * (rotation ? 48 : sourceWindow ? 44 : 28)
        : (5 + readers * 5) * 4,
    );
    [
      rotation
        ? 0x4e504c37
        : offCanvas
          ? 0x4e504c36
          : sourceWindow
            ? 0x4e504c35
            : captions
              ? 0x4e504c34
              : mediaAlpha
                ? 0x4e504c33
                : overlap
                  ? 0x4e504c32
                  : 0x4e504c31,
      readers,
      frames,
      3840,
      2160,
    ].forEach((value, index) => binary.writeUInt32LE(value, index * 4));
    if (overlap) {
      resolvedLayers.forEach((layer, index) => {
        const offset = 20 + index * 28;
        [layer.reader, layer.x, layer.y, layer.w, layer.h].forEach((value, field) => {
          if (offCanvas && (field === 1 || field === 2))
            binary.writeInt32LE(value, offset + field * 4);
          else binary.writeUInt32LE(value, offset + field * 4);
        });
        binary.writeFloatLE(layer.opacity, offset + 20);
        binary.writeUInt32LE(layer.sourceFrame, offset + 24);
      });
      if (sourceWindow)
        resolvedSources.forEach((source, index) => {
          const offset = 20 + resolvedLayers.length * 28 + index * 16;
          [source.x, source.y, source.w, source.h].forEach((value, field) =>
            binary.writeFloatLE(value, offset + field * 4),
          );
        });
      if (rotation)
        resolvedAngles.forEach((angle, index) =>
          binary.writeFloatLE(angle, 20 + resolvedLayers.length * 44 + index * 4),
        );
    } else
      placements.forEach((placement, index) =>
        [placement.reader, placement.x, placement.y, placement.w, placement.h].forEach(
          (value, field) => binary.writeUInt32LE(value, (5 + index * 5 + field) * 4),
        ),
      );
    const file = path.join(work, "scene.bin");
    await fsp.writeFile(file, binary);
    let captionPlane:
      | {
          ass: string;
          sha256: string;
          fonts: Array<{ file: string; sha256: string }>;
          frames: number;
          fps: number;
        }
      | undefined;
    if (captions) {
      const captionPlan = buildRenderCommand(timeline, path.join(work, "unused.mp4"));
      expect(captionPlan.assFiles).toHaveLength(1);
      await fsp.mkdir(path.join(work, "fonts"));
      const fonts: Array<{ file: string; sha256: string }> = [];
      for (const font of captionPlan.fonts) {
        const target = path.join(work, "fonts", font);
        await fsp.copyFile(path.join(process.cwd(), "src-tauri/resources/fonts", font), target);
        fonts.push({ file: target, sha256: await hashFile(target) });
      }
      expect(fonts.length).toBeGreaterThan(0);
      const ass = path.join(work, captionPlan.assFiles[0].name);
      await fsp.writeFile(ass, captionPlan.assFiles[0].content);
      captionPlane = { ass, sha256: await hashFile(ass), fonts, frames, fps: 60 };
    }
    let alphaAsset:
      | {
          path: string;
          sha256: string;
          rgba: string;
          rgbaSha256: string;
          width: number;
          height: number;
        }
      | undefined;
    if (mediaAlpha) {
      const rgba = path.join(work, "source.rgba");
      const bytes = Buffer.alloc(3840 * 2160 * 4);
      for (let row = 0; row < 2160; row++) {
        for (let column = 0; column < 3840; column++) {
          const offset = (row * 3840 + column) * 4;
          const section = Math.floor(column / 960);
          bytes[offset] = 235;
          bytes[offset + 1] = Math.floor(row / 270) % 2 ? 45 : 185;
          bytes[offset + 2] = 90;
          bytes[offset + 3] = [0, 64, 128, 255][section];
        }
      }
      await fsp.writeFile(rgba, bytes);
      const image = path.join(work, "transparent-source.png");
      await ff([
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "-s",
        "3840x2160",
        "-i",
        rgba,
        "-frames:v",
        "1",
        image,
      ]);
      const decoded = await bytesFromFfmpeg([
        "-i",
        image,
        "-frames:v",
        "1",
        "-pix_fmt",
        "rgba",
        "-f",
        "rawvideo",
        "-",
      ]);
      expect(
        decoded.equals(bytes),
        "PNG decoder preserves actual RGB and all four alpha levels",
      ).toBe(true);
      alphaAsset = {
        path: image,
        sha256: await hashFile(image),
        rgba,
        rgbaSha256: await hashFile(rgba),
        width: 3840,
        height: 2160,
      };
    }
    let renderReference:
      { path: string; sha256: string; seconds: number; referenceFrames?: number } | undefined;
    if (overlap && process.env.ARTDADDY_NATIVE_SCENE_REUSE_REPORT) {
      const previous = JSON.parse(
        await fsp.readFile(process.env.ARTDADDY_NATIVE_SCENE_REUSE_REPORT, "utf8"),
      ) as {
        sharedScene: {
          mode: string;
          frames: number;
          sourceSha256: string;
          renderReference: NonNullable<typeof renderReference>;
          timeline: Timeline;
        };
      };
      expect(previous.sharedScene.mode).toBe(mode);
      expect(previous.sharedScene.frames).toBe(180);
      expect(previous.sharedScene.sourceSha256).toBe(source.sourceSha256);
      expect(await hashFile(previous.sharedScene.renderReference.path)).toBe(
        previous.sharedScene.renderReference.sha256,
      );
      const previousScene = buildScene(previous.sharedScene.timeline, 0, dimensions);
      if (captions) {
        const previousCaptions = resolveRenderPlan(previous.sharedScene.timeline).clips.filter(
          (clip) => clip.text,
        );
        const actualCaptions = resolveRenderPlan(timeline).clips.filter((clip) => clip.text);
        expect(previousCaptions).toHaveLength(1);
        expect(actualCaptions).toHaveLength(frames / 180);
        for (const caption of actualCaptions)
          expect(caption.text).toEqual(previousCaptions[0].text);
      }
      expect(
        previousScene.layers.map((layer) => ({
          source: layer.source,
          dst: layer.dst,
          opacity: layer.opacity,
        })),
      ).toEqual(
        initial.layers.map((layer) => ({
          source: layer.source,
          dst: layer.dst,
          opacity: layer.opacity,
        })),
      );
      for (let frame = 0; frame < frames; frame++) {
        const expected = buildScene(previous.sharedScene.timeline, (frame % 180) / 60, dimensions);
        const actual = resolvedLayers.slice(frame * readers, (frame + 1) * readers);
        expect(
          actual.map((layer) => ({
            reader: layer.reader,
            x: layer.x,
            y: layer.y,
            w: layer.w,
            h: layer.h,
            opacity: Math.fround(layer.opacity),
            sourceFrame: layer.sourceFrame,
          })),
        ).toEqual(
          expected.layers.map((layer) => ({
            reader: Number(layer.source.replace("native-source-", "")),
            ...layer.dst,
            opacity: Math.fround(layer.opacity),
            sourceFrame: Math.round(layer.sourceTime! * 60),
          })),
        );
      }
      renderReference = { ...previous.sharedScene.renderReference, referenceFrames: 180 };
    }
    if (overlap && process.env.ARTDADDY_NATIVE_SCENE_REFERENCE === "1") {
      const project = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-native-reference-"));
      installE2EDocuments();
      try {
        await openE2EDoc(project);
        const context = mkCtx(project);
        const media = await libRef(context, source.sourcePath, "video");
        const image = alphaAsset ? await libRef(context, alphaAsset.path, "image") : undefined;
        const referenceTimeline = structuredClone(timeline);
        for (const track of referenceTimeline.tracks)
          for (const clip of track.clips ?? [])
            clip.media_ref = clip.kind === "image" ? image! : media;
        await ensureTimeline(context.store);
        await replaceTimeline(context.store, referenceTimeline);
        const started = Date.now();
        const rendered = await renderMp4(
          { ...context, signal: AbortSignal.timeout(120_000) },
          project,
        );
        const retained = path.join(work, "legacy-reference.mp4");
        await fsp.copyFile(rendered, retained);
        const metadata = await probe(retained);
        expect(metadata.width).toBe(3840);
        expect(metadata.height).toBe(2160);
        expect(metadata.vDurationS).toBeCloseTo(frames / 60, 5);
        renderReference = {
          path: retained,
          sha256: await hashFile(retained),
          seconds: (Date.now() - started) / 1000,
        };
      } finally {
        await resetE2EDocuments();
      }
    }
    const reportFile = process.env.ARTDADDY_NATIVE_SCENE_SETUP!;
    expect(path.basename(reportFile)).toBe("native-scene-current.json");
    expect(await fsp.realpath(path.dirname(reportFile))).toBe(fixture);
    await fsp.writeFile(
      reportFile,
      JSON.stringify(
        {
          status: "shared_scene_fixture_only",
          file,
          sha256: await hashFile(file),
          readers,
          frames,
          mode,
          sourceSha256: source.sourceSha256,
          referenceSha256: source.outputSha256,
          timeline,
          placements,
          renderReference,
          alphaAsset,
          captionPlane,
          scope: overlap
            ? "shared per-frame source/placement/z-order/opacity; native GPU reference conformance still pending"
            : "shared rules resolve opaque fixed rectangles across every frame; no general feature/crop/alpha conformance",
        },
        null,
        2,
      ),
    );
  }, 150_000);
});

describe.skipIf(process.env.ARTDADDY_EXPORT_BOUNDARY !== "1")(
  "E1 rendered artifact boundary",
  () => {
    it.each(["video", "audio"])(
      "refuses undeclared duplicate %s streams in a real artifact",
      async (kind) => {
        const work = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-export-stream-count-"));
        const source = path.join(work, "source.mp4"),
          output = path.join(work, `duplicate-${kind}.mp4`);
        await ff([
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=s=320x180:r=30:d=1",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=1",
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-shortest",
          source,
        ]);
        const timeline: Timeline = {
          units: "frames",
          canvas: { width: 320, height: 180, fps: 30 },
          tracks: [
            {
              id: "picture",
              kind: "video",
              z: 0,
              clips: [
                {
                  id: "picture",
                  kind: "video",
                  media_ref: source,
                  source_in: 0,
                  source_out: 30,
                  timeline_in: 0,
                  timeline_out: 30,
                },
              ],
            },
            {
              id: "sound",
              kind: "audio",
              z: 0,
              clips: [
                {
                  id: "sound",
                  kind: "audio",
                  media_ref: source,
                  source_in: 0,
                  source_out: 30,
                  timeline_in: 0,
                  timeline_out: 30,
                },
              ],
            },
          ],
        };
        const plan = buildRenderCommand(timeline, output);
        expect(plan.audioExpected).toBe(true);
        const context = mkCtx(work);
        const completed = { code: 0, stdout: "", stderr: "" };
        expect((await finishRenderJob(context, { plan, stagePath: source }, completed)).ok).toBe(
          true,
        );
        await ff([
          "-y",
          "-i",
          source,
          "-map",
          "0:v:0",
          ...(kind === "video" ? ["-map", "0:v:0"] : []),
          "-map",
          "0:a:0",
          ...(kind === "audio" ? ["-map", "0:a:0"] : []),
          "-c",
          "copy",
          output,
        ]);
        const probe = await context.runner.run("ffprobe", [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_type",
          "-of",
          "json",
          output,
        ]);
        expect(probe.code).toBe(0);
        const streams = JSON.parse(probe.stdout).streams as Array<{ codec_type: string }>;
        expect(streams.filter((stream) => stream.codec_type === kind)).toHaveLength(2);
        const result = await finishRenderJob(context, { plan, stagePath: output }, completed);
        expect(result.ok, `duplicate ${kind} stream was accepted`).toBe(false);
        expect(String(result.error)).toContain(`rendered ${kind} failed validation`);
      },
      60000,
    );

    it("rejects successful-process artifacts that do not match the submitted video contract", async () => {
      const work = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-export-boundary-"));
      const context = mkCtx(work);
      const plan: ExportJobPlan = {
        contractVersion: RENDER_CONTRACT_VERSION,
        duration: 1,
        output: { width: 320, height: 180, fps: 30 },
        frame: false,
        audioMustSpanVideo: false,
        audioExpected: false,
        warnings: [],
        sources: [],
      };
      const cases = [
        { name: "valid", width: 320, height: 180, fps: 30, duration: 1, accepted: true },
        { name: "dimensions", width: 640, height: 360, fps: 30, duration: 1, accepted: false },
        { name: "frame-count", width: 320, height: 180, fps: 30, duration: 0.5, accepted: false },
        { name: "frame-rate", width: 320, height: 180, fps: 25, duration: 1, accepted: false },
      ];
      for (const sample of cases) {
        const file = path.join(work, `${sample.name}.mp4`);
        await ff([
          "-y",
          "-f",
          "lavfi",
          "-i",
          `testsrc2=s=${sample.width}x${sample.height}:r=${sample.fps}:d=${sample.duration}`,
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          file,
        ]);
        const result = await finishRenderJob(
          context,
          { plan, stagePath: file },
          { code: 0, stdout: "", stderr: "" },
        );
        expect(result.ok, sample.name).toBe(sample.accepted);
        if (!sample.accepted)
          expect(String(result.error)).toContain("rendered video failed validation");
      }
      const audio = path.join(work, "audio-only.m4a");
      await ff(["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac", audio]);
      expect(
        (
          await finishRenderJob(
            context,
            { plan, stagePath: audio },
            { code: 0, stdout: "", stderr: "" },
          )
        ).ok,
      ).toBe(false);
      const legacy = { ...plan } as Partial<ExportJobPlan>;
      delete legacy.output;
      const file = path.join(work, "valid.mp4");
      const result = await finishRenderJob(
        context,
        { plan: legacy as ExportJobPlan, stagePath: file },
        { code: 0, stdout: "", stderr: "" },
      );
      expect(result.ok, "old job metadata cannot skip artifact verification").toBe(false);
      expect(String(result.error)).toContain("no supported output contract");
      const unsupported = { ...plan, contractVersion: -1 };
      const skewed = await finishRenderJob(
        context,
        { plan: unsupported, stagePath: file },
        { code: 0, stdout: "", stderr: "" },
      );
      expect(skewed.ok, "valid video bytes do not make an unsupported compiler contract safe").toBe(
        false,
      );
      expect(String(skewed.error)).toContain("unsupported render contract");
      const previousRevision = await finishRenderJob(
        context,
        { plan: { ...plan, contractVersion: RENDER_CONTRACT_VERSION - 1 }, stagePath: file },
        { code: 0, stdout: "", stderr: "" },
      );
      expect(
        previousRevision.ok,
        "an older artifact proof cannot claim the stronger current validation",
      ).toBe(false);
      expect(String(previousRevision.error)).toContain("unsupported render contract");
      const missingAudio = await finishRenderJob(
        context,
        { plan: { ...plan, audioExpected: true }, stagePath: file },
        { code: 0, stdout: "", stderr: "" },
      );
      expect(missingAudio.ok, "a valid picture cannot stand in for the submitted sound").toBe(
        false,
      );
      expect(String(missingAudio.error)).toContain("rendered audio");
      const unexpected = path.join(work, "unexpected-audio.mp4");
      await ff([
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=320x180:r=30:d=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        unexpected,
      ]);
      const extraAudio = await finishRenderJob(
        context,
        { plan, stagePath: unexpected },
        { code: 0, stdout: "", stderr: "" },
      );
      expect(extraAudio.ok, "a silent submitted edit cannot gain an undeclared audio stream").toBe(
        false,
      );
      expect(String(extraAudio.error)).toContain("rendered audio");
    }, 60_000);

    it("delivers the submitted plan and destination despite later caller mutation", async () => {
      const work = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-export-snapshot-"));
      installE2EDocuments();
      try {
        await openE2EDoc(work);
        const context = mkCtx(work);
        const destination = path.join(work, "submitted.mp4");
        const stage = path.join(work, "submitted.partial");
        const timeline: Timeline = {
          units: "frames",
          canvas: { width: 320, height: 180, fps: 30 },
          tracks: [
            {
              id: "text",
              kind: "text",
              z: 0,
              clips: [
                {
                  id: "caption",
                  kind: "text",
                  text: "SUBMITTED",
                  timeline_in: 0,
                  timeline_out: 30,
                  style: { font: "Poppins", size: 48 },
                },
              ],
            },
          ],
        };
        await ensureTimeline(context.store);
        await replaceTimeline(context.store, timeline);
        const captured = await loadForRender(context, "working");
        if (!captured.ok) throw new Error(String(captured.result.error));
        expect(captured.admission.snapshotSha256).toMatch(/^[a-f0-9]{64}$/);
        const request = {
          plan: buildRenderCommand(captured.seconds, stage),
          admission: captured.admission,
          destPath: destination,
          stagePath: stage,
          filename: "submitted.mp4",
          quality: "",
        };
        const submitted = queueRenderJob(context, request);
        request.destPath = path.join(work, "changed.mp4");
        request.stagePath = path.join(work, "changed.partial");
        request.plan.args = ["-this-would-fail"];
        request.plan.output.width = 2;
        const admission = await submitted;
        const outcome = await whenExportEnds(admission.job_id);
        expect(outcome?.state).toBe("done");
        expect(outcome?.destPath).toBe(destination);
        const metadata = await probe(destination);
        expect(metadata).toMatchObject({ width: 320, height: 180 });
        expect(metadata.vDurationS).toBeCloseTo(1, 5);
        expect(await fsp.stat(request.destPath).catch(() => null)).toBe(null);
        const changedSession = {
          ...request,
          plan: buildRenderCommand(captured.seconds, path.join(work, "rejected.partial")),
          admission: { ...captured.admission, projectDir: path.join(work, "different-project") },
          stagePath: path.join(work, "rejected.partial"),
          destPath: path.join(work, "rejected.mp4"),
        };
        await expect(queueRenderJob(context, changedSession)).rejects.toThrow(
          "closed or different project session",
        );
        expect(await fsp.stat(changedSession.destPath).catch(() => null)).toBe(null);
        const malformed = [
          {
            name: "older-artifact-contract",
            alter: (plan: ReturnType<typeof buildRenderCommand>) => {
              plan.contractVersion = RENDER_CONTRACT_VERSION - 1;
            },
          },
          {
            name: "zero-width",
            alter: (plan: ReturnType<typeof buildRenderCommand>) => {
              plan.output.width = 0;
            },
          },
          {
            name: "nonfinite-fps",
            alter: (plan: ReturnType<typeof buildRenderCommand>) => {
              plan.output.fps = NaN;
            },
          },
          {
            name: "negative-duration",
            alter: (plan: ReturnType<typeof buildRenderCommand>) => {
              plan.duration = -1;
            },
          },
          {
            name: "overflowing-frame-count",
            alter: (plan: ReturnType<typeof buildRenderCommand>) => {
              plan.duration = Number.MAX_SAFE_INTEGER;
            },
          },
          {
            name: "frame-with-audio",
            alter: (plan: ReturnType<typeof buildRenderCommand>) => {
              plan.frame = true;
              plan.audioExpected = true;
            },
          },
          {
            name: "silent-spanning-audio",
            alter: (plan: ReturnType<typeof buildRenderCommand>) => {
              plan.audioMustSpanVideo = true;
            },
          },
        ];
        for (const sample of malformed) {
          const stagePath = path.join(work, `${sample.name}.partial`);
          const destPath = path.join(work, `${sample.name}.mp4`);
          const plan = buildRenderCommand(captured.seconds, stagePath);
          sample.alter(plan);
          await expect(
            queueRenderJob(context, {
              plan,
              admission: captured.admission,
              stagePath,
              destPath,
              filename: `${sample.name}.mp4`,
              quality: "",
            }),
            sample.name,
          ).rejects.toThrow(
            sample.name === "older-artifact-contract"
              ? "unsupported render contract"
              : "supported output contract",
          );
          expect(await fsp.stat(stagePath).catch(() => null), sample.name).toBe(null);
          expect(await fsp.stat(destPath).catch(() => null), sample.name).toBe(null);
        }
      } finally {
        await resetE2EDocuments();
      }
    }, 60_000);
  },
);

describe.skipIf(process.env.ARTDADDY_EXPORT_BOUNDARY !== "1")("E2 audio layout conformance", () => {
  it("preserves stereo content when the first mixed source is mono in either ordering", async () => {
    const work = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-export-layout-"));
    const mono = path.join(work, "mono.wav"),
      stereo = path.join(work, "stereo.wav");
    await ff([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "aevalsrc=0.1*sin(2*PI*330*t):s=48000:d=2",
      "-c:a",
      "pcm_f64le",
      mono,
    ]);
    await ff([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "aevalsrc=0.1*sin(2*PI*440*t)|0.08*sin(2*PI*880*t):s=48000:d=2",
      "-c:a",
      "pcm_f64le",
      stereo,
    ]);
    const context = mkCtx(work);
    for (const [index, sources] of [
      [mono, stereo],
      [stereo, mono],
    ].entries()) {
      const timeline: Timeline = {
        units: "frames",
        canvas: { width: 320, height: 180, fps: 30 },
        tracks: sources.map((source, sourceIndex) => ({
          id: `audio-${sourceIndex}`,
          kind: "audio",
          z: sourceIndex,
          clips: [
            {
              id: `clip-${sourceIndex}`,
              kind: "audio",
              media_ref: source,
              timeline_in: 0,
              timeline_out: 60,
              source_in: 0,
              source_out: 60,
            },
          ],
        })),
      };
      const output = path.join(work, `order-${index}.mp4`);
      const plan = buildRenderCommand(timeline, output);
      const result = await context.runner.run("ffmpeg", plan.args);
      expect(result.code, result.stderr).toBe(0);
      const pcm = await bytesFromFfmpeg([
        "-i",
        output,
        "-map",
        "0:a",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-f",
        "f32le",
        "-",
      ]);
      expect(pcm.length / 8).toBe(96000);
      expect(toneMagnitude(pcm, 0, 440), "original stereo left remains present").toBeGreaterThan(
        0.07,
      );
      expect(
        toneMagnitude(pcm, 1, 880),
        "original stereo right cannot disappear behind a mono-first source",
      ).toBeGreaterThan(0.05);
      expect(toneMagnitude(pcm, 0, 330), "mono content is audible on the left").toBeGreaterThan(
        0.05,
      );
      expect(toneMagnitude(pcm, 1, 330), "mono content is audible on the right").toBeGreaterThan(
        0.05,
      );
      expect(
        toneMagnitude(pcm, 0, 880),
        "stereo right must not collapse into the left",
      ).toBeLessThan(0.01);
    }
  }, 60_000);
});

describe.skipIf(!process.env.ARTDADDY_NATIVE_CAPTION_SETUP)("E0 caption plane feasibility", () => {
  it("emits visible changing caption alpha rather than an inert transparent plane", async () => {
    const fixture = await fsp.realpath(process.env.ARTDADDY_NATIVE_CAPTION_SETUP!);
    expect(path.basename(fixture)).toMatch(/^artdaddy-bench-render-/);
    expect(fixture.startsWith((await fsp.realpath(os.tmpdir())) + path.sep)).toBe(true);
    const work = await fsp.mkdtemp(path.join(fixture, "native-caption-"));
    const timeline: Timeline = {
      units: "frames",
      canvas: { width: 3840, height: 2160, fps: 60 },
      tracks: [
        {
          id: "caption-track",
          kind: "text",
          z: 16,
          clips: [
            {
              id: "caption-clip",
              kind: "text",
              timeline_in: 0,
              timeline_out: 180,
              content: [
                { text: "ALPHA", t_in: 0, t_out: 0.7 },
                { text: "CAPTION", t_in: 0.7, t_out: 1.4 },
                { text: "STREAM", t_in: 1.4, t_out: 3 },
              ],
              animation: { build: "typewriter", timing: "explicit" },
              style: {
                font: "Poppins",
                size: 180,
                color: "#ffffff",
                outline: { color: "#ffffff", width: 12 },
              },
            },
          ],
        },
      ],
    };
    const plan = buildRenderCommand(timeline, path.join(work, "unused.mp4"));
    expect(plan.assFiles).toHaveLength(1);
    expect(plan.fonts.length).toBeGreaterThan(0);
    for (const asset of plan.assFiles)
      await fsp.writeFile(path.join(work, asset.name), asset.content);
    await fsp.mkdir(path.join(work, "fonts"));
    for (const font of plan.fonts)
      await fsp.copyFile(
        path.join(process.cwd(), "src-tauri/resources/fonts", font),
        path.join(work, "fonts", font),
      );
    const output = path.join(work, "caption-samples.rgba");
    const ffmpeg = shippedSidecar("ffmpeg");
    if (!ffmpeg)
      throw new Error("the bundled ffmpeg sidecar is required for the caption-plane check");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        ffmpeg,
        [
          "-y",
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=black@0:s=3840x2160:r=60:d=3,format=rgba",
          "-vf",
          `ass=f=${plan.assFiles[0].name}:fontsdir=fonts:alpha=1,select=eq(n\\,12)+eq(n\\,108)`,
          "-fps_mode",
          "passthrough",
          "-frames:v",
          "2",
          "-pix_fmt",
          "rgba",
          "-f",
          "rawvideo",
          output,
        ],
        { cwd: work, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
      );
      let errors = "";
      child.stderr.on("data", (chunk: Buffer) => {
        errors = (errors + chunk.toString()).slice(-8192);
      });
      const deadline = setTimeout(() => child.kill(), 60_000);
      child.on("error", (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(deadline);
        if (code === 0) resolve();
        else reject(new Error(`Caption plane failed (${code}): ${errors}`));
      });
    });
    const pixels = await fsp.readFile(output);
    const frameBytes = 3840 * 2160 * 4;
    expect(pixels.length).toBe(frameBytes * 2);
    const ink = [0, 0],
      partial = [0, 0],
      transparent = [0, 0],
      coverageWeighted = [0, 0];
    for (let sample = 0; sample < 2; sample++) {
      for (let offset = sample * frameBytes + 3; offset < (sample + 1) * frameBytes; offset += 4) {
        const alpha = pixels[offset];
        if (alpha > 0) ink[sample]++;
        if (alpha > 0 && alpha < 255) partial[sample]++;
        if (alpha > 10 && alpha < 200 && pixels[offset - 3] > 0 && pixels[offset - 3] <= alpha + 2)
          coverageWeighted[sample]++;
        if (alpha === 0) transparent[sample]++;
      }
    }
    await fsp.writeFile(
      path.join(work, "caption-plane.json"),
      JSON.stringify(
        {
          status:
            ink[0] > 0 &&
            ink[1] > ink[0] &&
            partial.every((count) => count > 0) &&
            transparent.every((count) => count > 0) &&
            coverageWeighted.every((count) => count > 0)
              ? "passed"
              : "failed",
          timeline,
          assFiles: plan.assFiles,
          fonts: plan.fonts,
          output,
          outputSha256: await hashFile(output),
          ink,
          partial,
          transparent,
          coverageWeighted,
          scope:
            "two actual 4K caption-alpha samples through shipped libass; not native composition or full caption conformance",
        },
        null,
        2,
      ),
    );
    expect(ink[0], "early caption really contributes alpha").toBeGreaterThan(0);
    expect(ink[1], "later reveal contains more caption pixels").toBeGreaterThan(ink[0]);
    for (const count of partial)
      expect(count, "anti-aliased glyph coverage remains partial alpha").toBeGreaterThan(0);
    for (const count of coverageWeighted)
      expect(
        count,
        "actual glyph RGB follows the declared coverage-weighted stream contract",
      ).toBeGreaterThan(0);
    for (const count of transparent)
      expect(count, "background is not an opaque rectangle").toBeGreaterThan(0);
  }, 90_000);
});

describe.skipIf(!process.env.ARTDADDY_NATIVE_CAPTION_COMPRESSION_REPORT)(
  "E0 lossless caption transfer",
  () => {
    it("reduces real transfer bytes without changing any frozen caption RGBA pixel", async () => {
      const report = JSON.parse(
        await fsp.readFile(process.env.ARTDADDY_NATIVE_CAPTION_COMPRESSION_REPORT!, "utf8"),
      ) as {
        status: string;
        output: string;
        outputSha256: string;
      };
      expect(report.status).toBe("passed");
      const fixture = await fsp.realpath(path.dirname(path.dirname(report.output)));
      expect(path.basename(fixture)).toMatch(/^artdaddy-bench-render-/);
      expect(fixture.startsWith((await fsp.realpath(os.tmpdir())) + path.sep)).toBe(true);
      expect(await hashFile(report.output)).toBe(report.outputSha256);
      const original = await fsp.readFile(report.output);
      expect(original.length).toBe(2 * 3840 * 2160 * 4);
      const work = await fsp.mkdtemp(path.join(fixture, "native-caption-lossless-"));
      const output = path.join(work, "captions.mov");
      await ff([
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "-s",
        "3840x2160",
        "-r",
        "60",
        "-i",
        report.output,
        "-frames:v",
        "2",
        "-c:v",
        "qtrle",
        "-pix_fmt",
        "argb",
        "-threads:v",
        "1",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "-f",
        "mov",
        output,
      ]);
      const sdk = JSON.parse(
        await fsp.readFile(
          path.join(os.tmpdir(), "artdaddy-export-native-sdk-c867e13549/sdk-provenance.json"),
          "utf8",
        ),
      ) as {
        runtimeRoot: string;
        libraries: Array<{ binary: string; binarySha256: string }>;
      };
      for (const library of sdk.libraries)
        expect(await hashFile(library.binary)).toBe(library.binarySha256);
      const decoded = await bytesFromFfmpeg(
        ["-i", output, "-map", "0:v", "-pix_fmt", "rgba", "-f", "rawvideo", "-"],
        path.join(sdk.runtimeRoot, "ffmpeg.exe"),
      );
      const compressedBytes = (await fsp.stat(output)).size;
      const identical = original.equals(decoded);
      await fsp.writeFile(
        path.join(work, "caption-transfer-comparison.json"),
        JSON.stringify(
          {
            status: identical && compressedBytes < original.length / 10 ? "passed" : "failed",
            identical,
            rawBytes: original.length,
            compressedBytes,
            sourceSha256: report.outputSha256,
            outputSha256: await hashFile(output),
            decodedSha256: createHash("sha256").update(decoded).digest("hex"),
            scope:
              "two frozen full-resolution RGBA samples through shipped QTRLE/fragmented MOV and pinned runtime decode; not live-stream throughput qualification",
          },
          null,
          2,
        ),
      );
      expect(identical, "lossless caption transfer preserves every alpha and colour byte").toBe(
        true,
      );
      expect(compressedBytes, "compression must have an actual measured effect").toBeLessThan(
        original.length / 10,
      );
    }, 90_000);
  },
);

describe.skipIf(!process.env.ARTDADDY_NATIVE_ALPHA_EDGE_REPORT)(
  "E0 native alpha edge invariant",
  () => {
    it("ignores fully transparent RGB while preserving visible colour changes after resizing", async () => {
      const report = JSON.parse(
        await fsp.readFile(process.env.ARTDADDY_NATIVE_ALPHA_EDGE_REPORT!, "utf8"),
      ) as {
        source: string;
        sourceSha256: string;
        frames: number;
        sharedScene: { file: string; sha256: string; mode: string };
      };
      const fixture = await fsp.realpath(path.dirname(report.source));
      expect(path.basename(fixture)).toMatch(/^artdaddy-bench-render-/);
      expect(fixture.startsWith((await fsp.realpath(os.tmpdir())) + path.sep)).toBe(true);
      expect(["alpha", "alpha-reverse"]).toContain(report.sharedScene.mode);
      expect(report.frames).toBe(180);
      expect((await fsp.realpath(report.sharedScene.file)).startsWith(fixture + path.sep)).toBe(
        true,
      );
      expect(await hashFile(report.source)).toBe(report.sourceSha256);
      expect(await hashFile(report.sharedScene.file)).toBe(report.sharedScene.sha256);
      const sdk = JSON.parse(
        await fsp.readFile(
          path.join(os.tmpdir(), "artdaddy-export-native-sdk-c867e13549/sdk-provenance.json"),
          "utf8",
        ),
      ) as {
        worker: string;
        workerSha256: string;
        runtimeRoot: string;
        libraries: Array<{ binary: string; binarySha256: string }>;
      };
      expect(await hashFile(sdk.worker)).toBe(sdk.workerSha256);
      for (const library of sdk.libraries)
        expect(await hashFile(library.binary)).toBe(library.binarySha256);
      const work = await fsp.mkdtemp(path.join(fixture, "native-alpha-edge-"));
      const pictures: Buffer[] = [];
      const outputs: Array<{ variant: number; path: string; sha256: string; rgbaSha256: string }> =
        [];
      for (let variant = 0; variant < 3; variant++) {
        const rgba = Buffer.alloc(3840 * 2160 * 4);
        for (let row = 0; row < 2160; row++) {
          for (let column = 0; column < 3840; column++) {
            const offset = (row * 3840 + column) * 4;
            const transparent = column % 4 < 2;
            const colour = transparent
              ? variant === 1
                ? [10, 30, 240]
                : [250, 5, 25]
              : variant === 2
                ? [25, 235, 245]
                : [245, 235, 25];
            rgba[offset] = colour[0];
            rgba[offset + 1] = colour[1];
            rgba[offset + 2] = colour[2];
            rgba[offset + 3] = transparent ? 0 : [64, 128, 255][Math.floor(row / 720)];
          }
        }
        const asset = path.join(work, `edge-${variant}.rgba`);
        await fsp.writeFile(asset, rgba);
        const video = path.join(work, `edge-${variant}.h264`);
        await new Promise<void>((resolve, reject) => {
          const child = spawn(
            sdk.worker,
            [
              sdk.runtimeRoot,
              report.source,
              path.join(work, `edge-${variant}.rgb`),
              "16",
              "180",
              "1",
              "1",
              "1",
              report.sharedScene.file,
              video,
              "536870912",
              asset,
            ],
            { windowsHide: true },
          );
          let errors = "";
          child.stdout.resume();
          child.stderr.on("data", (chunk: Buffer) => {
            errors = (errors + chunk.toString()).slice(-8192);
          });
          const deadline = setTimeout(() => child.kill(), 120_000);
          child.on("error", (error) => {
            clearTimeout(deadline);
            reject(error);
          });
          child.on("close", (code) => {
            clearTimeout(deadline);
            if (code === 0) resolve();
            else reject(new Error(`Native edge variant ${variant} failed (${code}): ${errors}`));
          });
        });
        const output = path.join(work, `edge-${variant}.mp4`);
        await ff(["-y", "-r", "60", "-i", video, "-map", "0:v", "-c:v", "copy", output]);
        const pixels = await bytesFromFfmpeg([
          "-i",
          output,
          "-map",
          "0:v",
          "-vf",
          "scale=128:72",
          "-pix_fmt",
          "rgb24",
          "-f",
          "rawvideo",
          "-",
        ]);
        expect(pixels.length).toBe(180 * 128 * 72 * 3);
        pictures.push(pixels);
        outputs.push({
          variant,
          path: output,
          sha256: await hashFile(output),
          rgbaSha256: await hashFile(asset),
        });
      }
      let hiddenDifference = 0,
        visibleDifference = 0;
      for (let offset = 0; offset < pictures[0].length; offset++) {
        hiddenDifference += Math.abs(pictures[0][offset] - pictures[1][offset]);
        visibleDifference += Math.abs(pictures[0][offset] - pictures[2][offset]);
      }
      hiddenDifference /= pictures[0].length;
      visibleDifference /= pictures[0].length;
      const hiddenIdentical = pictures[0].equals(pictures[1]);
      await fsp.writeFile(
        path.join(work, "alpha-edge-comparison.json"),
        JSON.stringify(
          {
            status: hiddenIdentical && visibleDifference > 3 ? "passed" : "failed",
            hiddenIdentical,
            hiddenDifference,
            visibleDifference,
            outputs,
            workerSha256: sdk.workerSha256,
            scope:
              "encoded subpixel alpha-edge invariant; no legacy-reference or full colour/format qualification",
          },
          null,
          2,
        ),
      );
      expect(await hashFile(report.source)).toBe(report.sourceSha256);
      expect(await hashFile(report.sharedScene.file)).toBe(report.sharedScene.sha256);
      expect(hiddenIdentical, "RGB belonging to alpha-zero texels cannot tint resized edges").toBe(
        true,
      );
      expect(
        visibleDifference,
        "visible RGB changes must not be silently discarded",
      ).toBeGreaterThan(3);
    }, 150_000);
  },
);

describe.skipIf(!process.env.ARTDADDY_NATIVE_WORKER_REPORT)(
  "E0 bounded native decode comparison",
  () => {
    it("preserves every source picture across every reader and rewind", async () => {
      const reportFile = process.env.ARTDADDY_NATIVE_WORKER_REPORT!;
      const report = JSON.parse(await fsp.readFile(reportFile, "utf8")) as {
        source: string;
        sourceSha256: string;
        baseline: string;
        baselineSha256: string;
        rawPixels: string;
        rawPixelsSha256: string;
        readers: number;
        frames: number;
        diagnostics?: boolean;
      };
      expect(report.diagnostics, "raw reader proof requires actual reader diagnostics").not.toBe(
        false,
      );
      const work = await fsp.realpath(path.dirname(reportFile));
      const fixture = path.dirname(work);
      expect(path.basename(work)).toMatch(/^native-worker-[a-f0-9]+$/);
      expect(path.basename(fixture)).toMatch(/^artdaddy-bench-render-/);
      expect(fixture.startsWith((await fsp.realpath(os.tmpdir())) + path.sep)).toBe(true);
      for (const source of [report.source, report.baseline])
        expect((await fsp.realpath(source)).startsWith(fixture + path.sep)).toBe(true);
      expect((await fsp.realpath(report.rawPixels)).startsWith(work + path.sep)).toBe(true);
      expect(await hashFile(report.source)).toBe(report.sourceSha256);
      expect(await hashFile(report.baseline)).toBe(report.baselineSha256);
      expect(await hashFile(report.rawPixels)).toBe(report.rawPixelsSha256);
      expect([1, 16]).toContain(report.readers);
      expect([180, 1800]).toContain(report.frames);
      const reference = await bytesFromFfmpeg([
        "-i",
        report.baseline,
        "-map",
        "0:v",
        "-vf",
        "scale=32:18",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "-",
      ]);
      const candidate = await fsp.readFile(report.rawPixels);
      const frameBytes = 32 * 18 * 3;
      expect(reference.length).toBe(180 * frameBytes);
      expect(candidate.length).toBe(report.readers * report.frames * frameBytes);
      const differences: number[] = [];
      const boundaries: Array<{ reader: number; frame: number; meanRgbDifference: number }> = [];
      const movingReaders: boolean[] = [];
      const temporalCorrelations: number[] = [];
      expect(reference.subarray(0, frameBytes).equals(reference.subarray(-frameBytes))).toBe(false);
      for (let reader = 0; reader < report.readers; reader++) {
        let totalDifference = 0;
        for (let frame = 0; frame < report.frames; frame++) {
          let difference = 0;
          const actualOffset = (frame * report.readers + reader) * frameBytes;
          const referenceOffset = (frame % 180) * frameBytes;
          for (let pixel = 0; pixel < frameBytes; pixel++)
            difference += Math.abs(
              candidate[actualOffset + pixel] - reference[referenceOffset + pixel],
            );
          totalDifference += difference;
          if (frame % 180 === 0 || frame % 180 === 179)
            boundaries.push({ reader, frame, meanRgbDifference: difference / frameBytes });
        }
        differences.push(totalDifference / (report.frames * frameBytes));
        const first = reader * frameBytes;
        const last = ((report.frames - 1) * report.readers + reader) * frameBytes;
        movingReaders.push(
          !candidate
            .subarray(first, first + frameBytes)
            .equals(candidate.subarray(last, last + frameBytes)),
        );
        temporalCorrelations.push(
          temporalCorrelation(reference, candidate, first, last, frameBytes),
        );
      }
      const passed =
        differences.every((difference) => difference < 3) &&
        boundaries.every((boundary) => boundary.meanRgbDifference < 3) &&
        movingReaders.every(Boolean) &&
        temporalCorrelations.every((correlation) => correlation > 0.5);
      await fsp.writeFile(
        path.join(work, "worker-artifact-comparison.json"),
        JSON.stringify(
          {
            status: passed ? "passed" : "failed",
            readers: report.readers,
            frames: report.frames,
            meanRgbDifferences: differences,
            boundaries,
            movingReaders,
            temporalCorrelations,
            rawPixelsSha256: report.rawPixelsSha256,
            scope:
              "every independent decoded picture/rewind against frozen reference; no encoder/audio/compositor qualification",
          },
          null,
          2,
        ),
      );
      for (const difference of differences)
        expect(difference, "native decoded RGB difference").toBeLessThan(3);
      for (const boundary of boundaries)
        expect(
          boundary.meanRgbDifference,
          `reader ${boundary.reader} exact boundary ${boundary.frame}`,
        ).toBeLessThan(3);
      for (const moving of movingReaders)
        expect(moving, "each decoded reader changes across source times").toBe(true);
      for (const correlation of temporalCorrelations)
        expect(
          correlation,
          "decoded motion follows the independently expected source-time direction",
        ).toBeGreaterThan(0.5);
    });
  },
);
