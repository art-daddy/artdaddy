// The speech jobs this app is running, has queued or has just stopped, as the status-bar chip shows them
// (S2-04 = D). The engine side (transcribe.ts, indexCoordinator.ts, the monitor) writes; the chip
// (SpeechChip.tsx) reads. LOCAL ONLY: nothing in here is sent anywhere (T1-10 = C: the client sends no
// new fact), and nothing is stored on disk.
import { create } from "zustand";

import type { SpeechBackend } from "../tools/speechPace";

/** What asked for the run: the background indexer's whole file, or a request for words. */
export type SpeechPurpose = "index" | "captions" | "look" | "transcript";

/** `waiting`: queued, nothing started (its turn has not come, or an export is running).
 *  `starting`: the engine was launched and has said no word yet, so NO time is claimed.
 *  `running`: words are coming, so speed and time left are measured.
 *  `stopped`: ended by the person or by the live check; kept for a few seconds so the person is told. */
export type SpeechPhase = "waiting" | "starting" | "running" | "stopped";

/** `cancelled`: the person pressed Cancel. `too_slow`: the live check stopped a whole-file run whose
 *  projection passed twice the cap. */
export type SpeechStop = "cancelled" | "too_slow";

/** Every fact the app holds about why a run is slow (`slowNote` reads these and nothing else). */
export interface SpeechFacts {
  /** The backend that runs it; null until the engine's own log says. */
  backend: SpeechBackend | null;
  /** An earlier crash of the graphics chip keeps it off (`cpuOnlyNow()`). */
  gpuHeld: boolean;
  /** The engine said it found no graphics chip it can use. */
  noGpu: boolean;
  /** Logical processors (`navigator.hardwareConcurrency`); null when unknown. */
  cores: number | null;
  /** Threads the run was given (`-t`); null when unknown. */
  threads: number | null;
  /** An export is queued or running (`workGate.ts`). */
  exportsBusy: boolean;
}

/** What one run reads, so work that was asked for can be matched to the run that does it (a wake batch names
 *  files; a run is a job). LOCAL: never shown and never sent. */
export interface SpeechWorkItem {
  /** The absolute path of the media file the run reads. */
  source: string;
  /** The language as `transcriptWait` keys it (`normLanguage`): "" is the default. */
  language: string;
  /** Source seconds; null is the whole file. */
  window: { start: number; end: number | null } | null;
}

export interface SpeechJob {
  /** The supervisor's job id for a run that has started; a queue id for one that has not. Stable. */
  id: string;
  purpose: SpeechPurpose;
  /** What the person calls the file (its name); shown on this PC only. */
  label: string;
  /** What the run reads: one item, or one per file for a run over several files. Empty for a job that is
   *  only waiting: its file is resolved when its turn comes. */
  work: readonly SpeechWorkItem[];
  /** Seconds of audio the run covers: the whole file, or its window. Null when not known. */
  spanS: number | null;
  phase: SpeechPhase;
  stop: SpeechStop | null;
  /** Epoch ms. */
  enqueuedAt: number;
  startedAt: number | null;
  firstWordsAt: number | null;
  endedAt: number | null;
  /** Seconds of audio transcribed so far. */
  doneS: number;
  /** Seconds of work per second of audio since the first words; null until measured. */
  rate: number | null;
  /** Seconds left at that rate; null until measured: never a guess before audio moves. */
  etaS: number | null;
  facts: SpeechFacts;
}

/** How long a stopped job stays in the list so that the person is told what happens next. */
export const STOPPED_SHOWN_MS = 8_000;

export type SpeechEnd = "done" | "failed" | SpeechStop;

interface SpeechJobsState {
  jobs: SpeechJob[];
  /** Adds a job, or replaces the one with the same id. */
  add: (job: SpeechJob) => void;
  /** Merges into one job (its `facts` merge field by field); a job that is not there is left alone. */
  patch: (
    id: string,
    patch: Partial<Omit<SpeechJob, "id" | "facts">> & { facts?: Partial<SpeechFacts> },
  ) => void;
  /** The run ended. A finished or failed run leaves the list; a stopped one stays, as `stopped`. */
  end: (id: string, how: SpeechEnd, at: number) => void;
  dismiss: (id: string) => void;
  /** Removes stopped jobs older than {@link STOPPED_SHOWN_MS}. The chip calls it on its own tick. */
  prune: (now: number) => void;
}

