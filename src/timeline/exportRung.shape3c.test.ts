// The shape prior for the starting rung. Where this PC has measured nothing for the project's shape, the table's prediction of the peak at each rung of the export's own ladder lets
// the plan start the export at the first rung that fits, instead of letting it stop first. The picture gate decides too: a gentler rung can change the delivered file, so the prior may start an export
// at rung 1 or 2 only when the picture gate's record for that rung says yes for the arguments the code has now. Every answer in the table is still `pending`, so today the prior is computed and kept locally and the start
// rung is 0.27.0's. Each case plays the real decision (`decideRung`) with a shape the test builds from the real shape type.
import fc from "fast-check";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import type { CostClip, CostShape } from "./costShape";
import { EXPORT_SPEED_REVISION, type ExportCalibration } from "./exportOptions";
import { CEILING_SHARE, GIB, ceilingBytes, type Ladder, type Rung } from "./exportPlan";
import { decideRung } from "./exportRung";
import { GATE_TABLE, type GateRecord } from "./pictureGate";
import type { RenderWorkload } from "./renderPlan";
import { predictShapePeakMiB } from "./shapeMemory";
import { __resetShapeDecisions, currentRungHash, recentShapeDecisions } from "./shapeRung";

const MIB = 1024 * 1024;

const workload: RenderWorkload = {
  width: 7680,
  height: 4320,
  fps: 30,
  durationSeconds: 6,
  visualClips: 1,
  captionClips: 0,
  audioClips: 1,
  peakVisualLayers: 1,
  peakMediaLayers: 1,
};
const output = { width: 1080, height: 1920, fps: 30 };

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
const shapeOf = (clips: CostClip[], over: Partial<CostShape> = {}): CostShape => ({
  canvas: { width: 1080, height: 1920, fps: 30 },
  canvasFrames: 1000,
  frames: { video: 0, still: 0, caption: 0, audio: 0 },
  clips,
  common: {},
  layerFrames: 0,
  peakLayers: 1,
  meanLayers: 1,
  captionBands: 0,
  inputs: { video: 0, still: 0, audio: 1 },
  unknownSources: 0,
  unpricedFeatures: 0,
  ...over,
});
/** One decode-bound clip: 8K HEVC at 10 bits, the code's own lab case (3.52 GiB at the normal rung, 0.83 at the gentle one). */
const big = (id: string) => clip({ id, sourceMp: 33.18, bytesPerPixel: 3, tenBit: true });
const eightK = shapeOf([big("a")]);
/** Two and three of them, layered: what the gentle rung cannot hold on a PC with about two gigabytes free. */
const twoEightK = shapeOf([big("a"), big("b")], { peakLayers: 2 });
const threeEightK = shapeOf([big("a"), big("b"), big("c")], { peakLayers: 3 });
/** An ordinary project: a few 1080p clips. */
const plain = shapeOf(
  Array.from({ length: 3 }, (_, i) => clip({ id: `p${i}` })),
  { peakLayers: 1 },
);
/** The same project with the facts of one source unknown: nothing is predicted. */
const unknown = shapeOf([
  clip({ sourceMp: 33.18, bytesPerPixel: 3 }),
  clip({ id: "u", known: false }),
]);

const pc = (freeGiB: number | null) => async () =>
  freeGiB === null
    ? null
    : {
        total_memory_bytes: 16 * GIB,
        available_memory_bytes: freeGiB * GIB,
        scratch_free_bytes: 100 * GIB,
        destination_free_bytes: 100 * GIB,
        local_fast_candidate: false,
        budgets: { memoryBytes: 8 * GIB, temporaryBytes: 18 * GIB, executionSeconds: 28_800 },
      };

const HASH: Record<1 | 2, string> = { 1: "", 2: "" };
const rungHash = async (rung: 1 | 2) => HASH[rung];

/** The table with the owner's yes recorded for one route, to the arguments the code has now unless told otherwise. */
const opened = (
  route: "rung_1" | "rung_2",
  over: Partial<GateRecord> = {},
): readonly GateRecord[] =>
  GATE_TABLE.map((record) =>
    record.route === route
      ? {
          ...record,
          answer: "agree",
          exact: "pass",
          floor: "pass",
          answeredOn: "2026-11-16",
          ...over,
        }
      : record,
  );

const decide = (over: Partial<Parameters<typeof decideRung>[0]> = {}) =>
  decideRung({
    workload,
    output,
    quality: "medium",
    engine: "file-sequence-v1",
    encoder: "x264-crf",
    history: [],
    destPath: "/out/final.mp4",
    enabled: true,
    resolve: pc(4),
    shape: eightK,
    cores: 16,
    gate: { rungHash },
    ...over,
  });

