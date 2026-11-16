import { describe, expect, it } from "vitest";

import {
  COST_FEATURES,
  summarizeCostShape,
  type CostClip,
  type CostFeature,
  type CostShape,
  type FeatureLoad,
  type FeatureLoads,
} from "./costShape";
import { FEATURE_PRICES, RANGE } from "./costTable";
import { estimate, type EstimateRequest, type PcPace } from "./estimator";
import { EXPORT_SPEED_REVISION, type ExportCalibration } from "./exportOptions";
import { emptyTimeline, type Clip } from "./model";
import { summarizeRenderWorkload, type RenderWorkload } from "./renderPlan";

const MP = (1080 * 1920) / 1e6;

const workload = (over: Partial<RenderWorkload> = {}): RenderWorkload => ({
  width: 1920,
  height: 1080,
  fps: 30,
  durationSeconds: 120,
  visualClips: 1,
  captionClips: 0,
  audioClips: 1,
  peakVisualLayers: 1,
  peakMediaLayers: 1,
  ...over,
});
const load = (frames: number, windowFrames = frames, mp = MP): FeatureLoad => ({
  frames,
  windowFrames,
  mp,
});
const clip = (over: Partial<CostClip> = {}): CostClip => ({
  id: "a",
  kind: "video",
  frames: 3600,
  mp: MP,
  sourceMp: MP,
  tenBit: false,
  bytesPerPixel: 1.5,
  known: true,
  loads: {},
  ...over,
});
const shapeOf = (clips: CostClip[], over: Partial<CostShape> = {}): CostShape => ({
  canvas: { width: 1920, height: 1080, fps: 30 },
  canvasFrames: 3600,
  frames: { video: 3600, still: 0, caption: 0, audio: 0 },
  clips,
  common: {},
  layerFrames: clips.reduce((sum, entry) => sum + entry.frames, 0),
  peakLayers: clips.length > 0 ? 1 : 0,
  meanLayers: 1,
  captionBands: 0,
  inputs: { video: clips.length, still: 0, audio: 1 },
  unknownSources: clips.filter((entry) => !entry.known).length,
  unpricedFeatures: 0,
  ...over,
});
/** The audit's PC: the reference export takes about 0.4 s a second of video, and 40 percent of it is reading and mixing (the table's own split). */
const labPace: PcPace = { rHat: 0.4, aFps: 80, bFps: 32, cFps: 60, cores: 16, cls: "fast" };
const V2 = { estimate_v2: true, pc_check: true } as const;

const request = (over: Partial<EstimateRequest> = {}): EstimateRequest => ({
  workload: workload(),
  shape: shapeOf([clip()]),
  output: { width: 1920, height: 1080, fps: 30, quality: "medium" },
  route: { family: "processor", faster: false, chipMaker: null, quick: false },
  pace: labPace,
  correction: null,
  history: [],
  flags: V2,
  ...over,
});
const seconds = (over: Partial<EstimateRequest> = {}) => estimate(request(over))!.seconds;
const withLoads = (loads: FeatureLoads, over: Partial<CostClip> = {}) =>
  shapeOf([clip({ loads, ...over })]);
const heavy = withLoads({ cover_zoom: load(3600, 3600, 2.5) });

const sample = (over: Partial<ExportCalibration> = {}): ExportCalibration => ({
  workload: workload(),
  output: { width: 1920, height: 1080, fps: 30 },
  quality: "medium",
  engine: "file-sequence-v1",
  encoder: "x264-crf",
  revision: EXPORT_SPEED_REVISION,
  elapsedSeconds: 130,
  finalBytes: 90e6,
  memoryBytes: 1.4e9,
  temporaryBytes: 4e8,
  ...over,
});

