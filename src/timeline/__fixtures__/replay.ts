import { notePace, startPace, type TimeLeft } from "../exportTimeLeft";
import { fractionOf, realLeftSeconds, type ReplayRun } from "./timeLeftRuns";

// Replays a recorded run through the live time-left rule, one report per sample, and keeps what the rule said at each one.
// Shared by the replay test and by any wiring test that wants the rule's answer for a real feed.

export interface ReplayRecord {
  /** When the report arrived, ms since the run began. */
  readonly atMs: number;
  /** The share of the video made, as handed to the rule (0 to 1). */
  readonly fraction: number;
  /** What the rule said after this report. */
  readonly value: TimeLeft;
  /** How long the run really still had to go, in seconds. */
  readonly realLeft: number;
}

export function replayRun(run: ReplayRun): ReplayRecord[] {
  let state = startPace();
  return run.samples.map(([atMs, outMs]) => {
    const fraction = fractionOf(run, outMs);
    state = notePace(state, { at: atMs, fraction });
    return { atMs, fraction, value: state.value, realLeft: realLeftSeconds(run, atMs) };
  });
}

/** The same run with a constant added to every arrival time. */
export function shifted(run: ReplayRun, byMs: number): ReplayRun {
  return {
    ...run,
    endMs: run.endMs + byMs,
    samples: run.samples.map(([at, out]) => [at + byMs, out] as const),
  };
}

/** The same run reported half as often: every second report dropped, the first and the last kept. */
export function coarser(run: ReplayRun): ReplayRun {
  const last = run.samples.length - 1;
  return { ...run, samples: run.samples.filter((_, i) => i % 2 === 0 || i === last) };
}

/**
 * The same run until `fromShare` of the video is made, then `factor` times slower: the time axis after that point is stretched
 * and the positions are kept, so the real run's own wobble stays and only its speed changes.
 */
export function slowedFrom(run: ReplayRun, fromShare: number, factor: number): ReplayRun {
  let best = 0;
  let pivot = -1;
  for (let i = 0; i < run.samples.length; i++) {
    best = Math.max(best, fractionOf(run, run.samples[i][1]));
    if (best >= fromShare) {
      pivot = i;
      break;
    }
  }
  if (pivot < 0) return run;
  const origin = run.samples[pivot][0];
  const stretch = (at: number): number => Math.round(origin + (at - origin) * factor);
  return {
    ...run,
    endMs: stretch(run.endMs),
    samples: run.samples.map(([at, out], i) => [i <= pivot ? at : stretch(at), out] as const),
  };
}
