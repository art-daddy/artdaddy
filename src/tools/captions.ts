// add_captions: spoken audio -> caption clips, in one call.
//
// The model's job here is to ask for captions, not to compute them. Transcription, phrase
// chunking, frame mapping, gap closing and placement are all deterministic, so they live in
// code: asking a model to emit 200 timed runs by hand is slow, expensive, and wrong in ways
// nobody notices until export.
//
// Transcription is LOCAL (bundled whisper.cpp) and cached per media ref, so a second call on
// the same footage costs nothing.
import {
  chunkWords,
  fitSpans,
  applyCase,
  type CaptionSpan,
  type CaptionWord,
} from "../timeline/captionChunk";
import { parseSubtitles, subtitleFormat, type SubtitleCue } from "../timeline/subtitleParse";
import { ctxApplyOp, loadTimeline } from "../timeline/engine";
import { canvasFps, newId } from "../timeline/frames";
import { clipSpanToFrames, resolveCaptionTrack } from "../timeline/helpers";
import type { Clip, Timeline } from "../timeline/model";
import type { ClientToolContext } from "./context";
import type { ClientToolRegistry } from "./registry";
import { ensureTranscript } from "./transcribe";

type Args = Record<string, unknown>;
type Result = Record<string, unknown>;
const NOT_READY: Result = { ok: false, error: "client tool runtime not ready" };

/** Holding a caption across a breath reads better than blinking off and on; 0.5s is the
 *  gap below which the silence is a pause rather than a change of subject. */
const DEFAULT_MAX_GAP_SECONDS = 0.5;

/** Where a caption sits when nobody says otherwise: centred, low in the frame.
 *
 *  Text renders dead-centre by default, which is right for a TITLE and wrong for a caption —
 *  "add a title, then caption it" stacked the two on top of each other, unreadable. Matches
 *  established desktop NLEs's `AppTheme.Caption.defaultCenter`. Written onto each caption as a real
 *  transform rather than applied at render time, so it is visible in get_timeline, draggable in
 *  the editor, and captions already in someone's project keep the position they were made with. */
export const CAPTION_DEFAULT_POSITION = { x: 0.5, y: 0.9 } as const;

/** The caller's transform wins per-field, so `{position:{x:0.2}}` only moves it sideways. */
function captionTransform(raw: unknown): Record<string, unknown> {
  const t = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Args) : {};
  const pos = t.position && typeof t.position === "object" ? (t.position as Args) : {};
  return {
    ...t,
    position: { ...CAPTION_DEFAULT_POSITION, ...pos },
  };
}

interface CaptionRun {
  text: string;
  /** Seconds relative to the card's start. */
  t_in: number;
  t_out: number;
  /** The card's hero word. `assCaption` gives it the `animation.emphasis` treatment. */
  emphasis?: boolean;
}

const HERO_MODES = ["none", "longest", "first", "last"];

/** Flag ONE run per card as the hero, so `animation.emphasis` has a target.
 *  Without this the emphasis spec has nothing to mark and every word renders in the base
 *  colour — which is why "one key word in yellow" was unbuildable even after cards became
 *  per-word runs. `longest` picks the longest alphanumeric word, a decent stand-in for the
 *  stressed one; ties keep the earliest so the choice is stable. */
function markHero(runs: CaptionRun[], mode: string): void {
  if (mode === "none" || runs.length === 0) return;
  let idx = 0;
  if (mode === "last") {
    idx = runs.length - 1;
  } else if (mode === "longest") {
    const weight = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "").length;
    let best = -1;
    runs.forEach((r, i) => {
      const w = weight(r.text);
      if (w > best) {
        best = w;
        idx = i;
      }
    });
  }
  runs[idx].emphasis = true;
}

interface Cue {
  span: CaptionSpan;
  text: string; /** The card's words, when the source had per-word timing. Empty for a subtitle file, which
   *  gives a cue's text but no word boundaries. */
  words?: CaptionRun[];
}

/** Every audio clip that could carry speech, grouped by the track it sits on. A video clip's
 *  audio is split to a linked audio clip at placement, so audio tracks are the whole story. */
function audioClipsByTrack(timeline: Timeline): Map<string, Clip[]> {
  const byTrack = new Map<string, Clip[]>();
  for (const t of timeline.tracks ?? []) {
    if (t.kind !== "audio") continue;
    const clips = (t.clips ?? []).filter((c) => typeof c.media_ref === "string" && c.media_ref);
    if (clips.length)
      byTrack.set(
        t.id,
        clips.slice().sort((a, b) => num(a.timeline_in) - num(b.timeline_in)),
      );
  }
  return byTrack;
}

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

