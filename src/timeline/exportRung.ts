// Where the plan meets the PC: read the free memory, read this PC's history of the same shape, and say which
// rung the export runs at (exportPlan.ts). Used once, at the moment an export's command is captured, because
// nothing downstream may change the command afterwards.
import { resolveExportResources, type ExportResources } from "../platform/host";
import {
  peakSamples,
  type ExportCalibration,
  type ExportEncoder,
  type ExportEngine,
} from "./exportOptions";
import {
  planRung,
  cleanLadder,
  denseLadder,
  type Ladder,
  type Plan,
  type Rung,
} from "./exportPlan";
import type { RenderWorkload } from "./renderPlan";

export interface RungDecision {
  readonly rung: Rung;
  readonly plan: Plan;
  /** The free memory the decision was made on, or null when the PC could not be measured. */
  readonly freeBytes: number | null;
  /** The rungs this export really has (exportPlan.ts `Ladder`): what the plan counted on, and what Try again may ask
   *  for. The same with the switch off (the export then runs the normal rung): the switch is read again when Try again
   *  is offered (`gentlestRungOf`), so what the command has must be kept. */
  readonly ladder: Ladder;
  /** The gentlest of them: the last on the ladder. */
  readonly maxRung: Rung;
}

type Resolve = (destPath: string, signal?: AbortSignal) => Promise<ExportResources | null>;

/** The streamed engine already runs every decoder on one thread and the final encoder on at most two, so it
 *  has no gentler rung; the one-pass engine has the two. */
const lastRungOf = (engine: ExportEngine): Rung => (engine === "partition-pipes-v1" ? 0 : 2);

/** Which rung an export runs at. With the switch off the export runs as it did before rungs existed: the normal
 *  rung, whatever a second try asked, because there are no rungs to ask for. With no way to measure the PC it is
 *  the rung asked for (the normal one unless this is a second try): the plan never makes an export fail, it only
 *  chooses. */
export async function decideRung(input: {
  workload: RenderWorkload;
  output: { width: number; height: number; fps: number };
  quality: string;
  engine: ExportEngine;
  encoder: ExportEncoder;
  history: readonly ExportCalibration[];
  destPath: string;
  signal?: AbortSignal;
  /** The gentlest-so-far a second try starts from. */
  minRung?: number;
  /** The rungs this export's command really has (render.ts `ladderOf`): a rung that is the same command as the one
   *  before it is not counted on. Absent: the rungs with no gaps up to `maxRung`. */
  ladder?: Ladder;
  /** The gentlest rung, for a caller that has no ladder. Absent: what the engine has. */
  maxRung?: number;
  /** The remote switch (`plan_rung`): off is today's behaviour. */
  enabled: boolean;
  resolve?: Resolve;
}): Promise<RungDecision> {
  const engineLast = lastRungOf(input.engine);
  const bounded = input.ladder
    ? cleanLadder(input.ladder).filter((rung) => rung <= engineLast)
    : denseLadder(Math.min(engineLast, input.maxRung ?? 2));
  const ladder: Ladder = bounded.length ? bounded : [0];
  const maxRung = ladder[ladder.length - 1];
  const samples = peakSamples(
    input.workload,
    input.output,
    input.quality,
    input.engine,
    input.history,
    input.encoder,
  );
  if (!input.enabled)
    return {
      rung: 0,
      plan: planRung({ samples, freeBytes: null, minRung: 0, ladder }),
      freeBytes: null,
      ladder,
      maxRung,
    };
  let resources: ExportResources | null = null;
  try {
    resources = await (input.resolve ?? resolveExportResources)(input.destPath, input.signal);
  } catch {
    resources = null;
  }
  const raw = resources?.available_memory_bytes;
  const freeBytes = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
  const plan = planRung({ samples, freeBytes, minRung: input.minRung, ladder });
  return { rung: plan.rung, plan, freeBytes, ladder, maxRung };
}
