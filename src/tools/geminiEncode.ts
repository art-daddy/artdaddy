// Shared client-side "encode a video for a Gemini video Part" helper — the twin
// of the server's _encode_for_gemini_cached. Downscales, fps-samples and (by
// default) strips audio into a compact MP4 so we ship a small clip over the wire
// instead of the full source. Reused by inspect_media (windowed glance) and by
// read_media (whole-video pre-encode before a hosted vision call). Kept
// dependency-free (only the context type) so it never forms an import cycle.
import { stderrExcerpt } from "./command";
import type { ClientToolContext } from "./context";

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
const GEMINI_VIDEO_ENCODE_REV = 1;

/** Encode `src` into a compact, content-keyed (cached) MP4 for a Gemini video
 *  Part and return the output path. Skips the ffmpeg run when the cached output
 *  already exists. Throws on encode failure. */
export async function encodeVideoForGemini(
  ctx: ClientToolContext,
  src: string,
  opts: GeminiEncodeOpts,
): Promise<string> {
  const kbps = opts.budget
    ? bitrateForBudget(opts.budget.maxBytes, opts.budget.durationS)
    : null;
  const key = keyHash(
    `${src}|${opts.start ?? ""}|${opts.end ?? ""}|${opts.fps}|${opts.maxDim}|${opts.keepAudio}|${kbps ?? ""}|r${GEMINI_VIDEO_ENCODE_REV}`,
  );
  const out = await ctx.store.prepareArtifact(`${opts.tag ?? "gemini"}/gem_vid_${key}.mp4`);
  if (await ctx.store.exists(out)) return out;
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
  cmd.push(...(opts.keepAudio ? ["-c:a", "aac", "-b:a", "96k"] : ["-an"]), out);
  const r = await ctx.runner.run("ffmpeg", cmd);
  if (r.code !== 0 || !(await ctx.store.exists(out))) {
    throw new Error(`encode for gemini failed: ${stderrExcerpt(r.stderr, 200)}`);
  }
  // The budget is a cap ffmpeg can still overshoot. Say so in the caller's vocabulary rather than
  // letting the reader refuse a cache filename the model has never heard of.
  if (opts.budget) {
    const size = await ctx.store.byteSize(out).catch(() => null);
    if (size !== null && size > opts.budget.maxBytes) {
      throw new Error(
        `this video is too large to analyse in one pass (${Math.round(size / 1e6)} MB of samples). ` +
          `Pass a shorter start_seconds/end_seconds window and analyse it in parts.`,
      );
    }
  }
  return out;
}

/** Encode `src` into a compact, content-keyed (cached) downscaled JPEG for an
 *  image Part the model SEES (fits within `maxDim`×`maxDim`, never upscaled).
 *  Client-side twin of the server's old Pillow downscale — the server now
 *  attaches image bytes as-is. Returns `src` unchanged on any encode failure
 *  (the model still sees it, just larger). */
export async function encodeImageForGemini(
  ctx: ClientToolContext,
  src: string,
  opts: { maxDim?: number; quality?: number; tag?: string } = {},
): Promise<string> {
  const maxDim = opts.maxDim ?? 512;
  const quality = opts.quality ?? 70;
  const key = keyHash(`${src}|${maxDim}|${quality}`);
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
    src,
    "-vf",
    `scale=${maxDim}:${maxDim}:force_original_aspect_ratio=decrease`,
    "-frames:v",
    "1",
    "-q:v",
    String(qv),
    out,
  ]);
  if (r.code !== 0 || !(await ctx.store.exists(out))) return src;
  return out;
}
