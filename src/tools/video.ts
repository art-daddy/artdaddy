// Video-understanding tools (client): resolve + pre-encode the clip locally
// (downscale / fps-sample / strip audio via ffmpeg), then make the ONE hosted
// video-understanding call via the thin server proxy (/ai/vision_video). The
// compact clip bytes cross the wire; the model credential stays server-side.
// Ported from the server's research.py video tools (now client-side).
import { callAiProxy, toB64 } from "../api/ai";
import type { ClientToolContext } from "./context";
import { encodeVideoForGemini } from "./geminiEncode";
import { probePath } from "./media";
import { unresolvedRefMessage } from "./refState";
import type { ClientToolRegistry } from "./registry";
import { MAX_HEAP_READ_BYTES } from "./store";
import { loadTimeline } from "../timeline/engine";
import { canvasFps } from "../timeline/frames";
import { clipSpanToFrames, findClip } from "../timeline/helpers";
import type { Clip } from "../timeline/model";

type Result = Record<string, unknown>;
const NOT_READY: Result = { ok: false, error: "client tool runtime not ready" };

// ── timestamp parsing (ports research.py _TS_RE / _mmss_to_seconds / _extract_timestamps) ──
const TS_RE =
  /(?<![\d.])(?:(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)|(\d{1,3}):(\d{2}(?:\.\d+)?))(?!\d)/g;

function mmssToSeconds(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const s = text.trim();
  if (!s) return null;
  const parts = s.split(":");
  if (parts.length === 2) {
    const m = parseInt(parts[0], 10);
    const sec = parseFloat(parts[1]);
    return Number.isNaN(m) || Number.isNaN(sec) ? null : m * 60 + sec;
  }
  if (parts.length === 3) {
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const sec = parseFloat(parts[2]);
    return Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(sec) ? null : h * 3600 + m * 60 + sec;
  }
  return null;
}

function extractTimestamps(text: string): { text: string; seconds: number }[] {
  const out: { text: string; seconds: number }[] = [];
  for (const m of (text ?? "").matchAll(TS_RE)) {
    const sec = mmssToSeconds(m[0]);
    if (sec === null) continue;
    out.push({ text: m[0], seconds: Math.round(sec * 1000) / 1000 });
  }
  return out;
}

const YOUTUBE_RE = /(?:youtube\.com|youtu\.be)/i;
function isUrl(s: string): boolean {
  return YOUTUBE_RE.test(s) || /^https?:\/\//i.test(s);
}

/** Resolve media_ref and/or clip_id to a source path (mirrors the video tools'
 *  companion logic + inspect_media's clip resolution). */
async function resolveVideoSource(
  ctx: ClientToolContext,
  mediaRef: string,
  clipId: string,
): Promise<{ path?: string; ref?: string; clip?: Clip; fps?: number; error?: string }> {
  let ref = mediaRef;
  let clip: Clip | undefined;
  let fps: number | undefined;
  // A clip-derived source may legitimately be an EXTERNAL (out-of-project absolute) ref; an
  // agent-supplied `media_ref` may NOT. Track the origin so the final resolve picks the right
  // resolver (trusted clip -> resolveRef, untrusted agent arg -> resolveMediaRef).
  let fromClip = false;
  if (clipId) {
    let timeline;
    try {
      timeline = await loadTimeline(ctx.store);
    } catch (e) {
      return { error: `clip_id given but the timeline could not be read: ${String(e)}` };
    }
    const found = findClip(timeline, clipId);
    if (!found)
      return { error: `clip not found on the timeline (or it has no source media): ${clipId}` };
    clip = found[1];
    fps = canvasFps(timeline);
    const clipSource = String(clip.media_ref ?? "").trim();
    if (!clipSource) return { error: `clip ${clipId} has no source media (e.g. a text clip).` };
    if (mediaRef) {
      const [a, b] = await Promise.all([
        ctx.store.resolveRef(clipSource),
        ctx.store.resolveRef(mediaRef),
      ]);
      if (a && b && a !== b) {
        return {
          error: `clip_id ${clipId} references ${clipSource}, which does not match media_ref ${mediaRef}.`,
        };
      }
    }
    ref = clipSource;
    fromClip = true;
  }
  if (!ref)
    return { error: "provide media_ref (a library asset) or clip_id (a placed timeline clip)." };
  // Agent-supplied media_ref goes through the NARROW resolver (rejects a raw absolute path / `..`
  // escape) so a read tool can't be turned into an arbitrary-file reader + exfil-to-model; a
  // clip-derived source is trusted (an EXTERNAL clip legitimately carries an absolute ref).
  const path = fromClip ? await ctx.store.resolveRef(ref) : await ctx.store.resolveMediaRef(ref);
  if (!path) {
    return {
      error: await unresolvedRefMessage(
        ctx.store,
        ref,
        `local file not found: ${ref}. Pass a library asset id (media_...), a library filename, or a project-relative path. To probe a URL, call \`download_video\` first, then pass the local path it returns.`,
      ),
    };
  }
  return { path, ref, clip, fps };
}

