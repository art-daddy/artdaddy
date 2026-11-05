// The plan: how gentle an export runs so that it fits the PC. Pure; nothing here reads the PC, builds a
// command or starts anything, so every rule is testable without an export.
//
// A rung is a way of doing the same work with less memory at a cost in time:
//   0 normal    ffmpeg's own thread counts (today's command, byte for byte)
//   1 gentle    two decoder threads and two encoder threads
//   2 gentlest  one decoder thread and two encoder threads
// Lab, 8K HEVC to 1080x1920 (exporter document 8.2): 3.52 GiB in 22.7 s, 0.83 GiB in 39.4 s, 0.76 GiB in
// 52.5 s. A rung changes how the work is done, never what is made.
//
// The rule is "the fastest rung that fits": the first whose predicted peak is under the ceiling. The
// prediction comes from this PC's own history of the same shape; with none, the export runs at the fastest
// rung unless the PC has less than a small reserve free (XR-21), because a first export has nothing to
// learn from and a guess must not slow every ordinary export down. The reserve is what the gentlest rung
// needs, so below it the export runs at the gentlest (XR-28).

export type Rung = 0 | 1 | 2;
export const RUNG_NAMES = ["normal", "gentle", "gentlest"] as const;

/** The rungs an export really has: each is a different command from the one before it in the list, and the list always
 *  begins with the normal rung. A graphics encoder takes no thread cap, so with nine to twelve clips rung 1 is the same
 *  command as rung 0 and the ladder is [0, 2]; the streamed engine has only [0]. The plan never counts on, and Try
 *  again never promises, a rung that is not on it. */
export type Ladder = readonly Rung[];

const isLadderRung = (value: unknown): value is Rung => value === 0 || value === 1 || value === 2;

/** A ladder as the plan reads it: only real rungs, each once, gentlest last, and never empty. */
export function cleanLadder(ladder: Ladder): Ladder {
  const rungs = [...new Set(ladder.filter(isLadderRung))].sort((a, b) => a - b);
  return rungs.length ? rungs : [0];
}

/** The ladder with no gaps up to `last`: what every export had before gaps existed. */
export function denseLadder(last: number | undefined): Ladder {
  const top = last === undefined ? 2 : rungOf(last);
  return ([0, 1, 2] as const).filter((rung) => rung <= top);
}

export const GIB = 1024 ** 3;

/** The share of the PC's free memory an export may use together (the owner chose 75%). */
export const CEILING_SHARE = 0.75;
/** The most an export may use. The native watcher stops an export at its own cap of the same size
 *  (`RENDER_RESIDENT_CEILING`), so a plan never counts on more than the watcher allows. */
export const CEILING_CAP_BYTES = 8 * GIB;
/** What an export with no measurement needs free (XR-21): it covers the heaviest gentlest-rung peak the lab
 *  measured (1.3 GiB, 8K HEVC) with about half to spare; ordinary clips need 0.5 to 1.3 GiB. */
export const UNMEASURED_RESERVE_BYTES = 2e9;

export function ceilingBytes(freeBytes: number): number {
  return Math.min(Math.max(0, freeBytes) * CEILING_SHARE, CEILING_CAP_BYTES);
}

/** What a rung allows a command to use: decoder frame threads per video input and x264 threads (null: no
 *  cap, ffmpeg's own choice). A cap only ever lowers a count; see {@link capThreads}. */
export const RUNG_THREAD_CAPS: readonly {
  readonly decoder: number | null;
  readonly encoder: number | null;
}[] = [
  { decoder: null, encoder: null },
  { decoder: 2, encoder: 2 },
  { decoder: 1, encoder: 2 },
];

/** A thread count under a cap: never above the count it already had (null is "ffmpeg decides"), so a
 *  command that was already frugal (many inputs, the streamed engine) is not made hungrier by a rung. */
export function capThreads(base: number | null, cap: number | null): number | null {
  if (cap === null) return base;
  return base === null ? cap : Math.min(base, cap);
}

/** The rung a value names; anything that is not 0, 1 or 2 is the normal rung. */
export function rungOf(value: unknown): Rung {
  return value === 1 || value === 2 ? value : 0;
}

/** The rung "Try again" asks for. A failure for lack of memory or time asks for the next rung on the export's ladder
 *  above the one that failed, or the gentlest it has when there is none (the streamed engine has only the normal one);
 *  any other failure (a full disk, a missing file) says nothing about how the work was done, so the plan decides afresh:
 *  the person may have freed memory since. A number as the third argument is a ladder with no gaps up to it. */
export function retryRung(failedRung: Rung, reason: string, ladder: Ladder | number = 2): Rung {
  if (reason !== "memory_limit" && reason !== "time_limit") return 0;
  const rungs = typeof ladder === "number" ? denseLadder(ladder) : cleanLadder(ladder);
  return rungs.find((rung) => rung > failedRung) ?? rungs[rungs.length - 1];
}

/** What a peak measured at one rung (the row) predicts at another (the column). Every entry errs HIGH on
 *  what the lab measured, so a conversion never promises a smaller peak than there will be:
 *  normal to gentle is at most 0.60 (8K 0.24, 1080p about 0.42, 4K60 0.60) and gentle to normal at least
 *  4.5 (8K 4.24), and the round trip between two rungs is never below 1 (a test pins both). */
