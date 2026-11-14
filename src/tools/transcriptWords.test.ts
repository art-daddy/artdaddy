// What the assistant is told when a transcript is not ready, as DATA: one table of words keyed by
// state, each rendered from its numbers by one pure function. The final wording of three of these
// waits for the A/B (S2-12), so the tests pin what must stay true when the words change: every
// state renders, no placeholder is left, the numbers are the pace model's, and a span that is
// offered always fits.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { projectedS, spanLimitS, type PaceModel } from "./speechPace";
import { CAP_S } from "./speechPlan";
import {
  clock,
  formatDuration,
  NOT_READY_CLAUSES,
  NOT_READY_STATES,
  NOT_READY_WORDS,
  renderNotReady,
  tooLongNotReady,
} from "./transcriptWords";

/** The two wordings of 0.27.0 (`transcriptWait.ts`), copied as they were: the default must not move. */
const DO_NOT_GUESS =
  "Do not guess or describe what is said. The frames, metadata and loudness in this result are final. " +
  "Call inspect_media again with the same arguments: it returns the words at once when they are done, " +
  "or pass wait_seconds (up to 60) to wait for them.";
function oldNote(
  stage: "transcribing" | "downloading_speech_model",
  label: string,
  eta: number | undefined,
  waited: number,
  pct: number | undefined,
): string {
  const left = eta === undefined ? "" : `, about ${eta} s to go`;
  if (stage === "downloading_speech_model")
    return (
      `The transcript is not ready: the speech model is still downloading (${pct ?? 0}%${left}). ` +
      `This one-time download happens the first time speech is transcribed on this computer, and ` +
      `the transcription starts when it ends. ${DO_NOT_GUESS} Tell the user the speech model is downloading.`
    );
  const took = waited > 0 ? ` (this call waited ${waited} s)` : "";
  return (
    `The transcript is not ready: the speech in this ${label} of audio is still being transcribed${left}${took}. ` +
    `${DO_NOT_GUESS} Tell the user it is still being transcribed.`
  );
}

const model = (startupS: number, rate: number): PaceModel => ({
  backend: "cpu",
  startupS,
  rate,
  runs: 1,
});
const models = fc
  .tuple(fc.integer({ min: 1, max: 120 }), fc.double({ min: 0.02, max: 12, noNaN: true }))
  .map(([s, r]) => model(s, r));

describe("the words of the existing states are what 0.27.0 said, byte for byte", () => {
  it("is so for every combination of a label, a time left, a wait and a percent", () => {
    fc.assert(
      fc.property(
        // add_captions does not know how long the speech is, and passes no label at all
        fc.oneof(fc.constant(""), fc.stringMatching(/^[0-9]{1,2}:[0-5][0-9]$/)),
        fc.option(fc.integer({ min: 1, max: 3600 }), { nil: undefined }),
        fc.integer({ min: 0, max: 60 }),
        fc.option(fc.integer({ min: 0, max: 100 }), { nil: undefined }),
        (label, eta, waited, pct) => {
          expect(renderNotReady("words", { label, eta, waited })).toBe(
            oldNote("transcribing", label, eta, waited, undefined),
          );
          expect(renderNotReady("download", { pct: pct ?? 0, eta })).toBe(
            oldNote("downloading_speech_model", label, eta, waited, pct),
          );
        },
      ),
    );
  });
});

