// Turning spoken words into caption-sized clips. Pure: no timeline, no I/O.
//
// This is deterministic work the model should never be doing token by token — it is the
// difference between "captions" and "one 400-word text clip". Two stages, because they
// answer different questions in different units:
//
//   chunkWords  — WHICH words belong together, in SOURCE seconds.
//   fitSpans    — where those chunks may START and END once placed, in PROJECT FRAMES.
//
// The invariant that matters for both: every input word survives, in order. Captions that
// silently drop a word are worse than no captions, because nobody re-reads their own video
// to check.

import { joinWords, wordGap } from "./wordJoin";

export interface CaptionWord {
  readonly text: string;
  /** Source seconds. */
  readonly start: number;
  readonly end: number;
  /** The transcript segment the word came from; a caption never spans two. */
  readonly segment?: number;
}

export interface CaptionPhrase {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly words: readonly CaptionWord[];
}

export interface ChunkOptions {
  /** Whether a caption's text draws on ONE line of its box. Required, because no length is right on
   *  every canvas, in every font, at every size: a caption is as long as fits (UJ-030). */
  readonly fits: (text: string) => boolean;
  /** Cap words per caption. A cap only makes captions shorter: they still fit one line. */
  readonly maxWords?: number;
  /** Cap characters per caption, spaces included. */
  readonly maxCharacters?: number;
}

/** A word that ends a sentence closes the caption even when there is room left: reading a
 *  new sentence that begins mid-caption is what makes auto-captions feel machine-made. Other
 *  scripts end theirs with their own marks: 。！？ (Chinese, Japanese), । ॥ (Hindi and other
 *  Indian scripts), ؟ (Arabic), ۔ (Urdu). */
const SENTENCE_END = /[.!?…。！？।॥؟۔]["')\]」』]?$/;
/** Where a clause ends: the next best place to cut a line that does not fit. */
const CLAUSE_END = /[,;:，、；：،؛]["')\]」』]?$/;

/** Group spoken words into captions the way an NLE does (Palmier Pro's rule): a caption is everything
 *  up to a sentence end, within one transcript segment, if it fits on one line; one that does not is
 *  cut at the clause mark nearest its middle, else at the word nearest its middle, and each half is
 *  judged again. A single word too wide for the line keeps a caption of its own. */
export function chunkWords(words: readonly CaptionWord[], opts: ChunkOptions): CaptionPhrase[] {
  const maxWords = opts.maxWords && opts.maxWords > 0 ? Math.floor(opts.maxWords) : Infinity;
  const maxChars =
    opts.maxCharacters && opts.maxCharacters > 0 ? Math.floor(opts.maxCharacters) : Infinity;
  const textOf = (run: readonly CaptionWord[]): string => joinWords(run.map((w) => w.text));

  const out: CaptionPhrase[] = [];
  const place = (run: readonly CaptionWord[]): void => {
    const text = textOf(run);
    const ok = run.length <= maxWords && text.length <= maxChars && opts.fits(text);
    if (ok || run.length === 1) {
      out.push({ text, start: run[0].start, end: run[run.length - 1].end, words: run });
      return;
    }
    const at = cutAt(run);
    place(run.slice(0, at));
    place(run.slice(at));
  };

  let unit: CaptionWord[] = [];
  for (const w of words) {
    if (unit.length && w.segment !== unit[unit.length - 1].segment) {
      place(unit);
      unit = [];
    }
    unit.push(w);
    if (SENTENCE_END.test(w.text)) {
      place(unit);
      unit = [];
    }
  }
  if (unit.length) place(unit);
  return out;
}

/** Where to cut a run of two or more words that does not fit: after the clause mark nearest the
 *  middle of its text, or failing one, between the words nearest the middle. */
function cutAt(run: readonly CaptionWord[]): number {
  const ends: number[] = []; // text length up to and including word i
  let len = 0;
  run.forEach((w, i) => {
    len += (i ? wordGap(run[i - 1].text, w.text).length : 0) + w.text.length;
    ends.push(len);
  });
  const nearestMiddle = (allowed: (i: number) => boolean): number => {
    let best = -1;
    for (let i = 1; i < run.length; i++)
      if (
        allowed(i) &&
        (best < 0 || Math.abs(ends[i - 1] - len / 2) < Math.abs(ends[best - 1] - len / 2))
      )
        best = i;
    return best;
  };
  const clause = nearestMiddle((i) => CLAUSE_END.test(run[i - 1].text));
  return clause > 0 ? clause : nearestMiddle(() => true);
}

export interface CaptionSpan {
  in: number;
  out: number;
}

export interface FitOptions {
  /** Close a gap no larger than this by holding the earlier caption, and hold the final one
   *  for up to the same. 0 disables both. */
  readonly maxGapFrames: number;
  /** Nothing may extend past here (the end of the speech's own clip). */
  readonly limit: number;
}

/** Make a run of caption spans placeable on ONE track: no overlaps, no sub-frame clips, short
 *  gaps closed, final caption held.
 *
 *  De-overlapping is not cosmetic — validateTimeline REFUSES a track whose clips overlap, so a
 *  one-frame rounding collision between neighbouring words would reject the whole edit.
 *  Spans arrive in timeline order. */
export function fitSpans(spans: readonly CaptionSpan[], opts: FitOptions): CaptionSpan[] {
  const gap = Math.max(0, Math.floor(opts.maxGapFrames));
  const out: CaptionSpan[] = [];

  for (const s of spans) {
    const span = { in: Math.round(s.in), out: Math.round(s.out) };
    if (span.out <= span.in) span.out = span.in + 1;
    const prev = out[out.length - 1];
    if (prev) {
      // A caption that would start before its predecessor ends loses; the predecessor is
      // already on screen and shortening it is less wrong than moving spoken words.
      if (span.in < prev.out) prev.out = span.in;
      if (prev.out <= prev.in) {
        // The predecessor has been squeezed out of existence — drop it rather than emit a
        // zero-length clip the renderer would have to special-case.
        out.pop();
      } else if (span.in - prev.out <= gap) {
        prev.out = span.in; // hold across the silence instead of blinking off and on
      }
    }
    if (span.in >= opts.limit) continue; // starts after the speech's clip ends
    span.out = Math.min(span.out, opts.limit);
    if (span.out <= span.in) continue;
    out.push(span);
  }

  const last = out[out.length - 1];
  if (last && gap > 0) last.out = Math.min(last.out + gap, opts.limit);
  return out;
}

/** Non-destructive display casing, applied at build time so the stored text stays readable. */
export function applyCase(text: string, mode: string | undefined): string {
  if (mode === "upper") return text.toUpperCase();
  if (mode === "lower") return text.toLowerCase();
  return text;
}