export const CONVERT: readonly (readonly [number, number, number])[] = [
  [1, 0.6, 0.5],
  [4.5, 1, 1],
  [5, 1.15, 1],
];

const isRung = (value: unknown): value is Rung => value === 0 || value === 1 || value === 2;
const isPeak = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** A peak memory (bytes) measured for an export of this shape, at the rung it ran. */
export interface PeakSample {
  readonly rung: Rung;
  readonly bytes: number | null;
}

/** The predicted peak at `rung`: the largest measurement at that rung when there is one; otherwise the
 *  conversion from the measured rung that needs the least extrapolation (the factor nearest 1), so a
 *  measurement close to the rung asked about outweighs a loose one from far away; null when nothing usable
 *  was measured. */
export function predictPeak(samples: readonly PeakSample[], rung: Rung): number | null {
  const best: Partial<Record<Rung, number>> = {};
  for (const sample of samples) {
    if (!isRung(sample.rung) || !isPeak(sample.bytes)) continue;
    best[sample.rung] = Math.max(best[sample.rung] ?? 0, sample.bytes);
  }
  const direct = best[rung];
  if (direct !== undefined) return direct;
  let chosen: { distance: number; bytes: number } | null = null;
  for (const from of [0, 1, 2] as const) {
    const bytes = best[from];
    if (bytes === undefined) continue;
    const factor = CONVERT[from][rung];
    const distance = Math.abs(Math.log(factor));
    const converted = bytes * factor;
    if (
      chosen === null ||
      distance < chosen.distance ||
      (distance === chosen.distance && converted > chosen.bytes)
    )
      chosen = { distance, bytes: converted };
  }
  return chosen === null ? null : chosen.bytes;
}

export interface Plan {
  readonly rung: Rung;
  /** The predicted peak at `rung`, or null when nothing was measured. */
  readonly predictedBytes: number | null;
  /** Where the prediction comes from: this PC measured this rung, measured another and converted, never
   *  measured this shape (the reserve decides), or the PC itself could not be measured. */
  readonly basis: "measured" | "derived" | "unmeasured" | "unknown_pc";
  /** Whether `rung` fits under the ceiling (or nothing is known that says it does not). */
  readonly fits: boolean;
  /** The free memory the gentlest rung needs: what the memory question calls "Needed". Null when no number
   *  would be honest (the peak is above what an export may ever use). */
  readonly neededFreeBytes: number | null;
}

const clampRung = rungOf;

/** The first rung on the export's ladder, from `minRung` on, whose predicted peak fits under the ceiling of the free
 *  memory now. The ladder is the rungs that really are different commands (`ladder`; absent, the rungs with no gaps up
 *  to `maxRung`, the gentlest the engine has: the streamed engine has only the normal one). A `minRung` above them
 *  all is the export's own last rung. */
export function planRung(input: {
  samples: readonly PeakSample[];
  freeBytes: number | null;
  minRung?: number;
  maxRung?: number;
  ladder?: Ladder;
}): Plan {
  const rungs = input.ladder ? cleanLadder(input.ladder) : denseLadder(input.maxRung);
  const last = rungs[rungs.length - 1];
  const asked = clampRung(input.minRung);
  const min = rungs.find((rung) => rung >= asked) ?? last;
  const free =
    input.freeBytes !== null && Number.isFinite(input.freeBytes) && input.freeBytes >= 0
      ? input.freeBytes
      : null;
  const gentlest = predictPeak(input.samples, last);
  if (gentlest === null) {
    if (free === null)
      return {
        rung: min,
        predictedBytes: null,
        basis: "unknown_pc",
        fits: true,
        neededFreeBytes: null,
      };
    const fits = free >= UNMEASURED_RESERVE_BYTES;
    return {
      // The reserve is what the gentlest rung needs, so a PC with less than that free runs the gentlest rung
      // (XR-28): whoever answers Continue or Start anyway to the question that PC is asked is not given the
      // thread counts that need the most memory. A PC with room runs the rung it was asked for.
      rung: fits ? min : last,
      predictedBytes: null,
      basis: "unmeasured",
      fits,
      neededFreeBytes: UNMEASURED_RESERVE_BYTES,
    };
  }
  const neededFreeBytes = gentlest > CEILING_CAP_BYTES ? null : gentlest / CEILING_SHARE;
  const basisOf = (rung: Rung): "measured" | "derived" =>
    input.samples.some((sample) => sample.rung === rung && isPeak(sample.bytes))
      ? "measured"
      : "derived";
  for (const rung of rungs) {
    if (rung < min) continue;
    const predicted = predictPeak(input.samples, rung)!;
    if (free === null || predicted <= ceilingBytes(free))
      return {
        rung,
        predictedBytes: predicted,
        basis: free === null ? "unknown_pc" : basisOf(rung),
        fits: true,
        neededFreeBytes,
      };
  }
  return {
    rung: last,
    predictedBytes: gentlest,
    basis: basisOf(last),
    fits: false,
    neededFreeBytes,
  };
}
