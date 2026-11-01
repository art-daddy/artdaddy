// Waiting for a transcript inside a tool call, for at most as long as the caller allows.
//
// A look used to wait for the speech model to download AND for the engine to finish, with no
// limit: one turn took 81 minutes, four looks at once all waiting on a 465 MB download at under
// 1 Mbit/s. The rule now is that a call answers within its bound whatever is slow underneath, says
// what is still pending and about how long it should take, and leaves the work running, so the next
// call finds the words in the cache.
import { settledWithin } from "../lib/settledWithin";
import { hostInfo, type HostOs } from "../platform/host";
import { downloadEtaSeconds, percent, useModelDownload } from "../store/modelDownload";
import {
  classifyTranscriptFailure,
  FAILURE_ADVICE,
  type TranscriptFailureReason,
} from "./speechFailure";
import { estimateTranscribeSeconds, readPace, type PaceSample } from "./speechPace";

/** How long a look waits for what is not ready, when the caller does not say. */
export const WAIT_DEFAULT_S = 15;
/** The longest a look may be asked to wait (the same as get_transcript's wait). */
export const WAIT_MAX_S = 60;
/** An estimate past this is a guess about nothing: say so by saying no more than this. */
const MAX_ETA_S = 3600;

/** The wait the caller asked for (`wait_seconds`), in ms: 0 to {@link WAIT_MAX_S}, where 0 starts
 *  the work and does not wait. Absent, not a number, or negative is the default: a caller that
 *  said nothing sensible still gets the same bounded call as one that said nothing. */
export function waitBoundMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return WAIT_DEFAULT_S * 1000;
  return Math.round(Math.min(WAIT_MAX_S, raw) * 1000);
}

export interface InProgressTranscript {
  status: "in_progress";
  stage: "transcribing" | "downloading_speech_model";
  /** How long this call waited before answering. */
  waited_s: number;
  /** About how long is left; absent when it cannot be told yet. */
  eta_s?: number;
  /** How far the speech model's download is, while that is what is pending. */
  progress_pct?: number;
  note: string;
}

export interface FailedTranscript {
  status: "failed";
  reason: TranscriptFailureReason;
  error: string;
  note: string;
}

export type WaitOutcome<T> =
  | { kind: "done"; value: T }
  | { kind: "pending"; status: InProgressTranscript }
  | { kind: "failed"; status: FailedTranscript }
  | { kind: "cancelled" };

/** Why a transcription failed, as the result a look carries: a reason code, the sentence, and what
 *  to do about it. Never prose alone: the model reads the code, the person reads the sentence. */
export function failedTranscript(error: unknown): FailedTranscript {
  const { reason, message } = classifyTranscriptFailure(error);
  return { status: "failed", reason, error: message, note: FAILURE_ADVICE[reason] };
}

export interface DownloadProgress {
  pct: number;
  etaS: number | null;
}

/** The speech model's download, when one is under way. */
export function modelDownloadNow(): DownloadProgress | null {
  const s = useModelDownload.getState();
  return s.total > 0 ? { pct: percent(s.received, s.total), etaS: downloadEtaSeconds(s) } : null;
}

export interface WaitRequest<T> {
  /** One per transcript wanted: two calls with the same key are one piece of work. */
  key: string;
  /** The speech to be transcribed, in seconds; null when it is not known. */
  audioSeconds: number | null;
  /** That length as a person reads it ("2:30"), for the note. */
  audioLabel: string;
  /** The run, started or joined by the caller. It keeps going whatever this call does. */
  run: Promise<T>;
  /** At most this long (ms) is waited. */
  boundMs: number;
  signal?: AbortSignal;
  progress?: () => DownloadProgress | null;
  now?: () => number;
  samples?: readonly PaceSample[];
  os?: HostOs;
}

/** Transcriptions being waited on, in the order they were asked for. A look's engine runs one look
 *  at a time (workGate.ts), so what one still has to wait for is the work ahead of it and its own. */
