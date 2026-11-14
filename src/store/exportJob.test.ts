import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { liveFeedOf, useExportJob } from "./exportJob";
import { COST_FEATURES } from "../timeline/costShape";
import { ENCODER_IDS } from "../timeline/exportEncoder";
import { EXPORT_SPEED_REVISION, type ExportCalibration } from "../timeline/exportOptions";
import { quietSeconds } from "../timeline/exportWords";

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
    });
  });
});
