// The first-word fix: a word's time is the one the engine's own alignment found for its sound (whisper-cli `-dtw`),
// not the one whisper stores. Why: whisper puts the first word(s) of any audio at the START of that audio, early by
// the silence in front of them, so `get_transcript` (a window of the clip's span plus a second each side) drops a
// clip's first words and captions start their first cue early. In the speech study (170 clips with a quarter of a second
// to two and a half seconds of silence in front, 20 languages, the app's own flags) no first word was early by more
// than half a second with the alignment, against every clip with about a second of silence without it; the median
// first word came 0.1 s after the sound began, the word error moved by -0.13 points (inside the noise) and a run took
// about a tenth longer. On the owner's second demo page (seven clips with 1 to 8 s of quiet in front, one engine run
// each way) the first word landed 0.12 to 1.14 s after the voice, median 0.26 s, where without the alignment it sat at
// the start of the audio in six of the seven: measured on those clips, not a promise for any clip.
//
// THE RULE (the owner, 16 Nov 2026: "the quiet that counts is 1 second"). A launch of the engine carries the alignment
// only when the voice in the ONE audio file that launch hears starts MORE than LEADING_QUIET_MS (one second) after the
// start of that file, measured before the launch (speechLeadingQuiet.ts), and only for a model file and an engine path
// that were measured (WORD_TIMES_MODELS, WORD_TIMES_CHIP_MODELS). A voice that starts within a second: the launch, the
// words that are kept and every word time are exactly what 0.27.0 made. At about a second of quiet the aligned captions
// looked laggy beside today's, which were fine; with longer quiet today's appear well before the speech and the aligned
// ones as it is spoken. The threshold is hard: a voice that starts at 0.98 s and one that starts at 1.02 s are treated
// differently, by about the quiet in front of the first caption.
//
// Whether a build uses any of this is `WORD_TIMES_SHIPPED` (and `WORD_TIMES_CHIP_SHIPPED` for the graphics chip). The
// remote switch `speech_word_times` is an off-switch that starts on, like every other: once a release turns the
// behaviour on it can take it away again (a launch without the arguments, a read of the kept words as 0.27.0 read
// them), never give it.
//
// Not covered, each named so nobody assumes it:
//   * the graphics-chip path, until its constant is on and a model is in WORD_TIMES_CHIP_MODELS: with a chip `-dtw` needs
//     flash attention off, which has to be measured on its own;
//   * any model file that is not in the list for its path (another size needs another alignment preset; a squeezed copy
//     of "small" has other weights);
//   * a launch over several files: it never carries the arguments, and a file whose voice starts late is run alone;
//   * a voice that starts after the first VOICE_SCAN_S seconds of the audio, or that comes after a click or a breath
//     the detector reads as the voice: both launch as 0.27.0 did;
//   * transcripts already kept are not repaired: one is made again only when its cache entry is gone;
//   * a long pause INSIDE a recording (the same effect at whisper's own 30 s windows), `clipWordFrames`' tolerance, any
//     change to the audio the engine hears, any telemetry or privacy text, and the pace model (a run with the
//     alignment is about a tenth slower and the pace is measured from runs).
import { exportFlag } from "../api/exportFlags";
import { WINDOWS_LOAD_FAILURES } from "./speechBackend";
import { voiceStartsLate, type VoiceStart } from "./speechLeadingQuiet";

/** Whether this build uses the alignment on the processor path. Off in every commit but the one that turns it on. */
export const WORD_TIMES_SHIPPED = false;

/** Whether this build also uses it on the graphics-chip path (a launch without `-ng`). Off until that path has been
 *  measured and the owner has agreed; independent of {@link WORD_TIMES_SHIPPED} so the processor path can ship alone. */
export const WORD_TIMES_CHIP_SHIPPED = false;

let shipped: boolean = WORD_TIMES_SHIPPED;
let chipShipped: boolean = WORD_TIMES_CHIP_SHIPPED;

/** Tests only. */
export function __setWordTimesShipped(value: boolean): void {
  shipped = value;
}

/** Tests only. */
export function __setWordTimesChipShipped(value: boolean): void {
  chipShipped = value;
}

