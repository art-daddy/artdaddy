import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { estimate, type EstimateRequest } from "./estimator";
import {
  PACE_LOG_KEY,
  PACE_LOG_LIMITS,
  paceCorrection,
  recordPace,
  type PaceInput,
  type PaceKey,
  type StorageLike,
} from "./paceLog";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

interface FakeStore extends StorageLike {
  map: Map<string, string>;
  writes: number;
}
const memoryStore = (initial?: string): FakeStore => {
  const map = new Map<string, string>(initial === undefined ? [] : [[PACE_LOG_KEY, initial]]);
  const store: FakeStore = {
    map,
    writes: 0,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      store.writes++;
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
  return store;
};
const stored = (store: FakeStore): unknown[] => {
  try {
    const value: unknown = JSON.parse(store.map.get(PACE_LOG_KEY) ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

const KEY: PaceKey = { family: "processor", speedRevision: 2, build: "0.28.0" };
const run = (over: Partial<PaceInput> = {}): PaceInput => ({
  family: "processor",
  runSeconds: 600,
  producedFraction: 1,
  predictedTotalSeconds: 600,
  outcome: "done",
  speedRevision: 2,
  build: "0.28.0",
  atMs: NOW,
  ...over,
});
/** A finished run that was `ratio` times as slow as predicted. */
const teach = (store: StorageLike | null, ratio: number, over: Partial<PaceInput> = {}) =>
  recordPace(store, run({ runSeconds: 600, predictedTotalSeconds: 600 / ratio, ...over }));
const learned = (store: StorageLike | null, key: PaceKey = KEY, now = NOW) =>
  paceCorrection(store, key, now);

describe("what a run teaches", () => {
  it("is the ratio of the pace it showed to the pace predicted, as if it had finished", () => {
    const store = memoryStore();
    // Ran 10 minutes, made half of its project, and 1,000 s were predicted for all of it: 1,200 s for all of it is 1.2 times as slow.
    recordPace(
      store,
      run({
        runSeconds: 600,
        producedFraction: 0.5,
        predictedTotalSeconds: 1000,
        outcome: "cancelled",
      }),
    );
    expect(learned(store)).toBeCloseTo(1.2, 12);
    const finished = memoryStore();
    recordPace(finished, run({ runSeconds: 800, predictedTotalSeconds: 400 }));
    expect(learned(finished)).toBe(2);
    expect(learned(memoryStore())).toBeNull();
  });

  it("learns from a failed run as well as a cancelled one", () => {
    const store = memoryStore();
    recordPace(
      store,
      run({
        outcome: "failed",
        runSeconds: 300,
        producedFraction: 0.4,
        predictedTotalSeconds: 300,
      }),
    );
    expect(learned(store)).toBeCloseTo(2.5, 12);
  });

  it("only from a run that ran 90 seconds and made 3 percent of its project, at the very limit and not below it", () => {
    const attempt = (over: Partial<PaceInput>) => {
      const store = memoryStore();
      recordPace(store, run(over));
      return store.writes;
    };
    expect(attempt({ runSeconds: 90, producedFraction: 0.03 })).toBe(1);
    expect(attempt({ runSeconds: 89.99, producedFraction: 1 })).toBe(0);
    expect(attempt({ runSeconds: 600, producedFraction: 0.0299 })).toBe(0);
    expect(attempt({ runSeconds: 600, producedFraction: 1.00005 })).toBe(1);
    expect(attempt({ runSeconds: 600, producedFraction: 1.5 })).toBe(0);
  });

  it("nothing from a hang, a cancel before the first picture, a run a sleep crossed, or numbers that are not numbers", () => {
    // Each case would teach the log a ratio at the top of its range if it counted, and is the same run as `taught` but for one thing.
    const taught = run({
      runSeconds: 600,
      producedFraction: 0.5,
      predictedTotalSeconds: 100,
      outcome: "failed",
    });
    const refused: Array<[string, Partial<PaceInput>]> = [
      ["a run stopped as idle", { outcome: "stopped_idle" }],
      [
        "a cancel before the first picture",
        { outcome: "cancelled", cancelledBeforeFirstPicture: true },
      ],
      ["a run a sleep crossed", { crossedBySleep: true }],
      ["an outcome nobody knows", { outcome: "mystery" as never }],
      ["an encoder family nobody knows", { family: "gpu" as never }],
      ["no run time", { runSeconds: Number.NaN }],
      ["an infinite run time", { runSeconds: Number.POSITIVE_INFINITY }],
      ["no produced fraction", { producedFraction: Number.NaN }],
      ["a negative produced fraction", { producedFraction: -0.5 }],
      ["a prediction of nothing", { predictedTotalSeconds: 0 }],
      ["a negative prediction", { predictedTotalSeconds: -5 }],
      ["an infinite prediction", { predictedTotalSeconds: Number.POSITIVE_INFINITY }],
      ["no time of day", { atMs: Number.NaN }],
      ["a build that is not a name", { build: 4 as never }],
      ["a revision that is not a number", { speedRevision: Number.NaN }],
    ];
    const control = memoryStore();
    recordPace(control, taught);
    expect(control.writes, "the unspoilt run IS taught").toBe(1);
    for (const [label, over] of refused) {
      const store = memoryStore();
      recordPace(store, { ...taught, ...over });
      expect(store.writes, label).toBe(0);
      expect(store.map.size, label).toBe(0);
      expect(learned(store), label).toBeNull();
    }
    for (const nonsense of [null, undefined, 4, "run", []])
      expect(() => recordPace(memoryStore(), nonsense as never)).not.toThrow();
  });

  it("clamps what it learns to a quarter and eight times, and stores the clamped figure", () => {
    const slow = memoryStore();
    teach(slow, 50);
    expect(learned(slow)).toBe(PACE_LOG_LIMITS.ratio.max);
    expect((stored(slow)[0] as { ratio: number }).ratio).toBe(8);
    const quick = memoryStore();
    teach(quick, 0.01);
    expect(learned(quick)).toBe(0.25);
    for (const edge of [0.25, 8]) {
      const store = memoryStore();
      teach(store, edge);
      expect(learned(store)).toBeCloseTo(edge, 12);
    }
  });

  it("weighs a run by how much of its project it made, up to a quarter of it", () => {
    // Two runs that made 5 percent each say 1.0, one run that made all of it says 3.0: counting them equally gives 1.0, weighing them gives 3.0.
    const weighed = memoryStore();
    for (let index = 0; index < 2; index++)
      recordPace(
        weighed,
        run({
          runSeconds: 100,
          producedFraction: 0.05,
          predictedTotalSeconds: 2000,
          outcome: "cancelled",
        }),
      );
    teach(weighed, 3);
    expect(learned(weighed)).toBe(3);
    const equal = memoryStore();
    for (let index = 0; index < 2; index++) teach(equal, 1);
    teach(equal, 3);
    expect(learned(equal)).toBe(1);
    // Past a quarter of its project a run counts in full, not more.
    expect((stored(weighed)[0] as { weight: number }).weight).toBeCloseTo(0.2, 12);
    const wide = memoryStore();
    recordPace(wide, run({ runSeconds: 600, producedFraction: 0.9, predictedTotalSeconds: 540 }));
    expect((stored(wide)[0] as { weight: number }).weight).toBe(1);
  });
});

describe("what the correction is", () => {
  it("the median of the last eight runs: a minority of freak ones does not move it, and old ones fall out", () => {
    const freak = memoryStore();
    // Sorted: 0.25 1.1 1.1 1.15 1.2 1.2 8 8. Half of eight equal weights falls between the fourth and the fifth: their mean.
    for (const ratio of [1.1, 1.2, 1.1, 8, 1.2, 8, 0.25, 1.15]) teach(freak, ratio);
    expect(learned(freak)).toBeCloseTo(1.175, 12);
    const old = memoryStore();
    for (const ratio of [8, 8, 1, 1, 1, 1, 1, 1, 1, 1]) teach(old, ratio);
    expect(learned(old)).toBe(1);
    const half = memoryStore();
    for (const ratio of [1, 1, 1, 1, 8, 8, 8, 8]) teach(half, ratio);
    expect(learned(half)).toBe(4.5);
  });

  it("eight honest runs replace whatever came before them, however poisoned", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0.01, max: 100, noNaN: true }), { maxLength: 20 }),
        fc.double({ min: 0.3, max: 7.9, noNaN: true }),
        (before, honest) => {
          const store = memoryStore();
          for (const ratio of before) teach(store, ratio);
          for (let index = 0; index < PACE_LOG_LIMITS.window; index++) teach(store, honest);
          expect(learned(store)).toBeCloseTo(honest, 9);
        },
      ),
    );
  });

  it("does not depend on the order the last eight came in, and stays between their smallest and largest", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0.25, max: 8, noNaN: true }), { minLength: 1, maxLength: 8 }),
        fc.nat(),
        (ratios, shift) => {
          const a = memoryStore();
          for (const ratio of ratios) teach(a, ratio);
          const b = memoryStore();
          const turned = [
            ...ratios.slice(shift % ratios.length),
            ...ratios.slice(0, shift % ratios.length),
          ].reverse();
          for (const ratio of turned) teach(b, ratio);
          const left = learned(a)!;
          expect(left).toBeCloseTo(learned(b)!, 9);
          expect(left).toBeGreaterThanOrEqual(Math.min(...ratios) - 1e-9);
          expect(left).toBeLessThanOrEqual(Math.max(...ratios) + 1e-9);
        },
      ),
    );
  });

  it("never corrects the other encoder family: a chip's ratio is not the processor's", () => {
    const store = memoryStore();
    for (let index = 0; index < 3; index++) teach(store, 2, { family: "processor" });
    for (let index = 0; index < 3; index++) teach(store, 0.5, { family: "chip" });
    expect(learned(store, { ...KEY, family: "processor" })).toBe(2);
    expect(learned(store, { ...KEY, family: "chip" })).toBe(0.5);
    const onlyChip = memoryStore();
    teach(onlyChip, 3, { family: "chip" });
    expect(learned(onlyChip, { ...KEY, family: "processor" })).toBeNull();
  });

  /** A run stopped early: `made` of its project in 95 s, against a prediction of 600 s for all of it. */
  const stoppedEarly = (store: StorageLike, made: number, over: Partial<PaceInput> = {}) =>
    recordPace(
      store,
      run({
        outcome: "cancelled",
        runSeconds: 95,
        producedFraction: made,
        predictedTotalSeconds: 600,
        ...over,
      }),
    );

  it("gives nothing from a lone run that was stopped early: it is mostly start-up, and a median of one is that one", () => {
    for (const made of [0.03, 0.05, 0.06, 0.11]) {
      const store = memoryStore();
      stoppedEarly(store, made);
      expect(stored(store), String(made)).toHaveLength(1); // it is kept ...
      expect(learned(store), String(made)).toBeNull(); // ... and does not correct the estimate on its own
    }
    // a lone run that was finished, or that made an eighth of its project, is enough
    const finished = memoryStore();
    teach(finished, 2.5);
    expect(learned(finished)).toBe(2.5);
    const eighth = memoryStore();
    stoppedEarly(eighth, 0.125);
    expect(learned(eighth)).toBeCloseTo(95 / 0.125 / 600, 12);
    const almost = memoryStore();
    stoppedEarly(almost, 0.12);
    expect(learned(almost)).toBeNull();
  });

  it("gives a correction once the lessons together weigh half a finished run, and not before", () => {
    // 6 percent of a project weighs 0.24, 3 percent weighs 0.12
    const two = memoryStore();
    stoppedEarly(two, 0.06);
    stoppedEarly(two, 0.06);
    expect(learned(two)).toBeNull();
    const three = memoryStore();
    for (let index = 0; index < 3; index++) stoppedEarly(three, 0.06);
    expect(learned(three)).toBeCloseTo(95 / 0.06 / 600, 12);
    const mixed = memoryStore();
    stoppedEarly(mixed, 0.06);
    stoppedEarly(mixed, 0.06);
    stoppedEarly(mixed, 0.03);
    expect(learned(mixed)).not.toBeNull();
    // lessons older than 30 days weigh nothing: three old small ones do not add up with a newer one
    const crowded = memoryStore();
    stoppedEarly(crowded, 0.06, { atMs: NOW - 31 * DAY });
    stoppedEarly(crowded, 0.06, { atMs: NOW - 31 * DAY });
    stoppedEarly(crowded, 0.06, { atMs: NOW - 31 * DAY });
    stoppedEarly(crowded, 0.06);
    expect(learned(crowded)).toBeNull();
  });

  it("is silent until the window weighs half a finished run, and then speaks inside its bounds (property)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            made: fc.double({ min: 0.03, max: 1, noNaN: true }),
            ratio: fc.double({ min: 0.25, max: 8, noNaN: true }),
          }),
          { minLength: 0, maxLength: 12 },
        ),
        (lessons) => {
          const store = memoryStore();
          for (const { made, ratio } of lessons)
            recordPace(
              store,
              run({
                outcome: "cancelled",
                runSeconds: 600,
                producedFraction: made,
                predictedTotalSeconds: 600 / made / ratio,
              }),
            );
          const weight = lessons
            .slice(-PACE_LOG_LIMITS.window)
            .reduce((sum, { made }) => sum + Math.min(1, made / PACE_LOG_LIMITS.fullWeightAt), 0);
          const result = learned(store);
          // the clamp can move a ratio to a bound but never past it
          if (weight < PACE_LOG_LIMITS.minTotalWeight - 1e-6) expect(result).toBeNull();
          else if (weight > PACE_LOG_LIMITS.minTotalWeight + 1e-6) {
            expect(result).not.toBeNull();
            expect(result!).toBeGreaterThanOrEqual(0.25);
            expect(result!).toBeLessThanOrEqual(8);
          }
        },
      ),
    );
  });

  it("is for one speed revision and one build, and a newer export does not lend to an older key", () => {
    const store = memoryStore();
    teach(store, 2, { speedRevision: 1 });
    teach(store, 3, { build: "0.27.0" });
    expect(learned(store)).toBeNull();
    teach(store, 1.5);
    expect(learned(store)).toBe(1.5);
    expect(learned(store, { ...KEY, speedRevision: 1 })).toBe(2);
  });

  it("forgets a lesson after 30 days, and does not trust one dated from the future", () => {
    const store = memoryStore();
    teach(store, 2, { atMs: NOW - 31 * DAY });
    expect(learned(store)).toBeNull();
    const young = memoryStore();
    teach(young, 2, { atMs: NOW - 30 * DAY });
    expect(learned(young)).toBe(2);
    const ahead = memoryStore();
    teach(ahead, 2, { atMs: NOW + 2 * DAY });
    expect(learned(ahead)).toBeNull();
    const soon = memoryStore();
    teach(soon, 2, { atMs: NOW + 60 * 60 * 1000 });
    expect(learned(soon)).toBe(2);
  });

  it("keeps at most 32 lessons, dropping the oldest", () => {
    const store = memoryStore();
    for (let index = 0; index < 40; index++) teach(store, 2, { atMs: NOW + index });
    const kept = stored(store) as Array<{ atMs: number }>;
    expect(kept).toHaveLength(PACE_LOG_LIMITS.entries);
    expect(kept[0].atMs).toBe(NOW + 8);
    expect(kept[31].atMs).toBe(NOW + 39);
  });
});

