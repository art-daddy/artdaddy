// Export delivery options: the size, quality and rate the finished video is written at.
//
// Deliberately applied at the OUTPUT stage rather than by rebuilding the composite at a different
// canvas size: the timeline composes at its own resolution and is scaled once on the way out, so
// changing a preset can never move a clip, resize a caption, or perturb the filtergraph a default
// export produces. A default export must stay byte-identical to what it was before presets
// existed, and there is a golden gate that says so.
export type ExportResolution = "source" | "2160p" | "1440p" | "1080p" | "720p" | "480p";
export type ExportQuality = "high" | "medium" | "low";

import type { Branding } from "./branding";

export interface ExportOptions {
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
