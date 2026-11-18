import runs from "./timeLeftRuns.json";

// Recorded progress of real export runs, kept by the export-timing lab: ffmpeg's `-progress` positions with the time
// each report arrived. The numbers are the raw ones (every report of the run, at the report cadence of about half a second;
// never smoothed, shifted or repaired); each run's `source` names the lab folder it was copied from. Used to replay the live
// time-left rule against what really happened.

/** The encoder of the run's command: the processor at its normal setting, the processor at its light setting, or the graphics chip. */
export type ReplayRoute = "x264" | "x264-light" | "chip";

export interface ReplayRun {
  /** The lab's run id: project, PC profile, block, segment, position. */
  readonly id: string;
  /** What the project was (a plain slug, for example `phone-reel-plain-cuts`). */
  readonly kind: string;
  readonly route: ReplayRoute;
  /** Which of the two export choices the command belongs to, or null for a lab experiment that is neither. */
  readonly choice: "quality" | "fast" | null;
  /** The lab's PC profile: `STRONG` (all 16 threads) or `WEAK4` (4 threads, memory held). */
  readonly pc: string;
  /** The length of the delivered video: the 100 % of the progress. */
  readonly videoSeconds: number;
  /** When the run's last report arrived, in ms since the run began. */
  readonly endMs: number;
  /** The run's folder under the lab's runs folder. */
  readonly source: string;
  /** `[arrival in ms since the run began, render position in ms]`; 0 is "no picture yet" and a small negative position (ffmpeg's first
   *  frame of some runs) is kept as recorded and counts as 0 %. */
  readonly samples: ReadonlyArray<readonly [number, number]>;
}

export const REPLAY_RUNS: readonly ReplayRun[] = runs as unknown as readonly ReplayRun[];

/** The share of the video made at a render position: 0 to 1. */
export function fractionOf(run: Pick<ReplayRun, "videoSeconds">, outMs: number): number {
  const share = outMs / (run.videoSeconds * 1000);
  return Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0;
}

/** How long the run still had to go at a moment, in seconds: what a person would really have waited. */
export function realLeftSeconds(run: Pick<ReplayRun, "endMs">, atMs: number): number {
  return (run.endMs - atMs) / 1000;
}
