// The slow banner and a late first picture. A big project (4K, many layers, a streamed export) can spend minutes starting up before its first picture. The render's own time left and the
// share produced both count that time as time at the render's pace, which made a healthy export look several times slower than it was, and showed "This PC is slower than expected".
// These tests drive the real watch (noteHelpTick3c, at the queue's own 5 s tick) and the pure rule with series whose answer is known, and assert what a person sees.
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import late from "./__fixtures__/lateFirstPicture.json";
import { __resetFacts3c } from "./exportFacts3c";
import { exportHelp, type ActivityVerdict, type HelpInput } from "./exportHelp";
import {
  __resetHelp3c,
  helpOf3c,
  keepGoing3c,
  noteHelpTick3c,
  type HelpRecordFacts,
} from "./exportHelpWatch";
import type { EstimateBasis } from "./exportTypes3c";
import type { LiveFacts } from "./exportWords";
import { etaSeconds, progressFraction } from "./ffmpegProgress";

vi.mock("./quickAvailable", () => ({ quickAvailable: vi.fn(() => false) }));

const START = 1_700_000_000_000;
const JOB = "job-late";
const TICK = 5;
/** Seconds an export spends preparing before the render process starts. */
const PREP = 5;
/** The owner's numbers, written here and not read from the module: a rule that is changed is changed on purpose. */
const SLOW_AFTER_SECONDS = 90;
const BANNER_LATEST_SECONDS = 180;

type Engine = "one-pass" | "streamed";
const ENGINES: Engine[] = ["one-pass", "streamed"];
const BASES: EstimateBasis[] = ["history", "pc_check"];

const record = (seconds: number, basis: EstimateBasis = "history"): HelpRecordFacts => ({
  estimate: { seconds, basis },
  canRetry: true,
});

/** What the card holds `t` seconds in, for a run that has made `share` of the project (0: no picture yet), as each engine reports it. A one-pass render's own time left is ffmpeg's: what is left
 *  at the speed since the process started, so the start-up counts as time at the pace. A streamed export has none, and its bar is scaled over twice the project. */
function feedOf(
  engine: Engine,
  t: number,
  share: number,
  moveAt: number,
  processStart: number,
  busy: boolean | null = true,
): LiveFacts {
  const rendering = share > 0;
  return {
    stage: rendering ? "rendering" : "preparing",
    startedAt: START,
    fraction: rendering ? (engine === "streamed" ? share / 2 : share) : null,
    etaSec: rendering ? ((1 - share) / share) * Math.max(1, t - processStart) : null,
    step: engine === "streamed" ? 0 : null,
    steps: engine === "streamed" ? 3 : null,
    lastMoveAt: START + moveAt * 1000,
    busy,
  };
}

interface Seen {
  /** The first tick (seconds since the start) at which a slow banner was up, and the first at which any banner was. */
  slowAt: number | null;
  anyAt: number | null;
  /** The projection the first slow banner reported. */
  projected: number | null;
}
const nothingSeen = (): Seen => ({ slowAt: null, anyAt: null, projected: null });

function look(seen: Seen, t: number): void {
  const view = helpOf3c(JOB)?.view;
  if (!view || view.kind === "none") return;
  seen.anyAt ??= t;
  if (view.kind === "slow") {
    seen.slowAt ??= t;
    seen.projected ??= view.projectedTotalSeconds;
  }
}

/** A run that starts up for `d` seconds with nothing produced and then makes the project at one steady rate, so that the whole export takes `total` seconds. */
const shareAt = (t: number, d: number, total: number): number =>
  t <= d ? 0 : Math.min(1, (t - d) / (total - d));

function playSteady(
  engine: Engine,
  d: number,
  total: number,
  estimate: number,
  basis: EstimateBasis = "history",
): Seen {
  __resetHelp3c();
  const seen = nothingSeen();
  for (let t = TICK; t < total; t += TICK) {
    const share = shareAt(t, d, total);
    const feed = feedOf(engine, t, share, share > 0 ? t : 0, Math.min(PREP, d));
    noteHelpTick3c(JOB, { record: record(estimate, basis), feed }, START + t * 1000);
    look(seen, t);
  }
  return seen;
}

beforeEach(() => {
  __resetHelp3c();
  __resetFacts3c();
  __resetExportFlags();
});
afterEach(() => {
  __resetHelp3c();
  __resetFacts3c();
  __resetExportFlags();
});

