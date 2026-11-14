// What an export's processes have used, and the one question the "no progress" stop asks of it: has the export been
// idle for the whole window? Pure: every time is passed in (the page's own clock, in seconds); nothing here reads a
// clock or sets a timer.
//
// The app process prints a mark on the job's output every few seconds: `artdaddy_cpu=<cpu ms>,<bytes read>`, what the
// export's processes have used so far. This module writes and reads that line, takes it out of the text the progress
// readers see, keeps the latest readings and answers "idle", "busy" or "unknown".
//
// The direction of the rule is the owner's reliability rule: only positive evidence of idleness may say "idle". A
// reading that is missing, old, odd or out of step with the clock says "unknown", and an export whose activity is
// unknown is never stopped for being idle.
import type { LiveStageName } from "./exportWords";

/** Every mark starts with this. The mark is one line, `artdaddy_cpu=<cumulative cpu ms>,<cumulative bytes read>`: two
 *  whole numbers, counted from when the export's first process started. */
export const ACTIVITY_MARK_PREFIX = "artdaddy_cpu=";

/** An export is idle when its processes used next to nothing for this long. */
export const IDLE_WINDOW_SECONDS = 180;
/** Readings further apart than this, or older than this, are not evidence: the reader may have died or the page stood
 *  still. */
export const ACTIVITY_STALE_SECONDS = 20;
/** Next to nothing, in processor time: under this many ms for every second of the window (2 % of one core). */
export const IDLE_CPU_MS_PER_SECOND = 20;
/** And in disk reads: under this many bytes in the whole window. */
export const IDLE_READ_BYTES = 1024 * 1024;
/** Readings kept. At one every 5 seconds that is four minutes, a window and room to spare; a flood of readings can push
 *  the window out of the ring, and a window the ring does not cover is "unknown", never a guess. */
export const ACTIVITY_RING_CAPACITY = 48;
/** The largest counter taken as real: past 2^53 a number is no longer exact, and 2^53 ms of processor is some 285,000
 *  years. */
export const ACTIVITY_COUNTER_MAX = 2 ** 53;

export type ActivityVerdict = "idle" | "busy" | "unknown";

export interface ActivityMark {
  /** Processor time used by the export's processes, user plus kernel, in ms. */
  cpuMs: number;
  /** Bytes the export's processes have read from storage. */
  readBytes: number;
}

/** One mark line wherever it lands, even glued into the middle of one of ffmpeg's lines, where it would turn a number
 *  into noise. The digits are bounded (a 64-bit number has 20), so no text can make the match slow; a number longer
 *  than that is not a mark. */
const MARK_LINE = /artdaddy_cpu=(\d{1,20}),(\d{1,20})\r?\n/g;
const LIMIT_DIGITS = String(ACTIVITY_COUNTER_MAX);

/** The value of a run of digits, or null above 2^53. Compared as text: parsed, a number that large cannot be told from
 *  its neighbours. */
function counterOf(digits: string): number | null {
  const significant = digits.replace(/^0+(?=\d)/, "");
  const tooBig =
    significant.length > LIMIT_DIGITS.length ||
    (significant.length === LIMIT_DIGITS.length && significant > LIMIT_DIGITS);
  return tooBig ? null : Number(significant);
}

const nearestCounter = (value: number): number =>
  Number.isFinite(value) ? Math.min(ACTIVITY_COUNTER_MAX, Math.max(0, Math.floor(value))) : 0;

/** The line the app process prints, newline included. A number that cannot be a counter is brought to the nearest one
 *  that can. */
export function formatActivityMark(mark: ActivityMark): string {
  return `${ACTIVITY_MARK_PREFIX}${nearestCounter(mark.cpuMs)},${nearestCounter(mark.readBytes)}\n`;
}

/** Every mark in a chunk of the job's output, in order. A line that has the shape of a mark but a counter above 2^53
 *  is skipped, like any text that is not a mark. */
export function parseActivityMarks(text: string): ActivityMark[] {
  const marks: ActivityMark[] = [];
  for (const match of text.matchAll(MARK_LINE)) {
    const cpuMs = counterOf(match[1]);
    const readBytes = counterOf(match[2]);
    if (cpuMs !== null && readBytes !== null) marks.push({ cpuMs, readBytes });
  }
  return marks;
}

/** The text with every mark line taken out and nothing else changed. One pass: a mark made of the pieces on both sides of
 *  another is left, as any other noise is. */
export function stripActivityMarks(text: string): string {
  return text.replace(MARK_LINE, "");
}

interface Reading extends ActivityMark {
  t: number;
}

const isCounter = (value: number): boolean =>
  Number.isFinite(value) && value >= 0 && value <= ACTIVITY_COUNTER_MAX;

