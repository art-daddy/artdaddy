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

export interface CaptionWord {
  readonly text: string;
  /** Source seconds. */
  readonly start: number;
  readonly end: number;
}

export interface CaptionPhrase {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly words: readonly CaptionWord[];
}

export interface ChunkOptions {
  /** Cap words per caption. Undefined = no cap. */
  readonly maxWords?: number;
  /** Cap characters per caption, spaces included. A single longer word still gets its own
   *  caption rather than being split or dropped. */
  readonly maxCharacters?: number;
}

/** A word that ends a sentence closes the caption even when there is room left: reading a
 *  new sentence that begins mid-caption is what makes auto-captions feel machine-made. */
const SENTENCE_END = /[.!?…]["')\]]?$/;

export function chunkWords(
  words: readonly CaptionWord[],
  opts: ChunkOptions = {},
): CaptionPhrase[] {
  const maxWords = opts.maxWords && opts.maxWords > 0 ? Math.floor(opts.maxWords) : Infinity;
  const maxChars =
    opts.maxCharacters && opts.maxCharacters > 0 ? Math.floor(opts.maxCharacters) : Infinity;

  const out: CaptionPhrase[] = [];
  let run: CaptionWord[] = [];
  let chars = 0;

  const flush = (): void => {
    if (!run.length) return;
    out.push({
      text: run.map((w) => w.text).join(" "),
      start: run[0].start,
      end: run[run.length - 1].end,
      words: run,
    });
    run = [];
    chars = 0;
  };

  for (const w of words) {
    const width = run.length ? chars + 1 + w.text.length : w.text.length;
    // `run.length` guard: a word longer than the cap must still be emitted, not loop forever.
    if (run.length && (run.length + 1 > maxWords || width > maxChars)) flush();
    chars = run.length ? chars + 1 + w.text.length : w.text.length;
    run.push(w);
    if (SENTENCE_END.test(w.text)) flush();
  }
  flush();
  return out;
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
