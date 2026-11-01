// How fast THIS machine transcribes, learned from its own finished runs, so a call that has to
// stop waiting can say roughly how long is left.
//
// The figure is a courtesy to the agent and the person ("about 40 s"), not a promise. Each run is
// timed by whisper itself (whisperFacts.ts), the estimate is the MEDIAN rate of the last few runs
// (one that an export or a sleeping laptop slowed does not move it), and a machine with no history
// gets a typical figure for its kind: measured with the small model, a Mac with its GPU takes about
// a tenth of the audio's length and a Windows or Linux one about a third (2026-11-01).
import { hostInfo, type HostOs } from "../platform/host";

const KEY = "artdaddy.speech_pace";
/** Where the runs are kept; exported so a test can put something unreadable there. */
export const SPEECH_PACE_KEY = KEY;
const KEEP = 8;
/** Seconds of engine start-up (loading the model) that no amount of audio shortens. */
export const STARTUP_S = 3;
/** A run on less audio than this is mostly start-up, which says nothing about speed. */
const MIN_AUDIO_S = 10;
const MIN_RATE = 0.01;

/** [audio seconds, whisper's own wall seconds, model load included] of one finished run. */
export type PaceSample = readonly [audio: number, wall: number];

type Store = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const isSample = (v: unknown): v is PaceSample =>
  Array.isArray(v) &&
  v.length === 2 &&
  v.every((n) => typeof n === "number" && Number.isFinite(n)) &&
  v[0] >= MIN_AUDIO_S &&
  v[1] > 0;

/** The runs kept, oldest first. Anything unreadable is no history, never an error. */
export function readPace(storage: Store | null = browserStorage()): PaceSample[] {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter(isSample).slice(-KEEP) : [];
  } catch {
    return [];
  }
}

/** Remember a finished run. A run with no timing, or too little audio to say anything, is not
 *  kept. Never throws: where nothing can be stored, the defaults stand. */
export function recordSpeechRun(
  audioSeconds: number | null,
  wallSeconds: number | null,
  storage: Store | null = browserStorage(),
): void {
  if (audioSeconds === null || wallSeconds === null) return;
  const sample: unknown = [audioSeconds, wallSeconds];
  if (!isSample(sample)) return;
  try {
    storage?.setItem(KEY, JSON.stringify([...readPace(storage), sample].slice(-KEEP)));
  } catch {
    /* a full or blocked store only costs the next estimate its accuracy */
  }
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Seconds of work per second of audio, beyond the start-up. */
export function secondsPerAudioSecond(
  samples: readonly PaceSample[],
  os: HostOs = hostInfo().os,
): number {
  if (!samples.length) return os === "macos" ? 0.1 : 0.35;
  return median(samples.map(([audio, wall]) => Math.max(MIN_RATE, (wall - STARTUP_S) / audio)));
}

/** About how many seconds `audioSeconds` of speech takes to transcribe here, start-up included. */
export function estimateTranscribeSeconds(
  audioSeconds: number,
  samples: readonly PaceSample[] = readPace(),
  os: HostOs = hostInfo().os,
): number {
  const audio = Number.isFinite(audioSeconds) ? Math.max(0, audioSeconds) : 0;
  return Math.round(STARTUP_S + secondsPerAudioSecond(samples, os) * audio);
}