describe("estimate: the legacy path (estimate_v2 off)", () => {
  const off = { estimate_v2: false, pc_check: true } as const;

  it("is 0.27.0's number, and nothing the new model reads can move it", () => {
    const plain = estimate(request({ flags: off, shape: null, pace: null }))!;
    expect(plain.basis).toBe("guess");
    expect(plain.low).toBe(plain.seconds);
    expect(plain.high).toBe(plain.seconds);
    expect(plain.muchLonger).toBe(false);
    const crowded = estimate(
      request({
        flags: off,
        shape: heavy,
        pace: { ...labPace, rHat: 9 },
        correction: 7,
        recipeOf: () => "lean",
        rung: 2,
        route: { family: "processor", faster: false, chipMaker: null, quick: true },
      }),
    )!;
    expect(crowded).toEqual(plain);
  });

  it("is a measurement when a matching earlier export exists, and says so", () => {
    const measured = estimate(
      request({
        flags: off,
        history: [sample({ elapsedSeconds: 130 }), sample({ elapsedSeconds: 200 })],
      }),
    )!;
    expect(measured.basis).toBe("history");
    expect(measured.seconds).toBe(200);
    expect(measured.bytes).toBe(90e6);
    expect(measured.low).toBe(200);
  });

  it("keeps 0.27.0's whole-time divisors for a route nothing was measured for (the new model never does)", () => {
    // 0.27.0 divides the processor's whole time by 1.5 for a chip; the new model divides only the encode term.
    const processor = estimate(
      request({ flags: off, history: [sample({ elapsedSeconds: 600 })] }),
    )!;
    const chip = estimate(
      request({
        flags: off,
        history: [sample({ elapsedSeconds: 600 })],
        route: { family: "chip", faster: false, chipMaker: "amd", quick: false },
      }),
    )!;
    expect(processor.seconds).toBe(600);
    expect(chip.seconds).toBe(400);
    expect(chip.basis).toBe("guess");
    expect(chip.family).toBe("chip");
    expect(chip.bytes).toBeNull();
  });

  it("promises at least a second, and no estimate for what 0.27.0 could not estimate", () => {
    const empty = workload({ durationSeconds: 0, visualClips: 0, captionClips: 0, audioClips: 0 });
    expect(estimate(request({ flags: off, workload: empty }))).toBeNull();
    // 0.27.0 gives a project of no length that matches an earlier export 0 s; the record says 1.
    const matched = estimate(request({ flags: off, workload: empty, history: [sample()] }));
    expect(matched?.seconds).toBe(1);
    expect(matched?.basis).toBe("history");
    expect(estimate(request({ flags: off, workload: workload({ width: 0 }) }))).toBeNull();
  });

  it("reads an unnamed quality as Medium, and a chip route without a maker as the processor", () => {
    const named = estimate(request({ flags: off }))!;
    const unnamed = estimate(
      request({ flags: off, output: { width: 1920, height: 1080, fps: 30, quality: undefined } }),
    )!;
    expect(unnamed).toEqual(named);
    const noMaker = estimate(
      request({
        flags: off,
        route: { family: "chip", faster: false, chipMaker: null, quick: false },
      }),
    )!;
    expect(noMaker).toEqual(named);
    expect(noMaker.family).toBe("processor");
  });

  it("takes the engine the caller names, as the admission door does", () => {
    const history = [
      sample({ engine: "partition-pipes-v1", encoder: "x264-crf", elapsedSeconds: 333 }),
    ];
    expect(estimate(request({ flags: off, history }))!.basis).toBe("guess");
    expect(estimate(request({ flags: off, history, engine: "partition-pipes-v1" }))).toMatchObject({
      basis: "history",
      seconds: 333,
    });
  });
});

