// 3j (UJ-023): a timeline clip exported as its own file is the whole export's frames and sound
// over that clip's span: every track, caption, transition and sound there, nothing else. Each case
// renders one timeline twice through buildRenderCommand, whole and as the span, losslessly (x264
// qp 0, PCM), and compares every frame's raw YUV and every audio sample. One frame or one sample
// off fails.
// Run: npx vitest run --config vitest.smoke.config.ts src/timeline/exportRange.smoke.e2e.ts
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from "vitest";

import { ff, mkCtx, installE2EDocuments, openE2EDoc, flushE2EDoc, resetE2EDocuments, libRef, runNativeRenderSequence } from "../tools/__e2e";
import type { ClientToolContext } from "../tools/context";
import { shippedSidecar, shippedSidecarPath } from "../test/sidecars";
import { FakeJobs } from "../test/fakeJobs";
import { supervisedRunner } from "../tools/jobSupervisor";
import { localDeliveryPort } from "./exportQueue";
import { resolveEffect, resolveGrade, typesFor } from "./effectRegistry";
import { TRANSITION_KINDS } from "./transition";
import { allEffects, paramSchema } from "../contract";
import { ensureTimeline, replaceTimeline } from "./engine";
import { setClipPropertiesTool, setKeyframesTool } from "./props";
import { resolveFit } from "./renderPlan";
import { fitRects } from "../preview/scene";
import { brandRatio, watermarkFile } from "./branding";
import type { ExportOptions } from "./exportOptions";
import { emptyTimeline, type Timeline } from "./model";
import { buildAudioRenderCommand, buildRenderCommand, resolveClipSources, runRenderPlan } from "./render";
import { __setExportConfirmationForTests } from "../lib/confirm";

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
let retainArtifacts = false;
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
async function decoded(file: string, audioFormat = "s16le"): Promise<{ frames: Buffer[]; pcm: Buffer }> {
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
  const pcm = await ffBytes(["-i", file, "-map", "0:a", "-f", audioFormat, "-"]);
  return { frames, pcm };
}

/** The export's own plan, encoded losslessly so nothing but the graph can differ. */
async function renderLossless(
  tl: Timeline,
  tag: string,
  options: ExportOptions = {},
  native = false,
  audioCodec = "pcm_s16le",
  delivery = false,
): Promise<string> {
  const out = path.join(dir, `${tag}.${delivery ? "mp4" : "mkv"}`);
  const plan = buildRenderCommand(tl, out, options);
  const args = [...plan.args];
  if (delivery) args.splice(args.lastIndexOf("-c:v") + 2, 0, "-threads:v", "1");
  else {
    args.splice(args.indexOf("-c:v"), 2, "-c:v", "libx264", "-qp", "0", "-preset", "ultrafast");
    const audio = args.indexOf("-c:a");
    if (audio >= 0) {
      args.splice(audio, 2, "-c:a", audioCodec);
      if (audioCodec === "pcm_f64le") args.splice(args.length - 1, 0, "-ar", String(RATE));
    }
    const format = args.lastIndexOf("-f");
    if (format >= 0 && args[format + 1] === "mp4") args.splice(format, 2, "-f", "matroska");
  }
  let renderContext = ctx;
  if (native) {
    const jobs = new FakeJobs();
    if (plan.transport) {
      const delivery = localDeliveryPort(ctx.store);
      jobs.delivery = { ...delivery, stageScratch: async (id, files, fonts) => {
        await delivery.prepare(id, ctx.store.projectDir, out, `${out}.fixture-delivered`, { kind: "render", paths: plan.dependencies });
        return delivery.stageScratch(id, files, fonts);
      } };
    }
    jobs.onStart = async (spec) => {
      try {
        const result = await runNativeRenderSequence(spec);
        if (plan.transport && spec.cwd && result.code === 0)
          await fsp.rm(spec.cwd, { recursive: true, force: true });
        jobs.exit(spec.id, result.code, result.stderr);
      } catch (error) {
        jobs.exit(spec.id, -1, String(error));
      }
    };
    renderContext = {
      ...ctx,
      runner: supervisedRunner(ctx.runner, jobs, { id: `real-${tag}`, lane: "export",
        meta: plan.transport ? { renderTransport: plan.transport, dependencies: plan.dependencies } : {} }),
    };
  }
  const r = await runRenderPlan(renderContext, { ...plan, args });
  expect(r.code, r.stderr).toBe(0);
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
  __setExportConfirmationForTests(async () => "continue");
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
  __setExportConfirmationForTests(null);
  if (retainArtifacts) { console.log(`Retained exporter conformance artifacts: ${dir}`); return; }
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("streaming delivery settings conformance", () => {
  const schema = paramSchema("export") as Any;
  const cases = [
    ...(schema.properties.resolution.enum as string[]).map((value) => ({ kind: "resolution", value })),
    ...(schema.properties.quality.enum as string[]).map((value) => ({ kind: "quality", value })),
    ...[24, 60].map((value) => ({ kind: "fps", value: String(value) })),
  ];
  const qualityOutcomes = new Map<string, { error: number; bytes: number }>();
  let base: Timeline;
  let referencePixels: Buffer;

  beforeAll(async () => {
    const source = path.join(dir, "delivery-detail.png");
    await ff(["-y", "-f", "lavfi", "-i", "testsrc2=s=3840x2160:r=30:d=1", "-frames:v", "1", source]);
    base = timeline([track("delivery-source", 0, [{
      ...vclip(source, 0, 196, 0, { kind: "image" }), id: "delivery-source",
    }])]);
    base.canvas = { width: 3840, height: 2160, fps: FPS };
    const reference = await renderLossless(base, "delivery-quality-reference", { maxDurationSec: 0.1 });
    referencePixels = await ffBytes(["-i", reference, "-frames:v", "1", "-pix_fmt", "yuv420p", "-f", "rawvideo", "-"]);
    expect(referencePixels.length).toBe(3840 * 2160 * 3 / 2);
  });

  afterAll(() => {
    if (qualityOutcomes.size === (schema.properties.quality.enum as string[]).length) {
      expect(qualityOutcomes.get("high")!.error).toBeLessThan(qualityOutcomes.get("medium")!.error);
      expect(qualityOutcomes.get("medium")!.error).toBeLessThan(qualityOutcomes.get("low")!.error);
      expect(qualityOutcomes.get("high")!.bytes).toBeGreaterThan(qualityOutcomes.get("low")!.bytes);
    }
  });

  it.each(cases)("$kind/$value survives actual native delivery with the promised encoded outcome", async ({ kind, value }) => {
    onTestFailed(() => { retainArtifacts = true; });
    const options: ExportOptions = { engine: "partition-pipes-v1", maxDurationSec: kind === "fps" ? 0.5 : 0.1 };
    if (kind === "resolution") options.resolution = value as ExportOptions["resolution"];
    if (kind === "quality") options.quality = value as ExportOptions["quality"];
    if (kind === "fps") { options.fps = Number(value); options.resolution = "480p"; }
    const output = await renderLossless(base, `delivery-${kind}-${value}`, options, true, "pcm_s16le", true);
    const metadata = await ctx.runner.run("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
      "stream=width,height,r_frame_rate,nb_read_frames,codec_name,pix_fmt:format=format_name", "-of", "json", output]);
    expect(metadata.code, metadata.stderr).toBe(0);
    const actual = JSON.parse(metadata.stdout);
    const video = actual.streams[0];
    const fps = kind === "fps" ? Number(value) : FPS;
    const shortSide = kind === "fps" ? 480 : kind === "resolution" && value !== "source" ? Math.min(2160, Number.parseInt(value, 10)) : 2160;
    expect(Math.min(video.width, video.height)).toBe(shortSide);
    expect(video.width % 2).toBe(0);
    expect(video.height % 2).toBe(0);
    expect(Math.abs(video.width - video.height * 16 / 9)).toBeLessThanOrEqual(2);
    expect(video.r_frame_rate).toBe(`${fps}/1`);
    expect(Number(video.nb_read_frames)).toBe(Math.round(options.maxDurationSec! * fps));
    expect(video.codec_name).toBe("h264");
    expect(video.pix_fmt).toBe("yuv420p");
    expect(actual.format.format_name.split(",")).toContain("mp4");
    const pixels = await ffBytes(["-i", output, "-frames:v", "1", "-pix_fmt", "yuv420p", "-f", "rawvideo", "-"]);
    expect(pixels.some((pixel) => pixel > 64), "delivery produced no visible detail").toBe(true);
    if (kind === "quality") {
      expect(pixels.length).toBe(referencePixels.length);
      let error = 0;
      for (let index = 0; index < pixels.length; index++) error += (pixels[index] - referencePixels[index]) ** 2;
      qualityOutcomes.set(value, { error: error / pixels.length, bytes: (await fsp.stat(output)).size });
    }
  }, 180_000);
});

