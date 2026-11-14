import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { CostClip, CostShape } from "./costShape";
import type { ExportEngine } from "./exportOptions";
import type { Rung } from "./exportPlan";
import { MEMORY_TABLE, predictShapePeakMiB, type ShapeMemoryInput } from "./shapeMemory";

const clip = (over: Partial<CostClip> = {}): CostClip => ({
  id: "c",
  kind: "video",
  frames: 100,
  mp: 2.0736,
  sourceMp: 2.0736,
  tenBit: false,
  bytesPerPixel: 1.5,
  known: true,
  loads: {},
  ...over,
});
const shapeOf = (
  clips: CostClip[],
  over: Partial<CostShape> & { audio?: number } = {},
): CostShape => {
  const { audio = 1, ...rest } = over;
  return {
    canvas: { width: 1080, height: 1920, fps: 30 },
    canvasFrames: 1000,
    frames: { video: 0, still: 0, caption: 0, audio: 0 },
    clips,
    common: {},
    layerFrames: 0,
    peakLayers: 1,
    meanLayers: 1,
    captionBands: 0,
    inputs: { video: 0, still: 0, audio },
    unknownSources: 0,
    unpricedFeatures: 0,
    ...rest,
  };
};
const videos = (count: number, over: Partial<CostClip> = {}) =>
  Array.from({ length: count }, (_, index) => clip({ id: `v${index}`, ...over }));
const pictures = (
  count: number,
  sourceMp: number,
  bytesPerPixel: number,
  over: Partial<CostClip> = {},
) =>
  Array.from({ length: count }, (_, index) =>
    clip({ id: `s${index}`, kind: "still", sourceMp, bytesPerPixel, ...over }),
  );
const peak = (shape: CostShape | null, over: Partial<ShapeMemoryInput> = {}): number | null =>
  predictShapePeakMiB({ engine: "file-sequence-v1", rung: 0, shape, cores: 16, ...over });
const graded = { grade_rgb: { frames: 100, windowFrames: 100, mp: 2.07 } };

