// Types for timing.mjs, the one implementation of the shared timing helper (its interface is documented in timing.ts).
export const TIMING_FILE_ENV: "ARTDADDY_TIMING_FILE";
export const BUILD_ENV: "ARTDADDY_BUILD";

/** One line of the results file. */
export interface TimingEntry {
  /** The wait, named as timing.ts says; the key of its budget in e2e/timing-budgets.json. */
  scenario: string;
  /** How long it took, in whole milliseconds. */
  ms: number;
  /** The host name of the machine that ran it. */
  machine: string;
  /** ARTDADDY_BUILD, else the checkout's git commit (with "+dirty" when tracked files were changed). */
  build: string;
  /** When the wait began, ISO 8601 UTC. */
  at: string;
}

export interface Timer {
  /** Records the wait from startTimer() to now and returns the line written. A second call throws. */
  stop(): TimingEntry;
}

export function timingFile(env?: Record<string, string | undefined>, now?: Date): string;
export function measure<T>(scenario: string, fn: () => T | PromiseLike<T>): Promise<T>;
export function startTimer(scenario: string): Timer;
export function record(scenario: string, ms: number): TimingEntry;