describe("estimate: where the number comes from", () => {
  it("a matching earlier export speaks first: its maximum, a narrow range, whatever the PC check says", () => {
    const history = [sample({ elapsedSeconds: 130 }), sample({ elapsedSeconds: 200 })];
    const result = estimate(request({ history }))!;
    expect(result.basis).toBe("history");
    expect(result.seconds).toBe(200);
    expect(result.bytes).toBe(90e6);
    // Narrow enough to be said as one number (DESIGN 3.4: high / low of 1.8 or less).
    expect(result.low).toBeLessThanOrEqual(130);
    expect(result.high).toBeGreaterThanOrEqual(200);
    expect(result.high / result.low).toBeLessThanOrEqual(2.5);
    expect(result.seconds / result.low).toBeLessThanOrEqual(1.8);
    expect(result.high / result.seconds).toBeLessThanOrEqual(1.8);
    expect(estimate(request({ history, pace: null, shape: null }))).toEqual(result);
    expect(estimate(request({ history, correction: 5 }))).toEqual(result);
  });

  it("an export of another shape is not matched and does not throw the estimate off", () => {
    const other = sample({ workload: workload({ peakVisualLayers: 3, peakMediaLayers: 3 }) });
    const result = estimate(request({ history: [other] }))!;
    expect(result.basis).toBe("pc_check");
    expect(result).toEqual(estimate(request())!);
  });

  it("a PC check gives its own number, and no usable check gives a rough guess on a prior PC, with a wider range", () => {
    const checked = estimate(request())!;
    expect(checked.basis).toBe("pc_check");
    for (const pace of [
      null,
      { ...labPace, cls: "unfinished" as const },
      { ...labPace, cls: "unknown" as const },
      { ...labPace, rHat: Number.NaN },
      { ...labPace, rHat: -2 },
    ]) {
      const guessed = estimate(request({ pace }))!;
      expect(guessed.basis, JSON.stringify(pace)).toBe("guess");
      expect(guessed.high / guessed.low).toBeGreaterThan(checked.high / checked.low);
    }
    expect(estimate(request({ flags: { estimate_v2: true, pc_check: false } }))!.basis).toBe(
      "guess",
    );
  });

  it("a check that could not finish is priced as a weak PC: slower than the prior PC, still a rough guess, whatever pace the record carries", () => {
    const never = estimate(request({ pace: null }))!;
    const stuck = estimate(request({ pace: { ...labPace, cls: "unfinished" as const } }))!;
    const slowStuck = estimate(
      request({ pace: { ...labPace, rHat: 9, cls: "unfinished" as const } }),
    )!;
    expect(stuck.basis).toBe("guess");
    expect(stuck.seconds).toBeGreaterThan(never.seconds);
    expect(stuck.high).toBeGreaterThan(never.high);
    // nothing was measured, so what the record says about its own speed is not believed
    expect(slowStuck).toEqual(stuck);
  });

  it("a faster PC check gives a smaller number than a slower one", () => {
    expect(seconds({ pace: { ...labPace, rHat: 0.4 } })).toBeLessThan(
      seconds({ pace: { ...labPace, rHat: 4 } }),
    );
  });

  it("the prior PC prices a plain project at about what the field's median export took, 2.4 times the video", () => {
    const guess = estimate(request({ pace: null }))!;
    expect(guess.seconds / 120).toBeGreaterThan(1.5);
    expect(guess.seconds / 120).toBeLessThan(4);
  });

  it("always says low <= seconds <= high, in whole seconds, at least one", () => {
    for (const shape of [shapeOf([]), heavy, null]) {
      const result = estimate(request({ shape }))!;
      expect(
        Number.isInteger(result.seconds) &&
          Number.isInteger(result.low) &&
          Number.isInteger(result.high),
      ).toBe(true);
      expect(result.low).toBeGreaterThanOrEqual(1);
      expect(result.low).toBeLessThanOrEqual(result.seconds);
      expect(result.seconds).toBeLessThanOrEqual(result.high);
    }
  });

  it("says 'could take much longer' when the shape is unknown or a feature cannot be priced", () => {
    expect(estimate(request())!.muchLonger).toBe(false);
    expect(estimate(request({ shape: null }))!.muchLonger).toBe(true);
    expect(
      estimate(request({ shape: { ...shapeOf([clip()]), unpricedFeatures: 1 } }))!.muchLonger,
    ).toBe(true);
    expect(
      estimate(request({ shape: { ...shapeOf([clip()]), unpricedFeatures: 1 } }))!.high,
    ).toBeGreaterThan(estimate(request())!.high);
  });

  it("says it as well when the range itself is that wide, with nothing unknown or unpriced in the project", () => {
    // A guess on the prior PC with a learned correction at its lowest: the high end is over four times the central figure.
    const result = estimate(request({ pace: null, correction: 0.2 }))!;
    expect(result.high).toBeGreaterThan(RANGE.muchLongerOver * result.seconds);
    expect(result.muchLonger).toBe(true);
    const narrow = estimate(request())!;
    expect(narrow.high).toBeLessThanOrEqual(RANGE.muchLongerOver * narrow.seconds);
    expect(narrow.muchLonger).toBe(false);
  });

  it("an unknown source widens the range upward and leaves the central figure where it was", () => {
    const loads = { still_decode: load(900, 900, 4), cover_zoom: load(900, 900, 5) };
    const known = estimate(request({ shape: shapeOf([clip({ loads, known: true })]) }))!;
    const unknown = estimate(request({ shape: shapeOf([clip({ loads, known: false })]) }))!;
    expect(unknown.seconds).toBe(known.seconds);
    expect(unknown.low).toBe(known.low);
    expect(unknown.high).toBeGreaterThan(known.high);
  });

  it("an unknown shape is priced on a prior and widens upward, never narrowing", () => {
    const known = estimate(request({ shape: shapeOf([clip()]) }))!;
    const unknown = estimate(request({ shape: null }))!;
    expect(unknown.high).toBeGreaterThan(known.high);
    expect(unknown.low).toBeGreaterThanOrEqual(1);
  });
});