/** Tests only: both constants back to what the build says. */
export function __resetWordTimesShipped(): void {
  shipped = WORD_TIMES_SHIPPED;
  chipShipped = WORD_TIMES_CHIP_SHIPPED;
}

/** The manifest keys (modelManifest.ts) of the model files whose alignment was measured on the PROCESSOR path (the launch
 *  with `-ng`): the ONE place that says which model files may carry the arguments there, and the app's own default model
 *  is the only one in it. A file that is not here never carries them, so a model added to the manifest is refused until
 *  somebody has measured it. The smaller file (`small_q8_0`, the processor-only model) is NOT in it: nobody has measured
 *  `-dtw` with it. A release that measures it adds its key here and changes nothing else (`transcribe.ts` hands the
 *  engine the key of the file it launches). "small": the speech study and the sweep over 240 real outputs. */
export const WORD_TIMES_MODELS: readonly string[] = ["small"];

/** The same for the GRAPHICS-CHIP path (a launch without `-ng`), which also needs {@link WORD_TIMES_CHIP_SHIPPED}. The
 *  smaller file is never launched there (the launch boundary converts it to the processor's). */
export const WORD_TIMES_CHIP_MODELS: readonly string[] = [];

/** What the engine is given: `-dtw small` aligns each token with the audio (the alignment heads of the "small"
 *  model), and `-nfa` turns flash attention off, which that alignment needs. */
export const DTW_ARGS = ["-dtw", "small", "-nfa"] as const;

/** Is the behaviour in use right now: this build ships it and the server has not switched it off. */
export function wordTimesOn(): boolean {
  return shipped && exportFlag("speech_word_times");
}

/** Could a launch with these facts carry the arguments at all, before any audio is looked at? The build and the server
 *  allow it, the model file was measured, and so was this engine path (the chip also needs its own constant). A caller
 *  asks this first so that nothing is read from the audio while the rule cannot apply. */
export function wordTimesPossible(input: { size: string; cpuOnly: boolean }): boolean {
  if (!wordTimesOn()) return false;
  if (input.cpuOnly) return WORD_TIMES_MODELS.includes(input.size);
  return chipShipped && WORD_TIMES_CHIP_MODELS.includes(input.size);
}

/** What a launch of the engine adds to its arguments. `voice` is where the voice starts in the one file the launch
 *  hears (speechLeadingQuiet.ts), measured before it: required, so no caller can leave the rule out. The arguments only
 *  when the rule says so; every other launch is what 0.27.0 made. `size` is the manifest key of the model file the
 *  launch names. */
export function wordTimesArgs(input: {
  size: string;
  cpuOnly: boolean;
  voice: VoiceStart;
}): string[] {
  return wordTimesPossible(input) && voiceStartsLate(input.voice) ? [...DTW_ARGS] : [];
}

/** What a launch that carried the arguments left at its output path. */
export type AlignmentOutput = "readable" | "missing" | "unreadable";

/** What the engine prints for a language it does not know (the same text `finishWhisper` reads). */
const UNKNOWN_LANGUAGE = /error: unknown language '/;

/** Should a launch that carried the arguments be made once more without them? When it ended in failure and was not
 *  stopped: a non-zero exit, no output, an output that is not JSON. Then the run is the one 0.27.0 made, so a PC the
 *  alignment does not run on gets today's words, never a failed transcription. Never for a stop (the person's Cancel,
 *  the live check, the caller's signal), for an engine that cannot start at all, or for a language the engine does not
 *  know: a launch without the arguments would end the same way. */
export function retryWithoutWordTimes(input: {
  carried: boolean;
  stopped: boolean;
  code: number | null;
  stderr: string;
  output: AlignmentOutput;
}): boolean {
  if (!input.carried || input.stopped) return false;
  if (input.stderr === "cancelled") return false; // how the runner answers a process it was told to kill
  if (input.code === 0 && input.output === "readable") return false;
  if (input.code !== null && WINDOWS_LOAD_FAILURES.has(input.code)) return false;
  return !UNKNOWN_LANGUAGE.test(input.stderr);
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
