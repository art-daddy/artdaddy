import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";

import {
  backendNow,
  DEFAULT_PACE,
  estimateTranscribeSeconds,
  MIN_SPAN_S,
  paceModel,
  projectedS,
  readPace,
  recordSpeechRun,
  secondsPerAudioSecond,
  spanLimitS,
  SPEECH_BACKENDS,
  SPEECH_PACE_KEY,
  type PaceSample,
  type SpeechBackend,
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

const backend = fc.constantFrom<SpeechBackend>(...SPEECH_BACKENDS);
const sample = fc.tuple(
  fc.integer({ min: 10, max: 7200 }),
  fc.integer({ min: 1, max: 7200 }),
  backend,
);

describe("what a machine remembers of its own transcriptions", () => {
  it("keeps the runs it is told of, oldest first, the last eight of EACH backend", () => {
    const store = memory();
    for (let i = 1; i <= 12; i++) recordSpeechRun(10 + i, 5 + i, "gpu", store);
    for (let i = 1; i <= 3; i++) recordSpeechRun(40 + i, 100 + i, "cpu", store);
    const kept = readPace(store);
    const gpu = kept.filter((s) => s[2] === "gpu");
    expect(gpu).toHaveLength(8);
    expect(gpu[0]).toEqual([15, 10, "gpu"]);
    expect(gpu[7]).toEqual([22, 17, "gpu"]);
    expect(
      kept.filter((s) => s[2] === "cpu"),
      "a burst of one backend evicts none of the other",
    ).toEqual([
      [41, 101, "cpu"],
      [42, 102, "cpu"],
      [43, 103, "cpu"],
    ]);
  });

  it("does not keep a run that says nothing about speed, or about where it ran", () => {
    const store = memory();
    const nothing: Array<[number | null, number | null, SpeechBackend | null]> = [
      [null, 5, "gpu"],
      [30, null, "gpu"],
      [9.9, 5, "gpu"], // mostly start-up
      [30, 0, "gpu"],
      [30, -4, "gpu"],
      [NaN, 5, "gpu"],
      [30, Infinity, "gpu"],
      [-30, 5, "gpu"],
      [30, 5, null], // the engine did not say what it ran on: it belongs to neither model
    ];
    for (const [a, w, b] of nothing) recordSpeechRun(a, w, b, store);
    expect(readPace(store)).toEqual([]);
    expect(store.kept.size).toBe(0);
  });

  it("keeps a measured start-up when one is given, and drops one that cannot be true", () => {
    const store = memory();
    recordSpeechRun(120, 145, "gpu", store, 65);
    recordSpeechRun(120, 145, "gpu", store, 145); // as long as the whole run: no audio moved at all
    recordSpeechRun(120, 145, "gpu", store, -3);
    recordSpeechRun(120, 145, "gpu", store, NaN);
    expect(readPace(store)).toEqual([
      [120, 145, "gpu", 65],
      [120, 145, "gpu"],
      [120, 145, "gpu"],
      [120, 145, "gpu"],
    ]);
  });

  it("never reads what 0.27.0 kept: its samples have no backend", () => {
    localStorage.setItem("artdaddy.speech_pace", JSON.stringify([[30, 6]]));
    expect(readPace()).toEqual([]);
    const store = memory();
    store.kept.set(
      SPEECH_PACE_KEY,
      JSON.stringify([
        [30, 6],
        [30, 6, "tpu"],
        [30, 6, null],
      ]),
    );
    expect(readPace(store), "a sample under the new key that names no backend of ours").toEqual([]);
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
          for (const [audio, wall, where, startup] of readPace(store)) {
            expect(Number.isFinite(audio) && Number.isFinite(wall)).toBe(true);
            expect(audio).toBeGreaterThanOrEqual(10);
            expect(wall).toBeGreaterThan(0);
            expect(SPEECH_BACKENDS).toContain(where);
            if (startup !== undefined) expect(startup > 0 && startup < wall).toBe(true);
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
    expect(() => recordSpeechRun(30, 6, "gpu", hostile)).not.toThrow();
    expect(readPace(null)).toEqual([]);
    expect(() => recordSpeechRun(30, 6, "gpu", null)).not.toThrow();
  });

  it("keeps and reads the app's own storage by default", () => {
    localStorage.clear();
    recordSpeechRun(30, 6, "cpu");
    expect(readPace()).toEqual([[30, 6, "cpu"]]);
    localStorage.clear();
  });
});

describe("the model of how long a transcription takes here", () => {
  const os = "windows";

  it("starts from a figure for each backend that errs toward the SHORTER limit: a processor is slower than a chip, and a Mac's own chip the fastest", () => {
    const limit = (b: SpeechBackend, where: "windows" | "macos") =>
      spanLimitS(paceModel([], b, where), 600);
    expect(limit("cpu", os)).toBeLessThan(limit("gpu", os));
    expect(limit("gpu", "macos")).toBeGreaterThan(limit("gpu", os));
    // The owner's own example of a typical processor-only PC (0.27 times real time): ten minutes
    // for about three minutes of audio, not for ten.
    expect(limit("cpu", os)).toBeGreaterThanOrEqual(120);
    expect(limit("cpu", os)).toBeLessThanOrEqual(200);
    // Even the weakest tenth of chip PCs (2 times real time) is given no more than it does.
    expect(limit("gpu", os)).toBeLessThanOrEqual(600 * 2);
  });

  it("is told its own speed back: a machine that always takes W for A is estimated at W for A", () => {
    // Where the run took more than the start-up and the slowest rate the model will believe; a run
    // faster than that says less about the machine than about the start-up it assumed.
    fc.assert(
      fc.property(
        backend,
        fc.integer({ min: 10, max: 7200 }),
        fc.integer({ min: 0, max: 7200 }),
        (where, audio, extra) => {
          const wall = DEFAULT_PACE[where].startupS + Math.ceil(audio * 0.01) + extra;
          const store = memory();
          for (let i = 0; i < 3; i++) recordSpeechRun(audio, wall, where, store);
          const est = estimateTranscribeSeconds(audio, readPace(store), os, where);
          expect(Math.abs(est - wall)).toBeLessThanOrEqual(1);
        },
      ),
    );
  });

  it("is told a measured start-up back: the time before any audio has moved IS that start-up", () => {
    fc.assert(
      fc.property(
        backend,
        fc.integer({ min: 2, max: 300 }),
        fc.integer({ min: 10, max: 3600 }),
        (where, startup, audio) => {
          const samples: PaceSample[] = [[audio, startup + audio * 0.5, where, startup]];
          const model = paceModel(samples, where, os);
          expect(projectedS(model, 0)).toBe(startup);
          expect(model.rate).toBeCloseTo(0.5, 6);
        },
      ),
    );
  });

  it("is not moved by one run that something slowed down", () => {
    const steady: PaceSample[] = Array.from({ length: 7 }, () => [100, 23, "cpu"]);
    const withOutlier: PaceSample[] = [...steady, [100, 1003, "cpu"]]; // one run 50 times slower
    expect(secondsPerAudioSecond(withOutlier, os, "cpu")).toBeCloseTo(
      secondsPerAudioSecond(steady, os, "cpu"),
      6,
    );
  });

  it("keeps the two backends apart: the runs of one never shape the other", () => {
    fc.assert(
      fc.property(fc.array(sample, { maxLength: 16 }), backend, (history, where) => {
        const samples: PaceSample[] = history.map(([a, w, b]) => [a, w, b]);
        const mine = samples.filter((s) => s[2] === where);
        expect(paceModel(samples, where, os)).toEqual(paceModel(mine, where, os));
      }),
    );
  });

  it("is a whole number of seconds that is never under the start-up and never shrinks with more speech", () => {
    fc.assert(
      fc.property(
        fc.array(sample, { maxLength: 16 }),
        backend,
        fc.constantFrom("windows", "macos", "linux", "unknown"),
        fc.double({ min: 0, max: 100_000, noNaN: true }),
        fc.double({ min: 0, max: 100_000, noNaN: true }),
        (history, where, host, a, b) => {
          const samples: PaceSample[] = history.map(([x, y, z]) => [x, y, z]);
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          const low = estimateTranscribeSeconds(lo, samples, host, where);
          const high = estimateTranscribeSeconds(hi, samples, host, where);
          expect(Number.isInteger(low)).toBe(true);
          expect(low).toBeGreaterThanOrEqual(Math.round(paceModel(samples, where, host).startupS));
          expect(high).toBeGreaterThanOrEqual(low);
        },
      ),
    );
  });

  it("does not turn an unknown or impossible length into NaN", () => {
    for (const where of SPEECH_BACKENDS)
      for (const audio of [NaN, Infinity, -Infinity, -5])
        expect(estimateTranscribeSeconds(audio, [], os, where), `${where} ${audio}`).toBe(
          Math.round(DEFAULT_PACE[where].startupS),
        );
  });

  it("never throws, whatever is in the samples it is handed", () => {
    fc.assert(
      fc.property(
        fc.array(fc.anything(), { maxLength: 6 }),
        backend,
        fc.anything(),
        (junk, where, audio) => {
          const model = paceModel(junk as PaceSample[], where, os);
          expect(Number.isFinite(model.rate) && model.rate > 0).toBe(true);
          expect(Number.isFinite(model.startupS) && model.startupS > 0).toBe(true);
          expect(Number.isFinite(projectedS(model, audio as number))).toBe(true);
        },
      ),
    );
  });

  beforeEach(() => localStorage.clear());
});

describe("the longest span that fits a time", () => {
  const models = fc.tuple(fc.array(sample, { maxLength: 16 }), backend).map(([history, where]) =>
    paceModel(
      history.map(([a, w, b]) => [a, w, b] as PaceSample),
      where,
      "windows",
    ),
  );
  const cap = fc.integer({ min: 0, max: 7200 });

  it("is the largest span whose projected time is within the cap: it fits, and one more second would not", () => {
    fc.assert(
      fc.property(models, cap, (model, capS) => {
        const limit = spanLimitS(model, capS);
        expect(limit).toBeGreaterThanOrEqual(0);
        if (limit === 0) {
          // so slow that even the shortest span worth asking for does not fit: nothing is offered
          expect(projectedS(model, MIN_SPAN_S)).toBeGreaterThan(capS);
          return;
        }
        expect(projectedS(model, limit)).toBeLessThanOrEqual(capS);
        expect(projectedS(model, limit + 1)).toBeGreaterThan(capS);
      }),
      { numRuns: 300 },
    );
  });

  it("never grows for a slower machine or a smaller cap, and never shrinks for a faster one or a bigger cap", () => {
    fc.assert(
      fc.property(
        models,
        cap,
        cap,
        fc.double({ min: 1, max: 20, noNaN: true }),
        (model, a, b, slower) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          expect(spanLimitS(model, lo)).toBeLessThanOrEqual(spanLimitS(model, hi));
          const slow = { ...model, rate: model.rate * slower, startupS: model.startupS * slower };
          expect(spanLimitS(slow, hi)).toBeLessThanOrEqual(spanLimitS(model, hi));
        },
      ),
    );
  });

  it("is a start-up shorter: a minute of start-up takes a minute off what a cap allows", () => {
    const base = { backend: "cpu", rate: 1, runs: 1 } as const;
    expect(spanLimitS({ ...base, startupS: 0.5 }, 600)).toBe(599);
    expect(spanLimitS({ ...base, startupS: 60 }, 600)).toBe(540);
  });

  it("says nothing fits, rather than a number, for a cap the start-up alone uses up", () => {
    const model = paceModel([], "cpu", "windows");
    expect(spanLimitS(model, 0)).toBe(0);
    expect(spanLimitS(model, model.startupS)).toBe(0);
    expect(spanLimitS(model, Number.NaN)).toBe(0);
  });
});

describe("which backend would run", () => {
  it("is the processor while the chip is held, whatever the runs say", () => {
    expect(backendNow([[100, 20, "gpu"]], "windows", true)).toBe("cpu");
    expect(backendNow([], "macos", true)).toBe("cpu");
  });

  it("is what the machine's latest run used, so a PC with no usable chip is judged by its own processor runs", () => {
    expect(
      backendNow(
        [
          [100, 20, "gpu"],
          [100, 400, "cpu"],
        ],
        "windows",
        false,
      ),
    ).toBe("cpu");
    expect(
      backendNow(
        [
          [100, 400, "cpu"],
          [100, 20, "gpu"],
        ],
        "windows",
        false,
      ),
    ).toBe("gpu");
  });

  it("is the chip for a machine with no runs, except on Linux where the engine has none", () => {
    expect(backendNow([], "windows", false)).toBe("gpu");
    expect(backendNow([], "macos", false)).toBe("gpu");
    expect(backendNow([], "linux", false)).toBe("cpu");
  });
});
