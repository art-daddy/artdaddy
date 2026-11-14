import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { EXPORT_REASON_CODES, type ExportReasonCode } from "../api/exportReason";
import { EXPORT_LIMITS, type ExportLimit } from "../api/exportVocabulary";
import { GIB, ceilingBytes, planRung, type Rung } from "./exportPlan";
import {
  AUTO_RESTART_REASONS,
  FIRST_QUARTER,
  MAX_FIRST_REPORT_WAIT_S,
  MAX_LONGEST_GAP_S,
  MAX_ROUTE_SECONDS,
  OVERRIDE_KEYS,
  OWN_CEILING_GUARDS,
  PC_SHORT_GUARDS,
  REFUSAL_ORDER,
  RESTARTED_AS,
  RESTART_RECORDS,
  ROOM_SHARE,
  ROUTE_TABLE,
  anchorBytes,
  decideRestart,
  eligibleReasons,
  producedFraction,
  recordOf,
  restartRow,
  routeRowProblems,
  stopFactsOf,
  wasCancelAsked,
  type AutoRestartReason,
  type DecideOptions,
  type RestartDecision,
  type RestartEngine,
  type RestartFacts,
  type RestartFlags,
  type RestartRefusal,
  type RestartWorkload,
  type RouteRow,
} from "./exportRestart";
import {
  createSequenceProgressReader,
  progressFraction,
  type RenderProgress,
} from "./ffmpegProgress";
import type { RenderWorkload } from "./renderPlan";
import {
  BUSY_RUN_CEILING_SECONDS,
  BUSY_START_CEILING_SECONDS,
  SLOW_START_SECONDS,
  STALL_STOP_SECONDS,
} from "./exportTrace";

const MIB = 1024 ** 2;
const STREAMED = "partition-pipes-v1" as const;

// The order the refusals are given in, written out here on purpose: the module's own list is not the oracle.
const ORDER: readonly RestartRefusal[] = [
  "not_memory",
  "flag_off",
  "cancelled",
  "second",
  "no_closure",
  "edited",
  "late",
  "no_route",
  "pc_short",
];

const HEAVY: RestartWorkload = {
  width: 1080,
  height: 1920,
  fps: 30,
  durationSeconds: 120,
  visualClips: 40,
  captionClips: 3,
  audioClips: 5,
  peakVisualLayers: 3,
  peakMediaLayers: 6,
  sourceInputs: 28,
  effects: [],
};
const LIGHT: RestartWorkload = { ...HEAVY, visualClips: 2, sourceInputs: 2 };

interface Over {
  failure?: Partial<RestartFacts["failure"]>;
  attempt?: Partial<RestartFacts["attempt"]>;
  progress?: Partial<RestartFacts["progress"]>;
  machine?: Partial<RestartFacts["machine"]>;
  request?: Partial<Omit<RestartFacts["request"], "flags">>;
  flags?: Partial<RestartFlags>;
  workload?: RestartWorkload | null;
}

/** A PC-short stop at the start of a one-pass export, with room to start again one rung gentler. */
function facts(over: Over = {}): RestartFacts {
  return {
    failure: {
      code: "memory_limit",
      guard: "pc_floor",
      stopKind: null,
      stopSeconds: null,
      ...over.failure,
    },
    attempt: {
      number: 1,
      rung: 0,
      ladder: [0, 1, 2],
      engine: "file-sequence-v1",
      encoder: "x264-crf",
      chipMaker: null,
      stickyRoute: null,
      ...over.attempt,
    },
    progress: {
      producedFraction: 0.05,
      elapsedSeconds: 90,
      activeSeconds: 80,
      expectedSeconds: 3600,
      ...over.progress,
    },
    machine: {
      freeBytes: 8 * GIB,
      failedPeakBytes: 1.2 * GIB,
      limitBytes: 3.5 * GIB,
      ...over.machine,
    },
    request: {
      retryClosureExists: true,
      snapshotUnchanged: true,
      aborted: false,
      autoRestartsUsed: 0,
      flags: {
        auto_restart: true,
        memory_restart: true,
        restart_streamed: true,
        plan_rung: true,
        ...over.flags,
      },
      ...over.request,
    },
    workload: over.workload === undefined ? HEAVY : over.workload,
  };
}

const OWN_LIMIT = 4992 * MIB;
/** The export's own ceiling stop: peak just under the limit, 10 GiB free now. */
function ceilingFacts(over: Over = {}): RestartFacts {
  return facts({
    ...over,
    failure: { guard: "resident", ...over.failure },
    machine: {
      freeBytes: 10 * GIB,
      failedPeakBytes: 4980 * MIB,
      limitBytes: OWN_LIMIT,
      ...over.machine,
    },
  });
}

const heavyShape = (workload: RestartWorkload): boolean => workload.sourceInputs >= 20;
function routeRow(row: Partial<RouteRow> & Pick<RouteRow, "id" | "route">): RouteRow {
  return {
    matches: heavyShape,
    peakFactor: 0.5,
    firstReportWaitS: 120,
    longestGapS: 60,
    timeFactor: 1.5,
    evidence: "synthetic row made for this test",
    ...row,
  };
}
// Against the anchor of ceilingFacts (4,992 MiB, the limit): rung 1 is predicted at 3,994 MiB, rung 2 at 2,496 MiB and
// the streamed engine at 1,500 MiB.
const RUNG_1 = routeRow({ id: "rung-1", route: { rung: 1 }, peakFactor: 0.8, timeFactor: 1.3 });
const RUNG_2 = routeRow({ id: "rung-2", route: { rung: 2 }, peakFactor: 0.5, timeFactor: 1.8 });
const STREAMED_ROW = routeRow({
  id: "streamed",
  route: { engine: STREAMED },
  peakFactor: undefined,
  peakMiB: 1500,
  timeFactor: 2.5,
  pictureCleared: true,
});
const TABLE: readonly RouteRow[] = [RUNG_1, RUNG_2, STREAMED_ROW];

const freeFor = (ceilingMiB: number): number => (ceilingMiB / 0.75) * MIB;
const NO_ROUTE: RestartDecision = { restart: false, why: "no_route" };
const PC_SHORT: RestartDecision = { restart: false, why: "pc_short" };