// ── video_ask (research.py::video_ask) ──
const VIDEO_ASK_MAX_DURATION_S = 1800;
const VIDEO_ASK_FIXED_FPS = 4;
const TIMESTAMP_RULE =
  "\n\n---\n" +
  "TIMESTAMP FORMAT \u2014 STRICT: whenever you cite a moment in the video, " +
  "write it as MM:SS.sss with THREE decimal digits of seconds (millisecond " +
  "precision). Valid examples: '00:03.480', '01:24.567', '12:08.012'. For " +
  "values >= 1 hour use H:MM:SS.sss (e.g. '1:02:04.250'). DO NOT write bare " +
  "'MM:SS' (e.g. '01:24'), single-digit fractions ('01:24.5'), or vague " +
  "phrases like 'around 1:24'. DO NOT round to quarter-seconds out of habit " +
  "\u2014 if the moment is at 01:24.567, write 01:24.567, not 01:24.500.";
const VISUAL_ONLY_SUFFIX =
  "\n\n---\n" +
  "VISUAL-ONLY MODE \u2014 STRICT:\n" +
  "Base your answer ONLY on what is visually rendered into the video frame " +
  "(pixels you can actually see). IGNORE the audio track entirely: do not " +
  "consider spoken narration, voice-over, music, sound effects, or any " +
  "closed-caption / subtitle text that originates from the audio track (CC, " +
  "auto-generated captions, transcript overlays added by the player). These " +
  "are NOT on-screen text \u2014 they are audio metadata and must be disregarded.\n" +
  'Only count text as "on-screen" if it is burned into the video pixels ' +
  "themselves (lower-thirds, title cards, watermarks, logos, broadcast " +
  "banners, mission patches, hard-coded subtitles that appear as part of the " +
  "picture regardless of player settings).";

