// Where the voice starts in the audio an engine launch is about to hear, measured BEFORE the launch (the rule is in
// speechWordTimes.ts: the engine's own word times are used only when the voice starts more than LEADING_QUIET_MS in).
//
// A port of the speech study's own onset proxy (`speech_onset_ms`, tools/pkwords.py of the speech study): the audio is cut
// into 20 ms frames, each frame's level is its RMS in dBFS, and the voice starts at the first of three frames in a row
// whose level is more than 15 dB above the quietest tenth of the frames and above -50 dBFS. It is a proxy, never a word
// time: it can be a few tens of milliseconds early or late depending on how a word begins, and the rule only needs to
// know which side of one second it falls on.
//
// What it does not see, each a launch as 0.27.0 made it (the answer is then `none` or `unknown`, never "late"):
//   * a recording whose speech never rises above -50 dBFS in a 20 ms frame (a very quiet recording): `none`;
//   * a click or a breath in front of the voice reads as the voice, so a clip that begins with a blip and then holds
//     seconds of near-silence is told apart from one that begins with speech only as far as the blip is not the first
//     three loud frames;
//   * a voice that starts after the first VOICE_SCAN_S seconds of the audio: `none` (the floor and the search stop there,
//     one whisper window);
//   * audio that is not what the app extracts for the engine (16 kHz, mono, 16-bit PCM), cut short, unreadable or too slow
//     to read: `unknown`. Nothing here throws and nothing waits longer than MEASURE_GUARD_MS.
// Found while freezing the reference (each is a case of __fixtures__/firstWord/onset-reference.json), all the same direction:
//   * a hiss or a steady tone (music) in front of the voice that is 15 dB or more over the pauses of the voice reads as the
//     voice from its first three frames, so a voice that starts seconds later is `at` 0; a constant offset or a loud hum that
//     lifts the quietest tenth hides the voice (`none`); so does a voice with no pause and no quiet in front of it;
//   * a `fmt ` chunk too short to hold the format fields, a `data` size of 0 (an empty file: `none`), a format tag other than
//     1 (extensible included), and a chunk in front of `data` longer than the 4 KiB of room the read leaves (a shorter
//     scan, or `unknown` when `data` is not in the read) are read as written, never guessed.
//
// Arithmetic: the levels are computed from the integer samples exactly as the reference computes them from the same
// samples divided by 32768 (the sum of squares is exact in a double, so only `log10` could differ from the reference, and
// only for a frame whose level sits exactly on a threshold). The comparison against the threshold is strict.

/** The voice may start this long after the start of the audio and a launch is still exactly what 0.27.0 made: the owner's
 *  rule ("the quiet that counts is 1 second"). More than this and the launch carries the engine's own word times. */
export const LEADING_QUIET_MS = 1000;

/** How much of the start of the audio is looked at, in seconds: whisper's own first window. The floor (the quietest
 *  tenth) is taken over these seconds only, so for audio up to this long the answer is the reference's. On the 1070 real
 *  clips of the study (3.6 to 46.5 s, 20 languages) no clip's decision changed with a prefix of 20 s or more; with 10 s
 *  five did, with 5 s eighteen. It is also what fits the one read: the app's head read returns at most 1 MiB. */
export const VOICE_SCAN_S = 30;

/** How long the measurement may take before the launch goes ahead as 0.27.0 made it. */
export const MEASURE_GUARD_MS = 5000;

const SAMPLE_RATE = 16_000;
const FRAME_MS = 20;
const FRAMES_IN_A_ROW = 3;
const ABOVE_FLOOR_DB = 15;
const MIN_DB = -50;
const FLOOR_PERCENT = 10;
/** The scan plus room for the header (the extract's header is under 100 bytes). Within the app's 1 MiB head read. */
const HEAD_BYTES = VOICE_SCAN_S * SAMPLE_RATE * 2 + 4096;

/** Where the voice starts in a file's first seconds: `at` is milliseconds from the start of the audio (a multiple of
 *  20); `none` means nothing stood out (silence, a very quiet recording, a voice after the scanned seconds); `unknown`
 *  means it could not be measured. Only `at` more than LEADING_QUIET_MS is "late". */
export type VoiceStart =
  | { readonly kind: "at"; readonly ms: number }
  | { readonly kind: "none" }
  | { readonly kind: "unknown" };

const NONE: VoiceStart = { kind: "none" };
const UNKNOWN: VoiceStart = { kind: "unknown" };

/** Does the voice start later than the quiet the rule allows. Strictly more: a voice at exactly one second is today's. */
export function voiceStartsLate(voice: VoiceStart): boolean {
  return voice.kind === "at" && voice.ms > LEADING_QUIET_MS;
}

