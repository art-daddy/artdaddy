// What the assistant is told when a transcript is not ready, as DATA.
//
// The words of every such answer live in ONE table keyed by state, each with the numbers it shows and
// how each is said, and one pure function renders a state from its numbers. They are wording C of the
// wording study (LAB-WORDING, owner decision S2-12 of 14 Nov 2026), character for character: `words`
// is its message 1, `too_long` its message 2 and `download` its message 3. The study ran on gpt-6-luna
// only and in a mock of the tool. `too_slow` is a fourth state the study did not have, written in the
// same voice and untested. The numbers come from the pace model (`speechPace.ts`), never from this
// file, and `__fixtures__/notReadyWording.json` holds what the study's own code makes of numbers,
// which `transcriptWords.test.ts` holds this table to.
import { MIN_SPAN_S, projectedS, spanLimitS, type PaceModel } from "./speechPace";
import { CAP_S } from "./speechPlan";

export const NOT_READY_STATES = ["words", "download", "too_long", "too_slow"] as const;
export type NotReadyState = (typeof NOT_READY_STATES)[number];

/** How a number is said in the words. Every number a caller gives is seconds, except a percent. */
export type Say = "approx" | "length" | "clock" | "percent";

export interface NotReadyEntry {
  /** The words. `{name}` is a number of the state, or an optional piece. */
  text: string;
  /** The numbers the state must be given, each with how the words say it. */
  numbers: Readonly<Record<string, Say>>;
  /** A piece of the words that is there only when its number is given and above zero: `{piece}` in the
   *  words, and `{number}` in the piece's own words. */
  optional?: Readonly<Record<string, { number: string; say: Say; text: string }>>;
}

export const NOT_READY_WORDS: Readonly<Record<NotReadyState, NotReadyEntry>> = {
  // The words are being made. Without a time left (a span of unknown length) there is no parenthesis.
  words: {
    text:
      "The words are not ready yet{left}. Don't guess what is said. " +
      "Tell the user, and ask again later, or ask for a shorter span if you need them sooner. " +
      "If a shorter span is not ready either, stop asking and tell the user.",
    numbers: {},
    optional: { left: { number: "eta", say: "approx", text: " ({eta})" } },
  },
  // The speech model is downloading, with how far it is and the time left when it can be told.
  download: {
    text:
      "The speech model is downloading ({pct}%{left}). The words start after that. " +
      "Don't guess what is said. Tell the user, and ask again later.",
    numbers: { pct: "percent" },
    optional: { left: { number: "eta", say: "approx", text: ", {eta}" } },
  },
  // The span asked for is more than this PC does within the cap. `fit` is the example span, which the
  // pace model keeps inside what the cap allows (`tooLongNotReady`).
  too_long: {
    text:
      "Transcribing these {span} would take {time} on this PC. " +
      "A span of {fit} (for example {from} to {to}) would take {fitTime}. " +
      "Ask for a shorter span with start_seconds and end_seconds. Don't guess what is said.",
    numbers: {
      span: "length",
      time: "approx",
      fit: "length",
      from: "clock",
      to: "clock",
      fitTime: "approx",
    },
  },
  // UNTESTED: a PC so slow that not even the shortest span worth asking for fits, so nothing is offered.
  too_slow: {
    text:
      "Transcribing these {span} would take {time} on this PC, and even {minSpan} would take {minTime}. " +
      "No span can be transcribed here in {cap}. Don't guess what is said. Tell the user, and stop asking.",
    numbers: {
      span: "length",
      time: "approx",
      minSpan: "length",
      minTime: "approx",
      cap: "length",
    },
  },
};

const finiteOrZero = (n: number): number => (Number.isFinite(n) ? Math.max(0, n) : 0);

/** "less than a minute", "about 4 minutes", "about 1 hour 20 minutes": whole minutes below ten, the
 *  nearest five minutes from ten on. */
export function approxTime(seconds: number): string {
  const m = finiteOrZero(seconds) / 60;
  if (m < 0.75) return "less than a minute";
  if (m < 10) {
    const n = Math.max(1, Math.round(m));
    return n === 1 ? "about 1 minute" : `about ${n} minutes`;
  }
  const n = 5 * Math.round(m / 5);
  if (n < 60) return `about ${n} minutes`;
  const hours = Math.floor(n / 60);
  const minutes = n % 60;
  return `about ${hours} hour${hours === 1 ? "" : "s"}${minutes ? ` ${minutes} minutes` : ""}`;
}

/** The length of a span: whole minutes from a minute on, seconds below it. */
export function lengthWords(seconds: number): string {
  const s = finiteOrZero(seconds);
  const unit = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
  return Math.round(s) < 60 ? unit(Math.round(s), "second") : unit(Math.round(s / 60), "minute");
}