export const useSpeechJobs = create<SpeechJobsState>((set) => ({
  jobs: [],
  add: (job) => set((s) => ({ jobs: [...s.jobs.filter((j) => j.id !== job.id), job] })),
  patch: (id, patch) =>
    set((s) => ({
      jobs: s.jobs.map((j) =>
        j.id === id ? { ...j, ...patch, facts: { ...j.facts, ...patch.facts } } : j,
      ),
    })),
  end: (id, how, at) =>
    set((s) => ({
      jobs:
        how === "done" || how === "failed"
          ? s.jobs.filter((j) => j.id !== id)
          : s.jobs.map((j) =>
              j.id === id ? { ...j, phase: "stopped", stop: how, endedAt: at, etaS: null } : j,
            ),
    })),
  dismiss: (id) => set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) })),
  prune: (now) =>
    set((s) => {
      const kept = s.jobs.filter(
        (j) => !(j.phase === "stopped" && (j.endedAt ?? 0) + STOPPED_SHOWN_MS <= now),
      );
      return kept.length === s.jobs.length ? s : { jobs: kept };
    }),
}));

const cancellers = new Map<string, () => void>();

/** The engine registers how to stop ONE run; the chip's Cancel calls it. Returns the way to withdraw it
 *  (call it when the run ends). */
export function registerCanceller(id: string, cancel: () => void): () => void {
  cancellers.set(id, cancel);
  return () => {
    if (cancellers.get(id) === cancel) cancellers.delete(id);
  };
}

/** Cancel one job, and only that one. False when nothing can stop it (it has ended, or never started). */
export function cancelSpeechJob(id: string): boolean {
  const cancel = cancellers.get(id);
  if (!cancel) return false;
  cancel();
  return true;
}

/** How long a job that has just stopped is shown before a run that is going (see {@link chipJob}): long enough
 *  for the person to read what their click did, and for a double click to be over before the next run's Cancel
 *  takes the place of the one that was pressed. */
export const JUST_STOPPED_MS = 3_000;

const goingOnly = (jobs: readonly SpeechJob[]): SpeechJob[] =>
  jobs.filter((j) => j.phase === "starting" || j.phase === "running");

/** The job the chip shows. In this order:
 *  1. a job that stopped less than {@link JUST_STOPPED_MS} ago (the latest), when `now` is given: the person
 *     sees what their click did, and no other run's Cancel is under their pointer in its place;
 *  2. a run that is going: one a request made (captions, a look, a transcript) before the indexer's own, the
 *     one started first of each, so the person's own request is never out of reach behind a long run of the
 *     indexer;
 *  3. the job that stopped (the latest); 4. the first one waiting.
 *  Null when there is nothing to show. */
export function chipJob(jobs: readonly SpeechJob[], now?: number): SpeechJob | null {
  const stopped = jobs
    .filter((j) => j.phase === "stopped")
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  if (now !== undefined && stopped[0] && now - (stopped[0].endedAt ?? 0) < JUST_STOPPED_MS)
    return stopped[0];
  const going = goingOnly(jobs).sort(
    (a, b) => (a.startedAt ?? a.enqueuedAt) - (b.startedAt ?? b.enqueuedAt),
  );
  const first = going.find((j) => j.purpose !== "index") ?? going[0];
  if (first) return first;
  if (stopped[0]) return stopped[0];
  return (
    [...jobs].filter((j) => j.phase === "waiting").sort((a, b) => a.enqueuedAt - b.enqueuedAt)[0] ??
    null
  );
}

/** How many jobs are waiting besides the one shown ("N more waiting"). */
export function waitingBesides(jobs: readonly SpeechJob[], shown: SpeechJob | null): number {
  return jobs.filter((j) => j.phase === "waiting" && j.id !== shown?.id).length;
}

/** How many runs are going besides the one shown ("N more running"): Cancel in the popover reaches the one it
 *  shows, and the person is told that others are going. */
export function goingBesides(jobs: readonly SpeechJob[], shown: SpeechJob | null): number {
  return goingOnly(jobs).filter((j) => j.id !== shown?.id).length;
}

/** Tests only. */
export function __resetSpeechJobs(): void {
  useSpeechJobs.setState({ jobs: [] });
  cancellers.clear();
}
