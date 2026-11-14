// What the assistant is told when a transcript is not ready, as DATA: one table of words keyed by
// state, each rendered from its numbers by one pure function. The words are wording C of the wording
// study (owner decision S2-12), so the table is held to what the study's own code makes of numbers
// (`__fixtures__/notReadyWording.json`, made by running LAB-WORDING/data/wording.py, not by this
// project's code), and the rules that must survive any rewording are checked on their own: what is
// said agrees with the pace model's numbers within the rounding it promises, and an example span
// offered to the assistant always fits.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import golden from "./__fixtures__/notReadyWording.json";
import { projectedS, spanLimitS, type PaceModel } from "./speechPace";
import { CAP_S } from "./speechPlan";
import {
  approxTime,
  EXAMPLE_FROM_S,
  EXAMPLE_LEN_S,
  exampleSpanS,
  lengthWords,
  NOT_READY_STATES,
  NOT_READY_WORDS,
  paddedClock,
  renderNotReady,
  SAY,
  tooLongNotReady,
} from "./transcriptWords";

const approxRows = golden.approx as unknown as [number, string][];
const wordsRows = golden.words as unknown as [number, string][];
const downloadRows = golden.download as unknown as [number, number | null, string][];
const tooLongRows = golden.too_long as unknown as [number, number, string][];

/** The true times, in minutes, that are said as `text`: a half-open interval, from the rounding the
 *  words promise (whole minutes below ten, the nearest five from ten on), decoded from the words alone. */
