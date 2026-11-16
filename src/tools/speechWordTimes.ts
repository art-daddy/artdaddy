// The first-word fix: a word's time is the one the engine's own alignment found for its sound (whisper-cli `-dtw`),
// not the one whisper stores. Why: whisper puts the first word(s) of any audio at the START of that audio, early by
// the silence in front of them, so `get_transcript` (a window of the clip's span plus a second each side) drops a
// clip's first words and captions start their first cue early. In the speech study (170 clips with a quarter of a second
// to two and a half seconds of silence in front, 20 languages, the app's own flags) no first word was early by more
// than half a second with the alignment, against every clip with about a second of silence without it; the median
// first word came 0.1 s after the sound began, the word error moved by -0.13 points (inside the noise) and a run took
// about a tenth longer.
//
// SHIPPED DARK. This release carries the code and does not use it: `WORD_TIMES_SHIPPED` is off, so no launch of the
// engine is changed and no transcript is read differently, whatever the server says. The remote switch
// `speech_word_times` is an off-switch that starts on, like every other: once a release turns the behaviour on it can
// take it away again (a launch without the arguments, a read of the kept words as 0.27.0 read them), never give it.
//
// Not in this slice (each named so nobody assumes it):
//   * the graphics-chip path: with a chip, `-dtw` needs flash attention off and nobody has measured that, and a
//     failure there would be read by `isGpuCrash` as a crash of the chip and pause it for hours, so only a launch
//     with `-ng` carries the arguments (a PC whose chip has not crashed launches without `-ng`, even one with no
//     usable chip, so it runs as in 0.27.0);
//   * any model other than "small" (the other sizes need another alignment preset; "base" is not measured);
//   * transcripts already kept are not repaired: one is made again only when its cache entry is gone;
//   * the `trim` fallback (cut the window's leading silence, add the cut back), `clipWordFrames`' tolerance, any
//     change to the audio the engine hears, any telemetry or privacy text, and the pace model (a run with the
//     alignment is about a tenth slower and the pace is measured from runs).
import { exportFlag } from "../api/exportFlags";

/** Shipped dark (see above). A later release turns it on, after the owner has looked at real captions made this way
 *  and a PC with a graphics chip has been measured. */
export const WORD_TIMES_SHIPPED = false;

let shipped: boolean = WORD_TIMES_SHIPPED;

/** Tests only. */
export function __setWordTimesShipped(value: boolean): void {
  shipped = value;
}

/** Tests only. */
export function __resetWordTimesShipped(): void {
  shipped = WORD_TIMES_SHIPPED;
}

/** The manifest keys (modelManifest.ts) of the model files whose alignment was measured: the ONE place that says which model
 *  files may carry the arguments below, and the app's own default model is the only one in it. The smaller file
 *  (`small_q8_0`, the processor-only model) is NOT in it: nobody has measured `-dtw` with it. A release that measures it
 *  adds its key here and changes nothing else (`transcribe.ts` hands the engine the key of the file it launches). */
export const WORD_TIMES_MODELS: readonly string[] = ["small"];

/** What the engine is given: `-dtw small` aligns each token with the audio (the alignment heads of the "small"
 *  model), and `-nfa` turns flash attention off, which that alignment needs. */
export const DTW_ARGS = ["-dtw", "small", "-nfa"] as const;

/** Is the behaviour in use right now: this build ships it and the server has not switched it off. */
export function wordTimesOn(): boolean {
  return shipped && exportFlag("speech_word_times");
}

/** What a launch of the engine adds to its arguments. Only a launch with the chip off (`cpuOnly`, the `-ng` one: the
 *  retry after the chip crashed is one too) and only a measured model (`size` is the manifest key of the file the
 *  launch names); every other launch is what 0.27.0 made. */
export function wordTimesArgs(input: { size: string; cpuOnly: boolean }): string[] {
  return wordTimesOn() && WORD_TIMES_MODELS.includes(input.size) && input.cpuOnly
    ? [...DTW_ARGS]
    : [];
}

/** One whisper window is 30 s. A time further than that from where the token was stored is the alignment of
 *  something else (a window's clock mistaken for the file's, a damaged value), never a correction. */
export const WINDOW_MS = 30_000;

/** A token's place in time, in milliseconds. */
export interface Interval {
  from: number;
  to: number;
}

/** A word's or a segment's place in time, in seconds. */
export interface Span {
  start: number;
  end: number;
}

/** A token moved onto its own sound. `stored` is where whisper wrote it (ms); `tDtw` is its alignment time, in units
 *  of 10 ms, and -1 where none was made. The token keeps its stored length. Null when there is no usable time: not a
 *  finite number of 0 or more, or too far from where it was stored. */
export function tokenOnSound(stored: Interval, tDtw: unknown): Interval | null {
  if (typeof tDtw !== "number" || !Number.isFinite(tDtw) || tDtw < 0) return null;
  // Whole milliseconds: a time on a window's clock was moved by a part of 10 ms.
  const shift = Math.round(tDtw * 10) - stored.from;
  if (!Number.isFinite(shift) || Math.abs(shift) > WINDOW_MS) return null;
  return { from: stored.from + shift, to: stored.to + shift };
}

/** The words of a transcript, in order, made fit to be read in order after their tokens moved. Each rule has one reason:
 *  - a start is never before the start of the word before it (across segments too), and never below 0: the alignment
 *    is made in order, so a start that goes back is a token aligned somewhere else, and everything that reads the words
 *    (captions, `get_transcript`, the word editor) reads them as a sequence from the start of the audio;
 *  - an end is never before its start: a token keeps the length it was stored with, made for its stored time;
 *  - a word that runs over the next is cut back to where the next one starts: that stored length is longer than the gap
 *    the alignment leaves, and two words must not claim the same sound. They touch, they never overlap.
 *  A time that is not a number is no time: the word starts where the one before it did and ends where it starts. */
export function settleWords(words: readonly Span[]): Span[] {
  let before = 0;
  const settled = words.map((w) => {
    const start = Math.max(Number.isFinite(w.start) ? w.start : before, before);
    before = start;
    return { start, end: Number.isFinite(w.end) ? Math.max(w.end, start) : start };
  });
  for (let i = 0; i + 1 < settled.length; i++)
    if (settled[i].end > settled[i + 1].start) settled[i].end = settled[i + 1].start;
  return settled;
}

/** A segment follows its words: it starts where its first word does when that is later than where it was stored (the
 *  first segment of a clip is stored as starting at 0 whatever is in front of its words), and it ends where its last
 *  word ends when that is later than where it was stored. It is never made to start earlier or end earlier. */
export function segmentFollowsWords(segment: Span, words: readonly Span[]): Span {
  if (words.length === 0) return { ...segment };
  return {
    start: Math.max(segment.start, words[0].start),
    end: words.reduce((end, w) => Math.max(end, w.end), segment.end),
  };
}