const measured = (rung: 0 | 1 | 2, bytes: number | null): ExportCalibration => ({
  workload,
  output,
  quality: "medium",
  engine: "file-sequence-v1",
  encoder: "x264-crf",
  revision: EXPORT_SPEED_REVISION,
  elapsedSeconds: 22,
  finalBytes: 12e6,
  memoryBytes: bytes,
  temporaryBytes: 0,
  rung,
});

/** What the prior itself says, rung by rung, for a shape on this many processors: the test's own reading of the table, not the decision's. */
const priorMiB = (shape: CostShape, ladder: Ladder = [0, 1, 2], cores = 16) =>
  Object.fromEntries(
    ladder.map((rung) => [
      rung,
      predictShapePeakMiB({ engine: "file-sequence-v1", rung, shape, cores }),
    ]),
  ) as Record<number, number | null>;

/** The first rung of the ladder whose prediction fits under the ceiling of the free memory (the design's rule in the test's own words). */
const firstFitting = (
  shape: CostShape,
  freeGiB: number,
  ladder: Ladder = [0, 1, 2],
): Rung | null => {
  const miB = priorMiB(shape, ladder);
  return ladder.find((rung) => miB[rung]! * MIB <= ceilingBytes(freeGiB * GIB)) ?? null;
};

afterEach(() => {
  __resetExportFlags();
  __resetShapeDecisions();
});

beforeAll(async () => {
  for (const rung of [1, 2] as const) HASH[rung] = (await currentRungHash(rung)) ?? "";
});

describe("the arguments hash the code has now", () => {
  it("is the hash the picture gate's table records for each rung: the production recipe and the test's recipe are one", async () => {
    for (const rung of [1, 2] as const) {
      const hash = await currentRungHash(rung);
      expect(hash, `rung ${rung}`).toBe(
        GATE_TABLE.find((r) => r.route === `rung_${rung}`)!.argsHash,
      );
    }
  });
});

describe("the lab case the prior is built on", () => {
  it("is a project the normal rung does not fit on 4 GiB and the gentle rung does (so the cases below are about the rung, not about a project that fits anyway)", () => {
    const miB = priorMiB(eightK);
    expect(miB[0]! * MIB).toBeGreaterThan(ceilingBytes(4 * GIB));
    expect(miB[1]! * MIB).toBeLessThanOrEqual(ceilingBytes(4 * GIB));
    expect(firstFitting(eightK, 4)).toBe(1);
  });
});

describe("with the picture gate as it is (every answer pending): 0.27.0's start rung, whatever the prior says", () => {
  it("starts at the normal rung and says so on the plan, while the prior is worked out and kept locally", async () => {
    const decision = await decide();
    expect(decision.rung).toBe(0);
    expect(decision.plan.basis).toBe("unmeasured");
    const [said] = recentShapeDecisions();
    expect(said).toMatchObject({
      engine: "file-sequence-v1",
      baselineRung: 0,
      shapedRung: 1,
      startedRung: 0,
      applied: false,
      held: "picture_gate",
    });
    expect(said.predictedMiB[1]).toBe(priorMiB(eightK)[1]);
  });

  it("holds the prior for every answer that is not a yes to the arguments the code has now", async () => {
    const stale = HASH[1].replace(/./, (c) => (c === "0" ? "1" : "0"));
    const cases: Array<[string, readonly GateRecord[]]> = [
      ["pending", GATE_TABLE],
      ["no", opened("rung_1", { answer: "no" })],
      ["an answer given to other arguments", opened("rung_1", { argsHash: stale })],
      ["agree with a guard that failed", opened("rung_1", { exact: "fail" })],
      ["agree with a guard never measured", opened("rung_1", { floor: "unmeasured" })],
      ["a yes for the other rung", opened("rung_2")],
    ];
    for (const [name, table] of cases) {
      __resetShapeDecisions();
      const decision = await decide({ gate: { table, rungHash } });
      expect(decision.rung, name).toBe(0);
      expect(decision.plan.basis, name).toBe("unmeasured");
      expect(recentShapeDecisions()[0], name).toMatchObject({
        applied: false,
        held: "picture_gate",
      });
    }
  });

  it("is 0.27.0's start rung for every project, PC, engine and second try the prior is asked about (property)", async () => {
    const shapes = [eightK, plain, unknown, shapeOf([])];
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...shapes),
        fc.double({ min: 0.5, max: 64, noNaN: true }),
        fc.constantFrom<"file-sequence-v1" | "partition-pipes-v1">(
          "file-sequence-v1",
          "partition-pipes-v1",
        ),
        fc.constantFrom<0 | 1 | 2>(0, 1, 2),
        async (shape, free, engine, minRung) => {
          __setExportFlag("memory_shape", false);
          const before = await decide({ shape, resolve: pc(free), engine, minRung });
          __resetExportFlags();
          const now = await decide({ shape, resolve: pc(free), engine, minRung });
          expect(now.rung).toBe(before.rung);
          expect(now.plan).toEqual(before.plan);
        },
      ),
      { numRuns: 80 },
    );
  });
});

