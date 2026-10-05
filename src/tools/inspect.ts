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
import { unresolvedRefError, unresolvedRefMessage } from "./refState";
import { normLanguage, peekTranscript, runWhisper } from "./transcribe";
import { prioritizeTranscript } from "./transcriptQueue";
import { measureLoudness, type Loudness } from "./loudness";
import { displaySize, mediaFrameDims, sampleFrames, stillWithGrid } from "./mediaFrames";
import { makeStoryboard } from "./storyboard";
import { loadTimeline } from "../timeline/engine";
import { clipSourceSpanSeconds, clipSpanToFrames, findClip } from "../timeline/helpers";
import { canvasFps, toSecondsView } from "../timeline/frames";
import { IMAGE_EXTS } from "../media/formats";
import { stillPicture } from "../media/stillPicture";
import type { Clip, Timeline } from "../timeline/model";
import {
  buildRenderCommand,
  canvasDuration,
  canvasPx,
  resolveClipSources,
  runRenderPlan,
} from "../timeline/render";
import { onCanvasFrames, resolveRenderPlan, type SecondsRenderPlan } from "../timeline/renderPlan";
import { validateTimeline } from "../timeline/validate";
import {
  fitDims,
  gridAss,
  gridFilter,
  GRID_NOTE,
  OVERLAY_FONT_FILE,
  OVERLAY_REV,
} from "./inspectOverlay";

type Result = Record<string, unknown>;
const NOT_READY: Result = { ok: false, error: "client tool runtime not ready" };
/** Frames inspect_media samples from a video when max_frames is not given (Palmier's). */
const DEFAULT_FRAMES = 6;
const MAX_FRAMES = 12;
/** Frames inspect_timeline samples from a range when max_frames is not given (Palmier's). */
const TIMELINE_DEFAULT_FRAMES = 6;
/** Frame renders at once: each is its own ffmpeg, and a low-core machine must not be thrashed. */
const FRAME_LANES = 4;

/** Longest edge of a frame the agent sees, per tool (owner decision, 2026-10-02).
 *
 *  Frames are now re-sent every round while they stay in the conversation (the app owns the
 *  history), so their size is paid many times: a 1024 px PNG is ~1 MB, and ~30 of them a round
 *  approach the 64 MB request cap. `inspect_media` asks "what is in this clip", which 512 px
 *  answers (Palmier sends 512; see mediaFrames.MEDIA_FRAME_EDGE). `inspect_timeline` must also let
 *  the agent judge caption text: 512 px was tried before and a caption at 2-3% of a 9:16 frame's
 *  height came out 10-15 px tall, unjudgeable; at 768 px it is ~15-23 px. `inspect_color` keeps
 *  1024 px PNG because its measurement reads the same file and compression would move the
 *  numbers. */
const TIMELINE_FRAME_EDGE = 768;
const COLOR_FRAME_EDGE = 1024;

/** ffmpeg scale filter bounding a frame to `edge` without changing its aspect. */
const scaleTo = (edge: number): string =>
  `scale=${edge}:${edge}:force_original_aspect_ratio=decrease`;

/** ffmpeg's mjpeg quantizer (2 = best, 31 = worst) for frames the agent sees. */
const FRAME_JPEG_Q = "4";

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

/** The source times an inspect_media call samples from [start, end): `max_frames` (default 6, max
 *  12) sub-span midpoints. The one rule, shared with the eval's stand-in. */
export function mediaLookTimes(start: number, end: number, maxFrames: unknown): number[] {
  return evenTimes(start, end, clampFrames(maxFrames));
}

/** The project frames an inspect_timeline call asks for: `start_frame` alone (default 0), or with
 *  `end_frame`, `max_frames` (default 6, max 12) midpoints of [start_frame, end_frame). The one
 *  rule, shared with the eval's stand-in. */
export function timelineLookFrames(args: Record<string, unknown>): number[] {
  const startFrame = typeof args.start_frame === "number" ? Math.trunc(args.start_frame) : 0;
  const endFrame = typeof args.end_frame === "number" ? Math.trunc(args.end_frame) : null;
  const n =
    typeof args.max_frames === "number"
      ? Math.max(1, Math.min(MAX_FRAMES, Math.trunc(args.max_frames)))
      : TIMELINE_DEFAULT_FRAMES;
  return endFrame === null ? [startFrame] : midpointFrames(startFrame, endFrame, n);
}