describe("estimate: what the project costs", () => {
  it("prices a project that is only the reference export at what the PC check measured for it", () => {
    const rHat = labPace.rHat;
    const result = estimate(request({ shape: shapeOf([clip()]) }))!;
    // The reference export's own time is rHat x the video; the extras are the watermark, the end card and a few seconds of start-up.
    expect(result.seconds).toBeGreaterThan(rHat * 120);
    expect(result.seconds).toBeLessThan(rHat * 120 * 1.3 + 15);
  });

  it("a cover zoom costs the audit's order of magnitude: about a second a frame at the audit's PC, which 0.27.0 cannot see", () => {
    const frames = 90;
    const plain = shapeOf([clip({ frames })], { canvasFrames: frames });
    const zoomed = shapeOf([clip({ frames, loads: { cover_zoom: load(frames, frames, 2.5) } })], {
      canvasFrames: frames,
    });
    const base = request({
      workload: workload({ durationSeconds: frames / 30 }),
      pace: { ...labPace, rHat: 0.39 },
    });
    const perFrame =
      (estimate({ ...base, shape: zoomed })!.seconds -
        estimate({ ...base, shape: plain })!.seconds) /
      frames;
    // FILTER-MAP.md 8.5: 1.17 to 1.2 s a frame canvas-aspect, 2.5 to 2.75 s on a 16:9 clip; 0.27.0 says 0.03.
    expect(perFrame).toBeGreaterThan(0.4);
    expect(perFrame).toBeLessThan(3);
    const legacy = estimate({
      ...base,
      shape: zoomed,
      flags: { estimate_v2: false, pc_check: true },
    })!;
    expect(legacy.seconds / frames).toBeLessThan(0.5);
  });

  it("matches the audit's whole-project runs within a factor of two, from a timeline through the shape", () => {
    // Z1G-V: a 45-frame video clip, cover zoom 1.0 to 1.1, the lab grade, 1080x1920: 57 s measured, 1,268 ms a frame.
    const build = (frames: number) => {
      const raw = emptyTimeline(1080, 1920, 30);
      const grade = {
        contrast: 1.06,
        exposure: 0.05,
        highlights: -0.06,
        saturation: 1.04,
        shadows: 0.04,
        temperature: 6900,
        vibrance: 0.1,
      };
      const zoom: Clip = {
        id: "z",
        kind: "video",
        media_ref: "z.mp4",
        timeline_in: 0,
        timeline_out: frames,
        fit: "cover",
        color: grade,
        transform: {
          scale: [
            { t: 0, v: 1 },
            { t: frames, v: 1.1 },
          ],
        },
      };
      raw.tracks = [{ id: "v1", kind: "video", z: 0, clips: [zoom] }];
      const shape = summarizeCostShape(raw, {
        facts: () => ({
          width: 1080,
          height: 1920,
          fps: 30,
          codec: "h264",
          pixFmt: "yuv420p",
          hasAlpha: false,
        }),
      });
      const base = summarizeRenderWorkload(raw);
      return estimate({
        workload: base,
        shape,
        output: { width: 1080, height: 1920, fps: 30, quality: "medium" },
        route: { family: "processor", faster: false, chipMaker: null, quick: false },
        pace: { ...labPace, rHat: 0.39 },
        correction: null,
        history: [],
        flags: V2,
      })!.seconds;
    };
    const perFrame = (build(90) - build(45)) / 45;
    expect(perFrame).toBeGreaterThan(1.268 / 2);
    expect(perFrame).toBeLessThan(1.268 * 2);
  });

  it("a PC whose encoder is the slow part is priced differently from one whose reading and mixing is", () => {
    const slowEncoder = { ...labPace, aFps: 90, bFps: 18 };
    const slowReading = { ...labPace, aFps: 24, bFps: 22 };
    // A busy project is mostly reading and mixing; a plain one delivered at 4K is mostly encoding.
    expect(seconds({ shape: heavy, pace: slowReading })).toBeGreaterThan(
      seconds({ shape: heavy, pace: slowEncoder }),
    );
    const encodeBound = {
      output: { width: 3840, height: 2160, fps: 30, quality: "medium" },
    } as const;
    expect(seconds({ ...encodeBound, pace: slowEncoder })).toBeGreaterThan(
      seconds({ ...encodeBound, pace: slowReading }),
    );
  });

  it("the streamed engine reads and mixes slower, and a gentler rung is slower, never faster", () => {
    expect(seconds({ engine: "partition-pipes-v1" })).toBeGreaterThan(
      seconds({ engine: "file-sequence-v1" }),
    );
    expect(seconds({ rung: 1 })).toBeGreaterThan(seconds({ rung: 0 }));
    expect(seconds({ rung: 2 })).toBeGreaterThan(seconds({ rung: 1 }));
    expect(seconds({ rung: 0 })).toBe(seconds());
  });

  it("a bigger or smoother delivery costs more to encode, and a quality tier moves only the processor", () => {
    expect(
      seconds({ output: { width: 3840, height: 2160, fps: 30, quality: "medium" } }),
    ).toBeGreaterThan(seconds());
    expect(
      seconds({ output: { width: 1920, height: 1080, fps: 60, quality: "medium" } }),
    ).toBeGreaterThan(seconds());
    expect(
      seconds({ output: { width: 1920, height: 1080, fps: 30, quality: "high" } }),
    ).toBeGreaterThan(seconds());
    expect(
      seconds({ output: { width: 1920, height: 1080, fps: 30, quality: "low" } }),
    ).toBeLessThan(seconds());
    const chip = (quality: "high" | "low") =>
      seconds({
        route: { family: "chip", faster: false, chipMaker: "amd", quick: false },
        output: { width: 1920, height: 1080, fps: 30, quality },
      });
    expect(chip("high")).toBe(chip("low"));
  });
});

