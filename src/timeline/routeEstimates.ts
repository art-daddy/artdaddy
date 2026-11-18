// HELD OFF, NOT DELETED (owner decision 2026-11-18): part of the held export-time guess machinery (flags `estimate_v2`,
// `pc_check`, both in OFF_IN_THIS_BUILD in `api/exportFlags.ts`), kept for a later release, so do not remove it as unused;
// see docs/EXPORTER_ARCHITECTURE.md, "Deferred Export Speed And Settings Work".
//
// The honest estimate of every way an export could run, for the Export dialog, the route decision and the admission door: ONE gathering of what the estimate needs (this PC's speed
// check, what the exporter learned, this PC's earlier exports, the project's cost shape, the switches) and ONE call of the estimator per way. Everything it reads comes in through
// `RouteEstimatesDeps`, so the logic is tested without a store, a storage or a clock; `estimateDeps.ts` builds the real ones.
//
// It never throws: a part that cannot be read is left out of the estimate (the estimate says less, or says it on a prior), and a way that cannot be priced is `null`.
import { summarizeCostShape, type CostShape, type SourceFactsLookup } from "./costShape";
import { estimate, type EstimateRequest, type PcPace, type Recipe } from "./estimator";
import type { ChipMaker, ExportEncoder } from "./exportEncoder";
import {
  deliveredPicture,
  type ExportCalibration,
  type ExportEngine,
  type ExportQuality,
} from "./exportOptions";
import type { Rung } from "./exportPlan";
import { QUICK_BUNDLE, isWeakPc, quickSettings } from "./exportRoute";
import {
  PC_CLASSES,
  type EncoderFamily,
  type Flags3c,
  type HonestEstimate,
  type PcClass,
  type RouteEstimates,
  type RouteEstimatesRequest,
} from "./exportTypes3c";
import { paceCorrection } from "./paceLog";
import { paceOfCheck } from "./pcPace";
import type { Cutoffs, PcCheckRecord, StorageLike } from "./pcClass";
import { summarizeRenderWorkload, type RenderWorkload } from "./renderPlan";
import type { Timeline } from "./model";

export interface RouteEstimatesDeps {
  /** The switches, read once for one answer (the callers read them at the decision). */
  flags(): Pick<Flags3c, "estimate_v2" | "pc_check">;
  /** The timeline the person has open: what the cost shape is read from. */
  openTimeline(): Timeline | null;
  /** The source facts reader (what a clip's size, pixel format and alpha are). `null` until the reader exists: every source is then priced as unknown and the range widens. */
  facts: SourceFactsLookup | null;
  /** The recipe a clip will really run on. `undefined` until the lean decision exists: every clip is then priced on today's (the slow, pessimistic) recipe. */
  recipeOf: ((clipId: string) => Recipe) | undefined;
  /** The speed check's stored result for this PC, already tested for age, build and core count (the check service), or null. */
  speedCheck(): PcCheckRecord | null;
  /** The class cut-offs in force now (the server's pair), or undefined for the compiled ones. */
  cutoffs(): Cutoffs | undefined;
  /** Logical processors of this PC. */
  cores(): number;
  /** This PC's finished exports. */
  history(): readonly ExportCalibration[];
  /** Where the pace log is kept, or null. */
  storage(): StorageLike | null;
  build: string;
  /** The exporter's speed revision: a ratio learned under another one is not believed. */
  speedRevision: number;
  now(): number;
}

