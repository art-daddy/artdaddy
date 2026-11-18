import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { liveFeedOf, useExportJob } from "./exportJob";
import { COST_FEATURES } from "../timeline/costShape";
import { ENCODER_IDS } from "../timeline/exportEncoder";
import { EXPORT_SPEED_REVISION, type ExportCalibration } from "../timeline/exportOptions";
import { NO_TIME_LEFT, startPace, type TimeLeft } from "../timeline/exportTimeLeft";
import { describeDialogProgress, describeLiveStatus, quietSeconds } from "../timeline/exportWords";
import { playSteady, steadyReports, type SteadyReport } from "../test/steadyFeed";

const sample: ExportCalibration = {
  workload: {
    width: 1920,
    height: 1080,
    fps: 30,
    durationSeconds: 10,
    visualClips: 14,
    captionClips: 2,
    audioClips: 1,
    peakVisualLayers: 8,
    peakMediaLayers: 7,
  },
  output: { width: 1920, height: 1080, fps: 30 },
  quality: "medium",
  engine: "partition-pipes-v1",
  revision: EXPORT_SPEED_REVISION,
  elapsedSeconds: 16,
  finalBytes: 2_400_000,
  memoryBytes: null,
  temporaryBytes: null,
};

beforeEach(() => {
  useExportJob.setState({ calibrations: [] });
});