describe("streaming caption preset conformance", () => {
  const schema = paramSchema("add_captions") as Any;
  const cases = (["style", "animation"] as const).flatMap((kind) =>
    (schema.properties[kind].properties.preset.enum as string[]).map((preset) => ({ kind, preset })));
  const stylePictures = new Map<string, string>();
  let base: Timeline;
  let plain: { frames: Buffer[]; pcm: Buffer };

  beforeAll(async () => {
    const background = path.join(dir, "caption-static.png");
    await ff(["-y", "-f", "lavfi", "-i", `color=c=0x243b3b:s=${W}x${H}:r=${FPS}:d=1`, "-frames:v", "1", background]);
    base = timeline([
      track("caption-background", 0, Array.from({ length: 98 }, (_, index) => ({
        ...vclip(background, index * 2, index * 2 + 2, 0, { kind: "image" }), id: `caption-background-${index}`,
      }))),
      track("caption-score", 0, [aclip(src.stereo, 0, 196)], "audio"),
    ]);
    plain = await decoded(await renderLossless(base, "caption-static-control", {}, false, "pcm_f64le"), "f64le");
    expect(plain.frames).toHaveLength(196);
    expect(plain.frames.every((frame) => frame.equals(plain.frames[0])), "caption motion control must actually be static").toBe(true);
  });

  afterAll(() => {
    if (stylePictures.size > 1)
      expect(new Set(stylePictures.values()).size, "named style presets collapsed to the same rendered appearance").toBe(stylePictures.size);
  });

  it.each(cases)("$kind/$preset renders visible promised behaviour and preserves every native frame/sample", async ({ kind, preset }) => {
    onTestFailed(() => { retainArtifacts = true; });
    const authored = structuredClone(base);
    const caption: Any = { id: `caption-${kind}-${preset}`, kind: "text", timeline_in: 0, timeline_out: sec(196),
      content: [{ text: "steady", t_in: 0, t_out: 2 }, { text: "moving", t_in: 2, t_out: 4 },
        { text: "stories", t_in: 4, t_out: sec(196) }],
      transform: { position: { x: 0.5, y: 0.5 } },
      style: { font: "Poppins", fontsize: 24, color: "white" } };
    if (kind === "style") caption.style = { preset, fontsize: 24 };
    else caption.animation = { preset };
    authored.tracks.push(track("caption-presets", 2, [caption], "text"));
    const reference = await decoded(await renderLossless(authored, `caption-reference-${kind}-${preset}`, {}, false, "pcm_f64le"), "f64le");
    expect(reference.frames).toHaveLength(196);
    expect(reference.frames.some((frame, index) => !frame.equals(plain.frames[index])), `${kind}/${preset} painted no caption pixels`).toBe(true);
    if (kind === "animation")
      expect(reference.frames.some((frame) => !frame.equals(reference.frames[0])), `${preset} is inert over a static scene`).toBe(true);
    else {
      expect(reference.frames.every((frame) => frame.equals(reference.frames[0])), "style-only caption unexpectedly animates").toBe(true);
      stylePictures.set(preset, createHash("sha256").update(reference.frames[90]).digest("hex"));
    }
    const options = { engine: "partition-pipes-v1" as const };
    const plan = buildRenderCommand(authored, path.join(dir, `caption-check-${kind}-${preset}.mp4`), options);
    expect(plan.steps!.length, "caption conformance must cross a real native partition").toBeGreaterThan(1);
    const delivered = await decoded(await renderLossless(authored, `caption-stream-${kind}-${preset}`, options, true, "pcm_f64le"), "f64le");
    expect(delivered.frames).toHaveLength(reference.frames.length);
    for (let frame = 0; frame < reference.frames.length; frame++)
      expect(delivered.frames[frame].equals(reference.frames[frame]), `${kind}/${preset} frame${frame}`).toBe(true);
    expect(delivered.pcm.length).toBe(plain.pcm.length);
    expect(reference.pcm.equals(plain.pcm), "caption altered the reference stereo mix").toBe(true);
    expect(delivered.pcm.equals(plain.pcm), "caption transport altered floating stereo samples").toBe(true);
  }, 180_000);
});