describe("the project length produced", () => {
  it("is the card's own fraction for an export made in one step, and 0 when it is not known", () => {
    expect(producedFraction({ fraction: 0.1, step: null, steps: null })).toBe(0.1);
    expect(producedFraction({ fraction: 0.3, step: 0, steps: 1 })).toBe(0.3);
    expect(producedFraction({ fraction: 0.3, step: 0, steps: 0 })).toBe(0.3);
    for (const unknown of [null, Number.NaN])
      expect(producedFraction({ fraction: unknown, step: null, steps: null })).toBe(0);
  });

  it("is twice the card's bar while the parts are made, because the bar runs over the parts and the final encode", () => {
    expect(producedFraction({ fraction: 0.1, step: 0, steps: 9 })).toBeCloseTo(0.2, 12);
    expect(producedFraction({ fraction: 0.2, step: 3, steps: 9 })).toBeCloseTo(0.4, 12);
    expect(producedFraction({ fraction: 0.5, step: 7, steps: 9 })).toBe(1); // the last part, done
  });

  it("is all of it once the final encode has begun, whatever the bar says", () => {
    for (const fraction of [null, Number.NaN, 0, 0.5, 0.75, 1])
      expect(producedFraction({ fraction, step: 8, steps: 9 })).toBe(1);
  });

  it("is clamped, and a bar that is not a number counts as nothing", () => {
    expect(producedFraction({ fraction: -3, step: null, steps: null })).toBe(0);
    expect(producedFraction({ fraction: 7, step: null, steps: null })).toBe(1);
    expect(producedFraction({ fraction: Number.POSITIVE_INFINITY, step: 0, steps: 4 })).toBe(1);
    expect(producedFraction({ fraction: Number.NEGATIVE_INFINITY, step: 0, steps: 4 })).toBe(0);
    expect(producedFraction({ fraction: Number.NaN, step: 0, steps: 4 })).toBe(0);
  });

  it("does not take a step it cannot read for the last one", () => {
    for (const step of [null, Number.NaN, -1, 1.5])
      expect(producedFraction({ fraction: 0.1, step, steps: 9 })).toBeCloseTo(0.2, 12);
    // and one past the end is read as the end: the later reading is the cautious one
    expect(producedFraction({ fraction: 0.1, step: 12, steps: 9 })).toBe(1);
  });

  // What the card's bar really does, from the code that draws it: the sequence reader reports each part's output
  // after the parts before it, over the parts and the final encode (render.ts hands it `[...parts, whole duration]`).
  // The expectation is the project length made so far, worked out from the part lengths, not from the 2x.
  it("equals the project length made, when the bar is drawn by the real sequence reader", () => {
    const card = (parts: readonly number[], index: number, positionMs: number) => {
      const durations = [...parts, parts.reduce((total, part) => total + part, 0)];
      const totalMs = durations.reduce((total, part) => total + part * 1000, 0);
      const seen: RenderProgress[] = [];
      const feed = createSequenceProgressReader(durations, (report) => seen.push(report));
      feed(`artdaddy_step=${index}\n`);
      feed(`frame=1\nout_time_us=${positionMs * 1000}\nprogress=continue\n`);
      return {
        fraction: progressFraction(seen[0].outMs, totalMs),
        step: seen[0].step ?? null,
        steps: seen[0].steps ?? null,
      };
    };
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 30 }), { minLength: 1, maxLength: 12 }).chain((parts) =>
          fc.record({
            parts: fc.constant(parts),
            index: fc.integer({ min: 0, max: parts.length }),
            position: fc.integer({ min: 0, max: 1000 }).map((thousandth) => thousandth / 1000),
          }),
        ),
        ({ parts, index, position }) => {
          const whole = parts.reduce((total, part) => total + part, 0);
          const inParts = index < parts.length;
          const length = inParts ? parts[index] : whole;
          const inMs = Math.round(position * length * 1000);
          const reading = card(parts, index, inMs);
          if (inParts) {
            const madeBefore = parts.slice(0, index).reduce((total, part) => total + part, 0);
            const made = (madeBefore * 1000 + inMs) / (whole * 1000);
            expect(reading.fraction).toBeCloseTo(made / 2, 9); // the bar reads half the project length
            expect(producedFraction(reading)).toBeCloseTo(made, 9);
          } else {
            expect(reading.fraction).toBeGreaterThanOrEqual(0.5 - 1e-9);
            expect(producedFraction(reading)).toBe(1);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("measures the quarter on the project, not on the card's bar: 20 % of a streamed export's bar is 40 % of the project", () => {
    const decide = (live: Parameters<typeof producedFraction>[0]) =>
      decideRestart(facts({ progress: { producedFraction: producedFraction(live) } }));
    expect(decide({ fraction: 0.2, step: 3, steps: 9 })).toEqual({ restart: false, why: "late" });
    expect(decide({ fraction: 0.125, step: 3, steps: 9 })).toEqual({ restart: false, why: "late" }); // 25 %: not under it
    expect(decide({ fraction: 0.1, step: 1, steps: 9 })).toMatchObject({ restart: true }); // 20 %
    expect(decide({ fraction: 0.2, step: null, steps: null })).toMatchObject({ restart: true }); // one step: the bar is the project
  });

  it("is monotone in the bar within a step, always between 0 and 1, and never throws on what it is given", () => {
    const inputs = fc.record({
      step: fc.oneof(fc.constant(null), fc.integer({ min: -2, max: 12 })),
      steps: fc.oneof(fc.constant(null), fc.integer({ min: -1, max: 12 })),
    });
    const bar = fc.integer({ min: -200, max: 300 }).map((hundredth) => hundredth / 100);
    fc.assert(
      fc.property(inputs, bar, bar, ({ step, steps }, a, b) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        const lower = producedFraction({ fraction: low, step, steps });
        const upper = producedFraction({ fraction: high, step, steps });
        expect(lower).toBeLessThanOrEqual(upper);
        for (const value of [lower, upper]) {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 400 },
    );
    fc.assert(
      fc.property(fc.anything(), fc.anything(), fc.anything(), (fraction, step, steps) => {
        const value = producedFraction({ fraction, step, steps } as never);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }),
      { numRuns: 300 },
    );
  });
});

describe("the app's own stop for standing still, as a reason reads it", () => {
  const ceiling = BUSY_RUN_CEILING_SECONDS;

  it("tells an idle stop from a ceiling stop with the REAL limits of the no-progress rule, so a limit that moves cannot drift away from it", () => {
    // Every idle limit (before and after the first picture) is an idle stop; every busy ceiling is a ceiling stop.
    expect(stopFactsOf({ kind: "frozen", seconds: STALL_STOP_SECONDS }, ceiling)).toEqual({
      stopKind: "idle",
      stopSeconds: STALL_STOP_SECONDS,
    });
    expect(stopFactsOf({ kind: "slow_start", seconds: SLOW_START_SECONDS }, ceiling)).toEqual({
      stopKind: "idle",
      stopSeconds: SLOW_START_SECONDS,
    });
    expect(stopFactsOf({ kind: "spinning", seconds: BUSY_RUN_CEILING_SECONDS }, ceiling)).toEqual({
      stopKind: "ceiling",
      stopSeconds: BUSY_RUN_CEILING_SECONDS,
    });
    expect(
      stopFactsOf({ kind: "slow_start", seconds: BUSY_START_CEILING_SECONDS }, ceiling),
    ).toEqual({ stopKind: "ceiling", stopSeconds: BUSY_START_CEILING_SECONDS });
    expect(Math.max(STALL_STOP_SECONDS, SLOW_START_SECONDS)).toBeLessThan(ceiling);
    expect(BUSY_START_CEILING_SECONDS).toBeGreaterThanOrEqual(ceiling);
  });

  it("says nothing when the export was not stopped for standing still, or the stop cannot be read", () => {
    expect(stopFactsOf(undefined, ceiling)).toEqual({ stopKind: null, stopSeconds: null });
    expect(stopFactsOf(null, ceiling)).toEqual({ stopKind: null, stopSeconds: null });
    for (const seconds of [Number.NaN, Number.POSITIVE_INFINITY, -1, "180" as never])
      expect(stopFactsOf({ kind: "frozen", seconds }, ceiling)).toEqual({
        stopKind: null,
        stopSeconds: null,
      });
  });

  it("is a ceiling stop exactly when the kind is spinning or the stop came at the ceiling or later, and never throws (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("frozen", "slow_start", "spinning", "anything else"),
        fc.integer({ min: 0, max: 7200 }),
        (kind, seconds) => {
          const got = stopFactsOf({ kind, seconds }, ceiling);
          expect(got.stopSeconds).toBe(seconds);
          expect(got.stopKind).toBe(kind === "spinning" || seconds >= ceiling ? "ceiling" : "idle");
        },
      ),
      { numRuns: 300 },
    );
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (kind, seconds) => {
        const got = stopFactsOf({ kind, seconds } as never, ceiling);
        expect([null, "idle", "ceiling"]).toContain(got.stopKind);
        expect(got.stopKind === null).toBe(got.stopSeconds === null);
      }),
      { numRuns: 300 },
    );
  });
});

describe("who stopped the export a failure ended: a Cancel, or the app for standing still", () => {
  // Every combination, written out against the rule in words: a Cancel that was asked is a Cancel whatever the controller says;
  // an aborted controller is a Cancel unless the app's own stop for standing still did it.
  const CASES: Array<[boolean, boolean, boolean, boolean]> = [
    // aborted, appStopped, asked -> a Cancel was asked
    [false, false, false, false],
    [false, true, false, false],
    [true, false, false, true],
    [true, true, false, false], // the app's own stop aborts the controller, and is no Cancel
    [false, false, true, true],
    [false, true, true, true],
    [true, false, true, true],
    [true, true, true, true], // a Cancel asked on top of the app's own stop still stops the restart
  ];

  it.each(CASES)(
    "aborted %s, stopped by the app %s, Cancel asked %s: a Cancel was asked is %s",
    (aborted, appStopped, asked, expected) => {
      expect(wasCancelAsked({ aborted, appStopped, asked })).toBe(expected);
    },
  );
});

describe("stage 1: the PC itself ran short", () => {
  it("starts again one rung gentler after a pc_floor or an os stop, and says what it did", () => {
    expect(PC_SHORT_GUARDS).toEqual(["pc_floor", "os"]);
    for (const guard of PC_SHORT_GUARDS)
      expect(decideRestart(facts({ failure: { guard } }))).toEqual({
        restart: true,
        reason: "memory_short",
        override: { rung: 1 },
        restarted: "gentler_setting",
        routeM: 1,
        failedRungN: 0,
      });
  });

  it("goes on from the rung that failed, and steps over a rung that is the same command", () => {
    expect(decideRestart(facts({ attempt: { rung: 1 } }))).toMatchObject({
      restart: true,
      override: { rung: 2 },
      routeM: 2,
      failedRungN: 1,
    });
    expect(decideRestart(facts({ attempt: { ladder: [0, 2] } }))).toMatchObject({
      restart: true,
      override: { rung: 2 },
    });
  });

  it("takes the first rung from the next that fits, as the planner reads this PC's memory now", () => {
    // 3.5 GiB peaked at the normal rung: rung 1 is predicted at 2.1 GiB and rung 2 at 1.75 GiB.
    const at = (freeBytes: number) =>
      decideRestart(facts({ machine: { failedPeakBytes: 3.5 * GIB, freeBytes } }));
    expect(at(4 * GIB)).toMatchObject({ restart: true, override: { rung: 1 } }); // a 3 GiB ceiling
    expect(at(2.5 * GIB)).toMatchObject({ restart: true, override: { rung: 2 } }); // 1.875 GiB: only rung 2
    expect(at(1 * GIB)).toEqual(PC_SHORT); // 0.75 GiB: neither
  });

  it("asks the planner's own reserve of a stop whose peak was never measured", () => {
    const at = (freeBytes: number) =>
      decideRestart(facts({ machine: { failedPeakBytes: null, freeBytes } }));
    expect(at(3e9)).toMatchObject({ restart: true, override: { rung: 1 } });
    expect(at(1.9e9)).toEqual(PC_SHORT);
  });

  it("does not bet on a PC whose free memory it cannot read", () => {
    expect(decideRestart(facts({ machine: { freeBytes: null } }))).toEqual(PC_SHORT);
  });

  it("has no route from the gentlest rung of the ladder, on the streamed engine, or with the rungs switched off", () => {
    expect(decideRestart(facts({ attempt: { rung: 2 } }))).toEqual(NO_ROUTE);
    expect(decideRestart(facts({ attempt: { rung: 1, ladder: [0, 1] } }))).toEqual(NO_ROUTE);
    expect(decideRestart(facts({ attempt: { ladder: [0] } }))).toEqual(NO_ROUTE);
    expect(decideRestart(facts({ attempt: { engine: STREAMED, ladder: [0] } }))).toEqual(NO_ROUTE);
    // facts that contradict each other still refuse: the streamed engine has no gentler step whatever the ladder says
    expect(decideRestart(facts({ attempt: { engine: STREAMED } }))).toEqual(NO_ROUTE);
    expect(decideRestart(facts({ flags: { plan_rung: false } }))).toEqual(NO_ROUTE);
  });

  it("does not restart a stop that is not the PC's, and leaves the export's own ceiling to stage 2", () => {
    for (const guard of [null, "scratch", "clock", "other"] as const)
      expect(decideRestart(facts({ failure: { guard } }))).toEqual({
        restart: false,
        why: "not_memory",
      });
    for (const guard of OWN_CEILING_GUARDS)
      expect(eligibleReasons(facts({ failure: { guard } }))).not.toContain("memory_short");
    for (const code of EXPORT_REASON_CODES.filter((code) => code !== "memory_limit"))
      expect(decideRestart(facts({ failure: { code } }))).toEqual({
        restart: false,
        why: "not_memory",
      });
  });
});