describe("estimate: a route divides only the encode term", () => {
  const amd = { family: "chip", faster: false, chipMaker: "amd", quick: false } as const;
  const faster = { family: "processor", faster: true, chipMaker: null, quick: false } as const;
  const saving = (shape: CostShape, route: EstimateRequest["route"]) => {
    const standard = seconds({ shape });
    return (standard - seconds({ shape, route })) / standard;
  };

  it("a plain project saves a lot on the chip and a busy one saves almost nothing (the lab: 5 to 10 percent on busy projects)", () => {
    const plain = shapeOf([clip()]);
    expect(saving(plain, amd)).toBeGreaterThan(0.25);
    expect(saving(heavy, amd)).toBeLessThan(0.1);
    expect(saving(heavy, amd)).toBeGreaterThan(0);
    // The faster setting saves less than the chip on a plain project, and almost nothing on a busy one.
    expect(saving(plain, faster)).toBeGreaterThan(0.15);
    expect(saving(plain, faster)).toBeLessThan(saving(plain, amd));
    expect(saving(heavy, faster)).toBeLessThan(0.05);
  });

  it("saves the same SECONDS on any project of the same length, however much reading and mixing it asks for", () => {
    const gains = [1, 4, 16, 64].map((times) => {
      const shape = withLoads({ cover_zoom: load(900 * times, 900 * times, 2.5) });
      return seconds({ shape }) - seconds({ shape, route: amd });
    });
    for (const gain of gains) expect(Math.abs(gain - gains[0])).toBeLessThanOrEqual(2);
  });

  it("never claims more than the encode term could save, and not the old whole-time divisor on a project with a lot of reading", () => {
    const busy = withLoads({ cover_zoom: load(3600, 3600, 2.5) });
    // 0.27.0 would say the chip takes 2/3 of the time for every project; the encode term of this one is a sliver of its time.
    expect(seconds({ shape: busy, route: amd }) / seconds({ shape: busy })).toBeGreaterThan(0.9);
  });

  it("a measured chip export beats the model's gain; a measured processor export keeps its level and moves only the encode term", () => {
    const processorRun = sample({ elapsedSeconds: 600 });
    const derived = estimate(request({ history: [processorRun], route: amd }))!;
    expect(derived.basis).toBe("history");
    expect(derived.bytes).toBeNull();
    expect(derived.family).toBe("chip");
    expect(derived.seconds).toBeLessThan(600);
    expect(derived.seconds).toBeGreaterThan(600 / 4);
    const busyDerived = estimate(request({ shape: heavy, history: [processorRun], route: amd }))!;
    expect(busyDerived.seconds).toBeGreaterThan(derived.seconds);
    const chipRun = sample({ elapsedSeconds: 250, encoder: "chip-amd" });
    expect(estimate(request({ history: [processorRun, chipRun], route: amd }))).toMatchObject({
      basis: "history",
      seconds: 250,
      bytes: 90e6,
    });
    // A processor request is never answered from the chip's run.
    expect(estimate(request({ history: [chipRun] }))!.basis).toBe("pc_check");
  });

  it("a PC whose speed test measured a smaller faster-setting gain than the lab's is priced on its own", () => {
    const plain = shapeOf([clip()]);
    const lab = seconds({ shape: plain, route: faster, pace: labPace });
    const slowFaster = seconds({ shape: plain, route: faster, pace: { ...labPace, cFps: 41 } });
    expect(slowFaster).toBeGreaterThan(lab);
    const none = seconds({ shape: plain, pace: { ...labPace, cFps: 41 } });
    expect(slowFaster).toBeLessThanOrEqual(none);
  });
});

