// The shape prior for the starting rung (the memory prediction, 3c-37 = C). Where this PC has measured nothing for the project's shape, the table's prediction of the peak (shapeMemory.ts) at each rung of the export's own ladder
// stands in for the missing samples, so the plan starts the export at the first rung whose predicted peak fits under the ceiling instead of letting it stop first. It stands in; it never overrides: a measurement this PC made
// decides at every rung it covers (the prior is not even consulted), and it can only make the start GENTLER than 0.27.0's, never lighter.
//
// A gentler rung can change the delivered file (x264's two encoder threads), so it is the owner's picture rule's business (pictureGate.ts): the prior may start an export at rung 1 or 2 only when the gate's record for that rung
// says yes for the arguments the code has now. Every answer in the table is still `pending`, so today the prior is worked out and kept locally (`recentShapeDecisions`) and the start rung is 0.27.0's.
import type { CostShape } from "./costShape";
import { estimateDepsNow } from "./estimateDeps";
import type { ExportEngine } from "./exportOptions";
import {
  RUNG_THREAD_CAPS,
  planRung,
  type Ladder,
  type PeakSample,
  type Plan,
  type Rung,
} from "./exportPlan";
import { flags3cNow } from "./flags3c";
import type { Timeline } from "./model";
import { GATE_TABLE, hashArgs, mayWidenRoute, type GateRecord } from "./pictureGate";
import type { RenderWorkload } from "./renderPlan";
import { shapeOf } from "./routeEstimates";
import { predictShapePeakMiB } from "./shapeMemory";

const MIB = 1024 * 1024;

/** What the prior must pass to start an export at a gentler rung. Both parts are the app's own unless a test gives others. */
export interface ShapeGate {
  /** The picture gate's table: the owner's recorded answers. */
  table?: readonly GateRecord[];
  /** The hash of the arguments a rung has in the code now. */
  rungHash?: (rung: 1 | 2) => Promise<string | null>;
}

/** What the prior worked out for one export, kept locally and sent nowhere. Numbers and rung names only. */
export interface ShapeDecision {
  atMs: number;
  engine: ExportEngine;
  ladder: Ladder;
  /** The predicted peak in MiB at each rung of the ladder. */
  predictedMiB: Record<number, number>;
  freeMiB: number | null;
  /** The rung 0.27.0's plan starts at. */
  baselineRung: Rung;
  /** The rung the prior would start at. */
  shapedRung: Rung;
  /** The rung the export starts at. */
  startedRung: Rung;
  applied: boolean;
  /** Why a gentler start was not made: the picture gate does not allow that rung yet. */
  held: "picture_gate" | null;
}

const MAX_KEPT = 20;
const kept: ShapeDecision[] = [];

/** The last few decisions, newest first. */
export function recentShapeDecisions(): readonly ShapeDecision[] {
  return kept.map((entry) => ({ ...entry, predictedMiB: { ...entry.predictedMiB } }));
}

export function __resetShapeDecisions(): void {
  kept.length = 0;
}

const isPeak = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** Whether any earlier export of this shape left a peak behind. With none, nothing was measured and the prior may stand in. */
export function hasMeasuredPeak(samples: readonly PeakSample[]): boolean {
  return samples.some((sample) => isPeak(sample.bytes));
}

/** The prior's samples: the predicted peak at each rung of the ladder, or null when any rung cannot be predicted (an unread source, a project outside the table): a part of a prediction would be read as a measurement. */
export function shapeSamples(input: {
  engine: ExportEngine;
  shape: CostShape | null;
  cores: number;
  ladder: Ladder;
}): PeakSample[] | null {
  const samples: PeakSample[] = [];
  for (const rung of input.ladder) {
    const mib = predictShapePeakMiB({
      engine: input.engine,
      rung,
      shape: input.shape,
      cores: input.cores,
    });
    if (mib === null) return null;
    samples.push({ rung, bytes: mib * MIB });
  }
  return samples;
}

