// HELD OFF ON PURPOSE, NOT DELETED (owner decision 2026-11-18): part of the held export-time guess machinery (flags
// `estimate_v2` and `pc_check`, both in OFF_IN_THIS_BUILD). Kept for a later release, so do not remove it as unused.
// The full note is in src/api/exportFlags.ts.
//
// Phase 3c: the ONE estimate every number about an export's time comes from. Pure and fail-soft: it never throws, and a figure it cannot make is
// null ("no estimate"), never a refused export, a negative time or an infinite one.
//
// With `estimate_v2` off it is 0.27.0's own estimate (`estimateExport`), mapped into the new record: the same seconds, the same file size, a range
// that is a point. With it on, a matching earlier export still speaks first (the maximum of the matches, as today); otherwise the project is
// priced from what it asks of the exporter (the cost shape) on this PC's pace:
//
//   T = F + c x rung x tFrame x ( kRM x engine x RM(project, recipes) + kENC x ENC(output, route) )
//
// in seconds, where `tFrame` is the PC's seconds for one reference frame (`rHat / 30`), RM is the project's read-and-mix cost and ENC its encode
// cost, both in reference frames (costTable.ts), `kRM` and `kENC` move cost between the two for a PC whose speed test says its split differs, and
// `c` is the learned correction, which moves the central figure only inside the range the model reports (see `honest`). A route divides ONLY the
// encode term, so a project that is mostly reading and drawing gets a small saving from the chip or the faster setting and a plain one a large
// saving; Quick is the same function on Quick's own size, rate and encoder.
import {
  COST_FEATURES,
  FACTS_DEPENDENT_FEATURES,
  type CostFeature,
  type CostShape,
  type FeatureLoads,
} from "./costShape";
import {
  BASE,
  BRANDING,
  ENCODE,
  ENGINE,
  FEATURE_PRICES,
  FIXED,
  PACE_LIMITS,
  PRIOR_PACE,
  PRIOR_SHAPE,
  RANGE,
  REFERENCE_FRAME,
  REFERENCE_MEGAPIXELS,
  RUNG_TIME_FACTOR,
  WEAK_PRIOR_PACE,
} from "./costTable";
import { CHIP_MAKERS, FASTER_X264_GAIN, type ChipMaker, type ExportEncoder } from "./exportEncoder";
import {
  estimateExport,
  estimateExportFromHistory,
  exceedsOnePass,
  finalEncoderPolicy,
  type ExportCalibration,
  type ExportEngine,
  type ExportQuality,
} from "./exportOptions";
import type { Rung } from "./exportPlan";
import type {
  EncoderFamily,
  EstimateBasis,
  Flags3c,
  HonestEstimate,
  PcClass,
} from "./exportTypes3c";
import type { RenderWorkload } from "./renderPlan";

/** What the PC check stores for this PC: the reference export's seconds per second of video, the speeds of its three runs (frames a second:
 *  read and mix, plus the normal encode, plus the faster setting's encode), the logical cores and the class. */
export interface PcPace {
  rHat: number;
  aFps: number | null;
  bFps: number | null;
  cFps: number | null;
  cores: number;
  cls: PcClass;
}

/** The recipe a clip will really run on: the lean one, or today's (the slow one). */
export type Recipe = "lean" | "today";

export interface EstimateRequest {
  /** 0.27.0's summary of the project: the legacy path and the guess read it. */
  workload: RenderWorkload;
  /** What the project asks of the exporter; null = unknown: priced on a prior and the range widens upward. */
  shape: CostShape | null;
  output: { width: number; height: number; fps: number; quality: ExportQuality | undefined };
  route: { family: EncoderFamily; faster: boolean; chipMaker: ChipMaker | null; quick: boolean };
  /** The PC check's result for this PC, if any. */
  pace: PcPace | null;
  /** The learned ratio from the pace log (already looked up), or null. */
  correction: number | null;
  /** 0.27.0's finished samples, as today. */
  history: ExportCalibration[];
  /** The per-clip lean decision; absent = every clip on today's (slow, pessimistic) recipe. */
  recipeOf?: (clipId: string) => Recipe;
  flags: Pick<Flags3c, "estimate_v2" | "pc_check">;
  nowMs?: number;
  /** The engine the export will run, when the caller knows it (the admission door: the plan sees triggers the dialog cannot). Absent = the one
   *  the Automatic policy picks from the workload, as the dialog does. */
  engine?: ExportEngine;
  /** The rung the export will run at (a gentler one is slower). Absent = the normal one. */
  rung?: Rung;
}