describe("predictShapePeakMiB: what it says, against what was measured", () => {
  it("reproduces the code's own lab note for a decode-bound clip: 8K HEVC to 1080x1920, 3.52 GiB at rung 0, 0.83 at rung 1, 0.76 at rung 2", () => {
    // exportPlan.ts, lines 7 to 8. One 7680 x 4320 clip of 10-bit HEVC: 33.2 megapixels at 3 bytes a pixel.
    const eightK = shapeOf([clip({ sourceMp: 33.18, bytesPerPixel: 3, tenBit: true })]);
    const lab = [3.52, 0.83, 0.76].map((gib) => gib * 1024);
    for (const rung of [0, 1, 2] as const) {
      const predicted = peak(eightK, { rung })!;
      expect(predicted, `rung ${rung}`).toBeGreaterThan(lab[rung] * 0.8);
      expect(predicted, `rung ${rung}`).toBeLessThan(lab[rung] * 1.6);
    }
    const [normal, gentle, gentlest] = [0, 1, 2].map((rung) =>
      peak(eightK, { rung: rung as Rung })!,
    );
    expect(gentle / normal).toBeGreaterThan(0.1);
    expect(gentle / normal).toBeLessThan(0.4);
    expect(gentlest).toBeLessThanOrEqual(gentle);
  });

  it("lands within a factor of two and a half of lane L3's RED peaks on approximate shapes (a sanity check, not a fit)", () => {
    // Peak working set, MiB, on 16 logical processors (red\RED-TABLE.md); the shapes are read off RED-NOTES.md and are approximate.
    const rows: Array<[string, CostShape, ExportEngine, number]> = [
      ["BASE-V: one clip", shapeOf(videos(1)), "file-sequence-v1", 489],
      [
        "R3: a talking head with a cover zoom",
        shapeOf(videos(1, { loads: { cover_zoom: { frames: 90, windowFrames: 90, mp: 3.24 } } })),
        "file-sequence-v1",
        1011,
      ],
      [
        "R4: a montage of six clips",
        shapeOf(videos(6), { peakLayers: 2 }),
        "file-sequence-v1",
        1368,
      ],
      [
        "R9: a graded reel of 21 clips",
        shapeOf(videos(21, { loads: graded })),
        "file-sequence-v1",
        3601,
      ],
      [
        "R1a: two clips and four PNG pictures, graded, zooming",
        shapeOf(
          [
            ...videos(2, { loads: graded }),
            ...pictures(4, 3.1, 3, {
              loads: { ...graded, cover_zoom: { frames: 150, windowFrames: 150, mp: 3.35 } },
            }),
          ],
          { peakLayers: 2 },
        ),
        "file-sequence-v1",
        2406,
      ],
      ["R8b: thirty 12 MP photos", shapeOf(pictures(30, 12, 1.5)), "file-sequence-v1", 3441],
      [
        "R12: twenty-four 4K PNG pictures",
        shapeOf(pictures(24, 8.3, 3), { peakLayers: 2 }),
        "file-sequence-v1",
        13299,
      ],
      [
        "R4 on the streamed engine",
        shapeOf(videos(6), { peakLayers: 2 }),
        "partition-pipes-v1",
        864,
      ],
      [
        "R6: a 4K canvas on the streamed engine",
        shapeOf(videos(2, { sourceMp: 8.3, mp: 8.3 }), {
          canvas: { width: 3840, height: 2160, fps: 30 },
        }),
        "partition-pipes-v1",
        1949,
      ],
    ];
    for (const [name, shape, engine, measured] of rows) {
      const predicted = peak(shape, { engine })!;
      expect(predicted / measured, name).toBeGreaterThan(0.4);
      expect(predicted / measured, name).toBeLessThan(2.5);
    }
  });

  it("says the 24 big PNG pictures will not fit under the 8 GiB ceiling, on a 16-processor PC and on an 8-processor one: they did not", () => {
    // RED: 13,299 MiB on 16 processors and 9,655 on the 8-thread rig, both above exportPlan.ts's CEILING_CAP_BYTES (8,192 MiB).
    const r12 = shapeOf(pictures(24, 8.3, 3), { peakLayers: 2 });
    expect(peak(r12, { cores: 16 })!).toBeGreaterThan(8192);
    expect(peak(r12, { cores: 8 })!).toBeGreaterThan(8192);
    // ...and a gentler rung cannot rescue what is made of pictures: a still's decoder has no thread cap.
    expect(peak(r12, { rung: 2 })!).toBeGreaterThan(8192);
  });

  it("prices the streamed engine by its canvas and layers, and below the one-pass engine for a project of many inputs", () => {
    const reel = shapeOf(videos(21, { loads: graded }));
    expect(peak(reel, { engine: "partition-pipes-v1" })!).toBeLessThan(peak(reel)!);
    const small = peak(reel, { engine: "partition-pipes-v1" })!;
    const fourK = peak(shapeOf(videos(21), { canvas: { width: 3840, height: 2160, fps: 30 } }), {
      engine: "partition-pipes-v1",
    })!;
    expect(fourK).toBeGreaterThan(small);
    // The streamed engine has no rungs and no processors to lean on.
    expect(peak(reel, { engine: "partition-pipes-v1", rung: 2 })).toBe(small);
    expect(peak(reel, { engine: "partition-pipes-v1", cores: 4 })).toBe(small);
  });

  it("is in MiB: a plain one-clip project is hundreds of them, not thousands of bytes or gigabytes", () => {
    const plain = peak(shapeOf(videos(1)))!;
    expect(plain).toBeGreaterThan(200);
    expect(plain).toBeLessThan(2000);
    expect(Number.isInteger(plain)).toBe(true);
  });
});

