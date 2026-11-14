import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { CostClip, CostShape } from "./costShape";
import { estimate, type EstimateRequest } from "./estimator";
import { EXPORT_SPEED_REVISION } from "./exportOptions";

const NASTY: readonly unknown[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -1,
  0,
  1e-9,
  1e308,
  Number.MAX_VALUE,
  Number.MIN_VALUE,
  2 ** 53,
  undefined,
  null,
  "12",
  "",
  true,
  {},
  [],
  [1, 2],
];

const clip = (over: Partial<CostClip> = {}): CostClip => ({
  id: "a",
  kind: "video",
  frames: 900,
  mp: 2.07,
  sourceMp: 2.07,
  tenBit: false,
  bytesPerPixel: 1.5,
  known: false,
  loads: {
    cover_zoom: { frames: 900, windowFrames: 900, mp: 2.5 },
    fade: { frames: 900, windowFrames: 15, mp: 2.07 },
  },
  ...over,
});
const good = (): EstimateRequest => {
  const shape: CostShape = {
    canvas: { width: 1920, height: 1080, fps: 30 },
    canvasFrames: 900,
    frames: { video: 900, still: 0, caption: 0, audio: 0 },
    clips: [clip()],
    common: { captions: { frames: 900, windowFrames: 100, mp: 2.07 } },
    layerFrames: 900,
    peakLayers: 1,
    meanLayers: 1,
    captionBands: 1,
    inputs: { video: 1, still: 0, audio: 1 },
    unknownSources: 1,
    unpricedFeatures: 1,
  };
  const workload = {
    width: 1920,
    height: 1080,
    fps: 30,
    durationSeconds: 30,
    visualClips: 1,
    captionClips: 1,
    audioClips: 1,
    peakVisualLayers: 1,
    peakMediaLayers: 1,
  };
  return {
    workload,
    shape,
    output: { width: 1920, height: 1080, fps: 30, quality: "medium" },
    route: { family: "processor", faster: false, chipMaker: null, quick: false },
    pace: { rHat: 0.5, aFps: 80, bFps: 32, cFps: 60, cores: 8, cls: "ok" },
    correction: 1.2,
    history: [
      {
        workload,
        output: { width: 1920, height: 1080, fps: 30 },
        quality: "medium",
        engine: "file-sequence-v1",
        encoder: "x264-crf",
        revision: EXPORT_SPEED_REVISION,
        elapsedSeconds: 40,
        finalBytes: 1e7,
        memoryBytes: 1e9,
        temporaryBytes: 1e8,
      },
    ],
    recipeOf: () => "lean",
    flags: { estimate_v2: true, pc_check: true },
  };
};

/** Every position of a request that carries a number the estimator reads. */
const POSITIONS: ReadonlyArray<readonly (string | number)[]> = [
  ["workload", "width"],
  ["workload", "height"],
  ["workload", "fps"],
  ["workload", "durationSeconds"],
  ["workload", "visualClips"],
  ["workload", "audioClips"],
  ["workload", "peakVisualLayers"],
  ["workload", "peakMediaLayers"],
  ["output", "width"],
  ["output", "height"],
  ["output", "fps"],
  ["output", "quality"],
  ["pace", "rHat"],
  ["pace", "aFps"],
  ["pace", "bFps"],
  ["pace", "cFps"],
  ["pace", "cores"],
  ["pace", "cls"],
  ["correction"],
  ["rung"],
  ["engine"],
  ["nowMs"],
  ["route", "family"],
  ["route", "chipMaker"],
  ["route", "faster"],
  ["shape", "canvasFrames"],
  ["shape", "layerFrames"],
  ["shape", "unpricedFeatures"],
  ["shape", "inputs", "video"],
  ["shape", "inputs", "audio"],
  ["shape", "clips", 0, "frames"],
  ["shape", "clips", 0, "mp"],
  ["shape", "clips", 0, "id"],
  ["shape", "clips", 0, "known"],
  ["shape", "clips", 0, "loads", "cover_zoom", "frames"],
  ["shape", "clips", 0, "loads", "cover_zoom", "windowFrames"],
  ["shape", "clips", 0, "loads", "cover_zoom", "mp"],
  ["shape", "clips", 0, "loads", "fade"],
  ["shape", "common", "captions", "frames"],
  ["history", 0, "elapsedSeconds"],
  ["history", 0, "finalBytes"],
  ["history", 0, "workload", "durationSeconds"],
  ["history", 0, "workload", "width"],
  ["history", 0, "output", "fps"],
  ["history", 0, "revision"],
  ["history", 0, "engine"],
  ["history", 0, "encoder"],
  ["flags"],
  ["flags", "estimate_v2"],
  ["flags", "pc_check"],
  ["recipeOf"],
  ["history"],
  ["shape"],
  ["pace"],
  ["workload"],
  ["output"],
  ["route"],
];

const setAt = (request: EstimateRequest, path: readonly (string | number)[], value: unknown) => {
  const copy = structuredClone({ ...request, recipeOf: undefined }) as Record<string, unknown>;
  copy.recipeOf = request.recipeOf;
  let node: Record<string | number, unknown> = copy;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (typeof next !== "object" || next === null) return copy as unknown as EstimateRequest;
    node = next as Record<string | number, unknown>;
  }
  node[path[path.length - 1]] = value;
  return copy as unknown as EstimateRequest;
};

