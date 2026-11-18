// The one place that decides what time left a running export may say. Pure: no store, no clock, no I/O. The progress
// reporter hands it each report of one run (when it arrived and the share of the whole render made) and publishes the
// answer; the card, the Export dialog, the assistant's export list and the slow banner only read that answer, so they can
// never disagree. It works on the share made, never on ffmpeg's own `speed=` (a whole-run average that counts start-up).
//
// The rule, in the order it is applied to every report:
//  - from 90 % done the answer is "finishing", for good: the last tenth is the end of the render and the file's write, and
//    a number there is the least reliable one;
//  - until the gate opens there is no answer at all: at least 20 s rendered and either 15 % made or 60 s rendered;
//  - once it has opened there is always an answer, a figure from the pace of the last 20 s, kept on a rounding grid
//    (under a minute, whole minutes to 10, 5 minutes to an hour, quarter hours after) so it moves by steps and not by seconds;
//  - when the average pace since the render began implies a total over 1.5 times the one it implied when the first figure
//    was said, the answer is "longer", for good.
// A render made in parts says nothing until its final encode, which is the only part whose pace is the pace of what is left.

/** What may be said about the time left of a running export. */
export type TimeLeft =
  | { readonly kind: "none" }
  | { readonly kind: "left"; readonly seconds: number }
  | { readonly kind: "finishing" }
  | { readonly kind: "longer" };

export const NO_TIME_LEFT: TimeLeft = Object.freeze({ kind: "none" as const });
const FINISHING: TimeLeft = Object.freeze({ kind: "finishing" as const });
const LONGER: TimeLeft = Object.freeze({ kind: "longer" as const });

/** The gate: no answer until this much has been rendered ... */
export const GATE_RENDERED_SECONDS = 20;
/** ... and this much of the video is made ... */
export const GATE_FRACTION = 0.15;
/** ... or, failing that, this long has been rendered. */
export const GATE_RENDERED_ALONE_SECONDS = 60;
/** The pace is read over this much of the feed's own recent past. */
export const PACE_WINDOW_SECONDS = 20;
/** A pace is not read from less than this much of the feed: a figure from a second or two of pictures is noise. */
export const PACE_MIN_SPAN_SECONDS = 5;
/** From this share made the answer is "finishing". */
export const FINISHING_FROM = 0.9;
/** The implied total must exceed this many times the first one for the answer to become "longer". */
export const LONGER_FACTOR = 1.5;
/** A time left over this is not a time left. */
export const IMPLAUSIBLE_SECONDS = 48 * 3600;
/** A figure is kept while the raw time left is inside its rounding cell widened by this share of the cell's width on each
 *  side, so a pace that hovers at a rounding boundary does not make the words flap. */
export const HOLD_MARGIN = 0.25;

/** Below this many seconds the words are "under a minute". */
const UNDER_A_MINUTE_SECONDS = 45;
/** The grid figure of the band below it (the figure is a number only so every answer has one). */
const UNDER_A_MINUTE_FIGURE = 30;
/** Reports at a rate no real ffmpeg has would otherwise grow the window without bound. */
const MAX_SAMPLES = 400;

/** The raw time left rounded to the grid a person reads: under 45 s one band, then the nearest minute up to 10 minutes,
 *  the nearest 5 minutes up to an hour, the nearest quarter hour after. Monotone. A value that is not a number, or below
 *  zero, is read as zero. */
export function roundTimeLeft(rawSeconds: number): number {
  const raw = Number.isFinite(rawSeconds) && rawSeconds > 0 ? rawSeconds : 0;
  if (raw < UNDER_A_MINUTE_SECONDS) return UNDER_A_MINUTE_FIGURE;
  if (raw <= 600) return 60 * Math.max(1, Math.round(raw / 60));
  if (raw <= 3600) return 300 * Math.round(raw / 300);
  return 900 * Math.round(raw / 900);
}