const MAX_SECONDS = 1e9;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const nonNegative = (value: unknown): number => (positive(value) ? value : 0);
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const familyOf = (encoder: ExportEncoder): EncoderFamily =>
  encoder.startsWith("chip-") ? "chip" : "processor";

const WORKLOAD_KEYS = [
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

/** A sample the 0.27.0 estimator can read. The persisted validator makes every stored one so; a malformed one is dropped, not fatal. */
function isCalibration(sample: unknown): sample is ExportCalibration {
  if (!isObject(sample) || !isObject(sample.workload) || !isObject(sample.output)) return false;
  const workload = sample.workload;
  const output = sample.output;
  return (
    WORKLOAD_KEYS.every((key) => typeof workload[key] === "number") &&
    (["width", "height", "fps"] as const).every((key) => typeof output[key] === "number") &&
    typeof sample.quality === "string" &&
    typeof sample.engine === "string" &&
    typeof sample.elapsedSeconds === "number" &&
    typeof sample.finalBytes === "number"
  );
}

interface Base {
  workload: RenderWorkload;
  picture: { width: number; height: number; fps: number };
  quality: ExportQuality;
  engine: ExportEngine;
  encoder: ExportEncoder;
  history: ExportCalibration[];
}

/** What both paths read the same way: the delivered picture, the engine the dialog would assume, and the encoder that route asks for. */
function readBase(req: EstimateRequest): Base | null {
  if (!isObject(req)) return null;
  const { workload, output, route } = req;
  if (!isObject(workload) || !isObject(output) || !isObject(route)) return null;
  const picture = {
    width: Number(output.width),
    height: Number(output.height),
    fps: Number(output.fps),
  };
  const quality: ExportQuality =
    output.quality === "high" || output.quality === "low" ? output.quality : "medium";
  const engine: ExportEngine =
    req.engine === "file-sequence-v1" || req.engine === "partition-pipes-v1"
      ? req.engine
      : exceedsOnePass(workload, workload)
        ? "partition-pipes-v1"
        : "file-sequence-v1";
  const maker =
    route.family === "chip" && CHIP_MAKERS.includes(route.chipMaker as ChipMaker)
      ? (route.chipMaker as ChipMaker)
      : null;
  const { encoder } = finalEncoderPolicy(picture, engine, maker ? "fast" : "quality", {
    chip: maker,
    faster: route.faster === true,
  });
  const history = Array.isArray(req.history) ? req.history.filter(isCalibration) : [];
  return { workload, picture, quality, engine, encoder, history };
}

const finiteBytes = (value: number | null): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** 0.27.0's numbers, in the new record. */
function legacy(req: EstimateRequest): HonestEstimate | null {
  const base = readBase(req);
  if (!base) return null;
  const result = estimateExport(
    base.workload,
    base.picture,
    base.quality,
    base.engine,
    base.history,
    base.encoder,
  );
  const { seconds } = result;
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  // A zero-length project with an earlier export "takes" 0 s in 0.27.0; the record promises at least a second.
  const whole = Math.max(1, seconds);
  return {
    seconds: whole,
    low: whole,
    high: whole,
    basis: result.secondsGuessed === true ? "guess" : "history",
    bytes: finiteBytes(result.finalBytes),
    muchLonger: false,
    family: familyOf(base.encoder),
  };
}

interface Pace {
  /** Seconds one reference frame takes on this PC. */
  tFrame: number;
  /** The share of the reference export's time that is reading and mixing, on this PC. */
  readMix: number;
  cores: number;
  fasterGain: number;
  basis: Extract<EstimateBasis, "pc_check" | "guess">;
}

/** This PC's pace from its speed test, or the prior PC's when there is no usable one (no result, the check is off or its record is damaged). A check that could not
 *  finish is a weak PC's pace, still a guess. */
function readPace(pace: PcPace | null | undefined, enabled: boolean): Pace {
  const prior: Pace = {
    tFrame: PRIOR_PACE.rHat / 30,
    readMix: REFERENCE_FRAME.readMix,
    cores: PRIOR_PACE.cores,
    fasterGain: ENCODE.fasterGain,
    basis: "guess",
  };
  if (!enabled || !isObject(pace) || pace.cls === "unknown") return prior;
  // The check could not finish: priced as a weak PC, but nothing was measured, so whatever speed the record carries is not believed and the basis stays a guess.
  if (pace.cls === "unfinished")
    return {
      ...prior,
      tFrame: WEAK_PRIOR_PACE.rHat / 30,
      cores: positive(pace.cores) ? pace.cores : WEAK_PRIOR_PACE.cores,
    };
  if (!positive(pace.rHat)) return prior;
  const { aFps, bFps, cFps } = pace;
  const split = positive(aFps) && positive(bFps);
  // The reference export's time is reading and mixing (A) plus encoding (B less A): the speed test's split of it on this PC.
  const readMix = split
    ? clamp(bFps / aFps, PACE_LIMITS.readMixShare.min, PACE_LIMITS.readMixShare.max)
    : REFERENCE_FRAME.readMix;
  // The faster setting's gain on this PC when its run says so, never above the lab's.
  let fasterGain: number = FASTER_X264_GAIN;
  if (split && positive(cFps)) {
    const encodeNormal = 1 / bFps - 1 / aFps;
    const encodeFaster = 1 / cFps - 1 / aFps;
    if (encodeNormal > 0 && encodeFaster > 0)
      fasterGain = clamp(encodeNormal / encodeFaster, 1, FASTER_X264_GAIN);
  }
  return {
    tFrame: clamp(pace.rHat, PACE_LIMITS.rHat.min, PACE_LIMITS.rHat.max) / 30,
    readMix,
    cores: positive(pace.cores) ? pace.cores : PRIOR_PACE.cores,
    fasterGain,
    basis: "pc_check",
  };
}

/** Reference frames of a set of loads on one recipe, optionally only for some features. */
function loadsRf(
  loads: FeatureLoads | undefined,
  recipe: Recipe,
  only: readonly CostFeature[] = COST_FEATURES,
): number {
  if (!isObject(loads)) return 0;
  let total = 0;
  for (const feature of only) {
    const load = loads[feature];
    const price = FEATURE_PRICES[feature];
    if (!isObject(load) || !price) continue;
    const frames = nonNegative(load.frames);
    const window = Math.min(frames, nonNegative(load.windowFrames));
    const unit = price.unit === "frame" ? 1 : nonNegative(load.mp);
    const { frame, window: extra } = price[recipe];
    total += unit * (frame * frames + extra * window);
  }
  return total;
}

interface Context {
  base: Base;
  pace: Pace;
  shape: CostShape | null;
  recipeOf: ((clipId: string) => Recipe) | undefined;
  rung: number;
}

interface Route {
  /** What the encode term is divided by. */
  gain: number;
  /** Whether the processor's quality tiers apply (a chip's rate control is its own). */
  processor: boolean;
}

interface Priced {
  fixed: number;
  variable: number;
  /** Seconds of the variable part that rest on source facts nobody knew: they may cost more than priced. */
  unknown: number;
}

function recipeFor(context: Context, clipId: string): Recipe {
  if (!context.recipeOf) return "today";
  try {
    return context.recipeOf(clipId) === "lean" ? "lean" : "today";
  } catch {
    return "today";
  }
}

function priceProject(context: Context, route: Route): Priced {
  const { base, pace, shape } = context;
  const { workload, picture } = base;
  const canvasScale = (workload.width * workload.height) / 1e6 / REFERENCE_MEGAPIXELS;
  const canvasFrames = workload.durationSeconds * workload.fps;
  let rm = (BASE.canvasFrame + BRANDING.watermarkFrame) * canvasFrames * canvasScale;
  let unknown = 0;
  let inputs = nonNegative(workload.visualClips) + nonNegative(workload.audioClips);
  if (shape) {
    for (const clip of Array.isArray(shape.clips) ? shape.clips : []) {
      if (!isObject(clip)) continue;
      const recipe = recipeFor(context, String(clip.id));
      const layer = BASE.layerFrame * nonNegative(clip.frames) * canvasScale;
      rm += layer + loadsRf(clip.loads, recipe);
      if (clip.known === false)
        unknown += layer + loadsRf(clip.loads, recipe, FACTS_DEPENDENT_FEATURES);
    }
    rm += loadsRf(shape.common, "today");
    const counted: Record<string, unknown> = isObject(shape.inputs) ? shape.inputs : {};
    inputs = nonNegative(counted.video) + nonNegative(counted.still) + nonNegative(counted.audio);
  } else {
    const layers = Math.max(1, nonNegative(workload.peakMediaLayers));
    rm = (rm + BASE.layerFrame * canvasFrames * layers * canvasScale) * PRIOR_SHAPE.featureMultiple;
  }
  const outputScale = (picture.width * picture.height) / 1e6 / REFERENCE_MEGAPIXELS;
  const tier = route.processor ? ENCODE.quality[base.quality] : 1;
  const encode =
    (workload.durationSeconds * picture.fps * outputScale * REFERENCE_FRAME.encode * tier) /
    route.gain;

  const streamed = base.engine === "partition-pipes-v1";
  const engine = streamed
    ? clamp(ENGINE.streamed.perCore * pace.cores, ENGINE.streamed.min, ENGINE.streamed.max)
    : 1;
  const kRM = pace.readMix / REFERENCE_FRAME.readMix;
  const kENC = (1 - pace.readMix) / REFERENCE_FRAME.encode;
  const perRf = pace.tFrame * RUNG_TIME_FACTOR[context.rung];
  const partitions = streamed ? Math.ceil(workload.durationSeconds / ENGINE.partitionSeconds) : 0;
  return {
    fixed:
      FIXED.seconds +
      FIXED.perInputSeconds * inputs +
      BRANDING.endCardFrames * pace.tFrame +
      partitions * ENGINE.partitionStartSeconds,
    variable: perRf * (kRM * engine * rm + kENC * encode),
    unknown: perRf * kRM * engine * unknown,
  };
}

/** What the request's own route divides the encode term by. */
function routeOf(base: Base, pace: Pace): Route {
  if (base.encoder.startsWith("chip-"))
    return { gain: ENCODE.chipGain[base.encoder.slice(5) as ChipMaker] ?? 1, processor: false };
  if (base.encoder.startsWith("x264-fast")) return { gain: pace.fasterGain, processor: true };
  return { gain: 1, processor: true };
}

/** Whole, ordered, finite seconds, or null when the figures are not numbers. */
function finish(
  central: number,
  lowRaw: number,
  highRaw: number,
  fields: Pick<HonestEstimate, "basis" | "bytes" | "family"> & {
    muchLonger: (high: number, seconds: number) => boolean;
  },
): HonestEstimate | null {
  if (![central, lowRaw, highRaw].every(Number.isFinite)) return null;
  const seconds = Math.max(1, Math.ceil(Math.min(MAX_SECONDS, central)));
  const low = Math.max(1, Math.min(seconds, Math.floor(Math.min(MAX_SECONDS, lowRaw))));
  const high = Math.max(seconds, Math.ceil(Math.min(MAX_SECONDS, highRaw)));
  return {
    seconds,
    low,
    high,
    basis: fields.basis,
    bytes: fields.bytes,
    muchLonger: fields.muchLonger(high, seconds),
    family: fields.family,
  };
}

interface Measured {
  max: number;
  min: number;
  bytes: number | null;
}

/** What earlier exports on this PC say for one encoder, by the one rule 0.27.0 uses: the maximum of the matches. The minimum gives the range. */
function measuredFor(base: Base, encoder: ExportEncoder): Measured | null {
  const all = estimateExportFromHistory(
    base.workload,
    base.picture,
    base.quality,
    base.engine,
    base.history,
    encoder,
  );
  if (all.seconds === null) return null;
  const each = base.history
    .map(
      (sample) =>
        estimateExportFromHistory(
          base.workload,
          base.picture,
          base.quality,
          base.engine,
          [sample],
          encoder,
        ).seconds,
    )
    .filter((value): value is number => value !== null);
  return { max: all.seconds, min: Math.min(...each), bytes: all.finalBytes };
}

function fromHistory(context: Context, route: Route): HonestEstimate | null {
  const { base } = context;
  const family = familyOf(base.encoder);
  const own = measuredFor(base, base.encoder);
  if (own) {
    const high = RANGE.history.high * own.max;
    const low = Math.min(own.min, RANGE.history.low * own.max);
    return finish(own.max, low, high, {
      basis: "history",
      bytes: finiteBytes(own.bytes),
      family,
      muchLonger: (top, seconds) => top > RANGE.muchLongerOver * seconds,
    });
  }
  // Nothing measured for this encoder, but the processor's normal setting has run this export: keep its level and move only what the route
  // changes, the encode term. The bytes are not claimed for an encoder that has not run here.
  const normal = finalEncoderPolicy(base.picture, base.engine, "quality", {
    chip: null,
    faster: false,
  }).encoder;
  if (normal === base.encoder) return null;
  const processor = measuredFor(base, normal);
  if (!processor) return null;
  const reference = priceProject(context, { gain: 1, processor: true });
  const requested = priceProject(context, route);
  const ratio = (requested.fixed + requested.variable) / (reference.fixed + reference.variable);
  const central = processor.max * ratio;
  return finish(central, RANGE.derived.low * central, RANGE.derived.high * central, {
    basis: "history",
    bytes: null,
    family,
    muchLonger: (top, seconds) => top > RANGE.muchLongerOver * seconds,
  });
}

function honest(req: EstimateRequest): HonestEstimate | null {
  const base = readBase(req);
  if (!base) return null;
  const { workload, picture } = base;
  if (
    ![workload.width, workload.height, workload.fps, workload.durationSeconds].every(positive) ||
    ![picture.width, picture.height, picture.fps].every(positive)
  )
    return null;
  const pace = readPace(req.pace, req.flags.pc_check === true);
  const shape =
    isObject(req.shape) && Array.isArray(req.shape.clips) && isObject(req.shape.common)
      ? req.shape
      : null;
  const context: Context = {
    base,
    pace,
    shape,
    recipeOf: typeof req.recipeOf === "function" ? req.recipeOf : undefined,
    rung: req.rung === 1 || req.rung === 2 ? req.rung : 0,
  };
  const route = routeOf(base, pace);
  const earlier = fromHistory(context, route);
  if (earlier) return earlier;

  const priced = priceProject(context, route);
  const band = RANGE[pace.basis];
  // A learned correction moves the central figure only inside the range the model already stood behind, so a poisoned or freak log can never
  // put the estimate outside it; it never moves the range itself.
  const learned = positive(req.correction) ? req.correction : 1;
  const unpriced = shape ? nonNegative(shape.unpricedFeatures) : 0;
  const central = priced.fixed + priced.variable * clamp(learned, band.low, band.high);
  const low = priced.fixed + priced.variable * band.low;
  const high =
    priced.fixed +
    priced.variable * band.high * (shape ? 1 : RANGE.unknownShapeHigh) +
    RANGE.unknownFactsExtra * priced.unknown +
    RANGE.unpricedExtra * unpriced * priced.variable;
  return finish(central, low, high, {
    basis: pace.basis,
    bytes: null,
    family: familyOf(base.encoder),
    muchLonger: (top, seconds) =>
      shape === null || unpriced > 0 || top > RANGE.muchLongerOver * seconds,
  });
}

/** The ONE entry. `flags.estimate_v2` false gives 0.27.0's numbers, true the priced model. Null is "no estimate": the caller shows no line. */
export function estimate(req: EstimateRequest): HonestEstimate | null {
  try {
    const result = req?.flags?.estimate_v2 === true ? honest(req) : legacy(req);
    if (result === null) return null;
    const ordered =
      Number.isFinite(result.seconds) &&
      Number.isFinite(result.low) &&
      Number.isFinite(result.high) &&
      result.low >= 1 &&
      result.low <= result.seconds &&
      result.seconds <= result.high;
    return ordered ? result : null;
  } catch {
    return null;
  }
}
