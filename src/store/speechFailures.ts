// The background transcriptions that failed, as the status bar shows them. A failed one used to be reported to us
// (app_error) and told to nobody: footage that was never transcribed reads as footage with no speech. The indexer
// writes this list (indexCoordinator.ts); the status bar's failure item (StatusBar.tsx) reads it and offers Retry.
// LOCAL ONLY: the file's name and the engine's own words stay on this PC. What is sent is the app_error report the
// indexer already makes for the same failure, which carries no file name; nothing here adds to it.
import { create } from "zustand";

import type { TranscriptFailureReason } from "../tools/speechFailure";

/** The speech engine's own failure, which is not one file's. */
export const ENGINE_FAILURE_ID = "engine";

export interface SpeechFailure {
  /** One per piece of work that failed: writing it again (another attempt) replaces it. */
  id: string;
  /** The project whose indexer it is: where Retry goes, and what closing the project takes away. */
  owner: string;
  /** What the person calls the file; null for the engine. */
  label: string | null;
  reason: TranscriptFailureReason;
  /** The error as the engine or the app gave it, for the tooltip. */
  message: string;
  /** Epoch ms of the latest failure. */
  at: number;
  /** How many times it has been tried. */
  attempts: number;
  /** The indexer tries it again by itself the next time the project opens or changes. */
  willRetry: boolean;
}

interface SpeechFailuresState {
  failures: SpeechFailure[];
  /** Adds a failure, or replaces the one of the same project and id. */
  record: (failure: SpeechFailure) => void;
  /** The work succeeded or was started again: its failure is no longer true. */
  clear: (owner: string, id: string) => void;
  /** The project closed: nothing of it can be retried any more. */
  clearOwner: (owner: string) => void;
  /** The person closed the notice. The work is left as it is. */
  dismissAll: () => void;
}

const same = (a: SpeechFailure, owner: string, id: string): boolean =>
  a.owner === owner && a.id === id;

export const useSpeechFailures = create<SpeechFailuresState>((set) => ({
  failures: [],
  record: (failure) =>
    set((s) => ({
      failures: [...s.failures.filter((f) => !same(f, failure.owner, failure.id)), failure],
    })),
  clear: (owner, id) =>
    set((s) => {
      const kept = s.failures.filter((f) => !same(f, owner, id));
      return kept.length === s.failures.length ? s : { failures: kept };
    }),
  clearOwner: (owner) =>
    set((s) => {
      const kept = s.failures.filter((f) => f.owner !== owner);
      return kept.length === s.failures.length ? s : { failures: kept };
    }),
  dismissAll: () => set((s) => (s.failures.length === 0 ? s : { failures: [] })),
}));

const retriers = new Map<string, (failure: SpeechFailure) => void>();

/** A project's indexer registers how to put one failed piece of work back. Returns the way to withdraw it, which only
 *  withdraws this registration: a project reopened before the old one finished closing keeps the new one. */
export function registerSpeechRetrier(
  owner: string,
  retry: (failure: SpeechFailure) => void,
): () => void {
  retriers.set(owner, retry);
  return () => {
    if (retriers.get(owner) === retry) retriers.delete(owner);
  };
}

/** Try everything on the list again: the engine first (a file cannot run before it can), then the files, each by the
 *  indexer that owns it. A piece of work leaves the list as it is started again, and one that fails again is
 *  written again by the indexer. Returns how many were started again. */
export function retrySpeechFailures(): number {
  const all = useSpeechFailures.getState().failures;
  const engineFirst = [...all].sort(
    (a, b) => Number(b.id === ENGINE_FAILURE_ID) - Number(a.id === ENGINE_FAILURE_ID),
  );
  let started = 0;
  for (const failure of engineFirst) {
    const retry = retriers.get(failure.owner);
    if (!retry) continue;
    retry(failure);
    started += 1;
  }
  return started;
}

/** Tests only. */
export function __resetSpeechFailures(): void {
  useSpeechFailures.setState({ failures: [] });
  retriers.clear();
}