describe("estimate: Quick is the same function on Quick's own size, rate and encoder", () => {
  const quickRoute = { family: "processor", faster: true, chipMaker: null, quick: true } as const;
  const quickOutput = { width: 1280, height: 720, fps: 30, quality: "medium" } as const;

  it("saves a lot on a plain project", () => {
    const plain = shapeOf([clip()]);
    const standard = seconds({ shape: plain });
    const quick = seconds({ shape: plain, output: { ...quickOutput }, route: quickRoute });
    expect(quick).toBeLessThan(standard * 0.7);
    // ...and a Quick on the chip saves more than one on the faster setting.
    const onChip = seconds({
      shape: plain,
      output: { ...quickOutput },
      route: { family: "chip", faster: false, chipMaker: "amd", quick: true },
    });
    expect(onChip).toBeLessThan(quick);
  });

  it("saves little where reading and drawing are the time, which 'Standard divided by 2.1' would not", () => {
    const standard = seconds({ shape: heavy });
    const quick = seconds({ shape: heavy, output: { ...quickOutput }, route: quickRoute });
    expect(quick).toBeLessThanOrEqual(standard);
    expect(quick / standard).toBeGreaterThan(0.9);
    expect(quick).toBeGreaterThan(standard / 2.1);
  });

  it("the label alone changes nothing: the number comes from the size, the rate and the encoder", () => {
    const route = { ...quickRoute, quick: false };
    expect(estimate(request({ route: quickRoute }))).toEqual(estimate(request({ route })));
    expect(estimate(request({ route: { ...quickRoute, quick: true }, shape: heavy }))).toEqual(
      estimate(request({ route: { ...quickRoute, quick: false }, shape: heavy })),
    );
  });
});