/** What a rung's route has in the code now: the real command builder's thread arguments for a one-input and a three-input project at that rung, and the rung's cap table. The picture gate's table records the hash of this
 *  for each rung (`pictureGate.test.ts` computes the same recipe from the code and fails when they differ). Null when the builder cannot be loaded. */
export async function currentRungHash(rung: 1 | 2): Promise<string | null> {
  try {
    const { buildRenderCommand } = await import("./render");
    const out = "/out.mp4";
    const project = (inputs: number): Timeline =>
      ({
        canvas: { width: 1920, height: 1080, fps: 30 },
        tracks: Array.from({ length: inputs }, (_, i) => ({
          id: `v${i}`,
          kind: "video",
          z: i,
          clips: [
            {
              media_ref: `/v${i}.mp4`,
              kind: "video",
              source_in: 0,
              source_out: 4,
              timeline_in: 0,
              timeline_out: 4,
            },
          ],
        })),
      }) as unknown as Timeline;
    const threads = (args: string[]): string[][] =>
      args.flatMap((arg, i) => (arg === "-threads:v" ? [[arg, args[i + 1] ?? ""]] : []));
    return hashArgs({
      caps: RUNG_THREAD_CAPS[rung],
      one: threads(buildRenderCommand(project(1), out, { rung } as never).args),
      three: threads(buildRenderCommand(project(3), out, { rung } as never).args),
    });
  } catch {
    return null;
  }
}

function keep(entry: ShapeDecision): void {
  kept.unshift(entry);
  if (kept.length > MAX_KEPT) kept.length = MAX_KEPT;
}

/** The plan to start the export from instead of `baseline` (0.27.0's), or null to start as 0.27.0 did. Never throws. */
export async function shapeStart(input: {
  baseline: Plan;
  workload: RenderWorkload;
  engine: ExportEngine;
  ladder: Ladder;
  freeBytes: number | null;
  minRung?: number;
  /** The project's cost shape: absent, the open project's when it is the project being exported; null, none. */
  shape?: CostShape | null;
  cores?: number;
  gate?: ShapeGate;
}): Promise<Plan | null> {
  try {
    if (!flags3cNow().memory_shape) return null;
    const shape =
      input.shape !== undefined ? input.shape : shapeOf(input.workload, estimateDepsNow());
    const cores = input.cores ?? estimateDepsNow().cores();
    const samples = shapeSamples({ engine: input.engine, shape, cores, ladder: input.ladder });
    if (!samples) return null;
    const shaped = planRung({
      samples,
      freeBytes: input.freeBytes,
      minRung: input.minRung,
      ladder: input.ladder,
    });
    const record = (applied: boolean, held: ShapeDecision["held"]): void =>
      keep({
        atMs: Date.now(),
        engine: input.engine,
        ladder: [...input.ladder],
        predictedMiB: Object.fromEntries(
          samples.map((sample) => [sample.rung, Math.round((sample.bytes ?? 0) / MIB)]),
        ),
        freeMiB: input.freeBytes === null ? null : Math.round(input.freeBytes / MIB),
        baselineRung: input.baseline.rung,
        shapedRung: shaped.rung,
        startedRung: applied ? shaped.rung : input.baseline.rung,
        applied,
        held,
      });
    // The prior only ever makes the start gentler: a project it thinks is small does not lighten what 0.27.0 chose.
    if (shaped.rung <= input.baseline.rung) {
      record(false, null);
      return null;
    }
    const rung = shaped.rung === 1 ? 1 : 2;
    const hash = await (input.gate?.rungHash ?? currentRungHash)(rung);
    const allowed =
      hash !== null && mayWidenRoute(`rung_${rung}`, hash, input.gate?.table ?? GATE_TABLE);
    record(allowed, allowed ? null : "picture_gate");
    return allowed ? { ...shaped, basis: "shape" } : null;
  } catch {
    return null;
  }
}
