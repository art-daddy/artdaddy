// What a running whisper-cli job says about how far it has got, read as its output arrives (S2-09, 5.1b).
// Pure: it reads the text it is handed and keeps a few numbers; it has no clock (the caller says what time
// it is), no I/O and no callback, so nothing it is given can make it fail, and nothing it does can slow the
// job it watches.
//
// What whisper-cli prints, and where (read from the app's own fixtures and its job supervisor):
//   * STDOUT: each segment, as the engine decodes it, as `[hh:mm:ss.mmm --> hh:mm:ss.mmm]  text`. The times
//     are on the engine's own clock, which starts at 0 for the audio it was handed (a window is handed its
//     own extract, so for a window it starts at the window's start). Segments come in bursts: the engine
//     decodes 30 s at a time and prints that stretch's segments together.
//   * STDERR: its log, among it `whisper_backend_init_gpu: using Vulkan0 backend` (or `no GPU found`, or
//     `failed to initialize`). The app's job supervisor streams stdout live and keeps stderr for the end
//     (jobs.rs: only `ProcEvent::Stdout` is announced), so the backend is not in a live stream; the caller
//     may hand the monitor the head of stderr that the supervisor holds (`feed` reads both the same way).
//
// The claims it makes, and when:
//   * the audio position, the end of the latest segment: from the first segment;
//   * the first words: the time that first segment arrived. "Starting" lasts until then, and the chip
//     claims no time until audio moves;
//   * the rate, seconds of work per second of audio SINCE the first words (the engine's start-up is not in
//     it): null until at least {@link MIN_AUDIO_S} s of audio and {@link MIN_WALL_S} s have passed since;
//   * the time left, the audio that remains at that rate: null until the rate is measured, and null when the
//     length of the run is not known;
//   * the start-up, launch to the first words less the work behind them at the measured rate: only when the
//     rate is measured, because the first segment arrives after the first 30 s window was decoded, and
//     launch-to-first-words alone would count that work as start-up;
//   * the backend, only when the engine's own log said it.
import type { SpeechBackend } from "./speechPace";

/** Audio and wall time that must have passed since the first words before a rate is claimed: fewer, and one
 *  burst of 30 s of segments decides it. */
export const MIN_AUDIO_S = 30;
export const MIN_WALL_S = 5;
/** The engine prints a decoded stretch's segments together: what arrives this soon after the first segment is
 *  the same burst, so the rate is read from after it, never from its middle. */
const BURST_MS = 1500;
/** The most text kept between chunks, and the most handled at once: a flood costs time in proportion to its
 *  size and never memory in proportion to it. */
export const BUFFER_CAP = 64 * 1024;
/** What must be kept of the end of a chunk so that a marker or log line cut in two by a chunk boundary is
 *  still found whole in the next one: more than the longest thing looked for. */
const KEEP_TAIL = 160;

const SEGMENT =
  /\[(\d{1,4}):([0-5]\d):([0-5]\d)[.,](\d{3}) --> (\d{1,4}):([0-5]\d):([0-5]\d)[.,](\d{3})\]/g;
const LOG = /whisper_backend_init_gpu: (using \S+ backend|no GPU found|failed to initialize)/g;

export interface MonitorOptions {
  /** Epoch ms the job was launched. */
  launchedAt: number;
  /** Seconds of audio the run covers; null when that is not known (then no time left is claimed). */
  spanS: number | null;
}

export interface MonitorSnapshot {
  /** Seconds of audio transcribed so far: the end of the latest segment. */
  doneS: number;
  /** Epoch ms the first segment arrived; null until audio has moved. */
  firstWordsAt: number | null;
  /** Seconds of work per second of audio since the first words; null until measured. */
  rate: number | null;
  /** Seconds left at that rate; null until measured. */
  etaS: number | null;
  /** Seconds from launch to when audio began to move, less the work behind the first words; null until the
   *  rate is measured (before then it cannot be told from the speed). */
  startupS: number | null;
  /** The backend the engine's own log named; null when no log reached the monitor. */
  backend: SpeechBackend | null;
  /** The engine said it found no graphics chip it can use, or could not start the one it found. */
  noGpu: boolean;
}