/** Palmier's sampling of a frame range: the midpoints of n equal parts of [start, end), distinct
 *  and ascending. A span shorter than n gives each of its frames once; an empty one, the start. */
export function midpointFrames(start: number, end: number, n: number): number[] {
  const s = Math.trunc(start);
  const span = Math.trunc(end) - s;
  if (span <= 0) return [s];
  const k = Math.max(1, Math.trunc(n));
  const out: number[] = [];
  for (let i = 0; i < k; i++) {
    const f = s + Math.floor((span * (i + 0.5)) / k);
    if (out[out.length - 1] !== f) out.push(f);
  }
  return out;
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

/** The longest span a look transcribes while the model waits (owner decision 2026-10-02, UJ-012).
 *  A longer one is made in the background, one file at a time, and the look returns at once: a
 *  58-minute podcast once took 21 minutes to answer one question about it. */
export const INLINE_TRANSCRIPT_MAX_S = 600;

/** mm:ss (h:mm:ss past an hour) for a duration in a note to the model. */
function clock(s: number): string {
  const t = Math.max(0, Math.round(s));
  const pad = (n: number): string => String(n).padStart(2, "0");
  return t >= 3600
    ? `${Math.floor(t / 3600)}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`
    : `${Math.floor(t / 60)}:${pad(t % 60)}`;
}

/** Transcribe `path` over [start, end] into a compact inspect_media transcript:
 *  sentence rows `[text, start_s, end_s]` always, plus a flat `words` list
 *  `[text, start_s, end_s]` when `wordTimestamps` — both windowed to [start, end]
 *  and capped, mirroring the server + other NLEs. When `clip` is set the times are
 *  instead the clip's PROJECT FRAMES `[text, start_frame, end_frame]` and rows
 *  outside its visible span are dropped.
 *
 *  A cached transcript (the whole file's, or this window's) is used whatever its length. With
 *  none, a span up to {@link INLINE_TRANSCRIPT_MAX_S} is transcribed now; a longer one goes to the
 *  FRONT of the project's background queue and comes back as `status: "in_progress"`. On failure
 *  returns `{ error }` so inspect_media still succeeds with frames/metadata. */
async function buildTranscript(
  ctx: ClientToolContext,
  path: string,
  opts: {
    start: number | null;
    end: number | null;
    /** The file's length, when known: a window covering all of it is the whole-file transcript. */
    duration: number | null;
    wordTimestamps: boolean;
    language: string;
    clip?: Clip | null;
    fps?: number;
  },
): Promise<Result> {
  try {
    const from = Math.max(0, opts.start ?? 0);
    const to = opts.end ?? opts.duration;
    // A window that covers the whole file IS the whole-file transcript: asking for it as a window
    // would cache a second copy the background transcriber can never reuse.
    const whole =
      from <= 0.05 && (to === null || (opts.duration !== null && to >= opts.duration - 0.05));
    const window = whole ? null : { start: from, end: to };
    let t = await peekTranscript(ctx, path, undefined, opts.language, window);
    if (!t && to !== null && to - from > INLINE_TRANSCRIPT_MAX_S) {
      const queued = prioritizeTranscript(ctx.store.projectDir, path, normLanguage(opts.language));
      const zoom = `Pass start_seconds/end_seconds covering up to ${INLINE_TRANSCRIPT_MAX_S / 60} minutes to transcribe that part now.`;
      return queued
        ? {
            status: "in_progress",
            note: `Not transcribed yet: ${clock(to - from)} of audio is too long to wait for, so the whole file is being transcribed in the background (one file at a time, this one next). Call inspect_media again later for it. ${zoom}`,
          }
        : {
            status: "unavailable",
            note: `Not transcribed: ${clock(to - from)} of audio is too long to wait for, and nothing is transcribing in the background for this project. ${zoom}`,
          };
    }
    t ??= await runWhisper(ctx, path, undefined, opts.language, window);
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
  let clipTimeline: Timeline | null = null;
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
    clipTimeline = timeline;
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
        ctx.store.resolveMediaRef(argMediaRef),
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
  const resolved = fromClip
    ? await ctx.store.resolveRef(mediaRef)
    : await ctx.store.resolveMediaRef(mediaRef);
  if (!resolved) {
    return unresolvedRefError(
      ctx.store,
      mediaRef,
      `media not found: ${mediaRef}. Pass a library id/filename or a clip_id.`,
    );
  }
  const srcRef = ctx.store.toRef(resolved); // echo a portable ref, never a system path
  // A HEIF-family still is looked at as its decoded picture (media/stillPicture.ts): read directly,
  // a tiled iPhone photo reports the size of one tile and shows only that tile.
  const picture = await stillPicture(ctx.store, ctx.runner, resolved, ctx.signal);
  if ("error" in picture) return { ok: false, error: picture.error };
  const path = picture.path;
  const probe = await probePath(ctx.runner, path);
  if (!probe.ok) return probe;
  const kind = mediaKind(path, probe);
  const wordTs = args.word_timestamps === true;
  const language = typeof args.language === "string" ? args.language.trim() : "";
  const hasAudio = probe.audio != null;
  const video = (probe.video ?? null) as Result | null;
  const display = displaySize(video);
  // Part of every cache key: a file replaced in place (a generation landing on its placeholder)
  // must not be answered with frames of what was there before.
  const sizeKey = String(probe.size_bytes ?? "");

  if (kind === "image") {
    const gridded = display
      ? await stillWithGrid(ctx, path, mediaFrameDims(display), sizeKey)
      : null;
    return {
      ok: true,
      kind: "image",
      media_ref: srcRef,
      width: video ? video.width : null,
      height: video ? video.height : null,
      frames_attached: 1,
      ...(gridded ? { coordinate_grid: GRID_NOTE } : {}),
      metadata: probe,
      _attachments: [
        imageAttachment(
          gridded ?? (await encodeImageForGemini(ctx, path)),
          `inspect_media image ${baseName(resolved)}`,
        ),
      ],
    };
  }

  // The span looked at. A clip_id names a SPAN of its source, not the whole file. Without this the
  // sampled frames came from wherever the file happened to be — inspecting a 30s clip of a 10min
  // video returned frames at 149s and 447s, footage the clip does not contain — while the
  // transcript beside them was correctly clipped. An explicit window still wins.
  const dur = typeof probe.duration_s === "number" && probe.duration_s > 0 ? probe.duration_s : 0;
  const clipWin = timelineClip ? clipSourceSpanSeconds(timelineClip, clipFps) : null;
  const winStart = clipWin ? clipWin[0] : 0;
  const winEnd = clipWin && clipWin[1] > clipWin[0] ? clipWin[1] : dur > 0 ? dur : null;
  const start = typeof args.start_seconds === "number" ? Math.max(0, args.start_seconds) : winStart;
  let end: number | null = typeof args.end_seconds === "number" ? args.end_seconds : winEnd;
  if (end !== null && end <= start) end = dur > start ? dur : null;

  // Sound and transcript come from other subsystems than the frames, so they start FIRST and run
  // while the frames are read, instead of one after the other. Loudness is measured over the whole
  // span looked at, however long (owner decision 2026-10-03).
  const loudnessTask: Promise<Result | null> = hasAudio
    ? measureLoudness(ctx, path, start, end).then((l) =>
        "error" in l ? l : withClipGain(l, clipTimeline, timelineClip),
      )
    : Promise.resolve(null);
  const transcriptTask: Promise<Result | null> = hasAudio
    ? buildTranscript(ctx, path, {
        start,
        end,
        duration: dur || null,
        wordTimestamps: wordTs,
        language,
        clip: timelineClip,
        fps: clipFps,
      })
    : Promise.resolve(null);
  const finish = async (body: Result): Promise<Result> => {
    const [loudness, transcript] = await Promise.all([loudnessTask, transcriptTask]);
    if (ctx.signal?.aborted) return { ok: false, error: "cancelled" };
    return { ...body, loudness, transcript };
  };
  /** A source time in the caller's units: project frames for a clip_id, seconds otherwise. */
  const at = (t: number): Result => {
    if (!timelineClip) return { t: round3(t) };
    const f = clipSpanToFrames(timelineClip, t, t, clipFps);
    return { frame: f ? f[0] : null };
  };
  const timing = timelineClip ? "project_frames" : "source_seconds";

  if (kind === "video") {
    const span: [number, number] = [start, end ?? start + 1];
    // Gemini perceives video natively -> attach the windowed clip (richer than
    // stills). gpt/text models keep the sampled-frame path below.
    if (isGemini(args._model_id) && args.overview !== true) {
      const attachFps =
        typeof args.sample_fps === "number" && args.sample_fps > 0 ? args.sample_fps : 1;
      const keepAudio = args.attach_audio === true;
      try {
        const clip = await clipVideoForGemini(ctx, path, span[0], span[1], attachFps, keepAudio);
        const cap = `inspect_media video ${baseName(path)} [${span[0].toFixed(2)}-${span[1].toFixed(2)}s] @ ${attachFps}fps`;
        return finish({
          ok: true,
          kind: "video",
          media_ref: srcRef,
          duration_s: dur || null,
          window_s: span,
          attach_fps: attachFps,
          video_attached: true,
          audio_attached_with_video: keepAudio,
          metadata: probe,
          _attachments: [videoAttachment(clip, cap, attachFps)],
        });
      } catch (e) {
        return finish({
          ok: true,
          kind: "video",
          media_ref: srcRef,
          video_attached: false,
          attach_error: String(e),
          metadata: probe,
        });
      }
    }
    if (!display)
      return finish({
        ok: true,
        kind: "video",
        media_ref: srcRef,
        duration_s: dur || null,
        frames_attached: 0,
        frames_error: "the video's picture size could not be read, so no frame was taken",
        metadata: probe,
      });

    const base: Result = {
      ok: true,
      kind: "video",
      media_ref: srcRef,
      duration_s: dur || null,
      window_s: [round3(span[0]), round3(span[1])],
      timing,
    };
    // Coarse first: ONE storyboard of the span's visual flow, instead of frames.
    if (args.overview === true) {
      try {
        const sb = await makeStoryboard(ctx, path, span[0], span[1], display);
        const tiles = sb.tile_times.map(at);
        return finish({
          ...base,
          overview: timelineClip
            ? { tile_frames: tiles.map((x) => x.frame) }
            : { tile_times: tiles.map((x) => x.t) },
          frames_attached: 1,
          metadata: probe,
          _attachments: [
            imageAttachment(
              sb.path,
              `inspect_media overview ${baseName(path)} [${span[0].toFixed(1)}-${span[1].toFixed(1)}s]`,
            ),
          ],
        });
      } catch (e) {
        return finish({
          ...base,
          overview: { error: String(e) },
          frames_attached: 0,
          metadata: probe,
        });
      }
    }

    const shots = await sampleFrames(
      ctx,
      path,
      mediaLookTimes(span[0], span[1], args.max_frames),
      mediaFrameDims(display),
      sizeKey,
    );
    // Rebuilt in request order: the lanes finish out of order and the model reads a sequence.
    const attachments: Attachment[] = [];
    const measured = shots.filter((s) => s.sharpness !== undefined);
    const mean = (k: "sharpness" | "noise"): number | null =>
      measured.length
        ? Math.round((measured.reduce((n, s) => n + (s[k] ?? 0), 0) / measured.length) * 10) / 10
        : null;
    for (const s of shots)
      if (s.path)
        attachments.push(imageAttachment(s.path, `inspect_media frame @${s.t.toFixed(2)}s`));
    return finish({
      ...base,
      frames: shots.map((s) => ({ ...at(s.t), ...(s.error ? { error: s.error } : {}) })),
      frames_attached: attachments.length,
      coordinate_grid: GRID_NOTE,
      sharpness: mean("sharpness"),
      noise_sigma: mean("noise"),
      metadata: probe,
      _attachments: attachments,
    });
  }

  // audio
  const audioDur = dur || null;
  if (isGemini(args._model_id)) {
    // Gemini reasons over audio natively -> attach the (windowed) clip.
    const gStart = typeof args.start_seconds === "number" ? args.start_seconds : null;
    const gEnd = typeof args.end_seconds === "number" ? args.end_seconds : null;
    try {
      const clip = await clipAudioForGemini(ctx, path, gStart, gEnd);
      return finish({
        ok: true,
        kind: "audio",
        media_ref: srcRef,
        duration_s: audioDur,
        audio_attached: true,
        metadata: probe,
        _attachments: [audioAttachment(clip, `inspect_media audio ${baseName(path)}`)],
      });
    } catch (e) {
      return finish({
        ok: true,
        kind: "audio",
        media_ref: srcRef,
        audio_attached: false,
        attach_error: String(e),
        metadata: probe,
      });
    }
  }
  // gpt/text: on-device whisper transcription (no media attachment).
  return finish({
    ok: true,
    kind: "audio",
    media_ref: srcRef,
    duration_s: audioDur,
    frames_attached: 0,
    metadata: probe,
  });
}

/** The loudness a clip is heard at, beside the source's. A clip's sound is the audio clip itself,
 *  or for a video clip the audio clip placement split from it (same link group and media). A
 *  constant volume moves every figure by the same dB; a keyframed one is reported, not applied.
 *  Audio effects and track mixing are not included. */
function withClipGain(l: Loudness, timeline: Timeline | null, clip: Clip | null): Result {
  if (!timeline || !clip) return { ...l };
  let sound: Clip | null = clip.kind === "audio" ? clip : null;
  if (!sound && clip.link_group)
    for (const t of timeline.tracks ?? [])
      for (const c of t.clips ?? [])
        if (
          c.kind === "audio" &&
          c.link_group === clip.link_group &&
          c.media_ref === clip.media_ref
        )
          sound ??= c;
  if (!sound) return { ...l };
  const vol = sound.volume ?? 1;
  if (typeof vol !== "number") return { ...l, clip_volume: "keyframed" };
  const db = vol > 0 ? 20 * Math.log10(vol) : null;
  const move = (v: number | null): number | null =>
    v === null || db === null ? null : Math.round((v + db) * 10) / 10;
  return {
    ...l,
    clip_volume: vol,
    after_clip_volume:
      db === null
        ? null
        : {
            integrated_lufs: move(l.integrated_lufs),
            true_peak_dbtp: move(l.true_peak_dbtp),
            rms_dbfs: move(l.rms_dbfs),
          },
  };
}

/** What a look at the timeline covers, decided before a pixel is drawn: the frames asked for that
 *  exist, the ones that do not, or why there is nothing to look at. Pure — the eval's stand-in
 *  answers from it too, so the two cannot disagree about which frames a call means. */
export function planTimelineLook(
  raw: Timeline,
  args: Record<string, unknown>,
):
  | { ok: false; result: Result }
  | {
      ok: true;
      seconds: Timeline;
      fps: number;
      total: number;
      nums: number[];
      outOfRange: number[];
    } {
  const errors = validateTimeline(raw);
  if (errors.length)
    return {
      ok: false,
      result: {
        ok: false,
        error: "timeline preflight failed",
        preflight_errors: errors.slice(0, 20),
      },
    };
  const seconds = toSecondsView(raw);
  const duration = canvasDuration(seconds);
  if (duration <= 0)
    return { ok: false, result: { ok: false, error: "timeline is empty — add clips first" } };
  const fps = canvasFps(raw);
  const total = Math.round(duration * fps);
  const asked = timelineLookFrames(args);
  const nums = asked.filter((f) => f >= 0 && f < total);
  const outOfRange = asked.filter((f) => f < 0 || f >= total);
  if (!nums.length)
    return {
      ok: false,
      result: {
        ok: false,
        error: `every frame asked for is outside the timeline, which runs from frame 0 to ${total - 1}.`,
        out_of_range: outOfRange,
        duration_frames: total,
      },
    };
  return { ok: true, seconds, fps, total, nums, outOfRange };
}

/** inspect_timeline (client): show the model the composited timeline at the frames it asks for.
 *
 *  Each frame is its OWN one-frame render of the export's graph (buildRenderCommand's frame
 *  window): only the clips on canvas near that frame are opened, each seeked close to it, so a look
 *  costs a few frames of work wherever it lands. It used to render the timeline from frame 0 up to
 *  the deepest frame asked for, which made a look at minute 14 cost 14 minutes of encode (UJ-012).
 *  The frame is the export's frame at that instant, then fitted to 768 px with Palmier's grid and
 *  an \"f<frame>\" label drawn on. */
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
  const planned = planTimelineLook(raw, args);
  if (!planned.ok) return planned.result;
  const { seconds, fps, total, nums, outOfRange } = planned;

  // Resolve portable "library/<id>" sources to absolute paths, as the export does: ffmpeg can only
  // open a path.
  const warnings = new Set(await resolveClipSources(ctx, seconds));
  const look = resolveRenderPlan(seconds);
  // Each file is named for the timeline STATE it shows (plus the size and overlay it was drawn
  // with), never just its frame number: the conversation keeps re-sending the frames an earlier
  // round saw, so a later look at the same frame number must not overwrite one. No key (the
  // platform cannot size a file) gets a one-off name, and is rendered every time: a stale frame is
  // a wrong answer.
  const key = await previewKey(ctx, seconds);
  const state = key ?? nextCallToken();
  const canvas = canvasPx(seconds);
  const dims = fitDims(canvas.w, canvas.h, TIMELINE_FRAME_EDGE);

  const renderFrame = async (frame: number): Promise<FrameShot> => {
    const final = await ctx.store.prepareArtifact(
      `inspect/tl_${state}_${frame}_${TIMELINE_FRAME_EDGE}g${OVERLAY_REV}.jpg`,
    );
    if (key && (await ctx.store.exists(final))) return { frame, path: final };
    // Stop starts nothing new; a frame already rendering is killed through the runner's signal.
    if (ctx.signal?.aborted) return { frame, error: "cancelled" };
    // Rendered under a temporary name and renamed into place, so a parallel look at the same frame
    // never reads half a JPEG, and a frame a round has shown is never rewritten under it.
    const out = ctx.store.canRename
      ? final.replace(/\.jpg$/, `.${nextCallToken()}.tmp.jpg`)
      : final;
    const assName = `grid_f${frame}.ass`;
    const plan = buildRenderCommand(
      seconds,
      out,
      {},
      {
        frame,
        post: `${scaleTo(TIMELINE_FRAME_EDGE)},${gridFilter(assName)}`,
        postAss: [{ name: assName, content: gridAss(dims.w, dims.h, `f${frame}`) }],
        postFonts: [OVERLAY_FONT_FILE],
        outputArgs: ["-q:v", FRAME_JPEG_Q],
      },
    );
    for (const w of plan.warnings) warnings.add(w);
    const rr = await runRenderPlan(ctx, plan);
    if (rr.code !== 0 || !(await ctx.store.exists(out))) {
      // Whatever a failed run left is not a frame: never let the name of one point at it.
      if (out !== final) await ctx.store.remove(out).catch(() => undefined);
      return {
        frame,
        error: `frame ${frame} could not be rendered${ffmpegReason(rr.stderr) || " — ffmpeg wrote no image"}`,
      };
    }
    if (out !== final) {
      if (await ctx.store.exists(final)) await ctx.store.remove(out).catch(() => undefined);
      else await ctx.store.rename(out, final);
    }
    return { frame, path: final };
  };

  const shots: FrameShot[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(FRAME_LANES, nums.length) }, async () => {
      for (let i = next++; i < nums.length; i = next++) shots[i] = await renderFrame(nums[i]);
    }),
  );
  if (ctx.signal?.aborted) return { ok: false, error: "cancelled" };

  // Rebuilt in frame order: the lanes finish out of order, and the model reads these as a sequence.
  const attachments: Attachment[] = [];
  const frames = shots.map((s) => {
    const time = s.frame / fps;
    if (s.path)
      attachments.push(imageAttachment(s.path, `timeline frame ${s.frame} (${time.toFixed(2)}s)`));
    return {
      frame: s.frame,
      time_s: round3(time),
      ok: !s.error,
      visible_clips: visibleClips(look, s.frame, fps),
      ...(s.error ? { error: s.error } : {}),
    };
  });
  const failed = shots.filter((s) => s.error);
  if (failed.length === shots.length) return { ok: false, error: failed[0].error, frames };
  return {
    ok: true,
    canvas: raw.canvas,
    duration_frames: total,
    frame_numbers: nums,
    ...(outOfRange.length ? { out_of_range: outOfRange } : {}),
    coordinate_grid: GRID_NOTE,
    frames_attached: attachments.length,
    frames,
    ...(warnings.size ? { warnings: [...warnings] } : {}),
    _attachments: attachments,
  };
}