function trueMinutes(text: string): [number, number] {
  if (text === "less than a minute") return [0, 0.75];
  const hours = /(\d+) hours?/.exec(text);
  const minutes = /(\d+) minutes?/.exec(text);
  expect(text, "a time said in words").toMatch(/^about \d+ (hours?|minutes?)/);
  const n = (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
  if (n === 1) return [0.75, 1.5];
  if (n < 10) return [n - 0.5, n + 0.5];
  if (n === 10) return [9.5, 12.5]; // from nine and a half (whole minutes) to twelve and a half (nearest five)
  return [n - 2.5, n + 2.5];
}
function expectSaid(text: string, seconds: number): void {
  const [lo, hi] = trueMinutes(text);
  expect(seconds / 60, `${seconds} s said as "${text}"`).toBeGreaterThanOrEqual(lo - 1e-9);
  expect(seconds / 60, `${seconds} s said as "${text}"`).toBeLessThan(hi + 1e-9);
}
function secondsOfLength(text: string): number {
  const m = /^(\d+) (second|minute)s?$/.exec(text);
  expect(m, `a length in words: "${text}"`).not.toBeNull();
  return Number(m![1]) * (m![2] === "minute" ? 60 : 1);
}
const secondsOfClock = (text: string): number =>
  text.split(":").reduce((total, part) => total * 60 + Number(part), 0);

const model = (startupS: number, rate: number): PaceModel => ({
  backend: "cpu",
  startupS,
  rate,
  runs: 1,
});
const models = fc
  .tuple(fc.integer({ min: 1, max: 120 }), fc.double({ min: 0.02, max: 12, noNaN: true }))
  .map(([s, r]) => model(s, r));

describe("the words are wording C of the study, character for character", () => {
  it("are held to the study's frozen code, and to enough of it to mean something", () => {
    // wording.py hashes to a1c0babb5b38cf4f... in the study's own report: another file is not this study
    expect(golden.wording_py_sha256.startsWith("a1c0babb5b38cf4f")).toBe(true);
    expect(golden.example).toEqual({ from_s: EXAMPLE_FROM_S, length_s: EXAMPLE_LEN_S });
    expect(approxRows.length).toBeGreaterThan(150);
    expect(wordsRows.length).toBeGreaterThan(8);
    expect(downloadRows.length).toBeGreaterThan(7);
    expect(tooLongRows.length).toBeGreaterThan(20);
  });

  it("says a time as the study does, at every place its rounding changes", () => {
    for (const [seconds, text] of approxRows)
      expect(approxTime(seconds), `${seconds} s`).toBe(text);
  });

  it("message 1, the words are being made: with the time left, to the study's byte", () => {
    for (const [eta, text] of wordsRows)
      expect(renderNotReady("words", { eta }), `eta ${eta} s`).toBe(text);
  });

  it("message 3, the speech model is downloading: with and without the time left", () => {
    for (const [pct, eta, text] of downloadRows)
      expect(renderNotReady("download", { pct, eta: eta ?? undefined }), `${pct}% ${eta}`).toBe(
        text,
      );
  });

  it("message 2, the span is too long: from the numbers the study was given", () => {
    for (const [span, factor, text] of tooLongRows)
      expect(
        renderNotReady("too_long", {
          span,
          time: span * factor,
          fit: EXAMPLE_LEN_S,
          from: EXAMPLE_FROM_S,
          to: EXAMPLE_FROM_S + EXAMPLE_LEN_S,
          fitTime: EXAMPLE_LEN_S * factor,
        }),
        `${span} s at ${factor}`,
      ).toBe(text);
  });

  it("is what a look is told, wherever the study's three-minute example fits this PC in the cap", () => {
    let compared = 0;
    for (const [span, factor, text] of tooLongRows) {
      const pace = { startupS: 0, rate: factor };
      if (spanLimitS(pace, CAP_S) < EXAMPLE_LEN_S) continue;
      expect(tooLongNotReady(pace, 0, span, CAP_S).note, `${span} s at ${factor}`).toBe(text);
      compared++;
    }
    expect(compared, "rows of the fixture that this checks").toBeGreaterThan(10);
  });

  it("offers fewer minutes on a PC where three would not fit in the cap, and says what those take", () => {
    // 142 s fit in ten minutes at 4.2 s of work per second of audio: the example is the two whole minutes that do
    const slow = { startupS: 0, rate: 4.2 };
    const got = tooLongNotReady(slow, 0, 3600, CAP_S);
    expect(got.fits_seconds).toBe(142);
    expect(got.note).toBe(
      "Transcribing these 60 minutes would take about 4 hours 10 minutes on this PC. " +
        "A span of 2 minutes (for example 05:00 to 07:00) would take about 8 minutes. " +
        "Ask for a shorter span with start_seconds and end_seconds. Don't guess what is said.",
    );
  });

  it("starts the example where the span asked for starts when the study's 05:00 is not inside it", () => {
    const fast = { startupS: 0, rate: 0.5 };
    expect(tooLongNotReady(fast, 0, 3600, CAP_S).values).toMatchObject({ from: 300, to: 480 });
    expect(tooLongNotReady(fast, 1000, 5000, CAP_S).values).toMatchObject({ from: 1000, to: 1180 });
    // a span of 200 s from the start has no room for 05:00 to 08:00, and the example stays inside it
    expect(tooLongNotReady({ startupS: 0, rate: 3.2 }, 0, 200, CAP_S).values).toMatchObject({
      from: 0,
      to: 180,
    });
  });

  it("leaves the parenthesis out when no time left can be told, which the study had no case for", () => {
    const bare =
      "The words are not ready yet. Don't guess what is said. " +
      "Tell the user, and ask again later, or ask for a shorter span if you need them sooner. " +
      "If a shorter span is not ready either, stop asking and tell the user.";
    expect(renderNotReady("words", {})).toBe(bare);
    expect(renderNotReady("words", { eta: Number.NaN })).toBe(bare);
    expect(renderNotReady("words", { eta: 0 })).toBe(bare);
  });

  it("says nothing of its own about a PC too slow for any span: the fourth state is untested, so it is pinned as it is", () => {
    const got = tooLongNotReady(model(30, 80), 0, 120, CAP_S);
    expect(got).toMatchObject({ state: "too_slow", fits_seconds: 0, would_take_s: 9630 });
    expect(got.note).toBe(
      "Transcribing these 2 minutes would take about 2 hours 40 minutes on this PC, and even 10 seconds would take about 15 minutes. " +
        "No span can be transcribed here in 10 minutes. Don't guess what is said. Tell the user, and stop asking.",
    );
  });
});

describe("the table of not-ready words", () => {
  const SAMPLE_VALUES: Record<string, number> = {
    span: 1320,
    time: 4800,
    fit: 180,
    from: 300,
    to: 480,
    fitTime: 600,
    minSpan: 10,
    minTime: 800,
    cap: 600,
    pct: 40,
    eta: 90,
  };
  const numbersOf = (state: (typeof NOT_READY_STATES)[number]): [string, keyof typeof SAY][] => {
    const entry = NOT_READY_WORDS[state];
    return [
      ...(Object.entries(entry.numbers) as [string, keyof typeof SAY][]),
      ...Object.values(entry.optional ?? {}).map((o): [string, keyof typeof SAY] => [
        o.number,
        o.say,
      ]),
    ];
  };

  it("has a state for each of the four things the assistant can be told, and nothing else", () => {
    expect([...NOT_READY_STATES].sort()).toEqual(["download", "too_long", "too_slow", "words"]);
    expect(Object.keys(NOT_READY_WORDS).sort()).toEqual([...NOT_READY_STATES].sort());
  });

  it.each(NOT_READY_STATES)(
    "%s: every placeholder is a number the state declares or an optional piece, and every declared number is used",
    (state) => {
      const entry = NOT_READY_WORDS[state];
      const optional = entry.optional ?? {};
      const named = new Set<string>();
      for (const text of [entry.text, ...Object.values(optional).map((o) => o.text)])
        for (const m of text.matchAll(/\{(\w+)\}/g)) named.add(m[1]);
      const declared = new Set(numbersOf(state).map(([name]) => name));
      for (const name of named)
        expect(declared.has(name) || name in optional, `{${name}} in ${state}`).toBe(true);
      for (const name of declared)
        expect(named.has(name), `${name} is declared and never used in ${state}`).toBe(true);
      for (const [name, say] of numbersOf(state))
        expect(Object.keys(SAY), `how ${name} is said in ${state}`).toContain(say);
    },
  );

  it.each(NOT_READY_STATES)(
    "%s: renders from its numbers with nothing left over, says each as it declares, and says not to guess",
    (state) => {
      const values = Object.fromEntries(
        numbersOf(state).map(([name]) => [name, SAMPLE_VALUES[name]]),
      );
      const text = renderNotReady(state, values);
      expect(text, state).not.toMatch(/\{\w+\}/);
      expect(text, state).toMatch(/Don't guess what is said\./);
      for (const [name, say] of numbersOf(state))
        expect(text, `${name} is shown in ${state}`).toContain(SAY[say](SAMPLE_VALUES[name]));
    },
  );

  it("never lets a raw placeholder through: a missing number is a mistake that fails loudly", () => {
    for (const state of NOT_READY_STATES) {
      if (!Object.keys(NOT_READY_WORDS[state].numbers).length) continue;
      expect(() => renderNotReady(state, {}), state).toThrow(/missing/i);
      const [first] = Object.keys(NOT_READY_WORDS[state].numbers);
      const all = Object.fromEntries(
        Object.keys(NOT_READY_WORDS[state].numbers).map((name) => [name, SAMPLE_VALUES[name]]),
      );
      expect(() => renderNotReady(state, { ...all, [first]: Number.NaN }), state).toThrow(
        /missing/i,
      );
    }
  });
});

describe("what is said agrees with the numbers, whatever they are", () => {
  const seconds = fc.double({ min: 0, max: 400_000, noNaN: true });

  it("says a time within the rounding it promises: the true time is always inside what the words stand for", () => {
    fc.assert(
      fc.property(seconds, (s) => expectSaid(approxTime(s), s)),
      { numRuns: 2000 },
    );
  });

  it("never says less time for more: the words only grow with the seconds", () => {
    fc.assert(
      fc.property(seconds, seconds, (a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(trueMinutes(approxTime(lo))[0]).toBeLessThanOrEqual(trueMinutes(approxTime(hi))[0]);
      }),
      { numRuns: 1000 },
    );
  });

  it("says a length in whole minutes from a minute on and in seconds below it, singular at one", () => {
    fc.assert(
      fc.property(seconds, (s) => {
        const text = lengthWords(s);
        expect(text).toMatch(/^\d+ (second|minute)s?$/);
        expect(text).not.toMatch(/^1 (seconds|minutes)|^0 minute/);
        const said = secondsOfLength(text);
        if (Math.round(s) < 60) expect(said).toBe(Math.round(s));
        else expect(said).toBe(Math.round(s / 60) * 60);
      }),
      { numRuns: 1000 },
    );
  });

  it("says a clock the way the example in the words shows it, and reads back to the same second", () => {
    expect(paddedClock(300)).toBe("05:00");
    expect(paddedClock(480)).toBe("08:00");
    expect(paddedClock(3725)).toBe("1:02:05");
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 400_000 }), (t) => {
        expect(secondsOfClock(paddedClock(t))).toBe(t);
        expect(paddedClock(t)).toMatch(t < 3600 ? /^\d\d:\d\d$/ : /^\d+:\d\d:\d\d$/);
      }),
      { numRuns: 500 },
    );
  });

  it("is safe for numbers that are not numbers: a time, a length and a clock all say nothing, never NaN", () => {
    for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      expect(approxTime(bad)).toBe("less than a minute");
      expect(lengthWords(bad)).toBe("0 seconds");
      expect(paddedClock(bad)).toBe("00:00");
    }
  });
});