export interface SpeechMonitor {
  /** Read what the job printed (or the head of its log). Never throws. */
  feed(chunk: string, now: number): void;
  /** What is known now. Never throws. */
  snapshot(): MonitorSnapshot;
}

const clock = (h: string, m: string, s: string, ms: string): number =>
  Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;

interface Point {
  /** Epoch ms. */
  at: number;
  /** Seconds of audio. */
  audioS: number;
}

export function createSpeechMonitor(options: MonitorOptions): SpeechMonitor {
  let tail = "";
  let position = 0;
  let first: Point | null = null;
  /** The last point inside the first burst: the rate is read from here. */
  let base: Point | null = null;
  let latest: Point | null = null;
  let gpuUsing = false;
  let gpuFailed = false;
  let noGpu = false;

  const scan = (text: string, now: number): number => {
    let consumed = 0;
    for (const m of text.matchAll(SEGMENT)) {
      const end = clock(m[5], m[6], m[7], m[8]);
      const start = clock(m[1], m[2], m[3], m[4]);
      consumed = (m.index ?? 0) + m[0].length;
      if (!Number.isFinite(end) || end < start) continue;
      if (end > position) position = end;
      const point: Point = { at: now, audioS: position };
      if (first === null) {
        first = point;
        base = point;
      } else if (now - first.at <= BURST_MS) base = point;
      latest = point;
    }
    for (const m of text.matchAll(LOG)) {
      consumed = Math.max(consumed, (m.index ?? 0) + m[0].length);
      if (m[1].startsWith("using")) gpuUsing = true;
      else if (m[1] === "no GPU found") noGpu = true;
      else gpuFailed = true;
    }
    return consumed;
  };

  return {
    feed(chunk, now) {
      try {
        if (typeof chunk !== "string" || !chunk || !Number.isFinite(now)) return;
        // Slices of at most the cap, so a flood is read in bounded pieces.
        for (let from = 0; from < chunk.length; from += BUFFER_CAP) {
          const text = tail + chunk.slice(from, from + BUFFER_CAP);
          const consumed = scan(text, now);
          tail = text.slice(Math.max(consumed, text.length - KEEP_TAIL));
        }
      } catch {
        /* a monitor that cannot read something says nothing about it: the job is not its business */
      }
    },
    snapshot() {
      try {
        let rate: number | null = null;
        if (base && latest) {
          const wallS = (latest.at - base.at) / 1000;
          const audioS = latest.audioS - base.audioS;
          if (audioS >= MIN_AUDIO_S && wallS >= MIN_WALL_S) rate = wallS / audioS;
        }
        const spanS = options.spanS;
        const etaS =
          rate !== null && spanS !== null && Number.isFinite(spanS)
            ? Math.max(0, spanS - position) * rate
            : null;
        let startupS: number | null = null;
        if (rate !== null && base) {
          const lead = (base.at - options.launchedAt) / 1000 - base.audioS * rate;
          if (Number.isFinite(lead) && lead > 0) startupS = lead;
        }
        // Exactly as whisperFacts.ts reads the same lines, so the live reading and the final one cannot differ.
        const backend: SpeechBackend | null =
          gpuUsing && !gpuFailed ? "gpu" : gpuUsing || noGpu ? "cpu" : null;
        return {
          doneS: position,
          firstWordsAt: first?.at ?? null,
          rate,
          etaS,
          startupS,
          backend,
          noGpu: backend === "cpu",
        };
      } catch {
        return {
          doneS: 0,
          firstWordsAt: null,
          rate: null,
          etaS: null,
          startupS: null,
          backend: null,
          noGpu: false,
        };
      }
    },
  };
}

/** Should a whole-file run on the processor be stopped for being too slow: the time it has taken plus the time
 *  it still needs, at the rate it has measured, passes twice the cap. Never before the rate is measured. */
export function passesLiveCap(elapsedS: number, etaS: number | null, capS: number): boolean {
  if (etaS === null || !Number.isFinite(etaS) || !Number.isFinite(elapsedS)) return false;
  return elapsedS + etaS > 2 * capS;
}