/** One sampled frame: the file it was rendered to, or why it was not. */
type FrameShot =
  | { frame: number; path: string; error?: undefined }
  | { frame: number; path?: undefined; error: string };

/** Clip ids on canvas at `frame`, top layer first: the render plan's order reversed (hidden tracks
 *  and disabled clips are not in it), each clip's span taken from the renderer's own rule. */
export function visibleClips(look: SecondsRenderPlan, frame: number, fps: number): string[] {
  const out: string[] = [];
  for (const pc of look.clips) {
    if (pc.kind === "audio") continue;
    const { first, end } = onCanvasFrames(pc, fps);
    if (frame >= first && frame < end) out.push(pc.srcClipId);
  }
  return out.reverse();
}

/** Cache key for a rendered frame: the RESOLVED timeline plus the size of every media file it
 *  reads. The timeline alone is not enough — a source can be replaced in place (a generation
 *  landing on its placeholder) without a single clip changing. Null when the platform cannot stat,
 *  and then the caller re-renders: a stale frame is a wrong answer, which is worse than a slow one. */
async function previewKey(ctx: ClientToolContext, seconds: Timeline): Promise<string | null> {
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
  return shortHash(JSON.stringify({ tl: seconds, sizes }));
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
 *  else a frame near 1s. Ports inspect_color._raw_frame. `ref` is always a model-typed argument,
 *  so it resolves through the narrow resolver: a raw path or `..` escape reads nothing. */
async function rawFrame(
  ctx: ClientToolContext,
  ref: string,
  tag: string,
  call: string,
): Promise<string | null> {
  const p = await ctx.store.resolveMediaRef(ref);
  if (!p) return null;
  const dot = p.lastIndexOf(".");
  if (IMAGE_EXT.has(dot >= 0 ? p.slice(dot).toLowerCase() : "")) {
    // The still itself, as its whole decoded picture when it is a HEIF-family file.
    const picture = await stillPicture(ctx.store, ctx.runner, p, ctx.signal);
    return "path" in picture ? picture.path : null;
  }
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
    scaleTo(COLOR_FRAME_EDGE),
    "-frames:v",
    "1",
    out,
  ]);
  return r.code === 0 && (await ctx.store.exists(out)) ? out : null;
}