describe("stage 2: the export reached its own ceiling", () => {
  const at = (freeBytes: number, over: Over = {}, options: DecideOptions = { table: TABLE }) =>
    decideRestart(ceilingFacts({ ...over, machine: { freeBytes, ...over.machine } }), options);
  const rung = (step: Rung) => ({ restart: true, override: { rung: step } });
  const streamed = { restart: true, override: { engine: STREAMED }, routeM: 10 };

  it("is not restarted yet: the table ships empty, so a resident or commit stop ends as it does today", () => {
    expect(ROUTE_TABLE).toEqual([]);
    for (const guard of OWN_CEILING_GUARDS)
      expect(decideRestart(ceilingFacts({ failure: { guard } }))).toEqual(NO_ROUTE);
  });

  it("restarts on the fastest route that fits with room to spare, and says what it did", () => {
    expect(at(10 * GIB)).toEqual({
      restart: true,
      reason: "memory_ceiling",
      override: { rung: 1 },
      restarted: "memory_light_route",
      routeM: 1,
      failedRungN: 0,
    });
    // 6 GiB free: rung 1 fits (3,994 of 4,608 MiB) but leaves under 15 % to spare, so the next one is taken
    expect(at(6 * GIB)).toMatchObject(rung(2));
    // 3.5 GiB free (a 2,688 MiB ceiling): rung 2 fits (2,496) without room to spare, the streamed engine has it
    expect(at(3.5 * GIB)).toMatchObject(streamed);
  });

  it("takes the lightest route that fits at all when none leaves room to spare", () => {
    const close = [
      routeRow({ id: "rung-1", route: { rung: 1 }, peakFactor: 0.6 }),
      routeRow({ id: "rung-2", route: { rung: 2 }, peakFactor: 0.55 }),
    ];
    // a 3,100 MiB ceiling: both fit (2,995 and 2,746 MiB), neither is under 85 % of it (2,635): the lighter one
    expect(at(freeFor(3100), {}, { table: close })).toMatchObject(rung(2));
    expect(at(2.2 * GIB)).toMatchObject(streamed); // only the streamed engine fits at all
  });

  it("is refused when no route fits the memory there is", () => {
    expect(at(1.5 * GIB)).toEqual(PC_SHORT);
    expect(at(0)).toEqual(PC_SHORT);
    expect(decideRestart(ceilingFacts({ machine: { freeBytes: null } }), { table: TABLE })).toEqual(
      PC_SHORT,
    );
  });

  it("works from the larger of what the run peaked at and the limit it stopped at", () => {
    // Rung 2 is predicted at half the anchor. With the limit above the peak the anchor is the limit.
    const only = { table: [RUNG_2] };
    const ceiling2300 = freeFor(2300);
    const held = { failedPeakBytes: 4000 * MIB, limitBytes: 5000 * MIB }; // 2,500 MiB predicted: does not fit 2,300
    expect(at(ceiling2300, { machine: held }, only)).toEqual(PC_SHORT);
    const overshot = { failedPeakBytes: 4500 * MIB, limitBytes: 4000 * MIB }; // 2,250 MiB: fits
    expect(at(ceiling2300, { machine: overshot }, only)).toMatchObject(rung(2));
    expect(
      at(ceiling2300, { machine: { failedPeakBytes: 4000 * MIB, limitBytes: null } }, only),
    ).toMatchObject(rung(2)); // no limit known: the peak alone, 2,000 MiB
    expect(at(10 * GIB, { machine: { failedPeakBytes: null, limitBytes: null } })).toEqual(
      NO_ROUTE,
    ); // nothing to predict from
    expect(anchorBytes("resident", 4000, 5000)).toBe(5000);
    expect(anchorBytes("commit", 6000, 5000)).toBe(6000);
    expect(anchorBytes("resident", null, 5000)).toBe(5000);
    expect(anchorBytes("resident", 4000, null)).toBe(4000);
    expect(anchorBytes("resident", null, null)).toBeNull();
    // where the PC ran short its peak is the whole evidence, and the limit says nothing
    expect(anchorBytes("pc_floor", 4000, 9000)).toBe(4000);
    expect(anchorBytes("os", null, 9000)).toBeNull();
    for (const guard of ["scratch", "clock", "other", null])
      expect(anchorBytes(guard, 1, 1)).toBeNull();
  });

  it("applies a row's factor only to a run on the normal route, and its own figure to any", () => {
    const failedOnRung1 = { attempt: { rung: 1 as Rung } };
    expect(at(10 * GIB, failedOnRung1, { table: [RUNG_2] })).toEqual(NO_ROUTE); // a factor of the NORMAL route's peak
    const figure = routeRow({
      id: "rung-2-figure",
      route: { rung: 2 },
      peakFactor: undefined,
      peakMiB: 2000,
    });
    expect(at(10 * GIB, failedOnRung1, { table: [figure] })).toMatchObject(rung(2));
  });

  it("never offers the route that failed or a heavier one", () => {
    const rung0 = routeRow({ id: "rung-0", route: { rung: 0 }, peakFactor: 0.4 });
    expect(at(10 * GIB, {}, { table: [rung0] })).toEqual(NO_ROUTE);
    expect(at(10 * GIB, {}, { table: [rung0, RUNG_1] })).toMatchObject(rung(1));
    // the failed run was on rung 1: rungs 0 and 1 are not routes from it, rung 2 is
    const onRung1 = { attempt: { rung: 1 as Rung } };
    const figures = [0, 1, 2].map((step) =>
      routeRow({
        id: `figure-${step}`,
        route: { rung: step as Rung },
        peakFactor: undefined,
        peakMiB: 1000,
      }),
    );
    expect(at(10 * GIB, onRung1, { table: figures })).toMatchObject(rung(2));
    // the streamed engine has no lighter route
    expect(at(10 * GIB, { attempt: { engine: STREAMED, ladder: [0] } })).toEqual(NO_ROUTE);
    // a route predicted at the anchor or above it is not lighter on memory, whatever its place in the order
    const level = routeRow({
      id: "level",
      route: { rung: 1 },
      peakFactor: undefined,
      peakMiB: 4992,
    });
    const above = routeRow({
      id: "above",
      route: { rung: 2 },
      peakFactor: undefined,
      peakMiB: 6000,
    });
    expect(at(10 * GIB, {}, { table: [level, above] })).toEqual(NO_ROUTE);
  });

  it("offers a rung only if it is on the export's ladder and the rungs are switched on", () => {
    expect(at(10 * GIB, { attempt: { ladder: [0, 2] } })).toMatchObject(rung(2)); // rung 1 is the same command as rung 0
    expect(at(10 * GIB, { flags: { plan_rung: false } })).toMatchObject(streamed);
    expect(at(10 * GIB, { flags: { plan_rung: false } }, { table: [RUNG_1, RUNG_2] })).toEqual(
      NO_ROUTE,
    );
  });

  it("offers the streamed engine only with its picture cleared and its own switch on", () => {
    const only = { table: [STREAMED_ROW] };
    expect(at(10 * GIB, {}, only)).toMatchObject(streamed);
    expect(at(10 * GIB, { flags: { restart_streamed: false } }, only)).toEqual(NO_ROUTE);
    for (const pictureCleared of [false, undefined])
      expect(at(10 * GIB, {}, { table: [{ ...STREAMED_ROW, pictureCleared }] })).toEqual(NO_ROUTE);
    // and where a rung would also do, the refusal of the streamed engine leaves the rung
    expect(at(3.5 * GIB, { flags: { restart_streamed: false } })).toMatchObject(rung(2));
  });

  it("leaves out a route that its own start-up or its silences would get stopped by the no-progress rule", () => {
    const slow = (over: Partial<RouteRow>) => ({ table: [RUNG_1, { ...STREAMED_ROW, ...over }] });
    expect(MAX_FIRST_REPORT_WAIT_S).toBe(900); // half of the 30 minutes to a first report
    expect(MAX_LONGEST_GAP_S).toBe(450); // half of the 15 minutes between pictures
    for (const [field, limit] of [
      ["firstReportWaitS", MAX_FIRST_REPORT_WAIT_S],
      ["longestGapS", MAX_LONGEST_GAP_S],
    ] as const) {
      expect(at(3.5 * GIB, {}, slow({ [field]: limit }))).toMatchObject(streamed);
      expect(at(3.5 * GIB, {}, slow({ [field]: limit + 1 }))).toEqual(PC_SHORT); // the streamed engine was the only one with room; rung 1 cannot fit
    }
  });

  it("leaves out a route that would take more than six hours, and with no expected time only one no slower", () => {
    expect(MAX_ROUTE_SECONDS).toBe(6 * 3600);
    const expectedFor = (seconds: number | null) => ({ progress: { expectedSeconds: seconds } });
    const only = { table: [STREAMED_ROW] }; // 2.5 times the normal route's time
    expect(at(10 * GIB, expectedFor(8640), only)).toMatchObject(streamed); // exactly six hours
    expect(at(10 * GIB, expectedFor(8641), only)).toEqual(NO_ROUTE);
    expect(at(10 * GIB, expectedFor(null), only)).toEqual(NO_ROUTE);
    const same = { table: [{ ...STREAMED_ROW, timeFactor: 1 }] };
    expect(at(10 * GIB, expectedFor(null), same)).toMatchObject(streamed);
  });

  it("offers a route only to a project a row matches", () => {
    expect(at(10 * GIB, { workload: LIGHT })).toEqual(NO_ROUTE);
    expect(at(10 * GIB, { workload: null })).toEqual(NO_ROUTE);
    const throwing = routeRow({
      id: "throws",
      route: { rung: 1 },
      matches: () => {
        throw new Error("a row that cannot say");
      },
    });
    expect(at(10 * GIB, {}, { table: [throwing] })).toEqual(NO_ROUTE);
    expect(at(10 * GIB, {}, { table: [throwing, RUNG_2] })).toMatchObject(rung(2));
    // a row can match on the facts the app already has
    const wide = routeRow({
      id: "wide",
      route: { rung: 1 },
      matches: (workload) => workload.width * workload.height >= 1920 * 1080,
    });
    const known: RenderWorkload = {
      width: 1080,
      height: 1920,
      fps: 30,
      durationSeconds: 60,
      visualClips: 3,
      captionClips: 0,
      audioClips: 1,
      peakVisualLayers: 1,
      peakMediaLayers: 2,
    };
    const fromApp = (workload: RenderWorkload): RestartWorkload => ({
      ...workload,
      sourceInputs: 3,
      effects: [],
    });
    expect(at(10 * GIB, { workload: fromApp(known) }, { table: [wide] })).toMatchObject(rung(1));
    expect(
      at(10 * GIB, { workload: fromApp({ ...known, width: 640, height: 360 }) }, { table: [wide] }),
    ).toEqual(NO_ROUTE);
  });

  it("believes the worst of the rows that match one route", () => {
    const hopeful = routeRow({ id: "hopeful", route: { rung: 2 }, peakFactor: 0.3 });
    const careful = routeRow({ id: "careful", route: { rung: 2 }, peakFactor: 0.9 });
    expect(at(freeFor(3000), {}, { table: [hopeful] })).toMatchObject(rung(2)); // 1,498 MiB
    expect(at(freeFor(3000), {}, { table: [hopeful, careful] })).toEqual(PC_SHORT); // 4,493 MiB
    expect(at(freeFor(3000), {}, { table: [careful, hopeful] })).toEqual(PC_SHORT);
    // the streamed engine only if every row that matches cleared its picture
    const doubtful = { ...STREAMED_ROW, id: "doubtful", pictureCleared: false };
    expect(at(10 * GIB, {}, { table: [STREAMED_ROW, doubtful] })).toEqual(NO_ROUTE);
  });

  it("never offers a row that is not a usable row, and says what is wrong with it", () => {
    const broken: RouteRow[] = [
      { ...RUNG_1, peakFactor: Number.NaN },
      { ...RUNG_1, peakFactor: 1.2 },
      { ...RUNG_1, evidence: "" },
      { ...RUNG_1, firstReportWaitS: -1 },
    ];
    for (const row of broken) {
      expect(routeRowProblems(row), row.id).not.toEqual([]);
      expect(at(10 * GIB, {}, { table: [row] })).toEqual(NO_ROUTE);
      expect(at(10 * GIB, {}, { table: [row, RUNG_2] })).toMatchObject(rung(2));
    }
    expect(routeRowProblems(RUNG_1)).toEqual([]);
    expect(routeRowProblems(STREAMED_ROW)).toEqual([]);
  });

  it("holds for a stop at the commit cap as for the resident one, and not after the quarter", () => {
    expect(at(10 * GIB, { failure: { guard: "commit" } })).toMatchObject(rung(1));
    expect(at(10 * GIB, { progress: { producedFraction: 0.3 } })).toEqual({
      restart: false,
      why: "late",
    });
    expect(ROOM_SHARE).toBe(0.85);
  });
});