/** mm:ss, zero-padded as the example in the words shows it (h:mm:ss from an hour on). */
export function paddedClock(seconds: number): string {
  const t = Math.round(finiteOrZero(seconds));
  const pad = (n: number): string => String(n).padStart(2, "0");
  return t >= 3600
    ? `${Math.floor(t / 3600)}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`
    : `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
}

export const SAY: Readonly<Record<Say, (n: number) => string>> = {
  approx: approxTime,
  length: lengthWords,
  clock: paddedClock,
  percent: (n) => String(Math.round(Math.min(100, finiteOrZero(n)))),
};

type Values = Readonly<Record<string, number | undefined>>;

/** A state's words with its numbers in. A number the state needs and was not given is a mistake in
 *  the caller, and it fails loudly here rather than put a raw `{placeholder}` in front of the model. */
export function renderNotReady(state: NotReadyState, values: Values): string {
  const entry = NOT_READY_WORDS[state];
  const said = (name: string, say: Say): string => {
    const v = values[name];
    if (typeof v !== "number" || !Number.isFinite(v))
      throw new Error(`renderNotReady(${state}): missing ${name}`);
    return SAY[say](v);
  };
  const fill = (text: string, own?: { number: string; say: Say }): string =>
    text.replace(/\{(\w+)\}/g, (_match, name: string) => {
      if (own && name === own.number) return said(name, own.say);
      const piece = entry.optional?.[name];
      if (piece) {
        const n = values[piece.number];
        return typeof n === "number" && Number.isFinite(n) && n > 0 ? fill(piece.text, piece) : "";
      }
      const say = entry.numbers[name];
      if (say === undefined) throw new Error(`renderNotReady(${state}): {${name}} is not declared`);
      return said(name, say);
    });
  return fill(entry.text);
}

/** m:ss (h:mm:ss past an hour) for a time in a note to the model. */
export function clock(s: number): string {
  const t = Number.isFinite(s) ? Math.max(0, Math.round(s)) : 0;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return t >= 3600
    ? `${Math.floor(t / 3600)}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`
    : `${Math.floor(t / 60)}:${pad(t % 60)}`;
}

/** A length of time in words: "45 seconds", "10 minutes", "1 hour 20 minutes", "3 days 4 hours". */
export function formatDuration(seconds: number): string {
  const unit = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
  const s = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  if (s < 60) return unit(s, "second");
  const minutes = Math.round(s / 60);
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48)
    return rest ? `${unit(hours, "hour")} ${unit(rest, "minute")}` : unit(hours, "hour");
  const days = Math.floor(hours / 24);
  const left = hours % 24;
  return left ? `${unit(days, "day")} ${unit(left, "hour")}` : unit(days, "day");
}

/** The study's example span: "A span of 3 minutes (for example 05:00 to 08:00)". */
export const EXAMPLE_FROM_S = 300;
export const EXAMPLE_LEN_S = 180;

/** The span offered as an example, in seconds: the study's three minutes where this PC does that within
 *  the cap, else the most whole minutes it does, else the seconds it does. Never more than `fits`. */
export function exampleSpanS(fits: number): number {
  if (fits >= EXAMPLE_LEN_S) return EXAMPLE_LEN_S;
  return fits >= 60 ? Math.floor(fits / 60) * 60 : Math.floor(fits);
}

/** Where the example starts: at the study's 05:00 when all of it lies inside the span asked for, else
 *  where that span starts, so that it is always inside the used part of the file. */
function exampleFromS(fromS: number, toS: number, lenS: number): number {
  return fromS <= EXAMPLE_FROM_S && toS >= EXAMPLE_FROM_S + lenS ? EXAMPLE_FROM_S : fromS;
}

export interface TooLongAnswer {
  state: "too_long" | "too_slow";
  /** The words for the assistant. */
  note: string;
  /** About how long the span that was asked for would take on this PC, in seconds. */
  would_take_s: number;
  /** The longest span, in seconds, that this PC does within the cap; 0 when not even the shortest span
   *  worth asking for ({@link MIN_SPAN_S}) fits. */
  fits_seconds: number;
  /** The numbers behind the words, in seconds, so a test can check them against the pace model. */
  values: Readonly<Record<string, number>>;
}

/** What to say about a span `[fromS, toS]` that this PC cannot do within `capS`: how long it would
 *  take, and an example span that would fit with its own time, or that nothing fits. Every number is
 *  the pace model's. */
export function tooLongNotReady(
  model: Pick<PaceModel, "startupS" | "rate">,
  fromS: number,
  toS: number,
  capS: number = CAP_S,
): TooLongAnswer {
  const asked = Math.max(0, toS - fromS);
  const time = projectedS(model, asked);
  const fits = spanLimitS(model, capS);
  if (fits === 0) {
    const values = {
      span: asked,
      time,
      minSpan: MIN_SPAN_S,
      minTime: projectedS(model, MIN_SPAN_S),
      cap: capS,
    };
    return {
      state: "too_slow",
      note: renderNotReady("too_slow", values),
      would_take_s: Math.round(time),
      fits_seconds: 0,
      values,
    };
  }
  const fit = exampleSpanS(fits);
  const from = exampleFromS(fromS, toS, fit);
  const values = { span: asked, time, fit, from, to: from + fit, fitTime: projectedS(model, fit) };
  return {
    state: "too_long",
    note: renderNotReady("too_long", values),
    would_take_s: Math.round(time),
    fits_seconds: fits,
    values,
  };
}