export async function addCaptionsTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return NOT_READY;

  let timeline: Timeline;
  try {
    timeline = await loadTimeline(ctx.store);
  } catch (e) {
    return { ok: false, error: `could not read timeline.json: ${String(e)}` };
  }
  const fps = canvasFps(timeline);

  if (args.subtitle_media_ref !== undefined) {
    // Mutually exclusive with everything: the file's own text and timing ARE the answer, so a
    // chunking cap or a language would silently do nothing.
    const extra = Object.keys(args).filter(
      (k) => k !== "subtitle_media_ref" && k !== "text_track_id",
    );
    if (extra.length) {
      return {
        ok: false,
        error: `subtitle_media_ref uses the file's text and timing as-is; drop ${extra.sort().join(", ")}`,
      };
    }
    return placeSubtitleCues(String(args.subtitle_media_ref), args, ctx, fps);
  }

  const byTrack = audioClipsByTrack(timeline);
  if (!byTrack.size) return { ok: false, error: "no audio on the timeline to caption" };

  const wantTrack = String(args.track_id ?? "").trim();
  if (wantTrack && !byTrack.has(wantTrack)) {
    return {
      ok: false,
      error: `track '${wantTrack}' has no audio clips; omit track_id to caption the track with the most speech`,
    };
  }

  const language = args.language === undefined ? undefined : String(args.language);
  const maxWords = numOrUndef(args.max_words);
  const maxCharacters = numOrUndef(args.max_characters);
  const maxGapSeconds =
    args.max_gap_seconds === undefined ? DEFAULT_MAX_GAP_SECONDS : Number(args.max_gap_seconds);
  if (!Number.isFinite(maxGapSeconds) || maxGapSeconds < 0 || maxGapSeconds > 2) {
    return { ok: false, error: "max_gap_seconds must be a number from 0 through 2" };
  }
  const textCase = args.case === undefined ? undefined : String(args.case);
  const hero = args.hero === undefined ? "none" : String(args.hero);
  if (!HERO_MODES.includes(hero)) {
    return { ok: false, error: `hero must be one of ${HERO_MODES.join(" | ")}` };
  }

  // Transcribe each candidate track. Auto-pick reads every track because "the track with the
  // most speech" cannot be known before transcribing — but each result is cached, so the cost
  // is paid once per source, not once per call.
  const candidates = wantTrack ? [wantTrack] : [...byTrack.keys()];
  const cuesByTrack = new Map<string, Cue[]>();
  const failures: Array<{ clip_id: string; error: string }> = [];
  for (const trackId of candidates) {
    const cues: Cue[] = [];
    for (const clip of byTrack.get(trackId) ?? []) {
      let words: Array<{ word: string; start_seconds: number; end_seconds: number }>;
      try {
        words = (
          await ensureTranscript(ctx, String(clip.media_ref), undefined, undefined, language)
        ).parsed.words;
      } catch (e) {
        // One unreadable source must not sink the rest, but it must not read as silence either.
        failures.push({ clip_id: String(clip.id), error: String(e).slice(-200) });
        continue;
      }
      const timed: CaptionWord[] = words
        .filter((w) => Number.isFinite(w.start_seconds) && Number.isFinite(w.end_seconds))
        .map((w) => ({ text: w.word.trim(), start: w.start_seconds, end: w.end_seconds }))
        .filter((w) => w.text.length > 0);
      for (const phrase of chunkWords(timed, { maxWords, maxCharacters })) {
        // clipSpanToFrames owns source-seconds -> project-frames (trim + speed + position)
        // and drops anything outside the clip's visible span.
        const span = clipSpanToFrames(clip, phrase.start, phrase.end, fps);
        if (!span) continue;
        // Carry the WORDS, not just the joined string. Collapsing a card to one run is why
        // `word-by-word`, `word-highlight` and `karaoke` rendered statically: those builds animate
        // per chunk, and a card with one chunk has nothing to animate. It is also why there was
        // nothing for `animation.emphasis` to mark — a hero is a RUN, and there was only ever one.
        // Times are seconds RELATIVE to the card, which is what the render plan reads.
        const cardSec = (span[0] - 0) / fps;
        const words = phrase.words.map((w) => {
          const ws = clipSpanToFrames(clip, w.start, w.end, fps);
          return {
            text: applyCase(w.text, textCase),
            t_in: ws ? ws[0] / fps - cardSec : 0,
            t_out: ws ? ws[1] / fps - cardSec : 0,
          };
        });
        markHero(words, hero);
        cues.push({
          span: { in: span[0], out: span[1] },
          text: applyCase(phrase.text, textCase),
          words,
        });
      }
    }
    if (cues.length) cuesByTrack.set(trackId, cues);
  }

  if (!cuesByTrack.size) {
    if (failures.length) {
      return {
        ok: false,
        error: `transcription failed for all ${failures.length} audio clip(s) — a tool failure, NOT an absence of speech: ${failures[0].error}`,
        failed: failures,
      };
    }
    return { ok: false, error: "no speech detected to caption" };
  }

  // Most speech wins: a music bed shouldn't beat the dialogue track just by being longer.
  const chosen = [...cuesByTrack.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  const [sourceTrack, rawCues] = chosen;
  rawCues.sort((a, b) => a.span.in - b.span.in);

  const limit = Math.max(...(byTrack.get(sourceTrack) ?? []).map((c) => num(c.timeline_out)));
  const fitted = fitSpans(
    rawCues.map((c) => c.span),
    { maxGapFrames: Math.round(maxGapSeconds * fps), limit },
  );
  // fitSpans may drop a squeezed-out cue, so pair by position rather than assuming 1:1.
  const placed: Cue[] = [];
  let cursor = 0;
  for (const span of fitted) {
    while (cursor < rawCues.length && rawCues[cursor].span.in < span.in) cursor++;
    const src = rawCues[Math.min(cursor, rawCues.length - 1)];
    placed.push({ span, text: src.text, words: src.words });
    cursor++;
  }
  if (!placed.length) return { ok: false, error: "no speech detected to caption" };

  const group = newId("cap");
  const style = args.style;
  const transform = captionTransform(args.transform);
  const animation = args.animation;

  const result = await ctxApplyOp(ctx, "add_captions", (tl) => {
    const track = resolveCaptionTrack(
      tl,
      args.text_track_id as string | undefined,
      placed.map((c) => c.span),
    );
    const created: Array<Record<string, unknown>> = [];
    for (const cue of placed) {
      const clip: Clip = {
        id: newId("txt"),
        kind: "text",
        timeline_in: cue.span.in,
        timeline_out: cue.span.out,
        content:
          cue.words && cue.words.length > 1
            ? cue.words.map((w) => ({
                text: w.text,
                t_in: w.t_in,
                t_out: w.t_out,
                ...(w.emphasis ? { emphasis: true } : {}),
              }))
            : [{ text: cue.text }],
        caption_group: group,
      };
      if (style && typeof style === "object") clip.style = style as Clip["style"];
      clip.transform = transform as Clip["transform"];
      if (animation && typeof animation === "object")
        clip.animation = animation as Clip["animation"];
      (track.clips ??= []).push(clip);
      created.push({ clip_id: clip.id, track_id: track.id });
    }
    return { created, count: created.length, caption_group: group, source_track: sourceTrack };
  });
  return failures.length ? { ...result, failed: failures } : result;
}

