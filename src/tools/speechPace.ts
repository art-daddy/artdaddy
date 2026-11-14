// How fast THIS machine transcribes, learned from its own finished runs: the ONE authority for "how
// long here". The wait notes, the size of a batch, the longest span the assistant may ask for and the
// planner all read it, because two estimators for one quantity disagree.
//
// Each run is timed by whisper itself (whisperFacts.ts) and kept with the backend it ran on: the
// graphics chip and the processor are two different machines in speed and in start-up, and a run of
// one says nothing about the other. A backend's model is a start-up (the time before the first audio
// moves, which no amount of audio shortens) plus a rate (seconds of work per second of audio). The
// rate is the MEDIAN of the last few runs (one that an export or a sleeping laptop slowed does not
// move it). The start-up is the one this PC measured when a run said so (the running-job monitor will
// record it), else the backend's default: never a constant that is only true in the lab.
//
// The figures are a courtesy to the agent and the person ("about 40 s"), not a promise.
import { hostInfo, type HostOs } from "../platform/host";
import { cpuOnlyNow } from "./speechBackend";

/** 0.27.0 kept `[audio, wall]` under `artdaddy.speech_pace`; those samples name no backend, so they
 *  are not read: this machine learns its pace again under the new key. */
const KEY = "artdaddy.speech_pace.v2";
/** Where the runs are kept; exported so a test can put something unreadable there. */
export const SPEECH_PACE_KEY = KEY;
/** Runs kept, of EACH backend: a burst of one never evicts the history of the other. */
const KEEP = 8;
/** A run on less audio than this is mostly start-up, which says nothing about speed. */
const MIN_AUDIO_S = 10;
const MIN_RATE = 0.01;
/** Beyond any file: keeps a projection finite whatever length is asked about. */
const MAX_AUDIO_S = 1e9;
/** The shortest span worth offering: a PC that cannot do this much in the cap is told so. */
export const MIN_SPAN_S = 10;

export type SpeechBackend = "gpu" | "cpu";
export const SPEECH_BACKENDS: readonly SpeechBackend[] = ["gpu", "cpu"];

/** [audio seconds, whisper's own wall seconds (model load included), the backend that ran it, and
 *  the seconds it took to begin when a monitor measured that]. */
export type PaceSample = readonly [
  audio: number,
  wall: number,
  backend: SpeechBackend,
  startupS?: number,
];

/** What a backend takes on this machine: `startupS` before the first audio moves, then `rate`
 *  seconds of work for each second of audio. `runs` is how many finished runs of THIS backend shaped
 *  it; 0 means the defaults. */
export interface PaceModel {
  readonly backend: SpeechBackend;
  readonly startupS: number;
  readonly rate: number;
  readonly runs: number;
}

export type PaceBook = Readonly<Record<SpeechBackend, PaceModel>>;

/** What a machine with no run of its own is assumed to do. They err toward the SHORTER span limit: a
 *  PC that is faster finds out from its first run, a PC that is slower would otherwise be told a span
 *  fits that it cannot do.
 *   - processor: 3.7 s of work for each second of audio, the field's median processor-only PC (0.27
 *     times real time: report 8.11, and the speech study's measured table, RESULTS section 5), and 20 s
 *     to begin;
 *   - graphics chip: 0.5 s for each second, 2 times real time, the weakest tenth of the field's chip
 *     PCs (their median is 4.2 times), and 15 s to begin.
 *  The start-ups are 5 to 9 times what the lab PC measured (1.7 s on its chip, 3.6 s on its processor)
 *  and a quarter to a third of the slowest field PC's (about a minute), so no clip is shown as taking
 *  seconds on a PC that has not yet said how long it takes to begin. */
export const DEFAULT_PACE: Readonly<Record<SpeechBackend, { rate: number; startupS: number }>> = {
  cpu: { rate: 3.7, startupS: 20 },
  gpu: { rate: 0.5, startupS: 15 },
};
/** A Mac with its own GPU did about a tenth of the audio's length in the lab (2026-11-01). */
export const MAC_GPU_RATE = 0.1;

