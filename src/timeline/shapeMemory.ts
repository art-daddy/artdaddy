// Phase 3c: the memory an export is expected to need, from the project's shape (DESIGN 5). Pure and fail-soft. It stands in only where this PC has
// no measurement of the shape (the plan's `unmeasured` branch) and is never below one that was passed in. Units are MiB, the peak resident
// set of the export's processes, the figure the native watcher's cap is about (exportPlan.ts `CEILING_CAP_BYTES`).
//
// The structure follows what holds memory in an export, so the rung and the engine act through the code's own rules (`decoderThreads` and
// `RUNG_THREAD_CAPS`, the ONE thread policy) and not through a copy of them: x264's look-ahead and one frame per encoder thread at the composite's
// size; each video input's decoder, one frame per frame thread and its references; each still's decoder, which has no cap; what each picture
// clip's chain holds in the filter graph, at the size it works at (a zoom's largest, a float-RGB grade's twelve bytes a pixel); a few canvas frames
// per extra visible layer. The streamed engine runs one partition at a time on one thread per filter and is priced by the canvas and the layers.
//
// EVERY NUMBER IN `MEMORY_TABLE` IS A PLACEHOLDER, seeded from the measured RED peaks (peak working set, MiB, 16 processors) and the exportPlan.ts
// lab note, then rounded up. They are not fitted: the lane fits them on the rig matrix.
import type { CostClip, CostShape, FeatureLoads } from "./costShape";
import { decoderThreads, type ExportEngine } from "./exportOptions";
import { RUNG_THREAD_CAPS, capThreads, type Rung } from "./exportPlan";

const MIB = 1024 * 1024;
/** The size the streamed engine's per-layer figure is quoted at: 1080 x 1920, 2.0736 megapixels. */
const QUOTED_MEGAPIXELS = 2.0736;

/** Seeds, by line: `base` BASE-V 489 (one clip, 1080x1920); `x264` the encoder's `rc_lookahead=40` and its frame threads (RED-NOTES: 60 to 80
 *  frames held before the first packet); `decoder` the code's own lab (exportOptions.ts 8K HEVC: 3.52 GiB at rung 0, 0.83 at rung 1, 0.76 at
 *  rung 2); `chain` R4 (6 clips, 1,368) and R9 (21 clips, 3,601): about 135 to 145 MiB for each input at 1080x1920, graded or not;
 *  `still` R12 (24 pictures of 3840x2160, 13,299) against R8b (30 photos, 3,441); `streamed` R4 864, R6 (4K canvas) 1,949, both streamed; `safety`
 *  keeps a placeholder from under-predicting what its seeds are rounded from. */
export const MEMORY_TABLE = {
  base: { onePass: 60, streamed: 480 },
  x264: {
    lookaheadFrames: 40,
    threadsPerCore: 1.5,
    maxThreads: 24,
    bytesPerPixel: 1.5,
    copies: 1.3,
  },
  decoder: { defaultThreadsMax: 16, refsPerThread: 2 },
  /** A still whose decoded frame is RGB-sized (a PNG) decodes on a frame thread a processor, so it holds that many frames; one in a YUV
   *  format (a JPEG photo) holds the base. The share rises from 0 at 1.5 bytes a pixel to 1 at 3. */
  still: { baseFrames: 2, framesPerCore: 1, maxCores: 16, threadedFrom: 1.5, threadedTo: 3 },
  chain: {
    queueFrames: 14,
    workFrames: 4,
    gradeFrames: 1.5,
    bytesPerPixel: 4,
    gradeBytesPerPixel: 12,
  },
  layer: { frames: 3, bytesPerPixel: 4 },
  audio: { perInput: 4 },
  streamed: { perCanvasMp: 176, perExtraLayer: 40 },
  safety: 1.3,
  /** Beyond these the table has nothing to say: "not predicted" (the flat reserve of exportPlan.ts stays the floor). */
  limits: { cores: 128, canvasMp: 36, sourceMp: 60, clips: 200 },
} as const;