const NONE: RouteEstimates = Object.freeze({
  pcClass: "unknown",
  standard: null,
  quick: null,
  chip: null,
  faster: null,
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Runs a reader that may throw; what it could not read is `fallback`. */
function soft<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

const WORKLOAD_FIELDS = [
  "width",
  "height",
  "fps",
  "durationSeconds",
  "visualClips",
  "captionClips",
  "audioClips",
  "peakVisualLayers",
  "peakMediaLayers",
] as const;

const sameWorkload = (a: RenderWorkload, b: RenderWorkload): boolean =>
  WORKLOAD_FIELDS.every((field) => a[field] === b[field]);

let memo: {
  timeline: Timeline;
  facts: SourceFactsLookup | null;
  recipeOf: unknown;
  workload: RenderWorkload;
  shape: CostShape | null;
} | null = null;

/** What the project asks of the exporter, when the open timeline is the project that is being priced: the open timeline says what the caller's workload says, field for field.
 *  A clip's own export, a section of the project or a timeline that has changed since do not, and are priced without a shape (on a prior, with the range widened). */
export function shapeOf(workload: RenderWorkload, deps: RouteEstimatesDeps): CostShape | null {
  try {
    const timeline = deps.openTimeline();
    if (!isObject(timeline)) return null;
    if (
      memo &&
      memo.timeline === timeline &&
      memo.facts === deps.facts &&
      memo.recipeOf === deps.recipeOf
    )
      return sameWorkload(memo.workload, workload) ? memo.shape : null;
    const here = summarizeRenderWorkload(timeline);
    const shape = summarizeCostShape(timeline, { facts: deps.facts });
    memo = { timeline, facts: deps.facts, recipeOf: deps.recipeOf, workload: here, shape };
    return sameWorkload(here, workload) ? shape : null;
  } catch {
    return null;
  }
}

/** For tests: forget the last timeline read. */
export function __resetRouteEstimatesMemo(): void {
  memo = null;
}

interface Gathered {
  flags: Pick<Flags3c, "estimate_v2" | "pc_check">;
  pace: PcPace | null;
  cls: PcClass;
  history: ExportCalibration[];
  deps: RouteEstimatesDeps;
}

function gather(deps: RouteEstimatesDeps): Gathered {
  const flags = soft(
    () => {
      const read = deps.flags();
      return { estimate_v2: read.estimate_v2 === true, pc_check: read.pc_check === true };
    },
    { estimate_v2: false, pc_check: false },
  );
  const pace = flags.pc_check
    ? soft(() => paceOfCheck(deps.speedCheck(), deps.cutoffs(), deps.cores()), null)
    : null;
  const history = soft(() => [...deps.history()], [] as ExportCalibration[]);
  return { flags, pace, cls: pace?.cls ?? "unknown", history, deps };
}

interface Way {
  output: { width: number; height: number; fps: number; quality: ExportQuality | undefined };
  route: EstimateRequest["route"];
  engine?: ExportEngine;
  rung?: Rung;
}

function price(
  gathered: Gathered,
  workload: RenderWorkload,
  shape: CostShape | null,
  way: Way,
  learned: boolean,
): HonestEstimate | null {
  try {
    const { deps, flags } = gathered;
    const family: EncoderFamily = way.route.family;
    const correction =
      flags.estimate_v2 && learned
        ? soft(
            () =>
              paceCorrection(
                deps.storage(),
                { family, speedRevision: deps.speedRevision, build: deps.build },
                deps.now(),
              ),
            null,
          )
        : null;
    return estimate({
      workload,
      shape,
      output: way.output,
      route: way.route,
      pace: gathered.pace,
      correction,
      history: gathered.history,
      ...(deps.recipeOf ? { recipeOf: deps.recipeOf } : {}),
      flags,
      nowMs: deps.now(),
      ...(way.engine ? { engine: way.engine } : {}),
      ...(way.rung ? { rung: way.rung } : {}),
    });
  } catch {
    return null;
  }
}

const usableRequest = (request: unknown): request is RouteEstimatesRequest =>
  isObject(request) && isObject(request.workload) && isObject(request.settings);

/** The honest estimate of each way for what the person has chosen, at dialog time (no plan exists yet: the engine is what the Automatic policy picks, the rung the normal one).
 *  `standard` is the processor's normal setting at the person's own settings, `faster` its faster setting, `chip` the graphics chip that passed its test (null when none is named) and
 *  `quick` Quick's own size and rate on the chip or the faster setting. With `estimate_v2` off the numbers are 0.27.0's and there is no Quick. */
export function estimatesForRoutes(
  request: RouteEstimatesRequest,
  deps: RouteEstimatesDeps,
): RouteEstimates {
  try {
    if (!usableRequest(request)) return NONE;
    const { workload, settings } = request;
    const gathered = gather(deps);
    const quality = settings.quality;
    const own = deliveredPicture(workload, {
      resolution: settings.resolution,
      fps: settings.fps ?? null,
    });
    // The project's cost shape is read only for the model that prices from it: with the estimate switched off the figure is 0.27.0's and nothing reads the timeline (and nothing keeps it).
    const shape = gathered.flags.estimate_v2 ? shapeOf(workload, deps) : null;
    const maker: ChipMaker | null = request.chipMaker ?? null;
    const processor = (faster: boolean): EstimateRequest["route"] => ({
      family: "processor",
      faster,
      chipMaker: null,
      quick: false,
    });
    const standard = price(
      gathered,
      workload,
      shape,
      { output: { ...own, quality }, route: processor(false) },
      true,
    );
    const faster = price(
      gathered,
      workload,
      shape,
      { output: { ...own, quality }, route: processor(true) },
      true,
    );
    const chip = maker
      ? price(
          gathered,
          workload,
          shape,
          {
            output: { ...own, quality },
            route: { family: "chip", faster: false, chipMaker: maker, quick: false },
          },
          true,
        )
      : null;
    let quick: HonestEstimate | null = null;
    if (gathered.flags.estimate_v2) {
      // This prices the estimate design's Quick: a 1080p cap, 720p on a weak PC, as a ladder of the one rung. It is read only with estimate_v2 on, which this build holds off,
      // and it is not the Fast bundle the app runs (exportRoute.ts: one rung below the project): price that one from `quickSettings` before this is ever turned on.
      const settingsOfQuick = quickSettings({
        canvas: { width: workload.width, height: workload.height, fps: workload.fps },
        requested: {
          resolution: settings.resolution,
          fps: typeof settings.fps === "number" ? settings.fps : undefined,
          quality,
        },
        explicit: request.explicit,
        bundle: { ...QUICK_BUNDLE, ladder: [isWeakPc(gathered.cls) ? "720p" : "1080p"] },
      });
      const picture = deliveredPicture(workload, {
        resolution: settingsOfQuick.resolution,
        fps: settingsOfQuick.fps ?? null,
      });
      quick = price(
        gathered,
        workload,
        shape,
        {
          output: { ...picture, quality },
          route: maker
            ? { family: "chip", faster: false, chipMaker: maker, quick: true }
            : { family: "processor", faster: true, chipMaker: null, quick: true },
        },
        true,
      );
    }
    return {
      pcClass: PC_CLASSES.includes(gathered.cls) ? gathered.cls : "unknown",
      standard,
      quick,
      chip,
      faster,
    };
  } catch {
    return NONE;
  }
}

/** What the admission door knows about the export it is admitting: the plan's own picture, engine, encoder and rung. */
export interface AdmissionInput {
  workload: RenderWorkload;
  output: { width: number; height: number; fps: number };
  quality: string | undefined;
  engine: ExportEngine;
  encoder: ExportEncoder | undefined;
  rung?: Rung;
}

export interface AdmissionEstimate {
  /** What the person is told: the model with whatever this PC has learned. */
  estimate: HonestEstimate;
  /** The same model with no learned correction: what the pace log is taught against, so it never learns its own correction back. */
  uncorrected: HonestEstimate | null;
  pcClass: PcClass;
  family: EncoderFamily;
}

/** The honest estimate of the export exactly as the plan has fixed it, or null when it cannot be made. The same pricing as the dialog's, from the plan's engine, encoder and rung. */
export function admissionEstimate(
  input: AdmissionInput,
  deps: RouteEstimatesDeps,
): AdmissionEstimate | null {
  try {
    if (!isObject(input) || !isObject(input.workload) || !isObject(input.output)) return null;
    const gathered = gather(deps);
    const encoder = input.encoder ?? "x264-crf";
    const maker = encoder.startsWith("chip-") ? (encoder.slice(5) as ChipMaker) : null;
    const route: EstimateRequest["route"] = maker
      ? { family: "chip", faster: false, chipMaker: maker, quick: false }
      : {
          family: "processor",
          faster: encoder.startsWith("x264-fast"),
          chipMaker: null,
          quick: false,
        };
    const way: Way = {
      output: { ...input.output, quality: input.quality as ExportQuality | undefined },
      route,
      engine: input.engine,
      ...(input.rung === 1 || input.rung === 2 ? { rung: input.rung } : {}),
    };
    const shape = gathered.flags.estimate_v2 ? shapeOf(input.workload, deps) : null;
    const shown = price(gathered, input.workload, shape, way, true);
    if (!shown) return null;
    const uncorrected = gathered.flags.estimate_v2
      ? price(gathered, input.workload, shape, way, false)
      : shown;
    return { estimate: shown, uncorrected, pcClass: gathered.cls, family: route.family };
  } catch {
    return null;
  }
}
