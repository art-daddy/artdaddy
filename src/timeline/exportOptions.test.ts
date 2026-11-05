// Export delivery presets. The rules that matter are about what a preset must NEVER do:
// invent detail by upscaling, emit an odd dimension that ffmpeg refuses outright, or change
// anything at all when the user asked for the source size.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  EXPORT_SPEED_REVISION,
  LONG_EXPORT_SECONDS,
  assessExport,
  crfFor,
  DECODER_FRAME_THREAD_BUDGET,
  decoderThreads,
  describeExportSize,
  describeExportTime,
  estimateExport,
  estimateExportFromHistory,
  estimateForDialog,
  exceedsFileSequencePicture,
  exceedsOnePass,
  FILE_SEQUENCE_MAX_PIXELS,
  finalEncoderPolicy,
  FRAME_THREADED_INPUTS_MAX,
  guessExportSeconds,
  isKnownProblem,
  outputFps,
  outputSize,
  peakSamples,
  promiseLineOf,
  promiseMultipleOf,
  type ExportCalibration,
  type ExportEncoder,
  type ExportEstimates,
  type ExportPreflightReason,
} from "./exportOptions";
import { CHIP_CAUTIOUS_GAIN, FASTER_X264_GAIN } from "./exportEncoder";
import { UNMEASURED_RESERVE_BYTES, planRung } from "./exportPlan";
import type { RenderWorkload } from "./renderPlan";

describe("one-pass picture ceiling", () => {
  it("is 2560x1440 pixels and moves with a single pixel", () => {
    expect(FILE_SEQUENCE_MAX_PIXELS).toBe(2560 * 1440);
    expect(exceedsFileSequencePicture({ width: 2560, height: 1440 })).toBe(false);
    expect(exceedsFileSequencePicture({ width: 1440, height: 2560 })).toBe(false);
    expect(exceedsFileSequencePicture({ width: 3_686_400, height: 1 })).toBe(false);
    expect(exceedsFileSequencePicture({ width: 3_686_401, height: 1 })).toBe(true);
    expect(exceedsFileSequencePicture({ width: 3840, height: 2160 })).toBe(true);
  });

  it("depends on the number of pixels only: orientation never matters and a bigger picture never goes back", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8192 }),
        fc.integer({ min: 1, max: 8192 }),
        (width, height) => {
          const over = exceedsFileSequencePicture({ width, height });
          expect(exceedsFileSequencePicture({ width: height, height: width })).toBe(over);
          if (over) {
            expect(exceedsFileSequencePicture({ width: width + 1, height })).toBe(true);
            expect(exceedsFileSequencePicture({ width, height: height + 1 })).toBe(true);
          }
        },
      ),
    );
  });
});

describe("decoder thread policy", () => {
  it("leaves a command of up to two video inputs on ffmpeg's defaults and shares a fixed budget of threads between the inputs of a larger one", () => {
    // The boundary and the budget are frozen here so that moving either is a decision, not a drift.
    expect(FRAME_THREADED_INPUTS_MAX).toBe(2);
    expect(DECODER_FRAME_THREAD_BUDGET).toBe(24);
    // Written out rather than recomputed: 3 -> 8, 4 -> 6, 5 and 6 -> 4, 7 and 8 -> 3, 9 to 12 -> 2, 13 and more -> 1.
    const perInput: [number, number][] = [
      [3, 8],
      [4, 6],
      [5, 4],
      [6, 4],
      [7, 3],
      [8, 3],
      [9, 2],
      [10, 2],
      [11, 2],
      [12, 2],
      [13, 1],
      [21, 1],
      [24, 1],
      [25, 1],
      [200, 1],
    ];
    for (const engine of ["file-sequence-v1", "auto"] as const) {
      for (let inputs = 0; inputs <= FRAME_THREADED_INPUTS_MAX; inputs++)
        expect(decoderThreads(engine, inputs), `${engine} ${inputs}`).toBeNull();
      for (const [inputs, threads] of perInput)
        expect(decoderThreads(engine, inputs), `${engine} ${inputs}`).toBe(threads);
    }
    // The streamed engine has always decoded every input on one thread, however few.
    for (let inputs = 0; inputs <= 200; inputs++)
      expect(decoderThreads("partition-pipes-v1", inputs), `streamed ${inputs}`).toBe(1);
    // A count that is not a whole number of inputs is never a reason to leave memory unbounded.
    for (const nonsense of [Number.NaN, -1, 2.5, Number.POSITIVE_INFINITY])
      expect(decoderThreads("file-sequence-v1", nonsense), String(nonsense)).toBe(1);
  });

  it("bounds the frame threads of a whole command whatever the project size or the machine", () => {
    // The rule that has to survive a rewrite: past two inputs a command never asks for more than 24 decoder frame threads in all, never gives an
    // input fewer than one, and the allowance of an input only ever shrinks as inputs are added. (At two or fewer, ffmpeg's own default of at
    // most 16 per input applies, so a command cannot hold more than 32.)
    for (const engine of ["file-sequence-v1", "auto"] as const) {
      let previous = Number.POSITIVE_INFINITY;
      for (let inputs = FRAME_THREADED_INPUTS_MAX + 1; inputs <= 400; inputs++) {
        const threads = decoderThreads(engine, inputs) as number;
        expect(Number.isInteger(threads) && threads >= 1, `${engine} ${inputs}`).toBe(true);
        expect(inputs * threads, `${engine} ${inputs}`).toBeLessThanOrEqual(Math.max(24, inputs));
        expect(threads, `${engine} ${inputs}`).toBeLessThanOrEqual(previous);
        previous = threads;
      }
    }
  });
});