/** The one thing every answer must be: nothing, or a whole, ordered, positive, finite estimate with its words and family in their lists. */
const assertSound = (result: ReturnType<typeof estimate>, label: string) => {
  if (result === null) return;
  expect(Number.isInteger(result.seconds), label).toBe(true);
  expect(Number.isInteger(result.low), label).toBe(true);
  expect(Number.isInteger(result.high), label).toBe(true);
  expect(result.low, label).toBeGreaterThanOrEqual(1);
  expect(result.low, label).toBeLessThanOrEqual(result.seconds);
  expect(result.seconds, label).toBeLessThanOrEqual(result.high);
  expect(Number.isFinite(result.high), label).toBe(true);
  expect(["pc_check", "history", "guess"], label).toContain(result.basis);
  expect(["processor", "chip"], label).toContain(result.family);
  expect(typeof result.muchLonger, label).toBe("boolean");
  if (result.bytes !== null) {
    expect(Number.isFinite(result.bytes), label).toBe(true);
    expect(result.bytes, label).toBeGreaterThanOrEqual(0);
  }
};

describe("estimate: garbage in, nothing or a sound estimate out", () => {
  it("survives every number the estimator reads being replaced by every kind of nonsense, with the flag on and off", () => {
    for (const flag of [true, false])
      for (const path of POSITIONS)
        for (const value of NASTY) {
          const request = setAt(good(), path, value);
          const label = `${path.join(".")} = ${String(value)} (v2 ${flag})`;
          const flagged = {
            ...request,
            flags: flag
              ? { estimate_v2: true, pc_check: true }
              : { estimate_v2: false, pc_check: false },
          } as EstimateRequest;
          // Only a request whose flags were themselves replaced keeps the replacement.
          const sent = path[0] === "flags" ? request : flagged;
          let result: ReturnType<typeof estimate>;
          expect(() => {
            result = estimate(sent);
          }, label).not.toThrow();
          assertSound(result!, label);
        }
  });

  it("answers null, not an exception, for requests that are not requests", () => {
    for (const nonsense of [undefined, null, 0, "x", [], {}, () => 1, Symbol("x")])
      expect(estimate(nonsense as never), String(nonsense)).toBeNull();
  });

  it("absurd rates give a bounded estimate, never an infinite or negative one", () => {
    const request = setAt(
      setAt(good(), ["pace", "rHat"], 1e300),
      ["workload", "durationSeconds"],
      1e300,
    );
    const result = estimate(request);
    assertSound(result, "absurd");
    expect(result!.seconds).toBeLessThanOrEqual(1e9);
    const tiny = estimate(setAt(good(), ["pace", "rHat"], 1e-300));
    assertSound(tiny, "tiny");
    expect(tiny!.seconds).toBeGreaterThanOrEqual(1);
  });

  it("a shape of fifty thousand clips is priced without hanging", () => {
    const request = good();
    request.shape = {
      ...request.shape!,
      clips: Array.from({ length: 50_000 }, (_, index) => clip({ id: `c${index}` })),
    };
    const started = Date.now();
    assertSound(estimate(request), "big");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("random requests of random garbage", () => {
    const loose = fc.oneof(fc.anything(), fc.constantFrom(...NASTY));
    const number = fc.oneof(fc.double(), fc.integer(), fc.constantFrom(...NASTY));
    const object = (fields: Record<string, fc.Arbitrary<unknown>>) =>
      fc.oneof(fc.record(fields, { requiredKeys: [] }), loose);
    const request = fc.record(
      {
        workload: object({
          width: number,
          height: number,
          fps: number,
          durationSeconds: number,
          visualClips: number,
          captionClips: number,
          audioClips: number,
          peakVisualLayers: number,
          peakMediaLayers: number,
        }),
        shape: fc.oneof(
          fc.constant(null),
          object({
            clips: fc.oneof(
              loose,
              fc.array(
                object({
                  id: loose,
                  frames: number,
                  known: loose,
                  loads: object({
                    cover_zoom: object({ frames: number, windowFrames: number, mp: number }),
                    fade: loose,
                    warp: loose,
                  }),
                }),
                { maxLength: 4 },
              ),
            ),
            common: object({
              captions: object({ frames: number, windowFrames: number, mp: number }),
            }),
            inputs: object({ video: number, still: number, audio: number }),
            unpricedFeatures: number,
          }),
        ),
        output: object({ width: number, height: number, fps: number, quality: loose }),
        route: object({ family: loose, faster: loose, chipMaker: loose, quick: loose }),
        pace: fc.oneof(
          fc.constant(null),
          object({
            rHat: number,
            aFps: number,
            bFps: number,
            cFps: number,
            cores: number,
            cls: loose,
          }),
        ),
        correction: number,
        history: fc.oneof(
          loose,
          fc.array(
            object({
              workload: object({
                width: number,
                durationSeconds: number,
                peakVisualLayers: number,
              }),
              output: object({ width: number, fps: number }),
              quality: loose,
              engine: loose,
              encoder: loose,
              revision: number,
              elapsedSeconds: number,
              finalBytes: number,
            }),
            { maxLength: 3 },
          ),
        ),
        recipeOf: fc.constantFrom(
          undefined,
          () => "lean" as const,
          () => {
            throw new Error("no decision");
          },
          () => 7 as never,
        ),
        flags: object({ estimate_v2: loose, pc_check: loose }),
        engine: loose,
        rung: loose,
        nowMs: number,
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(request, (req) => {
        let result: ReturnType<typeof estimate>;
        expect(() => {
          result = estimate(req as unknown as EstimateRequest);
        }).not.toThrow();
        assertSound(result!, "random");
      }),
      { numRuns: 1500 },
    );
  });
});