/** numpy's `percentile(values, 10)` with the default (linear) method, including its interpolation formula. */
function floorOf(levels: Float64Array): number {
  const sorted = Float64Array.from(levels).sort();
  const last = sorted.length - 1;
  const at = last * (FLOOR_PERCENT / 100);
  const below = Math.floor(at);
  const lower = sorted[below];
  const upper = sorted[Math.min(below + 1, last)];
  const weight = at - below;
  const span = upper - lower;
  return weight >= 0.5 ? upper - span * (1 - weight) : lower + span * weight;
}

/** Where the first voice is, in ms from the start of `pcm` (a multiple of 20), or null when no frame stands out or the
 *  audio holds fewer than three frames. `pcm` is 16-bit samples; `sampleRate` is in Hz. Pure; never throws for samples. */
export function speechOnsetMs(
  pcm: ArrayLike<number>,
  sampleRate: number = SAMPLE_RATE,
): number | null {
  const hop = Math.floor((sampleRate * FRAME_MS) / 1000);
  if (!(hop >= 1)) return null;
  const frames = Math.floor(pcm.length / hop);
  if (frames < FRAMES_IN_A_ROW) return null;
  const levels = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sumOfSquares = 0;
    for (let i = f * hop, end = i + hop; i < end; i++) sumOfSquares += pcm[i] * pcm[i];
    // The reference reads samples as value / 32768, so a frame's mean square is its sum over 2^30 and the frame length.
    const meanSquare = sumOfSquares / hop / 1_073_741_824;
    levels[f] = 20 * Math.log10(Math.sqrt(meanSquare + 1e-12));
  }
  const threshold = Math.max(floorOf(levels) + ABOVE_FLOOR_DB, MIN_DB);
  let run = 0;
  for (let f = 0; f < frames; f++) {
    run = levels[f] > threshold ? run + 1 : 0;
    if (run === FRAMES_IN_A_ROW) return (f - FRAMES_IN_A_ROW + 1) * FRAME_MS;
  }
  return null;
}

/** The samples of a 16 kHz mono 16-bit PCM WAV file given as its first bytes (the chunks are walked, so a LIST chunk
 *  before `data` is fine), at most the first VOICE_SCAN_S seconds of them; null for any other file, or one with no
 *  `fmt ` before `data`. A `data` chunk whose size is larger than what was read, or 0xFFFFFFFF, runs to the end of the
 *  bytes; a trailing half sample is dropped. */
export function pcm16WavSamples(bytes: Uint8Array): { samples: Int16Array; rate: number } | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number): string =>
    String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let format: { tag: number; channels: number; rate: number; bits: number } | null = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > bytes.length) return null;
      format = {
        tag: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (!format) return null;
      if (format.tag !== 1 || format.channels !== 1 || format.bits !== 16) return null;
      if (format.rate !== SAMPLE_RATE) return null;
      const end = size === 0xffffffff ? bytes.length : Math.min(bytes.length, body + size);
      const count = Math.min(Math.max(0, Math.floor((end - body) / 2)), VOICE_SCAN_S * format.rate);
      const samples = new Int16Array(count);
      for (let i = 0; i < count; i++) samples[i] = view.getInt16(body + 2 * i, true);
      return { samples, rate: format.rate };
    }
    at = body + size + (size & 1);
  }
  return null;
}

/** Where the voice starts in a WAV file given as its first bytes. Never throws: anything it cannot read is `unknown`. */
export function voiceStartOf(bytes: Uint8Array | null | undefined): VoiceStart {
  try {
    if (!bytes) return UNKNOWN;
    const wav = pcm16WavSamples(bytes);
    if (!wav) return UNKNOWN;
    const ms = speechOnsetMs(wav.samples, wav.rate);
    return ms === null ? NONE : { kind: "at", ms };
  } catch {
    return UNKNOWN;
  }
}

/** What `measureVoiceStart` needs of the project store: the ranged read of a file's start. */
export interface HeadReader {
  readHead?: (path: string, maxBytes: number) => Promise<Uint8Array | null>;
}

/** Where the voice starts in the audio file `wav`, read from its first bytes only. Never throws, never waits longer than
 *  `guardMs`; a file that cannot be read in time, or a store with no ranged read, is `unknown`. */
export async function measureVoiceStart(
  store: HeadReader,
  wav: string,
  guardMs: number = MEASURE_GUARD_MS,
): Promise<VoiceStart> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (typeof store.readHead !== "function") return UNKNOWN;
    const guard = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), guardMs);
    });
    return voiceStartOf(await Promise.race([store.readHead(wav, HEAD_BYTES), guard]));
  } catch {
    return UNKNOWN;
  } finally {
    clearTimeout(timer);
  }
}