interface Look {
  audio: number;
  startedAt: number;
}
const looks = new Map<string, Look>();

/** The seconds of work in the queue up to and including `key`, and when the first of it began. */
function queuedWork(
  key: string,
  samples: readonly PaceSample[],
  os: HostOs,
): { work: number; since: number } | null {
  let work = 0;
  let since = Infinity;
  for (const [k, look] of looks) {
    work += estimateTranscribeSeconds(look.audio, samples, os);
    since = Math.min(since, look.startedAt);
    if (k === key) return { work, since };
  }
  return null;
}

const clampEta = (s: number): number => Math.min(MAX_ETA_S, Math.max(1, Math.round(s)));

const DO_NOT_GUESS =
  "Do not guess or describe what is said. The frames, metadata and loudness in this result are final. " +
  "Call inspect_media again with the same arguments: it returns the words at once when they are done, " +
  "or pass wait_seconds (up to 60) to wait for them.";

function inProgressNote(
  stage: InProgressTranscript["stage"],
  label: string,
  eta: number | undefined,
  waited: number,
  pct: number | undefined,
): string {
  const left = eta === undefined ? "" : `, about ${eta} s to go`;
  if (stage === "downloading_speech_model")
    return (
      `The transcript is not ready: the speech model is still downloading (${pct ?? 0}%${left}). ` +
      `This one-time download happens the first time speech is transcribed on this computer, and ` +
      `the transcription starts when it ends. ${DO_NOT_GUESS} Tell the user the speech model is downloading.`
    );
  const took = waited > 0 ? ` (this call waited ${waited} s)` : "";
  return (
    `The transcript is not ready: the speech in this ${label} of audio is still being transcribed${left}${took}. ` +
    `${DO_NOT_GUESS} Tell the user it is still being transcribed.`
  );
}

/** Wait for `run` for at most `boundMs`: its value, or what is pending, or why it failed. The run
 *  is never stopped by the wait ending; only the caller's `signal` (Stop) ends the call early. */
export async function waitForRun<T>(req: WaitRequest<T>): Promise<WaitOutcome<T>> {
  const now = req.now ?? Date.now;
  const began = now();
  // A failure must reach us as a value: settledWithin reads a rejection as a timeout.
  const settled = req.run.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (!looks.has(req.key)) {
    const look: Look = { audio: req.audioSeconds ?? 0, startedAt: began };
    looks.set(req.key, look);
    void settled.then(() => {
      if (looks.get(req.key) === look) looks.delete(req.key);
    });
  }
  const got = await settledWithin(settled, req.boundMs, req.signal);
  if (req.signal?.aborted) return { kind: "cancelled" };
  if (got?.ok) return { kind: "done", value: got.value };
  if (got) return { kind: "failed", status: failedTranscript(got.error) };

  const samples = req.samples ?? readPace();
  const os = req.os ?? hostInfo().os;
  const download = (req.progress ?? modelDownloadNow)();
  const waited = Math.round((now() - began) / 1000);
  const queued = req.audioSeconds === null ? null : queuedWork(req.key, samples, os);
  let eta: number | undefined;
  if (queued) {
    if (!download) {
      // Past its estimate a run is not "about done": say at least half again what it has taken,
      // or the answer would be "1 s" at every call until it finished.
      const elapsed = (now() - queued.since) / 1000;
      eta = clampEta(Math.max(queued.work - elapsed, elapsed / 2));
    } else if (download.etaS !== null) eta = clampEta(download.etaS + queued.work);
  }
  const stage = download ? "downloading_speech_model" : "transcribing";
  return {
    kind: "pending",
    status: {
      status: "in_progress",
      stage,
      waited_s: waited,
      ...(eta === undefined ? {} : { eta_s: eta }),
      ...(download ? { progress_pct: download.pct } : {}),
      note: inProgressNote(stage, req.audioLabel, eta, waited, download?.pct),
    },
  };
}

/** Tests only. */
export function __resetWaiting(): void {
  looks.clear();
}