describe("with a recorded yes for the current arguments, the prior starts the gentler rung", () => {
  it("starts the first rung that fits, says it is predicted from the shape, and counts as fitting", async () => {
    const decision = await decide({ gate: { table: opened("rung_1"), rungHash } });
    expect(decision.rung).toBe(1);
    expect(decision.plan).toMatchObject({ basis: "shape", fits: true, rung: 1 });
    expect(decision.plan.predictedBytes).toBeCloseTo(priorMiB(eightK)[1]! * MIB, 0);
    expect(recentShapeDecisions()[0]).toMatchObject({ applied: true, held: null, startedRung: 1 });
  });

  it("asks the gate about the rung it would start at, and starts nothing the gate has not allowed", async () => {
    // free memory halfway between what rung 2 and rung 1 need: only the gentlest rung fits, and the PC has more than the reserve free, so the plan's own floor does not already say gentlest
    const miB = priorMiB(twoEightK);
    const needs = (rung: Rung) => (miB[rung]! * MIB) / CEILING_SHARE;
    expect(needs(2)).toBeLessThan(needs(1));
    const free = (needs(2) + needs(1)) / 2 / GIB;
    expect(free * GIB).toBeGreaterThanOrEqual(2e9);
    expect(firstFitting(twoEightK, free)).toBe(2);
    const onlyOne = await decide({
      shape: twoEightK,
      resolve: pc(free),
      gate: { table: opened("rung_1"), rungHash },
    });
    // a yes for rung 1 does not stand in for rung 2: the prior is held and the start is 0.27.0's
    expect(onlyOne.rung).toBe(0);
    expect(onlyOne.plan.basis).toBe("unmeasured");
    const gentlest = await decide({
      shape: twoEightK,
      resolve: pc(free),
      gate: { table: opened("rung_2"), rungHash },
    });
    expect(gentlest.rung).toBe(2);
    expect(gentlest.plan).toMatchObject({ basis: "shape", fits: true });
  });

  it("keeps the ladder the export really has: rungs the command does not have are never predicted for, never started at", async () => {
    // a ladder of [0, 2] (a graphics encoder takes no thread cap, so rung 1 is the same command as rung 0)
    const decision = await decide({
      ladder: [0, 2],
      gate: { table: opened("rung_2"), rungHash },
      resolve: pc(4),
    });
    expect(decision.ladder).toEqual([0, 2]);
    expect(decision.rung).toBe(2);
    const said = recentShapeDecisions()[0];
    expect(Object.keys(said.predictedMiB).map(Number)).toEqual([0, 2]);
    // and the streamed engine has one rung: nothing to start at
    const streamed = await decide({
      engine: "partition-pipes-v1",
      gate: { table: opened("rung_1"), rungHash },
    });
    expect(streamed.rung).toBe(0);
    expect(streamed.ladder).toEqual([0]);
  });

  it("is never lighter than 0.27.0's start, and never gentler than the first rung that fits (property)", async () => {
    const shapes = [eightK, plain, shapeOf([clip({ sourceMp: 8.3, bytesPerPixel: 1.5 })])];
    const open: readonly GateRecord[] = GATE_TABLE.map((record) =>
      record.route === "rung_1" || record.route === "rung_2"
        ? { ...record, answer: "agree", exact: "pass", floor: "pass", answeredOn: "2026-11-16" }
        : record,
    );
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...shapes),
        fc.double({ min: 0.3, max: 64, noNaN: true }),
        fc.constantFrom<0 | 1 | 2>(0, 1, 2),
        async (shape, free, minRung) => {
          __setExportFlag("memory_shape", false);
          const baseline = await decide({ shape, resolve: pc(free), minRung });
          __resetExportFlags();
          const shaped = await decide({
            shape,
            resolve: pc(free),
            minRung,
            gate: { table: open, rungHash },
          });
          expect(shaped.rung).toBeGreaterThanOrEqual(baseline.rung);
          expect(shaped.rung).toBeLessThanOrEqual(shaped.maxRung);
          if (shaped.plan.basis === "shape") {
            expect(shaped.rung).toBeGreaterThan(baseline.rung);
            // what it says fits, fits: the predicted peak of the rung it started at is under the ceiling
            if (shaped.plan.fits)
              expect(shaped.plan.predictedBytes!).toBeLessThanOrEqual(ceilingBytes(free * GIB));
          } else {
            expect(shaped.plan).toEqual(baseline.plan);
          }
        },
      ),
      { numRuns: 120 },
    );
  });

  it("still says a project does not fit when even the gentlest rung is predicted not to, so the memory question still appears", async () => {
    // about two gigabytes free (the reserve is met, so 0.27.0 starts at the normal rung and says nothing): three layered 8K clips fit at no rung
    const free = 1.9;
    expect(free * GIB).toBeGreaterThanOrEqual(2e9);
    expect(firstFitting(threeEightK, free)).toBeNull();
    const decision = await decide({
      shape: threeEightK,
      resolve: pc(free),
      gate: { table: opened("rung_2"), rungHash },
    });
    expect(decision.rung).toBe(2);
    expect(decision.plan).toMatchObject({ basis: "shape", fits: false });
  });
});