function merged(parts: readonly Over[]): Over {
  const out: Over = {};
  for (const part of parts) {
    out.failure = { ...out.failure, ...part.failure };
    out.attempt = { ...out.attempt, ...part.attempt };
    out.progress = { ...out.progress, ...part.progress };
    out.machine = { ...out.machine, ...part.machine };
    out.request = { ...out.request, ...part.request };
    out.flags = { ...out.flags, ...part.flags };
    if (part.workload !== undefined) out.workload = part.workload;
  }
  return out;
}

/** The facts as the overrides that rebuild them. */
function overOf(base: RestartFacts): Over {
  const { flags, ...request } = base.request;
  return { ...base, request, flags };
}

/** Every non-empty set of broken conditions: the answer is the first of them in the fixed order, whatever else is
 *  broken with it. `breaks` says how to break each condition that applies to the reason under test. */
function walkOrder(
  base: (over: Over) => RestartFacts,
  breaks: Partial<Record<RestartRefusal, Over>>,
  options?: DecideOptions,
): number {
  const present = ORDER.filter((why) => breaks[why] !== undefined);
  expect(decideRestart(base({}), options)).toMatchObject({ restart: true });
  let walked = 0;
  for (let mask = 1; mask < 2 ** present.length; mask++) {
    const picked = present.filter((_, bit) => (mask >> bit) % 2 === 1);
    const decision = decideRestart(base(merged(picked.map((why) => breaks[why]!))), options);
    expect(decision, picked.join(" + ")).toEqual({ restart: false, why: picked[0] });
    walked++;
  }
  return walked;
}

const BREAKS: Record<RestartRefusal, Over> = {
  not_memory: { failure: { code: "time_limit" } },
  flag_off: { flags: { memory_restart: false } },
  cancelled: { request: { aborted: true } },
  second: { request: { autoRestartsUsed: 1 } },
  no_closure: { request: { retryClosureExists: false } },
  edited: { request: { snapshotUnchanged: false } },
  late: { progress: { producedFraction: 0.4 } },
  no_route: { attempt: { rung: 2 } },
  pc_short: { machine: { freeBytes: 1 * MIB } },
};
const BREAKS_CEILING: Record<RestartRefusal, Over> = {
  ...BREAKS,
  flag_off: { flags: { auto_restart: false } },
  no_route: { workload: LIGHT },
  pc_short: { machine: { freeBytes: 1 * GIB } },
};

describe("what every reason must respect", () => {
  it("refuses each broken condition with its own word, and restarts when none is broken", () => {
    expect(decideRestart(facts())).toMatchObject({ restart: true });
    for (const why of ORDER) {
      expect(decideRestart(facts(BREAKS[why])), why).toEqual({ restart: false, why });
      expect(decideRestart(ceilingFacts(BREAKS_CEILING[why]), { table: TABLE }), why).toEqual({
        restart: false,
        why,
      });
    }
  });

  it("gives the first refusal in a fixed order, whatever else is wrong with the same export", () => {
    expect(REFUSAL_ORDER).toEqual(ORDER);
    expect(walkOrder(facts, BREAKS)).toBe(2 ** 9 - 1);
    expect(walkOrder(ceilingFacts, BREAKS_CEILING, { table: TABLE })).toBe(2 ** 9 - 1);
  });

  it("is too late at a quarter of the project, not before", () => {
    expect(FIRST_QUARTER).toBe(0.25);
    for (const producedFraction of [0, 0.1, 0.2499999])
      expect(decideRestart(facts({ progress: { producedFraction } }))).toMatchObject({
        restart: true,
      });
    for (const producedFraction of [FIRST_QUARTER, 0.2500001, 0.5, 1])
      expect(decideRestart(facts({ progress: { producedFraction } }))).toEqual({
        restart: false,
        why: "late",
      });
  });

  it("is stopped by either switch, the master one or the reason's own", () => {
    for (const flags of [{ auto_restart: false }, { memory_restart: false }])
      for (const make of [facts, ceilingFacts])
        expect(decideRestart(make({ flags }), { table: TABLE })).toEqual({
          restart: false,
          why: "flag_off",
        });
    // the switch for the streamed engine and for the rungs are not reasons' switches: they only narrow the routes
    expect(decideRestart(facts({ flags: { restart_streamed: false } }))).toMatchObject({
      restart: true,
    });
  });

  it("does not start a second automatic restart, whatever the count says", () => {
    for (const autoRestartsUsed of [1, 2, 9])
      expect(decideRestart(facts({ request: { autoRestartsUsed } }))).toEqual({
        restart: false,
        why: "second",
      });
  });

  it("does not restart a stop that is not memory, with any limit", () => {
    for (const code of EXPORT_REASON_CODES.filter((code) => code !== "memory_limit"))
      for (const guard of [...EXPORT_LIMITS, null])
        expect(decideRestart(ceilingFacts({ failure: { code, guard } }), { table: TABLE })).toEqual(
          {
            restart: false,
            why: "not_memory",
          },
        );
    for (const guard of EXPORT_LIMITS.filter(
      (limit) => !PC_SHORT_GUARDS.includes(limit) && !OWN_CEILING_GUARDS.includes(limit),
    ))
      expect(decideRestart(ceilingFacts({ failure: { guard } }), { table: TABLE })).toEqual({
        restart: false,
        why: "not_memory",
      });
  });
});

/** Replace one fact, in a copy: the facts of a favorable PC-short stop with `value` at `path`. */
function withValue(path: readonly string[], value: unknown): RestartFacts {
  const copy = structuredClone(facts()) as unknown as Record<string, unknown>;
  let at = copy;
  for (const key of path.slice(0, -1)) at = at[key] as Record<string, unknown>;
  at[path[path.length - 1]] = value;
  return copy as unknown as RestartFacts;
}

