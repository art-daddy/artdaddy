// Export delivery options: the size, quality and rate the finished video is written at.
//
// Deliberately applied at the OUTPUT stage rather than by rebuilding the composite at a different
// canvas size: the timeline composes at its own resolution and is scaled once on the way out, so
// changing a preset can never move a clip, resize a caption, or perturb the filtergraph a default
// export produces. A default export must stay byte-identical to what it was before presets
// existed, and there is a golden gate that says so.
export type ExportResolution = "source" | "2160p" | "1440p" | "1080p" | "720p" | "480p";
export type ExportQuality = "high" | "medium" | "low";
export type ExportEngine = "file-sequence-v1" | "partition-pipes-v1" | "auto";
export type ExportMode = "quality" | "fast";
export type ExportEncoder = "x264-crf" | "amf-cqp18";

import type { Branding } from "./branding";
import type { RenderWorkload } from "./renderPlan";
import type { ExportResources } from "../platform/host";

export interface ExportEstimates {
  readonly memoryBytes: number | null;
  readonly temporaryBytes: number | null;
  readonly finalBytes: number | null;
  readonly seconds: number | null;
}

export interface ExportBudgets {
  readonly memoryBytes: number | null;
  readonly temporaryBytes: number | null;
  readonly executionSeconds: number | null;
}

export interface ExportCalibration {
  readonly workload: RenderWorkload;
  readonly output: { width: number; height: number; fps: number };
  readonly quality: string;
  readonly engine: ExportEngine;
  readonly encoder?: ExportEncoder;
  readonly elapsedSeconds: number;
  readonly finalBytes: number;
  readonly memoryBytes: number | null;
  readonly temporaryBytes: number | null;
}

export function estimateExportFromHistory(
  workload: RenderWorkload,
  output: ExportCalibration["output"],
  quality: string,
  engine: ExportEngine,
  history: readonly ExportCalibration[],
  encoder: ExportEncoder = "x264-crf",
): ExportEstimates {
  const samples = history.filter((sample) => (sample.encoder ?? "x264-crf") === encoder && sample.quality === quality && sample.engine === engine &&
    sample.workload.width === workload.width && sample.workload.height === workload.height && sample.workload.fps === workload.fps &&
    sample.output.width === output.width && sample.output.height === output.height && sample.output.fps === output.fps &&
    sample.workload.peakMediaLayers === workload.peakMediaLayers && sample.workload.peakVisualLayers === workload.peakVisualLayers &&
    sample.workload.durationSeconds > 0 && sample.elapsedSeconds > 0 && Number.isFinite(sample.elapsedSeconds) &&
    sample.finalBytes > 0 && Number.isFinite(sample.finalBytes));
  const maximum = (values: (number | null)[]) => {
    const valid = values.filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0);
    return valid.length ? Math.ceil(Math.max(...valid)) : null;
  };
  const scale = (sample: ExportCalibration) => Math.max(workload.durationSeconds / sample.workload.durationSeconds,
    workload.visualClips / Math.max(1, sample.workload.visualClips),
    workload.captionClips / Math.max(1, sample.workload.captionClips),
    workload.audioClips / Math.max(1, sample.workload.audioClips));
  return {
    seconds: maximum(samples.map((sample) => sample.elapsedSeconds * scale(sample))),
    finalBytes: maximum(samples.map((sample) => sample.finalBytes * workload.durationSeconds / sample.workload.durationSeconds)),
    memoryBytes: maximum(samples.map((sample) => sample.memoryBytes)),
    temporaryBytes: maximum(samples.map((sample) => sample.temporaryBytes === null ? null : sample.temporaryBytes * Math.max(1,
      workload.visualClips / Math.max(1, sample.workload.visualClips), workload.captionClips / Math.max(1, sample.workload.captionClips)))),
  };
}

export type ExportPreflightReason = "outside_promise" | "memory_unknown" | "memory_shortage" |
  "disk_unknown" | "disk_shortage" | "temporary_limit" | "time_unknown" | "execution_limit" | "slow";

export interface ExportAssessment {
  readonly promiseLine: "hd" | "heavy_hd" | "4k" | "outside";
  readonly severity: "none" | "notice" | "warning";
  readonly reasons: readonly ExportPreflightReason[];
  readonly estimates: ExportEstimates;
}

