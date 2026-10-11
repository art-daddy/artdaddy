// Shared client-side "encode a video for a Gemini video Part" helper — the twin
// of the server's _encode_for_gemini_cached. Downscales, fps-samples and (by
// default) strips audio into a compact MP4 so we ship a small clip over the wire
// instead of the full source. Reused by inspect_media (windowed glance) and by
// read_media (whole-video pre-encode before a hosted vision call). Its imports are leaves (the
// context type, the command helpers, and the still-picture owner, which itself never reaches the
// tool modules) so it never forms an import cycle.
import { stderrExcerpt } from "./command";
import { currentProjectSession, withProjectLock } from "./coordinator";
import type { ClientToolContext } from "./context";
import { stillPicture } from "../media/stillPicture";

export interface GeminiEncodeOpts {
  /** Output frame rate (frames sampled per second). */
  fps: number;
  /** Longest scaled edge in pixels (height for landscape via scale=-2:maxDim). */
  maxDim: number;
  /** Keep an AAC audio track (else `-an`). */
  keepAudio: boolean;
  /** Optional trim window start (seconds); omit for whole file. */
  start?: number;
  /** Optional trim window end (seconds); omit for whole file. */
  end?: number;
  /** Artifact sub-dir tag, e.g. "inspect" | "gemini". Defaults to "gemini". */
  tag?: string;
  /** Byte budget the OUTPUT must fit, with the encoded span's length in seconds. Supplied by the
   *  caller that will read the file, because a duration cap and a byte ceiling set independently
   *  leave a band that is accepted and then unreadable: a 12-minute film passed video_find_moment's
   *  30-minute cap and produced a 77.6 MB encode that the 64 MB heap ceiling refused, ten times in
   *  one session. Applied as a rate CAP on top of the quality target, so a short clip is unaffected. */
  budget?: { maxBytes: number; durationS: number };
}

/** Video bitrate (kbit/s) that lands `durationS` seconds inside `maxBytes`, or null when the span
 *  is unknown. The headroom covers the container and the muxer's own overshoot. */
export function bitrateForBudget(maxBytes: number, durationS: number): number | null {
  if (!(durationS > 0) || !(maxBytes > 0)) return null;
  return Math.max(120, Math.floor((maxBytes * 0.85 * 8) / durationS / 1000));
}

/** Deterministic 32-bit FNV-1a of a key string -> 8 hex chars (cache filename). */
function keyHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// Bump when the Gemini video ENCODE recipe changes (fps/scale/mute/codec) so an existing cached
// encode is treated as stale and regenerated, not reused (Phase 7 cache keying).
const GEMINI_VIDEO_ENCODE_REV = 2;

interface VideoEncodeJob {
  controller: AbortController;
  result: Promise<string>;
  waiters: number;
}

const videoEncodes = new Map<string, VideoEncodeJob>();

export function _pendingVideoEncodes(): number {
  return videoEncodes.size;
}

function requireEncodeSession(ctx: ClientToolContext, signal?: AbortSignal): void {
  if (signal?.aborted || !ctx.store.sessionLive()) throw new Error("video analysis cancelled");
}

async function checkVideoBudget(
  ctx: ClientToolContext,
  output: string,
  budget: GeminiEncodeOpts["budget"],
): Promise<void> {
  if (!budget) return;
  const size = await ctx.store.byteSize(output);
  if (size !== null && size > budget.maxBytes) {
    throw new Error(
      `this video is too large to analyse in one pass (${Math.round(size / 1e6)} MB of samples). ` +
        `Use a shorter input video and analyse it in parts.`,
    );
  }
}

/** Encode `src` into a compact, content-keyed (cached) MP4 for a Gemini video
 *  Part and return the output path. Skips the ffmpeg run when the cached output
 *  already exists. Throws on encode failure. */
export async function encodeVideoForGemini(
  ctx: ClientToolContext,
  src: string,
  opts: GeminiEncodeOpts,
): Promise<string> {
  requireEncodeSession(ctx, ctx.signal);
  const recipe: GeminiEncodeOpts = {
    ...opts,
    ...(opts.budget ? { budget: { ...opts.budget } } : {}),
  };
  const session = currentProjectSession(ctx.store.projectDir);
  const kbps = recipe.budget
    ? bitrateForBudget(recipe.budget.maxBytes, recipe.budget.durationS)
    : null;
  const identity = await ctx.store.fileIdentity(src);
  requireEncodeSession(ctx, ctx.signal);
  const key = keyHash(
    `${src}|${identity ?? ""}|${recipe.start ?? ""}|${recipe.end ?? ""}|${recipe.fps}|${recipe.maxDim}|${recipe.keepAudio}|${kbps ?? ""}|${recipe.budget?.maxBytes ?? ""}|${recipe.budget?.durationS ?? ""}|r${GEMINI_VIDEO_ENCODE_REV}`,
  );
  const rel = `${recipe.tag ?? "gemini"}/gem_vid_${key}.mp4`;
  const out = ctx.store.artifactPath(rel);
  const jobKey = `${session}\0${out}`;
  let job = videoEncodes.get(jobKey);
  if (!job || job.controller.signal.aborted) {
    const controller = new AbortController();
    const work = ctx.detach?.() ?? ctx;
    const created: VideoEncodeJob = {
      controller,
      waiters: 0,
      result: Promise.resolve().then(() =>
        encodeVideo(work, src, recipe, rel, out, kbps, controller.signal),
      ),
    };
    created.result = created.result.finally(() => {
      if (videoEncodes.get(jobKey) === created) videoEncodes.delete(jobKey);
    });
    videoEncodes.set(jobKey, created);
    job = created;
  }
  job.waiters += 1;
  let onAbort: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("video analysis cancelled"));
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      if (ctx.signal?.aborted) onAbort();
    });
    const output = await Promise.race([job.result, cancelled]);
    await checkVideoBudget(ctx, output, recipe.budget);
    requireEncodeSession(ctx, ctx.signal);
    return output;
  } finally {
    if (onAbort) ctx.signal?.removeEventListener("abort", onAbort);
    job.waiters -= 1;
    if (job.waiters === 0) job.controller.abort();
  }
}

