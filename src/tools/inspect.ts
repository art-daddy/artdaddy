// inspect_media (client): let the model SEE media on its next turn.
// Ported from src/akaru/v4/tools/inspect.py — the model-agnostic paths:
//   - image: attach the still directly;
//   - video: sample N evenly-spaced stills via ffmpeg and attach them.
// Audio + video-with-audio also get an on-device whisper transcript (sentence
// rows, plus word-level tuples when word_timestamps). Extracted stills land in
// the shared project store and are declared
// through `_attachments` (attachment-transport → server enqueues them).
import { type Attachment, audioAttachment, imageAttachment, videoAttachment } from "./attachments";
import { stderrExcerpt } from "./command";
import type { ClientToolContext } from "./context";
import { probePath, shortHash } from "./media";
import { encodeImageForGemini, encodeVideoForGemini } from "./geminiEncode";
import type { ClientToolRegistry } from "./registry";
import { unresolvedRefError } from "./refState";
import { runWhisper } from "./transcribe";
import { INTERNAL_DIR, joinPath } from "./store";
import { loadTimeline } from "../timeline/engine";
import { clipSourceSpanSeconds, findClip } from "../timeline/helpers";
import { canvasFps, toSecondsView } from "../timeline/frames";
import { IMAGE_EXTS } from "../media/formats";
import type { Clip, Timeline } from "../timeline/model";
import {
  buildRenderCommand,
  canvasDuration,
  resolveClipSources,
  runRenderPlan,
} from "../timeline/render";
import { validateTimeline } from "../timeline/validate";

type Result = Record<string, unknown>;
const NOT_READY: Result = { ok: false, error: "client tool runtime not ready" };
const DEFAULT_FRAMES = 4;
const MAX_FRAMES = 12;

/** Longest edge of an extracted frame.
 *
 *  Was 512, which on a 1080x1920 canvas produced 288x512 — 7% of the frame's area. A caption at
 *  2-3% of frame height lands at 10-15px there, so stroke width, weight and legibility are all
 *  unjudgeable and `inspect_timeline` returned ok:true for a frame nobody could actually check.
 *  One constant, shared by every extractor, so the three call sites cannot drift apart. */
const FRAME_MAX_EDGE = 1024;

/** ffmpeg scale filter bounding a frame to {@link FRAME_MAX_EDGE} without changing its aspect. */
const frameScale = `scale=${FRAME_MAX_EDGE}:${FRAME_MAX_EDGE}:force_original_aspect_ratio=decrease`;

/** How much of `cache/inspect/` the intermediate renders may occupy.
 *
 *  Each call encodes up to the DEEPEST frame asked for, so a question about the end of a 50s
 *  timeline writes ~40 MB whatever the frame count. `sweepArtifactCache` collects these, but only
 *  at project CLOSE — so an afternoon of iterative work grew the directory without bound (eight
 *  calls, ~220 MB, in one reported session). This is the in-session ceiling. */
const INSPECT_CACHE_BUDGET = 512 * 1024 * 1024;

/** Hold `cache/inspect/` under {@link INSPECT_CACHE_BUDGET}, never touching `keep`.
 *
 *  `readDir` reports no timestamps, so there is no least-recently-used to evict by: over budget,
 *  everything but the render this call needs goes. That still serves the dominant pattern (the same
 *  window asked repeatedly — seven times in one reported session, five back to back) and is only
 *  reached when the directory is already large. Best-effort: a cache it cannot trim must never fail
 *  the inspection. */
async function trimInspectCache(ctx: ClientToolContext, keep: string): Promise<void> {
  try {
    const dir = joinPath(ctx.store.projectDir, INTERNAL_DIR, "cache", "inspect");
    const entries = await ctx.store.readDir(dir);
    const mp4s = entries.filter((e) => !e.isDirectory && e.name.endsWith(".mp4"));
    const sized = await Promise.all(
      mp4s.map(async (e) => {
        const path = joinPath(dir, e.name);
        return { path, bytes: (await ctx.store.byteSize(path).catch(() => null)) ?? 0 };
      }),
    );
    let total = sized.reduce((n, f) => n + f.bytes, 0);
    if (total <= INSPECT_CACHE_BUDGET) return;
    for (const f of sized) {
      if (total <= INSPECT_CACHE_BUDGET) break;
      if (f.path === keep) continue;
      await ctx.store.remove(f.path).catch(() => undefined);
      total -= f.bytes;
    }
  } catch {
    /* unreadable cache dir — trimming is housekeeping, not part of the answer */
  }
}
const IMAGE_EXT = new Set(IMAGE_EXTS.map((e) => `.${e}`));