const NOT_A_NUMBER = [Number.NaN, "0", "1", null, undefined, {}, [], true, false];
const NOT_AN_AMOUNT = [...NOT_A_NUMBER, -1, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
const NOT_TRUE = [false, 0, 1, "true", null, undefined, {}, []];
const NOT_A_STRING = [0, 1, true, null, undefined, {}, [], Number.NaN];
const NOT_A_SECTION = [null, undefined, 5, "x", [], true];

describe("facts that cannot be read", () => {
  // The facts that decide a PC-short restart each have values that cannot be read, and each such value refuses with
  // the word of that fact. The facts it does not use may be anything, and the answer is still an answer.
  const decisive: ReadonlyArray<[path: string[], values: readonly unknown[], why: RestartRefusal]> =
    [
      [["failure", "code"], [...NOT_A_STRING, "", "nope"], "not_memory"],
      [["failure", "guard"], [...NOT_A_STRING.filter((v) => v !== null), "nope", ""], "not_memory"],
      [["attempt", "rung"], [3, -1, 0.5, ...NOT_A_NUMBER], "no_route"],
      [
        ["attempt", "ladder"],
        [undefined, null, "0,1,2", 5, {}, [], [7], ["0"], [Number.NaN]],
        "no_route",
      ],
      [["attempt", "engine"], ["auto", "x", 0, null, undefined, {}], "no_route"],
      [["progress", "producedFraction"], NOT_AN_AMOUNT, "late"],
      [["machine", "freeBytes"], NOT_AN_AMOUNT, "pc_short"],
      [["request", "aborted"], [true, 0, 1, "false", null, undefined, {}, []], "cancelled"],
      [
        ["request", "autoRestartsUsed"],
        [1, -1, 0.5, Number.NaN, "0", null, undefined, {}, []],
        "second",
      ],
      [["request", "retryClosureExists"], NOT_TRUE, "no_closure"],
      [["request", "snapshotUnchanged"], NOT_TRUE, "edited"],
      [["request", "flags", "auto_restart"], NOT_TRUE, "flag_off"],
      [["request", "flags", "memory_restart"], NOT_TRUE, "flag_off"],
      [["request", "flags"], NOT_A_SECTION, "flag_off"],
      [["failure"], NOT_A_SECTION, "not_memory"],
      [["attempt"], NOT_A_SECTION, "no_route"],
      [["progress"], NOT_A_SECTION, "late"],
      [["machine"], NOT_A_SECTION, "pc_short"],
      [["request"], NOT_A_SECTION, "flag_off"],
    ];
  const unused: ReadonlyArray<[string[], readonly unknown[]]> = [
    [["failure", "stopKind"], NOT_A_STRING],
    [["failure", "stopSeconds"], NOT_AN_AMOUNT],
    [["attempt", "number"], NOT_A_NUMBER],
    [["attempt", "encoder"], NOT_A_STRING],
    [["attempt", "chipMaker"], NOT_A_STRING],
    [["attempt", "stickyRoute"], NOT_A_STRING],
    [["progress", "elapsedSeconds"], NOT_AN_AMOUNT],
    [["progress", "activeSeconds"], NOT_AN_AMOUNT],
    [["progress", "expectedSeconds"], NOT_AN_AMOUNT],
    [["machine", "failedPeakBytes"], NOT_AN_AMOUNT],
    [["machine", "limitBytes"], NOT_AN_AMOUNT],
    [["workload"], NOT_A_SECTION],
  ];

  it("refuse with the word of the fact that cannot be read, and never throw", () => {
    for (const [path, values, why] of decisive)
      for (const value of values) {
        const label = `${path.join(".")} = ${String(JSON.stringify(value))}`;
        expect(() => decideRestart(withValue(path, value)), label).not.toThrow();
        expect(decideRestart(withValue(path, value)), label).toEqual({ restart: false, why });
      }
  });

  it("do not stop a restart that does not need them, and never throw", () => {
    for (const [path, values] of unused)
      for (const value of values) {
        const label = `${path.join(".")} = ${String(JSON.stringify(value))}`;
        expect(() => decideRestart(withValue(path, value)), label).not.toThrow();
        expect(decideRestart(withValue(path, value)), label).toMatchObject({ restart: true });
      }
  });

  it("refuse as not a memory failure when there are no facts at all", () => {
    for (const nothing of [null, undefined, 0, "x", [], {}, true])
      expect(decideRestart(nothing as never)).toEqual({ restart: false, why: "not_memory" });
  });

  it("give an answer for options that are not what they should be", () => {
    expect(decideRestart(facts(), null as never)).toMatchObject({ restart: true });
    expect(decideRestart(ceilingFacts(), { table: 5 as never })).toEqual(NO_ROUTE);
    expect(decideRestart(ceilingFacts(), { table: [null, 7, "x", {}] as never })).toEqual(NO_ROUTE);
    expect(decideRestart(facts(), { rows: 5 as never })).toEqual({
      restart: false,
      why: "not_memory",
    });
  });
});

// A promise about the picture, a likeness or a speed: nothing a person or the assistant reads may make one.
const PROMISES =
  /pixel|same (picture|image|look|quality)|identical|looks? the same|times (faster|slower|longer)|\d\s?[x×]\s|twice|half the time/i;
const WORD_KEYS = ["gap", "after", "failedAgain", "assistantNote"] as const;

/** What a row of the table must have; empty when it has it all. */
function reasonProblems(row: AutoRestartReason): string[] {
  const problems: string[] = [];
  const name = /^[a-z][a-z0-9_]*$/;
  const among = (list: readonly string[], value: unknown) => list.includes(value as string);
  if (typeof row.reason !== "string" || !name.test(row.reason)) problems.push("reason");
  if (typeof row.owner !== "string" || row.owner.trim() === "") problems.push("owner");
  if (typeof row.flag !== "string" || !name.test(row.flag)) problems.push("flag");
  if (typeof row.trigger !== "function") problems.push("trigger");
  if (!among(RESTARTED_AS, row.restarted)) problems.push("restarted");
  if (
    !Array.isArray(row.override) ||
    row.override.length === 0 ||
    !row.override.every((key) => among(OVERRIDE_KEYS, key))
  )
    problems.push("override");
  if (
    !Array.isArray(row.witnesses) ||
    row.witnesses.length === 0 ||
    !row.witnesses.every((id) => typeof id === "string" && /^[A-Z]\d+[a-z]?$/.test(id))
  )
    problems.push("witnesses");
  for (const key of WORD_KEYS) {
    const sentence: unknown = row.words?.[key];
    if (typeof sentence !== "string" || sentence.trim() === "") problems.push(`words.${key}`);
    else if (PROMISES.test(sentence)) problems.push(`words.${key} promises`);
  }
  return problems;
}

// The graphics chip's reason is a row of the shipped table (chipRestart.ts): the walks below hold it to the same checks as the
// memory rows, with facts a failure only a chip explains would have.
const CHIP_FAILED = restartRow("chip_failed")!;

/** A failed graphics-chip encode that arrived at the very end of the export. */
function chipFacts(over: Over = {}): RestartFacts {
  return facts({
    ...over,
    failure: { code: "verification_failed", guard: null, ...over.failure },
    attempt: { chipMaker: "amd", encoder: "chip-amd", ...over.attempt },
    progress: { producedFraction: 0.97, ...over.progress },
    flags: { chip_restart: true, ...over.flags },
  });
}

const ROWS: readonly AutoRestartReason[] = AUTO_RESTART_REASONS;
const WITH_ALL: DecideOptions = { rows: ROWS, table: TABLE };
// The chip row has no first-quarter rule and its route is a certain one, so it has two conditions fewer; an export that ran on no chip is
// not its failure at all (the same word as any failure no row is about).
const BREAKS_CHIP: Partial<Record<RestartRefusal, Over>> = {
  not_memory: { failure: { code: "storage_full" } },
  flag_off: { flags: { chip_restart: false } },
  cancelled: { request: { aborted: true } },
  second: { request: { autoRestartsUsed: 1 } },
  no_closure: { request: { retryClosureExists: false } },
  edited: { request: { snapshotUnchanged: false } },
};
// Facts every row restarts on. A row added to the table needs an entry here, and then the walks below hold it to
// everything every other row is held to.
const FAVORABLE: Record<string, () => RestartFacts> = {
  memory_short: () => facts(),
  memory_ceiling: () => ceilingFacts(),
  chip_failed: () => chipFacts(),
};

describe("the table of reasons", () => {
  it("has the memory reasons, and every row has its words, its switch, its witnesses and an override from the closed list", () => {
    const reasons = AUTO_RESTART_REASONS.map((row) => row.reason);
    expect(reasons).toEqual(expect.arrayContaining(["memory_short", "memory_ceiling"]));
    expect(new Set(reasons).size).toBe(reasons.length);
    for (const row of AUTO_RESTART_REASONS) expect(reasonProblems(row), row.reason).toEqual([]);
    expect(reasonProblems(CHIP_FAILED)).toEqual([]);
    expect(restartRow("memory_short")).toBe(AUTO_RESTART_REASONS[0]);
    expect(restartRow("nope")).toBeNull();
  });

  it("fails a row that lacks any of them", () => {
    const good = AUTO_RESTART_REASONS[0];
    const damaged: ReadonlyArray<[string, Partial<Record<keyof AutoRestartReason, unknown>>]> = [
      ["reason", { reason: "" }],
      ["reason", { reason: "Memory Short" }],
      ["owner", { owner: " " }],
      ["flag", { flag: "" }],
      ["trigger", { trigger: undefined }],
      ["restarted", { restarted: "the_same_picture" }],
      ["override", { override: [] }],
      ["override", { override: ["rung", "bitrate"] }],
      ["witnesses", { witnesses: [] }],
      ["witnesses", { witnesses: ["later"] }],
      ["words.gap", { words: { ...good.words, gap: "" } }],
      ["words.after", { words: { ...good.words, after: undefined } }],
      ["words.failedAgain", { words: undefined }],
      ["words.assistantNote", { words: { ...good.words, assistantNote: "  " } }],
    ];
    for (const [problem, patch] of damaged)
      expect(
        reasonProblems({ ...good, ...patch } as AutoRestartReason),
        JSON.stringify(patch),
      ).toContain(problem);
  });

  it("keeps every sentence free of a promise about the picture or the speed, and the check can tell one", () => {
    for (const row of ROWS)
      for (const key of WORD_KEYS)
        expect(row.words[key], `${row.reason}.${key}`).not.toMatch(PROMISES);
    const promises = [
      "Every pixel is kept.",
      "You get the same picture as before.",
      "The file is identical to a normal export.",
      "It looks the same.",
      "It runs 2 times faster.",
      "About 3 x slower than usual.",
      "It takes twice as long.",
    ];
    for (const sentence of promises) expect(sentence).toMatch(PROMISES);
    for (const row of AUTO_RESTART_REASONS)
      expect(reasonProblems({ ...row, words: { ...row.words, after: promises[1] } })).toContain(
        "words.after promises",
      );
  });

  it("is closed: nothing can be added to it or changed in it", () => {
    expect(Object.isFrozen(AUTO_RESTART_REASONS)).toBe(true);
    expect(Object.isFrozen(ROUTE_TABLE)).toBe(true);
    for (const row of AUTO_RESTART_REASONS) expect(Object.isFrozen(row)).toBe(true);
    expect(() => (AUTO_RESTART_REASONS as AutoRestartReason[]).push(CHIP_FAILED)).toThrow();
    expect(() => (ROUTE_TABLE as RouteRow[]).push(RUNG_1)).toThrow();
    expect(() => {
      (AUTO_RESTART_REASONS[0] as { flag: string }).flag = "other";
    }).toThrow();
  });

  it("holds every route row of the shipped table to what the chooser needs, evidence included", () => {
    for (const row of ROUTE_TABLE) expect(routeRowProblems(row), row.id).toEqual([]);
    expect(new Set(ROUTE_TABLE.map((row) => row.id)).size).toBe(ROUTE_TABLE.length);
    // the check is not blind: a good row has no problem and each way to spoil one is found
    expect(routeRowProblems(RUNG_1)).toEqual([]);
    const spoiled: ReadonlyArray<[string, Partial<Record<keyof RouteRow, unknown>>]> = [
      ["id", { id: "" }],
      ["matches", { matches: undefined }],
      ["route", { route: {} }],
      ["route.rung", { route: { rung: 3 } }],
      ["route.rung", { route: { engine: STREAMED, rung: 2 } }],
      ["route.engine", { route: { engine: "file-sequence-v1" } }],
      ["peak", { peakFactor: undefined, peakMiB: undefined }],
      ["peakFactor", { peakFactor: 1 }],
      ["peakFactor", { peakFactor: 0 }],
      ["peakMiB", { peakMiB: -5 }],
      ["firstReportWaitS", { firstReportWaitS: Number.NaN }],
      ["longestGapS", { longestGapS: -1 }],
      ["timeFactor", { timeFactor: 0 }],
      ["evidence", { evidence: "  " }],
      ["evidence", { evidence: undefined }],
      ["pictureCleared", { pictureCleared: "yes" }],
    ];
    for (const [problem, patch] of spoiled)
      expect(
        routeRowProblems({ ...RUNG_1, ...patch } as RouteRow),
        JSON.stringify(patch),
      ).toContain(problem);
  });
});

describe("a second reason in the table", () => {
  it("restarts a chip failure on the processor at any point of the export, and says what it did", () => {
    expect(decideRestart(chipFacts(), WITH_ALL)).toEqual({
      restart: true,
      reason: "chip_failed",
      override: { processor: true },
      restarted: "processor",
      routeM: 0,
      failedRungN: 0,
    });
    // the memory rows do not take it, and it does not take a memory stop
    expect(
      decideRestart(chipFacts(), { rows: AUTO_RESTART_REASONS.slice(0, 2), table: TABLE }),
    ).toEqual({
      restart: false,
      why: "not_memory",
    });
    expect(decideRestart(facts(), WITH_ALL)).toMatchObject({ reason: "memory_short" });
    expect(decideRestart(ceilingFacts(), WITH_ALL)).toMatchObject({ reason: "memory_ceiling" });
  });

  it("is held to the same order of refusals as the memory reasons, with its own switch", () => {
    const walked = walkOrder((over) => chipFacts(over), BREAKS_CHIP, WITH_ALL);
    expect(walked).toBe(2 ** 6 - 1);
    // the master switch stops it as well
    expect(decideRestart(chipFacts({ flags: { auto_restart: false } }), WITH_ALL)).toEqual({
      restart: false,
      why: "flag_off",
    });
  });

  it("walks every row: each has facts it restarts on, and each is held to the same checks", () => {
    for (const row of ROWS) {
      const make = FAVORABLE[row.reason];
      expect(make, `${row.reason} needs favorable facts in FAVORABLE`).toBeDefined();
      const decision = decideRestart(make(), WITH_ALL);
      expect(decision, row.reason).toMatchObject({
        restart: true,
        reason: row.reason,
        restarted: row.restarted,
      });
      if (decision.restart)
        for (const key of Object.keys(decision.override))
          expect(row.override as readonly string[], `${row.reason} changes ${key}`).toContain(key);
      const base = make();
      const broken: ReadonlyArray<[RestartRefusal, Over]> = [
        ["flag_off", { flags: { auto_restart: false } }],
        ["flag_off", { flags: { [row.flag]: false } }],
        ["cancelled", { request: { aborted: true } }],
        ["second", { request: { autoRestartsUsed: 1 } }],
        ["no_closure", { request: { retryClosureExists: false } }],
        ["edited", { request: { snapshotUnchanged: false } }],
      ];
      for (const [why, patch] of broken) {
        const spoiled = merged([overOf(base), patch]);
        expect(decideRestart(facts(spoiled), WITH_ALL), `${row.reason}: ${why}`).toEqual({
          restart: false,
          why,
        });
      }
    }
  });

  it("never lets a second automatic restart start, whichever reason came first and whichever second", () => {
    for (const first of ROWS)
      for (const second of ROWS) {
        const make = FAVORABLE[second.reason];
        expect(decideRestart(FAVORABLE[first.reason](), WITH_ALL)).toMatchObject({
          restart: true,
          reason: first.reason,
        });
        // the successor of that restart carries the count: it runs short of memory, or its chip fails
        const successor = merged([overOf(make()), { request: { autoRestartsUsed: 1 } }]);
        expect(
          decideRestart(facts(successor), WITH_ALL),
          `${first.reason} then ${second.reason}`,
        ).toEqual({
          restart: false,
          why: "second",
        });
      }
  });

  /** Every (code, limit, chip) a failure can have, with facts every row would restart on: how many rows accept it,
   *  and which rows accept anything at all. */
  function exclusivity(rows: readonly AutoRestartReason[]) {
    const violations: string[] = [];
    const accepted = new Set<string>();
    for (const code of EXPORT_REASON_CODES)
      for (const guard of [...EXPORT_LIMITS, null])
        for (const chipMaker of [null, "amd"] as const) {
          const eligible = eligibleReasons(
            ceilingFacts({
              failure: { code, guard },
              attempt: { chipMaker, encoder: chipMaker === null ? "x264-crf" : "chip-amd" },
              flags: { chip_restart: true },
            }),
            { rows, table: TABLE },
          );
          for (const reason of eligible) accepted.add(reason);
          if (eligible.length > 1)
            violations.push(`${code} / ${guard} / ${chipMaker}: ${eligible.join(" + ")}`);
        }
    return { violations, accepted };
  }

  it("makes no failure eligible for two reasons, so the table's order is never needed", () => {
    const { violations, accepted } = exclusivity(ROWS);
    expect(violations).toEqual([]);
    // not vacuous: every row accepts some failure
    expect([...accepted].sort()).toEqual(ROWS.map((row) => row.reason).sort());
  });

  it("finds the overlap when two rows accept one failure", () => {
    const twin: AutoRestartReason = { ...AUTO_RESTART_REASONS[0], reason: "memory_short_twin" };
    expect(exclusivity([...ROWS, twin]).violations.join("\n")).toContain("memory_limit / pc_floor");
    const greedy: AutoRestartReason = {
      ...CHIP_FAILED,
      reason: "greedy",
      trigger: () => ({ eligible: true, override: { processor: true } }),
    };
    expect(exclusivity([...ROWS, greedy]).violations.length).toBeGreaterThan(10);
  });

  it("holds a row to what it declares: nothing more, only commands the export has, and something that changes", () => {
    const stand = (
      trigger: AutoRestartReason["trigger"],
      over: Partial<AutoRestartReason> = {},
    ) => ({
      rows: [{ ...CHIP_FAILED, reason: "stand_in", trigger, ...over }],
    });
    const yes = (override: object) => () => ({ eligible: true, override }) as never;
    const chip = chipFacts();
    // more than it declared
    expect(decideRestart(chip, stand(yes({ processor: true, rung: 2 })))).toEqual(NO_ROUTE);
    expect(decideRestart(chip, stand(yes({ engine: STREAMED })))).toEqual(NO_ROUTE);
    // nothing at all, or what the failed attempt already was
    expect(decideRestart(chip, stand(yes({})))).toEqual(NO_ROUTE);
    const onProcessor = chipFacts({ attempt: { chipMaker: null, encoder: "x264-crf" } });
    expect(decideRestart(onProcessor, stand(yes({ processor: true })))).toEqual(NO_ROUTE);
    const rungRow = { override: ["rung" as const] };
    expect(decideRestart(chip, stand(yes({ rung: 0 }), rungRow))).toEqual(NO_ROUTE); // the same rung
    const gapped = chipFacts({ attempt: { ladder: [0, 2] } });
    expect(decideRestart(gapped, stand(yes({ rung: 1 }), rungRow))).toEqual(NO_ROUTE); // the same command as rung 0
    expect(decideRestart(gapped, stand(yes({ rung: 2 }), rungRow))).toMatchObject({
      restart: true,
    });
    const engineRow = { override: ["engine" as const] };
    const onStreamed = chipFacts({ attempt: { engine: STREAMED, ladder: [0] } });
    expect(decideRestart(onStreamed, stand(yes({ engine: STREAMED }), engineRow))).toEqual(
      NO_ROUTE,
    );
    expect(decideRestart(chip, stand(yes({ engine: STREAMED }), engineRow))).toMatchObject({
      restart: true,
      routeM: 10,
    });
  });

  it("answers for a row that throws, answers with nonsense, or tries to change the facts", () => {
    const stand = (trigger: unknown) => ({
      rows: [{ ...CHIP_FAILED, reason: "stand_in", trigger } as AutoRestartReason],
    });
    const chip = chipFacts();
    const copy = structuredClone(chip);
    const nonsense = [
      () => {
        throw new Error("a row with a bug");
      },
      () => undefined,
      () => null,
      () => ({}),
      () => ({ eligible: true }),
      () => ({ eligible: true, override: null }),
      () => ({ eligible: false, why: "second" }), // a refusal that is not a row's to give
      () => ({ eligible: false }),
      (facts: RestartFacts) => {
        (facts.request as { aborted: boolean }).aborted = false; // a row may not touch the facts
        return { eligible: true, override: { processor: true } };
      },
    ];
    for (const trigger of nonsense) {
      expect(() => decideRestart(chip, stand(trigger))).not.toThrow();
      expect(decideRestart(chip, stand(trigger))).toEqual(NO_ROUTE);
    }
    expect(chip).toEqual(copy);
    // a row can still refuse with any of its own four words
    for (const why of ["not_memory", "late", "no_route", "pc_short"] as const)
      expect(
        decideRestart(
          chip,
          stand(() => ({ eligible: false, why })),
        ),
      ).toEqual({
        restart: false,
        why,
      });
  });
});

describe("the local record of a decision", () => {
  it("names each way a restart ended or did not start, and nothing for a failure that was not memory", () => {
    expect([...RESTART_RECORDS].sort()).toEqual(
      [
        "eligible",
        "late",
        "second",
        "no_route",
        "pc_short",
        "flag_off",
        "no_closure",
        "refused_at_door",
        "cancelled",
        "edited",
      ].sort(),
    );
    expect(recordOf(decideRestart(facts()))).toBe("eligible");
    for (const why of ORDER)
      expect(recordOf({ restart: false, why })).toBe(why === "not_memory" ? null : why);
  });

  it("gives a word on the closed list for every decision a failure can get", () => {
    for (const why of REFUSAL_ORDER.filter((word) => word !== "not_memory"))
      expect(RESTART_RECORDS as readonly string[]).toContain(why);
    for (const over of Object.values(BREAKS)) {
      const record = recordOf(decideRestart(facts(over)));
      expect(record === null || (RESTART_RECORDS as readonly string[]).includes(record)).toBe(true);
    }
    expect(recordOf(null as never)).toBeNull();
    expect(recordOf({} as never)).toBeNull();
  });
});

function freezeDeep<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) freezeDeep(inner);
  }
  return value;
}

