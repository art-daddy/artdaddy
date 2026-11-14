// The line the Export dialog says about time before the click. With the new estimate on it is the honest estimate of the way that is selected, said in the copy pack's words (where its number comes from, a range where it is unsure,
// "could take much longer"); with it off it is 0.27.0's own line, from 0.27.0's own functions. Nothing here throws: an estimate that cannot be made is no line.
import { describeEstimateLine, describeMuchLonger } from "./estimateWords";
import { routeEstimatesHere } from "./estimateDeps";
import type { ChipMaker } from "./exportEncoder";
import {
  estimateForDialog,
  type ExportCalibration,
  type ExportMode,
  type ExportQuality,
  type ExportResolution,
} from "./exportOptions";
import type { PcClass } from "./exportTypes3c";
import { describeExpected } from "./exportWords";
import { flags3cNow } from "./flags3c";
import type { Timeline } from "./model";
import type { RenderWorkload } from "./renderPlan";

export interface DialogEstimateInput {
  workload: RenderWorkload | null;
  settings: { resolution: ExportResolution; quality: ExportQuality; fps: number | null };
  /** The mode the dialog shows as chosen: Fast is the chip's estimate, Full quality the processor's. */
  mode: ExportMode;
  /** The graphics chip that passed its test for this picture. */
  chip: ChipMaker | null | undefined;
  /** The processor's faster setting is what Full quality will run. */
  faster: boolean;
  history: readonly ExportCalibration[];
  /** The timeline the person has open, for the project's cost shape. */
  openTimeline?: () => Timeline | null;
}

export interface DialogEstimate {
  /** The sentence under the three settings; "" when there is nothing to say. */
  line: string;
  /** The amber sentence for an estimate that could be far off, or null. */
  muchLonger: string | null;
  /** The PC's class the estimate was priced on. */
  pcClass: PcClass;
}

const NONE: DialogEstimate = { line: "", muchLonger: null, pcClass: "unknown" };

export function dialogEstimate(input: DialogEstimateInput): DialogEstimate {
  try {
    const { workload, settings, mode } = input;
    if (!workload) return NONE;
    if (!flags3cNow().estimate_v2) {
      const route = mode === "fast" ? { chip: input.chip } : { faster: input.faster === true };
      return {
        ...NONE,
        line: describeExpected(
          estimateForDialog(workload, { ...settings, mode }, input.history, route),
        ),
      };
    }
    const maker = input.chip ?? null;
    const estimates = routeEstimatesHere(
      {
        workload,
        settings,
        explicit: { size: settings.resolution !== "source", fps: settings.fps !== null },
        chipMaker: maker,
      },
      {
        history: () => input.history,
        ...(input.openTimeline ? { openTimeline: input.openTimeline } : {}),
      },
    );
    const way =
      mode === "fast" ? (maker ? "chip" : "standard") : input.faster ? "faster" : "standard";
    const estimate = estimates[way];
    return {
      line: describeEstimateLine(estimate, estimates.pcClass),
      muchLonger: describeMuchLonger(estimate),
      pcClass: estimates.pcClass,
    };
  } catch {
    return NONE;
  }
}