describe("estimate: recipe honesty", () => {
  const featureShape = (feature: CostFeature) =>
    withLoads({ [feature]: load(36_000, 600, 2.5) }, { frames: 36_000 });
  const priced = (feature: CostFeature, recipeOf?: EstimateRequest["recipeOf"]) =>
    estimate(
      request({
        shape: featureShape(feature),
        workload: workload({ durationSeconds: 1200 }),
        ...(recipeOf ? { recipeOf } : {}),
      }),
    )!;

  it("a project on the lean recipe is never dearer than one on today's, feature by feature", () => {
    for (const feature of COST_FEATURES) {
      const today = priced(feature);
      const lean = priced(feature, () => "lean");
      expect(lean.seconds, feature).toBeLessThanOrEqual(today.seconds);
      const { today: now, lean: fixed } = FEATURE_PRICES[feature];
      if (fixed.frame < now.frame)
        expect(lean.seconds, `${feature} is cheaper when fixed`).toBeLessThan(today.seconds);
      else expect(lean.seconds, `${feature} has no fix`).toBe(today.seconds);
    }
  });

  it("prices a clip on today's recipe when nothing says otherwise, when the decision throws, or answers nonsense", () => {
    const shape = withLoads({ cover_zoom: load(3600, 3600, 2.5) });
    const today = seconds({ shape });
    expect(seconds({ shape, recipeOf: () => "today" })).toBe(today);
    expect(
      seconds({
        shape,
        recipeOf: () => {
          throw new Error("no decision");
        },
      }),
    ).toBe(today);
    expect(seconds({ shape, recipeOf: () => "fast" as never })).toBe(today);
    expect(seconds({ shape, recipeOf: () => "lean" })).toBeLessThan(today);
  });

  it("prices each clip on its own recipe: a mixed project sits between all-today and all-lean", () => {
    const shape = shapeOf(
      ["a", "b", "c"].map((id) =>
        clip({ id, frames: 1200, loads: { cover_zoom: load(1200, 1200, 2.5) } }),
      ),
    );
    const none = seconds({ shape });
    const all = seconds({ shape, recipeOf: () => "lean" });
    const some = seconds({ shape, recipeOf: (id) => (id === "a" ? "lean" : "today") });
    expect(all).toBeLessThan(some);
    expect(some).toBeLessThan(none);
  });
});

describe("estimate: what a learned correction may do", () => {
  it("moves the central figure inside the range the model stood behind, and never moves the range", () => {
    const plain = estimate(request())!;
    for (const correction of [0.25, 0.5, 1, 2, 8, 1e-9, 1e9]) {
      const learned = estimate(request({ correction }))!;
      expect(learned.low, String(correction)).toBe(plain.low);
      expect(learned.high, String(correction)).toBe(plain.high);
      expect(learned.seconds, String(correction)).toBeGreaterThanOrEqual(plain.low);
      expect(learned.seconds, String(correction)).toBeLessThanOrEqual(plain.high);
    }
    expect(seconds({ correction: 1.3 })).toBeGreaterThan(seconds());
    expect(seconds({ correction: 0.8 })).toBeLessThan(seconds());
    expect(seconds({ correction: 1.4 })).toBeGreaterThanOrEqual(seconds({ correction: 1.3 }));
  });

  it("ignores a correction that is not a usable ratio", () => {
    const plain = estimate(request())!;
    for (const correction of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -2,
      0,
      "x" as never,
      {} as never,
    ])
      expect(estimate(request({ correction })), String(correction)).toEqual(plain);
  });

  it("only changes numbers: the route and the encoder family it was asked for come back as asked", () => {
    for (const route of [
      { family: "processor", faster: false, chipMaker: null, quick: false },
      { family: "chip", faster: false, chipMaker: "nvidia", quick: false },
    ] as const) {
      const learned = estimate(request({ route, correction: 8 }))!;
      expect(learned.family).toBe(route.family);
      expect(learned.basis).toBe("pc_check");
    }
  });
});

describe("estimate: input it cannot use", () => {
  it("gives no estimate for a project of no length, a picture of no size or garbage", () => {
    expect(estimate(request({ workload: workload({ durationSeconds: 0 }) }))).toBeNull();
    expect(estimate(request({ workload: workload({ width: Number.NaN }) }))).toBeNull();
    expect(
      estimate(request({ output: { width: 1920, height: 1080, fps: 0, quality: "medium" } })),
    ).toBeNull();
    expect(estimate(null as never)).toBeNull();
    expect(estimate({} as never)).toBeNull();
    expect(estimate(request({ history: "nope" as never }))).toEqual(estimate(request()));
    expect(estimate(request({ history: [null, 3, { workload: 1 }] as never }))).toEqual(
      estimate(request()),
    );
  });

  it("falls back to the legacy path when the flags themselves are garbage", () => {
    const legacy = estimate(request({ flags: { estimate_v2: false, pc_check: false } }));
    expect(estimate(request({ flags: undefined as never }))).toEqual(legacy);
    expect(estimate(request({ flags: { estimate_v2: "yes" as never, pc_check: true } }))).toEqual(
      legacy,
    );
  });

  it("a feature the table does not know is priced at nothing and never breaks the estimate", () => {
    const shape = shapeOf([clip({ loads: { warp_drive: load(100) } as unknown as FeatureLoads })]);
    expect(estimate(request({ shape }))).toEqual(estimate(request({ shape: shapeOf([clip()]) })));
  });
});