describe("local export calibration records", () => {
  it("bounds successful measurements without discarding unknown resource values", () => {
    for (let index = 0; index < 40; index++)
      useExportJob.getState().rememberCalibration({ ...sample, elapsedSeconds: index + 1 });
    expect(useExportJob.getState().calibrations).toHaveLength(24);
    expect(useExportJob.getState().calibrations[23]).toMatchObject({
      elapsedSeconds: 40,
      memoryBytes: null,
      temporaryBytes: null,
    });
  });

  it("rejects unusable observations rather than giving them zero-cost estimates", () => {
    for (const invalid of [
      { elapsedSeconds: NaN },
      { elapsedSeconds: 0 },
      { finalBytes: -1 },
      { quality: "unknown" },
    ])
      useExportJob.getState().rememberCalibration({ ...sample, ...invalid });
    useExportJob
      .getState()
      .rememberCalibration(JSON.parse(JSON.stringify({ ...sample, encoder: "unqualified" })));
    expect(useExportJob.getState().calibrations).toEqual([]);
  });

  it("keeps explicit encoder observations separate", () => {
    useExportJob.getState().rememberCalibration(sample);
    useExportJob.getState().rememberCalibration({ ...sample, encoder: "chip-amd" });
    expect(useExportJob.getState().calibrations.map((entry) => entry.encoder)).toEqual([
      "x264-crf",
      "chip-amd",
    ]);
  });

  // The fault that lost a gentle run's rung (S3): a field the store did not know about was dropped without a word, and
  // nothing failed. Every way an export can be encoded must survive the store, or a chip's measurements would be
  // remembered as the processor's and the estimates of both would be wrong.
  it("remembers a measurement under the encoder it was made with, for every encoder there is", () => {
    for (const encoder of ENCODER_IDS) {
      useExportJob.setState({ calibrations: [] });
      useExportJob.getState().rememberCalibration({ ...sample, encoder });
      expect(useExportJob.getState().calibrations, encoder).toEqual([
        expect.objectContaining({ encoder }),
      ]);
    }
  });

  it("reads back what it saved, encoder included, in the next session", async () => {
    localStorage.clear();
    for (const encoder of ENCODER_IDS)
      useExportJob.getState().rememberCalibration({ ...sample, encoder, elapsedSeconds: 7 });
    vi.resetModules();
    const reopened = (await import("./exportJob")).useExportJob;
    expect(reopened.getState().calibrations.map((entry) => entry.encoder)).toEqual([
      ...ENCODER_IDS,
    ]);
  });

  it("drops private fields while preserving valid numeric measurements", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const secret = `private:${text}`;
        useExportJob.getState().rememberCalibration({
          ...sample,
          ...{ filename: secret, project_id: secret, error: secret },
          workload: { ...sample.workload, ...{ content: secret } },
        });
        const kept = useExportJob.getState().calibrations.at(-1)!;
        expect(kept.elapsedSeconds).toBe(16);
        expect(JSON.stringify(kept)).not.toContain(secret);
        expect(kept.memoryBytes).toBeNull();
      }),
      { numRuns: 40 },
    );
  });

  it("keeps the speed revision a measurement was made under and omits a malformed one", () => {
    useExportJob.getState().rememberCalibration({ ...sample, revision: 7 });
    for (const revision of [-1, NaN, Infinity, "1", null, {}])
      useExportJob
        .getState()
        .rememberCalibration(JSON.parse(JSON.stringify({ ...sample, revision })));
    const [made, ...malformed] = useExportJob.getState().calibrations;
    expect(made.revision).toBe(7);
    expect(malformed).toHaveLength(6);
    for (const entry of malformed) expect(entry.revision).toBeUndefined();
  });

  it("saves history under a name that does not change with the app version", () => {
    localStorage.clear();
    useExportJob.getState().rememberCalibration(sample);
    const keys = Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.key(index)!,
    );
    const history = keys.filter((key) => key.includes("calibration"));
    expect(history).toHaveLength(1);
    expect(history[0]).not.toContain(__ARTDADDY_RELEASE__);
  });

  it("starts a new session from what the last one measured", async () => {
    localStorage.clear();
    useExportJob.getState().rememberCalibration({ ...sample, elapsedSeconds: 33 });
    vi.resetModules();
    const reopened = (await import("./exportJob")).useExportJob;
    expect(reopened.getState().calibrations).toEqual([
      expect.objectContaining({ elapsedSeconds: 33, revision: EXPORT_SPEED_REVISION }),
    ]);
  });

  // The field of a journey replay: a gentle export's peak was remembered as a NORMAL export's, so the next
  // export of the same shape on the same tight PC was planned at the normal rung and failed again.
  it("keeps the rung a measurement was made at, in this session and in the next", async () => {
    localStorage.clear();
    useExportJob.getState().rememberCalibration({ ...sample, memoryBytes: 9e8, rung: 1 });
    useExportJob.getState().rememberCalibration({ ...sample, memoryBytes: 8e8, rung: 2 });
    useExportJob.getState().rememberCalibration({ ...sample, memoryBytes: 3.5e9 });
    expect(useExportJob.getState().calibrations.map((entry) => entry.rung)).toEqual([
      1,
      2,
      undefined,
    ]);
    vi.resetModules();
    const reopened = (await import("./exportJob")).useExportJob;
    expect(
      reopened.getState().calibrations.map((entry) => [entry.rung, entry.memoryBytes]),
    ).toEqual([
      [1, 9e8],
      [2, 8e8],
      [undefined, 3.5e9],
    ]);
  });

  it("reads a rung that is not 1 or 2 as the normal rung, so a damaged copy never claims a gentler setting", () => {
    for (const rung of [0, 3, -1, 1.5, NaN, "1", null, {}])
      useExportJob.getState().rememberCalibration(JSON.parse(JSON.stringify({ ...sample, rung })));
    const kept = useExportJob.getState().calibrations;
    expect(kept).toHaveLength(8);
    for (const entry of kept) expect(entry.rung).toBeUndefined();
  });

  it("remembers every field a measurement carries: one that is added to the type and not here is caught", () => {
    // Built from the type itself, so a field added to ExportCalibration stops this from compiling until it
    // is given a value, and then fails here until the store keeps it.
    const everything: Required<ExportCalibration> = {
      ...sample,
      encoder: "x264-crf",
      rung: 2,
      revision: 3,
      cost: { crossfade: { frames: 90, windowFrames: 30, mp: 2.07 } },
    };
    useExportJob.getState().rememberCalibration(everything);
    const stored = useExportJob.getState().calibrations.at(-1)!;
    expect(Object.keys(stored).sort()).toEqual(Object.keys(everything).sort());
    expect(stored).toEqual(everything);
  });
});