const mostly = (weight: number, value = true) =>
  fc.oneof(
    { weight, arbitrary: fc.constant(value) },
    { weight: 1, arbitrary: fc.constant(!value) },
  );
const maybe = (amount: fc.Arbitrary<number>) =>
  fc.oneof({ weight: 8, arbitrary: amount }, { weight: 1, arbitrary: fc.constant(null) });
// fast-check's doubles bunch up near zero over a wide range, so amounts are whole units and shares whole thousandths.
const mib = (low: number, high: number) =>
  fc.integer({ min: low, max: high }).map((count) => count * MIB);
const share = (low: number, high: number) =>
  fc.integer({ min: Math.round(low * 1000), max: Math.round(high * 1000) }).map((n) => n / 1000);

// Facts that restart often enough to be worth generating, with every kind of break among them.
const factsOver: fc.Arbitrary<Over> = fc.record({
  failure: fc.record({
    code: fc.oneof(
      { weight: 9, arbitrary: fc.constant<ExportReasonCode>("memory_limit") },
      { weight: 1, arbitrary: fc.constantFrom(...EXPORT_REASON_CODES) },
    ),
    guard: fc.oneof(
      {
        weight: 9,
        arbitrary: fc.constantFrom<ExportLimit | null>("pc_floor", "os", "resident", "commit"),
      },
      { weight: 1, arbitrary: fc.constantFrom<ExportLimit | null>(...EXPORT_LIMITS, null) },
    ),
  }),
  attempt: fc.record({
    rung: fc.constantFrom<Rung>(0, 0, 0, 1, 2),
    ladder: fc.constantFrom<readonly Rung[]>([0], [0, 1], [0, 2], [0, 1, 2], [0, 1, 2], [0, 1, 2]),
    engine: fc.constantFrom<RestartEngine>(
      "file-sequence-v1",
      "file-sequence-v1",
      "file-sequence-v1",
      "file-sequence-v1",
      STREAMED,
    ),
    chipMaker: fc.constantFrom<"amd" | null>(null, "amd"),
  }),
  progress: fc.record({
    producedFraction: fc.oneof(
      { weight: 7, arbitrary: share(0, 0.3) },
      {
        weight: 1,
        arbitrary: fc.constantFrom(FIRST_QUARTER, 0.2499999, 1, Number.NaN, -1, 7, Infinity),
      },
    ),
    expectedSeconds: maybe(fc.integer({ min: 60, max: 12_000 })),
  }),
  machine: fc.record({
    freeBytes: maybe(mib(0, 24 * 1024)),
    failedPeakBytes: maybe(mib(100, 12 * 1024)),
    limitBytes: maybe(mib(100, 12 * 1024)),
  }),
  request: fc.record({
    retryClosureExists: mostly(12),
    snapshotUnchanged: mostly(12),
    aborted: mostly(12, false),
    autoRestartsUsed: fc.constantFrom(0, 0, 0, 0, 0, 0, 0, 1, 2),
  }),
  flags: fc.record({
    auto_restart: mostly(12),
    memory_restart: mostly(12),
    restart_streamed: mostly(3),
    plan_rung: mostly(8),
    chip_restart: mostly(8),
  }),
  workload: fc.constantFrom<RestartWorkload | null>(HEAVY, HEAVY, HEAVY, LIGHT, null),
});

