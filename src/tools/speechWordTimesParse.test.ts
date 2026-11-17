// The parser's word times, from REAL whisper outputs of the engine's dtw run (the first-word fix). What is checked is
// what comes out: where the first word of a clip with silence in front of it starts, that the words stay in order and
// never overlap, that the segment follows its first word, and that with the behaviour off (or a run that made no
// dtw) the parse is what 0.27.0 made of the same file, byte for byte (the frozen parse of __fixtures__/wordTimes).
import { readFileSync } from "node:fs";
import path from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  fmtTimestamp,
  fmtTimestampPrecise,
  parseWhisperCppJson,
  type ParsedTranscript,
} from "./transcribe";

const DIR = path.join(__dirname, "__fixtures__", "wordTimes");
const REAL = [
  "en-leading-silence.json",
  "ar-leading-silence.json",
  "de-long-first-segment.json",
  "ja-unspaced.json",
  "zh-unspaced.json",
  "en-first-segment-starts-late.json",
];
const SPACED = [
  "en-leading-silence.json",
  "ar-leading-silence.json",
  "de-long-first-segment.json",
  "en-first-segment-starts-late.json",
];

interface RawToken {
  text: string;
  offsets?: { from: number; to: number };
  p?: number;
  t_dtw?: unknown;
}
interface RawJson {
  result?: { language: string };
  transcription: Array<{
    offsets?: { from: number; to: number };
    text: string;
    tokens?: RawToken[];
  }>;
}
const rawText = (name: string): string => readFileSync(path.join(DIR, name), "utf8");
const rawJson = (name: string): RawJson => JSON.parse(rawText(name)) as RawJson;
const frozen = JSON.parse(rawText("frozen-0.27.0.json")) as {
  real: Record<string, ParsedTranscript>;
  synthetic: Record<string, { input: RawJson; output: ParsedTranscript }>;
};

const on = (json: unknown): ParsedTranscript =>
  parseWhisperCppJson(JSON.stringify(json), { wordTimes: true });
const off = (json: unknown): ParsedTranscript =>
  parseWhisperCppJson(JSON.stringify(json), { wordTimes: false });
/** The same file as an engine made it without -dtw: every token's time is -1. */
const noDtw = (json: unknown): unknown =>
  JSON.parse(
    JSON.stringify(json, (key, value: unknown) => (key === "t_dtw" ? -1 : value)),
  ) as unknown;