// A history record may carry a compact summary of the project it measured: its features by the frames they ran on. Nothing reads it yet, so
// what matters is that it is never believed when it is damaged, never makes a record vanish, and never changes a record that has none.
describe("the cost summary a history record may carry", () => {
  const cost = {
    crossfade: { frames: 90, windowFrames: 30, mp: 2.07 },
    grain: { frames: 300, windowFrames: 300, mp: 2.07 },
  };
  const savedKey = () =>
    Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!).find(
      (key) => key.includes("calibration"),
    )!;
  const load = (frames: number, windowFrames: number, mp: number) => ({ frames, windowFrames, mp });
  // Every way a summary can be damaged: not an object, a feature nobody prices, a number that is not one, a window longer than its frames.
  const damaged: Array<[string, unknown]> = [
    ["null", null],
    ["a string", "crossfade"],
    ["a number", 5],
    ["a list", [load(1, 1, 1)]],
    ["a feature nobody prices", { ...cost, hologram: load(1, 1, 1) }],
    ["a feature that is not an object", { crossfade: 5 }],
    ["a feature that is null", { crossfade: null }],
    ["negative frames", { crossfade: load(-1, 0, 1) }],
    ["frames that are not a number", { crossfade: load(Number.NaN, 0, 1) }],
    ["a window longer than its frames", { crossfade: load(10, 20, 1) }],
    ["a missing window", { crossfade: { frames: 10, mp: 1 } }],
    ["a size that is not a number", { crossfade: { frames: 10, windowFrames: 5, mp: "big" } }],
    ["a size that is absurd", { crossfade: load(10, 5, 1e300) }],
    ["one good feature beside a damaged one", { ...cost, fade: load(5, 9, 1) }],
  ];

  it("keeps a summary in this session and in the next, and gives a record without one none", async () => {
    localStorage.clear();
    useExportJob.getState().rememberCalibration({ ...sample, cost });
    useExportJob.getState().rememberCalibration(sample);
    expect(useExportJob.getState().calibrations.map((entry) => entry.cost)).toEqual([
      cost,
      undefined,
    ]);
    const saved = JSON.parse(localStorage.getItem(savedKey())!);
    expect(saved[0].cost).toEqual(cost);
    expect("cost" in saved[1]).toBe(false);
    vi.resetModules();
    const reopened = (await import("./exportJob")).useExportJob;
    expect(reopened.getState().calibrations.map((entry) => entry.cost)).toEqual([cost, undefined]);
  });

  it("reads a record saved before there were summaries exactly as it was read, with none", async () => {
    localStorage.clear();
    const old = {
      workload: sample.workload,
      output: sample.output,
      quality: "medium",
      engine: "partition-pipes-v1",
      encoder: "x264-crf",
      revision: EXPORT_SPEED_REVISION,
      rung: 1,
      elapsedSeconds: 16,
      finalBytes: 2_400_000,
      memoryBytes: 9e8,
      temporaryBytes: null,
    };
    localStorage.setItem("artdaddy-export-calibration-v4", JSON.stringify([old]));
    vi.resetModules();
    const reopened = (await import("./exportJob")).useExportJob;
    expect(reopened.getState().calibrations).toEqual([old]);
    expect("cost" in reopened.getState().calibrations[0]).toBe(false);
  });

  it.each(damaged)(
    "drops a damaged summary (%s) and keeps the measurement, when it is remembered and when it is read back",
    async (_name, junk) => {
      localStorage.clear();
      // an encoder that is not named is the processor's normal one: what the store has always made of such a record
      const measured = { ...sample, encoder: "x264-crf" };
      expect(() =>
        useExportJob
          .getState()
          .rememberCalibration(JSON.parse(JSON.stringify({ ...sample, cost: junk ?? null }))),
      ).not.toThrow();
      expect(useExportJob.getState().calibrations).toEqual([measured]);
      // the same record, damaged in the saved copy: read at the next start
      localStorage.setItem(
        "artdaddy-export-calibration-v4",
        JSON.stringify([JSON.parse(JSON.stringify({ ...sample, cost: junk ?? null }))]),
      );
      vi.resetModules();
      const reopened = (await import("./exportJob")).useExportJob;
      expect(reopened.getState().calibrations).toEqual([measured]);
    },
  );

  it("keeps every summary that is whole and drops every one that is not, whatever it holds (property)", () => {
    const loadArb = fc
      .tuple(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.double({ min: 0, max: 200, noNaN: true }),
      )
      .map(([a, b, mp]) => load(Math.max(a, b), Math.min(a, b), mp));
    fc.assert(
      fc.property(fc.dictionary(fc.constantFrom(...COST_FEATURES), loadArb), (whole) => {
        useExportJob.setState({ calibrations: [] });
        useExportJob.getState().rememberCalibration({ ...sample, cost: whole });
        expect(useExportJob.getState().calibrations.at(-1)?.cost).toEqual(whole);
      }),
      { numRuns: 80 },
    );
    fc.assert(
      fc.property(fc.jsonValue(), (junk) => {
        useExportJob.setState({ calibrations: [] });
        useExportJob.getState().rememberCalibration({ ...sample, cost: junk } as never);
        const kept = useExportJob.getState().calibrations.at(-1)!;
        expect(kept.elapsedSeconds).toBe(16);
        for (const [feature, entry] of Object.entries(kept.cost ?? {})) {
          expect(COST_FEATURES as readonly string[]).toContain(feature);
          expect(entry.windowFrames).toBeLessThanOrEqual(entry.frames);
          for (const value of Object.values(entry)) expect(value).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("lets nothing a summary says in words into what is saved", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (text) => {
        const secret = `private:${text}`;
        useExportJob.setState({ calibrations: [] });
        useExportJob.getState().rememberCalibration({
          ...sample,
          cost: {
            ...cost,
            crossfade: { ...cost.crossfade, ...{ note: secret } },
            ...{ [secret]: load(1, 1, 1) },
          },
        } as never);
        expect(JSON.stringify(useExportJob.getState().calibrations)).not.toContain(secret);
      }),
      { numRuns: 40 },
    );
  });
});

// The feed of the export that is running, for the chat card. The job above belongs to the Export
// dialog: only the menu begins it, so an export an assistant started never moved it. This feed belongs
// to the queue instead, begun when an export's turn comes, for ANY export.
describe("the live feed of the running export", () => {
  beforeEach(() => {
    useExportJob.getState().reset();
    useExportJob.setState({ live: null, finishing: {} });
    vi.useFakeTimers({ now: 1_000_000 });
  });
  afterEach(() => vi.useRealTimers());
  const live = () => useExportJob.getState().live;
  const at = (ms: number) => vi.setSystemTime(1_000_000 + ms);

  it("takes progress from an export the menu did not start, and leaves the dialog's own job alone", () => {
    const store = useExportJob.getState();
    store.beginLive("j1");
    store.update({ phase: "rendering", fraction: 0.3, etaSec: 90, speed: 1.2, frame: 300 });
    expect(live()).toMatchObject({
      jobId: "j1",
      stage: "preparing",
      fraction: 0.3,
      etaSec: 90,
      speed: 1.2,
      frame: 300,
    });
    // No job was begun by the menu: the dialog's own state does not move (it never did for these).
    expect(useExportJob.getState().phase).toBe("idle");
    expect(useExportJob.getState().fraction).toBeNull();
  });

  it("still moves the dialog's job as before when the menu started it", () => {
    const store = useExportJob.getState();
    store.begin(null);
    store.beginLive("j1");
    store.update({ phase: "rendering", fraction: 0.5, etaSec: 10, speed: 2, frame: 50 });
    expect(useExportJob.getState()).toMatchObject({ phase: "rendering", fraction: 0.5 });
    expect(live()).toMatchObject({ fraction: 0.5 });
  });

  it("does nothing for progress that arrives when no export is live", () => {
    useExportJob.getState().update({ fraction: 0.9, frame: 9 });
    expect(live()).toBeNull();
  });

  it("counts a change in the frame, the position or the part as movement, and a repeated block as none", () => {
    const store = useExportJob.getState();
    store.beginLive("j1");
    at(2_000);
    store.update({ fraction: 0.1, frame: 100 });
    expect(live()?.lastMoveAt).toBe(1_002_000);
    at(5_000);
    store.update({ fraction: 0.1, frame: 100 }); // ffmpeg prints the same block while it is stuck
    expect(live()?.lastMoveAt).toBe(1_002_000);
    at(6_000);
    store.update({ fraction: 0.1, frame: 101 });
    expect(live()?.lastMoveAt).toBe(1_006_000);
    at(7_000);
    store.update({ fraction: 0.1, frame: 101, step: 2, steps: 5 }); // the next part of a streamed render
    expect(live()).toMatchObject({ lastMoveAt: 1_007_000, step: 2, steps: 5 });
  });

  it("keeps the stage it was told, and a new stage ends the silence", () => {
    const store = useExportJob.getState();
    store.beginLive("j1");
    expect(live()?.stage).toBe("preparing");
    at(30_000);
    store.setLiveStage("j1", "rendering");
    expect(live()).toMatchObject({ stage: "rendering", lastMoveAt: 1_030_000 });
    store.setLiveStage("j1", "checking");
    expect(live()?.stage).toBe("checking");
  });

  it("belongs to one export: a late word about an older one changes nothing", () => {
    const store = useExportJob.getState();
    store.beginLive("old");
    store.beginLive("new"); // the next export's turn came
    store.setLiveStage("old", "saving");
    store.endLive("old");
    expect(live()).toMatchObject({ jobId: "new", stage: "preparing" });
    store.endLive("new");
    expect(live()).toBeNull();
  });

  it("is not ended by the dialog's own reset", () => {
    const store = useExportJob.getState();
    store.beginLive("j1");
    store.reset();
    expect(live()?.jobId).toBe("j1");
  });

  it("keeps the stage of an export that is still checking or saving when the next export's turn begins", () => {
    const store = useExportJob.getState();
    store.beginLive("a");
    store.setLiveStage("a", "rendering");
    store.update({ fraction: 0.99, frame: 990 });
    store.setLiveStage("a", "checking"); // the render process has exited; the file is being checked
    store.beginLive("b"); // the supervisor started the next export
    const state = () => useExportJob.getState();
    expect(liveFeedOf(state(), "a")).toMatchObject({ stage: "checking", fraction: 0.99 });
    expect(liveFeedOf(state(), "b")).toMatchObject({ stage: "preparing", fraction: null });
    // Progress is the current render's; a stage is its own export's.
    store.update({ fraction: 0.2, frame: 20 });
    store.setLiveStage("a", "saving");
    expect(liveFeedOf(state(), "a")).toMatchObject({ stage: "saving", fraction: 0.99 });
    expect(liveFeedOf(state(), "b")).toMatchObject({ stage: "preparing", fraction: 0.2 });
    store.endLive("a");
    expect(liveFeedOf(state(), "a")).toBeNull();
    expect(liveFeedOf(state(), "b")).toMatchObject({ stage: "preparing" });
    store.endLive("b");
    expect(liveFeedOf(state(), "b")).toBeNull();
    expect(state().live).toBeNull();
    expect(state().finishing).toEqual({});
  });

  it("knows nothing about an export that never began", () => {
    expect(liveFeedOf(useExportJob.getState(), "nope")).toBeNull();
  });

  it("does not leave an export that failed or was stopped looking like a render that stands still", () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    try {
      const store = useExportJob.getState();
      store.beginLive("a");
      store.setLiveStage("a", "rendering");
      // It failed or was killed: nothing ever said "checking", but the next export's turn came, which
      // only happens once its render process is over. Its cleanup then takes a minute and a half.
      store.beginLive("b");
      vi.setSystemTime(1_000_000 + 90_000);
      const feed = liveFeedOf(useExportJob.getState(), "a")!;
      expect(feed.stage).not.toBe("rendering");
      expect(feed.stage).not.toBe("preparing");
      expect(quietSeconds(feed, Date.now())).toBe(0); // not "no progress for 90 s"
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts clean for every export: nothing of the last one carries over", () => {
    const store = useExportJob.getState();
    store.beginLive("a");
    store.update({ fraction: 0.9, etaSec: 5, speed: 3, frame: 900, step: 4, steps: 5 });
    store.setLiveStage("a", "saving");
    // The last export reached 90 %, where the rule latches "finishing": what makes the comparison below mean something.
    const last = live()!;
    expect(last.timeLeft).toEqual({ kind: "finishing" });
    store.endLive("a");
    store.beginLive("b");
    expect(live()).toEqual({
      jobId: "b",
      stage: "preparing",
      startedAt: Date.now(),
      fraction: null,
      etaSec: null,
      speed: 0,
      frame: 0,
      step: null,
      steps: null,
      lastMoveAt: Date.now(),
      timeLeft: NO_TIME_LEFT,
      pace: startPace(),
    });
    // A new run of the rule, not the last export's memory handed on.
    expect(live()!.pace).not.toBe(last.pace);
  });
});

// The time left of a running export is decided by the rule in timeline/exportTimeLeft.ts. The store gives each attempt its own run of it, and the
// dialog's own job another, and feeds both every progress report with the clock of the moment the report lands. These tests play a steady render on a
// fake clock (a render of `total` seconds that is `t` seconds in has `total - t` left): the rule says nothing until 20 s are rendered and either
// 15 % is made or 60 s have passed, then a figure of its rounding grid (under 45 s one band, the nearest minute to 10 minutes, the nearest 5 minutes to
// an hour, the nearest quarter hour after), and "finishing" from 90 %.
describe("the time left of the running export, as the store keeps it", () => {
  const ORIGIN = 50_000_000;
  const FINISHING: TimeLeft = { kind: "finishing" };
  beforeEach(() => {
    useExportJob.getState().reset();
    useExportJob.setState({ live: null, finishing: {} });
    vi.useFakeTimers({ toFake: ["Date"], now: ORIGIN });
  });
  afterEach(() => vi.useRealTimers());
  const state = () => useExportJob.getState();
  const live = () => state().live!;
  // What the progress reporters publish: the share and the frame, the speed, and a raw pace of their own (12 s left) that the rule does not read.
  const report = (r: Pick<SteadyReport, "fraction" | "frame">) =>
    state().update({ fraction: r.fraction, frame: r.frame, speed: 1, etaSec: 12 });
  /** What the store says after each second of a steady render, by second: the feed's answer, the card's line at that moment, and the dialog's own job's answer. */
  const play = (feed: Parameters<typeof playSteady>[1]) => {
    const said = new Map<number, TimeLeft>();
    const lines = new Map<number, string>();
    const job = new Map<number, TimeLeft>();
    playSteady((r) => {
      report(r);
      said.set(r.at, live().timeLeft);
      lines.set(r.at, describeLiveStatus(live(), Date.now()));
      job.set(r.at, state().timeLeft);
    }, feed);
    return { said, lines, job };
  };
  const begin = (jobId: string) => {
    state().beginLive(jobId);
    state().setLiveStage(jobId, "rendering");
  };

  // Each row is worked out by hand: the gate opens at the later of 20 s and the time 15 % takes, but never later than 60 s; left = total - t at that
  // second; the grid then says it.
  //   total 60:   gate 20 s (a third is made), 40 s left, under 45 s is one band (30)           -> "under a minute left"
  //   total 120:  gate 20 s, 100 s left, nearest minute is 120                                  -> "about 2 min left"
  //   total 300:  gate 45 s (15 % of 300), 255 s left, nearest minute is 240 (4.25 minutes)      -> "about 4 min left"
  //   total 3000: gate 60 s (15 % would take 450 s, the 60 s of rendering alone opens it), 2940 s left, nearest 5 minutes is 3000 -> "about 50 min left"
  //   total 4560: gate 60 s, 4500 s left, nearest quarter hour is 4500                           -> "about 1 h 15 min left"
  it.each([
    [60, 20, 30, "under a minute left"],
    [120, 20, 120, "about 2 min left"],
    [300, 45, 240, "about 4 min left"],
    [3000, 60, 3000, "about 50 min left"],
    [4560, 60, 4500, "about 1 h 15 min left"],
  ])(
    "says nothing until the gate, then the grid figure of the time left, to the card and the dialog (a %i s render)",
    (total, gate, figure, words) => {
      begin("a");
      const { said, lines } = play({ total, from: 0, to: gate + 2, origin: ORIGIN });
      for (let t = 0; t < gate; t++) {
        expect(said.get(t), `${t} s in`).toEqual(NO_TIME_LEFT);
        expect(lines.get(t), `${t} s in`).not.toMatch(/left|Finishing|longer/);
      }
      expect(said.get(gate)).toEqual({ kind: "left", seconds: figure });
      // The raw pace the reporters publish (12 s left) is not what is said.
      expect(lines.get(gate)).toMatch(new RegExp(` · ${words}$`));
      // A steady render's figure holds for the next two seconds, and the dialog reads the same feed and says the same words.
      expect(live().timeLeft).toEqual({ kind: "left", seconds: figure });
      const now = Date.now();
      const dialog = describeDialogProgress(
        {
          own: live(),
          place: null,
          phase: "rendering",
          fraction: null,
          timeLeft: NO_TIME_LEFT,
          speed: 0,
        },
        now,
      );
      expect(dialog.timeLeft).toBe(words);
      expect(describeLiveStatus(live(), now).endsWith(` · ${words}`)).toBe(true);
    },
  );

  it("advances the rule with the clock of each report: the same shares with no time passing never open the gate", () => {
    begin("a");
    // 240 reports of a 300 s render landing at one instant: 80 % made, nothing rendered yet.
    for (const r of steadyReports({ total: 300, from: 0, to: 240 })) report(r);
    expect(live().timeLeft).toEqual(NO_TIME_LEFT);
    expect(describeLiveStatus(live(), Date.now())).toBe("Rendering and encoding · 80%");
    // The same shares with a second between reports: 240 s in, 60 s left, which is a grid figure.
    begin("b");
    playSteady(report, { total: 300, from: 0, to: 240, origin: ORIGIN + 1_000_000 });
    expect(live().timeLeft).toEqual({ kind: "left", seconds: 60 });
  });

  it("leaves the dialog's own job without an answer when the menu did not start the export", () => {
    begin("a");
    playSteady(report, { total: 300, from: 0, to: 60, origin: ORIGIN });
    expect(live().timeLeft).toEqual({ kind: "left", seconds: 240 });
    expect(state().phase).toBe("idle");
    expect(state().timeLeft).toEqual(NO_TIME_LEFT);
    expect(state().pace).toEqual(startPace());
  });

  // The restart: an attempt that played to 95 % has said "Finishing" for good; the next attempt of the same export starts from nothing, and the
  // one that is still checking its file keeps what it said.
  it("starts every attempt's rule afresh: nothing the last attempt latched is said of the next", () => {
    begin("a");
    playSteady(report, { total: 100, from: 0, to: 95, origin: ORIGIN });
    expect(live().timeLeft).toEqual(FINISHING);
    const first = live();

    vi.setSystemTime(ORIGIN + 200_000);
    begin("b");
    expect(live().jobId).toBe("b");
    expect(live().timeLeft).toEqual(NO_TIME_LEFT);
    expect(live().pace).toEqual(startPace());
    expect(live().pace).not.toBe(first.pace);

    // A 500 s render from zero. Its own gate is the 60 s of rendering (15 % would take 75 s): 440 s left, nearest minute 420 s. 90 % is 450 s in.
    const { said } = play({ total: 500, from: 0, to: 450, origin: ORIGIN + 200_000 });
    for (let t = 0; t < 60; t++) expect(said.get(t), `${t} s in`).toEqual(NO_TIME_LEFT);
    expect(said.get(60)).toEqual({ kind: "left", seconds: 420 });
    for (let t = 0; t < 450; t++) expect(said.get(t)?.kind, `${t} s in`).not.toBe("finishing");
    expect(said.get(450)).toEqual(FINISHING);

    // The first attempt is kept while its file is checked, with its own answer and memory; the new attempt's reports never touched them.
    expect(state().finishing["a"].timeLeft).toEqual(FINISHING);
    expect(state().finishing["a"].pace).toEqual(first.pace);
    expect(liveFeedOf(state(), "a")).toMatchObject({ stage: "checking", timeLeft: FINISHING });
  });

  // The failure direction: ffmpeg repeats its last block while it is stuck. A block that says nothing new is still a report, and is the rule's evidence
  // that the pace has dropped.
  it("counts a block that says nothing new: a render that stops making pictures is told to be taking longer than expected", () => {
    begin("a");
    // A 300 s render: the gate opens at 45 s (15 %) with 255 s left, the figure 240 s, and an implied total of 45 / 0.15 = 300 s.
    playSteady(report, { total: 300, from: 0, to: 45, origin: ORIGIN });
    expect(live().timeLeft).toEqual({ kind: "left", seconds: 240 });
    const stuck = (t: number) => {
      vi.setSystemTime(ORIGIN + t * 1000);
      report({ fraction: 0.15, frame: 45 * 30 });
    };
    // Stuck at 15 % since 45 s, the implied total t / 0.15 passes 1.5 times 300 s (450 s) between 67 s and 68 s.
    for (let t = 46; t <= 67; t++) stuck(t);
    expect(live().timeLeft.kind).toBe("left");
    stuck(68);
    expect(live().timeLeft).toEqual({ kind: "longer" });
    expect(describeLiveStatus(live(), Date.now())).toBe(
      "Still working · 1 min in · Rendering and encoding · 15% · taking longer than expected",
    );
    // A minute with no new picture since 45 s: the words go with it, though the rule still holds its answer.
    for (let t = 69; t <= 105; t++) stuck(t);
    expect(live().timeLeft).toEqual({ kind: "longer" });
    expect(describeLiveStatus(live(), Date.now())).toBe(
      "No progress for 60 s · Rendering and encoding · 15%",
    );
  });

  describe("the dialog's own job", () => {
    it.each(["begin", "reset"] as const)("%s clears what the job had said and latched", (how) => {
      state().begin(null);
      playSteady(report, { total: 100, from: 0, to: 95, origin: ORIGIN });
      expect(state().timeLeft).toEqual(FINISHING);
      const before = state().pace;
      if (how === "begin") state().begin(null);
      else state().reset();
      expect(state().timeLeft).toEqual(NO_TIME_LEFT);
      expect(state().pace).toEqual(startPace());
      expect(state().pace).not.toBe(before);
    });

    it("restarts with every new live feed, and says what the feed says while both follow the same reports", () => {
      state().begin(null);
      begin("a");
      const { said, job } = play({ total: 100, from: 0, to: 95, origin: ORIGIN });
      // 95 s in a 100 s render: gate at 20 s (a fifth is made), "finishing" from 90 s.
      expect(said.get(19)).toEqual(NO_TIME_LEFT);
      expect(said.get(20)?.kind).toBe("left");
      expect(said.get(95)).toEqual(FINISHING);
      for (const [t, answer] of said) expect(job.get(t), `${t} s in`).toEqual(answer);
      state().beginLive("b");
      expect(state().timeLeft).toEqual(NO_TIME_LEFT);
      expect(state().pace).toEqual(startPace());
      expect(state().phase).toBe("preparing");
    });

    // The gap between two attempts: the first has ended and the restart waits for its turn, so the dialog has no feed of its own to read and falls back on the job.
    it("clears the job's answer when the feed it followed ends, so the gap before a restart does not say what the last attempt latched", () => {
      state().begin(null);
      begin("a");
      playSteady(report, { total: 100, from: 0, to: 95, origin: ORIGIN });
      expect(state().timeLeft).toEqual(FINISHING);
      state().endLive("a");
      expect(state().timeLeft).toEqual(NO_TIME_LEFT);
      expect(state().pace).toEqual(startPace());
      const gap = describeDialogProgress(
        {
          own: null,
          place: null,
          phase: "rendering",
          fraction: state().fraction,
          timeLeft: state().timeLeft,
          speed: state().speed,
        },
        Date.now(),
      );
      expect(gap.timeLeft).toBe("");
    });

    it("keeps the job's answer when only an export that is finishing ends: the job follows the feed that is live", () => {
      state().begin(null);
      begin("a");
      begin("b"); // a is finishing now
      playSteady(report, { total: 300, from: 0, to: 60, origin: ORIGIN });
      expect(state().timeLeft).toEqual({ kind: "left", seconds: 240 });
      state().endLive("a");
      expect(live().jobId).toBe("b");
      expect(state().timeLeft).toEqual({ kind: "left", seconds: 240 });
    });

    it.each(["done", "failed", "cancelled"] as const)(
      "is moved by a report only while it is preparing or rendering: a late one after it is %s changes nothing",
      (phase) => {
        state().begin(null);
        // 60 s into a 300 s render: the gate opened at 45 s, 240 s left.
        playSteady(report, { total: 300, from: 0, to: 60, origin: ORIGIN });
        expect(state().timeLeft).toEqual({ kind: "left", seconds: 240 });
        state().finish({ phase });
        const settled = {
          timeLeft: state().timeLeft,
          pace: state().pace,
          fraction: state().fraction,
        };
        // ffmpeg's last blocks can arrive after the process has gone: 250 s in, 83 % made, which would be about a minute left.
        vi.setSystemTime(ORIGIN + 250_000);
        report({ fraction: 250 / 300, frame: 7500 });
        expect(state().fraction).toBe(settled.fraction);
        expect(state().timeLeft).toEqual(settled.timeLeft);
        expect(state().pace).toEqual(settled.pace);
      },
    );
  });

  it("keeps the answer when the stage changes, the processors are read, or the dialog's job finishes", () => {
    state().begin(null);
    begin("a");
    playSteady(report, { total: 300, from: 0, to: 60, origin: ORIGIN });
    const kept = { timeLeft: live().timeLeft, pace: live().pace };
    expect(kept.timeLeft).toEqual({ kind: "left", seconds: 240 });
    state().setLiveBusy("a", true);
    expect(live()).toMatchObject(kept);
    for (const stage of ["checking", "saving"] as const) {
      state().setLiveStage("a", stage);
      expect(live().stage).toBe(stage);
      expect(live().timeLeft).toEqual(kept.timeLeft);
      expect(live().pace).toEqual(kept.pace);
    }
    const job = { timeLeft: state().timeLeft, pace: state().pace };
    state().finish({ phase: "done", savedTo: "C:/out/final.mp4" });
    expect(state().timeLeft).toEqual(job.timeLeft);
    expect(state().pace).toEqual(job.pace);
    expect(live().timeLeft).toEqual(kept.timeLeft);
    // An export that is finishing (the next one's turn came) keeps its own answer through the same words about it.
    state().beginLive("b");
    state().setLiveStage("a", "saving");
    state().setLiveBusy("a", false);
    expect(state().finishing["a"]).toMatchObject(kept);
  });

  it("says nothing at a part before the last of a render made in parts, and starts afresh at the final encode", () => {
    begin("a");
    // Three steps: parts 1 and 2, then the final encode. 90 s in at one 300th of the render per second is long past the gate of a plain render.
    for (let t = 0; t <= 90; t++) {
      vi.setSystemTime(ORIGIN + t * 1000);
      state().update({ fraction: t / 300, frame: t * 30, speed: 1, etaSec: 12, step: 0, steps: 3 });
      expect(live().timeLeft, `${t} s in part 1`).toEqual(NO_TIME_LEFT);
    }
    expect(describeLiveStatus(live(), Date.now())).toBe(
      "Still working · 1 min in · Rendering part 1 of 2 · 30%",
    );
    // The final encode is a new segment with its own clock and gate: its first report is at 91 s, and 20 s of its own rendering (111 s) opens the
    // gate, the whole render being past 15 % already. At 131 s, 44 % is made and 169 s are left: the nearest minute is 180 s.
    for (let t = 91; t <= 131; t++) {
      vi.setSystemTime(ORIGIN + t * 1000);
      state().update({ fraction: t / 300, frame: t * 30, speed: 1, etaSec: 12, step: 2, steps: 3 });
      if (t < 111) expect(live().timeLeft, `${t} s in the encode`).toEqual(NO_TIME_LEFT);
    }
    expect(live().timeLeft).toEqual({ kind: "left", seconds: 180 });
    expect(describeLiveStatus(live(), Date.now())).toBe(
      "Still working · 2 min in · Encoding · 44% · about 3 min left",
    );
  });
});