describe("a store that is damaged, missing or refuses to write", () => {
  it("reads as empty, and the next lesson replaces it", () => {
    const good = JSON.stringify([
      { family: "processor", speedRevision: 2, build: "0.28.0", atMs: NOW, ratio: 1.4, weight: 1 },
    ]);
    const cases: Array<[string, string, number | null]> = [
      ["not json", "{{{", null],
      ["an older format", JSON.stringify({ version: 0, ratios: [1, 2] }), null],
      ["null", "null", null],
      ["a list of numbers", "[1,2,3]", null],
      [
        "entries with missing fields",
        JSON.stringify([{ family: "processor" }, { ratio: 2 }]),
        null,
      ],
      [
        "an entry with a ratio outside the bounds",
        JSON.stringify([
          {
            family: "processor",
            speedRevision: 2,
            build: "0.28.0",
            atMs: NOW,
            ratio: 1000,
            weight: 1,
          },
        ]),
        null,
      ],
      [
        "an entry with no weight",
        JSON.stringify([
          {
            family: "processor",
            speedRevision: 2,
            build: "0.28.0",
            atMs: NOW,
            ratio: 2,
            weight: 0,
          },
        ]),
        null,
      ],
      ["a good entry among junk", `[1,"x",${good.slice(1, -1)},null]`, 1.4],
    ];
    for (const [label, raw, expected] of cases) {
      const store = memoryStore(raw);
      expect(learned(store), label).toBe(expected);
      teach(store, 2);
      const entries = stored(store);
      expect(Array.isArray(entries), label).toBe(true);
      expect(learned(store), label).not.toBeNull();
      expect(learned(store), label).toBeGreaterThanOrEqual(0.25);
    }
  });

  it("is not a failure when it cannot be read or written, or when there is none", () => {
    const refusing: StorageLike = {
      getItem: () => {
        throw new Error("storage is gone");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("storage is gone");
      },
    };
    expect(() => teach(refusing, 2)).not.toThrow();
    expect(learned(refusing)).toBeNull();
    const readOnly: StorageLike = { ...memoryStore(), setItem: refusing.setItem };
    expect(() => teach(readOnly, 2)).not.toThrow();
    expect(learned(readOnly)).toBeNull();
    expect(() => teach(null, 2)).not.toThrow();
    expect(learned(null)).toBeNull();
    const odd: StorageLike = {
      getItem: () => 7 as never,
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(learned(odd)).toBeNull();
    expect(paceCorrection(memoryStore(), KEY, Number.NaN)).toBeNull();
    expect(paceCorrection(memoryStore(), null as never, NOW)).toBeNull();
  });

  it("whatever is thrown at it, it answers with nothing or a ratio inside its bounds", () => {
    const loose = fc.oneof(
      fc.anything(),
      fc.double(),
      fc.constantFrom(Number.NaN, Infinity, -Infinity, 0, -1),
    );
    fc.assert(
      fc.property(
        fc.array(
          fc.record(
            {
              family: loose,
              runSeconds: loose,
              producedFraction: loose,
              predictedTotalSeconds: loose,
              outcome: fc.oneof(
                loose,
                fc.constantFrom("done", "failed", "cancelled", "stopped_idle"),
              ),
              cancelledBeforeFirstPicture: loose,
              crossedBySleep: loose,
              speedRevision: loose,
              build: loose,
              atMs: loose,
            },
            { requiredKeys: [] },
          ),
          { maxLength: 50 },
        ),
        fc.oneof(fc.string(), fc.constant(undefined)),
        (inputs, garbage) => {
          const store = memoryStore(garbage);
          for (const input of inputs) recordPace(store, input as never);
          const result = learned(store);
          if (result !== null) {
            expect(Number.isFinite(result)).toBe(true);
            expect(result).toBeGreaterThanOrEqual(0.25);
            expect(result).toBeLessThanOrEqual(8);
          }
          expect(stored(store).length).toBeLessThanOrEqual(PACE_LOG_LIMITS.entries);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("a poisoned log and the estimate it corrects", () => {
  const request = (correction: number | null): EstimateRequest => ({
    workload: {
      width: 1920,
      height: 1080,
      fps: 30,
      durationSeconds: 600,
      visualClips: 3,
      captionClips: 0,
      audioClips: 1,
      peakVisualLayers: 1,
      peakMediaLayers: 1,
    },
    shape: null,
    output: { width: 1920, height: 1080, fps: 30, quality: "medium" },
    route: { family: "processor", faster: false, chipMaker: null, quick: false },
    pace: { rHat: 0.5, aFps: 80, bFps: 32, cFps: 60, cores: 8, cls: "ok" },
    correction,
    history: [],
    flags: { estimate_v2: true, pc_check: true },
  });
  const corrected = (store: StorageLike) => estimate(request(learned(store)))!;
  const clean = estimate(request(null))!;

  /** Eight attempts to teach the log something false, every one of which the rules refuse: the log is not touched, and neither is the estimate. */
  const REFUSED: Array<Partial<PaceInput>> = [
    {
      outcome: "stopped_idle",
      runSeconds: 7200,
      producedFraction: 0.5,
      predictedTotalSeconds: 100,
    },
    {
      outcome: "cancelled",
      cancelledBeforeFirstPicture: true,
      runSeconds: 400,
      producedFraction: 0.2,
      predictedTotalSeconds: 10,
    },
    { crossedBySleep: true, runSeconds: 40_000, producedFraction: 1, predictedTotalSeconds: 600 },
    { runSeconds: 30, producedFraction: 1, predictedTotalSeconds: 1 },
    { runSeconds: 600, producedFraction: 0.01, predictedTotalSeconds: 600 },
    { runSeconds: Number.NaN },
    { predictedTotalSeconds: -1 },
    {
      outcome: "stopped_idle",
      runSeconds: 100_000,
      producedFraction: 0.9,
      predictedTotalSeconds: 5,
    },
  ];

  it("eight poisoned attempts that the rules refuse leave the log, and so the estimate, exactly as they were", () => {
    const store = memoryStore();
    for (const poison of REFUSED) recordPace(store, run(poison));
    expect(store.writes).toBe(0);
    expect(learned(store)).toBeNull();
    expect(corrected(store)).toEqual(clean);
  });

  it("a lone run stopped early, 95 s in with 3 to 6 percent made, leaves the next estimate exactly as the model's own: it was mostly start-up", () => {
    // the same run, if it had been taken at its word, gives a ratio near 2.6 and moves the central figure to the top of the range
    const moved = memoryStore();
    teach(moved, 2.6);
    expect(corrected(moved).seconds).toBeGreaterThan(clean.seconds);
    for (const made of [0.03, 0.045, 0.06, 0.11]) {
      const store = memoryStore();
      recordPace(
        store,
        run({
          outcome: "cancelled",
          runSeconds: 95,
          producedFraction: made,
          predictedTotalSeconds: 600,
        }),
      );
      expect(store.writes, String(made)).toBe(1);
      expect(corrected(store), String(made)).toEqual(clean);
    }
  });

  it("eight that get through at the clamp's edges can only move the estimate inside the range it reports, and never move the range", () => {
    const layouts: number[][] = [
      [8, 8, 8, 8, 8, 8, 8, 8],
      [0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25],
      [8, 0.25, 8, 0.25, 8, 0.25, 8, 0.25],
      [50, 0.01, 1e9, 1e-9, 8, 0.25, 1000, 0.001],
    ];
    for (const ratios of layouts) {
      const store = memoryStore();
      for (const ratio of ratios) teach(store, ratio);
      const result = corrected(store);
      expect(result.low, ratios.join(" ")).toBe(clean.low);
      expect(result.high, ratios.join(" ")).toBe(clean.high);
      expect(result.seconds, ratios.join(" ")).toBeGreaterThanOrEqual(clean.low);
      expect(result.seconds, ratios.join(" ")).toBeLessThanOrEqual(clean.high);
      // A log can change a number, never the question: the same basis, the same encoder family, the same words.
      expect(result.basis).toBe(clean.basis);
      expect(result.family).toBe(clean.family);
    }
  });

  it("a few freak runs among honest ones do not move the estimate off what the honest ones say", () => {
    const honestOnly = memoryStore();
    for (const ratio of [1.2, 1.25, 1.3, 1.2, 1.25]) teach(honestOnly, ratio);
    const poisoned = memoryStore();
    for (const ratio of [1.2, 1.25, 8, 1.3, 0.25, 1.2, 8, 1.25]) teach(poisoned, ratio);
    expect(corrected(poisoned).seconds).toBe(corrected(honestOnly).seconds);
    expect(corrected(poisoned).seconds).toBeGreaterThan(clean.seconds);
    expect(corrected(poisoned).seconds).toBeLessThanOrEqual(clean.high);
  });

  it("a PC that is really 2.5 times slower than its check says: after one cancelled and one failed run the next estimate is within 2 times of the truth", () => {
    const store = memoryStore();
    // Both runs were predicted at `clean.seconds` for the whole export and showed a pace 2.5 times as slow.
    recordPace(
      store,
      run({
        outcome: "cancelled",
        runSeconds: 0.4 * 2.5 * clean.seconds,
        producedFraction: 0.4,
        predictedTotalSeconds: clean.seconds,
      }),
    );
    recordPace(
      store,
      run({
        outcome: "failed",
        runSeconds: 0.7 * 2.5 * clean.seconds,
        producedFraction: 0.7,
        predictedTotalSeconds: clean.seconds,
      }),
    );
    expect(learned(store)).toBeCloseTo(2.5, 9);
    const next = corrected(store);
    const truth = 2.5 * clean.seconds;
    expect(next.seconds).toBeGreaterThan(clean.seconds);
    expect(truth / next.seconds).toBeLessThan(2);
    expect(next.seconds / truth).toBeLessThan(2);
  });
});
