// What the assistant is told when a transcript is not ready, as DATA.
//
// The words of every such answer live in ONE table keyed by state, each with the numbers it shows,
// and one pure function renders a state from its numbers. The final wording of three of these is
// waiting for a measurement (the A/B of S2-12), so changing it is an edit of this table and nothing
// else; the default wording of the two states that already existed is what 0.27.0 said, byte for
// byte. The numbers come from the pace model (`speechPace.ts`), never from this file.
import { MIN_SPAN_S, projectedS, spanLimitS, type PaceModel } from "./speechPace";
import { CAP_S } from "./speechPlan";

export const NOT_READY_STATES = ["words", "download", "too_long", "too_slow"] as const;
export type NotReadyState = (typeof NOT_READY_STATES)[number];

export interface NotReadyEntry {
  /** The words. `{name}` is a number of this state, an optional piece, or a shared clause. */
  text: string;
  /** The numbers (and the length of the audio as a person reads it) this state must be given. */
  numbers: readonly string[];
  /** A piece that is there only when its number is a positive one: `{piece}` in the words. */
  optional?: Readonly<Record<string, { number: string; text: string }>>;
}

/** Sentences that more than one state says, written once. */
export const NOT_READY_CLAUSES: Readonly<Record<string, string>> = {
  guard:
    "Do not guess or describe what is said. The frames, metadata and loudness in this result are final. " +
    "Call inspect_media again with the same arguments: it returns the words at once when they are done, " +
    "or pass wait_seconds (up to 60) to wait for them.",
};

export const NOT_READY_WORDS: Readonly<Record<NotReadyState, NotReadyEntry>> = {
  // The words are being made, with the time left when it can be told.
  words: {
    text:
      "The transcript is not ready: the speech in this {label} of audio is still being transcribed{left}{took}. " +
      "{guard} Tell the user it is still being transcribed.",
    numbers: ["label"],
    optional: {
      left: { number: "eta", text: ", about {eta} s to go" },
      took: { number: "waited", text: " (this call waited {waited} s)" },
    },
  },
  // The speech model is downloading, with how far it is and the time left when it can be told.
  download: {
    text:
      "The transcript is not ready: the speech model is still downloading ({pct}%{left}). " +
      "This one-time download happens the first time speech is transcribed on this computer, and " +
      "the transcription starts when it ends. {guard} Tell the user the speech model is downloading.",
    numbers: ["pct"],
    optional: { left: { number: "eta", text: ", about {eta} s to go" } },
  },
  // INTERIM wording (the coordinator's draft): the final words wait for the A/B (S2-12).
  too_long: {
    text:
      "Transcribing these {span} would take about {time} on this PC. A span of {fit} (for example {from} to {to}) " +
      "would take about {fitTime}. Ask for a shorter span with start_seconds and end_seconds. " +
      "Don't guess what is said.",
    numbers: ["span", "time", "fit", "from", "to", "fitTime"],
  },
  // INTERIM wording, same status: a PC so slow that not even the shortest span worth asking for fits.
  too_slow: {
    text:
      "Transcribing these {span} would take about {time} on this PC, and even {minSpan} would take about {minTime}, " +
      "so no span can be transcribed here in {cap}. Don't guess what is said.",
    numbers: ["span", "time", "minSpan", "minTime", "cap"],
  },
};

type Values = Readonly<Record<string, string | number | undefined>>;

/** A state's words with its numbers in. A number the state needs and was not given is a mistake in
 *  the caller, and it fails loudly here rather than put a raw `{placeholder}` in front of the model. */
export function renderNotReady(state: NotReadyState, values: Values): string {
  const entry = NOT_READY_WORDS[state];
  const fill = (text: string): string =>
    text.replace(/\{(\w+)\}/g, (_match, name: string) => {
      const clause = NOT_READY_CLAUSES[name];
      if (clause !== undefined) return clause;
      const piece = entry.optional?.[name];
      if (piece) {
        const n = values[piece.number];
        return typeof n === "number" && Number.isFinite(n) && n > 0 ? fill(piece.text) : "";
      }
      const v = values[name];
      if (v === undefined || v === "") throw new Error(`renderNotReady(${state}): missing ${name}`);
      return String(v);
    });
  return fill(entry.text);
}

/** mm:ss (h:mm:ss past an hour) for a time in a note to the model. */
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

/** The span to offer in place of one that is too long: the longest that fits, in whole minutes when
 *  it is a minute or more, so it is said plainly and never rounded up past what fits. */
function offeredSpan(fits: number): number {
  return fits >= 60 ? Math.floor(fits / 60) * 60 : fits;
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
  /** The numbers behind the words, so a test can check them against the pace model. `offerS` is the
   *  span offered in place of the one asked for, in seconds (0 when none is). */
  values: Record<string, string | number> & { offerS: number };
}

/** What to say about a span `[fromS, toS]` that this PC cannot do within `capS`: how long it would
 *  take, and a span that would fit with its own time, or that nothing fits. Every number is the pace
 *  model's. */
export function tooLongNotReady(
  model: Pick<PaceModel, "startupS" | "rate">,
  fromS: number,
  toS: number,
  capS: number = CAP_S,
): TooLongAnswer {
  const asked = Math.max(0, toS - fromS);
  const wouldTake = Math.round(projectedS(model, asked));
  const fits = spanLimitS(model, capS);
  const shown = { span: formatDuration(asked), time: formatDuration(wouldTake) };
  if (fits === 0) {
    const values = {
      ...shown,
      minSpan: formatDuration(MIN_SPAN_S),
      minTime: formatDuration(Math.round(projectedS(model, MIN_SPAN_S))),
      cap: formatDuration(capS),
      offerS: 0,
    };
    return {
      state: "too_slow",
      note: renderNotReady("too_slow", values),
      would_take_s: wouldTake,
      fits_seconds: 0,
      values,
    };
  }
  const offerS = offeredSpan(fits);
  const values = {
    ...shown,
    fit: formatDuration(offerS),
    from: clock(fromS),
    to: clock(fromS + offerS),
    fitTime: formatDuration(Math.round(projectedS(model, offerS))),
    offerS,
  };
  return {
    state: "too_long",
    note: renderNotReady("too_long", values),
    would_take_s: wouldTake,
    fits_seconds: fits,
    values,
  };
}