describe("streaming effect catalog conformance", () => {
  const cases = (["video", "audio"] as const).flatMap((kind) => typesFor(kind).map((type) => ({ kind, type })));
  let base: Timeline;
  let plain: { frames: Buffer[]; pcm: Buffer };

  beforeAll(async () => {
    const sound = path.join(dir, "matrix-stereo.wav");
    const frozen = process.env.ARTDADDY_QA_EFFECT_REFERENCE_DIR;
    if (frozen) await fsp.copyFile(path.join(frozen, "matrix-stereo.wav"), sound);
    else await ff(["-y", "-f", "lavfi", "-i",
      `aevalsrc=0.10*sin(2*PI*440*t)+0.03*(random(0)-0.5)|0.08*sin(2*PI*880*t)+0.03*(random(1)-0.5):s=${RATE}:d=7`,
      "-c:a", "pcm_f64le", sound]);
    base = timeline([
      track("background", 0, Array.from({ length: 98 }, (_, index) => ({
        ...vclip(index % 2 ? src.b : src.a, index * 2, index * 2 + 2), id: `matrix-background-${index}`,
      }))),
      track("hero", 1, [vclip(src.a, 0, 196, 0, { id: "matrix-hero", transform: { scale: 0.7 } })]),
      track("sound", 0, [aclip(sound, 0, 196, { id: "matrix-audio" })], "audio"),
    ]);
    plain = await decoded(await renderLossless(base, "matrix-neutral", {}, false, "pcm_f64le"), "f64le");
    expect(plain.frames).toHaveLength(196);
    expect(plain.pcm.length).toBe((196 * RATE * 2 * 8) / FPS);
    expect(plain.frames[0].equals(plain.frames[90]), "moving source control is inert").toBe(false);
    const topBand = (frame: Buffer) => Buffer.concat([
      frame.subarray(0, W * 24),
      frame.subarray(W * H, W * H + (W * 12) / 2),
      frame.subarray((W * H * 5) / 4, (W * H * 5) / 4 + (W * 12) / 2),
    ]);
    expect(topBand(plain.frames[0]).equals(topBand(plain.frames[2])), "visible background control is inert").toBe(false);
  });

  it.each(cases)("$kind/$type preserves actual frames and floating stereo across partitions", async ({ kind, type }) => {
    onTestFailed(() => { retainArtifacts = true; });
    const params = type === "custom" ? { expr: "hue=s=0" }
      : type === "eq" ? { bass: 6 }
      : type === "pan" ? { balance: 0.6 }
      : type === "compressor" ? { threshold: -36, ratio: 8 }
      : undefined;
    const authored = resolveEffect({ type, ...(params ? { params } : {}) }, kind);
    expect(authored.error).toBeUndefined();
    const tl = structuredClone(base);
    const clip = tl.tracks.find((entry) => entry.id === (kind === "video" ? "hero" : "sound"))!.clips![0];
    clip[kind === "video" ? "effects" : "audio_effects"] = [authored.effect];
    const reference = await decoded(await renderLossless(tl, `matrix-reference-${kind}-${type}`, {}, false, "pcm_f64le"), "f64le");
    const frozen = process.env.ARTDADDY_QA_EFFECT_REFERENCE_DIR;
    if (frozen) {
      const previous = await decoded(path.join(frozen, `matrix-reference-${kind}-${type}.mkv`), "f64le");
      expect(reference.frames).toHaveLength(previous.frames.length);
      expect(reference.frames.every((frame, index) => frame.equals(previous.frames[index])), "whole-reference pixels changed from the frozen pre-fix artifact").toBe(true);
      expect(reference.pcm.equals(previous.pcm), "whole-reference floating audio changed from the frozen pre-fix artifact").toBe(true);
    }
    if (kind === "audio" && type === "loudnorm") {
      const span = await decoded(await renderLossless(tl, "matrix-full-range-loudnorm", { range: { from: 0, to: 196 } }, false, "pcm_f64le"), "f64le");
      expect(span.pcm.equals(reference.pcm), "full-range loudnorm must match the identical whole-timeline span before testing pipe transport").toBe(true);
    }
    const plan = buildRenderCommand(tl, path.join(dir, "matrix-check.mp4"), { engine: "partition-pipes-v1" });
    expect(plan.steps!.length, "conformance case must cross a real partition").toBeGreaterThan(1);
    const delivered = await decoded(await renderLossless(tl, `matrix-stream-${kind}-${type}`,
      { engine: "partition-pipes-v1" }, true, "pcm_f64le"), "f64le");
    expect(delivered.frames).toHaveLength(reference.frames.length);
    let visualChange = false;
    for (let frame = 0; frame < reference.frames.length; frame++) {
      expect(delivered.frames[frame].equals(reference.frames[frame]), `${kind}/${type} frame ${frame}`).toBe(true);
      visualChange ||= !reference.frames[frame].equals(plain.frames[frame]);
    }
    expect(delivered.pcm.length, `${kind}/${type} complete stereo samples`).toBe(reference.pcm.length);
    let firstDifference = -1;
    for (let offset = 0; offset < reference.pcm.length; offset++) {
      if (delivered.pcm[offset] !== reference.pcm[offset]) { firstDifference = offset; break; }
    }
    expect(firstDifference, `${kind}/${type} first different floating sample byte`).toBe(-1);
    if (kind === "video") expect(visualChange, `${type} emitted no changed pixels`).toBe(true);
    else expect(reference.pcm.equals(plain.pcm), `${type} emitted no changed sound`).toBe(false);
  }, 180_000);
});

describe("streaming transition conformance", () => {
  const make = (): Timeline => timeline([
    track("transition-background", 0, Array.from({ length: 98 }, (_, index) => ({
      ...vclip(index % 2 ? src.b : src.a, index * 2, index * 2 + 2), id: `transition-background-${index}`,
    }))),
    track("transition-main", 1, [
      vclip(src.a, 0, 98, 0, { id: "transition-outgoing", transform: { scale: 0.7 } }),
      vclip(src.b, 98, 196, 0, { id: "transition-incoming", transform: { scale: 0.7 } }),
    ]),
    track("transition-sound", 0, [aclip(src.stereo, 0, 196)], "audio"),
  ]);
  let hardCut: { frames: Buffer[]; pcm: Buffer };
  beforeAll(async () => { hardCut = await decoded(await renderLossless(make(), "transition-hard-cut")); });

  it.each(TRANSITION_KINDS)("%s preserves the centred cut across native partitions", async (kind) => {
    onTestFailed(() => { retainArtifacts = true; });
    const tl = make();
    tl.tracks[1].clips![1].transition_in = { kind, duration: sec(16), ...(kind === "custom" ? { expr: "x*x" } : {}) };
    const plan = buildRenderCommand(tl, path.join(dir, `transition-${kind}.mkv`), { engine: "partition-pipes-v1" });
    expect(plan.steps!.length).toBeGreaterThan(1);
    let boundary = 0;
    expect(plan.steps!.some((step) => {
      boundary += Math.round(step.duration * FPS);
      return boundary === 98;
    }), "cut must lie on a tested partition boundary").toBe(true);
    const reference = await decoded(await renderLossless(tl, `transition-reference-${kind}`));
    const delivered = await decoded(await renderLossless(tl, `transition-stream-${kind}`, { engine: "partition-pipes-v1" }, true));
    expect(delivered.frames).toHaveLength(196);
    let transitionVisible = false;
    for (let frame = 0; frame < reference.frames.length; frame++) {
      expect(delivered.frames[frame].equals(reference.frames[frame]), `${kind} frame ${frame}`).toBe(true);
      if (frame >= 90 && frame <= 106) transitionVisible ||= !reference.frames[frame].equals(hardCut.frames[frame]);
    }
    expect(transitionVisible, `${kind} was indistinguishable from a hard cut`).toBe(true);
    expect(delivered.pcm.length).toBe(reference.pcm.length);
    expect(delivered.pcm.equals(reference.pcm), `${kind} changed the complete stereo mix`).toBe(true);
    if (kind === "custom") expect(plan.warnings.some((warning) => warning.includes("custom expr not evaluated"))).toBe(true);
  }, 180_000);
});