/** The latest readings of one export's activity, newest last. */
export class ActivityRing {
  private readings: Reading[] = [];
  private readonly capacity: number;

  constructor(capacity: number = ACTIVITY_RING_CAPACITY) {
    this.capacity = Number.isFinite(capacity)
      ? Math.max(1, Math.floor(capacity))
      : ACTIVITY_RING_CAPACITY;
  }

  /** A mark that arrived at `tSeconds` on the page's own clock. A time or a counter that is not a finite number is
   *  dropped. A time earlier than the newest reading's restarts the ring with this reading: nothing from before a clock
   *  that went back can be set against what comes after. Readings at one time are all kept. */
  push(tSeconds: number, mark: ActivityMark): void {
    if (!Number.isFinite(tSeconds) || !isCounter(mark.cpuMs) || !isCounter(mark.readBytes)) return;
    const newest = this.readings[this.readings.length - 1];
    if (newest && tSeconds < newest.t) this.readings = [];
    this.readings.push({ t: tSeconds, cpuMs: mark.cpuMs, readBytes: mark.readBytes });
    if (this.readings.length > this.capacity) this.readings.shift();
  }

  /** Forget everything: after the PC slept or the page stood still, nothing read before is evidence of what happened
   *  after. */
  clear(): void {
    this.readings = [];
  }

  get size(): number {
    return this.readings.length;
  }

  /** What the export did over the `windowSeconds` that end at `nowSeconds`.
   *
   *  The window's two ends are the newest reading and the newest reading at or before the window's start (the oldest of
   *  those if several share a time). What was used is the difference of the counters between them. The older end only
   *  adds use from before the window, so it can delay "idle" and never bring it early.
   *
   *  "unknown" when the readings do not show the whole window: none yet; the newest is later than `nowSeconds` (the clock
   *  and the readings disagree), older than ACTIVITY_STALE_SECONDS, or not inside the window; none at or before the
   *  window's start (never that far back, or dropped for room); a hole longer than ACTIVITY_STALE_SECONDS from the
   *  window's start to its first reading, between two readings in it, or from the newest to `nowSeconds`; a counter that
   *  went down inside the window (a reader that started again: the difference no longer says what was used); or a time
   *  or window that is not a number or not positive. Otherwise "idle" when the processor time is under
   *  IDLE_CPU_MS_PER_SECOND for every second of the window and the reads are under IDLE_READ_BYTES, and "busy" when not. */
  verdict(nowSeconds: number, windowSeconds: number = IDLE_WINDOW_SECONDS): ActivityVerdict {
    const readings = this.readings;
    const newest = readings[readings.length - 1];
    if (
      !newest ||
      !Number.isFinite(nowSeconds) ||
      !Number.isFinite(windowSeconds) ||
      windowSeconds <= 0
    )
      return "unknown";
    const start = nowSeconds - windowSeconds;
    if (
      newest.t > nowSeconds ||
      nowSeconds - newest.t > ACTIVITY_STALE_SECONDS ||
      newest.t <= start ||
      readings[0].t > start
    )
      return "unknown";

    let from = 0;
    while (from + 1 < readings.length && readings[from + 1].t <= start) from++;
    while (from > 0 && readings[from - 1].t === readings[from].t) from--;

    let edge = start;
    let previous = readings[from];
    for (let i = from + 1; i < readings.length; i++) {
      const reading = readings[i];
      if (reading.t > start) {
        if (reading.t - edge > ACTIVITY_STALE_SECONDS) return "unknown";
        edge = reading.t;
      }
      if (reading.cpuMs < previous.cpuMs || reading.readBytes < previous.readBytes)
        return "unknown";
      previous = reading;
    }

    const cpuUsed = newest.cpuMs - readings[from].cpuMs;
    const readUsed = newest.readBytes - readings[from].readBytes;
    return cpuUsed < IDLE_CPU_MS_PER_SECOND * windowSeconds && readUsed < IDLE_READ_BYTES
      ? "idle"
      : "busy";
  }
}

const whole = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;

/** What the live feed says about an export's silence: how long it has gone without moving, and whether the processors
 *  were busy meanwhile (`busy` is true, false or null when the activity could not be read). The quiet is counted as
 *  `quietSeconds` in exportWords.ts counts it, restated so this module stays free of that one's imports; a test pins the
 *  two to the same numbers. */
export function quietVerdict(
  live: { stage: LiveStageName; lastMoveAt: number; busy?: boolean | null },
  nowMs: number,
): { verdict: ActivityVerdict; quiet_for_s: number } {
  const counting = live.stage === "preparing" || live.stage === "rendering";
  return {
    verdict: live.busy === true ? "busy" : live.busy === false ? "idle" : "unknown",
    quiet_for_s: counting ? whole((nowMs - live.lastMoveAt) / 1000) : 0,
  };
}
