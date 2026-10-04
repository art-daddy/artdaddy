// AAC at 48 kHz, end to end (slice 3d). The shipped ffmpeg's AAC encoder stalls forever on 16 kHz
// audio that follows a few seconds of digital silence, so an export of a 16 kHz clip placed 5 s
// into the timeline ran until cancelled. These drive the REAL producers through the shared runner
// (the same ffmpeg rules TauriCommandRunner applies) with exactly that audio, and judge the FILE:
// it must exist within a bound, carry 48 kHz AAC, and sound where the source sounds.
//   npx vitest run --config vitest.smoke.config.ts src/timeline/aac48k.smoke.e2e.ts
import os from "node:os";
import { spawnSync } from "node:child_process";
import { promises as fsp } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ClientToolContext } from "../tools/context";
import { shippedSidecar } from "../test/sidecars";
import {
  ff,
  installE2EDocuments,
  libRef,
  meanVolumeDb,
  mkCtx,
  nodeFs,
  nodeRunner,
  openE2EDoc,
  resetE2EDocuments,
} from "../tools/__e2e";
import { clipVideoTool } from "../tools/media";
import { AAC_EXTENSIONS, AAC_MUXERS } from "../tools/ffmpegPolicy";
import { encodeVideoForGemini } from "../tools/geminiEncode";
import { joinPath } from "../tools/store";
import { saveRecording } from "../media/recordSave";
import { processImportedMedia } from "../preview/mediaProxy";
import { proxyName } from "../preview/proxyPaths";
import { ensureTimeline } from "./engine";
import { addTrackTool, setCanvasTool } from "./ops";
import { addClipsTool } from "./placement";
import { exportTimelineTool } from "./render";
import { cancelExport, whenExportEnds } from "./exportQueue";

type Rec = Record<string, unknown>;

const ROOT = joinPath(os.tmpdir(), `artdaddy-aac48k-${Date.now()}`);
/** Far beyond the seconds each encode below takes; a hang never ends. */
const BOUND_MS = 60_000;

beforeAll(() => installE2EDocuments());
afterAll(async () => {
  await resetE2EDocuments();
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
});

async function project(name: string): Promise<{ dir: string; ctx: ClientToolContext }> {
  const dir = joinPath(ROOT, name);
  await nodeFs.mkdir(dir);
  await openE2EDoc(dir);
  const ctx = mkCtx(dir);
  await ensureTimeline(ctx.store);
  return { dir, ctx };
}

