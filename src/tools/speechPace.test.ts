import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";

import {
  estimateTranscribeSeconds,
  readPace,
  recordSpeechRun,
  secondsPerAudioSecond,
  SPEECH_PACE_KEY,
  STARTUP_S,
  type PaceSample,
} from "./speechPace";

/** A storage that keeps what it is given, under any key. */
function memory() {
  const kept = new Map<string, string>();
  return {
    kept,
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => void kept.set(k, v),
  };
}

describe("what a machine remembers of its own transcriptions", () => {
  it("keeps the runs it is told of, oldest first, and no more than the last eight", () => {
    const store = memory();
    for (let i = 1; i <= 12; i++) recordSpeechRun(10 + i, 5 + i, store);
    const kept = readPace(store);
    expect(kept).toHaveLength(8);
    expect(kept[0]).toEqual([15, 10]);
    expect(kept[7]).toEqual([22, 17]);
  });

  it("does not keep a run that says nothing about speed", () => {
    const store = memory();
    const nothing: Array<[number | null, number | null]> = [
      [null, 5],
      [30, null],
      [9.9, 5], // mostly start-up
      [30, 0],
      [30, -4],
      [NaN, 5],
      [30, Infinity],
      [-30, 5],
    ];
    for (const [a, w] of nothing) recordSpeechRun(a, w, store);
    expect(readPace(store)).toEqual([]);
    expect(store.kept.size).toBe(0);
  });

  it("reads whatever is in storage as history or as none, and never throws", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.json().map((j) => JSON.stringify(j)),
        ),
        (raw) => {
          const store = memory();
          store.kept.set(SPEECH_PACE_KEY, raw);
          for (const [audio, wall] of readPace(store)) {
            expect(Number.isFinite(audio) && Number.isFinite(wall)).toBe(true);
            expect(audio).toBeGreaterThanOrEqual(10);
            expect(wall).toBeGreaterThan(0);
          }
        },
      ),
    );
  });

  it("is no history, and no error, where the storage throws or is missing", () => {
    const hostile = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(readPace(hostile)).toEqual([]);
    expect(() => recordSpeechRun(30, 6, hostile)).not.toThrow();
    expect(readPace(null)).toEqual([]);
    expect(() => recordSpeechRun(30, 6, null)).not.toThrow();
  });

  it("keeps and reads the app's own storage by default", () => {
    localStorage.clear();
    recordSpeechRun(30, 6);
    expect(readPace()).toEqual([[30, 6]]);
    localStorage.clear();
  });
});

describe("the estimate", () => {
  it("starts from a typical figure for the kind of machine, a Mac's GPU being the faster", () => {
    expect(secondsPerAudioSecond([], "macos")).toBe(0.1);
    for (const os of ["windows", "linux", "unknown"] as const)
      expect(secondsPerAudioSecond([], os)).toBe(0.35);
  });

  it("is told its own speed back: a machine that always takes W for A is estimated at W for A", () => {
    // Where the run took more than the start-up and the slowest rate the model will believe; a run
    // faster than that says less about the machine than about the start-up it assumed.
    fc.assert(
      fc.property(
        fc.integer({ min: 10, max: 7200 }),
        fc.integer({ min: 0, max: 7200 }),
        (audio, extra) => {
          const wall = STARTUP_S + Math.ceil(audio * 0.01) + extra;
          const store = memory();
          for (let i = 0; i < 3; i++) recordSpeechRun(audio, wall, store);
          const est = estimateTranscribeSeconds(audio, readPace(store), "windows");
          expect(Math.abs(est - wall)).toBeLessThanOrEqual(1);
        },
      ),
    );
  });

  it("is not moved by one run that something slowed down", () => {
    const steady: PaceSample[] = Array.from({ length: 7 }, () => [100, 23]); // 0.2 s per second
    const withOutlier: PaceSample[] = [...steady, [100, 1003]]; // one run 50 times slower
    expect(secondsPerAudioSecond(withOutlier, "windows")).toBeCloseTo(
      secondsPerAudioSecond(steady, "windows"),
      6,
    );
  });

  it("is a whole number of seconds that is never under the start-up and never shrinks with more speech", () => {
    const sample = fc.tuple(fc.integer({ min: 10, max: 7200 }), fc.integer({ min: 1, max: 7200 }));
    fc.assert(
      fc.property(
        fc.array(sample, { maxLength: 8 }),
        fc.constantFrom("windows", "macos", "linux", "unknown"),
        fc.double({ min: 0, max: 100_000, noNaN: true }),
        fc.double({ min: 0, max: 100_000, noNaN: true }),
        (samples, os, a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          const low = estimateTranscribeSeconds(lo, samples, os);
          const high = estimateTranscribeSeconds(hi, samples, os);
          expect(Number.isInteger(low)).toBe(true);
          expect(low).toBeGreaterThanOrEqual(STARTUP_S);
          expect(high).toBeGreaterThanOrEqual(low);
        },
      ),
    );
  });

  it("does not turn an unknown or impossible length into NaN", () => {
    for (const audio of [NaN, Infinity, -Infinity, -5])
      expect(estimateTranscribeSeconds(audio, [], "windows"), String(audio)).toBe(STARTUP_S);
  });

  beforeEach(() => localStorage.clear());
});