describe("a late first picture alone never makes a banner", () => {
  const healthy = fc.record({
    d: fc.integer({ min: 0, max: 600 }),
    body: fc.integer({ min: 60, max: 3000 }),
    ratio: fc.oneof(fc.constant(1), fc.double({ min: 0.5, max: 2, noNaN: true })),
    engine: fc.constantFrom(...ENGINES),
    basis: fc.constantFrom(...BASES),
  });

  it("for a start-up of any length from 0 to 600 s followed by a steady rate that makes the whole export what was said (or up to twice that), on either engine", () => {
    fc.assert(
      fc.property(healthy, ({ d, body, ratio, engine, basis }) => {
        const total = d + body;
        const seen = playSteady(engine, d, total, total / ratio, basis);
        expect(seen.anyAt).toBeNull();
      }),
      { numRuns: 200 },
    );
  }, 120_000);

  it("and the longest start-up the first property allows, with the estimate exactly right, is quiet on both engines", () => {
    for (const engine of ENGINES)
      for (const basis of BASES)
        expect(playSteady(engine, 600, 900, 900, basis).anyAt, `${engine} ${basis}`).toBeNull();
  });
});

interface FixtureRun {
  id: string;
  kind: "recorded" | "modelled";
  frames: number;
  totalMs: number;
  firstPictureWallS: number;
  endWallS: number;
  blocks: Array<[number, number, number]>;
}
const RUNS = late.runs as unknown as FixtureRun[];

interface RunSeen extends Seen {
  /** The first tick at which the projection as it was read from the start (the old reading) was over three times the estimate with the project 2 % made and 90 s gone. */
  overFromStartAt: number | null;
}

/** One of the three real runs through the watch: the same series the replay harness drives, 5 s after the export's start, at the queue's tick. */
function playRun(
  run: FixtureRun,
  engine: Engine,
  estimate: number,
  basis: EstimateBasis = "history",
): RunSeen {
  __resetHelp3c();
  const seen: RunSeen = { ...nothingSeen(), overFromStartAt: null };
  const moveWall: number[] = [];
  let last = 0;
  let move = 0;
  for (const [wall, outMs] of run.blocks) {
    if (outMs > last) move = wall;
    last = Math.max(last, outMs);
    moveWall.push(move);
  }
  const end = run.endWallS + late.prepSeconds;
  let i = -1;
  for (let t = TICK; t <= end + 1e-9; t += TICK) {
    while (i + 1 < run.blocks.length && run.blocks[i + 1][0] + late.prepSeconds <= t + 1e-9) i++;
    const block = i >= 0 ? run.blocks[i] : null;
    const share = block ? progressFraction(block[1], run.totalMs) : 0;
    const eta = block ? etaSeconds(block[1], run.totalMs, block[2]) : null;
    const feed: LiveFacts = {
      ...feedOf(engine, t, share, 0, PREP),
      etaSec: eta,
      lastMoveAt: START + (block ? moveWall[i] + late.prepSeconds : 0) * 1000,
    };
    const fromStart =
      engine === "streamed" || eta === null ? (share > 0 ? t / share : null) : t + eta;
    if (fromStart !== null && t >= SLOW_AFTER_SECONDS && share >= 0.02 && fromStart > 3 * estimate)
      seen.overFromStartAt ??= t;
    noteHelpTick3c(JOB, { record: record(estimate, basis), feed }, START + t * 1000);
    look(seen, t);
  }
  return seen;
}

describe("the three real runs whose first picture came late (two recorded, one modelled from recorded pacing)", () => {
  const totalOf = (run: FixtureRun) => Math.round(run.endWallS + late.prepSeconds);

  it("has three runs whose first picture came after 100 s, and whose old reading was over three times an estimate that was exactly right", () => {
    expect(RUNS.map((r) => r.id)).toHaveLength(3);
    for (const run of RUNS)
      for (const engine of ENGINES) {
        expect(run.firstPictureWallS, run.id).toBeGreaterThan(100);
        expect(
          playRun(run, engine, totalOf(run)).overFromStartAt,
          `${run.id} ${engine}`,
        ).not.toBeNull();
      }
  });

  it("shows no banner of either kind when the estimate was right, on either engine and with either kind of estimate", () => {
    // Only the exact estimate: these recorded shapes are bursty (smoke2 makes 14 % in ten seconds, then nothing for fifty), so an estimate that is 1.5 times short is a different question that the replay of 103 runs answers.
    for (const run of RUNS)
      for (const engine of ENGINES)
        for (const basis of BASES)
          expect(
            playRun(run, engine, totalOf(run), basis).anyAt,
            `${run.id} ${engine} ${basis}`,
          ).toBeNull();
  });

  it("still shows a slow banner, before the export ends, when the same run really is 3.5 times slower than said", () => {
    for (const run of RUNS)
      for (const engine of ENGINES) {
        const seen = playRun(run, engine, totalOf(run) / 3.5);
        expect(seen.slowAt, `${run.id} ${engine}`).not.toBeNull();
        expect(seen.slowAt!, `${run.id} ${engine}`).toBeLessThan(totalOf(run));
        expect(seen.slowAt!, `${run.id} ${engine}`).toBeGreaterThanOrEqual(SLOW_AFTER_SECONDS);
      }
  });
});

