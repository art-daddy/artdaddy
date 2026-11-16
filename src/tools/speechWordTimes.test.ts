// The first-word fix's pure rules: which launches get word times, where a token sits once its own sound time is
// used, and how the words of a transcript are settled. What is checked is the outcome of each rule for any input,
// not how it is computed: the one launch that carries the arguments is named, every other of the 32 is not.
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { MODEL_MANIFEST } from "./modelManifest";
import {
  __resetWordTimesShipped,
  __setWordTimesShipped,
  DTW_ARGS,
  segmentFollowsWords,
  settleWords,
  tokenOnSound,
  WINDOW_MS,
  WORD_TIMES_MODELS,
  WORD_TIMES_SHIPPED,
  wordTimesArgs,
  wordTimesOn,
} from "./speechWordTimes";

beforeEach(() => {
  __resetExportFlags();
  __resetWordTimesShipped();
});
afterEach(() => {
  __resetExportFlags();
  __resetWordTimesShipped();
});

const SIZES = ["small", "base", "large", ""];
const arguments_ = (gate: boolean, flag: boolean, size: string, cpuOnly: boolean): string[] => {
  __setWordTimesShipped(gate);
  __setExportFlag("speech_word_times", flag);
  return wordTimesArgs({ size, cpuOnly });
};

describe("which launches carry word times", () => {
  // The release decision: this build ships the behaviour dark. A release that turns it on changes this line
  // on purpose, after the owner has looked at real captions and a graphics-chip PC has been measured.
  it("ships dark: the build's own gate is off, so nothing carries them", () => {
    expect(WORD_TIMES_SHIPPED).toBe(false);
    expect(wordTimesOn()).toBe(false);
    for (const size of SIZES)
      for (const cpuOnly of [true, false]) expect(wordTimesArgs({ size, cpuOnly })).toEqual([]);
  });

  it("is ONE launch of the 32 combinations of gate, flag, size and backend: the processor, on the measured model, with both on", () => {
    const rows: Array<{ gate: boolean; flag: boolean; size: string; cpuOnly: boolean }> = [];
    for (const gate of [true, false])
      for (const flag of [true, false])
        for (const size of SIZES)
          for (const cpuOnly of [true, false]) rows.push({ gate, flag, size, cpuOnly });
    expect(rows).toHaveLength(32);
    const carrying = rows.filter((r) => arguments_(r.gate, r.flag, r.size, r.cpuOnly).length > 0);
    expect(carrying).toEqual([{ gate: true, flag: true, size: "small", cpuOnly: true }]);
    expect(arguments_(true, true, "small", true)).toEqual(["-dtw", "small", "-nfa"]);
  });

  it("never gives the smaller model file (the processor-only one) word times, with everything on: nobody measured the alignment with it", () => {
    for (const cpuOnly of [true, false])
      expect(arguments_(true, true, "small_q8_0", cpuOnly), `cpuOnly ${cpuOnly}`).toEqual([]);
    // The rule is ONE list of manifest keys (the line a release that measures the smaller file changes), and every
    // key in it is a file of the manifest.
    expect(WORD_TIMES_MODELS).not.toContain("small_q8_0");
    for (const key of WORD_TIMES_MODELS) expect(MODEL_MANIFEST[key], key).toBeDefined();
    expect(
      Object.keys(MODEL_MANIFEST).filter((k) => arguments_(true, true, k, true).length > 0),
    ).toEqual([...WORD_TIMES_MODELS]);
  });

  it("is 0.27.0 for the opposite ordering: the gate on and the flag off (the operator's way back) carries nothing, on any model and backend", () => {
    for (const size of SIZES)
      for (const cpuOnly of [true, false])
        expect(arguments_(true, false, size, cpuOnly), size).toEqual([]);
  });

  it("gives every launch its own array, so a caller that edits the arguments edits nobody else's", () => {
    const first = arguments_(true, true, "small", true);
    first.push("-x");
    first[0] = "changed";
    expect(wordTimesArgs({ size: "small", cpuOnly: true })).toEqual([...DTW_ARGS]);
  });

  it("follows the flag live: the answer changes when the server's answer does, not only at start", () => {
    __setWordTimesShipped(true);
    expect(wordTimesOn()).toBe(true);
    __setExportFlag("speech_word_times", false);
    expect(wordTimesOn()).toBe(false);
    __setExportFlag("speech_word_times", true);
    expect(wordTimesOn()).toBe(true);
  });
});

