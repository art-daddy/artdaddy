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
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ff,
  have,
  installE2EDocuments,
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
import {
  buildRenderCommand,
  finishRenderJob,
  loadForRender,
  queueRenderJob,
  RENDER_CONTRACT_VERSION,
  type ExportJobPlan,
} from "../timeline/render";
import { whenExportEnds } from "../timeline/exportQueue";

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