export function defaultPace(
  backend: SpeechBackend,
  os: HostOs,
): { rate: number; startupS: number } {
  const base = DEFAULT_PACE[backend === "gpu" ? "gpu" : "cpu"];
  return backend === "gpu" && os === "macos" ? { ...base, rate: MAC_GPU_RATE } : base;
}

type Store = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A sample as kept, or null when it says nothing usable. A start-up that cannot be true (not
 *  positive, or as long as the whole run) is dropped from the sample, not the sample from the model. */
function cleanSample(v: unknown): PaceSample | null {
  if (!Array.isArray(v) || v.length < 3 || v.length > 4) return null;
  const [audio, wall, where, startup] = v as unknown[];
  if (!finite(audio) || !finite(wall) || audio < MIN_AUDIO_S || wall <= 0) return null;
  if (where !== "gpu" && where !== "cpu") return null;
  return finite(startup) && startup > 0 && startup < wall
    ? [audio, wall, where, startup]
    : [audio, wall, where];
}

/** The last {@link KEEP} runs of each backend, oldest first overall. */
function recent(samples: readonly PaceSample[]): PaceSample[] {
  const seen: Record<SpeechBackend, number> = { gpu: 0, cpu: 0 };
  const keep = new Set<PaceSample>();
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (seen[s[2]] < KEEP) {
      seen[s[2]]++;
      keep.add(s);
    }
  }
  return samples.filter((s) => keep.has(s));
}

/** The runs kept, oldest first. Anything unreadable is no history, never an error. */
export function readPace(storage: Store | null = browserStorage()): PaceSample[] {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return recent(raw.map(cleanSample).filter((s): s is PaceSample => s !== null));
  } catch {
    return [];
  }
}

/** Remember a finished run and the backend it ran on. A run with no timing, no backend (the engine
 *  did not say what it ran on, so it belongs to neither model), or too little audio to say anything,
 *  is not kept. Never throws: where nothing can be stored, the defaults stand. */
export function recordSpeechRun(
  audioSeconds: number | null,
  wallSeconds: number | null,
  backend: SpeechBackend | null,
  storage: Store | null = browserStorage(),
  startupSeconds?: number,
): void {
  if (audioSeconds === null || wallSeconds === null || backend === null) return;
  const sample = cleanSample(
    startupSeconds === undefined
      ? [audioSeconds, wallSeconds, backend]
      : [audioSeconds, wallSeconds, backend, startupSeconds],
  );
  if (!sample) return;
  try {
    storage?.setItem(KEY, JSON.stringify(recent([...readPace(storage), sample])));
  } catch {
    /* a full or blocked store only costs the next estimate its accuracy */
  }
}

/** The backend a run reports in its own log ("vulkan", "metal", "cpu", ...) as one of ours; null
 *  when the log did not say. */