const isText = (t: RawToken): boolean => t.text.trim() !== "" && !/^\s*\[_/.test(t.text);

/** What every parsed transcript made WITH word times must hold, whatever the sound said. */
function expectSettled(t: ParsedTranscript, label: string): void {
  expect(t.words, label).toEqual(t.segments.flatMap((s) => s.words));
  t.words.forEach((w, i) => {
    expect(
      Number.isFinite(w.start_seconds) && Number.isFinite(w.end_seconds),
      `${label}: word ${i} is a time`,
    ).toBe(true);
    expect(w.start_seconds, `${label}: word ${i} is not before 0`).toBeGreaterThanOrEqual(0);
    expect(w.end_seconds, `${label}: word ${i} ends after it starts`).toBeGreaterThanOrEqual(
      w.start_seconds,
    );
    expect(w.start_timestamp).toBe(fmtTimestampPrecise(w.start_seconds));
    expect(w.end_timestamp).toBe(fmtTimestampPrecise(w.end_seconds));
    if (i > 0) {
      expect(
        w.start_seconds,
        `${label}: word ${i} does not start before word ${i - 1}`,
      ).toBeGreaterThanOrEqual(t.words[i - 1].start_seconds);
      expect(
        t.words[i - 1].end_seconds,
        `${label}: word ${i - 1} ends where word ${i} starts at the latest`,
      ).toBeLessThanOrEqual(w.start_seconds);
    }
  });
  for (const s of t.segments) {
    expect(s.start_timestamp).toBe(fmtTimestamp(s.start_seconds));
    expect(s.end_timestamp).toBe(fmtTimestamp(s.end_seconds));
    expect(s.end_seconds, `${label}: segment ${s.segment_id}`).toBeGreaterThanOrEqual(
      s.start_seconds,
    );
  }
  expect(t.duration_seconds).toBe(Math.max(0, ...t.segments.map((s) => s.end_seconds)));
}

/** Everything about a transcript but its times. */
const withoutTimes = (t: ParsedTranscript): unknown => ({
  language: t.language,
  segments: t.segments.map((s) => ({
    segment_id: s.segment_id,
    text: s.text,
    words: s.words.map((w) => [w.word_id, w.segment_id, w.index_in_segment, w.word, w.probability]),
  })),
  words: t.words.map((w) => [w.word_id, w.segment_id, w.index_in_segment, w.word, w.probability]),
});

describe("0.27.0 is what the parser makes of a file with the behaviour off, or of a run that made no dtw", () => {
  it.each(REAL)("%s: off by name, it parses exactly as the frozen 0.27.0 parse", (name) => {
    expect(parseWhisperCppJson(rawText(name), { wordTimes: false })).toStrictEqual(
      frozen.real[name],
    );
  });

  it.each(REAL)(
    "%s: with the behaviour ON, the same file from a run without -dtw (every t_dtw is -1) parses as it always did",
    (name) => {
      expect(on(noDtw(rawJson(name)))).toStrictEqual(frozen.real[name]);
    },
  );

  it.each(Object.keys(frozen.synthetic))(
    "%s: t_dtw of every wild kind changes nothing while it is off, and nothing is read from it",
    (name) => {
      const { input, output } = frozen.synthetic[name];
      expect(off(input)).toStrictEqual(output);
      const without = JSON.parse(
        JSON.stringify(input, (key, value: unknown) => (key === "t_dtw" ? undefined : value)),
      ) as unknown;
      expect(off(without)).toStrictEqual(output);
    },
  );

  it("is untouched, out of order as it is, when no token has a usable dtw (nothing is settled that the sound did not move)", () => {
    const backwards = {
      result: { language: "en" },
      transcription: [
        {
          offsets: { from: 0, to: 3000 },
          text: " b a",
          tokens: [
            { text: " b", offsets: { from: 2000, to: 2500 }, p: 0.9, t_dtw: -1 },
            { text: " a", offsets: { from: 1000, to: 1800 }, p: 0.8, t_dtw: -1 },
          ],
        },
      ],
    };
    expect(on(backwards)).toStrictEqual(off(backwards));
    expect(on(backwards).words.map((w) => w.start_seconds)).toEqual([2, 1]);
    // t_dtw there but not usable (further than a whisper window from where it was stored) is the same.
    const far = JSON.parse(
      JSON.stringify(backwards).replaceAll('"t_dtw":-1', '"t_dtw":99999'),
    ) as unknown;
    expect(on(far)).toStrictEqual(off(far));
  });
});

describe("the first word of a clip with silence in front of it, from real outputs of the dtw run", () => {
  it.each(REAL)(
    "%s: starts where the sound starts (its t_dtw), not where whisper stored it",
    (name) => {
      const json = rawJson(name);
      const first = json.transcription[0].tokens!.find(isText)!;
      const got = on(json);
      expect(got.words[0].start_seconds).toBe(((first.t_dtw as number) * 10) / 1000);
      expect(frozen.real[name].words[0].start_seconds).toBe(first.offsets!.from / 1000);
      expect(got.words[0].start_seconds).toBeGreaterThan(frozen.real[name].words[0].start_seconds);
    },
  );

  it.each(REAL)("%s: every word is in order, nothing overlaps, and nothing is below 0", (name) => {
    expectSettled(on(rawJson(name)), name);
  });

  it.each(REAL)(
    "%s: only times differ from 0.27.0: the words, their order, ids, probabilities and the segments' texts are the same",
    (name) => {
      expect(withoutTimes(on(rawJson(name)))).toStrictEqual(withoutTimes(frozen.real[name]));
    },
  );

  it.each(REAL)(
    "%s: the first segment starts where its first word does (it started at 0 or at a guess, and the first word is later)",
    (name) => {
      const got = on(rawJson(name));
      expect(frozen.real[name].segments[0].start_seconds).toBeLessThan(got.words[0].start_seconds);
      expect(got.segments[0].start_seconds).toBe(got.words[0].start_seconds);
    },
  );

  it.each(SPACED)(
    "%s: each word starts on the sound of its first token, as the engine's alignment says",
    (name) => {
      const json = rawJson(name);
      const starts = json.transcription.flatMap((seg) => {
        const tokens = seg.tokens!.filter(isText);
        return tokens
          .filter((t, i) => i === 0 || /^\s/.test(t.text))
          .map((t) => ((t.t_dtw as number) * 10) / 1000);
      });
      expect(on(json).words.map((w) => w.start_seconds)).toEqual(starts);
    },
  );

  it("moves a word that the dtw puts earlier than it was stored (a stretch whisper's own times ran late over), and it still ends before the next one starts", () => {
    const json = rawJson("ja-unspaced.json");
    const got = on(json);
    const base = frozen.real["ja-unspaced.json"];
    const earlier = got.words.filter((w, i) => w.start_seconds < base.words[i].start_seconds);
    expect(earlier.length).toBeGreaterThan(0);
    expectSettled(got, "ja");
  });

  it("splits unspaced scripts into the same words as 0.27.0 did, each on the sound of its first character", () => {
    for (const name of ["ja-unspaced.json", "zh-unspaced.json"]) {
      const got = on(rawJson(name));
      expect(got.words.map((w) => w.word)).toEqual(frozen.real[name].words.map((w) => w.word));
      const firstSound = rawJson(name).transcription[0].tokens!.find(isText)!.t_dtw as number;
      expect(got.words[0].start_seconds).toBe((firstSound * 10) / 1000);
    }
  });
});

/** One segment of hand-made tokens, each [text, stored from, stored to, t_dtw]. */
const segment = (from: number, to: number, tokens: Array<[string, number, number, unknown]>) => ({
  offsets: { from, to },
  text: tokens.map((t) => t[0]).join(""),
  tokens: tokens.map(([text, a, b, d]) => ({
    text,
    offsets: { from: a, to: b },
    p: 0.9,
    t_dtw: d,
  })),
});
const doc = (...segments: unknown[]): unknown => ({
  result: { language: "en" },
  transcription: segments,
});
const times = (t: ParsedTranscript): Array<[string, number, number]> =>
  t.words.map((w) => [w.word, w.start_seconds, w.end_seconds]);

describe("what the settling does to words the sound puts on top of each other or out of order", () => {
  it("cuts a word back to where the next one starts when its stored length runs over it", () => {
    const json = doc(
      segment(0, 3000, [
        [" one", 0, 900, 100],
        [" two", 900, 1300, 120],
      ]),
    );
    expect(times(off(json))).toEqual([
      ["one", 0, 0.9],
      ["two", 0.9, 1.3],
    ]);
    expect(times(on(json))).toEqual([
      ["one", 1, 1.2],
      ["two", 1.2, 1.6],
    ]);
  });

  it("keeps the order when the alignment's times go backwards: a start is never before the start of the word before it", () => {
    const json = doc(
      segment(0, 3000, [
        [" one", 0, 500, 300],
        [" two", 500, 900, 200],
        [" three", 900, 1500, 400],
      ]),
    );
    expect(times(on(json))).toEqual([
      ["one", 3, 3],
      ["two", 3, 3],
      ["three", 4, 4.6],
    ]);
  });

  it("keeps order across segments too: a first word never starts before the last word of the segment before it", () => {
    const json = doc(
      segment(0, 3000, [[" one", 0, 500, 500]]),
      segment(3000, 6000, [[" two", 3000, 3500, 100]]),
    );
    // "two" sounds at 1 s by the alignment, but "one" is at 5 s: it follows it.
    expect(times(on(json))).toEqual([
      ["one", 5, 5],
      ["two", 5, 5],
    ]);
  });

  it("gives a token that has no usable time its stored time, whatever its neighbours do: -1 is not 'at the very start'", () => {
    const json = doc(
      segment(0, 3000, [
        [" one", 500, 900, -1],
        [" two", 900, 1300, 200],
      ]),
    );
    expect(times(on(json))).toEqual([
      ["one", 0.5, 0.9],
      ["two", 2, 2.4],
    ]);
  });

  it("refuses a time more than a whisper window away from the stored one and keeps that token where it was stored", () => {
    const json = doc(
      segment(0, 3000, [
        [" one", 1000, 1400, 5000],
        [" two", 1400, 1800, 150],
      ]),
    );
    expect(times(on(json))).toEqual([
      ["one", 1, 1.4],
      ["two", 1.5, 1.9],
    ]);
  });

  it("takes the length of a word from its tokens' stored lengths: first token's start to last token's end, both on the sound", () => {
    const json = doc(
      segment(0, 3000, [
        [" hel", 0, 300, 100],
        ["lo", 300, 700, 140],
      ]),
    );
    expect(times(on(json))).toEqual([["hello", 1, 1.8]]);
  });

  it("makes a segment start where its first word starts and end where its last word ends when that is later than it was stored", () => {
    const got = on(
      doc(
        segment(0, 2000, [
          [" late", 0, 900, 100],
          [" later", 900, 1300, 400],
        ]),
      ),
    );
    expect(got.segments[0].start_seconds).toBe(1);
    expect(got.segments[0].end_seconds).toBe(4.4);
    expect(got.duration_seconds).toBe(4.4);
  });

  it("keeps a segment's stored start when its first word comes earlier, and its stored end when it is the later", () => {
    const got = on(doc(segment(5000, 9000, [[" early", 5000, 5400, 450]])));
    expect(got.words[0].start_seconds).toBe(4.5);
    expect(got.segments[0].start_seconds).toBe(5);
    expect(got.segments[0].end_seconds).toBe(9);
    expect(got.duration_seconds).toBe(9);
  });

  it("leaves a segment of annotations only exactly as it was, between two that moved", () => {
    const json = doc(
      segment(0, 2000, [[" a", 0, 400, 50]]),
      segment(2000, 3000, [
        [" [", 2000, 2100, 210],
        ["BLANK", 2100, 2800, 230],
        ["]", 2800, 3000, 290],
      ]),
      segment(3000, 4000, [[" b", 3000, 3400, 330]]),
    );
    const got = on(json);
    expect(got.segments[1]).toStrictEqual(off(json).segments[1]);
    expect(got.segments[1].words).toEqual([]);
    expect(times(got)).toEqual([
      ["a", 0.5, 0.9],
      ["b", 3.3, 3.7],
    ]);
  });

  it("works for a token with no stored time: the segment's start is where it was stored", () => {
    const json = {
      transcription: [
        { offsets: { from: 500, to: 1500 }, text: " one", tokens: [{ text: " one", t_dtw: 90 }] },
      ],
    };
    expect(times(on(json))).toEqual([["one", 0.9, 0.9]]);
  });
});

describe("the parser for ANY file: the same words with the same times as 0.27.0 unless the engine's dtw moved them", () => {
  const TEXTS = [
    " Hello",
    " wor",
    "ld",
    ".",
    ",",
    " [",
    "Music",
    "]",
    " (",
    "laugh",
    ")",
    " a",
    "b",
    " 世",
    "界",
    "こん",
    " ",
    "[_BEG_]",
    "[_TT_50]",
  ];
  const dtw = fc.oneof(
    fc.constant(-1),
    fc.integer({ min: 0, max: 13_000 }),
    fc.integer({ min: 0, max: 400 }),
    fc.double(),
    fc.constantFrom("5", null, undefined, 1e15, -0),
  );
  const token = fc.record(
    {
      text: fc.constantFrom(...TEXTS),
      offsets: fc.record({
        from: fc.integer({ min: 0, max: 120_000 }),
        to: fc.integer({ min: 0, max: 120_000 }),
      }),
      p: fc.double({ min: 0, max: 1, noNaN: true }),
      t_dtw: dtw,
    },
    { requiredKeys: ["text"] },
  );
  const seg = fc.record(
    {
      offsets: fc
        .record({
          from: fc.integer({ min: 0, max: 120_000 }),
          length: fc.integer({ min: 0, max: 30_000 }),
        })
        .map(({ from, length }) => ({ from, to: from + length })),
      text: fc.constantFrom(" Hello world.", " [BLANK_AUDIO]", "   ", " 世界", "x"),
      tokens: fc.array(token, { maxLength: 10 }),
    },
    { requiredKeys: ["text"] },
  );
  // One first segment whose token is certain to carry a usable time, so the settling is always in force.
  const anchor = {
    offsets: { from: 1000, to: 4000 },
    text: " Hello",
    tokens: [{ text: " Hello", offsets: { from: 1000, to: 1500 }, p: 0.9, t_dtw: 150 }],
  };
  const timed = fc.array(seg, { maxLength: 4 }).map((rest) => doc(anchor, ...rest) as RawJson);
  const anyDoc = fc.array(seg, { maxLength: 4 }).map((rest) => doc(...rest) as RawJson);

  it("never throws, and with the settling in force every invariant holds, whatever the sound said", () => {
    fc.assert(
      fc.property(timed, (json) => {
        expectSettled(on(json), "random");
      }),
      { numRuns: 250 },
    );
  });

  it("changes only times: words, order, ids, probabilities, texts and the segments' texts are 0.27.0's", () => {
    fc.assert(
      fc.property(timed, (json) => {
        expect(withoutTimes(on(json))).toStrictEqual(withoutTimes(off(json)));
      }),
      { numRuns: 250 },
    );
  });

  it("makes each segment follow its words from where it was stored: later at the start, later at the end, never earlier at either", () => {
    fc.assert(
      fc.property(timed, (json) => {
        const got = on(json);
        const base = off(json);
        let end = base.duration_seconds;
        got.segments.forEach((s, i) => {
          const stored = base.segments[i];
          if (s.words.length === 0) {
            expect([s.start_seconds, s.end_seconds]).toEqual([
              stored.start_seconds,
              stored.end_seconds,
            ]);
          } else {
            expect(s.start_seconds).toBe(Math.max(stored.start_seconds, s.words[0].start_seconds));
            expect(s.end_seconds).toBe(
              Math.max(stored.end_seconds, s.words[s.words.length - 1].end_seconds),
            );
          }
          end = Math.max(end, s.end_seconds);
        });
        expect(got.duration_seconds).toBe(end);
      }),
      { numRuns: 250 },
    );
  });

  it("is exactly 0.27.0's parse when no token is given a time (every t_dtw -1), for any file", () => {
    fc.assert(
      fc.property(anyDoc, (json) => {
        expect(on(noDtw(json))).toStrictEqual(off(json));
      }),
      { numRuns: 250 },
    );
  });

  it("is exactly 0.27.0's parse when it is off, whatever t_dtw holds, and nothing is ever read from t_dtw then", () => {
    fc.assert(
      fc.property(anyDoc, (json) => {
        expect(off(json)).toStrictEqual(off(noDtw(json)));
      }),
      { numRuns: 250 },
    );
  });
});