describe("predictShapePeakMiB: not predicted", () => {
  it("says so for no shape, a source whose facts are unknown, a pixel format nobody knows, or a shape outside the table", () => {
    expect(peak(null)).toBeNull();
    expect(peak(shapeOf([clip({ known: false, sourceMp: null, bytesPerPixel: null })]))).toBeNull();
    expect(peak(shapeOf([clip(), clip({ known: false, sourceMp: null })]))).toBeNull();
    expect(peak(shapeOf([clip({ bytesPerPixel: null })]))).toBeNull();
    expect(peak(shapeOf([clip({ sourceMp: MEMORY_TABLE.limits.sourceMp + 1 })]))).toBeNull();
    expect(
      peak(shapeOf([clip()], { canvas: { width: 20000, height: 20000, fps: 30 } })),
    ).toBeNull();
    expect(peak(shapeOf(videos(MEMORY_TABLE.limits.clips + 1)))).toBeNull();
    expect(peak(shapeOf(videos(MEMORY_TABLE.limits.clips)))).not.toBeNull();
    // An empty project is a shape with nothing in it: it needs the encoder and little else.
    expect(peak(shapeOf([]))).toBeGreaterThan(0);
  });

  it("says so for an engine, a rung or a processor count that is not one", () => {
    const shape = shapeOf(videos(2));
    expect(peak(shape, { engine: "auto" })).toBeNull();
    expect(peak(shape, { rung: 3 as never })).toBeNull();
    for (const cores of [
      0,
      -4,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MEMORY_TABLE.limits.cores + 1,
    ])
      expect(peak(shape, { cores }), String(cores)).toBeNull();
  });

  it("never throws, whatever it is given", () => {
    fc.assert(
      fc.property(fc.anything(), (nonsense) => {
        const result = predictShapePeakMiB(nonsense as never);
        expect(result === null || (Number.isFinite(result) && result >= 0)).toBe(true);
      }),
      { numRuns: 200 },
    );
    for (const nonsense of [null, undefined, 4, "x", [], {}])
      expect(predictShapePeakMiB(nonsense as never)).toBeNull();
    const dirty = shapeOf([clip({ sourceMp: Number.NaN }), clip({ mp: -1 })]);
    expect(peak(dirty)).toBeNull();
    expect(peak({ ...shapeOf(videos(1)), clips: "none" as never })).toBeNull();
    expect(peak({ ...shapeOf(videos(1)), peakLayers: Number.NaN })).toBeNull();
    expect(peak(shapeOf(videos(1), { canvas: { width: 0, height: 5, fps: 30 } }))).toBeNull();
  });
});