/** The raw seconds that round to a grid figure: `lo <= raw < hi`. */
export function cellOf(figure: number): { lo: number; hi: number } {
  if (figure <= UNDER_A_MINUTE_FIGURE) return { lo: 0, hi: UNDER_A_MINUTE_SECONDS };
  if (figure === 60) return { lo: UNDER_A_MINUTE_SECONDS, hi: 90 };
  if (figure < 600) return { lo: figure - 30, hi: figure + 30 };
  if (figure === 600) return { lo: 570, hi: 750 };
  if (figure < 3600) return { lo: figure - 150, hi: figure + 150 };
  if (figure === 3600) return { lo: 3450, hi: 4050 };
  return { lo: figure - 450, hi: figure + 450 };
}

/** The shown figure, or the one the raw time left now rounds to when it has left the shown figure's cell by more than the margin. */
function held(shown: number, raw: number): number {
  const { lo, hi } = cellOf(shown);
  const margin = HOLD_MARGIN * (hi - lo);
  return raw >= lo - margin && raw < hi + margin ? shown : roundTimeLeft(raw);
}

/** One progress report of one export run. */
export interface PaceReport {
  /** When it arrived, in ms on any clock. One that goes back in time is read as the same instant as the newest report. */
  readonly at: number;
  /** The share of the whole render made, 0 to 1. Not a number is no report; out of range is clamped. */
  readonly fraction: number;
  /** A render made in parts: which part this is (0-based) and how many there are, the last being the final encode. */
  readonly step?: number | null;
  readonly steps?: number | null;
}

interface Sample {
  readonly at: number;
  readonly fraction: number;
}

interface Part {
  readonly step: number;
  readonly steps: number;
}

export interface PaceState {
  /** What may be said now. */
  readonly value: TimeLeft;
  readonly part: Part | null;
  /** When the segment's clock began (its first report), or null before any. */
  readonly origin: number | null;
  /** The share made at that first report: 0 for a run seen from its start, more for one joined late. */
  readonly floor: number;
  /** The highest share seen: a feed that goes backwards stands still. */
  readonly best: number;
  /** The newest report's time. */
  readonly last: number | null;
  /** The reports that made a picture, over the last window, with one at or before its start. */
  readonly samples: readonly Sample[];
  readonly opened: boolean;
  readonly shown: number | null;
  /** The total the average pace implied when the first figure was said. */
  readonly base: number | null;
  readonly finishing: boolean;
  readonly longer: boolean;
}

const START: PaceState = Object.freeze({
  value: NO_TIME_LEFT,
  part: null,
  origin: null,
  floor: 0,
  best: 0,
  last: null,
  samples: Object.freeze([]) as readonly Sample[],
  opened: false,
  shown: null,
  base: null,
  finishing: false,
  longer: false,
});

/** A run with no report yet. */
export function startPace(): PaceState {
  return START;
}

function partOf(step: unknown, steps: unknown): Part | null {
  return typeof step === "number" &&
    typeof steps === "number" &&
    Number.isInteger(step) &&
    Number.isInteger(steps) &&
    steps > 1 &&
    step >= 0 &&
    step < steps
    ? { step, steps }
    : null;
}

const sameParts = (a: Part | null, b: Part | null): boolean =>
  a === b || (a !== null && b !== null && a.step === b.step && a.steps === b.steps);

/** A part that is not the last: its pace says nothing about what is left. */
const inParts = (part: Part | null): boolean => part !== null && part.step < part.steps - 1;

/** The reports that fall in the window ending at `at`, plus the one before it that gives the window its start. */
function withSample(samples: readonly Sample[], at: number, fraction: number): readonly Sample[] {
  const added =
    samples.length > 0 && samples[samples.length - 1].at === at
      ? [...samples.slice(0, -1), { at, fraction }]
      : [...samples, { at, fraction }];
  const start = at - PACE_WINDOW_SECONDS * 1000;
  let from = 0;
  while (from + 1 < added.length && added[from + 1].at <= start) from++;
  const kept = from > 0 ? added.slice(from) : added;
  return kept.length > MAX_SAMPLES ? kept.slice(kept.length - MAX_SAMPLES) : kept;
}