function baseName(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

/** image / audio / video from the path extension + probe streams. */
export function mediaKind(path: string, probe: Result): "image" | "audio" | "video" {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  if (IMAGE_EXT.has(ext)) return "image";
  const hasVideo = probe.video != null;
  const hasAudio = probe.audio != null;
  if (!hasVideo && hasAudio) return "audio";
  const dur = typeof probe.duration_s === "number" ? probe.duration_s : 0;
  if (hasVideo && dur <= 0) return "image"; // single still misnamed / no duration
  return "video";
}

/** n evenly-spaced sample times (sub-span midpoints); mirrors _even_times. */
export function evenTimes(start: number, end: number, n: number): number[] {
  const span = Math.max(0, end - start);
  if (n <= 1 || span <= 0) return [start + span / 2];
  return Array.from({ length: n }, (_, i) => start + (span * (i + 0.5)) / n);
}

function clampFrames(v: unknown): number {
  const n = typeof v === "number" ? Math.trunc(v) : DEFAULT_FRAMES;
  return Math.max(1, Math.min(MAX_FRAMES, n));
}

/** n evenly-spaced frame numbers in [start,end]; mirrors _even_frame_nums. */
export function evenFrameNums(start: number, end: number, n: number): number[] {
  const s = Math.trunc(start);
  const e = Math.trunc(end);
  if (e <= s) return [s];
  const k = Math.max(1, Math.min(n, e - s));
  if (k === 1) return [s];
  return Array.from({ length: k }, (_, i) => s + Math.round(((e - s - 1) * i) / (k - 1)));
}

/** True for a Gemini-family model (reasons over video/audio natively). */
export function isGemini(model: unknown): boolean {
  return String(model ?? "")
    .trim()
    .toLowerCase()
    .startsWith("gemini");
}

/** ffmpeg-clip [start,end] into a 480p, fps-sampled mp4 for a Gemini inline
 *  video Part. Cached by (src, window, fps, audio). Mirrors _clip_video_for_gemini. */
async function clipVideoForGemini(
  ctx: ClientToolContext,
  src: string,
  start: number,
  end: number,
  fps: number,
  keepAudio: boolean,
): Promise<string> {
  return encodeVideoForGemini(ctx, src, {
    fps,
    maxDim: 480,
    keepAudio,
    start,
    end,
    tag: "inspect",
  });
}

// Bump when the audio-extract recipe changes (codec/bitrate/filters) so a cached clip is
// regenerated instead of reused (Phase 7 cache keying).
const GEMINI_AUDIO_REV = 1;

/** ffmpeg-extract [start,end] audio into a compact mp3 for a Gemini inline audio
 *  Part. Whole track when no window. Mirrors _clip_audio_for_gemini. */
async function clipAudioForGemini(
  ctx: ClientToolContext,
  src: string,
  start: number | null,
  end: number | null,
): Promise<string> {
  const s = start ?? 0;
  const out = await ctx.store.prepareArtifact(
    `inspect/gem_aud_${shortHash(`${src}|${start}|${end}|r${GEMINI_AUDIO_REV}`)}.mp3`,
  );
  if (await ctx.store.exists(out)) return out;
  const cmd = ["-y", "-hide_banner", "-loglevel", "error"];
  if (start !== null) cmd.push("-ss", Math.max(0, s).toFixed(3));
  cmd.push("-i", src);
  if (end !== null) cmd.push("-t", Math.max(0.1, end - s).toFixed(3));
  cmd.push("-vn", "-c:a", "libmp3lame", "-q:a", "5", out);
  const r = await ctx.runner.run("ffmpeg", cmd);
  if (r.code !== 0 || !(await ctx.store.exists(out)))
    throw new Error(`extract audio for attach failed: ${stderrExcerpt(r.stderr, 200)}`);
  return out;
}

const TRANSCRIPT_SEG_CAP = 400;
const TRANSCRIPT_WORD_CAP = 10_000;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Transcribe `path` (whole file, cached) into a compact inspect_media transcript:
 *  sentence rows `[text, start_s, end_s]` always, plus a flat `words` list
 *  `[text, start_s, end_s]` when `wordTimestamps` — both windowed to [start, end]
 *  and capped, mirroring the server + other NLEs. When `clip` is set the times are
 *  instead the clip's PROJECT FRAMES `[text, start_frame, end_frame]` and rows
 *  outside its visible span are dropped. On failure returns `{ error }` so
 *  inspect_media still succeeds with frames/metadata. */
async function buildTranscript(
  ctx: ClientToolContext,
  path: string,
  opts: {
    start: number | null;
    end: number | null;
    wordTimestamps: boolean;
    clip?: Clip | null;
    fps?: number;
  },
): Promise<Result> {
  try {
    // Bound the WORK by the window, not just the rows we print. Transcribing all of a
    // 58-minute podcast to answer a question about 30 seconds of it cost 21 minutes; the
    // window whisper is given keeps its own cache entry, and a full transcript (the
    // indexer builds one in the background) still short-circuits every windowed ask.
    const t = await runWhisper(ctx, path, undefined, undefined, {
      start: opts.start,
      end: opts.end,
    });
    const { start, end } = opts;
    const inWin = (a: number, b: number): boolean =>
      !((end !== null && a > end) || (start !== null && b < start));
    // When inspecting a placed clip, report times in the timeline's PROJECT
    // FRAMES (mirroring the renderer's source<->timeline mapping) and drop rows
    // outside the clip's visible span, so the model gets frames it can edit with.
    const clip = opts.clip ?? null;
    const fps = opts.fps && opts.fps > 0 ? opts.fps : 30;
    const tin = clip ? Number(clip.timeline_in) || 0 : 0;
    const tout = clip ? Number(clip.timeline_out) || 0 : 0;
    const projectRow = (row: [string, number, number]): [string, number, number] | null => {
      if (!clip) return row;
      const speed = Number(clip.speed) > 0 ? Number(clip.speed) : 1;
      const srcIn = Number(clip.source_in) || 0;
      const toFrame = (ts: number): number => tin + (ts * fps - srcIn) / speed;
      let sf = toFrame(row[1]);
      let ef = toFrame(row[2]);
      if (ef < tin || sf > tout) return null; // wholly outside the clip's span
      sf = Math.max(tin, Math.min(tout, sf));
      ef = Math.max(tin, Math.min(tout, ef));
      return [row[0], Math.round(sf), Math.round(ef)];
    };
    const keepRow = (r: [string, number, number] | null): r is [string, number, number] =>
      r !== null;
    const fmt = clip ? "[text, start_frame, end_frame]" : "[text, start_s, end_s]";
    const segRows = t.segments
      .filter((s) => inWin(s.start_seconds, s.end_seconds))
      .map((s) => projectRow([s.text, round3(s.start_seconds), round3(s.end_seconds)]))
      .filter(keepRow);
    const segTrunc = segRows.length > TRANSCRIPT_SEG_CAP;
    const nextStart = segTrunc ? segRows[TRANSCRIPT_SEG_CAP][1] : null;
    const out: Result = {
      format: fmt,
      language: t.language,
      segments: segRows.slice(0, TRANSCRIPT_SEG_CAP),
      truncated: segTrunc,
      ...(clip ? { next_start_frame: nextStart } : { next_start_s: nextStart }),
    };
    if (opts.wordTimestamps) {
      const wordRows = t.words
        .filter((w) => inWin(w.start_seconds, w.end_seconds))
        .map((w) => projectRow([w.word, round3(w.start_seconds), round3(w.end_seconds)]))
        .filter(keepRow);
      out.words_format = fmt;
      out.words = wordRows.slice(0, TRANSCRIPT_WORD_CAP);
      out.words_truncated = wordRows.length > TRANSCRIPT_WORD_CAP;
    }
    return out;
  } catch (e) {
    return { error: `transcription failed: ${String(e)}` };
  }
}

export async function inspectMediaTool(
  args: Record<string, unknown>,
  ctx: ClientToolContext | null,
): Promise<Result> {
  if (!ctx) return NOT_READY;
  const argMediaRef = String(args.media_ref ?? "").trim();
  const clipId = String(args.clip_id ?? "").trim();
  let mediaRef = argMediaRef;
  let timelineClip: Clip | null = null;
  let clipFps = 30;
  // A clip-derived source may legitimately be an EXTERNAL (out-of-project absolute) ref; an
  // agent-supplied `media_ref` may NOT. Track the origin so the final resolve picks the right
  // resolver (trusted clip -> resolveRef, untrusted agent arg -> resolveMediaRef).
  let fromClip = false;
  if (clipId) {
    // A placed timeline clip: resolve it to its underlying source media so the
    // model can inspect a clip the same way it inspects a library asset, and so
    // transcript times can be reported in the timeline's PROJECT FRAMES.
    let timeline: Timeline;
    try {
      timeline = await loadTimeline(ctx.store);
    } catch (e) {
      return { ok: false, error: `clip_id given but the timeline could not be read: ${String(e)}` };
    }
    const found = findClip(timeline, clipId);
    if (!found) return { ok: false, error: `clip not found on the timeline: ${clipId}` };
    timelineClip = found[1];
    clipFps = canvasFps(timeline);
    const clipSource = String(timelineClip.media_ref ?? "").trim();
    if (!clipSource)
      return {
        ok: false,
        error: `clip ${clipId} has no source media to inspect (e.g. a text clip).`,
      };
    if (argMediaRef) {
      // Both provided -> enforce they name the same asset (parity with established NLEs), so a
      // clip_id can't silently override a mismatched media_ref.
      const [pClip, pArg] = await Promise.all([
        ctx.store.resolveRef(clipSource),
        ctx.store.resolveRef(argMediaRef),
      ]);
      if (pClip && pArg && pClip !== pArg) {
        return {
          ok: false,
          error: `clip_id ${clipId} references ${clipSource}, which does not match media_ref ${argMediaRef}. Pass just one, or matching values.`,
        };
      }
    }
    mediaRef = clipSource;
    fromClip = true;
  }
  if (!mediaRef)
    return {
      ok: false,
      error: "provide media_ref (a library asset) or clip_id (a placed timeline clip).",
    };
  // Agent-supplied media_ref goes through the NARROW resolver (rejects a raw absolute path / `..`
  // escape) so a read tool can't be turned into an arbitrary-file reader + exfil-to-model; a
  // clip-derived source is trusted (an EXTERNAL clip legitimately carries an absolute ref).
  const path = fromClip
    ? await ctx.store.resolveRef(mediaRef)
    : await ctx.store.resolveMediaRef(mediaRef);
  if (!path) {
    return unresolvedRefError(
      ctx.store,
      mediaRef,
      `media not found: ${mediaRef}. Pass a library id/filename or a clip_id.`,
    );
  }
  const srcRef = ctx.store.toRef(path); // echo a portable ref, never a system path
  const probe = await probePath(ctx.runner, path);
  if (!probe.ok) return probe;
  const kind = mediaKind(path, probe);
  const wordTs = args.word_timestamps === true;
  const hasAudio = probe.audio != null;

  if (kind === "image") {
    const v = (probe.video ?? null) as Result | null;
    return {
      ok: true,
      kind: "image",
      media_ref: srcRef,
      width: v ? v.width : null,
      height: v ? v.height : null,
      frames_attached: 1,
      metadata: probe,
      _attachments: [
        imageAttachment(
          await encodeImageForGemini(ctx, path),
          `inspect_media image ${baseName(path)}`,
        ),
      ],
    };
  }

  if (kind === "video") {
    const dur = typeof probe.duration_s === "number" ? probe.duration_s : 0;
    // A clip_id names a SPAN of its source, not the whole file. Without this the sampled
    // frames came from wherever the file happened to be — inspecting a 30s clip of a 10min
    // video returned frames at 149s and 447s, footage the clip does not contain — while the
    // transcript beside them was correctly clipped. An explicit window still wins.
    const clipWin = timelineClip ? clipSourceSpanSeconds(timelineClip, clipFps) : null;
    const winStart = clipWin ? clipWin[0] : 0;
    const winEnd = clipWin && clipWin[1] > clipWin[0] ? clipWin[1] : dur > 0 ? dur : winStart + 1;
    const start = typeof args.start_seconds === "number" ? args.start_seconds : winStart;
    let end = typeof args.end_seconds === "number" ? args.end_seconds : winEnd;
    if (end <= start) end = dur > start ? dur : start + 1;

    // Gemini perceives video natively -> attach the windowed clip (richer than
    // stills). gpt/text models keep the sampled-frame path below.
    if (isGemini(args._model_id)) {
      const attachFps =
        typeof args.sample_fps === "number" && args.sample_fps > 0 ? args.sample_fps : 1;
      const keepAudio = args.attach_audio === true;
      try {
        const clip = await clipVideoForGemini(ctx, path, start, end, attachFps, keepAudio);
        const cap = `inspect_media video ${baseName(path)} [${start.toFixed(2)}-${end.toFixed(2)}s] @ ${attachFps}fps`;
        const transcript = hasAudio
          ? await buildTranscript(ctx, path, {
              start,
              end,
              wordTimestamps: wordTs,
              clip: timelineClip,
              fps: clipFps,
            })
          : null;
        return {
          ok: true,
          kind: "video",
          media_ref: srcRef,
          duration_s: dur || null,
          window_s: [start, end],
          attach_fps: attachFps,
          video_attached: true,
          audio_attached_with_video: keepAudio,
          transcript,
          metadata: probe,
          _attachments: [videoAttachment(clip, cap, attachFps)],
        };
      } catch (e) {
        return {
          ok: true,
          kind: "video",
          media_ref: srcRef,
          video_attached: false,
          attach_error: String(e),
          metadata: probe,
        };
      }
    }

    const n = clampFrames(args.max_frames);
    const times = evenTimes(start, end, n);
    // Frames go through ffmpeg, the transcript through whisper — different subsystems, so
    // start the transcript FIRST and let it run while the frames extract, instead of paying
    // for one after the other. (other NLEs' read_video does the same.)
    const transcriptTask = hasAudio
      ? buildTranscript(ctx, path, {
          start,
          end,
          wordTimestamps: wordTs,
          clip: timelineClip,
          fps: clipFps,
        })
      : Promise.resolve(null);

    // Each extract is an independent ffmpeg on the same read-only file; awaiting them one at
    // a time paid a process startup per frame (the cost inspect_timeline already shed).
    const targets = await Promise.all(
      times.map(async (t) => ({
        t,
        out: await ctx.store.prepareArtifact(`inspect/${shortHash(`${path}|${t.toFixed(3)}`)}.png`),
      })),
    );
    const results = new Array<{ t: number; out: string; ok: boolean }>(targets.length);
    const LANES = 4;
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(LANES, targets.length) }, async () => {
        for (let i = next++; i < targets.length; i = next++) {
          const { t, out } = targets[i];
          const r = await ctx.runner.run("ffmpeg", [
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            Math.max(0, t).toFixed(3),
            "-i",
            path,
            "-vf",
            frameScale,
            "-frames:v",
            "1",
            out,
          ]);
          results[i] = { t, out, ok: r.code === 0 && (await ctx.store.exists(out)) };
        }
      }),
    );

    // Rebuilt in request order: the lanes finish out of order and the model reads a sequence.
    const attachments: Attachment[] = [];
    const frames: Array<{ t: number }> = [];
    for (const r of results) {
      if (!r?.ok) continue;
      attachments.push(imageAttachment(r.out, `inspect_media frame @${r.t.toFixed(2)}s`));
      frames.push({ t: r.t });
    }
    const transcript = await transcriptTask;
    return {
      ok: true,
      kind: "video",
      media_ref: srcRef,
      duration_s: dur || null,
      frames,
      frames_attached: attachments.length,
      transcript,
      metadata: probe,
      _attachments: attachments,
    };
  }

  // audio
  const audioDur = typeof probe.duration_s === "number" ? probe.duration_s : null;
  if (isGemini(args._model_id)) {
    // Gemini reasons over audio natively -> attach the (windowed) clip.
    const start = typeof args.start_seconds === "number" ? args.start_seconds : null;
    const end = typeof args.end_seconds === "number" ? args.end_seconds : null;
    try {
      const clip = await clipAudioForGemini(ctx, path, start, end);
      const transcript = await buildTranscript(ctx, path, {
        start,
        end,
        wordTimestamps: wordTs,
        clip: timelineClip,
        fps: clipFps,
      });
      return {
        ok: true,
        kind: "audio",
        media_ref: srcRef,
        duration_s: audioDur,
        audio_attached: true,
        transcript,
        metadata: probe,
        _attachments: [audioAttachment(clip, `inspect_media audio ${baseName(path)}`)],
      };
    } catch (e) {
      return {
        ok: true,
        kind: "audio",
        media_ref: srcRef,
        audio_attached: false,
        attach_error: String(e),
        metadata: probe,
      };
    }
  }
  // gpt/text: on-device whisper transcription (no media attachment).
  const start = typeof args.start_seconds === "number" ? args.start_seconds : null;
  const end = typeof args.end_seconds === "number" ? args.end_seconds : null;
  const transcript = await buildTranscript(ctx, path, {
    start,
    end,
    wordTimestamps: wordTs,
    clip: timelineClip,
    fps: clipFps,
  });
  return {
    ok: true,
    kind: "audio",
    media_ref: srcRef,
    duration_s: audioDur,
    frames_attached: 0,
    transcript,
    metadata: probe,
  };
}