export function assessExport(
  workload: RenderWorkload,
  resources: ExportResources,
  measured: ExportEstimates,
  budgets: ExportBudgets,
): ExportAssessment {
  const valid = (value: number | null): value is number => value !== null && Number.isFinite(value) && value >= 0;
  const estimates: ExportEstimates = {
    memoryBytes: valid(measured.memoryBytes) ? measured.memoryBytes : null,
    temporaryBytes: valid(measured.temporaryBytes) ? measured.temporaryBytes : null,
    finalBytes: valid(measured.finalBytes) ? measured.finalBytes : null,
    seconds: valid(measured.seconds) ? measured.seconds : null,
  };
  const short = Math.min(workload.width, workload.height);
  const long = Math.max(workload.width, workload.height);
  const usable = Number.isFinite(short) && Number.isFinite(long) && short > 0 &&
    Number.isFinite(workload.fps) && workload.fps > 0 && Number.isFinite(workload.durationSeconds) && workload.durationSeconds > 0;
  const hd = usable && short <= 1080 && long <= 1920;
  const withinHd = hd && workload.durationSeconds <= 7200 && workload.visualClips <= 1000;
  const within4k = usable && !hd && short <= 2160 && long <= 3840 && workload.durationSeconds <= 1800 &&
    workload.peakVisualLayers <= 4 && workload.fps <= 30;
  const normalHd = withinHd && workload.peakVisualLayers <= 4 && workload.fps <= 60;
  const heavyHd = withinHd && workload.peakVisualLayers <= 8 && workload.fps <= 30;
  const promiseLine = normalHd ? "hd" : heavyHd ? "heavy_hd" : within4k ? "4k" : "outside";
  const reasons: ExportPreflightReason[] = [];
  if (promiseLine === "outside") reasons.push("outside_promise");
  const memory = estimates.memoryBytes;
  if (memory === null || !valid(resources.available_memory_bytes) || !valid(budgets.memoryBytes)) reasons.push("memory_unknown");
  else if (memory > Math.min(resources.available_memory_bytes, budgets.memoryBytes)) reasons.push("memory_shortage");
  const temporary = estimates.temporaryBytes;
  const final = estimates.finalBytes;
  if (temporary === null || final === null || !valid(resources.scratch_free_bytes) ||
    !valid(resources.destination_free_bytes) || !valid(budgets.temporaryBytes)) reasons.push("disk_unknown");
  else {
    if (temporary > budgets.temporaryBytes) reasons.push("temporary_limit");
    if (temporary + final > resources.scratch_free_bytes || temporary + final > resources.destination_free_bytes) reasons.push("disk_shortage");
  }
  if (estimates.seconds === null || !valid(budgets.executionSeconds)) reasons.push("time_unknown");
  else if (estimates.seconds > budgets.executionSeconds) reasons.push("execution_limit");
  else if (estimates.seconds > workload.durationSeconds * 2) reasons.push("slow");
  return { promiseLine, estimates, reasons,
    severity: reasons.some((reason) => reason !== "slow") ? "warning" : reasons.length ? "notice" : "none" };
}

export interface ExportOptions {
  engine?: ExportEngine;
  mode?: ExportMode;
  resolution?: ExportResolution;
  quality?: ExportQuality;
  fps?: number;
  /** Absolute paths to the watermark + end card a DELIVERABLE carries. Absent on the working
   *  renders (`renderTimelineTool`, the model's preview frames), which are not deliverables. */
  branding?: Branding;
  /** libx264 `-preset`. Absent leaves the encoder on its own default (medium) so a deliverable is
   *  unchanged; inspect_timeline sets it because that render is a FRAME SOURCE nobody watches. */
  preset?: string;
  /** Stop the output here when it is shorter than the timeline. inspect_timeline samples frames by
   *  absolute time, so everything after the last one it asked for is encoded and thrown away. */
  maxDurationSec?: number;
  /** Deliver only project frames [from, to): exactly the whole export's frames and sound there. */
  range?: { from: number; to: number };
}

/** The SHORTER side each preset targets. Reading presets off the short side means "1080p" is the
 *  same promise for a 1920x1080 landscape project and a 1080x1920 vertical one, which is how
 *  people actually use the word. */
const SHORT_SIDE: Record<Exclude<ExportResolution, "source">, number> = {
  "2160p": 2160,
  "1440p": 1440,
  "1080p": 1080,
  "720p": 720,
  "480p": 480,
};

/** libx264 CRF. Lower is better and bigger; 23 is the encoder's own default. */
const CRF: Record<ExportQuality, number> = { high: 18, medium: 23, low: 28 };

/** Output pixel size for a canvas under a preset, aspect preserved and both sides made EVEN.
 *
 *  Odd dimensions are not a rounding detail: yuv420p subsamples chroma by two, and ffmpeg refuses
 *  to encode an odd width or height at all ("width not divisible by 2"). Returns null when the
 *  canvas already matches, so no scale filter is emitted. */
export function outputSize(
  canvasW: number,
  canvasH: number,
  resolution: ExportResolution | undefined,
): { w: number; h: number } | null {
  if (!resolution || resolution === "source") return null;
  const target = SHORT_SIDE[resolution];
  if (!(canvasW > 0) || !(canvasH > 0) || !target) return null;
  const short = Math.min(canvasW, canvasH);
  // Never upscale: asking for 2160p from a 720p project invents detail and multiplies the
  // encode cost for nothing.
  if (short <= target) return null;
  const scale = target / short;
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  const w = even(canvasW * scale);
  const h = even(canvasH * scale);
  return w === canvasW && h === canvasH ? null : { w, h };
}

/** The `-crf` value, or null to leave libx264 on its own default. */
export function crfFor(quality: ExportQuality | undefined): number | null {
  return quality ? CRF[quality] : null;
}

/** The output frame rate: the requested one when it is usable, else the canvas rate. */
export function outputFps(canvasFps: number, requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) return canvasFps;
  const r = Math.round(requested);
  return r >= 1 && r <= 120 ? r : canvasFps;
}