const routeRows: fc.Arbitrary<RouteRow> = fc.record({
  id: fc.oneof(
    { weight: 9, arbitrary: fc.constantFrom("a", "b", "c", "d") },
    { weight: 1, arbitrary: fc.constant("") },
  ),
  matches: fc.constantFrom<RouteRow["matches"]>(
    () => true,
    () => true,
    () => true,
    () => false,
    () => {
      throw new Error("a row that cannot say");
    },
  ),
  route: fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom<{ rung: Rung }>({ rung: 1 }, { rung: 2 }) },
    { weight: 2, arbitrary: fc.constant({ engine: STREAMED }) },
    { weight: 1, arbitrary: fc.constant({ rung: 0 as Rung }) },
    { weight: 1, arbitrary: fc.constant({}) },
  ),
  peakFactor: fc.oneof(
    { weight: 6, arbitrary: share(0.2, 0.95) },
    { weight: 1, arbitrary: fc.constant(undefined) },
    { weight: 1, arbitrary: share(0.95, 1.3) },
  ),
  peakMiB: fc.oneof(
    { weight: 2, arbitrary: fc.constant(undefined) },
    { weight: 1, arbitrary: fc.integer({ min: 500, max: 9000 }) },
  ),
  firstReportWaitS: fc.integer({ min: 0, max: 1000 }),
  longestGapS: fc.integer({ min: 0, max: 500 }),
  timeFactor: share(0.3, 3),
  evidence: fc.oneof(
    { weight: 9, arbitrary: fc.constant("synthetic") },
    { weight: 1, arbitrary: fc.constant("") },
  ),
  pictureCleared: fc.constantFrom<boolean | undefined>(true, true, true, false, undefined),
});
const tables = fc.array(routeRows, { maxLength: 5 });

// Each way to break exactly one condition of a restart, for each reason, and the facts with nothing broken: where a
// check that is missing shows, because nothing else stands in the way of a restart.
const ONE_BREAK: readonly RestartFacts[] = [
  facts(),
  ceilingFacts(),
  chipFacts(),
  ...ORDER.map((why) => facts(BREAKS[why])),
  ...ORDER.map((why) => ceilingFacts(BREAKS_CEILING[why])),
  ...ORDER.flatMap((why) => (BREAKS_CHIP[why] ? [chipFacts(BREAKS_CHIP[why])] : [])),
];
const scenarios: fc.Arbitrary<{ given: RestartFacts; table: readonly RouteRow[] }> = fc.oneof(
  fc.tuple(factsOver, tables).map(([over, table]) => ({ given: facts(over), table })),
  fc.constantFrom(...ONE_BREAK).map((given) => ({ given, table: TABLE })),
);

const lightness = (decision: RestartDecision): number =>
  decision.restart ? (decision.override.engine ? 3 : (decision.override.rung ?? 0)) : -1;