/** inspect_timeline (client): render the composited timeline and attach sampled
 *  frames so the model can SEE the current edit. Reuses buildRenderCommand
 *  (full-timeline render, cached to cache/inspect/) + the attachment-transport.
 *  Ports inspect.py::inspect_timeline. */
export async function inspectTimelineTool(
  args: Record<string, unknown>,
  ctx: ClientToolContext | null,
): Promise<Result> {
  if (!ctx) return NOT_READY;
  let raw;
  try {
    raw = await loadTimeline(ctx.store);
  } catch (e) {
    return { ok: false, error: `timeline.json not found — author it first (${String(e)})` };
  }
  const errors = validateTimeline(raw);
  if (errors.length)
    return { ok: false, error: "timeline preflight failed", preflight_errors: errors.slice(0, 20) };
  const seconds = toSecondsView(raw);
  const duration = canvasDuration(seconds);
  if (duration <= 0) return { ok: false, error: "timeline is empty — add clips first" };
  const fps = canvasFps(raw);
  const startFrame = typeof args.start_frame === "number" ? Math.trunc(args.start_frame) : 0;
  const endFrame = typeof args.end_frame === "number" ? Math.trunc(args.end_frame) : null;
  const maxFrames =
    typeof args.max_frames === "number"
      ? Math.max(1, Math.min(MAX_FRAMES, Math.trunc(args.max_frames)))
      : 5;
  const nums = endFrame === null ? [startFrame] : evenFrameNums(startFrame, endFrame, maxFrames);

  // Resolve portable "library/<id>" sources to absolute paths (like the real
  // render does) so ffmpeg can open them — inspect_timeline previously handed
  // ffmpeg the raw relative path, which failed even though the file exists.
  await resolveClipSources(ctx, seconds);
  // Two costs this tool used to pay in full on EVERY call, on a timeline of ANY length:
  //
  //   * it encoded the WHOLE timeline. Frames are pulled by ABSOLUTE time below, so stopping the
  //     output after the last one asked for leaves every sampled frame byte-identical and drops
  //     the rest of the encode. In report d03ab792 a 2.7s question encoded 159s.
  //   * it encoded at DELIVERABLE quality (no -preset => libx264 `medium`). Nobody watches this
  //     file; it exists to have PNGs pulled out of it.
  //
  // And it re-did that work for calls it had already answered: the same session asked for the
  // identical window seven times, five of them back to back.
  const upTo = Math.min(duration, Math.max(...nums) / fps + 1 / fps);
  const options = { preset: "ultrafast", maxDurationSec: upTo };
  const key = await previewKey(ctx, seconds, options);
  const mp4 = await ctx.store.prepareArtifact(`inspect/tl_${key ?? "uncached"}.mp4`);
  await trimInspectCache(ctx, mp4);
  if (!key || !(await ctx.store.exists(mp4))) {
    const plan = buildRenderCommand(seconds, mp4, options);
    const rr = await runRenderPlan(ctx, plan);
    if (rr.code !== 0 || !(await ctx.store.exists(mp4))) {
      return {
        ok: false,
        error: `timeline render failed (code=${rr.code})`,
        stderr_tail: stderrExcerpt(rr.stderr),
      };
    }
  }

  // Extraction is per-frame and independent: same read-only mp4 in, a distinct png out. Running
  // them in sequence made an 8-frame call pay eight ffmpeg startups end to end, which is most of
  // why this tool's cost tracked "how many processes" rather than "how much work". Bounded rather
  // than unbounded so a low-core machine isn't thrashed by a wide request.
  const targets = await Promise.all(
    nums.map(async (nFrame) => ({
      nFrame,
      out: await ctx.store.prepareArtifact(`inspect/tl_${nFrame}.png`),
    })),
  );
  const results = new Array<{ nFrame: number; out: string; ok: boolean }>(targets.length);
  const LANES = 4;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(LANES, targets.length) }, async () => {
      for (let i = next++; i < targets.length; i = next++) {
        const { nFrame, out } = targets[i];
        // Seek HALF A FRAME EARLY. `-ss` before `-i` discards by PTS and keeps the first frame at
        // or after the target, so asking for a frame's own start time is a coin flip on rounding:
        // frame 59 at 30fps starts at 1.9666…s, prints as "1.967", and ffmpeg returned frame 60
        // instead. Landing between frame n-1 and frame n makes frame n the first one kept,
        // whatever the rounding. Measured: seeking mid-frame returns n+1, half a frame early n.
        const seek = Math.max(0, (nFrame - 0.5) / fps);
        const r = await ctx.runner.run("ffmpeg", [
          "-y",
          "-hide_banner",
          "-loglevel",
          "error",
          "-ss",
          seek.toFixed(3),
          "-i",
          mp4,
          "-vf",
          frameScale,
          "-frames:v",
          "1",
          out,
        ]);
        results[i] = { nFrame, out, ok: r.code === 0 && (await ctx.store.exists(out)) };
      }
    }),
  );

  // Rebuilt in frame order: the lanes finish out of order, and the model reads these as a sequence.
  const attachments: Attachment[] = [];
  const frames: Array<Record<string, unknown>> = [];
  for (const { nFrame, out, ok } of results) {
    const t = nFrame / fps;
    if (ok) attachments.push(imageAttachment(out, `timeline frame ${nFrame} (${t.toFixed(2)}s)`));
    frames.push({ frame: nFrame, time_s: t, ok });
  }
  return {
    ok: true,
    canvas: raw.canvas,
    frame_numbers: nums,
    frames_attached: attachments.length,
    frames,
    _attachments: attachments,
  };
}