describe("where the prior is not consulted", () => {
  const open = opened("rung_1");

  it("never overrides a measurement: a peak this PC measured for the shape decides, at every rung it covers", async () => {
    // the normal rung was measured at a size that fits 4 GiB: the prior's contrary opinion is not heard
    const fits = await decide({
      history: [measured(0, 1 * GIB)],
      gate: { table: open, rungHash },
    });
    expect(fits.rung).toBe(0);
    expect(fits.plan.basis).toBe("measured");
    expect(recentShapeDecisions()).toEqual([]);
    // measured and too big for the normal rung: the plan's own conversion decides, as it did, and not the prior
    const big = await decide({
      history: [measured(0, 3.52 * GIB)],
      gate: { table: open, rungHash },
    });
    expect(big.plan.basis).toBe("derived");
    expect(recentShapeDecisions()).toEqual([]);
  });

  it("is consulted when the earlier exports left no memory figure behind", async () => {
    const decision = await decide({
      history: [measured(0, null)],
      gate: { table: open, rungHash },
    });
    expect(decision.plan.basis).toBe("shape");
  });

  it("says nothing where it cannot predict: no project open, a source nobody has read, a project outside the table", async () => {
    for (const shape of [null, unknown, shapeOf([clip({ sourceMp: 120, bytesPerPixel: 3 })])]) {
      const decision = await decide({ shape, gate: { table: open, rungHash } });
      expect(decision.rung).toBe(0);
      expect(decision.plan.basis).toBe("unmeasured");
    }
    expect(recentShapeDecisions()).toEqual([]);
  });

  it("is off with the switch off, and the PC is asked as it always was", async () => {
    __setExportFlag("memory_shape", false);
    const decision = await decide({ gate: { table: open, rungHash } });
    expect(decision.rung).toBe(0);
    expect(decision.plan.basis).toBe("unmeasured");
    expect(recentShapeDecisions()).toEqual([]);
  });

  it("is off with the rungs off: the normal rung, the PC not asked, nothing worked out", async () => {
    let asked = 0;
    const resolve = async () => {
      asked++;
      return pc(1)();
    };
    const decision = await decide({ enabled: false, resolve, gate: { table: open, rungHash } });
    expect(decision.rung).toBe(0);
    expect(asked).toBe(0);
    expect(recentShapeDecisions()).toEqual([]);
  });

  it("asks only for what it needs: a PC that cannot be measured, or has room for the normal rung, starts as it did", async () => {
    expect((await decide({ resolve: pc(null), gate: { table: open, rungHash } })).rung).toBe(0);
    const roomy = await decide({ resolve: pc(40), gate: { table: open, rungHash } });
    expect(roomy.rung).toBe(0);
    expect(roomy.plan.basis).toBe("unmeasured");
  });

  it("never fails the export: a prediction or a gate that throws leaves the start rung as it was", async () => {
    const broken = await decide({
      gate: {
        table: open,
        rungHash: async () => {
          throw new Error("no command builder");
        },
      },
    });
    expect(broken.rung).toBe(0);
    const odd = await decide({
      shape: { nonsense: true } as never,
      gate: { table: open, rungHash },
    });
    expect(odd.rung).toBe(0);
  });
});

describe("what is kept locally", () => {
  it("is bounded, carries only numbers and rung names, and is forgotten at a reset", async () => {
    for (let i = 0; i < 40; i++) await decide();
    const kept = recentShapeDecisions();
    expect(kept.length).toBeLessThanOrEqual(20);
    expect(kept.length).toBeGreaterThan(0);
    for (const entry of kept) {
      const text = JSON.stringify(entry);
      expect(text).not.toMatch(/final\.mp4|\/out|media_ref/);
    }
    __resetShapeDecisions();
    expect(recentShapeDecisions()).toEqual([]);
  });
});