export interface ShapeMemoryInput {
  /** The engine the export will run: the streamed one or the one-pass one. */
  engine: ExportEngine;
  rung: Rung;
  shape: CostShape | null;
  /** Logical processors of this PC. */
  cores: number;
  /** Peaks measured on this PC for this shape, MiB, each at the rung it ran at: the prediction is never below one measured at the rung asked
   *  about or at a gentler one (a gentler rung needs no more). */
  measured?: ReadonlyArray<{ rung: Rung; mib: number }>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const nonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const frameMiB = (megapixels: number, bytesPerPixel: number) =>
  (megapixels * 1e6 * bytesPerPixel) / MIB;

/** The size a picture clip's filters work at: its box at the zoom's largest, or the picture scaled to cover that box, or a rotated surface. */
function workingMegapixels(clip: CostClip): number {
  const loads: FeatureLoads = isObject(clip.loads) ? clip.loads : {};
  const sizes = [clip.mp, loads.cover_zoom?.mp, loads.contain_zoom?.mp, loads.rotate?.mp];
  return Math.max(...sizes.filter(nonNegative));
}

/** The shape if every number the model reads is one, the facts of every picture clip are known and it is inside the table; else null. */
function usable(shape: CostShape | null): CostShape | null {
  if (!isObject(shape) || !isObject(shape.canvas) || !isObject(shape.inputs)) return null;
  if (!Array.isArray(shape.clips) || shape.clips.length > MEMORY_TABLE.limits.clips) return null;
  const { width, height } = shape.canvas;
  if (!positive(width) || !positive(height)) return null;
  if ((width * height) / 1e6 > MEMORY_TABLE.limits.canvasMp) return null;
  if (!nonNegative(shape.peakLayers) || !nonNegative(shape.inputs.audio)) return null;
  for (const clip of shape.clips) {
    if (!isObject(clip) || clip.known !== true) return null;
    if (clip.kind !== "video" && clip.kind !== "still") return null;
    if (!positive(clip.sourceMp) || clip.sourceMp > MEMORY_TABLE.limits.sourceMp) return null;
    if (!positive(clip.bytesPerPixel) || !nonNegative(clip.mp)) return null;
  }
  return shape;
}

function onePassMiB(shape: CostShape, rung: Rung, cores: number): number {
  const { x264, decoder, still, chain, layer, audio } = MEMORY_TABLE;
  const caps = RUNG_THREAD_CAPS[rung];
  const canvas = (shape.canvas.width * shape.canvas.height) / 1e6;
  // A rung caps a thread count that ffmpeg or the code chose; it never raises one, so a PC with fewer processors than the cap keeps its own.
  const encoderBase = Math.min(cores * x264.threadsPerCore, x264.maxThreads);
  const encoderThreads = capThreads(encoderBase, caps.encoder) ?? encoderBase;
  let total =
    MEMORY_TABLE.base.onePass +
    (x264.lookaheadFrames + encoderThreads) * frameMiB(canvas, x264.bytesPerPixel) * x264.copies +
    audio.perInput * shape.inputs.audio;
  // Each video input's decoder: the code's own budget of frame threads, capped further by the rung; ffmpeg's own count is a thread a processor.
  const videos = shape.clips.filter((clip) => clip.kind === "video").length;
  const decoderBase =
    decoderThreads("file-sequence-v1", videos) ?? Math.min(cores, decoder.defaultThreadsMax);
  const threadsEach = capThreads(decoderBase, caps.decoder) ?? decoderBase;
  const stillFrames = (bytesPerPixel: number) => {
    const threaded = Math.min(
      1,
      Math.max(0, (bytesPerPixel - still.threadedFrom) / (still.threadedTo - still.threadedFrom)),
    );
    return still.baseFrames + still.framesPerCore * Math.min(cores, still.maxCores) * threaded;
  };
  for (const clip of shape.clips) {
    const decoded = frameMiB(clip.sourceMp!, clip.bytesPerPixel!);
    const working = workingMegapixels(clip);
    // A video's decoder runs ahead of the graph and fills its queue; a still is read when its frame is asked for.
    if (clip.kind === "video")
      total +=
        threadsEach * decoded * decoder.refsPerThread +
        chain.queueFrames * frameMiB(clip.mp, chain.bytesPerPixel);
    else total += stillFrames(clip.bytesPerPixel!) * decoded;
    total += chain.workFrames * frameMiB(working, chain.bytesPerPixel);
    if (clip.loads.grade_rgb)
      total += chain.gradeFrames * frameMiB(working, chain.gradeBytesPerPixel);
  }
  return (
    total + Math.max(0, shape.peakLayers - 1) * layer.frames * frameMiB(canvas, layer.bytesPerPixel)
  );
}

function streamedMiB(shape: CostShape): number {
  const { streamed } = MEMORY_TABLE;
  const canvas = (shape.canvas.width * shape.canvas.height) / 1e6;
  return (
    MEMORY_TABLE.base.streamed +
    streamed.perCanvasMp * canvas +
    streamed.perExtraLayer * Math.max(0, shape.peakLayers - 1) * (canvas / QUOTED_MEGAPIXELS)
  );
}

/** The peak resident memory, in whole MiB, that an export of this shape is expected to need on this engine, at this rung, on a PC with this many
 *  logical processors; null when it cannot say: no shape, a source whose facts are unknown, a shape outside the table. Never throws, never
 *  negative, never below a measured peak passed in. */
export function predictShapePeakMiB(input: ShapeMemoryInput): number | null {
  try {
    if (!isObject(input)) return null;
    const { engine, rung, cores } = input;
    if (engine !== "file-sequence-v1" && engine !== "partition-pipes-v1") return null;
    if (rung !== 0 && rung !== 1 && rung !== 2) return null;
    if (!positive(cores) || cores > MEMORY_TABLE.limits.cores) return null;
    const shape = usable(input.shape);
    if (!shape) return null;
    const modelled =
      (engine === "file-sequence-v1" ? onePassMiB(shape, rung, cores) : streamedMiB(shape)) *
      MEMORY_TABLE.safety;
    const floors = Array.isArray(input.measured)
      ? input.measured
          .filter(
            (sample) =>
              isObject(sample) &&
              positive(sample.mib) &&
              typeof sample.rung === "number" &&
              sample.rung >= rung &&
              sample.rung <= 2,
          )
          .map((sample) => sample.mib)
      : [];
    const peak = Math.ceil(Math.max(modelled, ...floors));
    return Number.isFinite(peak) && peak >= 0 ? peak : null;
  } catch {
    return null;
  }
}