/** Cache key for the rendered preview: the RESOLVED timeline plus the size of every media file it
 *  reads. The timeline alone is not enough — a source can be replaced in place (a generation
 *  landing on its placeholder) without a single clip changing. Null when the platform cannot stat,
 *  and then the caller re-renders: a stale frame is a wrong answer, which is worse than a slow one. */
async function previewKey(
  ctx: ClientToolContext,
  seconds: Timeline,
  options: Record<string, unknown>,
): Promise<string | null> {
  const refs = new Set<string>();
  for (const t of seconds.tracks ?? [])
    for (const c of t.clips ?? [])
      if (typeof c.media_ref === "string" && c.media_ref) refs.add(c.media_ref);
  const sizes: string[] = [];
  for (const ref of [...refs].sort()) {
    const size = await ctx.store.byteSize(ref).catch(() => null);
    if (size === null) return null;
    sizes.push(`${ref}:${size}`);
  }
  return shortHash(JSON.stringify({ tl: seconds, options, sizes }));
}

// ---------------------------------------------------------------------------
// inspect_color (client): color scopes so the agent grades by NUMBERS, not vibes.
// Ports inspect.py::inspect_color + _measure_color_frame. ffmpeg decodes a 240px
// rawvideo rgb24 dump; the scope math runs in TS (exact metric parity, reuses the
// bundled ffmpeg — no new dependency). The measured frame attaches via _attachments.
// ---------------------------------------------------------------------------