/** Render ONE frame of ONE clip with its grade applied (no other layers), at its midpoint or
 *  `atFrame`, as a PNG fitted to 1024 px. It used to render the whole clip at deliverable quality
 *  and pull one frame out of it: 44 s median in production to look at a single frame (UJ-012). The
 *  frame window renders just that frame with the export's own graph. Ports
 *  inspect_color._render_graded_clip. */
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
  const tIn = typeof clip.timeline_in === "number" ? clip.timeline_in : 0;
  const tOut = typeof clip.timeline_out === "number" ? clip.timeline_out : 1;
  const dur = Math.max(1, tOut - tIn);
  const mid = atFrame === null ? tIn + Math.floor(dur / 2) : atFrame;
  const rel = Math.min(Math.max(0, mid - tIn), dur - 1);
  const oneClip: Clip = { ...clip, timeline_in: 0, timeline_out: dur };
  delete (oneClip as Record<string, unknown>).id;
  delete (oneClip as Record<string, unknown>).link_group;
  const one: Timeline = {
    units: "frames",
    canvas: raw.canvas,
    tracks: [{ id: "g", kind: "video", z: 0, clips: [oneClip] }],
    failures: [],
  };
  const seconds = toSecondsView(one);
  // ffmpeg cannot open a library ref, only a path. Every other render path resolves first; this
  // one did not, so measuring a CLIP always failed while a media_ref worked.
  await resolveClipSources(ctx, seconds);
  const png = await ctx.store.prepareArtifact(`inspect/color_clip_${call}.png`);
  const plan = buildRenderCommand(
    seconds,
    png,
    {},
    {
      frame: rel,
      post: scaleTo(COLOR_FRAME_EDGE),
    },
  );
  const rr = await runRenderPlan(ctx, plan);
  if (rr.code !== 0 || !(await ctx.store.exists(png)))
    return { error: `rendering frame ${mid} of the clip failed${ffmpegReason(rr.stderr)}` };
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
      `could not sample a frame from '${mediaRef}'. Pass a library id/filename (import_media a local file first) or a clip_id.`,
    );

  const scopes = await measureColorFrame(ctx, frame);
  if (!scopes) return { ok: false, error: "failed to measure color scopes (frame decode failed)" };
  const attachments: Attachment[] = [imageAttachment(frame, `inspect_color ${subject} scopes`)];
  const res: Result = { ok: true, subject, scopes, frame_attached: 1 };

  if (reference) {
    const rf = await rawFrame(ctx, reference, "ref", call);
    const refScopes = rf ? await measureColorFrame(ctx, rf) : null;
    if (rf && refScopes) {
      attachments.push(imageAttachment(rf, "inspect_color reference"));
      res.reference_scopes = refScopes;
      res.gap = colorGapHints(scopes, refScopes);
    } else {
      // Said, not dropped: without it the model reads "no gap" as "no difference".
      res.reference_error = rf
        ? `could not measure the reference '${reference}' (frame decode failed)`
        : await unresolvedRefMessage(
            ctx.store,
            reference,
            `reference '${reference}' is not a library asset — import_media it first and pass its media_ref`,
          );
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