describe("export preflight assessment", () => {
  const workload: RenderWorkload = {
    width: 1920,
    height: 1080,
    fps: 30,
    durationSeconds: 60,
    visualClips: 10,
    captionClips: 1,
    audioClips: 1,
    peakVisualLayers: 2,
    peakMediaLayers: 1,
  };
  const resources = {
    total_memory_bytes: 16e9,
    available_memory_bytes: 8e9,
    scratch_free_bytes: 100e9,
    destination_free_bytes: 100e9,
    local_fast_candidate: false,
    budgets: { memoryBytes: 4e9, temporaryBytes: 18e9, executionSeconds: 28800 },
  };
  const estimates: ExportEstimates = {
    memoryBytes: 2e9,
    temporaryBytes: 1e9,
    finalBytes: 100e6,
    seconds: 60,
  };
  const budgets = { memoryBytes: 4e9, temporaryBytes: 18e9, executionSeconds: 28800 };

  describe("with a plan, the memory verdict is the plan's", () => {
    const GIB = 1024 ** 3;
    const planFor = (free: number | null, peaks: Array<[0 | 1 | 2, number]> = []) =>
      planRung({
        samples: peaks.map(([rung, bytes]) => ({ rung, bytes })),
        freeBytes: free,
      });
    const reasons = (
      plan: ReturnType<typeof planFor> | undefined,
      over: Partial<ExportEstimates> = {},
    ) =>
      assessExport(workload, resources, { ...estimates, ...over }, budgets, plan).reasons.filter(
        (reason) => reason.startsWith("memory"),
      );

    it("is exactly today's verdict when there is no plan", () => {
      expect(reasons(undefined)).toEqual([]);
      expect(reasons(undefined, { memoryBytes: 5e9 })).toEqual(["memory_shortage"]);
      expect(reasons(undefined, { memoryBytes: null })).toEqual(["memory_unknown"]);
    });

    it("asks nothing when a rung fits, even though the normal rung would not (the plan chose the gentle one)", () => {
      const plan = planFor(4 * GIB, [[0, 3.52 * GIB]]); // the normal rung exceeds the ceiling; gentle fits
      expect(plan).toMatchObject({ rung: 1, fits: true });
      expect(reasons(plan, { memoryBytes: 3.52 * GIB })).toEqual([]);
    });

    it("asks when even the gentlest rung does not fit, and when a first export has less than the reserve", () => {
      expect(reasons(planFor(0.5 * GIB, [[0, 3.52 * GIB]]))).toEqual(["memory_shortage"]);
      expect(reasons(planFor(UNMEASURED_RESERVE_BYTES - 1), { memoryBytes: null })).toEqual([
        "memory_shortage",
      ]);
    });

    it("still says the memory was unknown (for the report) when nothing was measured and it fits", () => {
      expect(reasons(planFor(8 * GIB), { memoryBytes: null })).toEqual(["memory_unknown"]);
      expect(reasons(planFor(null), { memoryBytes: null })).toEqual(["memory_unknown"]);
    });
  });

  // The promise line moved into one function (the faster setting reads it too). Both readers must agree for every shape.
  it("says one thing about a project's promise line, to the assessment and to the encoder rule", () => {
    fc.assert(
      fc.property(
        fc.record({
          width: fc.constantFrom(720, 1080, 1280, 1920, 2160, 3840, 7680),
          height: fc.constantFrom(720, 1080, 1280, 1920, 2160, 3840, 7680),
          fps: fc.constantFrom(24, 30, 50, 60),
          durationSeconds: fc.constantFrom(1, 60, 1800, 1801, 7200, 7201),
          visualClips: fc.constantFrom(1, 10, 1000, 1001),
          captionClips: fc.constant(0),
          audioClips: fc.constant(0),
          peakVisualLayers: fc.integer({ min: 1, max: 10 }),
          peakMediaLayers: fc.integer({ min: 1, max: 10 }),
        }),
        (shape) => {
          expect(promiseLineOf(shape)).toBe(
            assessExport(shape, resources, estimates, budgets).promiseLine,
          );
        },
      ),
      { numRuns: 400 },
    );
  });

  it("promises two times the video's length for ordinary HD and four for everything heavier", () => {
    expect(promiseMultipleOf("hd")).toBe(2);
    for (const line of ["heavy_hd", "4k", "outside"] as const)
      expect(promiseMultipleOf(line), line).toBe(4);
  });

  it("uses the independent HD,4Kandheavy limits and counts captions as things", () => {
    expect(assessExport(workload, resources, estimates, budgets)).toMatchObject({
      promiseLine: "hd",
      severity: "none",
    });
    const fourK = {
      ...workload,
      width: 3840,
      height: 2160,
      durationSeconds: 1800,
      peakVisualLayers: 4,
    };
    expect(assessExport(fourK, resources, estimates, budgets).promiseLine).toBe("4k");
    expect(
      assessExport({ ...fourK, peakVisualLayers: 5 }, resources, estimates, budgets).severity,
    ).toBe("warning");
    expect(assessExport({ ...fourK, fps: 60 }, resources, estimates, budgets).promiseLine).toBe(
      "outside",
    );
    expect(
      assessExport({ ...workload, peakVisualLayers: 8 }, resources, estimates, budgets).promiseLine,
    ).toBe("heavy_hd");
    expect(
      assessExport({ ...workload, peakVisualLayers: 9 }, resources, estimates, budgets).promiseLine,
    ).toBe("outside");
    expect(
      assessExport({ ...workload, visualClips: 1001 }, resources, estimates, budgets).promiseLine,
    ).toBe("outside");
  });

  it("shows a light notice for a known slow in-scope export but never for unknown resources", () => {
    expect(
      assessExport(workload, resources, { ...estimates, seconds: 150 }, budgets),
    ).toMatchObject({ severity: "notice", reasons: ["slow"] });
    expect(
      assessExport(workload, resources, { ...estimates, seconds: null }, budgets),
    ).toMatchObject({ severity: "none", reasons: ["time_unknown"] });
    expect(
      assessExport(workload, { ...resources, scratch_free_bytes: null }, estimates, budgets),
    ).toMatchObject({ severity: "none", reasons: ["disk_unknown"] });
  });

  it("asks only about a problem the export is known to have, never about a missing measurement", () => {
    // One scenario per reason, each producing exactly that reason; adding a reason breaks the build here.
    const scenario: Record<ExportPreflightReason, () => ReturnType<typeof assessExport>> = {
      outside_promise: () =>
        assessExport({ ...workload, peakVisualLayers: 9 }, resources, estimates, budgets),
      memory_shortage: () =>
        assessExport(workload, resources, { ...estimates, memoryBytes: 5e9 }, budgets),
      disk_shortage: () =>
        assessExport(
          workload,
          { ...resources, destination_free_bytes: 1.05e9 },
          estimates,
          budgets,
        ),
      temporary_limit: () =>
        assessExport(workload, resources, { ...estimates, temporaryBytes: 19e9 }, budgets),
      execution_limit: () =>
        assessExport(workload, resources, { ...estimates, seconds: 28801 }, budgets),
      memory_unknown: () =>
        assessExport(workload, resources, { ...estimates, memoryBytes: null }, budgets),
      disk_unknown: () =>
        assessExport(workload, { ...resources, scratch_free_bytes: null }, estimates, budgets),
      time_unknown: () =>
        assessExport(workload, resources, { ...estimates, seconds: null }, budgets),
      slow: () => assessExport(workload, resources, { ...estimates, seconds: 150 }, budgets),
      long: () =>
        assessExport(workload, resources, { ...estimates, seconds: LONG_EXPORT_SECONDS }, budgets),
    };
    // Written out, not derived from isKnownProblem, so this pins which reasons ask.
    const asked: Record<ExportPreflightReason, "warning" | "notice" | "none"> = {
      outside_promise: "warning",
      memory_shortage: "warning",
      disk_shortage: "warning",
      temporary_limit: "warning",
      execution_limit: "warning",
      slow: "notice",
      long: "notice",
      memory_unknown: "none",
      disk_unknown: "none",
      time_unknown: "none",
    };
    for (const reason of Object.keys(scenario) as ExportPreflightReason[]) {
      const result = scenario[reason]();
      expect(result.reasons, reason).toEqual([reason]);
      expect(result.severity, reason).toBe(asked[reason]);
      expect(isKnownProblem(reason), reason).toBe(asked[reason] === "warning");
    }
  });

  it("asks about a long export, measured or guessed, and stays quiet just under the line", () => {
    const atTheLine = { ...estimates, seconds: LONG_EXPORT_SECONDS };
    expect(assessExport(workload, resources, atTheLine, budgets)).toMatchObject({
      severity: "notice",
      reasons: ["long"],
    });
    expect(
      assessExport(workload, resources, { ...atTheLine, secondsGuessed: true }, budgets),
    ).toMatchObject({ severity: "notice", reasons: ["long"], estimates: { secondsGuessed: true } });
    // A guess is never called "unknown", and under the line it asks about nothing.
    const under = { ...estimates, seconds: LONG_EXPORT_SECONDS - 1, secondsGuessed: true };
    expect(assessExport(workload, resources, under, budgets)).toMatchObject({
      severity: "none",
      reasons: [],
    });
  });

  it("holds a guess to long and to the time limit only, never to 'twice the video'", () => {
    const quick = { ...estimates, seconds: 150, secondsGuessed: true }; // 2.5x a 60 s video
    expect(assessExport(workload, resources, quick, budgets).reasons).toEqual([]);
    expect(
      assessExport(workload, resources, { ...quick, secondsGuessed: false }, budgets).reasons,
    ).toEqual(["slow"]);
    expect(assessExport(workload, resources, { ...quick, seconds: 28801 }, budgets)).toMatchObject({
      severity: "warning",
      reasons: ["execution_limit"],
    });
  });

  it("does not let a guess hide a known problem the resources show", () => {
    const guessed = { ...estimates, seconds: 30, secondsGuessed: true };
    expect(
      assessExport(workload, resources, { ...guessed, memoryBytes: 5e9 }, budgets).severity,
    ).toBe("warning");
  });

  it("does not put missing or invalid workload values inside the promise", () => {
    for (const patch of [
      { width: 0 },
      { height: NaN },
      { fps: 0 },
      { fps: Infinity },
      { durationSeconds: 0 },
    ])
      expect(assessExport({ ...workload, ...patch }, resources, estimates, budgets)).toMatchObject({
        promiseLine: "outside",
        severity: "warning",
      });
    expect(
      assessExport(
        workload,
        resources,
        { ...estimates, seconds: NaN, memoryBytes: Infinity },
        budgets,
      ).reasons,
    ).toEqual(["memory_unknown", "time_unknown"]);
  });

  it("checks final allocation and temporary space together without assuming separate volumes", () => {
    expect(
      assessExport(workload, { ...resources, destination_free_bytes: 1.05e9 }, estimates, budgets),
    ).toMatchObject({ severity: "warning", reasons: ["disk_shortage"] });
    expect(
      assessExport(workload, resources, { ...estimates, memoryBytes: 5e9 }, budgets).reasons,
    ).toContain("memory_shortage");
    expect(
      assessExport(workload, resources, { ...estimates, temporaryBytes: 19e9 }, budgets).reasons,
    ).toContain("temporary_limit");
  });

  it("never downgrades a fit warning when available memory or storage decreases", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 8_000_000_000 }),
        fc.integer({ min: 0, max: 100_000_000_000 }),
        (memory, disk) => {
          const result = assessExport(
            workload,
            { ...resources, available_memory_bytes: memory, destination_free_bytes: disk },
            estimates,
            budgets,
          );
          if (
            memory < estimates.memoryBytes! ||
            disk < estimates.temporaryBytes! + estimates.finalBytes!
          )
            expect(result.severity).toBe("warning");
        },
      ),
      { numRuns: 200 },
    );
  });

  it("fits scratch and pending output together rather than giving each the whole allowance", () => {
    expect(
      assessExport(
        workload,
        resources,
        { ...estimates, temporaryBytes: 10e9, finalBytes: 10e9 },
        budgets,
      ),
    ).toMatchObject({ severity: "warning", reasons: ["temporary_limit"] });
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 18_000_000_000 }),
        fc.integer({ min: 0, max: 18_000_000_000 }),
        (scratch, staging) => {
          const combined = assessExport(
            workload,
            resources,
            { ...estimates, temporaryBytes: scratch, finalBytes: staging },
            budgets,
          );
          const reversed = assessExport(
            workload,
            resources,
            { ...estimates, temporaryBytes: staging, finalBytes: scratch },
            budgets,
          );
          expect(combined.severity === "none").toBe(scratch + staging <= budgets.temporaryBytes);
          expect(reversed.reasons).toEqual(combined.reasons);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("local measured export estimates", () => {
  const workload: RenderWorkload = {
    width: 1920,
    height: 1080,
    fps: 30,
    durationSeconds: 10,
    visualClips: 14,
    captionClips: 2,
    audioClips: 1,
    peakVisualLayers: 8,
    peakMediaLayers: 7,
  };
  const output = { width: 1920, height: 1080, fps: 30 };
  const sample: ExportCalibration = {
    workload,
    output,
    quality: "medium",
    engine: "partition-pipes-v1",
    revision: EXPORT_SPEED_REVISION,
    elapsedSeconds: 16,
    finalBytes: 2_400_000,
    memoryBytes: 1_000_000_000,
    temporaryBytes: null,
  };
  const estimate = (target = workload, history: readonly ExportCalibration[] = [sample]) =>
    estimateExportFromHistory(target, output, "medium", "partition-pipes-v1", history);

  it("reads the peak memory of earlier exports of the same shape, with the rung each ran at", () => {
    const samples = (history: readonly ExportCalibration[]) =>
      peakSamples(workload, output, "medium", "partition-pipes-v1", history);
    expect(samples([sample])).toEqual([{ rung: 0, bytes: 1_000_000_000 }]); // no rung recorded: the normal one
    expect(
      samples([
        { ...sample, rung: 1, memoryBytes: 600_000_000 },
        { ...sample, rung: 2, memoryBytes: null },
        sample,
      ]),
    ).toEqual([
      { rung: 1, bytes: 600_000_000 },
      { rung: 2, bytes: null },
      { rung: 0, bytes: 1_000_000_000 },
    ]);
  });

  it("takes only the history that estimates already take: another shape, picture or speed revision says nothing", () => {
    const samples = (history: readonly ExportCalibration[], quality = "medium") =>
      peakSamples(workload, output, quality, "partition-pipes-v1", history);
    expect(samples([{ ...sample, revision: EXPORT_SPEED_REVISION - 1 }])).toEqual([]);
    expect(samples([{ ...sample, workload: { ...workload, peakMediaLayers: 1 } }])).toEqual([]);
    expect(samples([{ ...sample, output: { ...output, fps: 60 } }])).toEqual([]);
    expect(samples([sample], "high")).toEqual([]);
    // The same filter, so the two can never disagree about what a measurement matches.
    for (const history of [[sample], [{ ...sample, quality: "low" }], [] as ExportCalibration[]])
      expect(samples(history).length > 0).toBe(
        estimateExportFromHistory(workload, output, "medium", "partition-pipes-v1", history)
          .seconds !== null,
      );
  });

  it("estimates only from measurements made under the current speed revision", () => {
    const unknown = { seconds: null, memoryBytes: null, temporaryBytes: null, finalBytes: null };
    for (const revision of [undefined, EXPORT_SPEED_REVISION - 1, EXPORT_SPEED_REVISION + 1])
      expect(estimate(workload, [{ ...sample, revision }])).toEqual(unknown);
    expect(
      estimate(workload, [
        { ...sample, revision: EXPORT_SPEED_REVISION - 1, elapsedSeconds: 500 },
        sample,
        { ...sample, revision: EXPORT_SPEED_REVISION + 1, elapsedSeconds: 900 },
      ]).seconds,
    ).toBe(16);
  });

  it("does not invent observations for absent or incompatible history", () => {
    const unknown = { seconds: null, memoryBytes: null, temporaryBytes: null, finalBytes: null };
    expect(estimate(workload, [])).toEqual(unknown);
    expect(estimate({ ...workload, peakMediaLayers: 1 })).toEqual(unknown);
    expect(
      estimateExportFromHistory(workload, output, "high", "partition-pipes-v1", [sample]),
    ).toEqual(unknown);
    expect(
      estimateExportFromHistory(workload, { ...output, fps: 60 }, "medium", "partition-pipes-v1", [
        sample,
      ]),
    ).toEqual(unknown);
  });

  it("uses successful measurements without replacing missing observations by zero", () => {
    expect(estimate()).toEqual({
      seconds: 16,
      finalBytes: 2_400_000,
      memoryBytes: 1_000_000_000,
      temporaryBytes: null,
    });
    expect(estimate(workload, [{ ...sample, elapsedSeconds: NaN }]).seconds).toBeNull();
    expect(estimate(workload, [sample, { ...sample, elapsedSeconds: 20 }]).seconds).toBe(20);
  });

  it("cannot use old or late encoder-policy measurements for a different policy", () => {
    const profiles = (["x264-crf", "x264-crf-threads2", "chip-amd"] as const).map(
      (encoder, index) => ({ ...sample, encoder, elapsedSeconds: (index + 1) * 10 }),
    );
    for (const profile of profiles) {
      const foreign = profiles.filter((entry) => entry.encoder !== profile.encoder);
      expect(
        estimateExportFromHistory(
          workload,
          output,
          "medium",
          "partition-pipes-v1",
          foreign,
          profile.encoder,
        ).seconds,
      ).toBeNull();
      for (const history of [
        [profile, ...foreign],
        [...foreign, profile],
      ])
        expect(
          estimateExportFromHistory(
            workload,
            output,
            "medium",
            "partition-pipes-v1",
            history,
            profile.encoder,
          ).seconds,
        ).toBe(profile.elapsedSeconds);
    }
  });

  it("never estimates Fast from software history or software from Fast history", () => {
    const fast = {
      ...sample,
      encoder: "chip-amd" as const,
      elapsedSeconds: 9,
      finalBytes: 10_000_000,
    };
    expect(
      estimateExportFromHistory(
        workload,
        output,
        "medium",
        "partition-pipes-v1",
        [sample],
        "chip-amd",
      ).seconds,
    ).toBeNull();
    expect(estimate(workload, [fast]).seconds).toBeNull();
    expect(
      estimateExportFromHistory(
        workload,
        output,
        "medium",
        "partition-pipes-v1",
        [sample, fast],
        "chip-amd",
      ),
    ).toMatchObject({ seconds: 9, finalBytes: 10_000_000 });
    expect(estimate(workload, [sample, fast])).toMatchObject({
      seconds: 16,
      finalBytes: 2_400_000,
    });
  });

  it("does not shorten an estimate when duration or clip count increases", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 1, max: 1000 }),
        (seconds, clips) => {
          const first = estimate({ ...workload, durationSeconds: seconds, visualClips: clips });
          const more = estimate({
            ...workload,
            durationSeconds: seconds + 1,
            visualClips: clips + 1,
          });
          expect(more.seconds!).toBeGreaterThanOrEqual(first.seconds!);
          expect(more.finalBytes!).toBeGreaterThanOrEqual(first.finalBytes!);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("a rough time for an export nobody has measured", () => {
  const hd: RenderWorkload = {
    width: 1920,
    height: 1080,
    fps: 30,
    durationSeconds: 600,
    visualClips: 50,
    captionClips: 120,
    audioClips: 1,
    peakVisualLayers: 1,
    peakMediaLayers: 1,
  };
  const hdOut = { width: 1920, height: 1080, fps: 30 };
  const fourK: RenderWorkload = { ...hd, width: 3840, height: 2160, peakVisualLayers: 3 };
  const fourKOut = { width: 3840, height: 2160, fps: 30 };

  it("puts an ordinary HD export near the video's own length, as measured", () => {
    // Measured on a fast laptop: 0.6 to 1.2 times the length; one x264 thread caps it at 2.
    const seconds = guessExportSeconds(hd, hdOut)!;
    expect(seconds).toBeGreaterThan(600 * 0.5);
    expect(seconds).toBeLessThan(600 * 2);
  });

  it("calls a half-hour 4K export hours, and a ten-minute HD one short of long", () => {
    expect(guessExportSeconds({ ...fourK, durationSeconds: 1800 }, fourKOut)!).toBeGreaterThan(
      2 * 3600,
    );
    expect(guessExportSeconds(hd, hdOut)!).toBeLessThan(LONG_EXPORT_SECONDS);
    expect(guessExportSeconds({ ...hd, durationSeconds: 7200 }, hdOut)!).toBeGreaterThan(
      LONG_EXPORT_SECONDS,
    );
  });

  it("never says an export is quicker because it got longer, bigger, faster or heavier", () => {
    const sizes = fc.constantFrom(
      { width: 640, height: 360 },
      { width: 1280, height: 720 },
      { width: 1920, height: 1080 },
      { width: 2560, height: 1440 },
      { width: 3840, height: 2160 },
    );
    fc.assert(
      fc.property(
        sizes,
        sizes,
        fc.integer({ min: 1, max: 7200 }),
        fc.integer({ min: 10, max: 120 }),
        fc.integer({ min: 1, max: 15 }),
        (canvas, delivered, seconds, fps, layers) => {
          const base = {
            ...hd,
            ...canvas,
            durationSeconds: seconds,
            fps,
            peakVisualLayers: layers,
          };
          const out = { ...delivered, fps };
          const here = guessExportSeconds(base, out)!;
          expect(here).toBeGreaterThan(0);
          expect(Number.isInteger(here)).toBe(true);
          const more = (workload: RenderWorkload, output: ExportCalibration["output"] = out) =>
            guessExportSeconds(workload, output)!;
          expect(more({ ...base, durationSeconds: seconds + 1 })).toBeGreaterThanOrEqual(here);
          expect(more({ ...base, peakVisualLayers: layers + 1 })).toBeGreaterThanOrEqual(here);
          expect(more({ ...base, fps: fps + 1 }, { ...out, fps: fps + 1 })).toBeGreaterThanOrEqual(
            here,
          );
          expect(
            more(base, { ...out, width: out.width * 2, height: out.height * 2 }),
          ).toBeGreaterThanOrEqual(here);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("never says an export takes less time than starting and finishing one takes", () => {
    expect(guessExportSeconds({ ...hd, durationSeconds: 0.01 }, hdOut)!).toBeGreaterThanOrEqual(10);
  });

  it("charges for the larger of the project's size and the delivered size", () => {
    const small = guessExportSeconds(hd, hdOut)!;
    // Composited at 4K and delivered at 1080p, or composited at 1080p and delivered at 4K.
    expect(guessExportSeconds({ ...hd, width: 3840, height: 2160 }, hdOut)!).toBeGreaterThan(small);
    expect(guessExportSeconds(hd, fourKOut)!).toBeGreaterThan(small);
  });

  it("makes no guess for sizes that are not sizes", () => {
    for (const patch of [
      { width: 0 },
      { height: -1 },
      { fps: NaN },
      { durationSeconds: 0 },
      { durationSeconds: Infinity },
    ])
      expect(guessExportSeconds({ ...hd, ...patch }, hdOut), JSON.stringify(patch)).toBeNull();
    for (const encoder of ["chip-amd", "chip-nvidia", "chip-intel", "x264-fast"] as const)
      expect(guessExportSeconds({ ...hd, width: 0 }, hdOut, encoder), encoder).toBeNull();
    expect(guessExportSeconds(hd, { ...hdOut, width: 0 })).toBeNull();
    expect(guessExportSeconds({ ...hd, peakVisualLayers: NaN }, hdOut)).not.toBeNull();
  });

  // Phase 3, S4: a chip, or the faster setting, has no measurement on this PC until it has run once, so its estimate is the
  // processor's divided by a cautious gain (the lab saw 1.5 on a source that is hard to decode and 3.7 on an ordinary one).
  it("guesses the chip and the faster setting from the processor's guess, cautiously and never slower", () => {
    const normal = guessExportSeconds(hd, hdOut, "x264-crf")!;
    for (const chip of ["chip-amd", "chip-nvidia", "chip-intel"] as const) {
      const guess = guessExportSeconds(hd, hdOut, chip)!;
      expect(guess, chip).toBeLessThan(normal);
      expect(guess, chip).toBe(Math.ceil(normal / CHIP_CAUTIOUS_GAIN));
    }
    expect(guessExportSeconds(hd, hdOut, "x264-fast")).toBe(Math.ceil(normal / FASTER_X264_GAIN));
    expect(guessExportSeconds(hd, hdOut, "x264-fast-threads2")).toBe(
      Math.ceil(guessExportSeconds(hd, hdOut, "x264-crf-threads2")! / FASTER_X264_GAIN),
    );
    // The same floor as every guess: starting and finishing an export takes time whatever encodes it.
    expect(
      guessExportSeconds({ ...hd, durationSeconds: 0.01 }, hdOut, "chip-amd")!,
    ).toBeGreaterThanOrEqual(Math.ceil(10 / CHIP_CAUTIOUS_GAIN));
  });
});

describe("the estimate an export gets: measured when there is history, a guess when there is none", () => {
  const workload: RenderWorkload = {
    width: 1920,
    height: 1080,
    fps: 30,
    durationSeconds: 7200,
    visualClips: 14,
    captionClips: 2,
    audioClips: 1,
    peakVisualLayers: 1,
    peakMediaLayers: 1,
  };
  const output = { width: 1920, height: 1080, fps: 30 };
  const sample: ExportCalibration = {
    workload: { ...workload, durationSeconds: 100 },
    output,
    quality: "medium",
    engine: "partition-pipes-v1",
    revision: EXPORT_SPEED_REVISION,
    elapsedSeconds: 20,
    finalBytes: 1_000_000,
    memoryBytes: 1_000_000_000,
    temporaryBytes: null,
  };
  const estimate = (history: readonly ExportCalibration[], encoder?: ExportEncoder) =>
    estimateExport(workload, output, "medium", "partition-pipes-v1", history, encoder);

  it("trusts a comparable measurement over the guess, and does not call it a guess", () => {
    const measured = estimate([sample]);
    expect(measured.seconds).toBe(1440); // 20 s for 100 s of video, scaled to 7200 s
    expect(measured.secondsGuessed).toBeUndefined();
    expect(measured).toEqual(
      estimateExportFromHistory(workload, output, "medium", "partition-pipes-v1", [sample]),
    );
  });

  it("guesses the time, and only the time, when nothing comparable was measured", () => {
    const histories = [
      [],
      [{ ...sample, revision: EXPORT_SPEED_REVISION - 1 }],
      [{ ...sample, quality: "high" }],
    ];
    for (const history of histories) {
      const guessed = estimate(history);
      expect(guessed.seconds).toBe(guessExportSeconds(workload, output));
      expect(guessed.secondsGuessed).toBe(true);
      expect([guessed.memoryBytes, guessed.temporaryBytes, guessed.finalBytes]).toEqual([
        null,
        null,
        null,
      ]);
    }
  });

  it("stays unknown where it cannot guess", () => {
    expect(
      estimateExport(
        { ...workload, durationSeconds: 0 },
        output,
        "medium",
        "partition-pipes-v1",
        [],
        "chip-amd",
      ),
    ).toEqual({
      seconds: null,
      memoryBytes: null,
      temporaryBytes: null,
      finalBytes: null,
    });
  });

  // Phase 3, S4 (found by a journey): an encoder nothing was measured for yet used to be estimated from a fresh guess, which
  // ignored what this PC measured for the processor, so a ten-minute export read as "8 seconds" on the chip.
  describe("for an encoder nothing was measured for yet (the graphics chip, the faster setting)", () => {
    const measured = {
      ...sample,
      workload,
      elapsedSeconds: 600,
      engine: "file-sequence-v1" as const,
    };
    const one = (encoder: ExportEncoder, history: readonly ExportCalibration[]) =>
      estimateExport(workload, output, "medium", "file-sequence-v1", history, encoder);

    it("is what the processor measured, divided by the cautious gain, and says it is not a measurement of its own", () => {
      for (const chip of ["chip-amd", "chip-nvidia", "chip-intel"] as const) {
        const e = one(chip, [measured]);
        expect(e.seconds, chip).toBe(Math.ceil(600 / CHIP_CAUTIOUS_GAIN));
        expect(e.secondsGuessed, chip).toBe(true);
        // Nothing but the time is inferred: sizes and memory are not claimed for an encoder that has not run here.
        expect([e.memoryBytes, e.temporaryBytes, e.finalBytes]).toEqual([null, null, null]);
      }
      expect(one("x264-fast", [measured]).seconds).toBe(Math.ceil(600 / FASTER_X264_GAIN));
    });

    it("prefers the encoder's own measurement, and never the processor's when it has one", () => {
      const own = { ...measured, encoder: "chip-amd" as const, elapsedSeconds: 200 };
      const e = one("chip-amd", [measured, own]);
      expect(e.seconds).toBe(200);
      expect(e.secondsGuessed).toBeUndefined();
    });

    it("follows the processor's measurement of the same threading: the streamed 4K engine keeps its own", () => {
      const big = { ...workload, width: 3840, height: 2160 };
      const bigOut = { width: 3840, height: 2160, fps: 30 };
      const twoThreads = {
        ...measured,
        workload: big,
        output: bigOut,
        engine: "partition-pipes-v1" as const,
        encoder: "x264-crf-threads2" as const,
        elapsedSeconds: 900,
      };
      const e = estimateExport(
        big,
        bigOut,
        "medium",
        "partition-pipes-v1",
        [twoThreads],
        "chip-amd",
      );
      expect(e.seconds).toBe(Math.ceil(900 / CHIP_CAUTIOUS_GAIN));
      expect(
        estimateExport(
          big,
          bigOut,
          "medium",
          "partition-pipes-v1",
          [twoThreads],
          "x264-fast-threads2",
        ).seconds,
      ).toBe(Math.ceil(900 / FASTER_X264_GAIN));
    });

    it("is the processor's guess divided by the gain, as before, when the processor has no measurement either", () => {
      expect(one("chip-amd", []).seconds).toBe(guessExportSeconds(workload, output, "chip-amd"));
      expect(one("chip-amd", []).secondsGuessed).toBe(true);
    });

    it("never reads slower than the processor it was inferred from, whatever was measured", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 1_000_000 }),
          fc.constantFrom("chip-amd", "chip-nvidia", "chip-intel", "x264-fast" as const),
          (elapsedSeconds, encoder) => {
            const processor = one("x264-crf", [{ ...measured, elapsedSeconds }]).seconds!;
            const inferred = one(encoder, [{ ...measured, elapsedSeconds }]).seconds!;
            expect(inferred).toBeLessThanOrEqual(processor);
            expect(inferred).toBeGreaterThan(0);
          },
        ),
      );
    });
  });
});

// The engine rule moved into one function (the planner and the export dialog both read it). The planner's
// old inline rule is frozen here, word for word, so the move is proven to change nothing.
describe("one rule for what leaves the one-pass encoder", () => {
  const legacy = (
    w: { width: number; height: number; peakVisualLayers: number; peakMediaLayers: number },
    c: { width: number; height: number },
  ) =>
    w.peakVisualLayers > 4 ||
    (w.width * w.height > 1920 * 1080 && w.peakMediaLayers > 1) ||
    exceedsFileSequencePicture(c);

  it("answers exactly as the planner's own rule did, for every project shape", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8192 }),
        fc.integer({ min: 2, max: 8192 }),
        fc.integer({ min: 0, max: 12 }),
        fc.integer({ min: 0, max: 12 }),
        fc.integer({ min: -1, max: 1 }),
        (width, height, visual, media, nudge) => {
          const workload = { width, height, peakVisualLayers: visual, peakMediaLayers: media };
          const composite = { width: width + nudge, height };
          expect(exceedsOnePass(workload, composite)).toBe(legacy(workload, composite));
        },
      ),
      { numRuns: 500 },
    );
  });

  it("pins the edges: five layers, more than one layer above 1080p, and a picture over 2560x1440", () => {
    const plain = { width: 1920, height: 1080, peakVisualLayers: 4, peakMediaLayers: 4 };
    expect(exceedsOnePass(plain, plain)).toBe(false);
    expect(exceedsOnePass({ ...plain, peakVisualLayers: 5 }, plain)).toBe(true);
    // 1080x1920 has the pixels of 1920x1080 (not above them): a vertical canvas is no heavier.
    expect(exceedsOnePass({ ...plain, width: 1080, height: 1920, peakMediaLayers: 3 }, plain)).toBe(
      false,
    );
    expect(exceedsOnePass({ ...plain, width: 2560, height: 1440, peakMediaLayers: 1 }, plain)).toBe(
      false,
    );
    expect(exceedsOnePass({ ...plain, width: 2560, height: 1440, peakMediaLayers: 2 }, plain)).toBe(
      true,
    );
    expect(exceedsOnePass(plain, { width: 3840, height: 2160 })).toBe(true);
  });
});