describe("the table of not-ready words", () => {
  const SAMPLE_VALUES: Record<string, string | number> = {
    label: "2:00",
    span: "22 minutes",
    time: "1 hour 20 minutes",
    fit: "3 minutes",
    from: "5:00",
    to: "8:00",
    fitTime: "10 minutes",
    minSpan: "10 seconds",
    minTime: "2 minutes",
    cap: "10 minutes",
    pct: 40,
    eta: 90,
    waited: 15,
  };

  it("has a state for each of the four things the assistant can be told, and nothing else", () => {
    expect([...NOT_READY_STATES].sort()).toEqual(["download", "too_long", "too_slow", "words"]);
    expect(Object.keys(NOT_READY_WORDS).sort()).toEqual([...NOT_READY_STATES].sort());
  });

  it.each(NOT_READY_STATES)(
    "%s: every placeholder in its words is a number the state declares, an optional piece, or a shared clause",
    (state) => {
      const entry = NOT_READY_WORDS[state];
      const named = new Set<string>();
      for (const text of [entry.text, ...Object.values(entry.optional ?? {}).map((o) => o.text)])
        for (const m of text.matchAll(/\{(\w+)\}/g)) named.add(m[1]);
      for (const name of named) {
        const known =
          entry.numbers.includes(name) ||
          name in (entry.optional ?? {}) ||
          Object.values(entry.optional ?? {}).some((o) => o.number === name) ||
          name in NOT_READY_CLAUSES;
        expect(known, `{${name}} in ${state}`).toBe(true);
      }
      for (const n of entry.numbers)
        expect(
          named.has(n) || Object.values(entry.optional ?? {}).some((o) => o.number === n),
          `${n} is declared and never used in ${state}`,
        ).toBe(true);
    },
  );

  it.each(NOT_READY_STATES)(
    "%s: renders from its numbers with nothing left over, and says not to guess",
    (state) => {
      const entry = NOT_READY_WORDS[state];
      const values = Object.fromEntries(
        [...entry.numbers, ...Object.values(entry.optional ?? {}).map((o) => o.number)].map((n) => [
          n,
          SAMPLE_VALUES[n],
        ]),
      );
      const text = renderNotReady(state, values);
      expect(text, state).not.toMatch(/\{\w+\}/);
      expect(text, state).toMatch(/guess/i);
      for (const [name, v] of Object.entries(values))
        expect(text, `${name} is shown in ${state}`).toContain(String(v));
    },
  );

  it("never lets a raw placeholder through: a missing number is a mistake that fails loudly", () => {
    for (const state of NOT_READY_STATES) {
      const needed = NOT_READY_WORDS[state].numbers;
      if (!needed.length) continue;
      expect(() => renderNotReady(state, {}), state).toThrow(/missing/i);
    }
  });
});

describe("what an over-long span is told", () => {
  const asked = fc.tuple(fc.integer({ min: 0, max: 20_000 }), fc.integer({ min: 1, max: 200_000 }));

  it("shows the pace model's own numbers: the time of the asked span, and the span that fits and its time", () => {
    fc.assert(
      fc.property(models, asked, (pace, [from, len]) => {
        const fits = spanLimitS(pace, CAP_S);
        fc.pre(len > fits);
        const got = tooLongNotReady(pace, from, from + len, CAP_S);
        expect(got.would_take_s).toBe(Math.round(projectedS(pace, len)));
        expect(got.fits_seconds).toBe(fits);
        expect(got.note).toContain(formatDuration(got.would_take_s));
        if (fits > 0) {
          expect(got.state).toBe("too_long");
          expect(got.note).toContain(
            formatDuration(Math.round(projectedS(pace, got.values.offerS))),
          );
          expect(got.note).toContain(clock(from));
          expect(got.note).toContain(clock(from + got.values.offerS));
        }
      }),
      { numRuns: 300 },
    );
  });

  it("offers a span that ALWAYS fits the cap, not rounded up past it, and as long as can be said in whole minutes", () => {
    fc.assert(
      fc.property(models, asked, (pace, [from, len]) => {
        const fits = spanLimitS(pace, CAP_S);
        fc.pre(fits > 0 && len > fits);
        const { values } = tooLongNotReady(pace, from, from + len, CAP_S);
        expect(values.offerS).toBeGreaterThan(0);
        expect(values.offerS).toBeLessThanOrEqual(fits);
        expect(projectedS(pace, values.offerS)).toBeLessThanOrEqual(CAP_S);
        expect(fits - values.offerS, "no more than a minute left on the table").toBeLessThan(60);
      }),
      { numRuns: 300 },
    );
  });

  it("says so, and offers nothing, when this PC cannot do even the shortest span worth asking for in the cap", () => {
    const slow = model(30, 80); // 80 s of work for each second of speech
    const got = tooLongNotReady(slow, 0, 120, CAP_S);
    expect(got.state).toBe("too_slow");
    expect(got.fits_seconds).toBe(0);
    expect(got.note).toMatch(/even/);
    expect(got.note).not.toMatch(/\{\w+\}/);
  });

  it("is the same words whatever the order of magnitude: from seconds to days", () => {
    for (const s of [0, 1, 59, 60, 89, 90, 3_599, 3_600, 5_400, 86_400, 1e7])
      expect(formatDuration(s), String(s)).toMatch(
        /^\d+ (second|minute|hour|day)s?( \d+ (second|minute|hour)s?)?$/,
      );
    expect(formatDuration(Number.NaN)).toBe("0 seconds");
  });
});