describe("streaming colour catalog conformance", () => {
  const parameters = allEffects().filter((effect) => effect.kind === "color").flatMap((effect) =>
    effect.params as Array<{ key: string; type: string; default: unknown }>);
  const make = (grade: Record<string, unknown>): Timeline => timeline([
    track("colour-background", 0, Array.from({ length: 98 }, (_, index) => ({
      ...vclip(index % 2 ? src.b : src.a, index * 2, index * 2 + 2), id: `colour-background-${index}`,
    }))),
    track("colour-main", 1, [vclip(src.a, 0, 196, 0, { id: "colour-hero", transform: { scale: 0.7 }, color: grade })]),
    track("colour-sound", 0, [aclip(src.stereo, 0, 196)], "audio"),
  ]);
  let neutral: { frames: Buffer[]; pcm: Buffer };
  let lut: string;
  beforeAll(async () => {
    lut = path.join(dir, "colour-matrix.cube");
    const rows: string[] = ["TITLE \"Exporter conformance\"", "LUT_3D_SIZE 2", "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1"];
    for (const blue of [0, 1]) for (const green of [0, 1]) for (const red of [0, 1]) rows.push(`${1 - red} ${green} ${blue}`);
    await fsp.writeFile(lut, `${rows.join("\n")}\n`);
    neutral = await decoded(await renderLossless(make({}), "colour-neutral"));
  });

  it.each(parameters)("$key preserves actual colour pixels across native partitions", async (parameter) => {
    onTestFailed(() => { retainArtifacts = true; });
    const context = parameter.key.endsWith("Hue") ? { [parameter.key.replace(/Hue$/, "Amount")]: 0.35 } : {};
    const value = parameter.key === "lut" ? lut
      : parameter.type === "array" ? [[0, 0], [0.4, 0.65], [1, 1]]
      : parameter.key.endsWith("Hue") ? 120
      : typeof parameter.default === "number" ? parameter.default + (parameter.default > 1 ? parameter.default * 0.25 : 0.25)
      : undefined;
    expect(value, `new colour parameter ${parameter.key} needs an observable value`).toBeDefined();
    const resolved = resolveGrade({ ...context, [parameter.key]: value });
    expect(resolved.error).toBeUndefined();
    const tl = make(resolved.grade!);
    const control = Object.keys(context).length
      ? await decoded(await renderLossless(make(context), `colour-control-${parameter.key}`))
      : neutral;
    const reference = await decoded(await renderLossless(tl, `colour-reference-${parameter.key}`));
    const plan = buildRenderCommand(tl, path.join(dir, "colour-check.mkv"), { engine: "partition-pipes-v1" });
    expect(plan.steps!.length).toBeGreaterThan(1);
    const delivered = await decoded(await renderLossless(tl, `colour-stream-${parameter.key}`, { engine: "partition-pipes-v1" }, true));
    expect(delivered.frames).toHaveLength(196);
    let changesPixels = false;
    for (let frame = 0; frame < reference.frames.length; frame++) {
      expect(delivered.frames[frame].equals(reference.frames[frame]), `${parameter.key} frame ${frame}`).toBe(true);
      changesPixels ||= !reference.frames[frame].equals(control.frames[frame]);
    }
    expect(changesPixels, `${parameter.key} emitted no independently observable colour change`).toBe(true);
    expect(delivered.pcm.equals(reference.pcm), `${parameter.key} changed stereo samples`).toBe(true);
  }, 180_000);

  it("keeps legitimate LUT path bytes and prevents filter delimiters from changing rendered media", async () => {
    onTestFailed(() => { retainArtifacts = true; });
    const reference = await decoded(await renderLossless(make({ lut }), "colour-path-canonical"));
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("space name", "quote'name", "semi;colon", "comma,name",
      "bracket[name]", "equals=name", "paren(name)", "file' [fake];negate,tail", "percent%name"), { minLength: 1, maxLength: 3 }), async (segments) => {
      const filename = path.join(dir, `${segments.join("-")}.cube`);
      await fsp.copyFile(lut, filename);
      const candidate = await decoded(await renderLossless(make({ lut: filename }), "colour-path-fuzz"));
      expect(candidate.frames).toHaveLength(reference.frames.length);
      expect(candidate.frames.every((frame, index) => frame.equals(reference.frames[index])), `LUT path changed picture bytes: ${filename}`).toBe(true);
      expect(candidate.pcm.equals(reference.pcm)).toBe(true);
    }), { numRuns: 12 });
  }, 180_000);
});