describe("a slow export still gets its banner", () => {
  const slow = fc.record({
    d: fc.integer({ min: 0, max: 60 }),
    estimate: fc.integer({ min: 60, max: 1100 }),
    engine: fc.constantFrom(...ENGINES),
    basis: fc.constantFrom(...BASES),
  });

  it("between 90 s and 180 s in, for a steady rate that makes it 3.5 times the estimate, whatever delay up to a minute came before the first picture", () => {
    fc.assert(
      fc.property(slow, ({ d, estimate, engine, basis }) => {
        const seen = playSteady(engine, d, 3.5 * estimate, estimate, basis);
        expect(seen.slowAt).not.toBeNull();
        expect(seen.slowAt!).toBeGreaterThanOrEqual(SLOW_AFTER_SECONDS);
        expect(seen.slowAt!).toBeLessThanOrEqual(BANNER_LATEST_SECONDS);
      }),
      { numRuns: 150 },
    );
  }, 120_000);

  it("and the length it reports is the run's real length, whatever delay came before the first picture: it is not read from a minute of start-up", () => {
    fc.assert(
      fc.property(
        fc.record({
          d: fc.integer({ min: 6, max: 60 }),
          estimate: fc.integer({ min: 60, max: 1100 }),
          engine: fc.constantFrom(...ENGINES),
        }),
        ({ d, estimate, engine }) => {
          const total = 3.5 * estimate;
          const seen = playSteady(engine, d, total, estimate);
          expect(seen.projected).not.toBeNull();
          expect(Math.abs(seen.projected! - total)).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 150 },
    );
  }, 120_000);

  it("when a run that started well slows down six times part-way through (the opposite order: a good start, then the slow part), the banner comes", () => {
    for (const engine of ENGINES) {
      __resetHelp3c();
      const seen = nothingSeen();
      const estimate = 600;
      let share = 0;
      for (let t = TICK; t < 4000; t += TICK) {
        if (t > 10) share = Math.min(0.999, share + TICK / estimate / (t > 150 ? 6 : 1));
        const feed = feedOf(engine, t, share, share > 0 ? t : 0, PREP);
        noteHelpTick3c(JOB, { record: record(estimate), feed }, START + t * 1000);
        look(seen, t);
      }
      expect(seen.slowAt, engine).not.toBeNull();
      expect(seen.slowAt!, engine).toBeLessThan(1500);
    }
  });

  it("Keep going silences it as before, on a run that started up late, and it does not come back while the run goes on at the same pace", () => {
    for (const engine of ENGINES) {
      __resetHelp3c();
      const d = 60;
      const total = 700;
      let kept = false;
      let banners = 0;
      for (let t = TICK; t < total; t += TICK) {
        const share = shareAt(t, d, total);
        noteHelpTick3c(
          JOB,
          { record: record(200), feed: feedOf(engine, t, share, share > 0 ? t : 0, PREP) },
          START + t * 1000,
        );
        if (helpOf3c(JOB)?.view.kind === "slow") {
          banners++;
          if (!kept) {
            expect(keepGoing3c(JOB, "slow", "rendering")).toEqual({ ok: true });
            kept = true;
          }
        }
      }
      expect(kept, engine).toBe(true);
      expect(banners, engine).toBe(1);
    }
  });
});

describe("the stopped-moving rule is untouched", () => {
  it("shows it at the same tick and with the same words after a late first picture, with the processors idle", () => {
    const seen: Array<{ t: number; kind: string; lines: string[] }> = [];
    __resetHelp3c();
    // the first picture at 100 s, steady until 145 s, then nothing moves
    for (let t = TICK; t <= 215; t += TICK) {
      const moving = Math.min(t, 145);
      const share = moving > 100 ? (moving - 100) / 900 : 0;
      noteHelpTick3c(
        JOB,
        {
          record: record(2000),
          feed: feedOf("one-pass", t, share, share > 0 ? moving : 0, PREP, t <= 145),
        },
        START + t * 1000,
      );
      const view = helpOf3c(JOB)!.view;
      seen.push({ t, kind: view.kind, lines: view.lines });
    }
    const firstQuiet = seen.find((s) => s.kind === "quiet");
    expect(firstQuiet?.t).toBe(205);
    expect(firstQuiet?.lines.slice(0, 2)).toEqual([
      "This export has stopped moving",
      "No progress for 60 s.",
    ]);
    expect(seen.filter((s) => s.kind === "slow")).toEqual([]);
  });

  const quietInputs = fc.record({
    elapsedSeconds: fc.double({ min: 0, max: 1500, noNaN: true }),
    producedFraction: fc.double({ min: 0, max: 0.999, noNaN: true }),
    renderEtaSeconds: fc.option(fc.double({ min: 0, max: 20_000, noNaN: true }), { nil: null }),
    expectedSeconds: fc.option(fc.double({ min: 5, max: 4000, noNaN: true }), { nil: null }),
    expectedBasis: fc.constantFrom<EstimateBasis | null>("history", "pc_check", "guess", null),
    quickSeconds: fc.option(fc.double({ min: 1, max: 3000, noNaN: true }), { nil: null }),
    quietSeconds: fc.double({ min: 60, max: 600, noNaN: true }),
    verdict: fc.constantFrom<ActivityVerdict>("busy", "idle", "unknown"),
    canSwitch: fc.boolean(),
    shown: fc.record({
      slowShown: fc.integer({ min: 0, max: 2 }),
      silencedAtProjection: fc.option(fc.double({ min: 10, max: 5000, noNaN: true }), {
        nil: null,
      }),
      quietShown: fc.boolean(),
    }),
    flagOn: fc.constant(true),
  });
  const pictures = fc.record({
    atSeconds: fc.double({ min: 0, max: 1500, noNaN: true }),
    produced: fc.double({ min: 0.0001, max: 1, noNaN: true }),
  });

  it("gives the same answer with or without a first picture, whatever the facts, once the render has been quiet for 60 s", () => {
    fc.assert(
      fc.property(quietInputs, pictures, (input, firstPicture) => {
        expect(exportHelp({ ...input, firstPicture })).toEqual(exportHelp(input));
      }),
      { numRuns: 500 },
    );
  });
});

describe("what the first picture can and cannot do to the old reading", () => {
  const inputs = fc.record({
    elapsedSeconds: fc.double({ min: 0, max: 1500, noNaN: true }),
    producedFraction: fc.double({ min: 0, max: 0.999, noNaN: true }),
    renderEtaSeconds: fc.option(fc.double({ min: 0, max: 20_000, noNaN: true }), { nil: null }),
    expectedSeconds: fc.option(fc.double({ min: 5, max: 4000, noNaN: true }), { nil: null }),
    expectedBasis: fc.constantFrom<EstimateBasis | null>("history", "pc_check", "guess", null),
    quickSeconds: fc.option(fc.double({ min: 1, max: 3000, noNaN: true }), { nil: null }),
    quietSeconds: fc.double({ min: 0, max: 600, noNaN: true }),
    verdict: fc.constantFrom<ActivityVerdict>("busy", "idle", "unknown"),
    canSwitch: fc.boolean(),
    shown: fc.record({
      slowShown: fc.integer({ min: 0, max: 2 }),
      silencedAtProjection: fc.option(fc.double({ min: 10, max: 5000, noNaN: true }), {
        nil: null,
      }),
      quietShown: fc.boolean(),
    }),
    flagOn: fc.constant(true),
  });
  const pictures = fc.record({
    atSeconds: fc.double({ min: 0, max: 1500, noNaN: true }),
    produced: fc.double({ min: 0.0001, max: 1, noNaN: true }),
  });

  it("never adds a slow banner the old reading would not have shown, and never a longer projection (any facts, any first picture)", () => {
    fc.assert(
      fc.property(inputs, pictures, (input, firstPicture) => {
        const before = exportHelp(input);
        const after = exportHelp({ ...input, firstPicture });
        if (after.kind === "slow") {
          expect(before.kind).toBe("slow");
          expect(after.projectedTotalSeconds!).toBeLessThanOrEqual(before.projectedTotalSeconds!);
        }
        if (before.kind !== "slow")
          expect(after.kind).toBe(before.kind === "quiet" ? "quiet" : "none");
      }),
      { numRuns: 1000 },
    );
  });

  it("reads a first picture that cannot be read as no first picture at all, and never throws", () => {
    const garbage: unknown[] = [
      null,
      undefined,
      "late",
      42,
      [],
      {},
      { atSeconds: Number.NaN, produced: 0.1 },
      { atSeconds: -5, produced: 0.1 },
      { atSeconds: 10, produced: 0 },
      { atSeconds: 10, produced: 1.5 },
      { atSeconds: 10, produced: Number.NaN },
      { atSeconds: "10", produced: "0.1" },
      { atSeconds: Number.POSITIVE_INFINITY, produced: 0.1 },
    ];
    fc.assert(
      fc.property(inputs, fc.constantFrom(...garbage), (input, firstPicture) => {
        expect(exportHelp({ ...input, firstPicture } as HelpInput)).toEqual(exportHelp(input));
      }),
      { numRuns: 400 },
    );
  });

  it("shows nothing at all for a first picture that is under 30 s old or from which the share has not moved, whatever the old reading says", () => {
    const base: HelpInput = {
      elapsedSeconds: 600,
      producedFraction: 0.15,
      renderEtaSeconds: 3360,
      expectedSeconds: 1260,
      expectedBasis: "pc_check",
      quickSeconds: 540,
      quietSeconds: 0,
      verdict: "busy",
      canSwitch: true,
      shown: { slowShown: 0, silencedAtProjection: null, quietShown: false },
      flagOn: true,
    };
    expect(exportHelp(base).kind).toBe("slow");
    // the first picture 20 s ago: not yet a pace
    expect(exportHelp({ ...base, firstPicture: { atSeconds: 580, produced: 0.1 } }).kind).toBe(
      "none",
    );
    // the share has not moved since the first picture
    expect(exportHelp({ ...base, firstPicture: { atSeconds: 100, produced: 0.15 } }).kind).toBe(
      "none",
    );
    // the clock went back: the first picture is in the future
    expect(exportHelp({ ...base, firstPicture: { atSeconds: 700, produced: 0.1 } }).kind).toBe(
      "none",
    );
  });
});

describe("the watch's record of the first picture", () => {
  /** One run's ticks: `shareOf(t)` is what the card holds at t (null: a sample that cannot be read). */
  function drive(
    shareOf: (t: number) => number | null,
    estimate: number,
    to: number,
    startedAt: number = START,
    from: number = TICK,
  ): Seen {
    const seen = nothingSeen();
    for (let t = from; t <= to; t += TICK) {
      const share = shareOf(t);
      const feed: LiveFacts = {
        ...feedOf("streamed", t, share ?? 0, share ? t : 0, PREP),
        startedAt,
        fraction: share === null ? null : share / 2,
        stage: share ? "rendering" : "preparing",
      };
      noteHelpTick3c(JOB, { record: record(estimate), feed }, startedAt + t * 1000);
      look(seen, t);
    }
    return seen;
  }
  /** A healthy run: nothing for 100 s, then a steady rate that makes the whole export 400 s (the estimate). */
  const healthy = (t: number) => shareAt(t, 100, 400);

  it("is made again for a restart of the same export (no end in between, a later start): the second late first picture is no banner either", () => {
    expect(drive(healthy, 400, 395).anyAt).toBeNull();
    // the same job id starts again later, from nothing, and starts up late again
    const second = drive(healthy, 400, 395, START + 10_000_000);
    expect(second.anyAt).toBeNull();
  });

  it("keeps no banner on a healthy run through samples that cannot be read, a zero, or a share that falls back", () => {
    const rough = (t: number) => {
      if (t === 130 || t === 160) return null;
      if (t === 170) return 0;
      if (t === 200) return 0.05;
      return healthy(t);
    };
    const seen = drive(rough, 400, 395);
    expect(seen.slowAt).toBeNull();
  });

  it("counts from the start when the watch first looks at a run that already has a picture (it came late), as it always did", () => {
    __resetHelp3c();
    const feed = feedOf("one-pass", 100, 0.5, 100, PREP);
    noteHelpTick3c(JOB, { record: record(100), feed: { ...feed, etaSec: 5000 } }, START + 100_000);
    expect(helpOf3c(JOB)!.view.projectedTotalSeconds).toBe(5100);
  });

  it("is kept whether the switch is on or off, so that turning it on brings the banner back with the same projection; off, it says nothing at all", () => {
    __resetHelp3c();
    const d = 60;
    const total = 700;
    const projectedAt: Array<number | null> = [];
    for (let t = TICK; t < total; t += TICK) {
      __setExportFlag("export_help", t >= 150);
      const share = shareAt(t, d, total);
      noteHelpTick3c(
        JOB,
        { record: record(200), feed: feedOf("streamed", t, share, share > 0 ? t : 0, PREP) },
        START + t * 1000,
      );
      const state = helpOf3c(JOB)!;
      if (t < 150) expect(state.view.kind, `off at ${t}`).toBe("none");
      if (t === 150) projectedAt.push(state.view.projectedTotalSeconds);
    }
    expect(projectedAt[0]).toBe(total);
  });
});