function numOrUndef(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Place an SRT/WebVTT file's cues at their AUTHORED timecodes — no transcription, no chunking:
 *  someone already decided where the words break, and second-guessing that is how an imported
 *  subtitle stops matching the video it was made for. */
async function placeSubtitleCues(
  ref: string,
  args: Args,
  ctx: ClientToolContext,
  fps: number,
): Promise<Result> {
  const abs = await ctx.store.resolveMediaRef(ref);
  if (!abs) return { ok: false, error: `subtitle asset not found: ${ref}` };
  const format = subtitleFormat(abs);
  if (!format) {
    return {
      ok: false,
      error: `'${ref}' is not a subtitle file (.srt/.vtt). Omit subtitle_media_ref to caption spoken audio.`,
    };
  }

  let cues: SubtitleCue[];
  try {
    cues = parseSubtitles(await ctx.store.readText(abs), format);
  } catch (e) {
    return {
      ok: false,
      error: `could not read '${ref}': ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const raw = cues.map((c) => ({
    span: { in: Math.round(c.start * fps), out: Math.round(c.end * fps) },
    text: c.text,
  }));
  // Authored cues overlap more often than you would think; the timeline refuses that.
  const limit = Math.max(...raw.map((c) => c.span.out));
  const fitted = fitSpans(
    raw.map((c) => c.span),
    { maxGapFrames: 0, limit },
  );
  const placed: Cue[] = [];
  let cursor = 0;
  for (const span of fitted) {
    while (cursor < raw.length && raw[cursor].span.in < span.in) cursor++;
    placed.push({ span, text: raw[Math.min(cursor, raw.length - 1)].text });
    cursor++;
  }

  const group = newId("cap");
  return ctxApplyOp(ctx, "add_captions", (tl) => {
    const track = resolveCaptionTrack(
      tl,
      args.text_track_id as string | undefined,
      placed.map((c) => c.span),
    );
    const created: Array<Record<string, unknown>> = [];
    for (const cue of placed) {
      const clip: Clip = {
        id: newId("txt"),
        kind: "text",
        timeline_in: cue.span.in,
        timeline_out: cue.span.out,
        content: [{ text: cue.text }],
        caption_group: group,
        transform: captionTransform(undefined) as Clip["transform"],
      };
      (track.clips ??= []).push(clip);
      created.push({ clip_id: clip.id, track_id: track.id });
    }
    return { created, count: created.length, caption_group: group, source: ref };
  });
}

export function registerCaptionTools(
  registry: ClientToolRegistry,
  getCtx: () => ClientToolContext | null,
): void {
  registry.register("add_captions", (args) => addCaptionsTool(args, getCtx()));
}
