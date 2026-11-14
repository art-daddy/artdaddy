import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  COST_FEATURES,
  type CostClip,
  type CostShape,
  type FeatureLoad,
  type FeatureLoads,
} from "./costShape";
import { estimate, type EstimateRequest, type PcPace } from "./estimator";
import { EXPORT_SPEED_REVISION, type ExportCalibration, type ExportQuality } from "./exportOptions";

const SIZES: ReadonlyArray<readonly [number, number]> = [
  [1280, 720],
  [1920, 1080],
  [1080, 1920],
  [2560, 1440],
  [3840, 2160],
];

const loadArb: fc.Arbitrary<FeatureLoad> = fc
  .record({
    frames: fc.integer({ min: 1, max: 5000 }),
    window: fc.integer({ min: 0, max: 5000 }),
    mp: fc.double({ min: 0, max: 12, noNaN: true }),
  })
  .map(({ frames, window, mp }) => ({ frames, windowFrames: Math.min(window, frames), mp }));

const loadsArb: fc.Arbitrary<FeatureLoads> = fc
  .array(fc.tuple(fc.constantFrom(...COST_FEATURES), loadArb), { maxLength: 5 })
  .map((entries) => Object.fromEntries(entries));

const clipArb: fc.Arbitrary<CostClip> = fc
  .record({
    id: fc.constantFrom("a", "b", "c", "d", "e"),
    kind: fc.constantFrom("video" as const, "still" as const),
    frames: fc.integer({ min: 1, max: 4000 }),
    mp: fc.double({ min: 0.1, max: 8, noNaN: true }),
    known: fc.boolean(),
    loads: loadsArb,
  })
  .map((entry) => ({ ...entry, sourceMp: entry.mp, tenBit: false, bytesPerPixel: 1.5 }));

const shapeArb: fc.Arbitrary<CostShape> = fc
  .record({
    clips: fc.array(clipArb, { maxLength: 4 }),
    common: loadsArb,
    unpricedFeatures: fc.integer({ min: 0, max: 2 }),
  })
  .map(({ clips, common, unpricedFeatures }) => ({
    canvas: { width: 1920, height: 1080, fps: 30 },
    canvasFrames: 3600,
    frames: { video: 0, still: 0, caption: 0, audio: 0 },
    clips,
    common,
    layerFrames: clips.reduce((sum, entry) => sum + entry.frames, 0),
    peakLayers: clips.length,
    meanLayers: clips.length,
    captionBands: 0,
    inputs: { video: clips.length, still: 0, audio: 1 },
    unknownSources: clips.filter((entry) => !entry.known).length,
    unpricedFeatures,
  }));

const paceArb: fc.Arbitrary<PcPace> = fc
  .record({
    rHat: fc.double({ min: 0.1, max: 20, noNaN: true }),
    a: fc.double({ min: 20, max: 400, noNaN: true }),
    b: fc.double({ min: 0.2, max: 0.95, noNaN: true }),
    c: fc.double({ min: 1.1, max: 3, noNaN: true }),
    cores: fc.integer({ min: 2, max: 32 }),
    cls: fc.constantFrom("fast" as const, "ok" as const, "weak" as const),
  })
  .map(({ rHat, a, b, c, cores, cls }) => ({
    rHat,
    aFps: a,
    bFps: a * b,
    cFps: a * b * c,
    cores,
    cls,
  }));

const requestArb: fc.Arbitrary<EstimateRequest> = fc
  .record({
    size: fc.constantFrom(...SIZES),
    fps: fc.constantFrom(24, 30, 60),
    durationSeconds: fc.integer({ min: 30, max: 1800 }),
    visualClips: fc.integer({ min: 1, max: 12 }),
    audioClips: fc.integer({ min: 0, max: 3 }),
    layers: fc.integer({ min: 1, max: 6 }),
    shape: fc.option(shapeArb, { nil: null, freq: 6 }),
    pace: fc.option(paceArb, { nil: null, freq: 4 }),
    quality: fc.constantFrom<ExportQuality>("high", "medium", "low"),
    correction: fc.option(fc.double({ min: 0.25, max: 8, noNaN: true }), { nil: null }),
    rung: fc.constantFrom(0 as const, 1 as const, 2 as const),
  })
  .map((r) => ({
    workload: {
      width: r.size[0],
      height: r.size[1],
      fps: r.fps,
      durationSeconds: r.durationSeconds,
      visualClips: r.visualClips,
      captionClips: 0,
      audioClips: r.audioClips,
      peakVisualLayers: r.layers,
      peakMediaLayers: Math.max(1, r.layers - 1),
    },
    shape: r.shape,
    output: { width: r.size[0], height: r.size[1], fps: r.fps, quality: r.quality },
    route: { family: "processor" as const, faster: false, chipMaker: null, quick: false },
    pace: r.pace,
    correction: r.correction,
    history: [],
    flags: { estimate_v2: true, pc_check: true },
    rung: r.rung,
  }));