function r3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
function r2(x: number): number {
  return Math.round(x * 100) / 100;
}
function signed(x: number): string {
  const s = x.toFixed(2);
  return x >= 0 ? `+${s}` : s;
}

/** HSV hue in degrees [0,360) from linear-ish 0..1 RGB (standard conversion). */
function hueDeg(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b);
  const d = mx - Math.min(r, g, b);
  if (d === 0) return 0;
  let h: number;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/** Color scopes for one rgb24 buffer of `n` pixels (ports _measure_color_frame). */
export function colorScopes(buf: Uint8Array, n: number): Result {
  let rs = 0;
  let gs = 0;
  let bs = 0;
  let lumaSum = 0;
  let satSum = 0;
  let clipLow = 0;
  let clipHigh = 0;
  const luma = new Float32Array(n);
  const bins = new Float64Array(12);
  for (let i = 0; i < n; i++) {
    const r = buf[i * 3] / 255;
    const g = buf[i * 3 + 1] / 255;
    const b = buf[i * 3 + 2] / 255;
    rs += r;
    gs += g;
    bs += b;
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    luma[i] = l;
    lumaSum += l;
    if (l < 0.02) clipLow += 1;
    if (l > 0.98) clipHigh += 1;
    const mx = Math.max(r, g, b);
    const sat = mx > 0 ? (mx - Math.min(r, g, b)) / Math.max(mx, 1e-6) : 0;
    satSum += sat;
    bins[Math.min(11, Math.max(0, Math.floor(hueDeg(r, g, b) / 30)))] += sat;
  }
  const meanR = rs / n;
  const meanG = gs / n;
  const meanB = bs / n;
  const sorted = Float32Array.from(luma).sort();
  const pct = (p: number): number => {
    const rank = (p / 100) * (n - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    return lo === hi ? sorted[lo] : sorted[lo] * (1 - (rank - lo)) + sorted[hi] * (rank - lo);
  };
  const tot = bins.reduce((s, x) => s + x, 0) || 1;
  return {
    mean: [r3(meanR), r3(meanG), r3(meanB)],
    mean_luma: r3(lumaSum / n),
    black_point: r3(pct(1)),
    white_point: r3(pct(99)),
    clip_low_pct: r2((clipLow / n) * 100),
    clip_high_pct: r2((clipHigh / n) * 100),
    saturation: r3(satSum / n),
    warm_cool: r3(meanR - meanB),
    green_magenta: r3(meanG - (meanR + meanB) / 2),
    hue_histogram: Array.from(bins, (x) => r3(x / tot)),
  };
}

/** Directional grade gap between subject + reference scopes (ports _color_gap_hints). */
export function colorGapHints(subj: Result, ref: Result): Result {
  const dl = (ref.mean_luma as number) - (subj.mean_luma as number);
  const ds = (ref.saturation as number) - (subj.saturation as number);
  const dw = (ref.warm_cool as number) - (subj.warm_cool as number);
  const hints: string[] = [];
  if (Math.abs(dl) > 0.04)
    hints.push(`exposure ${signed(dl)} (subject ${dl > 0 ? "darker" : "brighter"})`);
  if (Math.abs(ds) > 0.04) hints.push(`saturation ${signed(ds)}`);
  if (Math.abs(dw) > 0.04)
    hints.push(`temperature ${dw > 0 ? "warmer" : "cooler"} (${signed(dw)})`);
  return { d_luma: r3(dl), d_saturation: r3(ds), d_warm_cool: r3(dw), hints };
}

/** ffmpeg-decode a frame to a 240px rgb24 dump, read the bytes, compute scopes. */
async function measureColorFrame(ctx: ClientToolContext, frame: string): Promise<Result | null> {
  const probe = await probePath(ctx.runner, frame);
  const video = (probe.video ?? null) as Result | null;
  const vw = video && typeof video.width === "number" ? video.width : 0;
  const vh = video && typeof video.height === "number" ? video.height : 0;
  if (vw <= 0 || vh <= 0) return null;
  // PIL thumbnail((240,240)): downscale only, longest side <= 240, keep aspect.
  const scale = Math.min(240 / vw, 240 / vh, 1);
  const tw = Math.max(1, Math.round(vw * scale));
  const th = Math.max(1, Math.round(vh * scale));
  const raw = await ctx.store.prepareArtifact(
    `inspect/color_${shortHash(`${frame}|${tw}x${th}`)}.raw`,
  );
  const r = await ctx.runner.run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    frame,
    "-vf",
    `scale=${tw}:${th}`,
    "-pix_fmt",
    "rgb24",
    "-f",
    "rawvideo",
    raw,
  ]);
  if (r.code !== 0) return null;
  let buf: Uint8Array;
  try {
    buf = await ctx.store.readBytes(raw);
  } catch {
    return null;
  }
  const n = tw * th;
  if (buf.length < n * 3) return null;
  return colorScopes(buf, n);
}