describe("predictShapePeakMiB: never below a measurement, and the rules it keeps", () => {
  it("is never below a peak measured at the rung asked about or at a gentler one, however small the table says it is", () => {
    const shape = shapeOf(videos(2));
    const table = peak(shape)!;
    expect(peak(shape, { measured: [{ rung: 0, mib: table + 5000 }] })).toBe(table + 5000);
    expect(peak(shape, { rung: 1, measured: [{ rung: 0, mib: table + 5000 }] })).toBeLessThan(
      table + 5000,
    );
    // A peak measured at the gentler rung is a floor for the less gentle one: the normal rung never needs less than the gentle one did.
    expect(peak(shape, { rung: 0, measured: [{ rung: 1, mib: table + 100 }] })).toBe(table + 100);
    expect(peak(shape, { measured: [{ rung: 0, mib: 1 }] })).toBe(table);
    expect(peak(shape, { measured: [{ rung: 0, mib: Math.PI * 1000 }] })).toBeGreaterThanOrEqual(
      table,
    );
    expect(
      peak(shape, {
        measured: [
          { rung: 0, mib: Number.NaN },
          { rung: 0, mib: -3 },
          { rung: 7 as never, mib: 1e9 },
          null as never,
        ],
      }),
    ).toBe(table);
  });

  it("is a whole non-negative number, and a prediction with a measurement is never lower than without it", () => {
    fc.assert(
      fc.property(
        shapeArb,
        enginesArb,
        rungArb,
        coresArb,
        fc.double({ min: 1, max: 20_000, noNaN: true }),
        (shape, engine, rung, cores, mib) => {
          const plain = predictShapePeakMiB({ engine, rung, shape, cores })!;
          expect(Number.isInteger(plain) && plain >= 0).toBe(true);
          const floored = predictShapePeakMiB({
            engine,
            rung,
            shape,
            cores,
            measured: [{ rung, mib }],
          })!;
          expect(floored).toBeGreaterThanOrEqual(plain);
          expect(floored).toBeGreaterThanOrEqual(Math.ceil(mib));
        },
      ),
    );
  });

  it("is never more on a gentler rung", () => {
    fc.assert(
      fc.property(shapeArb, enginesArb, coresArb, (shape, engine, cores) => {
        const [normal, gentle, gentlest] = [0, 1, 2].map((rung) =>
          predictShapePeakMiB({ engine, rung: rung as Rung, shape, cores })!,
        );
        expect(gentle).toBeLessThanOrEqual(normal);
        expect(gentlest).toBeLessThanOrEqual(gentle);
      }),
    );
  });

  it("is never less on a PC with more processors, and more on the one-pass engine where the project has pictures", () => {
    fc.assert(
      fc.property(
        shapeArb,
        enginesArb,
        rungArb,
        coresArb,
        fc.integer({ min: 0, max: 24 }),
        (shape, engine, rung, cores, extra) => {
          const fewer = predictShapePeakMiB({ engine, rung, shape, cores })!;
          const more = predictShapePeakMiB({
            engine,
            rung,
            shape,
            cores: Math.min(128, cores + extra),
          })!;
          expect(more).toBeGreaterThanOrEqual(fewer);
        },
      ),
    );
    const pngs = shapeOf(pictures(6, 8.3, 3));
    expect(peak(pngs, { cores: 16 })!).toBeGreaterThan(peak(pngs, { cores: 4 })!);
  });

  it("grows with the size of the sources, the number of layers and the size of the canvas", () => {
    fc.assert(
      fc.property(
        shapeArb,
        enginesArb,
        rungArb,
        coresArb,
        fc.double({ min: 1, max: 1.5, noNaN: true }),
        fc.integer({ min: 0, max: 4 }),
        (shape, engine, rung, cores, factor, layers) => {
          const base = predictShapePeakMiB({ engine, rung, shape, cores })!;
          const bigger = {
            ...shape,
            clips: shape.clips.map((entry) => ({
              ...entry,
              sourceMp: Math.min(60, entry.sourceMp! * factor),
            })),
          };
          expect(
            predictShapePeakMiB({ engine, rung, shape: bigger, cores })!,
          ).toBeGreaterThanOrEqual(base);
          const layered = { ...shape, peakLayers: shape.peakLayers + layers };
          expect(
            predictShapePeakMiB({ engine, rung, shape: layered, cores })!,
          ).toBeGreaterThanOrEqual(base);
          const wider = {
            ...shape,
            canvas: { ...shape.canvas, width: shape.canvas.width * factor },
          };
          expect(
            predictShapePeakMiB({ engine, rung, shape: wider, cores })!,
          ).toBeGreaterThanOrEqual(base);
        },
      ),
    );
  });

  it("grows with pictures, sound and (where the decoder budget cannot give threads back) with video inputs", () => {
    fc.assert(
      fc.property(
        shapeArb,
        enginesArb,
        rungArb,
        coresArb,
        clipArb,
        (shape, engine, rung, cores, extra) => {
          const base = predictShapePeakMiB({ engine, rung, shape, cores })!;
          const withStill = {
            ...shape,
            clips: [...shape.clips, { ...extra, kind: "still" as const }],
          };
          expect(
            predictShapePeakMiB({ engine, rung, shape: withStill, cores })!,
          ).toBeGreaterThanOrEqual(base);
          const withSound = {
            ...shape,
            inputs: { ...shape.inputs, audio: shape.inputs.audio + 1 },
          };
          expect(
            predictShapePeakMiB({ engine, rung, shape: withSound, cores })!,
          ).toBeGreaterThanOrEqual(base);
          // At the gentlest rung every video input has one decoder thread whatever the count, so another input only adds.
          const withVideo = {
            ...shape,
            clips: [...shape.clips, { ...extra, kind: "video" as const }],
          };
          expect(
            predictShapePeakMiB({ engine, rung: 2, shape: withVideo, cores })!,
          ).toBeGreaterThanOrEqual(predictShapePeakMiB({ engine, rung: 2, shape, cores })!);
        },
      ),
    );
  });

  it("names the one place a prediction can fall when an input is added: the decoder budget that gives each input fewer threads", () => {
    // 0.27.0 gives the first two video inputs ffmpeg's own thread count and shares 24 threads between three or more (exportOptions.ts
    // `decoderThreads`), so on a tiny canvas with huge sources a third input cuts the decoders' share by more than it adds. The prior keeps the
    // behaviour the code has: it dips, by at most the decoders' term, and not at all at the gentlest rung.
    const small = { canvas: { width: 160, height: 90, fps: 30 } };
    const huge = (count: number) =>
      shapeOf(videos(count, { sourceMp: 33, bytesPerPixel: 3 }), small);
    expect(peak(huge(3))!).toBeLessThan(peak(huge(2))!);
    expect(peak(huge(3), { rung: 2 })!).toBeGreaterThan(peak(huge(2), { rung: 2 })!);
  });

  it("reads a float-RGB grade, a zoom and a wider pixel as more memory, and never less", () => {
    const base = peak(shapeOf(videos(4)))!;
    expect(peak(shapeOf(videos(4, { loads: graded })))!).toBeGreaterThan(base);
    expect(
      peak(
        shapeOf(videos(4, { loads: { cover_zoom: { frames: 100, windowFrames: 100, mp: 8 } } })),
      )!,
    ).toBeGreaterThan(base);
    expect(peak(shapeOf(videos(4, { bytesPerPixel: 3, tenBit: true })))!).toBeGreaterThan(base);
  });
});