/** Resolves to `work`, or throws once `ms` pass: a hang must fail the test, not stall the lane. */
async function bounded<T>(what: string, work: Promise<T>, ms = BOUND_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish in ${ms / 1000} s`)), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

async function audioStream(file: string): Promise<{ codec: string; rate: number } | null> {
  const r = await nodeRunner.run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=codec_name,sample_rate",
    "-of",
    "json",
    file,
  ]);
  const s = (JSON.parse(r.stdout || "{}") as { streams?: Rec[] }).streams?.[0];
  return s ? { codec: String(s.codec_name), rate: Number(s.sample_rate) } : null;
}

/** 16 kHz mono: 6 s of digital silence, then 2 s of tone — the shape that stalls the encoder.
 *  With a picture when `video`, in Matroska with PCM audio so making it encodes no AAC itself. */
async function silenceThenTone(out: string, video: boolean): Promise<string> {
  const pic = video ? ["-f", "lavfi", "-i", "color=c=gray:s=160x90:r=10:d=8"] : [];
  const a = video ? 1 : 0;
  await ff([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    ...pic,
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=16000:cl=mono:d=6",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=16000:duration=2",
    "-filter_complex",
    `[${a}:a][${a + 1}:a]concat=n=2:v=0:a=1[a]`,
    ...(video ? ["-map", "0:v", "-c:v", "libx264", "-pix_fmt", "yuv420p"] : []),
    "-map",
    "[a]",
    "-c:a",
    "pcm_s16le",
    out,
  ]);
  return out;
}

describe("AAC at 48 kHz: every AAC encode finishes on 16 kHz audio that starts silent", () => {
  it("EXPORT: a 16 kHz clip placed 5 s into the timeline exports, at 48 kHz, sounding where placed", async () => {
    const { dir, ctx } = await project("export");
    expect(((await setCanvasTool({ width: 160, height: 90, fps: 30 }, ctx)) as Rec).ok).toBe(true);
    expect(((await addTrackTool({ id: "a1", kind: "audio" }, ctx)) as Rec).ok).toBe(true);
    // The user's case: speech recorded at 16 kHz, dropped 5 s in (frames at 30 fps).
    const wav = joinPath(dir, "speech16k.wav");
    await ff([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=16000:duration=3",
      "-ac",
      "1",
      wav,
    ]);
    const ref = await libRef(ctx, wav, "audio");
    const placed = (await addClipsTool(
      { entries: [{ media_ref: ref, track_id: "a1", timeline_in: 150, timeline_out: 240 }] },
      ctx,
    )) as Rec;
    expect(placed.ok, JSON.stringify(placed)).toBe(true);

    const res = (await exportTimelineTool({ name: "talk16k" }, ctx)) as Rec;
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const jobId = String(res.job_id);
    const ended = await bounded("the export", whenExportEnds(jobId)).catch((e) => {
      cancelExport(jobId); // kills the stalled ffmpeg instead of leaving it to outlive the run
      throw e;
    });
    expect(ended?.state, JSON.stringify(ended)).toBe("done");

    const out = await ctx.store.exportPath("talk16k.mp4");
    expect(await audioStream(out)).toEqual({ codec: "aac", rate: 48000 });
    // Two points that must differ: silence before the clip, the tone inside it.
    expect(await meanVolumeDb(out, { ss: 0.5, dur: 3.5 })).toBeLessThan(-70);
    expect(await meanVolumeDb(out, { ss: 5.5, dur: 2 })).toBeGreaterThan(-40);
  }, 120_000);

  it("CLIP_VIDEO re-encode of a source whose 16 kHz audio starts silent finishes at 48 kHz", async () => {
    const { dir, ctx } = await project("clip");
    const src = await silenceThenTone(joinPath(dir, "src16k.mkv"), true);
    const ref = await libRef(ctx, src, "video");
    const r = (await bounded(
      "clip_video",
      clipVideoTool(
        { media_ref: ref, start_s: 0, end_s: 8, output_name: "cut.mp4", reencode: true },
        ctx,
      ),
    )) as Rec;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const out = await ctx.store.resolveRef(String(r.media_ref));
    expect(out).toBeTruthy();
    expect(await audioStream(out!)).toEqual({ codec: "aac", rate: 48000 });
    expect(await meanVolumeDb(out!, { ss: 6.3, dur: 1.4 })).toBeGreaterThan(-40);
  }, 120_000);

  it("GEMINI encode with audio kept finishes at 48 kHz", async () => {
    const { dir, ctx } = await project("gemini");
    const src = await silenceThenTone(joinPath(dir, "src16k.mkv"), true);
    const out = await bounded(
      "the gemini encode",
      encodeVideoForGemini(ctx, src, { fps: 1, maxDim: 90, keepAudio: true }),
    );
    expect(await audioStream(out)).toEqual({ codec: "aac", rate: 48000 });
  }, 120_000);

  it("PREVIEW PROXY of an undecodable container with 16 kHz audio finishes at 48 kHz", async () => {
    const { dir, ctx } = await project("proxy");
    // h264 in Matroska: the WebView's demuxer reads ISOBMFF only, so this one gets a proxy.
    await nodeFs.mkdir(joinPath(dir, "library"));
    await silenceThenTone(joinPath(dir, "library", "src16k.mkv"), true);
    await bounded(
      "the preview proxy",
      processImportedMedia(ctx.store, ctx.runner, "library/src16k.mkv"),
    );
    const proxy = await ctx.store.prepareArtifact(`proxies/${proxyName("library/src16k.mkv")}`);
    expect(await nodeFs.exists(proxy)).toBe(true);
    expect(await audioStream(proxy)).toEqual({ codec: "aac", rate: 48000 });
  }, 120_000);

  it("RECORDING saved from a non-mp4 container finishes at 48 kHz", async () => {
    const { dir, ctx } = await project("record");
    // Matroska bytes are what a WebM recording is; the mime only names the file.
    const src = await silenceThenTone(joinPath(dir, "take.mkv"), true);
    const bytes = new Uint8Array(await fsp.readFile(src));
    const saved = await bounded("saving the recording", saveRecording(ctx, bytes, "video/webm"));
    expect(saved.transcoded).toBe(true);
    const out = await ctx.store.resolveRef(saved.media_ref);
    expect(out).toBeTruthy();
    expect(await audioStream(out!)).toEqual({ codec: "aac", rate: 48000 });
  }, 120_000);

  it("a 48 kHz source is not resampled and a non-AAC encode keeps its rate (control)", async () => {
    const { dir } = await project("control");
    const wav = joinPath(dir, "speech16k.wav");
    await ff(["-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=1", wav]);
    // The whisper extract's own shape: PCM at 16 kHz must stay 16 kHz.
    const pcm = joinPath(dir, "whisper.wav");
    await ff(["-y", "-i", wav, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", pcm]);
    expect(await audioStream(pcm)).toEqual({ codec: "pcm_s16le", rate: 16000 });
    const mp3 = joinPath(dir, "gemini.mp3");
    await ff(["-y", "-i", wav, "-vn", "-c:a", "libmp3lame", "-q:a", "5", mp3]);
    expect(await audioStream(mp3)).toEqual({ codec: "mp3", rate: 16000 });
  }, 60_000);

  // Found by QA: an agent asked for 16 kHz AAC tried every spelling of the rate it knew. swresample's
  // own options are a real way past `-ar` — the raw half below proves it, so this cannot pass by
  // testing a spelling ffmpeg ignores — and beside the pinned rate ffmpeg refused the command
  // ("Impossible to convert between the formats"). Through the app's runner they are dropped: the
  // encode of the stalling shape finishes, at 48 kHz.
  it("swresample's output rate (-osr / -out_sample_rate) cannot make a 16 kHz AAC", async () => {
    const { dir } = await project("swr");
    const bin = shippedSidecar("ffmpeg");
    expect(bin, "the shipped ffmpeg is staged").toBeTruthy();
    // A plain tone for the raw half: 16 kHz AAC after silence is the shape that never finishes.
    const tone = joinPath(dir, "tone16k.wav");
    await ff(["-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=1", tone]);
    const stalls = await silenceThenTone(joinPath(dir, "src16k.mkv"), false);
    for (const opt of ["-osr", "-out_sample_rate"]) {
      const raw = joinPath(dir, `raw${opt}.m4a`);
      const r0 = spawnSync(bin!, [
        "-y",
        "-v",
        "error",
        "-i",
        tone,
        "-c:a",
        "aac",
        opt,
        "16000",
        raw,
      ]);
      expect(r0.status, `${opt}: ${r0.stderr}`).toBe(0);
      expect(await audioStream(raw), `${opt} without the rule`).toEqual({
        codec: "aac",
        rate: 16000,
      });

      const out = joinPath(dir, `ruled${opt}.m4a`);
      const r = await bounded(
        opt,
        nodeRunner.run("ffmpeg", [
          "-y",
          "-v",
          "error",
          "-i",
          stalls,
          "-c:a",
          "aac",
          opt,
          "16000",
          out,
        ]),
      );
      expect(r.code, `${opt}: ${r.stderr}`).toBe(0);
      expect(await audioStream(out), opt).toEqual({ codec: "aac", rate: 48000 });
    }
  }, 120_000);
});

// The rule's tables say which muxers and extensions encode AAC when no codec is named. A table can
// only be as right as the ffmpeg it describes, so ask the shipped one, on each platform.
describe("the AAC tables agree with the shipped ffmpeg", () => {
  it("every muxer in the table defaults to AAC (and the documented exclusion does not)", async () => {
    const defaultAudio = async (muxer: string) => {
      const r = await nodeRunner.run("ffmpeg", ["-hide_banner", "-h", `muxer=${muxer}`]);
      return /Default audio codec: ([^.\s]+)/.exec(r.stdout + r.stderr)?.[1] ?? null;
    };
    for (const m of AAC_MUXERS) expect(await defaultAudio(m), m).toBe("aac");
    expect(await defaultAudio("3gp")).not.toBe("aac");
  }, 60_000);

  it("an output encodes AAC by default exactly when its extension is in the table", async () => {
    const { dir } = await project("extensions");
    const tone = joinPath(dir, "tone.wav");
    await ff(["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", tone]);
    // Wider than the table on purpose: an AAC default MISSING from it is the failure that matters.
    const universe = [
      ...AAC_EXTENSIONS,
      ...["mkv", "mka", "webm", "avi", "ts", "flv", "ogg", "opus", "mp3", "wav", "m2ts", "nut"],
      ...["caf", "aiff", "ac3", "flac", "wma", "3gp"],
    ];
    const wrong: string[] = [];
    for (const ext of universe) {
      const out = joinPath(dir, `o.${ext}`);
      const r = await nodeRunner.run("ffmpeg", ["-y", "-v", "error", "-i", tone, out]);
      const codec = r.code === 0 ? ((await audioStream(out))?.codec ?? null) : null;
      if ((codec === "aac") !== AAC_EXTENSIONS.has(ext)) wrong.push(`${ext} -> ${codec}`);
    }
    expect(wrong).toEqual([]);
  }, 120_000);
});