describe("for any facts", () => {
  it("never restarts after the quarter, with a second restart, after an edit, a cancel or without a closure or a switch", () => {
    let offered = 0;
    fc.assert(
      fc.property(scenarios, ({ given, table }) => {
        const decision = decideRestart(given, { table, rows: ROWS });
        if (!decision.restart) return;
        offered++;
        const row = ROWS.find((candidate) => candidate.reason === decision.reason)!;
        expect(given.request.autoRestartsUsed).toBe(0);
        expect(given.request.snapshotUnchanged).toBe(true);
        expect(given.request.aborted).toBe(false);
        expect(given.request.retryClosureExists).toBe(true);
        expect(given.request.flags.auto_restart).toBe(true);
        expect(given.request.flags[row.flag]).toBe(true);
        for (const key of Object.keys(decision.override))
          expect(row.override as readonly string[]).toContain(key);
        if (row.reason !== "chip_failed") {
          const produced = given.progress.producedFraction;
          expect(produced >= 0 && produced < FIRST_QUARTER, `produced ${produced}`).toBe(true);
          expect(given.failure.code).toBe("memory_limit");
        }
      }),
      { numRuns: 1500 },
    );
    expect(offered).toBeGreaterThan(60); // the property was exercised on real restarts
  });

  it("restarts exactly when the checks every reason shares all pass, on a stop that is otherwise a restart", () => {
    fc.assert(
      fc.property(factsOver, (over) => {
        const f = facts(
          merged([
            over,
            {
              failure: { code: "memory_limit", guard: "pc_floor" },
              attempt: { rung: 0, ladder: [0, 1, 2], engine: "file-sequence-v1" },
              progress: { producedFraction: 0.05 },
              machine: { freeBytes: 8 * GIB, failedPeakBytes: 1 * GIB },
              flags: { plan_rung: true },
            },
          ]),
        );
        const shared =
          f.request.flags.auto_restart &&
          f.request.flags.memory_restart &&
          !f.request.aborted &&
          f.request.autoRestartsUsed === 0 &&
          f.request.retryClosureExists &&
          f.request.snapshotUnchanged;
        expect(decideRestart(f).restart).toBe(shared);
      }),
      { numRuns: 400 },
    );
  });

  // The checks every reason shares, all passing, and the first quarter: what is left to decide is the route.
  const READY: Over = {
    request: {
      retryClosureExists: true,
      snapshotUnchanged: true,
      aborted: false,
      autoRestartsUsed: 0,
    },
    flags: { auto_restart: true, memory_restart: true },
    progress: { producedFraction: 0.1 },
  };

  it("restarts a PC-short stop exactly when the planner says a gentler rung fits, and on the rung the pre-start check keeps", () => {
    let restarted = 0;
    fc.assert(
      fc.property(factsOver, (over) => {
        const g = facts(
          merged([
            over,
            READY,
            { failure: { code: "memory_limit", guard: "pc_floor" } },
            { flags: { plan_rung: true } },
          ]),
        );
        const next = g.attempt.ladder.find((rung) => rung > g.attempt.rung);
        const plan =
          next === undefined || g.machine.freeBytes === null
            ? null
            : planRung({
                samples: [{ rung: g.attempt.rung, bytes: g.machine.failedPeakBytes }],
                freeBytes: g.machine.freeBytes,
                minRung: next,
                ladder: g.attempt.ladder,
              });
        const decision = decideRestart(g);
        expect(decision.restart).toBe(g.attempt.engine !== STREAMED && plan !== null && plan.fits);
        if (!decision.restart) return;
        restarted++;
        const rung = decision.override.rung!;
        expect(rung).toBeGreaterThan(g.attempt.rung);
        expect(g.attempt.ladder).toContain(rung);
        // the successor's own plan, on the same evidence, starts where the restart does
        const door = planRung({
          samples: [{ rung: g.attempt.rung, bytes: g.machine.failedPeakBytes }],
          freeBytes: g.machine.freeBytes,
          minRung: rung,
          ladder: g.attempt.ladder,
        });
        expect(door).toMatchObject({ fits: true, rung });
      }),
      { numRuns: 500 },
    );
    expect(restarted).toBeGreaterThan(50);
  });

  it("offers a route from the table only if it is lighter than the failed one, fits, and is not stopped or too slow", () => {
    let offered = 0;
    fc.assert(
      fc.property(factsOver, tables, (over, table) => {
        const f = facts(
          merged([over, READY, { failure: { code: "memory_limit", guard: "resident" } }]),
        );
        const decision = decideRestart(f, { table });
        if (!decision.restart) return;
        offered++;
        expect(decision.reason).toBe("memory_ceiling");
        const { override } = decision;
        const failedStep = f.attempt.engine === STREAMED ? 3 : f.attempt.rung;
        const step = override.engine ? 3 : override.rung!;
        // never the failed route, never one heavier
        expect(step).toBeGreaterThan(failedStep);
        if (step === 3) expect(f.request.flags.restart_streamed).toBe(true);
        else {
          expect(f.request.flags.plan_rung).toBe(true);
          expect(f.attempt.ladder).toContain(step);
        }
        const anchor = Math.max(f.machine.failedPeakBytes ?? 0, f.machine.limitBytes ?? 0);
        const ceiling = ceilingBytes(f.machine.freeBytes!);
        const rows = table.filter(
          (row) =>
            routeRowProblems(row).length === 0 &&
            (row.route.engine ? 3 : row.route.rung) === step &&
            (() => {
              try {
                return row.matches(f.workload!);
              } catch {
                return false;
              }
            })(),
        );
        expect(rows.length).toBeGreaterThan(0);
        let predicting = 0;
        for (const row of rows) {
          expect(row.firstReportWaitS).toBeLessThanOrEqual(MAX_FIRST_REPORT_WAIT_S);
          expect(row.longestGapS).toBeLessThanOrEqual(MAX_LONGEST_GAP_S);
          if (step === 3) expect(row.pictureCleared).toBe(true);
          const expected = f.progress.expectedSeconds;
          if (expected === null) expect(row.timeFactor).toBeLessThanOrEqual(1);
          else expect(row.timeFactor * expected).toBeLessThanOrEqual(MAX_ROUTE_SECONDS);
          for (const predicted of [
            row.peakFactor !== undefined && failedStep === 0 ? anchor * row.peakFactor : null,
            row.peakMiB !== undefined ? row.peakMiB * MIB : null,
          ])
            if (predicted !== null) {
              predicting++;
              expect(predicted).toBeLessThan(anchor); // lighter than the run that failed
              expect(predicted).toBeLessThanOrEqual(ceiling); // and it fits what is free now
            }
        }
        expect(predicting).toBeGreaterThan(0);
      }),
      { numRuns: 1500 },
    );
    expect(offered).toBeGreaterThan(20);
  });

  it("answers the same twice and leaves the facts and the table it was given alone", () => {
    fc.assert(
      fc.property(factsOver, tables, (over, table) => {
        const given = freezeDeep(facts(over));
        const options = { table: freezeDeep([...table]), rows: ROWS };
        const first = decideRestart(given, options);
        const snapshot = structuredClone(first);
        expect(eligibleReasons(given, options)).toEqual(eligibleReasons(given, options));
        // the answer is a new object each time: changing one cannot change the next
        if (first.restart) (first.override as { rung?: Rung }).rung = 2;
        expect(decideRestart(given, options)).toEqual(snapshot);
      }),
      { numRuns: 300 },
    );
  });

  it("is never lighter with more free memory: a restart offered stays offered, on the same reason and no lighter a route", () => {
    fc.assert(
      fc.property(
        factsOver,
        tables,
        fc.integer({ min: 10, max: 40 }).map((tenth) => tenth / 10),
        (over, table, more) => {
          const f = facts(over);
          const free = f.machine.freeBytes;
          if (free === null) return;
          const roomier = facts({ ...over, machine: { ...over.machine, freeBytes: free * more } });
          const options = { table, rows: ROWS };
          const before = decideRestart(f, options);
          if (!before.restart) return;
          const after = decideRestart(roomier, options);
          expect(after.restart).toBe(true);
          if (after.restart) {
            expect(after.reason).toBe(before.reason);
            expect(lightness(after)).toBeLessThanOrEqual(lightness(before));
          }
        },
      ),
      { numRuns: 800 },
    );
  });

  const leaves = (value: unknown, path: string[] = []): string[][] =>
    typeof value !== "object" || value === null || Array.isArray(value)
      ? [path]
      : [path, ...Object.entries(value).flatMap(([key, inner]) => leaves(inner, [...path, key]))];
  const everyPath = leaves(facts()).filter((path) => path.length > 0);

  it("gives an answer, never a throw, for any value at any place in the facts, and for facts that are not facts", () => {
    expect(everyPath.length).toBeGreaterThan(30);
    fc.assert(
      fc.property(fc.constantFrom(...everyPath), fc.anything(), (path, value) => {
        const given = withValue(path, value);
        expect(typeof decideRestart(given).restart).toBe("boolean");
        expect(Array.isArray(eligibleReasons(given, WITH_ALL))).toBe(true);
        expect(() => recordOf(decideRestart(given, WITH_ALL))).not.toThrow();
      }),
      { numRuns: 600 },
    );
    fc.assert(
      fc.property(fc.anything(), (nothing) => {
        expect(decideRestart(nothing as never).restart).toBe(false);
        expect(decideRestart(nothing as never, WITH_ALL).restart).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it("offers no route from rows that are not rows, whatever they are", () => {
    fc.assert(
      fc.property(fc.array(fc.anything(), { maxLength: 6 }), (table) => {
        expect(decideRestart(ceilingFacts(), { table: table as never })).toEqual(NO_ROUTE);
        expect(Array.isArray(eligibleReasons(ceilingFacts(), { table: table as never }))).toBe(
          true,
        );
      }),
      { numRuns: 200 },
    );
  });
});