function findClipInTimeline(tl: Timeline, id: string): Clip | null {
  for (const t of tl.tracks ?? []) for (const c of t.clips ?? []) if (c.id === id) return c;
  return null;
}

/** Sample a raw (ungraded) frame from a media ref: the still itself for images,
 *  else a frame near 1s. Ports inspect_color._raw_frame. */
async function rawFrame(
  ctx: ClientToolContext,
  ref: string,
  tag: string,
  call: string,
): Promise<string | null> {
  const p = await ctx.store.resolveRef(ref);
  if (!p) return null;
  const dot = p.lastIndexOf(".");
  if (IMAGE_EXT.has(dot >= 0 ? p.slice(dot).toLowerCase() : "")) return p;
  const out = await ctx.store.prepareArtifact(
    `inspect/color_raw_${tag}_${shortHash(p)}_${call}.png`,
  );
  const r = await ctx.runner.run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    "1.000",
    "-i",
    p,
    "-vf",
    frameScale,
    "-frames:v",
    "1",
    out,
  ]);
  return r.code === 0 && (await ctx.store.exists(out)) ? out : null;
}

/** Render ONE clip with its grade applied (no other layers) at its midpoint and
 *  return the still. Ports inspect_color._render_graded_clip. */
async function gradedClipFrame(
  ctx: ClientToolContext,
  clipId: string,
  atFrame: number | null,
  call: string,
): Promise<{ png: string } | { error: string }> {
  let raw: Timeline;
  try {
    raw = await loadTimeline(ctx.store);
  } catch (e) {
    return { error: `could not read the timeline (${String(e)})` };
  }
  const clip = findClipInTimeline(raw, clipId);
  if (!clip) return { error: `no clip '${clipId}' on the timeline` };
  const fps = canvasFps(raw);
  const tIn = typeof clip.timeline_in === "number" ? clip.timeline_in : 0;
  const tOut = typeof clip.timeline_out === "number" ? clip.timeline_out : 1;
  const dur = Math.max(1, tOut - tIn);
  const mid = atFrame === null ? tIn + Math.floor(dur / 2) : atFrame;
  const rel = Math.max(0, mid - tIn);
  const oneClip: Clip = { ...clip, timeline_in: 0, timeline_out: dur };
  delete (oneClip as Record<string, unknown>).id;
  delete (oneClip as Record<string, unknown>).link_group;
  const one: Timeline = {
    units: "frames",
    canvas: raw.canvas,
    tracks: [{ id: "g", kind: "video", z: 0, clips: [oneClip] }],
    failures: [],
  };
  const mp4 = await ctx.store.prepareArtifact(`inspect/color_clip_${call}.mp4`);
  const seconds = toSecondsView(one);
  // ffmpeg cannot open a library ref, only a path. Every other render path resolves first; this
  // one did not, so measuring a CLIP always failed while a media_ref worked.
  await resolveClipSources(ctx, seconds);
  const plan = buildRenderCommand(seconds, mp4);
  const rr = await runRenderPlan(ctx, plan);
  if (rr.code !== 0 || !(await ctx.store.exists(mp4)))
    return { error: `rendering the clip failed${ffmpegReason(rr.stderr)}` };
  const t = Math.min(rel, dur - 1) / fps;
  const png = await ctx.store.prepareArtifact(`inspect/color_clip_${call}.png`);
  const r2f = await ctx.runner.run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    Math.max(0, t).toFixed(3),
    "-i",
    mp4,
    "-frames:v",
    "1",
    png,
  ]);
  if (r2f.code !== 0 || !(await ctx.store.exists(png)))
    return { error: `sampling frame ${mid} failed${ffmpegReason(r2f.stderr)}` };
  return { png };
}