export function backendOfRun(reported: string | null): SpeechBackend | null {
  if (!reported) return null;
  return reported === "cpu" ? "cpu" : "gpu";
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** How `backend` does on this machine, from the samples that ran on it. Never throws: whatever is in
 *  `samples` that is not a usable run is no history. */
export function paceModel(
  samples: readonly PaceSample[],
  backend: SpeechBackend,
  os: HostOs = hostInfo().os,
): PaceModel {
  const where: SpeechBackend = backend === "gpu" ? "gpu" : "cpu";
  const base = defaultPace(where, os);
  const mine = (Array.isArray(samples) ? samples : [])
    .map(cleanSample)
    .filter((s): s is PaceSample => s !== null && s[2] === where)
    .slice(-KEEP);
  const measured = mine.flatMap((s) => (s[3] === undefined ? [] : [s[3]]));
  const startupS = measured.length ? median(measured) : base.startupS;
  if (!mine.length) return { backend: where, startupS, rate: base.rate, runs: 0 };
  const rate = median(
    mine.map(([audio, wall, , own]) => Math.max(MIN_RATE, (wall - (own ?? startupS)) / audio)),
  );
  return { backend: where, startupS, rate, runs: mine.length };
}

/** Both backends, for a decision that depends on which one runs. */
export function paceBook(samples: readonly PaceSample[], os: HostOs = hostInfo().os): PaceBook {
  return { gpu: paceModel(samples, "gpu", os), cpu: paceModel(samples, "cpu", os) };
}

/** The backend a run started now would use: the processor while the chip is held after a crash;
 *  otherwise the one the machine's latest run used (a PC with no usable chip is judged by its own
 *  processor runs, not by a chip it does not have); with no run yet, the chip, except on Linux where
 *  the engine has none. */
export function backendNow(
  samples: readonly PaceSample[],
  os: HostOs = hostInfo().os,
  held: boolean = cpuOnlyNow(),
): SpeechBackend {
  if (held) return "cpu";
  for (let i = (Array.isArray(samples) ? samples.length : 0) - 1; i >= 0; i--) {
    const s = cleanSample(samples[i]);
    if (s) return s[2];
  }
  return os === "linux" ? "cpu" : "gpu";
}

/** The model of the backend that would run now, on this machine's own history. */
export function currentPaceModel(
  samples: readonly PaceSample[] = readPace(),
  os: HostOs = hostInfo().os,
): PaceModel {
  return paceModel(samples, backendNow(samples, os), os);
}

/** About how many seconds `audioSeconds` of speech takes under `model`, start-up included: never
 *  under the start-up, never shrinking with more speech. A length that is not a number is none. */
export function projectedS(
  model: Pick<PaceModel, "startupS" | "rate">,
  audioSeconds: number,
): number {
  const audio = finite(audioSeconds) ? Math.min(MAX_AUDIO_S, Math.max(0, audioSeconds)) : 0;
  return model.startupS + model.rate * audio;
}

/** The longest span, in whole seconds of audio, whose projected time under `model` is at most
 *  `capS`; 0 when not even {@link MIN_SPAN_S} fits (a PC so slow that nothing is worth offering, which
 *  the caller says in words). It fits, and one more second would not. */
export function spanLimitS(model: Pick<PaceModel, "startupS" | "rate">, capS: number): number {
  if (!finite(capS) || !(model.rate > 0)) return 0;
  const room = capS - model.startupS;
  if (!(room > 0)) return 0;
  let limit = Math.min(MAX_AUDIO_S, Math.floor(room / model.rate));
  // The quotient can be a second off either way in floating point: settle it against projectedS itself.
  for (let i = 0; i < 3 && limit < MAX_AUDIO_S && projectedS(model, limit + 1) <= capS; i++)
    limit++;
  for (let i = 0; i < 3 && limit > 0 && projectedS(model, limit) > capS; i++) limit--;
  return limit >= MIN_SPAN_S ? limit : 0;
}

/** Seconds of work per second of audio, beyond the start-up, for `backend` (default: the one that
 *  would run now). */
export function secondsPerAudioSecond(
  samples: readonly PaceSample[],
  os: HostOs = hostInfo().os,
  backend: SpeechBackend = backendNow(samples, os),
): number {
  return paceModel(samples, backend, os).rate;
}

/** About how many seconds `audioSeconds` of speech takes to transcribe here, start-up included, as a
 *  whole number: on `backend` (default: the one that would run now). */
export function estimateTranscribeSeconds(
  audioSeconds: number,
  samples: readonly PaceSample[] = readPace(),
  os: HostOs = hostInfo().os,
  backend: SpeechBackend = backendNow(samples, os),
): number {
  return Math.round(projectedS(paceModel(samples, backend, os), audioSeconds));
}