async function encodeVideo(
  ctx: ClientToolContext,
  src: string,
  opts: GeminiEncodeOpts,
  rel: string,
  out: string,
  kbps: number | null,
  signal: AbortSignal,
): Promise<string> {
  requireEncodeSession(ctx, signal);
  if (await ctx.store.exists(out)) {
    await checkVideoBudget(ctx, out, opts.budget);
    requireEncodeSession(ctx, signal);
    return out;
  }
  const temporary = await ctx.store.prepareWork(`gemini/encode-${crypto.randomUUID()}.mp4`);
  const staged = `${out}.partial-${crypto.randomUUID()}`;
  const start = opts.start ?? 0;
  const cmd = ["-y", "-hide_banner", "-loglevel", "error"];
  if (opts.start !== undefined) cmd.push("-ss", Math.max(0, start).toFixed(3));
  cmd.push("-i", src);
  if (opts.end !== undefined) cmd.push("-t", Math.max(0.1, opts.end - start).toFixed(3));
  cmd.push(
    "-vf",
    `scale=-2:${opts.maxDim}`,
    "-r",
    String(Math.max(0.1, opts.fps)),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "28",
    "-pix_fmt",
    "yuv420p",
  );
  // A cap, not a target: crf still decides the quality, and this only bites on the long sources
  // that would otherwise encode past what the caller can read.
  if (kbps) cmd.push("-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`);
  cmd.push(...(opts.keepAudio ? ["-c:a", "aac", "-b:a", "96k"] : ["-an"]), temporary);
  try {
    requireEncodeSession(ctx, signal);
    const result = await ctx.runner.run("ffmpeg", cmd, signal);
    if (result.code !== 0 || !(await ctx.store.exists(temporary))) {
      throw new Error(`encode for gemini failed: ${stderrExcerpt(result.stderr, 200)}`);
    }
    await checkVideoBudget(ctx, temporary, opts.budget);
    await withProjectLock(ctx.store.projectDir, async () => {
      requireEncodeSession(ctx, signal);
      await ctx.store.prepareArtifact(rel);
      requireEncodeSession(ctx, signal);
      await ctx.store.copyFile(temporary, staged);
      requireEncodeSession(ctx, signal);
      await ctx.store.rename(staged, out);
    });
    return out;
  } finally {
    await ctx.store.remove(temporary).catch(() => undefined);
    await ctx.store.remove(staged).catch(() => undefined);
  }
}

/** Encode `src` into a compact, content-keyed (cached) downscaled JPEG for an
 *  image Part the model SEES (fits within `maxDim`×`maxDim`, never upscaled).
 *  Client-side twin of the server's old Pillow downscale — the server now
 *  attaches image bytes as-is. Returns the picture unchanged on an encode failure
 *  (the model still sees it, just larger).
 *
 *  Every still uploaded to a model passes here (generation references and frames, vision), so a
 *  HEIF-family still is read as its decoded picture HERE (media/stillPicture.ts): on a tiled iPhone
 *  photo the `-vf` below fails, and the fallback then sent the raw HEIC bytes, labelled .jpg, to a
 *  paid model. One that cannot be decoded is refused before anything is sent. */
export async function encodeImageForGemini(
  ctx: ClientToolContext,
  src: string,
  opts: { maxDim?: number; quality?: number; tag?: string } = {},
): Promise<string> {
  const maxDim = opts.maxDim ?? 512;
  const quality = opts.quality ?? 70;
  const picture = await stillPicture(ctx.store, ctx.runner, src, ctx.signal);
  if ("error" in picture) throw new Error(picture.error);
  const from = picture.path;
  const key = keyHash(`${from}|${maxDim}|${quality}`);
  const out = await ctx.store.prepareArtifact(`${opts.tag ?? "gemini"}/gem_img_${key}.jpg`);
  if (await ctx.store.exists(out)) return out;
  // mjpeg -q:v runs 2 (best) .. 31 (worst); map a 0-100 quality onto that band.
  const qv = Math.max(2, Math.min(31, Math.round((100 - quality) / 3)));
  const r = await ctx.runner.run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    from,
    "-vf",
    `scale=${maxDim}:${maxDim}:force_original_aspect_ratio=decrease`,
    "-frames:v",
    "1",
    "-q:v",
    String(qv),
    out,
  ]);
  if (r.code !== 0 || !(await ctx.store.exists(out))) return from;
  return out;
}