/** A token unique to one inspect_color call, so two overlapping calls never share a scratch file. */
let colorCallSeq = 0;
function nextCallToken(): string {
  colorCallSeq = (colorCallSeq + 1) % 1e6;
  return `${Date.now().toString(36)}${colorCallSeq.toString(36)}`;
}

/** The last meaningful ffmpeg line, so a failure names its cause instead of "could not render". */
function ffmpegReason(stderr: string): string {
  const line = (stderr || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  return line ? ` — ${line.slice(0, 300)}` : "";
}

export async function inspectColorTool(
  args: Record<string, unknown>,
  ctx: ClientToolContext | null,
): Promise<Result> {
  if (!ctx) return NOT_READY;
  const clipId = typeof args.clip_id === "string" ? args.clip_id.trim() : "";
  const mediaRef = typeof args.media_ref === "string" ? args.media_ref.trim() : "";
  const reference = typeof args.reference === "string" ? args.reference.trim() : "";
  const atFrame = typeof args.at_frame === "number" ? Math.trunc(args.at_frame) : null;
  // Scratch files were named `inspect/color_clip.mp4` / `.png` — FIXED paths. Reads overlap, so
  // one call's ffmpeg was writing the file another call was decoding: six failures in one session,
  // reported as `Invalid data found when processing input` and a raw decoder abort code, on clips
  // that were perfectly fine. Per-call names, because there is nothing worth caching here.
  const call = nextCallToken();

  let frame: string | null;
  let subject: string;
  if (clipId) {
    const r = await gradedClipFrame(ctx, clipId, atFrame, call);
    if ("error" in r) return { ok: false, error: r.error };
    frame = r.png;
    subject = "clip";
  } else if (mediaRef) {
    frame = await rawFrame(ctx, mediaRef, "subj", call);
    subject = "media";
  } else {
    return { ok: false, error: "provide clip_id or media_ref" };
  }
  if (!frame)
    return unresolvedRefError(
      ctx.store,
      mediaRef,
      `could not sample a frame from '${mediaRef}'`,
    );

  const scopes = await measureColorFrame(ctx, frame);
  if (!scopes) return { ok: false, error: "failed to measure color scopes (frame decode failed)" };
  const attachments: Attachment[] = [imageAttachment(frame, `inspect_color ${subject} scopes`)];
  const res: Result = { ok: true, subject, scopes, frame_attached: 1 };

  if (reference) {
    const rf = await rawFrame(ctx, reference, "ref", call);
    if (rf) {
      const refScopes = await measureColorFrame(ctx, rf);
      if (refScopes) {
        attachments.push(imageAttachment(rf, "inspect_color reference"));
        res.reference_scopes = refScopes;
        res.gap = colorGapHints(scopes, refScopes);
      }
    }
  }
  res._attachments = attachments;
  return res;
}

export function registerInspectTools(
  registry: ClientToolRegistry,
  getCtx: () => ClientToolContext | null,
): void {
  registry.register("inspect_media", (args) => inspectMediaTool(args, getCtx()));
  registry.register("inspect_timeline", (args) => inspectTimelineTool(args, getCtx()));
  registry.register("inspect_color", (args) => inspectColorTool(args, getCtx()));
}
