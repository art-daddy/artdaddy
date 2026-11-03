// Which queued clips share one run of the speech engine (T-34 step 3).
//
// Every run of the engine costs a start-up that no clip shortens: it loads the model and encodes a
// whole 30 s window even for a 5 s clip. Measured with the shipped engine, six short clips took 13.6 s as
// six runs and 4.1 s as one run over six files, with identical words. The cost of a batch is that its
// clips are only done together, so what goes into one is bounded:
//   * a clip somebody is waiting on, a stretch of a file, a different language and a clip whose length is
//     not known all run alone: they must not wait for, or be mixed with, anything else;
//   * a batch is sized to take about BATCH_TARGET_S on THIS machine, from its own measured pace, so a
//     look that asks for the next clip is held up by seconds, not minutes, and a slow CPU takes smaller
//     batches than a GPU;
//   * never more than BATCH_MAX_FILES, so the engine's output stays within what the job supervisor keeps.
// Pure: the queue is in, the places of the clips to take are out.
import { hostInfo, type HostOs } from "../platform/host";
import { secondsPerAudioSecond, STARTUP_S, type PaceSample } from "./speechPace";

export const BATCH_MAX_FILES = 8;
/** How long one batch is meant to take, engine start-up included. */
export const BATCH_TARGET_S = 12;
/** How far into the queue a batch looks for clips to take along: enough to pass over a few that do not fit. */
export const BATCH_LOOKAHEAD = 16;

/** What decides, before its length is known, whether a queued clip may share a run. */
export type BatchFlags = Pick<BatchCandidate, "language" | "windowed" | "urgent">;

/** One queued transcription, as far as batching is concerned. */
export interface BatchCandidate {
  /** The language asked for ("" = detect it). Only clips asking for the same one share a run. */
  language: string;
  /** A stretch of the file rather than all of it. */
  windowed: boolean;
  /** Somebody is waiting on this one: it goes first and alone. */
  urgent: boolean;
  /** The clip's length in seconds; null or 0 when it could not be measured. */
  seconds: number | null;
}

/** The most audio one batch may hold on this machine: what fits in BATCH_TARGET_S after the start-up. */
export function batchAudioCapSeconds(
  samples: readonly PaceSample[],
  os: HostOs = hostInfo().os,
): number {
  return Math.max(0, (BATCH_TARGET_S - STARTUP_S) / secondsPerAudioSecond(samples, os));
}

/** Whether `c` could share a run with `head`, whatever its length turns out to be: a clip for which this is
 *  false is never worth measuring for the batch `head` starts. `head` itself passes only if it may be in a
 *  batch at all. */
export function couldShare(head: BatchFlags, c: BatchFlags): boolean {
  return !head.windowed && !head.urgent && !c.windowed && !c.urgent && c.language === head.language;
}

const measured = (c: BatchCandidate): c is BatchCandidate & { seconds: number } =>
  c.seconds !== null && Number.isFinite(c.seconds) && c.seconds > 0;

/** The places in `queue` of the clips to run together, the first clip always among them. `capSeconds` is the
 *  audio one batch may hold ({@link batchAudioCapSeconds}). A clip that does not fit is passed over, not
 *  waited for, and stays where it is for a later batch. */
export function pickBatch(queue: readonly BatchCandidate[], capSeconds: number): number[] {
  if (queue.length === 0) return [];
  const head = queue[0];
  if (!couldShare(head, head) || !measured(head) || head.seconds > capSeconds) return [0];
  const picked = [0];
  let total = head.seconds;
  for (let i = 1; i < queue.length && picked.length < BATCH_MAX_FILES; i++) {
    const c = queue[i];
    if (!couldShare(head, c) || !measured(c) || total + c.seconds > capSeconds) continue;
    picked.push(i);
    total += c.seconds;
  }
  return picked;
}