const sizeArb = fc.constantFrom(
  { width: 1280, height: 720, fps: 30 },
  { width: 1920, height: 1080, fps: 30 },
  { width: 1080, height: 1920, fps: 30 },
  { width: 3840, height: 2160, fps: 30 },
);
const clipArb: fc.Arbitrary<CostClip> = fc
  .record({
    kind: fc.constantFrom("video" as const, "still" as const),
    sourceMp: fc.double({ min: 0.1, max: 40, noNaN: true }),
    mp: fc.double({ min: 0.1, max: 8, noNaN: true }),
    bytesPerPixel: fc.constantFrom(1, 1.5, 2, 3, 4, 6),
    graded: fc.boolean(),
    zoomMp: fc.option(fc.double({ min: 1, max: 20, noNaN: true }), { nil: null }),
  })
  .map(({ graded: isGraded, zoomMp, ...entry }) =>
    clip({
      ...entry,
      loads: {
        ...(isGraded ? graded : {}),
        ...(zoomMp === null ? {} : { cover_zoom: { frames: 100, windowFrames: 100, mp: zoomMp } }),
      },
    }),
  );
const shapeArb: fc.Arbitrary<CostShape> = fc
  .record({
    clips: fc.array(clipArb, { maxLength: 10 }),
    peakLayers: fc.integer({ min: 0, max: 8 }),
    canvas: sizeArb,
    audio: fc.integer({ min: 0, max: 6 }),
  })
  .map(({ clips, peakLayers, canvas, audio }) => shapeOf(clips, { peakLayers, canvas, audio }));
const enginesArb = fc.constantFrom<ExportEngine>("file-sequence-v1", "partition-pipes-v1");
const rungArb = fc.constantFrom<Rung>(0, 1, 2);
const coresArb = fc.integer({ min: 1, max: 64 });