describe("what the export dialog says before the click", () => {
  const project: RenderWorkload = {
    width: 1920,
    height: 1080,
    fps: 30,
    durationSeconds: 120,
    visualClips: 6,
    captionClips: 1,
    audioClips: 1,
    peakVisualLayers: 2,
    peakMediaLayers: 2,
  };
  const settings = { resolution: "source", quality: "medium", fps: null, mode: "quality" } as const;
  const measuredSample = (over: Partial<ExportCalibration> = {}): ExportCalibration => ({
    workload: project,
    output: { width: 1920, height: 1080, fps: 30 },
    quality: "medium",
    engine: "file-sequence-v1",
    encoder: "x264-crf",
    revision: EXPORT_SPEED_REVISION,
    elapsedSeconds: 150,
    finalBytes: 48_000_000,
    memoryBytes: 1_000_000_000,
    temporaryBytes: null,
    ...over,
  });

  it("gives the measured time and file size of an earlier export like this one, and says so by not calling it a guess", () => {
    expect(estimateForDialog(project, settings, [measuredSample()])).toEqual({
      seconds: 150,
      guessed: false,
      finalBytes: 48_000_000,
    });
  });

  it("guesses the time (and only the time) when nothing like it has run here", () => {
    const shown = estimateForDialog(project, settings, []);
    expect(shown.guessed).toBe(true);
    expect(shown.seconds).toBeGreaterThan(0);
    expect(shown.finalBytes).toBeNull();
  });

  it("follows the settings: a smaller picture, quality or frame rate matches a different measurement", () => {
    const small = measuredSample({
      output: { width: 1280, height: 720, fps: 30 },
      elapsedSeconds: 70,
    });
    expect(estimateForDialog(project, { ...settings, resolution: "720p" }, [small]).seconds).toBe(
      70,
    );
    // The same history says nothing about the full-size export: that one is guessed.
    expect(estimateForDialog(project, settings, [small]).guessed).toBe(true);
    const high = measuredSample({ quality: "high", elapsedSeconds: 210 });
    expect(estimateForDialog(project, { ...settings, quality: "high" }, [high]).seconds).toBe(210);
    expect(estimateForDialog(project, settings, [high]).guessed).toBe(true);
    const slow = measuredSample({
      output: { width: 1920, height: 1080, fps: 60 },
      elapsedSeconds: 300,
    });
    expect(estimateForDialog(project, { ...settings, fps: 60 }, [slow]).seconds).toBe(300);
  });

  it("looks for the measurement of the engine and encoder the planner would choose", () => {
    // Five layers: the streamed engine, whose final encoder is the two-thread one above 1080p only.
    const heavy: RenderWorkload = { ...project, peakVisualLayers: 5 };
    const streamed = measuredSample({
      workload: heavy,
      engine: "partition-pipes-v1",
      encoder: "x264-crf",
      elapsedSeconds: 400,
    });
    expect(estimateForDialog(heavy, settings, [streamed]).seconds).toBe(400);
    // A measurement from the other engine is not this export's measurement.
    expect(
      estimateForDialog(heavy, settings, [{ ...streamed, engine: "file-sequence-v1" }]).guessed,
    ).toBe(true);
    // Above 1080p the streamed engine's encoder is the two-thread one.
    const big: RenderWorkload = { ...heavy, width: 3840, height: 2160 };
    const bigSample = measuredSample({
      workload: big,
      output: { width: 3840, height: 2160, fps: 30 },
      engine: "partition-pipes-v1",
      encoder: "x264-crf-threads2",
      elapsedSeconds: 900,
    });
    expect(estimateForDialog(big, settings, [bigSample]).seconds).toBe(900);
    expect(estimateForDialog(big, settings, [{ ...bigSample, encoder: "x264-crf" }]).guessed).toBe(
      true,
    );
  });

  it("tells Fast from Full only where there is a chip to run Fast on, and then guesses it cautiously", () => {
    const full = estimateForDialog(project, settings, []);
    // No chip named: Fast is the processor's, exactly as Full is.
    expect(estimateForDialog(project, { ...settings, mode: "fast" }, [])).toEqual(full);
    const fast = estimateForDialog(project, { ...settings, mode: "fast" }, [], { chip: "amd" });
    expect(fast.guessed).toBe(true);
    expect(fast.seconds!).toBeLessThan(full.seconds!);
    // Its own measurement, once there is one, is what it says; the processor's history says nothing about it.
    const measured = measuredSample({
      encoder: "chip-amd",
      elapsedSeconds: 33,
      finalBytes: 9_000_000,
    });
    expect(
      estimateForDialog(project, { ...settings, mode: "fast" }, [measured], { chip: "amd" }),
    ).toMatchObject({ seconds: 33, guessed: false, finalBytes: 9_000_000 });
    expect(estimateForDialog(project, settings, [measured]).guessed).toBe(true);
    // The faster setting is estimated under its own history too.
    const faster = estimateForDialog(project, settings, [], { faster: true });
    expect(faster.seconds!).toBeLessThan(full.seconds!);
  });

  it("never throws and never returns a negative or non-finite figure, whatever the project is", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20_000 }),
        fc.integer({ min: 0, max: 20_000 }),
        fc.double({ min: -1, max: 1e6, noNaN: false }),
        fc.double({ min: -1, max: 400, noNaN: false }),
        fc.constantFrom("source", "2160p", "1440p", "1080p", "720p", "480p"),
        fc.constantFrom("high", "medium", "low"),
        fc.constantFrom(null, 24, 30, 60, 500),
        fc.constantFrom("quality", "fast"),
        (width, height, seconds, fps, resolution, quality, rate, mode) => {
          const odd: RenderWorkload = { ...project, width, height, fps, durationSeconds: seconds };
          const shown = estimateForDialog(
            odd,
            { resolution, quality, fps: rate, mode } as never,
            [],
          );
          for (const figure of [shown.seconds, shown.finalBytes])
            if (figure !== null) expect(Number.isFinite(figure) && figure >= 0).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("how a time and a size are put to the person", () => {
  it("rounds to what a person plans around, never claims more than it knows", () => {
    expect(describeExportTime(0)).toBe("under a minute");
    expect(describeExportTime(44)).toBe("under a minute");
    expect(describeExportTime(45)).toBe("about 1 min");
    expect(describeExportTime(150)).toBe("about 3 min");
    expect(describeExportTime(59 * 60)).toBe("about 59 min");
    expect(describeExportTime(60 * 60)).toBe("about 1 h");
    expect(describeExportTime(80 * 60)).toBe("about 1 h 20 min");
    expect(describeExportTime(null)).toBe("");
    expect(describeExportTime(Number.NaN)).toBe("");
    expect(describeExportTime(-3)).toBe("");
    expect(describeExportSize(48_000_000)).toBe("about 48 MB");
    expect(describeExportSize(1_400_000_000)).toBe("about 1.4 GB");
    expect(describeExportSize(25_000_000_000)).toBe("about 25 GB");
    expect(describeExportSize(10)).toBe("about 1 MB");
    expect(describeExportSize(0)).toBe("");
    expect(describeExportSize(null)).toBe("");
  });

  it("is monotone: a longer export is never described as shorter", () => {
    const rank = (seconds: number) => {
      const text = describeExportTime(seconds);
      if (text === "under a minute") return 0;
      const hours = /(\d+) h/.exec(text);
      const minutes = /(\d+) min/.exec(text);
      return (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
    };
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 400_000 }),
        fc.integer({ min: 0, max: 5_000 }),
        (a, extra) => {
          expect(rank(a + extra)).toBeGreaterThanOrEqual(rank(a));
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("outputSize", () => {
  it("reads the preset off the SHORTER side, so it means the same thing in both orientations", () => {
    expect(outputSize(1920, 1080, "720p")).toEqual({ w: 1280, h: 720 });
    expect(outputSize(1080, 1920, "720p")).toEqual({ w: 720, h: 1280 });
  });

  it("emits nothing when the canvas already matches", () => {
    expect(outputSize(1920, 1080, "1080p")).toBeNull();
    expect(outputSize(1080, 1920, "1080p")).toBeNull();
  });

  it("emits nothing for 'source' or no preset at all", () => {
    expect(outputSize(1920, 1080, "source")).toBeNull();
    expect(outputSize(1920, 1080, undefined)).toBeNull();
  });

  it("never UPSCALES — asking 2160p of a 720p project invents detail and costs a fortune", () => {
    expect(outputSize(1280, 720, "2160p")).toBeNull();
    expect(outputSize(1280, 720, "1080p")).toBeNull();
  });

  it("keeps the aspect ratio it was given", () => {
    const r = outputSize(2560, 1080, "480p"); // an ultrawide
    expect(r).not.toBeNull();
    expect(r!.w / r!.h).toBeCloseTo(2560 / 1080, 1);
  });

  it("refuses to produce an odd dimension, which ffmpeg cannot encode to yuv420p", () => {
    // The failure this guards is not cosmetic: libx264 + yuv420p aborts with "width not
    // divisible by 2", so an odd result means the export simply fails.
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8000 }),
        fc.integer({ min: 2, max: 8000 }),
        fc.constantFrom("2160p", "1440p", "1080p", "720p", "480p" as const),
        (w, h, preset) => {
          const r = outputSize(w, h, preset);
          if (!r) return;
          expect(r.w % 2).toBe(0);
          expect(r.h % 2).toBe(0);
          expect(r.w).toBeGreaterThanOrEqual(2);
          expect(r.h).toBeGreaterThanOrEqual(2);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("never returns a size LARGER than the canvas, for any input (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8000 }),
        fc.integer({ min: 2, max: 8000 }),
        fc.constantFrom("2160p", "1440p", "1080p", "720p", "480p" as const),
        (w, h, preset) => {
          const r = outputSize(w, h, preset);
          if (!r) return;
          expect(r.w).toBeLessThanOrEqual(w + 1); // +1 for the even-rounding step
          expect(r.h).toBeLessThanOrEqual(h + 1);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("shrugs off a degenerate canvas instead of emitting a broken filter", () => {
    expect(outputSize(0, 1080, "720p")).toBeNull();
    expect(outputSize(1920, 0, "720p")).toBeNull();
  });
});

describe("crfFor", () => {
  it("leaves libx264 on its own default when no quality was chosen", () => {
    // Load-bearing: this is what keeps a default export byte-identical to what it was before
    // presets existed.
    expect(crfFor(undefined)).toBeNull();
  });

  it("gets better as the label gets better", () => {
    expect(crfFor("high")).toBeLessThan(crfFor("medium")!);
    expect(crfFor("medium")).toBeLessThan(crfFor("low")!);
  });
});

describe("outputFps", () => {
  it("uses the canvas rate when nothing was asked for", () => {
    expect(outputFps(30, undefined)).toBe(30);
  });

  it("uses the requested rate when it is usable", () => {
    expect(outputFps(30, 60)).toBe(60);
    expect(outputFps(30, 24)).toBe(24);
  });

  it("falls back to the canvas rate rather than emitting nonsense", () => {
    for (const bad of [0, -1, 121, NaN, Infinity]) expect(outputFps(30, bad)).toBe(30);
  });

  it("always returns a rate ffmpeg will accept (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 120 }),
        fc.double({ min: -1000, max: 1000, noNaN: false }),
        (canvas, requested) => {
          const r = outputFps(canvas, requested);
          expect(Number.isInteger(r)).toBe(true);
          expect(r).toBeGreaterThanOrEqual(1);
          expect(r).toBeLessThanOrEqual(120);
        },
      ),
      { numRuns: 300 },
    );
  });
});

// Phase 3, S4: which encoder an export is estimated and recorded under. Today's exports keep today's ids.
describe("the encoder an export runs and is remembered under", () => {
  const phone = { width: 1080, height: 1920 };
  const fourK = { width: 3840, height: 2160 };

  it("is today's, id for id, for every export that uses neither the chip nor the faster setting", () => {
    expect(finalEncoderPolicy(phone, "file-sequence-v1")).toEqual({
      encoder: "x264-crf",
      threads: null,
    });
    expect(finalEncoderPolicy(phone, "partition-pipes-v1")).toEqual({
      encoder: "x264-crf",
      threads: 1,
    });
    expect(finalEncoderPolicy(fourK, "partition-pipes-v1")).toEqual({
      encoder: "x264-crf-threads2",
      threads: 2,
    });
    expect(finalEncoderPolicy(fourK, "file-sequence-v1", "quality")).toEqual({
      encoder: "x264-crf",
      threads: null,
    });
  });

  it("is the maker's chip when Fast runs on that chip, and the processor when there is no chip to run on", () => {
    expect(finalEncoderPolicy(phone, "file-sequence-v1", "fast", { chip: "amd" })).toEqual({
      encoder: "chip-amd",
      threads: null,
    });
    expect(finalEncoderPolicy(fourK, "partition-pipes-v1", "fast", { chip: "nvidia" })).toEqual({
      encoder: "chip-nvidia",
      threads: 1,
    });
    expect(finalEncoderPolicy(phone, "file-sequence-v1", "fast", { chip: "intel" }).encoder).toBe(
      "chip-intel",
    );
    // Fast with no chip cannot be a chip: it is the processor's, exactly as Full would be.
    expect(finalEncoderPolicy(phone, "file-sequence-v1", "fast")).toEqual(
      finalEncoderPolicy(phone, "file-sequence-v1", "quality"),
    );
    // And a chip that is named while Full is asked for is not used.
    expect(finalEncoderPolicy(phone, "file-sequence-v1", "quality", { chip: "amd" }).encoder).toBe(
      "x264-crf",
    );
  });

  it("is the faster setting's own id, with the two-thread variant where the streamed engine has one", () => {
    expect(finalEncoderPolicy(phone, "file-sequence-v1", "quality", { faster: true }).encoder).toBe(
      "x264-fast",
    );
    expect(finalEncoderPolicy(fourK, "partition-pipes-v1", "quality", { faster: true })).toEqual({
      encoder: "x264-fast-threads2",
      threads: 2,
    });
    // The chip wins over the faster setting: they are never combined.
    expect(
      finalEncoderPolicy(phone, "file-sequence-v1", "fast", { chip: "amd", faster: true }).encoder,
    ).toBe("chip-amd");
  });
});