describe("what an over-long span is told", () => {
  const asked = fc.tuple(fc.integer({ min: 0, max: 20_000 }), fc.integer({ min: 1, max: 200_000 }));
  const TOO_LONG =
    /^Transcribing these (\d+ \w+) would take (.+?) on this PC\. A span of (\d+ \w+) \(for example (\S+) to (\S+)\) would take (.+?)\. Ask for a shorter span with start_seconds and end_seconds\. Don't guess what is said\.$/;

  it("shows the pace model's own numbers: the span asked and its time, the example and its time", () => {
    fc.assert(
      fc.property(models, asked, (pace, [from, len]) => {
        const fits = spanLimitS(pace, CAP_S);
        fc.pre(fits > 0 && len > fits);
        const got = tooLongNotReady(pace, from, from + len, CAP_S);
        expect(got.state).toBe("too_long");
        expect(got.would_take_s).toBe(Math.round(projectedS(pace, len)));
        expect(got.fits_seconds).toBe(fits);
        const m = TOO_LONG.exec(got.note);
        expect(m, got.note).not.toBeNull();
        const [, askedText, timeText, fitText, fromText, toText, fitTimeText] = m!;
        expect(Math.abs(secondsOfLength(askedText) - len)).toBeLessThanOrEqual(len < 60 ? 0.5 : 30);
        expectSaid(timeText, projectedS(pace, len));
        const fit = secondsOfLength(fitText);
        expect(
          secondsOfClock(toText) - secondsOfClock(fromText),
          "the example is as long as it says",
        ).toBe(fit);
        expectSaid(fitTimeText, projectedS(pace, fit));
      }),
      { numRuns: 400 },
    );
  });

  it("offers an example that ALWAYS fits the cap and lies inside the span asked for, three minutes when this PC can", () => {
    fc.assert(
      fc.property(models, asked, (pace, [from, len]) => {
        const fits = spanLimitS(pace, CAP_S);
        fc.pre(fits > 0 && len > fits);
        const { values } = tooLongNotReady(pace, from, from + len, CAP_S);
        expect(values.fit).toBeGreaterThan(0);
        expect(values.fit).toBeLessThanOrEqual(Math.min(fits, EXAMPLE_LEN_S));
        expect(projectedS(pace, values.fit)).toBeLessThanOrEqual(CAP_S);
        if (fits >= EXAMPLE_LEN_S) expect(values.fit).toBe(EXAMPLE_LEN_S);
        else expect(fits - values.fit, "no more than a minute left on the table").toBeLessThan(60);
        expect(values.from).toBeGreaterThanOrEqual(from);
        expect(values.to).toBeLessThanOrEqual(from + len);
        const studyFits = from <= EXAMPLE_FROM_S && from + len >= EXAMPLE_FROM_S + values.fit;
        expect(values.from).toBe(studyFits ? EXAMPLE_FROM_S : from);
      }),
      { numRuns: 400 },
    );
  });

  it.each([
    [10, 10],
    [59, 59],
    [60, 60],
    [119, 60],
    [120, 120],
    [179, 120],
    [180, 180],
    [181, 180],
    [5000, 180],
  ])("an example for a PC that fits %i s in the cap is %i s", (fits, example) => {
    expect(exampleSpanS(fits)).toBe(example);
  });

  it("says so, and offers nothing, when this PC cannot do even the shortest span worth asking for in the cap", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 120 }),
        fc.double({ min: 60, max: 400, noNaN: true }),
        asked,
        (startup, rate, [from, len]) => {
          const pace = model(startup, rate);
          const got = tooLongNotReady(pace, from, from + len, CAP_S);
          expect(got).toMatchObject({ state: "too_slow", fits_seconds: 0 });
          expect(got.would_take_s).toBe(Math.round(projectedS(pace, len)));
          expect(got.note).toMatch(/even 10 seconds would take about/);
          expect(got.note).toMatch(/stop asking/);
          expect(got.note).not.toMatch(/\{\w+\}/);
          expectSaid(/would take (.+?) on this PC/.exec(got.note)![1], projectedS(pace, len));
          expectSaid(/even 10 seconds would take (.+?)\./.exec(got.note)![1], projectedS(pace, 10));
        },
      ),
      { numRuns: 200 },
    );
  });
});