describe("streaming authored animation conformance", () => {
  const schema = paramSchema("set_keyframes")!;
  const properties = (schema.properties!.property as { enum: string[] }).enum;
  const easings = (schema.properties!.keyframes.items!.properties!.ease as { enum: string[] }).enum;
  const cases = properties.flatMap((property) => (property === "position" ? ["x", "y"] : [""])
    .flatMap((axis) => easings.map((ease) => ({ property, axis, ease }))));
  let authoredContext: ClientToolContext;
  let authoredRoot: string;
  let videoRef: string;
  let otherVideoRef: string;
  let audioRef: string;

  beforeAll(async () => {
    authoredRoot = path.join(dir, "authored-animation");
    await fsp.mkdir(path.join(authoredRoot, "internals"), { recursive: true });
    authoredContext = mkCtx(authoredRoot);
    installE2EDocuments();
    await ensureTimeline(authoredContext.store);
    await openE2EDoc(authoredRoot);
    videoRef = await libRef(authoredContext, src.a, "video");
    otherVideoRef = await libRef(authoredContext, src.b, "video");
    audioRef = await libRef(authoredContext, src.stereo, "audio");
  });
  afterAll(async () => { await resetE2EDocuments(); });

  it.each(cases)("$property/$axis/$ease survives real authoring and native partition boundaries", async ({ property, axis, ease }) => {
    onTestFailed(() => { retainArtifacts = true; });
    const tag = `authored-${property}-${axis}-${ease}`;
    const model = emptyTimeline(W, H, FPS);
    model.tracks = [
      { id: "authored-background", kind: "video", z: 0, clips: Array.from({ length: 98 }, (_, index) => ({
        id: `authored-background-${index}`, kind: "video", media_ref: index % 2 ? otherVideoRef : videoRef,
        source_in: 0, source_out: 2, timeline_in: index * 2, timeline_out: index * 2 + 2,
      })) },
      { id: "authored-front", kind: "video", z: 1, clips: [{ id: "authored-hero", kind: "video", media_ref: videoRef,
        source_in: 0, source_out: 196, timeline_in: 0, timeline_out: 196, transform: { scale: 0.6 } }] },
      { id: "authored-sound", kind: "audio", z: 0, clips: [{ id: "authored-audio", kind: "audio", media_ref: audioRef,
        source_in: 0, source_out: 196, timeline_in: 0, timeline_out: 196 }] },
    ];
    expect(await replaceTimeline(authoredContext.store, model)).toBe(true);
    const target = property === "volume" ? "authored-audio" : "authored-hero";
    const keyframe = (at: number, progress: number): Record<string, unknown> => property === "position"
      ? { t: at, x: axis === "x" ? 0.35 + 0.3 * progress : 0.5, y: axis === "y" ? 0.35 + 0.3 * progress : 0.5, ease }
      : { t: at, v: property === "rotate" ? -18 + 36 * progress
        : property.startsWith("scale") ? 0.3 + 0.5 * progress : 0.2 + 0.6 * progress, ease };
    const capture = async (): Promise<Timeline> => {
      await flushE2EDoc(authoredRoot);
      const persisted = JSON.parse(await fsp.readFile(path.join(authoredRoot, "internals", "timeline.json"), "utf8")) as Timeline;
      await resolveClipSources(authoredContext, persisted);
      return persisted;
    };
    expect((await setKeyframesTool({ clip_id: target, property,
      keyframes: [{ ...keyframe(0, 0), ease: "hold" }, keyframe(195, 1)] }, authoredContext)).ok).toBe(true);
    const control = await decoded(await renderLossless(await capture(), `${tag}-constant`, {}, false, "pcm_f64le"), "f64le");
    expect((await setKeyframesTool({ clip_id: target, property,
      keyframes: [keyframe(0, 0), keyframe(98, 0.5), keyframe(195, 1)] }, authoredContext)).ok).toBe(true);
    const authored = await capture();
    const reference = await decoded(await renderLossless(authored, `${tag}-reference`, {}, false, "pcm_f64le"), "f64le");
    const plan = buildRenderCommand(authored, path.join(dir, "authored-check.mkv"), { engine: "partition-pipes-v1" });
    expect(plan.steps!.length).toBeGreaterThan(1);
    const delivered = await decoded(await renderLossless(authored, `${tag}-stream`, { engine: "partition-pipes-v1" }, true, "pcm_f64le"), "f64le");
    expect(delivered.frames).toHaveLength(196);
    for (let frame = 0; frame < reference.frames.length; frame++)
      expect(delivered.frames[frame].equals(reference.frames[frame]), `${tag} frame ${frame}`).toBe(true);
    expect(delivered.pcm.equals(reference.pcm), `${tag} floating stereo samples differ`).toBe(true);
    if (property === "volume") {
      expect(reference.pcm.subarray(0, 1600 * 16).equals(control.pcm.subarray(0, 1600 * 16))).toBe(true);
      expect(reference.pcm.subarray(1600 * 16 * 194).equals(control.pcm.subarray(1600 * 16 * 194)), "volume animation is inert").toBe(false);
    } else {
      expect(reference.frames[0].equals(control.frames[0]), "initial authored value changed").toBe(true);
      expect(reference.frames[194].equals(control.frames[194]), `${property}/${axis} animation is inert`).toBe(false);
    }
  }, 180_000);
});

