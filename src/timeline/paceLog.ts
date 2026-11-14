// Phase 3c: what the estimate learns from exports, including cancelled and failed ones (DESIGN 3.5). A run teaches how far the model was off as a
// ratio of the actual pace to the predicted one; the log keeps the last few, per encoder family and per speed revision and build, and `paceCorrection`
// gives their weighted median. Storage is injected (a Storage-like object, never the page's), every read of a damaged value is "nothing", and a
// write that fails is not a failure. Nothing here reads a clock or the page: the caller passes the time.
import type { EncoderFamily } from "./exportTypes3c";

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const PACE_LOG_KEY = "artdaddy.paceLog.v1";

export const PACE_LOG_LIMITS = {
  /** Entries kept, all families together: the oldest go first. */
  entries: 32,
  /** Entries the correction is the median of. */
  window: 8,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  /** A clock set ahead can make an entry look newer than now; more than this ahead is not trusted. */
  futureSlackMs: 24 * 60 * 60 * 1000,
  /** A run teaches only if it ran this long and made this much of its project. */
  minRunSeconds: 90,
  minProduced: 0.03,
  /** A sample that got this far through its project counts in full; one that got less counts in proportion. */
  fullWeightAt: 0.25,
  ratio: { min: 0.25, max: 8 },
} as const;

export interface PaceKey {
  family: EncoderFamily;
  speedRevision: number;
  build: string;
}

export interface PaceInput {
  family: EncoderFamily;
  /** Seconds the export ran, as a person lived it (the watch's own correction for a sleep is the lane's to apply). */
  runSeconds: number;
  /** The share of the project it made, 0 to 1 (1 for a finished one). */
  producedFraction: number;
  /** The total the estimate predicted for this export: the model's own figure, without any learned correction, so the log learns the model's
   *  error and not its own. */
  predictedTotalSeconds: number;
  outcome: "done" | "failed" | "cancelled" | "stopped_idle";
  cancelledBeforeFirstPicture?: boolean;
  crossedBySleep?: boolean;
  speedRevision: number;
  build: string;
  atMs: number;
}

interface Entry {
  family: EncoderFamily;
  speedRevision: number;
  build: string;
  atMs: number;
  ratio: number;
  weight: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isFamily = (value: unknown): value is EncoderFamily =>
  value === "processor" || value === "chip";

/** One input as the entry it teaches, or null when it teaches nothing: a hung run, a cancel before the first picture, a run a sleep crossed, a
 *  run too short or too little of its project to say anything, or a figure that is not a number. */
function lesson(input: PaceInput): Entry | null {
  if (!isObject(input)) return null;
  const { family, runSeconds, producedFraction, predictedTotalSeconds, outcome } = input;
  if (!isFamily(family)) return null;
  if (outcome !== "done" && outcome !== "failed" && outcome !== "cancelled") return null;
  if (input.cancelledBeforeFirstPicture === true || input.crossedBySleep === true) return null;
  if (!finite(runSeconds) || runSeconds < PACE_LOG_LIMITS.minRunSeconds) return null;
  if (
    !finite(producedFraction) ||
    producedFraction < PACE_LOG_LIMITS.minProduced ||
    producedFraction > 1.0001
  )
    return null;
  if (!finite(predictedTotalSeconds) || predictedTotalSeconds <= 0) return null;
  if (!finite(input.speedRevision) || typeof input.build !== "string" || !finite(input.atMs))
    return null;
  const produced = Math.min(1, producedFraction);
  const ratio = Math.min(
    PACE_LOG_LIMITS.ratio.max,
    Math.max(PACE_LOG_LIMITS.ratio.min, runSeconds / produced / predictedTotalSeconds),
  );
  return {
    family,
    speedRevision: input.speedRevision,
    build: input.build,
    atMs: input.atMs,
    ratio,
    weight: Math.min(1, produced / PACE_LOG_LIMITS.fullWeightAt),
  };
}

/** The entries in the store: none for a store that is missing, unreadable or not a list, and none of the entries that are not what this module
 *  writes (a ratio outside its bounds is a damaged entry, not a lesson). */
function readEntries(store: StorageLike): Entry[] {
  let parsed: unknown;
  try {
    const raw = store.getItem(PACE_LOG_KEY);
    if (typeof raw !== "string") return [];
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is Entry =>
      isObject(entry) &&
      isFamily(entry.family) &&
      finite(entry.speedRevision) &&
      typeof entry.build === "string" &&
      finite(entry.atMs) &&
      finite(entry.ratio) &&
      entry.ratio >= PACE_LOG_LIMITS.ratio.min &&
      entry.ratio <= PACE_LOG_LIMITS.ratio.max &&
      finite(entry.weight) &&
      entry.weight > 0 &&
      entry.weight <= 1,
  );
}

/** Teach the log one run, if it has anything to teach. Never throws; a store that cannot be written to is left as it was. */
export function recordPace(store: StorageLike | null, input: PaceInput): void {
  try {
    if (!store) return;
    const taught = lesson(input);
    if (!taught) return;
    const entries = [...readEntries(store), taught].slice(-PACE_LOG_LIMITS.entries);
    store.setItem(PACE_LOG_KEY, JSON.stringify(entries));
  } catch {
    // A write that fails is not a failure: the estimate just does not learn this time.
  }
}

/** The smallest ratio at which the weights below it reach half of all of them; between two ratios exactly at half, their mean. */
function weightedMedian(entries: readonly Entry[]): number | null {
  if (entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => a.ratio - b.ratio);
  const total = sorted.reduce((sum, entry) => sum + entry.weight, 0);
  const half = total / 2;
  const slack = total * 1e-9;
  let reached = 0;
  for (let index = 0; index < sorted.length; index++) {
    reached += sorted[index].weight;
    if (reached >= half - slack) {
      const next = sorted[index + 1];
      const exactlyHalf = Math.abs(reached - half) <= slack;
      return exactlyHalf && next ? (sorted[index].ratio + next.ratio) / 2 : sorted[index].ratio;
    }
  }
  return sorted[sorted.length - 1].ratio;
}

/** The learned correction for this encoder family under this speed revision and build: the weighted median of the last eight lessons at most 30
 *  days old. Null = no usable lesson (the estimate is then the model's own). Never throws. */
export function paceCorrection(
  store: StorageLike | null,
  key: PaceKey,
  nowMs: number,
): number | null {
  try {
    if (!store || !isObject(key) || !finite(nowMs)) return null;
    const usable = readEntries(store).filter((entry) => {
      const age = nowMs - entry.atMs;
      return (
        entry.family === key.family &&
        entry.speedRevision === key.speedRevision &&
        entry.build === key.build &&
        age <= PACE_LOG_LIMITS.maxAgeMs &&
        age >= -PACE_LOG_LIMITS.futureSlackMs
      );
    });
    return weightedMedian(usable.slice(-PACE_LOG_LIMITS.window));
  } catch {
    return null;
  }
}