const must = (req: EstimateRequest) => {
  const result = estimate(req);
  expect(result, "a valid request has an estimate").not.toBeNull();
  return result!;
};
const withClip = (shape: CostShape | null, extra: CostClip): CostShape => {
  const base = shape ?? {
    canvas: { width: 1920, height: 1080, fps: 30 },
    canvasFrames: 3600,
    frames: { video: 0, still: 0, caption: 0, audio: 0 },
    clips: [],
    common: {},
    layerFrames: 0,
    peakLayers: 0,
    meanLayers: 0,
    captionBands: 0,
    inputs: { video: 0, still: 0, audio: 0 },
    unknownSources: 0,
    unpricedFeatures: 0,
  };
  return {
    ...base,
    clips: [...base.clips, extra],
    inputs: { ...base.inputs, video: base.inputs.video + 1 },
  };
};
const heavyClip = (times: number): CostClip => ({
  id: "heavy",
  kind: "video",
  frames: 900,
  mp: 2.5,
  sourceMp: 2.5,
  tenBit: false,
  bytesPerPixel: 1.5,
  known: true,
  loads: { cover_zoom: { frames: 900 * times, windowFrames: 900 * times, mp: 2.5 } },
});
const known = (shape: CostShape | null): CostShape | null =>
  shape && {
    ...shape,
    clips: shape.clips.map((entry) => ({ ...entry, known: true })),
    unpricedFeatures: 0,
  };