describe("admitted fit modes preserve preview and native output", () => {
  it.each(["static", "scale_x", "scale_y"])("%s stretch fills a non-source-shaped box through real authoring, preview geometry and native frames", async (animation) => {
    onTestFailed(() => { retainArtifacts = true; });
    const projectDir = path.join(dir, "authored-stretch");
    await fsp.mkdir(path.join(projectDir, "internals"), { recursive: true });
    const context = mkCtx(projectDir);
    installE2EDocuments();
    await ensureTimeline(context.store);
    await openE2EDoc(projectDir);
    try {
      const white = path.join(dir, "stretch-white.mp4");
      await ff(["-y", "-f", "lavfi", "-i", `color=white:s=${W}x${H}:r=${FPS}:d=7`, "-c:v", "libx264", "-pix_fmt", "yuv420p", white]);
      const video = await libRef(context, white, "video");
      const sound = await libRef(context, src.stereo, "audio");
      const model = emptyTimeline(W, H, FPS);
      model.tracks = [
        { id: "fit-fillers", kind: "video", z: 0, clips: Array.from({ length: 98 }, (_, index) => ({
          id: `fit-filler-${index}`, kind: "video", media_ref: video, opacity: 0,
          source_in: 0, source_out: 2, timeline_in: index * 2, timeline_out: index * 2 + 2,
        })) },
        { id: "fit-hero", kind: "video", z: 1, clips: [{ id: "fit-target", kind: "video", media_ref: video,
          source_in: 0, source_out: 196, timeline_in: 0, timeline_out: 196 }] },
        { id: "fit-sound", kind: "audio", z: 0, clips: [{ id: "fit-audio", kind: "audio", media_ref: sound,
          source_in: 0, source_out: 196, timeline_in: 0, timeline_out: 196 }] },
      ];
      expect(await replaceTimeline(context.store, model)).toBe(true);
      const changed = await setClipPropertiesTool({ clip_ids: ["fit-target"], fit: "stretch",
        transform: { position: { x: 0.5, y: 0.5 }, scale_x: 0.5, scale_y: 0.8 } }, context);
      expect(changed.ok, JSON.stringify(changed)).toBe(true);
      if (animation !== "static") {
        const initial = animation === "scale_x" ? 0.5 : 0.8;
        const final = animation === "scale_x" ? 0.7 : 0.9;
        const keyframes = await setKeyframesTool({ clip_id: "fit-target", property: animation,
          keyframes: [{ t: 0, v: initial, ease: "ease-in-out" }, { t: 195, v: final }] }, context);
        expect(keyframes.ok, JSON.stringify(keyframes)).toBe(true);
      }
      await flushE2EDoc(projectDir);
      const persisted = JSON.parse(await fsp.readFile(path.join(projectDir, "internals", "timeline.json"), "utf8")) as Timeline;
      await resolveClipSources(context, persisted);
      const box = { x: 80, y: 18, w: 160, h: 144 };
      const preview = fitRects(box, { w: W, h: H }, resolveFit("stretch"));
      expect(preview.dst).toEqual(box);
      expect(preview.src).toEqual({ x: 0, y: 0, w: 1, h: 1 });
      const reference = await decoded(await renderLossless(persisted, `stretch-${animation}-reference`));
      const delivered = await decoded(await renderLossless(persisted, `stretch-${animation}-stream`, { engine: "partition-pipes-v1" }, true));
      expect(delivered.frames).toHaveLength(196);
      for (let frame = 0; frame < reference.frames.length; frame++) {
        expect(delivered.frames[frame].equals(reference.frames[frame]), `stretch frame ${frame}`).toBe(true);
        expect(delivered.frames[frame][25 * W + 100], "stretch must paint where contain letterboxes").toBeGreaterThan(200);
        expect(delivered.frames[frame][90 * W + 40], "stretch must remain clipped to its box").toBeLessThan(30);
      }
      expect(delivered.pcm.equals(reference.pcm)).toBe(true);
    } finally { await resetE2EDocuments(); }
  }, 180_000);
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

  it.skipIf(!process.env.ARTDADDY_QA_CONTINUOUS_REFERENCE)("continuous low-input pieces preserve frozen pictures and DSP across two minutes", async () => {
    retainArtifacts = true;
    const referencePath = process.env.ARTDADDY_QA_CONTINUOUS_REFERENCE!;
    const frozen = JSON.parse(await fsp.readFile(referencePath, "utf8")) as {
      timeline: Timeline; output: string; frames: number; pictureSha256: string; stereoSha256: string;
    };
    const saved = await decoded(frozen.output, "f64le");
    const pictureHash = (frames: Buffer[]) => {
      const digest = createHash("sha256");
      for (const frame of frames) digest.update(frame);
      return digest.digest("hex");
    };
    expect(saved.frames).toHaveLength(frozen.frames);
    expect(pictureHash(saved.frames)).toBe(frozen.pictureSha256);
    expect(createHash("sha256").update(saved.pcm).digest("hex")).toBe(frozen.stereoSha256);
    const results: Array<{ candidate: boolean; elapsedMs: number; partitions: number }> = [];
    for (const candidate of [false, true]) {
      const options: ExportOptions = { engine: "partition-pipes-v1", ...(candidate ? { __qaPieceSpanSeconds: 180 as const } : {}) };
      const plan = buildRenderCommand(frozen.timeline, path.join(dir, `continuous-plan-${candidate}.mp4`), options);
      const started = performance.now();
      const output = await renderLossless(frozen.timeline, `continuous-replay-${candidate}`, options, true, "pcm_f64le");
      const elapsedMs = performance.now() - started;
      const actual = await decoded(output, "f64le");
      expect(actual.frames).toHaveLength(frozen.frames);
      for (let frame = 0; frame < frozen.frames; frame++)
        expect(actual.frames[frame].equals(saved.frames[frame]), `candidate=${candidate} frame${frame}`).toBe(true);
      expect(actual.pcm.equals(saved.pcm), `candidate=${candidate} floating stereo changed`).toBe(true);
      results.push({ candidate, elapsedMs, partitions: plan.steps!.length });
    }
    expect(results[1].partitions).toBeLessThan(results[0].partitions);
    const result = { results, frozenReference: referencePath, pictureSha256: frozen.pictureSha256,
      stereoSha256: frozen.stereoSha256, fullPromiseQualified: false };
    await fsp.writeFile(path.join(dir, "continuous-piece-comparison.json"), JSON.stringify(result));
    console.log(`CONTINUOUS PIECES ${JSON.stringify(result)}`);
  }, 240_000);

  it("a span at the very start and one at the very end", async () => {
    await expectSpanOfWhole(whole, tl, 0, 60, "head");
    await expectSpanOfWhole(whole, tl, 330, 390, "tail");
  });

  it("a span that starts and ends on odd frames, inside clips", async () => {
    await expectSpanOfWhole(whole, tl, 143, 211, "odd");
  });

  it("range seeking preserves the held picture across a source gap longer than its seek margin", async () => {
    onTestFailed(() => { retainArtifacts = true; });
    const source = path.join(dir, "sparse-range.mp4");
    await ff(["-y", "-f", "lavfi", "-i", `testsrc2=s=${W}x${H}:r=${FPS}:d=24`,
      "-vf", "select='eq(n,0)+eq(n,9)+eq(n,600)+eq(n,719)'", "-fps_mode", "vfr",
      "-c:v", "libx264", "-g", "1", "-pix_fmt", "yuv420p", source]);
    const authored = timeline([
      track("sparse-video", 0, [vclip(source, 0, 720)]),
      track("sparse-score", 0, [{ ...aclip(src.stereo, 0, 720), source_out: 14, loop: true }], "audio"),
    ]);
    const expected = await decoded(await renderLossless(authored, "sparse-whole"));
    expect(expected.frames).toHaveLength(720);
    expect(expected.frames[150].equals(expected.frames[600]), "fixture must change after its source gap").toBe(false);
    await expectSpanOfWhole(expected, authored, 150, 630, "sparse-gap-range");
    await expectSpanOfWhole(expected, authored, 589, 614, "sparse-gap-boundary");
  }, 60_000);

  it("preserves a source audio gap before mixing instead of advancing sound to zero", async () => {
    onTestFailed(() => { retainArtifacts = true; });
    const source = path.join(dir, "source-audio-delay.nut");
    await ff(["-y", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=${FPS}:d=2`,
      "-f", "lavfi", "-i", `aevalsrc=0.1*sin(2*PI*440*t)|0.08*sin(2*PI*880*t):s=${RATE}:d=1.956`,
      "-af", "asetpts=PTS+0.044/TB", "-c:v", "ffv1", "-c:a", "pcm_f64le", "-f", "nut", source]);
    const authored = timeline([track("original-audio", 0, [aclip(source, 0, 60)], "audio")]);
    const output = path.join(dir, "source-audio-delay-rendered.nut");
    const plan = buildAudioRenderCommand(authored, output);
    const result = await ctx.runner.run("ffmpeg", plan.args, AbortSignal.timeout(20_000));
    expect(result.code, result.stderr).toBe(0);
    const actual = await ffBytes(["-i", output, "-map", "0:a:0", "-f", "f64le", "-"]);
    const reference = await ffBytes(["-i", source, "-map", "0:a:0", "-af",
      `aresample=${RATE}:async=1:first_pts=0,apad,atrim=end_sample=${2 * RATE}`, "-f", "f64le", "-"]);
    expect(actual.length, "the source gap must not shorten the mix").toBe(2 * RATE * 16);
    expect(actual.subarray(0, Math.floor(RATE * 0.04) * 16).every((byte) => byte === 0), "leading source silence was removed").toBe(true);
    let maximumError = 0;
    for (let offset = Math.floor(RATE * 0.05) * 16; offset < Math.floor(RATE * 1.95) * 16; offset += 8)
      maximumError = Math.max(maximumError, Math.abs(actual.readDoubleLE(offset) - reference.readDoubleLE(offset)));
    expect(maximumError, "source samples moved relative to their media timestamps").toBeLessThan(1e-7);
  }, 30_000);

  it.each(["mono-resample", "trim", "loop", "range", "native-pieces"])("keeps delayed source timing through %s", async (kind) => {
    onTestFailed(() => { retainArtifacts = true; });
    const source = path.join(dir, `source-clock-${kind}.nut`);
    const mono = kind === "mono-resample";
    const rate = mono ? 44100 : RATE;
    await ff(["-y", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=${FPS}:d=2`,
      "-f", "lavfi", "-i", `aevalsrc=${mono ? "0.1*sin(2*PI*440*t)" : "0.1*sin(2*PI*440*t)|0.08*sin(2*PI*880*t)"}:s=${rate}:d=1.956`,
      "-af", "asetpts=PTS+0.044/TB", "-c:v", "ffv1", "-c:a", "pcm_f64le", "-f", "nut", source]);
    const sourceIn = kind === "trim" ? 0.5 : 0;
    const sourceOut = kind === "trim" ? 1.5 : 2;
    const looped = kind === "loop" || kind === "native-pieces";
    const duration = looped ? 4 : sourceOut - sourceIn;
    const authored = timeline([track("source-clock", 0, [{ kind: "audio", media_ref: source,
      source_in: sourceIn, source_out: sourceOut, timeline_in: 0, timeline_out: duration, ...(looped ? { loop: true } : {}) }], "audio")]);
    const options = kind === "range" ? { range: { from: 15, to: 45 } } : {};
    if (kind === "native-pieces") {
      authored.tracks.push(track("source-clock-video", 0, Array.from({ length: 120 }, (_, index) => ({
        ...vclip(src.a, index, index + 1), id: `source-clock-video-${index}`,
      }))));
      expect(buildRenderCommand(authored, path.join(dir, "source-clock-pieces.mp4"), { engine: "partition-pipes-v1" }).steps!.length).toBeGreaterThan(1);
    }
    const output = kind === "native-pieces"
      ? await renderLossless(authored, "source-clock-native-pieces", { engine: "partition-pipes-v1" }, true, "pcm_f64le")
      : path.join(dir, `source-clock-${kind}-rendered.nut`);
    if (kind !== "native-pieces") {
      const result = await ctx.runner.run("ffmpeg", buildAudioRenderCommand(authored, output, options).args, AbortSignal.timeout(20_000));
      expect(result.code, result.stderr).toBe(0);
    }
    const actual = await ffBytes(["-i", output, "-map", "0:a:0", "-f", "f64le", "-"]);
    const reference = await ffBytes(["-i", source, "-map", "0:a:0", "-af",
      `aresample=${RATE}:async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=${RATE}:channel_layouts=stereo,apad,atrim=end_sample=${2 * RATE}`,
      "-f", "f64le", "-"]);
    const outSeconds = kind === "range" ? 1 : duration;
    expect(actual.length, `${kind} changed the delivered sample count`).toBe(outSeconds * RATE * 16);
    let maximumError = 0;
    for (let frame = Math.floor(RATE * 0.05); frame < (outSeconds - 0.05) * RATE; frame++) {
      const sourceFrame = (frame + Math.round((sourceIn + (kind === "range" ? 0.5 : 0)) * RATE)) % (2 * RATE);
      if (sourceFrame < RATE * 0.05 || sourceFrame >= RATE * 1.95) continue;
      for (let channel = 0; channel < 2; channel++) maximumError = Math.max(maximumError,
        Math.abs(actual.readDoubleLE(frame * 16 + channel * 8) - reference.readDoubleLE(sourceFrame * 16 + channel * 8)));
    }
    expect(maximumError, `${kind} advanced or changed source samples`).toBeLessThan(1e-7);
  });

  it.each([undefined, { from: 143, to: 211 }])("one-pass audio preserves the complete mix and DSP state for %j", async (range) => {
    onTestFailed(() => { retainArtifacts = true; });
    const authored = busy();
    authored.tracks.find((entry) => entry.id === "music")!.clips![0].audio_effects = [
      { type: "reverb", params: { room: 0.4 } }, { type: "loudnorm", params: { target: -14 } },
    ];
    await resolveClipSources(ctx, authored);
    const options = range ? { range } : {};
    const reference = await decoded(await renderLossless(authored, `one-pass-audio-reference-${range?.from ?? 0}`, options, false, "pcm_f64le"), "f64le");
    const output = path.join(dir, `one-pass-audio-${range?.from ?? 0}.nut`);
    const plan = buildAudioRenderCommand(authored, output, options);
    const result = await ctx.runner.run("ffmpeg", plan.args);
    expect(result.code, result.stderr).toBe(0);
    const actual = await ffBytes(["-i", output, "-map", "0:a:0", "-f", "f64le", "-"]);
    expect(actual.length).toBe(reference.pcm.length);
    expect(actual.equals(reference.pcm), "one-pass floating stereo differs from whole-render audio").toBe(true);
    expect(plan.sources.every((source) => source.path.endsWith(".wav"))).toBe(true);
  });

  it.each([false, true])("late audio matches allocating delay and Windows frozen samples with ducking=%s", async (ducked) => {
    onTestFailed(() => { retainArtifacts = true; });
    const onset = process.env.ARTDADDY_QA_LONG_AUDIO === "1" ? 3601 : 31;
    const authored = emptyTimeline(W, H, FPS);
    authored.tracks.push({ id: "late-voice", kind: "audio", z: 0, clips: [{ id: "late-voice-clip", kind: "audio", media_ref: src.voice,
      source_in: 0, source_out: 6 * FPS, timeline_in: onset * FPS, timeline_out: (onset + 6) * FPS, volume: 0.8,
      audio_effects: [{ type: "reverb", params: { room: 0.4 } }, { type: "loudnorm", params: { target: -14 } }] }] });
    if (ducked) authored.tracks.push({ id: "late-score", kind: "audio", z: 0, clips: [{ id: "late-score-clip", kind: "audio", media_ref: src.stereo,
      source_in: 0, source_out: 14 * FPS, timeline_in: 0, timeline_out: (onset + 6) * FPS, loop: true, volume: 0.25, duck: { against: "late-voice" } }] });
    const output = path.join(dir, `late-audio-${ducked}.nut`);
    const plan = buildAudioRenderCommand(authored, output, { range: { from: (onset - 1) * FPS, to: (onset + 5) * FPS } });
    const graphIndex = plan.args.indexOf("-filter_complex") + 1;
    expect(graphIndex).toBeGreaterThan(0);
    const delayedIndex = plan.args[graphIndex].match(/\[adelay_source(\d+)\];anullsrc=/)?.[1];
    expect(delayedIndex).toBeDefined();
    const virtualDelay =
      `[adelay_source${delayedIndex}];anullsrc=r=48000:cl=stereo:n=2048:d=${onset.toFixed(3)},` +
      `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[adelay_silence${delayedIndex}];` +
      `[adelay_silence${delayedIndex}][adelay_source${delayedIndex}]concat=n=2:v=0:a=1,asettb=1/48000,asetpts=N/SR/TB`;
    expect(plan.args[graphIndex]).toContain(virtualDelay);
    const allocatingArgs = [...plan.args];
    allocatingArgs[graphIndex] = allocatingArgs[graphIndex].replace(
      virtualDelay,
      `,adelay=${onset * 1000}|${onset * 1000}`,
    );
    const referenceOutput = path.join(dir, `late-audio-allocating-${ducked}.nut`);
    allocatingArgs[allocatingArgs.length - 1] = referenceOutput;
    const referenceResult = await ctx.runner.run(
      "ffmpeg",
      allocatingArgs,
      AbortSignal.timeout(110_000),
    );
    expect(referenceResult.code, referenceResult.stderr).toBe(0);
    const reference = await ffBytes(["-i", referenceOutput, "-map", "0:a:0", "-f", "f64le", "-"]);
    const result = await ctx.runner.run("ffmpeg", plan.args, AbortSignal.timeout(110_000));
    expect(result.code, result.stderr).toBe(0);
    const actual = await ffBytes(["-i", output, "-map", "0:a:0", "-f", "f64le", "-"]);
    expect(
      actual.equals(reference),
      "floating samples differ from the same-platform allocating delay",
    ).toBe(true);
    expect(actual.length).toBe(6 * RATE * 16);
    expect(actual.subarray(2 * RATE * 16, 3 * RATE * 16).some((byte) => byte !== 0)).toBe(true);
    if (!ducked) expect(actual.subarray(0, Math.floor(RATE * 0.9) * 16).every((byte) => byte === 0)).toBe(true);
    const hash = createHash("sha256").update(actual).digest("hex");
    if (process.platform === "win32")
      expect(hash, "floating samples differ from the frozen Windows allocating-delay implementation").toBe(ducked
        ? "604817d0d8408372745fa8d8de876b2ac1cf14bab99a4823c617ebba8f231de9"
        : "88bccd2a0eb7d424acc1edc2c7cfe78f1f8a5d3301cf5c15654f929e158df74b");
    console.log(`LATE AUDIO BASELINE ${JSON.stringify({ onset, ducked, hash, bytes: actual.length })}`);
  }, 120_000);

  it.skipIf(!process.env.ARTDADDY_QA_DENSE_FIXTURE)("saved dense4K60snapshot survives native memory guards and paints all16sources", async () => {
    onTestFailed(() => { retainArtifacts = true; });
    const fixture = JSON.parse(await fsp.readFile(process.env.ARTDADDY_QA_DENSE_FIXTURE!, "utf8")) as {
      timeline: Timeline; range: { from: number; to: number };
    };
    expect(fixture.timeline.canvas).toMatchObject({ width: 3840, height: 2160, fps: 60 });
    expect(fixture.timeline.tracks.filter((entry) => entry.kind === "video").reduce((count, entry) => count + (entry.clips?.length ?? 0), 0)).toBe(5000);
    const videoOnly = process.env.ARTDADDY_QA_DENSE_VIDEO_ONLY === "1";
    if (videoOnly) fixture.timeline.tracks = fixture.timeline.tracks.filter((entry) => entry.kind !== "audio");
    const delivered = await renderLossless(fixture.timeline, "saved-dense-4k60", { engine: "partition-pipes-v1", range: fixture.range }, true, "pcm_f64le");
    const result = await ctx.runner.run("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
      "stream=width,height,nb_read_frames,r_frame_rate", "-of", "json", delivered], AbortSignal.timeout(30_000));
    expect(result.code, result.stderr).toBe(0);
    const video = JSON.parse(result.stdout).streams[0];
    expect(video).toMatchObject({ width: 3840, height: 2160, r_frame_rate: "60/1", nb_read_frames: String(fixture.range.to - fixture.range.from) });
    const frames = await ffBytes(["-i", delivered, "-an", "-vf", "scale=384:216", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]);
    const frameBytes = 384 * 216 * 3;
    expect(frames.length).toBe(frameBytes * (fixture.range.to - fixture.range.from));
    const first = frames.subarray(0, frameBytes);
    const tiles = Array.from({ length: 16 }, (_, index) => {
      const pixels = Buffer.concat(Array.from({ length: 30 }, (_, vertical) => {
        const start = ((Math.floor(index / 4) * 43 + vertical + 5) * 384 + index % 4 * 96 + 5) * 3;
        return first.subarray(start, start + 80 * 3);
      }));
      expect(pixels.some((byte) => byte > 50), `dense source${index} is blank`).toBe(true);
      return createHash("sha256").update(pixels).digest("hex");
    });
    expect(new Set(tiles).size).toBe(16);
    expect(first.equals(frames.subarray(frameBytes, frameBytes * 2)), "dense scene is frozen").toBe(false);
    const captionPixels = [9, 45].map((frame) => {
      let painted = 0;
      for (let vertical = 174; vertical < 210; vertical++) for (let horizontal = 60; horizontal < 324; horizontal++) {
        const offset = frame * frameBytes + (vertical * 384 + horizontal) * 3;
        if (frames[offset] > 200 && frames[offset + 1] > 200 && frames[offset + 2] > 200) painted++;
      }
      return painted;
    });
    expect(captionPixels[1]).toBeGreaterThan(20);
    expect(captionPixels[1]).toBeGreaterThan(captionPixels[0]);
    console.log(`DENSE NATIVE ARTIFACT ${JSON.stringify({ videoOnly, video, distinctTiles: new Set(tiles).size, captionPixels, fullWorkloadQualified: false })}`);
  }, 180_000);

  it.each(["file-sequence-v1", "partition-pipes-v1"] as const)("%s chunk seams preserve every crossfade, caption, animated still and ducked sample", async (engine) => {
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
    const mediaDir = path.join(dir, `Director's-original-export-${engine}-${"project-".repeat(10)}`);
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
    const delivered = await decoded(await renderLossless(long, `seams-delivered-${engine}`, { engine }, engine === "partition-pipes-v1"));
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