async function videoAsk(
  ctx: ClientToolContext | null,
  args: Record<string, unknown>,
): Promise<Result> {
  if (!ctx) return NOT_READY;
  const prompt = String(args.prompt ?? "");
  const mediaRefArg = String(args.media_ref ?? "");
  const clipId = args.clip_id != null ? String(args.clip_id) : "";
  const startSeconds = args.start_seconds != null ? Number(args.start_seconds) : null;
  const endSeconds = args.end_seconds != null ? Number(args.end_seconds) : null;
  const visualOnly = args.visual_only !== false;
  const reasoningMode = String(args.reasoning_mode ?? "off");

  if (mediaRefArg && isUrl(mediaRefArg)) {
    return {
      ok: false,
      error: `video_ask now accepts LOCAL FILE PATHS ONLY. Got URL: ${mediaRefArg.slice(0, 120)}. Call \`download_video(url, output_name, ...)\` first, then pass the local path returned by that tool.`,
    };
  }

  const resolved = await resolveVideoSource(ctx, mediaRefArg, clipId);
  if (resolved.error || !resolved.path) return { ok: false, error: resolved.error ?? "unresolved" };
  const localPath = resolved.path;

  let duration: number | null = null;
  try {
    const p = await probePath(ctx.runner, localPath);
    duration = typeof p.duration_s === "number" ? p.duration_s : null;
  } catch {
    duration = null;
  }

  let winStart: number | null = null;
  let winEnd: number | null = null;
  if (startSeconds !== null || endSeconds !== null) {
    winStart = startSeconds !== null ? Math.max(0, startSeconds) : 0;
    winEnd = endSeconds !== null ? endSeconds : duration;
    if (winEnd !== null && duration !== null) winEnd = Math.min(winEnd, duration);
    if (winEnd !== null && winEnd <= winStart) {
      return {
        ok: false,
        error: `invalid window: end_seconds must be greater than start_seconds (got start=${winStart}, end=${winEnd}).`,
      };
    }
  }
  const analyzedS = winStart !== null && winEnd !== null ? winEnd - winStart : duration;
  if (analyzedS && analyzedS > VIDEO_ASK_MAX_DURATION_S) {
    return {
      ok: false,
      error: `too long for video_ask (${analyzedS.toFixed(0)}s = ${(analyzedS / 60).toFixed(1)} min, cap ${VIDEO_ASK_MAX_DURATION_S}s = 30 min). Pass a shorter start_seconds/end_seconds window.`,
      video_duration_s: duration,
    };
  }

  let finalPrompt = prompt + TIMESTAMP_RULE;
  if (visualOnly) finalPrompt += VISUAL_ONLY_SUFFIX;

  let encoded: string;
  try {
    encoded = await encodeVideoForGemini(ctx, localPath, {
      fps: VIDEO_ASK_FIXED_FPS,
      maxDim: 720,
      keepAudio: false,
      start: winStart ?? undefined,
      end: winEnd ?? undefined,
      tag: "gemini",
      ...(analyzedS ? { budget: { maxBytes: MAX_HEAP_READ_BYTES, durationS: analyzedS } } : {}),
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  let text = "";
  try {
    const bytes = await ctx.store.readBytes(encoded);
    const dto = await callAiProxy<{ text?: string; ok?: boolean; error?: string }>(
      "vision_video",
      {
        args: {
          prompt: finalPrompt,
          fps: VIDEO_ASK_FIXED_FPS,
          reasoning_mode: reasoningMode,
          tool_name: "video_ask",
          video: "video",
          max_output_tokens: 2000,
        },
        media: { video: { b64: toB64(bytes), ext: ".mp4" } },
      },
      ctx.signal,
      // Idempotent read: a 5xx / provider timeout is worth one re-fire.
      { transientRetries: 1 },
    );
    const r = dto.result ?? {};
    if (r.ok === false) return { ok: false, error: String(r.error ?? "video model failed") };
    text = String(r.text ?? "");
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const askClip = resolved.clip;
  const askFps = resolved.fps ?? 30;
  const rawTimestamps = extractTimestamps(text);
  // Placed clip -> report the structured times in PROJECT FRAMES (edit-ready),
  // dropping any that fall outside the clip's visible span. media_ref -> seconds.
  const timestampsFound = askClip
    ? rawTimestamps
        .map((t): { text: string; frame: number } | null => {
          const f = clipSpanToFrames(askClip, t.seconds, t.seconds, askFps);
          return f ? { text: t.text, frame: f[0] } : null;
        })
        .filter((x): x is { text: string; frame: number } => x !== null)
    : rawTimestamps;
  return {
    ok: true,
    response: text,
    timing: askClip ? "project_frames" : "source_seconds",
    timestamps_found: timestampsFound,
    video_duration_s: duration,
    window_s: winStart !== null ? [winStart, winEnd] : null,
  };
}

// ── video_find_moment (research.py::video_find_moment) ──
// Prose-Markdown parser ported verbatim: line-anchored `^` -> `(?:^|\n)`,
// Python `\Z` -> JS `$` (no `m` flag = end-of-string), `re.DOTALL` -> `[\s\S]`.
const VFM_FIXED_FPS = 1;
const VFM_MAX_DURATION_S = 1800;
const VFM_TS = String.raw`\d{1,2}:\d{2}(?:\.\d{1,3})?`;
const VFM_SEP = String.raw`[\u2013\-\u2012\u2014to]`;
const VFM_SHOT_HEADER = /(?:^|\n)\s*\*?\*?\s*Shot\s+(\d+)\b\*?\*?/i;
const VFM_TIMESTAMP_LINE = new RegExp(
  String.raw`(?:^|\n)\s*\*?\s*\*?\*?\s*Timestamp:?\s*\*?\*?\s*(${VFM_TS})\s*${VFM_SEP}\s*(${VFM_TS})`,
  "i",
);
const VFM_FIELD_WHAT =
  /(?:^|\n)\s*\*?\s*\*?\*?\s*What is in frame:?\s*\*?\*?\s*([\s\S]+?)(?=\n\s*\*|$)/i;
const VFM_FIELD_TEXT =
  /(?:^|\n)\s*\*?\s*\*?\*?\s*On-screen text:?\s*\*?\*?\s*([\s\S]+?)(?=\n\s*\*|$)/i;
const VFM_FIELD_TONE =
  /(?:^|\n)\s*\*?\s*\*?\*?\s*Tone\/?(?:mood)?:?\s*\*?\*?\s*([\s\S]+?)(?=\n\s*\*|$)/i;
const VFM_WHY_LINE =
  /(?:^|\n)\s*\*?\*?\s*Why:?\s*\*?\*?\s*([\s\S]+?)(?=\n\s*\*?\*?\s*Shot|\n\s*##|$)/i;
const VFM_MOMENT_SPLIT = /(?:^|\n)\s*#+\s*Moment\s+\d+\s+/i;
const VFM_RANGE = new RegExp(String.raw`^\s*(${VFM_TS})\s*${VFM_SEP}\s*(${VFM_TS})`);

function secondsToMmss(v: number): string {
  const mm = Math.floor(v / 60);
  const ss = v - mm * 60;
  return `${String(mm).padStart(2, "0")}:${ss.toFixed(3).padStart(6, "0")}`;
}

interface VfmShot {
  in_s: number;
  out_s: number;
  description: string;
}
interface VfmMoment {
  start_s: number;
  end_s: number;
  peak_s: number;
  why: string;
  shots: VfmShot[];
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Parse the 'Shot N' blocks (mirrors _parse_prose_shots_block). */
function parseProseShots(text: string, winStart: number, winEnd: number): VfmShot[] {
  if (!text) return [];
  const parts = text.split(VFM_SHOT_HEADER);
  if (parts.length < 3) return [];
  const edgeTol = 1.0;
  const overlapTol = 0.25;
  const out: VfmShot[] = [];
  let prevOut: number | null = null;
  for (let i = 1; i < parts.length - 1; i += 2) {
    const body = parts[i + 1] ?? "";
    const ts = VFM_TIMESTAMP_LINE.exec(body);
    if (!ts) continue;
    let inS = mmssToSeconds(ts[1]);
    let outS = mmssToSeconds(ts[2]);
    if (inS === null || outS === null || outS <= inS) continue;
    if (Math.abs(inS - winStart) <= edgeTol) inS = winStart;
    if (Math.abs(outS - winEnd) <= edgeTol) outS = winEnd;
    if (inS < winStart - edgeTol || outS > winEnd + edgeTol) continue;
    if (prevOut !== null && inS < prevOut - overlapTol) continue;
    const whatM = VFM_FIELD_WHAT.exec(body);
    const what = whatM ? whatM[1].trim() : "";
    const textM = VFM_FIELD_TEXT.exec(body);
    const textField = textM ? textM[1].trim() : "";
    const toneM = VFM_FIELD_TONE.exec(body);
    const tone = toneM ? toneM[1].trim() : "";
    const descParts: string[] = [];
    if (what) descParts.push(what.slice(0, 300));
    if (textField && !["none", "n/a", ""].includes(textField.toLowerCase()))
      descParts.push(`on-screen: ${textField.slice(0, 120)}`);
    if (tone) descParts.push(`tone: ${tone.slice(0, 60)}`);
    out.push({
      in_s: round3(Math.max(winStart, inS)),
      out_s: round3(Math.min(winEnd, outS)),
      description: descParts.length ? descParts.join(" | ") : "",
    });
    prevOut = outS;
  }
  return out;
}

/** Parse the single '## Moment 1' block + Why + Shot list (mirrors _parse_prose_moments). */
function parseProseMoments(text: string, duration: number | null): VfmMoment[] {
  if (!text) return [];
  const parts = text.split(VFM_MOMENT_SPLIT);
  if (parts.length < 2) return [];
  for (let idx = 1; idx < parts.length; idx += 1) {
    const part = parts[idx];
    const m = VFM_RANGE.exec(part);
    if (!m) continue;
    const s = mmssToSeconds(m[1]);
    const e = mmssToSeconds(m[2]);
    if (s === null || e === null || e <= s) continue;
    if (duration && duration > 0 && (s < 0 || e > duration + 0.5)) continue;
    const whyM = VFM_WHY_LINE.exec(part);
    const why = whyM ? whyM[1].trim().slice(0, 300) : "";
    return [
      {
        start_s: round3(s),
        end_s: round3(e),
        peak_s: round3((s + e) / 2),
        why,
        shots: parseProseShots(part, s, e),
      },
    ];
  }
  return [];
}

function buildVfmPrompt(query: string, duration: number | null, visualOnly: boolean): string {
  const boundsLine =
    duration && duration > 0
      ? `\nThe video is exactly ${duration.toFixed(2)} seconds long (=${secondsToMmss(duration)} in MM:SS). All timestamps MUST be within [00:00, ${secondsToMmss(duration)}].\n`
      : "";
  const visualBlock = visualOnly
    ? "\nVISUAL-ONLY MODE \u2014 STRICT: Judge by pixels only. IGNORE the audio track entirely (narration, music, sound effects, CC). Only count text as 'on-screen' when it is BURNED into the picture pixels (lower-thirds, title cards, watermarks, broadcast banners).\n"
    : "";
  return (
    "Find the SINGLE BEST contiguous moment in this video matching the editor's intent, then DESCRIBE SHOT-BY-SHOT what is VISUALLY inside the moment's window.\n\n" +
    `INTENT: ${query}\n` +
    boundsLine +
    visualBlock +
    "\nRANKING CRITERIA:\n" +
    "- Rank by EDITORIAL QUALITY, not chronological order. The best moment may be the 3rd occurrence in the video, not the 1st. Do not default to the 'first contiguous match'.\n" +
    "- Prefer a window that is visually clear, well-composed, free of broadcast graphics or distracting overlays, with enough continuous content (\u22652s) to hold on a timeline.\n" +
    "- The moment is a contiguous window where the target is clearly visible.\n" +
    "\nUse this EXACT Markdown format:\n\n" +
    "## Moment 1  MM:SS.sss \u2013 MM:SS.sss\n" +
    "**Why:** <one sentence \u2014 reason this matches the intent>\n\n" +
    "Describe shot-by-shot what is VISUALLY in this moment's window. The window starts at the moment's start timestamp and ends at the moment's end timestamp (timestamps INSIDE the source file). For each distinct sub-shot, emit a block:\n\n" +
    "**Shot 1**\n" +
    "*   **Timestamp:** MM:SS.sss \u2013 MM:SS.sss\n" +
    "*   **What is in frame:** <subject, motion, framing, location \u2014 do NOT paraphrase editorial intent; describe only what is rendered into the pixels>\n" +
    "*   **On-screen text:** <burned-in text or 'none'>\n" +
    "*   **Tone/mood:** <2-3 words, e.g. 'somber crisis', 'hopeful launch', 'static technical', 'high-energy ascent'>\n\n" +
    "**Shot 2**\n" +
    "*   **Timestamp:** ...\n\n" +
    "SHOT TIMESTAMP RULES \u2014 STRICT:\n" +
    "- Shots are STRICTLY CHRONOLOGICAL \u2014 shot N+1 must start AFTER shot N.\n" +
    "- The first shot's `in` equals the moment's `start`.\n" +
    "- The last shot's `out` equals the moment's `end`.\n" +
    "- Adjacent shots are back-to-back: shot N+1's `in` equals shot N's `out`. NO gaps. NO overlaps. NO concentric ranges.\n" +
    "- Emit a NEW shot for EVERY camera change, angle change, or scene cut. Do NOT lump multiple visually distinct shots into one block.\n" +
    "- TIMESTAMP FORMAT \u2014 STRICT: MM:SS.sss with THREE decimal digits of seconds (millisecond precision). For values \u2265 1 hour use H:MM:SS.sss.\n" +
    "\nBegin with '## Moment 1' immediately. Output ONLY the single moment block. No preamble."
  );
}

async function videoFindMoment(
  ctx: ClientToolContext | null,
  args: Record<string, unknown>,
): Promise<Result> {
  if (!ctx) return NOT_READY;
  const query = String(args.query ?? "");
  const mediaRefArg = String(args.media_ref ?? "");
  const clipId = args.clip_id != null ? String(args.clip_id) : "";
  const visualOnly = args.visual_only !== false;
  const reasoningMode = String(args.reasoning_mode ?? "off");

  // Local-only (the safe production default; the server's URL mode is an env flag
  // that also flips the tool description, so a URL never reaches a local-mode client).
  if (mediaRefArg && isUrl(mediaRefArg)) {
    return {
      ok: false,
      error: `video_find_moment accepts LOCAL FILE PATHS ONLY. Got URL: ${mediaRefArg.slice(0, 120)}. Call \`download_video(url, output_name, ...)\` first, then pass the local path returned by that tool.`,
    };
  }

  const resolved = await resolveVideoSource(ctx, mediaRefArg, clipId);
  if (resolved.error || !resolved.path) return { ok: false, error: resolved.error ?? "unresolved" };
  const localPath = resolved.path;

  let duration: number | null = null;
  try {
    const p = await probePath(ctx.runner, localPath);
    duration = typeof p.duration_s === "number" ? p.duration_s : null;
  } catch {
    duration = null;
  }
  if (duration && duration > VFM_MAX_DURATION_S) {
    return {
      ok: false,
      error: `video too long for video_find_moment (${duration.toFixed(0)}s = ${(duration / 60).toFixed(1)} min, cap ${VFM_MAX_DURATION_S}s = 30 min).`,
      video_duration_s: duration,
    };
  }

  const prompt = buildVfmPrompt(query, duration, visualOnly);

  let encoded: string;
  try {
    encoded = await encodeVideoForGemini(ctx, localPath, {
      fps: 4,
      maxDim: 720,
      keepAudio: false,
      tag: "gemini",
      ...(duration ? { budget: { maxBytes: MAX_HEAP_READ_BYTES, durationS: duration } } : {}),
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  let text = "";
  try {
    const bytes = await ctx.store.readBytes(encoded);
    const dto = await callAiProxy<{ text?: string; ok?: boolean; error?: string }>(
      "vision_video",
      {
        args: {
          prompt,
          fps: VFM_FIXED_FPS,
          reasoning_mode: reasoningMode,
          tool_name: "video_find_moment",
          video: "video",
          max_output_tokens: 2000,
        },
        media: { video: { b64: toB64(bytes), ext: ".mp4" } },
      },
      ctx.signal,
      // Idempotent read: a 5xx / provider timeout is worth one re-fire.
      { transientRetries: 1 },
    );
    const r = dto.result ?? {};
    if (r.ok === false) return { ok: false, error: String(r.error ?? "video model failed") };
    text = String(r.text ?? "");
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const moments = parseProseMoments(text, duration);
  const fmClip = resolved.clip;
  const fmFps = resolved.fps ?? 30;
  if (fmClip) {
    // Placed clip -> PROJECT FRAMES (edit-ready); drop moments/shots outside its span.
    const framed = moments
      .map((m): Record<string, unknown> | null => {
        const span = clipSpanToFrames(fmClip, m.start_s, m.end_s, fmFps);
        if (!span) return null;
        const peak = clipSpanToFrames(fmClip, m.peak_s, m.peak_s, fmFps);
        const shots = m.shots
          .map((s) => {
            const sf = clipSpanToFrames(fmClip, s.in_s, s.out_s, fmFps);
            return sf ? { in_frame: sf[0], out_frame: sf[1], description: s.description } : null;
          })
          .filter(
            (x): x is { in_frame: number; out_frame: number; description: string } => x !== null,
          );
        return {
          start_frame: span[0],
          end_frame: span[1],
          peak_frame: peak ? peak[0] : Math.round((span[0] + span[1]) / 2),
          why: m.why,
          shots,
        };
      })
      .filter((x): x is Record<string, unknown> => x !== null);
    return {
      ok: true,
      timing: "project_frames",
      moments: framed,
      video_duration_s: duration,
      raw_text: text && framed.length === 0 ? text.slice(0, 1500) : null,
    };
  }
  return {
    ok: true,
    timing: "source_seconds",
    moments,
    video_duration_s: duration,
    raw_text: text && moments.length === 0 ? text.slice(0, 1500) : null,
  };
}

export function registerVideoTools(
  registry: ClientToolRegistry,
  getCtx: () => ClientToolContext | null,
): void {
  registry.register("video_ask", (args) => videoAsk(getCtx(), args));
  registry.register("video_find_moment", (args) => videoFindMoment(getCtx(), args));
}