describe("estimate: properties", () => {
  it("is whole, ordered and at least a second for any usable request, and its basis follows its inputs", () => {
    fc.assert(
      fc.property(requestArb, (req) => {
        const result = must(req);
        expect(Number.isInteger(result.seconds)).toBe(true);
        expect(Number.isInteger(result.low) && Number.isInteger(result.high)).toBe(true);
        expect(result.low).toBeGreaterThanOrEqual(1);
        expect(result.low).toBeLessThanOrEqual(result.seconds);
        expect(result.seconds).toBeLessThanOrEqual(result.high);
        expect(result.basis).toBe(req.pace ? "pc_check" : "guess");
        expect(result.family).toBe("processor");
        expect(result.bytes).toBeNull();
        if (req.shape === null) expect(result.muchLonger).toBe(true);
      }),
    );
  });

  it("with the flag off is a point whatever else the request carries", () => {
    fc.assert(
      fc.property(requestArb, (req) => {
        const off = estimate({ ...req, flags: { estimate_v2: false, pc_check: true } });
        if (off === null) return;
        expect(off.low).toBe(off.seconds);
        expect(off.high).toBe(off.seconds);
        const stripped = estimate({
          ...req,
          shape: null,
          pace: null,
          correction: null,
          rung: undefined,
          flags: { estimate_v2: false, pc_check: false },
        });
        expect(off).toEqual(stripped);
      }),
    );
  });

  describe("never lowered by more work", () => {
    const grow = (shape: CostShape, factor: number): CostShape => ({
      ...shape,
      common: scaleLoads(shape.common, factor),
      clips: shape.clips.map((entry) => ({
        ...entry,
        frames: Math.ceil(entry.frames * factor),
        loads: scaleLoads(entry.loads, factor),
      })),
    });
    const scaleLoads = (loads: FeatureLoads, factor: number): FeatureLoads =>
      Object.fromEntries(
        Object.entries(loads).map(([feature, load]) => [
          feature,
          {
            frames: load.frames * factor,
            windowFrames: load.windowFrames * factor,
            mp: load.mp * factor,
          },
        ]),
      );
    const never = (change: (req: EstimateRequest) => EstimateRequest, name: string) =>
      it(name, () => {
        fc.assert(
          fc.property(requestArb, (req) => {
            expect(must(change(req)).seconds).toBeGreaterThanOrEqual(must(req).seconds);
          }),
        );
      });

    it("more layers: another clip", () => {
      fc.assert(
        fc.property(requestArb, clipArb, (req, extra) => {
          if (req.shape === null) return;
          expect(
            must({ ...req, shape: withClip(req.shape, extra) }).seconds,
          ).toBeGreaterThanOrEqual(must(req).seconds);
        }),
      );
    });

    it("more effects: any feature of any clip running on more frames, at a larger size", () => {
      fc.assert(
        fc.property(requestArb, fc.double({ min: 1, max: 4, noNaN: true }), (req, factor) => {
          if (req.shape === null) return;
          expect(must({ ...req, shape: grow(req.shape, factor) }).seconds).toBeGreaterThanOrEqual(
            must(req).seconds,
          );
        }),
      );
    });

    it("a feature added to a clip", () => {
      fc.assert(
        fc.property(
          requestArb,
          fc.constantFrom(...COST_FEATURES),
          loadArb,
          (req, feature, extra) => {
            if (req.shape === null || req.shape.clips.length === 0) return;
            const [first, ...rest] = req.shape.clips;
            const loads = { ...first.loads };
            const have = loads[feature];
            loads[feature] = have
              ? {
                  frames: have.frames + extra.frames,
                  windowFrames: have.windowFrames + extra.windowFrames,
                  mp: Math.max(have.mp, extra.mp),
                }
              : extra;
            expect(
              must({ ...req, shape: { ...req.shape, clips: [{ ...first, loads }, ...rest] } })
                .seconds,
            ).toBeGreaterThanOrEqual(must(req).seconds);
          },
        ),
      );
    });

    never(
      (req) => ({
        ...req,
        workload: { ...req.workload, durationSeconds: req.workload.durationSeconds + 600 },
      }),
      "a longer video",
    );
    never(
      (req) => ({
        ...req,
        workload: {
          ...req.workload,
          peakVisualLayers: req.workload.peakVisualLayers + 2,
          peakMediaLayers: req.workload.peakMediaLayers + 2,
        },
      }),
      "more simultaneous layers (the engine may change)",
    );
    never(
      (req) => ({
        ...req,
        output: { ...req.output, width: req.output.width * 2, height: req.output.height * 2 },
      }),
      "a bigger delivered picture",
    );
    never(
      (req) => ({ ...req, output: { ...req.output, fps: req.output.fps * 2 } }),
      "a faster delivered rate",
    );
    never((req) => ({ ...req, rung: req.rung === 0 ? 1 : 2 }), "a gentler rung");
    never(
      (req) => ({ ...req, engine: "partition-pipes-v1" }),
      "the streamed engine in place of whatever the workload chose, when that was the one-pass one",
    );
    never(
      (req) => ({
        ...req,
        output: { ...req.output, quality: req.output.quality === "low" ? "medium" : "high" },
      }),
      "a higher quality tier",
    );

    it("a slower PC: every speed of its check lower by the same factor", () => {
      fc.assert(
        fc.property(requestArb, fc.double({ min: 1, max: 6, noNaN: true }), (req, slower) => {
          if (req.pace === null) return;
          const pace = {
            ...req.pace,
            rHat: req.pace.rHat * slower,
            aFps: req.pace.aFps! / slower,
            bFps: req.pace.bFps! / slower,
            cFps: req.pace.cFps! / slower,
          };
          expect(must({ ...req, pace }).seconds).toBeGreaterThanOrEqual(must(req).seconds);
        }),
      );
    });

    it("a larger learned correction", () => {
      fc.assert(
        fc.property(
          requestArb,
          fc.double({ min: 0.25, max: 8, noNaN: true }),
          fc.double({ min: 0, max: 4, noNaN: true }),
          (req, low, extra) => {
            expect(must({ ...req, correction: low + extra }).seconds).toBeGreaterThanOrEqual(
              must({ ...req, correction: low }).seconds,
            );
          },
        ),
      );
    });
  });

  describe("a route divides only the encode term", () => {
    const routes: ReadonlyArray<EstimateRequest["route"]> = [
      { family: "processor", faster: true, chipMaker: null, quick: false },
      { family: "chip", faster: false, chipMaker: "amd", quick: false },
      { family: "chip", faster: false, chipMaker: "nvidia", quick: false },
      { family: "chip", faster: false, chipMaker: "intel", quick: false },
    ];

    it("the same seconds are saved however much reading and mixing the project asks for, so the share saved shrinks as that grows", () => {
      fc.assert(
        fc.property(requestArb, fc.constantFrom(...routes), (req, route) => {
          const saved = (times: number) => {
            const shape = withClip(known(req.shape), heavyClip(times));
            const standard = must({ ...req, shape, correction: null }).seconds;
            const faster = must({ ...req, shape, route, correction: null }).seconds;
            expect(faster).toBeLessThanOrEqual(standard);
            return { seconds: standard - faster, standard };
          };
          const light = saved(1);
          const medium = saved(8);
          const busy = saved(64);
          expect(Math.abs(medium.seconds - light.seconds)).toBeLessThanOrEqual(2);
          expect(Math.abs(busy.seconds - light.seconds)).toBeLessThanOrEqual(2);
          // The share saved, with what whole-second rounding of the two times can add (two seconds in the saving).
          expect(medium.seconds / medium.standard).toBeLessThanOrEqual(
            light.seconds / light.standard + 2 / medium.standard,
          );
          expect(busy.seconds / busy.standard).toBeLessThanOrEqual(
            medium.seconds / medium.standard + 2 / busy.standard,
          );
        }),
      );
    });

    it("a project that is almost all reading and mixing saves under a tenth, on any route", () => {
      fc.assert(
        fc.property(requestArb, fc.constantFrom(...routes), (req, route) => {
          const shape = withClip(known(req.shape), heavyClip(20_000));
          const standard = must({ ...req, shape, correction: null }).seconds;
          const faster = must({ ...req, shape, route, correction: null }).seconds;
          expect((standard - faster) / standard).toBeLessThan(0.1);
        }),
      );
    });
  });

  describe("Quick is the same function on Quick's own size, rate and encoder", () => {
    const quickOf = (req: EstimateRequest, chip: boolean): EstimateRequest => ({
      ...req,
      output: {
        ...req.output,
        width: Math.min(req.output.width, req.output.width >= req.output.height ? 1280 : 720),
        height: Math.min(req.output.height, req.output.width >= req.output.height ? 720 : 1280),
        fps: Math.min(req.output.fps, 30),
      },
      route: chip
        ? { family: "chip", faster: false, chipMaker: "amd", quick: true }
        : { family: "processor", faster: true, chipMaker: null, quick: true },
    });

    it("never costs more than Full quality, and saves the same seconds whatever the reading and mixing", () => {
      fc.assert(
        fc.property(requestArb, fc.boolean(), (req, chip) => {
          const saved = (times: number) => {
            const shape = withClip(known(req.shape), heavyClip(times));
            const full = must({ ...req, shape, correction: null }).seconds;
            const quick = must({ ...quickOf(req, chip), shape, correction: null }).seconds;
            expect(quick).toBeLessThanOrEqual(full);
            return full - quick;
          };
          const light = saved(1);
          expect(Math.abs(saved(16) - light)).toBeLessThanOrEqual(2);
          expect(Math.abs(saved(256) - light)).toBeLessThanOrEqual(2);
        }),
      );
    });

    it("saves under a tenth on a project that is almost all reading and drawing", () => {
      fc.assert(
        fc.property(requestArb, fc.boolean(), (req, chip) => {
          const shape = withClip(known(req.shape), heavyClip(20_000));
          const full = must({ ...req, shape, correction: null }).seconds;
          const quick = must({ ...quickOf(req, chip), shape, correction: null }).seconds;
          expect((full - quick) / full).toBeLessThan(0.1);
        }),
      );
    });

    it("the label changes nothing", () => {
      fc.assert(
        fc.property(requestArb, fc.boolean(), (req, chip) => {
          const quick = quickOf(req, chip);
          expect(estimate({ ...quick, route: { ...quick.route, quick: false } })).toEqual(
            estimate(quick),
          );
        }),
      );
    });
  });

  describe("recipe honesty", () => {
    it("lean is never dearer than a mix, and a mix is never dearer than today's", () => {
      fc.assert(
        fc.property(
          requestArb,
          fc.array(fc.constantFrom("a", "b", "c", "d", "e"), { maxLength: 5 }),
          (req, leanIds) => {
            const today = must(req).seconds;
            const lean = must({ ...req, recipeOf: () => "lean" }).seconds;
            const mixed = must({
              ...req,
              recipeOf: (id) => ((leanIds as readonly string[]).includes(id) ? "lean" : "today"),
            }).seconds;
            expect(lean).toBeLessThanOrEqual(mixed);
            expect(mixed).toBeLessThanOrEqual(today);
            expect(must({ ...req, recipeOf: () => "today" }).seconds).toBe(today);
          },
        ),
      );
    });
  });

  describe("what a learned correction may do", () => {
    it("never takes the estimate outside the range it reports, whatever the log says, and never moves the range", () => {
      fc.assert(
        fc.property(
          requestArb,
          fc.oneof(
            fc.double({ min: 0.25, max: 8, noNaN: true }),
            fc.constantFrom(0.25, 8, 1e-12, 1e12, Number.MAX_VALUE, Number.MIN_VALUE),
          ),
          (req, correction) => {
            const clean = must({ ...req, correction: null });
            const learned = must({ ...req, correction });
            expect(learned.low).toBe(clean.low);
            expect(learned.high).toBe(clean.high);
            expect(learned.seconds).toBeGreaterThanOrEqual(clean.low);
            expect(learned.seconds).toBeLessThanOrEqual(clean.high);
            expect(learned.basis).toBe(clean.basis);
            expect(learned.family).toBe(clean.family);
          },
        ),
      );
    });
  });

  describe("what is not known widens the range upward only", () => {
    it("an unknown source or an unpriced feature leaves the central figure and the low end alone and never narrows the high end", () => {
      fc.assert(
        fc.property(requestArb, (req) => {
          if (req.shape === null) return;
          const sure = { ...req, shape: known(req.shape) };
          const unsure = {
            ...req,
            shape: {
              ...req.shape,
              clips: req.shape.clips.map((entry) => ({ ...entry, known: false })),
            },
          };
          const a = must(sure);
          const b = must(unsure);
          expect(b.seconds).toBe(a.seconds);
          expect(b.low).toBe(a.low);
          expect(b.high).toBeGreaterThanOrEqual(a.high);
          const more = must({ ...sure, shape: { ...sure.shape!, unpricedFeatures: 2 } });
          expect(more.seconds).toBe(a.seconds);
          expect(more.high).toBeGreaterThanOrEqual(a.high);
          expect(more.muchLonger).toBe(true);
        }),
      );
    });
  });

  describe("earlier exports", () => {
    it("speak first, by 0.27.0's rule, whatever the PC check, the shape or a learned correction say", () => {
      fc.assert(
        fc.property(
          requestArb,
          fc.array(fc.integer({ min: 20, max: 5000 }), { minLength: 1, maxLength: 4 }),
          (base, elapsed) => {
            const req: EstimateRequest = { ...base, engine: "file-sequence-v1" };
            const history: ExportCalibration[] = elapsed.map((seconds) => ({
              workload: req.workload,
              output: { width: req.output.width, height: req.output.height, fps: req.output.fps },
              quality: req.output.quality ?? "medium",
              engine: "file-sequence-v1",
              revision: EXPORT_SPEED_REVISION,
              elapsedSeconds: seconds,
              finalBytes: 1e6 * seconds,
              memoryBytes: null,
              temporaryBytes: null,
            }));
            const result = must({ ...req, history });
            expect(result.basis).toBe("history");
            expect(result.seconds).toBe(Math.max(...elapsed));
            expect(must({ ...req, history, pace: null, shape: null, correction: 7 })).toEqual(
              result,
            );
          },
        ),
      );
    });
  });
});