describe("a token's own sound time", () => {
  it("moves the token onto its dtw time and keeps its length (the Arabic clip: a first word stored at 0 that sounds at 0.94 s)", () => {
    expect(tokenOnSound({ from: 0, to: 270 }, 94)).toEqual({ from: 940, to: 1210 });
  });

  it("moves a token earlier too: the sound can come before where whisper stored it", () => {
    expect(tokenOnSound({ from: 5000, to: 5400 }, 380)).toEqual({ from: 3800, to: 4200 });
  });

  it("takes only a finite number of 0 or more: -1 (none), NaN, infinity, text, null, a list and an object are no time", () => {
    for (const bad of [
      -1,
      -0.5,
      NaN,
      Infinity,
      -Infinity,
      "94",
      "",
      null,
      undefined,
      [94],
      { v: 94 },
      true,
    ])
      expect(tokenOnSound({ from: 0, to: 270 }, bad), String(bad)).toBeNull();
    expect(tokenOnSound({ from: 0, to: 270 }, 0)).toEqual({ from: 0, to: 270 });
  });

  it("refuses a time more than a whisper window (30 s) from where it was stored, from either side, and takes exactly 30 s", () => {
    expect(tokenOnSound({ from: 0, to: 100 }, WINDOW_MS / 10)).toEqual({
      from: WINDOW_MS,
      to: WINDOW_MS + 100,
    });
    expect(tokenOnSound({ from: 0, to: 100 }, WINDOW_MS / 10 + 0.1)).toBeNull();
    expect(tokenOnSound({ from: 40_000, to: 40_100 }, 1000)).toEqual({ from: 10_000, to: 10_100 });
    expect(tokenOnSound({ from: 40_001, to: 40_100 }, 1000)).toBeNull();
  });

  it("works in whole milliseconds, so a time on a window's clock (moved by a part of 10 ms) stays a whole number", () => {
    const moved = tokenOnSound({ from: 12_345, to: 12_800 }, 94 + 1234.5);
    expect(moved).toEqual({ from: 13_285, to: 13_740 });
    expect(Number.isInteger(moved!.from)).toBe(true);
  });

  it("holds for any stored interval and any value: a time is taken only if it is the number it says, keeps the length, and is never further than 30 s", () => {
    const anyValue = fc.oneof(
      fc.integer({ min: -5, max: 100_000 }),
      fc.double(),
      fc.constantFrom("12", "", null, undefined, true, [], {}),
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 60_000 }),
        anyValue,
        (from, length, value) => {
          const moved = tokenOnSound({ from, to: from + length }, value);
          if (moved === null) return;
          expect(typeof value).toBe("number");
          expect(Number.isFinite(value)).toBe(true);
          expect(value as number).toBeGreaterThanOrEqual(0);
          expect(moved.from === Math.round((value as number) * 10)).toBe(true);
          expect(moved.to - moved.from).toBe(length);
          expect(Math.abs(moved.from - from)).toBeLessThanOrEqual(WINDOW_MS);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("settling the words of a transcript", () => {
  const settled = (words: Array<[number, number]>): Array<[number, number]> =>
    settleWords(words.map(([start, end]) => ({ start, end }))).map((w) => [w.start, w.end]);

  it("leaves words that are already in order and apart exactly as they are, touching ones too (no harm where nothing is wrong)", () => {
    const words: Array<[number, number]> = [
      [0.2, 0.7],
      [0.7, 1.1],
      [1.5, 1.5],
      [2, 3],
    ];
    expect(settled(words)).toEqual(words);
  });

  it("pushes a start that comes before the word before it up to that word's start", () => {
    expect(
      settled([
        [1, 2],
        [0.5, 3],
        [4, 5],
      ]),
    ).toEqual([
      [1, 1],
      [1, 3],
      [4, 5],
    ]);
  });

  it("makes an end that is before its own start end where it starts", () => {
    expect(settled([[2, 1]])).toEqual([[2, 2]]);
  });

  it("cuts a word that runs over the next one back to where the next one starts: they touch, they never overlap", () => {
    expect(
      settled([
        [0, 5],
        [3, 4],
        [3.5, 9],
      ]),
    ).toEqual([
      [0, 3],
      [3, 3.5],
      [3.5, 9],
    ]);
  });

  it("never lets a time go below 0", () => {
    expect(
      settled([
        [-3, -1],
        [-2, 4],
      ]),
    ).toEqual([
      [0, 0],
      [0, 4],
    ]);
  });

  it("settles an empty list and a single word", () => {
    expect(settled([])).toEqual([]);
    expect(settled([[1, 2]])).toEqual([[1, 2]]);
  });

  it("takes a time that is not a number as no time: the word starts where the word before it did and ends where it starts", () => {
    expect(
      settled([
        [1, 2],
        [NaN, NaN],
        [Infinity, 5],
        [3, -Infinity],
      ]),
    ).toEqual([
      [1, 1],
      [1, 1],
      [1, 3],
      [3, 3],
    ]);
  });

  it("does not touch what it is given", () => {
    const given = [{ start: 3, end: 1 }];
    settleWords(given);
    expect(given).toEqual([{ start: 3, end: 1 }]);
  });

  const anyTime = fc.oneof(
    fc.double({ min: -50, max: 500, noNaN: true }),
    fc.constantFrom(NaN, Infinity, -Infinity, 0, -0),
  );
  const anyWords = fc.array(fc.record({ start: anyTime, end: anyTime }), { maxLength: 40 });

  it("holds for any words at all: starts never go back, an end is never before its start, no two overlap, nothing is below 0 or not a number", () => {
    fc.assert(
      fc.property(anyWords, (words) => {
        const out = settleWords(words);
        expect(out).toHaveLength(words.length);
        out.forEach((w, i) => {
          expect(Number.isFinite(w.start) && Number.isFinite(w.end), `word ${i} is a number`).toBe(
            true,
          );
          expect(w.start).toBeGreaterThanOrEqual(0);
          expect(w.end).toBeGreaterThanOrEqual(w.start);
          if (i > 0) {
            expect(w.start).toBeGreaterThanOrEqual(out[i - 1].start);
            expect(out[i - 1].end).toBeLessThanOrEqual(w.start);
          }
        });
      }),
      { numRuns: 400 },
    );
  });

  it("only ever moves a start later and an end earlier (the sweep takes nothing from the sound, it only keeps the order)", () => {
    const finite = fc.array(
      fc.record({
        start: fc.double({ min: 0, max: 500, noNaN: true }),
        end: fc.double({ min: 0, max: 500, noNaN: true }),
      }),
      { maxLength: 40 },
    );
    fc.assert(
      fc.property(finite, (words) => {
        const out = settleWords(words);
        out.forEach((w, i) => {
          expect(w.start).toBeGreaterThanOrEqual(words[i].start);
          expect(w.end).toBeLessThanOrEqual(Math.max(words[i].end, w.start));
        });
      }),
      { numRuns: 300 },
    );
  });

  it("is its own fixed point, and leaves alone any words that were already settled", () => {
    fc.assert(
      fc.property(anyWords, (words) => {
        const once = settleWords(words);
        expect(settleWords(once)).toEqual(once);
      }),
      { numRuns: 300 },
    );
    const inOrder = fc
      .array(
        fc.tuple(
          fc.double({ min: 0, max: 10, noNaN: true }),
          fc.double({ min: 0, max: 10, noNaN: true }),
        ),
        { maxLength: 30 },
      )
      .map((gaps) => {
        let t = 0;
        return gaps.map(([gap, length]) => {
          const start = t + gap;
          t = start + length;
          return { start, end: t };
        });
      });
    fc.assert(
      fc.property(inOrder, (words) => {
        expect(settleWords(words)).toEqual(words);
      }),
      { numRuns: 300 },
    );
  });
});

describe("a segment follows its words", () => {
  it("starts where its first word starts when that is later than where it was stored (the first segment 'starts at 0' artefact)", () => {
    expect(segmentFollowsWords({ start: 0, end: 7.5 }, [{ start: 0.94, end: 1.21 }])).toEqual({
      start: 0.94,
      end: 7.5,
    });
  });

  it("never starts earlier than it was stored, whatever its first word does", () => {
    expect(segmentFollowsWords({ start: 3, end: 8 }, [{ start: 2.5, end: 4 }])).toEqual({
      start: 3,
      end: 8,
    });
  });

  it("ends where its last word ends when that is later than where it was stored, and never earlier", () => {
    expect(
      segmentFollowsWords({ start: 0, end: 2 }, [
        { start: 0, end: 1 },
        { start: 1, end: 3 },
      ]),
    ).toEqual({
      start: 0,
      end: 3,
    });
    expect(segmentFollowsWords({ start: 0, end: 9 }, [{ start: 0, end: 1 }])).toEqual({
      start: 0,
      end: 9,
    });
  });

  it("is what it was for a segment with no words (all of it an annotation)", () => {
    expect(segmentFollowsWords({ start: 1, end: 2 }, [])).toEqual({ start: 1, end: 2 });
  });

  it("is never earlier at either edge than the stored segment, for any words", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.array(
          fc.record({
            start: fc.double({ min: 0, max: 200, noNaN: true }),
            end: fc.double({ min: 0, max: 200, noNaN: true }),
          }),
          {
            maxLength: 20,
          },
        ),
        (a, b, words) => {
          const stored = { start: Math.min(a, b), end: Math.max(a, b) };
          const out = segmentFollowsWords(stored, settleWords(words));
          expect(out.start).toBeGreaterThanOrEqual(stored.start);
          expect(out.end).toBeGreaterThanOrEqual(stored.end);
        },
      ),
      { numRuns: 300 },
    );
  });
});
