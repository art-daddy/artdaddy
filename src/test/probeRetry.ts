// A browser probe that never finishes is an environment stall, not a verdict. macos-14's Chrome
// stalled twice in three runs (2026-10-25): once on a control that waits for a video frame that
// never came, once so early the page never reported a stage. Every test in the spec then failed
// together, because they all read one shared probe run. The probe itself is bounded now; this is
// for the stall nobody can bound from inside the page.

/** The probe page did not report a result in time. `stage` is the last thing it said it was doing. */
export class ProbeStalled extends Error {
  constructor(
    message: string,
    readonly stage: string,
  ) {
    super(message);
    this.name = "ProbeStalled";
  }
}

/** Runs `attempt`, and again after `onStall` while it stalls, up to `tries` attempts in all.
 *
 *  Only a stall is retried. Any other error is a verdict about the code under test and is thrown at
 *  once; a probe that stalls on EVERY try is a real failure and is thrown as the last stall, so a
 *  hang that always happens still fails. `onStall` runs between attempts, never after the last one:
 *  it is where the caller replaces the page the stalled attempt left in an unknown state. */
export async function retryStalledProbe<T>(
  attempt: (tryNumber: number) => Promise<T>,
  onStall: (stalled: ProbeStalled, tryNumber: number) => Promise<void>,
  tries = 2,
): Promise<T> {
  for (let tryNumber = 1; ; tryNumber++) {
    try {
      return await attempt(tryNumber);
    } catch (error) {
      if (!(error instanceof ProbeStalled) || tryNumber >= tries) throw error;
      await onStall(error, tryNumber);
    }
  }
}

/** What a seek probe (src/preview/__probeStream.ts) reports. Only what telling a stall from a
 *  wrong picture needs, so this stays free of the browser-side module. */
export interface SeekReport {
  shots: ReadonlyArray<{
    time: number;
    pixel: ReadonlyArray<number>;
    matched: boolean;
    waitedMs: number;
  }>;
  errors: ReadonlyArray<string>;
}

// Nothing came back, or the canvas still holds the opaque black it starts with.
const drewNothing = (pixel: ReadonlyArray<number>) => pixel.slice(0, 3).every((v) => v === 0);

/** The first seek that showed nothing, when showing nothing is ALL that went wrong; null otherwise.
 *
 *  macos-14's decoders stall, and then the preview draws nothing: a blank canvas or no picture at
 *  all, on the worker and on the main thread alike (CI runs of 2026-10-20 and 2026-10-27). That is
 *  an environment stall and is asked again on a fresh page. A WRONG picture (the stale frame a
 *  backward seek used to leave), any error the preview reported, or a wrong picture next to a blank
 *  one is a verdict about the code under test and is never a stall. */
export function seekStall(report: SeekReport): { time: number; waitedMs: number } | null {
  if (report.errors.length > 0) return null;
  const missed = report.shots.filter((shot) => !shot.matched);
  if (missed.length === 0 || !missed.every((shot) => drewNothing(shot.pixel))) return null;
  return { time: missed[0].time, waitedMs: missed[0].waitedMs };
}