/** The time left at the pace of the last window: what is left of the share, over the share made per second between the
 *  window's start (taken from the report on either side of it, or the first picture when the feed began inside it) and
 *  now. Null when that cannot be read: too little feed, nothing made in it, or a time that cannot be real. */
function leftFromPace(samples: readonly Sample[], at: number, fraction: number): number | null {
  const oldest = samples[0];
  if (!oldest) return null;
  const start = at - PACE_WINDOW_SECONDS * 1000;
  let from = oldest.at;
  let made = oldest.fraction;
  const next = samples[1];
  if (oldest.at < start && next) {
    from = start;
    made = oldest.fraction + ((next.fraction - oldest.fraction) * (start - oldest.at)) / (next.at - oldest.at);
  }
  const span = (at - from) / 1000;
  const gained = fraction - made;
  if (!(span >= PACE_MIN_SPAN_SECONDS) || !(gained > 0)) return null;
  const left = ((1 - fraction) * span) / gained;
  return Number.isFinite(left) && left >= 0 && left <= IMPLAUSIBLE_SECONDS ? left : null;
}

const figureOf = (previous: TimeLeft, seconds: number): TimeLeft =>
  previous.kind === "left" && previous.seconds === seconds
    ? previous
    : { kind: "left", seconds };

function advance(state: PaceState, report: PaceReport): PaceState {
  if (!Number.isFinite(report.at) || !Number.isFinite(report.fraction)) return state;
  const part = partOf(report.step, report.steps);
  // A new part starts a new clock and a new gate; what was made stays made.
  const run: PaceState = sameParts(state.part, part)
    ? state
    : { ...START, part, best: state.best, last: state.last };
  const at = run.last === null ? report.at : Math.max(report.at, run.last);
  const fraction = Math.max(Math.min(1, Math.max(0, report.fraction)), run.best);
  const origin = run.origin ?? at;
  const floor = run.origin === null ? fraction : run.floor;
  const samples = fraction > 0 ? withSample(run.samples, at, fraction) : run.samples;
  const parts = inParts(part);
  const finishing = run.finishing || (!parts && fraction >= FINISHING_FROM);
  const seen: PaceState = { ...run, part, origin, floor, best: fraction, last: at, samples, finishing };

  if (parts) return { ...seen, value: NO_TIME_LEFT };
  if (finishing) return { ...seen, value: FINISHING };

  const rendered = (at - origin) / 1000;
  const made = fraction - floor;
  const total = made > 0 && rendered > 0 ? rendered / made : null;
  const raw = leftFromPace(samples, at, fraction);

  if (!seen.opened) {
    const open =
      rendered >= GATE_RENDERED_SECONDS &&
      (fraction >= GATE_FRACTION || rendered >= GATE_RENDERED_ALONE_SECONDS) &&
      raw !== null &&
      total !== null;
    if (!open) return { ...seen, value: NO_TIME_LEFT };
    const shown = roundTimeLeft(raw);
    return { ...seen, opened: true, shown, base: total, value: figureOf(seen.value, shown) };
  }

  const shown = raw !== null && seen.shown !== null ? held(seen.shown, raw) : seen.shown;
  const longer =
    seen.longer || (total !== null && seen.base !== null && total > LONGER_FACTOR * seen.base);
  return {
    ...seen,
    shown,
    longer,
    value: longer ? LONGER : shown === null ? NO_TIME_LEFT : figureOf(seen.value, shown),
  };
}

/** The state after one more report of the run. Never throws and never changes the state it is given: a report it cannot
 *  read leaves the answer as it was. */
export function notePace(state: PaceState, report: PaceReport): PaceState {
  try {
    return advance(state, report);
  } catch {
    return state;
  }
}
