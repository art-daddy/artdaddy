// Phase 3c: the facts about a project that the honest estimate prices (the "cost shape"). Pure and fail-soft: it reads the same Timeline as
// `summarizeRenderWorkload`, through the same render plan, and never throws; null means "cannot compute". It prices nothing itself: costTable.ts
// holds the prices and estimator.ts multiplies them by these loads.
//
// A load is "this feature's filter runs on `frames` frames of the clip, of which `windowFrames` are the frames it does useful work on (a
// transition's own window, a fade's ramps), at `mp` megapixels per frame". Today's recipe pays for every frame; lane L3's lean recipe pays
// the window only, so the two prices differ and the estimator needs both counts.
import { isNum, toSecondsView } from "./frames";
import { clipKind } from "./helpers";
import type { Clip, Timeline } from "./model";
import { onCanvasFrames, resolveRenderPlan } from "./renderPlan";

/** What the estimator needs to know about one source file. Lane L3's `SourceFacts` is assignable to it. */
export interface CostSourceFacts {
  width: number;
  height: number;
  fps: number | null;
  codec: string | null;
  pixFmt: string | null;
  hasAlpha: boolean;
}
export type SourceFactsLookup = (mediaId: string) => CostSourceFacts | null;

/** Every feature of a project the estimator prices, closed. costTable.ts must hold a price for each, for both recipes (a conformance test walks
 *  the list). A feature the exporter can emit that is not here is either free (measured) or reported as `unpricedFeatures`. */
export const COST_FEATURES = [
  "cover_zoom",
  "contain_zoom",
  "crossfade",
  "whip",
  "wipe",
  "dip",
  "fade",
  "opacity_animated",
  "opacity_constant",
  "blend",
  "rotate",
  "glow",
  "blur",
  "vignette",
  "grain",
  "denoise",
  "sharpen",
  "clarity",
  "motion",
  "chroma",
  "grade_basic",
  "grade_rgb",
  "grade_wheels",
  "still_decode",
  "speed_change",
  "crop_flip",
  "loudness",
  "captions",
] as const;
export type CostFeature = (typeof COST_FEATURES)[number];

/** The features whose cost depends on a source's own size: a clip whose facts are unknown is priced on a prior for these and its range widens. */
export const FACTS_DEPENDENT_FEATURES: readonly CostFeature[] = ["still_decode", "cover_zoom"];

// PLACEHOLDERS for sources whose facts are unknown (the shape reads them, the estimator never sees them): a phone photo is 12 megapixels and a
// 1080p picture 2, so an unknown still is priced at a middling 4; a cover zoom scales the picture to cover its box, which is the box's own size
// for a canvas-shaped source, 1.3 times it for a 3:4 picture on a 9:16 canvas and 3.2 times for a 16:9 clip on it (FILTER-MAP.md 8.8).
export const UNKNOWN_STILL_MEGAPIXELS = 4;
export const UNKNOWN_COVER_FACTOR = 2;

/** A guard against garbage, not a limit of the product: a scale beyond this prices as this. */
const MAX_SCALE = 16;
const MAX_SPEED = 16;
const MIN_SPEED = 0.05;
const MAX_LOAD = 1e9;

export interface FeatureLoad {
  /** Frames the feature's filter runs on today. */
  frames: number;
  /** Frames of those it does useful work on (its window); never above `frames`. */
  windowFrames: number;
  /** Megapixels per frame at which it runs (the clip's box at its largest zoom, a rotated surface, a still's own size). */
  mp: number;
}
export type FeatureLoads = Partial<Record<CostFeature, FeatureLoad>>;

export interface CostClip {
  /** The id the render plan gives the clip: what `recipeOf` is asked about. A clip with no id has a track-positional one, as in the plan. */
  id: string;
  kind: "video" | "still";
  /** Frames the clip is on canvas in the range, its transition's lead-in and hold included. */
  frames: number;
  /** The clip's box in megapixels at its largest scale. */
  mp: number;
  /** The source's size in megapixels, or null when its facts are unknown. */
  sourceMp: number | null;
  /** Whether the source has more than 8 bits per sample (null: unknown). */
  tenBit: boolean | null;
  /** Bytes one pixel of the source's decoded frame takes (null: unknown, or a pixel format this does not know). */
  bytesPerPixel: number | null;
  /** Whether the source's facts were known when the shape was made. */
  known: boolean;
  loads: FeatureLoads;
}

export interface CostShape {
  canvas: { width: number; height: number; fps: number };
  /** Frames in the range (the range's own length, picture or not). */
  canvasFrames: number;
  /** On-canvas frames summed over the clips of each kind. */
  frames: { video: number; still: number; caption: number; audio: number };
  /** The picture clips (video and stills) on canvas in the range. */
  clips: CostClip[];
  /** Features that belong to no picture clip: captions and sound. */
  common: FeatureLoads;
  /** The picture clips' frames summed: `layerFrames / canvasFrames` is the mean number of visible picture layers. */
  layerFrames: number;
  peakLayers: number;
  meanLayers: number;
  /** The caption bands that draw in the range: one full-frame text pass each. */
  captionBands: number;
  /** What the command would open: each picture clip, still and sound clip is an input. */
  inputs: { video: number; still: number; audio: number };
  /** Distinct sources on canvas whose facts were not known (all of them when no lookup was given). */
  unknownSources: number;
  /** Uses of a feature that cannot be priced (a custom filter): the estimate says "could take much longer". */
  unpricedFeatures: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** The numeric values of an animation's keyframes, or null when it is not a list with at least one. */
function keyframeValues(animation: unknown): number[] | null {
  if (!Array.isArray(animation)) return null;
  const values = animation
    .map((frame) => (isRecord(frame) ? frame.v : undefined))
    .filter((value): value is number => finite(value));
  return values.length > 0 ? values : null;
}

/** A scale at its largest: the number, or the highest keyframe. Null when it is neither. */
function peakScale(animation: unknown): number | null {
  if (finite(animation)) return clamp(animation, 0, MAX_SCALE);
  const values = keyframeValues(animation);
  return values === null ? null : clamp(Math.max(...values), 0, MAX_SCALE);
}

/** Facts that make sense: a positive finite size. Anything else is "unknown". */
function usableFacts(value: unknown): CostSourceFacts | null {
  if (!isRecord(value)) return null;
  const { width, height } = value;
  if (!finite(width) || !finite(height) || width <= 0 || height <= 0) return null;
  return {
    width,
    height,
    fps: finite(value.fps) && value.fps > 0 ? value.fps : null,
    codec: typeof value.codec === "string" ? value.codec : null,
    pixFmt: typeof value.pixFmt === "string" ? value.pixFmt : null,
    hasAlpha: value.hasAlpha === true,
  };
}

/** More than 8 bits per sample, from an ffmpeg pixel format name. */
function overEightBit(pixFmt: string | null): boolean | null {
  if (pixFmt === null) return null;
  return /(?:10|12|14|16)(?:le|be)$|^p01[026]|^(?:rgb|bgr)a?(?:48|64)/i.test(pixFmt);
}

/** Bytes one pixel of a decoded frame takes in an ffmpeg pixel format, or null for a name this does not know. */
function bytesPerPixelOf(pixFmt: string | null): number | null {
  if (pixFmt === null) return null;
  const name = pixFmt.toLowerCase();
  const deep = /(?:10|12|14|16)(?:le|be)$/.test(name) ? 2 : 1;
  if (/^(?:rgb|bgr)a64/.test(name)) return 8;
  if (/^(?:rgb|bgr)48/.test(name)) return 6;
  if (/^(?:rgba|bgra|argb|abgr|0rgb|rgb0|0bgr|bgr0)/.test(name)) return 4;
  if (/^(?:rgb|bgr)24/.test(name)) return 3;
  if (/^gbrap/.test(name)) return 4 * deep;
  if (/^gbrp/.test(name)) return 3 * deep;
  if (/^yuva420p/.test(name)) return 2.5 * deep;
  if (/^yuva422p/.test(name)) return 3 * deep;
  if (/^yuva444p/.test(name)) return 4 * deep;
  if (/^yuvj?420p|^nv12|^nv21/.test(name)) return 1.5 * deep;
  if (/^p01[026]/.test(name)) return 3;
  if (/^yuvj?422p/.test(name)) return 2 * deep;
  if (/^yuvj?444p/.test(name)) return 3 * deep;
  if (/^(?:gray|pal8|monob)/.test(name)) return /16/.test(name) ? 2 : 1;
  return null;
}

function addLoad(
  loads: FeatureLoads,
  feature: CostFeature,
  frames: number,
  windowFrames: number,
  mp: number,
): void {
  if (!(frames > 0) || !finite(mp) || mp < 0) return;
  const window = clamp(windowFrames, 0, frames);
  const have = loads[feature];
  if (have) {
    have.frames = Math.min(MAX_LOAD, have.frames + frames);
    have.windowFrames = Math.min(have.frames, have.windowFrames + window);
    have.mp = Math.max(have.mp, mp);
  } else loads[feature] = { frames: Math.min(MAX_LOAD, frames), windowFrames: window, mp };
}

/** The knobs of a colour grade as the filters the exporter emits for them (`colorFilters`, render.ts): the ones that stay in the picture's own
 *  format, the ones that force a conversion to RGB and back, and the colour wheels. A filter count, so a bigger grade costs more. */
function gradeFilters(color: unknown): { basic: number; rgb: number; wheels: number } {
  const out = { basic: 0, rgb: 0, wheels: 0 };
  if (!isRecord(color)) return out;
  const num = (key: string, fallback: number) =>
    isNum(color[key]) ? (color[key] as number) : fallback;
  if (isNum(color.exposure)) out.rgb++;
  if (
    num("brightness", 0) !== 0 ||
    num("contrast", 1) !== 1 ||
    num("saturation", 1) !== 1 ||
    num("gamma", 1) !== 1
  )
    out.basic++;
  if (isNum(color.temperature)) out.rgb++;
  if (isNum(color.tint)) out.wheels++;
  if (isNum(color.vibrance)) out.rgb++;
  if (num("blacks", 0) !== 0 || num("whites", 0) !== 0) out.rgb++;
  if (num("shadowsAmount", 0) > 0 || num("midsAmount", 0) > 0 || num("highsAmount", 0) > 0)
    out.wheels++;
  if (num("shadowsLum", 0) !== 0 || num("highsGain", 1) !== 1) out.rgb++;
  if (num("midsGamma", 1) !== 1) out.basic++;
  if (num("highlights", 0) !== 0 || num("shadows", 0) !== 0) out.rgb++;
  const curved = ["masterCurve", "redCurve", "greenCurve", "blueCurve"].some((key) => {
    const curve = color[key];
    return (
      Array.isArray(curve) &&
      curve.some(
        (point) => Array.isArray(point) && point.length >= 2 && isNum(point[0]) && isNum(point[1]),
      )
    );
  });
  if (curved) out.rgb++;
  if (typeof color.lut === "string" && color.lut.trim()) out.rgb++;
  return out;
}

/** The clip's glow as the exporter reads it: the clip's own value, else the first glow in its effects (render.ts `glowFromEffects`). */
function hasGlow(clip: Clip): boolean {
  let glow: unknown = clip.glow;
  if (glow === undefined || glow === null) {
    const effects: unknown = clip.effects;
    const first = Array.isArray(effects)
      ? effects.find((effect) => isRecord(effect) && effect.type === "glow")
      : undefined;
    if (!isRecord(first) || first.enabled === false) return false;
    const params = isRecord(first.params) ? first.params : {};
    glow = isNum(params.intensity) ? params.intensity : 25;
  }
  if (isNum(glow)) return glow > 0;
  return isRecord(glow) && isNum(glow.amount) && glow.amount > 0;
}

const EFFECT_FEATURES: Record<string, CostFeature> = {
  blur: "blur",
  denoise: "denoise",
  sharpen: "sharpen",
  grain: "grain",
  vignette: "vignette",
  motion: "motion",
  chroma: "chroma",
};

/** What the exporter's frame filters do for the effect stack of a picture clip: one feature per effect that emits a filter. */
function effectFeatures(clip: Clip): { features: CostFeature[]; unpriced: number } {
  const features: CostFeature[] = [];
  let unpriced = 0;
  const effects: unknown = clip.effects;
  if (!Array.isArray(effects)) return { features, unpriced };
  for (const effect of effects) {
    if (!isRecord(effect) || effect.enabled === false) continue;
    const type = String(effect.type ?? "");
    const params = isRecord(effect.params) ? effect.params : {};
    if (type in EFFECT_FEATURES) features.push(EFFECT_FEATURES[type]);
    else if (type === "clarity") {
      const clarity = isNum(params.clarity) ? params.clarity : 0;
      const dehaze = isNum(params.dehaze) ? params.dehaze : 0;
      if (clarity !== 0 || dehaze !== 0) features.push("clarity");
    } else if (type === "custom") {
      const raw = String(params.expr ?? params.filter ?? "").trim();
      if (raw) unpriced++;
    }
  }
  return { features, unpriced };
}

const TRANSITION_FEATURE: Record<string, CostFeature> = {
  crossfade: "crossfade",
  custom: "crossfade",
  whip: "whip",
  "wipe-l": "wipe",
  "wipe-r": "wipe",
  "dip-to-black": "dip",
  "dip-to-white": "dip",
};

interface Interval {
  from: number;
  to: number;
}

/** How many frames the union of the intervals covers. */
function unionLength(intervals: Interval[]): number {
  const sorted = [...intervals].sort((a, b) => a.from - b.from);
  let covered = 0;
  let edge = -Infinity;
  for (const { from, to } of sorted) {
    const start = Math.max(from, edge);
    if (to > start) covered += to - start;
    edge = Math.max(edge, to);
  }
  return covered;
}

function summarize(
  timeline: Timeline,
  options: {
    range?: { fromFrame: number; toFrame: number } | null;
    facts?: SourceFactsLookup | null;
  },
): CostShape | null {
  if (!isRecord(timeline) || !isRecord(timeline.canvas)) return null;
  const width = Number(timeline.canvas.width);
  const height = Number(timeline.canvas.height);
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) return null;
  const plan = resolveRenderPlan(toSecondsView(timeline));
  const fps = plan.canvas.fps;
  if (!(fps > 0 && Number.isFinite(fps))) return null;
  const total = Math.round(plan.durationSec * fps);
  const asked = options.range;
  const first = Math.max(0, Math.trunc(finite(asked?.fromFrame) ? asked.fromFrame : 0));
  const end = Math.max(
    first,
    Math.trunc(finite(asked?.toFrame) ? asked.toFrame : Number.isFinite(total) ? total : 0),
  );
  const canvasFrames = end - first;
  const canvasMp = (width * height) / 1e6;

  const known = new Map<string, CostSourceFacts | null>();
  const factsOf = (mediaId: unknown): CostSourceFacts | null => {
    if (typeof mediaId !== "string" || !options.facts) return null;
    if (!known.has(mediaId)) {
      let found: CostSourceFacts | null = null;
      try {
        found = usableFacts(options.facts(mediaId));
      } catch {
        found = null;
      }
      known.set(mediaId, found);
    }
    return known.get(mediaId) ?? null;
  };

  const clips: CostClip[] = [];
  const common: FeatureLoads = {};
  const frames = { video: 0, still: 0, caption: 0, audio: 0 };
  const inputs = { video: 0, still: 0, audio: 0 };
  const events = new Map<number, number>();
  const unknownSources = new Set<string>();
  const captionSpans: Interval[] = [];
  let unpricedFeatures = 0;
  let layerFrames = 0;
  let band: { active: boolean } | null = null;
  const bands: { active: boolean }[] = [];

  for (const pc of plan.clips) {
    const visible = onCanvasFrames(pc, fps);
    const start = Math.max(first, visible.first);
    const finish = Math.min(end, visible.end);
    const onCanvas = finish > start;
    const length = onCanvas ? finish - start : 0;
    const clip = pc.clipRef;

    if (pc.kind === "text") {
      if (!band) {
        band = { active: false };
        bands.push(band);
      }
      if (onCanvas) {
        band.active = true;
        frames.caption += length;
        captionSpans.push({ from: start, to: finish });
      }
      continue;
    }
    if (pc.kind !== "audio") band = null;
    if (!onCanvas) continue;

    if (pc.kind === "audio") {
      frames.audio += length;
      inputs.audio++;
      const effects: unknown = clip.effects;
      if (
        Array.isArray(effects) &&
        effects.some((fx) => isRecord(fx) && fx.type === "loudnorm" && fx.enabled !== false)
      )
        addLoad(common, "loudness", length, length, 0);
      continue;
    }

    // A picture clip: a video, or a still.
    const still = clipKind(clip) === "image";
    const loads: FeatureLoads = {};
    const mediaId = clip.media_ref;
    const facts = factsOf(mediaId);
    if (!facts && typeof mediaId === "string") unknownSources.add(mediaId);

    const transform = isRecord(clip.transform) ? clip.transform : {};
    const scaleX = transform.scale_x ?? transform.scale;
    const scaleY = transform.scale_y ?? transform.scale;
    const boxW = (peakScale(scaleX) ?? 1) * width;
    const boxH = (peakScale(scaleY) ?? 1) * height;
    const boxMp = (boxW * boxH) / 1e6;
    const zoomed = keyframeValues(scaleX) !== null || keyframeValues(scaleY) !== null;
    const fit = pc.media.fit;

    // Everything that runs per frame in the clip's chain runs at the size the clip was scaled to: its box, or, for a cover zoom, the picture
    // scaled to cover that box at its largest (which is bigger than the box for a source shaped unlike it).
    let clipMp = boxMp;
    if (zoomed && fit === "cover") {
      if (facts) {
        const k = Math.max(boxW / facts.width, boxH / facts.height);
        clipMp = (facts.width * k * facts.height * k) / 1e6;
      } else clipMp = boxMp * UNKNOWN_COVER_FACTOR;
    }
    if (zoomed)
      addLoad(loads, fit === "cover" ? "cover_zoom" : "contain_zoom", length, length, clipMp);

    if (still)
      addLoad(
        loads,
        "still_decode",
        length,
        length,
        facts ? (facts.width * facts.height) / 1e6 : UNKNOWN_STILL_MEGAPIXELS,
      );

    const transition = pc.transition;
    const transitionFeature = transition ? TRANSITION_FEATURE[transition.kind] : undefined;
    if (transition && transitionFeature) {
      const lead = transition.durSec / 2;
      const windowFrom = Math.ceil((pc.visibility.inSec - lead) * fps - 1e-6);
      const windowTo = Math.ceil((pc.visibility.inSec + lead) * fps - 1e-6);
      const window = Math.max(0, Math.min(finish, windowTo) - Math.max(start, windowFrom));
      // The colour flash of a dip is a canvas-sized layer as long as the project, not as long as the clip.
      if (transitionFeature === "dip") addLoad(loads, "dip", canvasFrames, window, canvasMp);
      else addLoad(loads, transitionFeature, length, window, clipMp);
    }

    const fade = isRecord(clip.fade) ? clip.fade : {};
    const fadeIn = isNum(fade.in) ? Math.max(0, fade.in) : 0;
    const fadeOut = isNum(fade.out) ? Math.max(0, fade.out) : 0;
    if (fadeIn > 0 || fadeOut > 0) addLoad(loads, "fade", length, fadeIn + fadeOut, clipMp);

    const opacity = pc.media.opacity;
    if (keyframeValues(opacity) !== null)
      addLoad(loads, "opacity_animated", length, length, clipMp);
    else if (isNum(opacity) && opacity < 1)
      addLoad(loads, "opacity_constant", length, length, clipMp);

    if (pc.media.blend !== "normal") addLoad(loads, "blend", canvasFrames, length, canvasMp);

    const rotate = pc.media.rotate;
    if (isNum(rotate) || keyframeValues(rotate) !== null)
      addLoad(loads, "rotate", length, length, (boxW * boxW + boxH * boxH) / 1e6);

    if (hasGlow(clip)) addLoad(loads, "glow", length, length, clipMp);

    const fx = effectFeatures(clip);
    unpricedFeatures += fx.unpriced;
    for (const feature of fx.features) addLoad(loads, feature, length, length, clipMp);

    const grade = gradeFilters(pc.media.color);
    addLoad(loads, "grade_basic", length * grade.basic, length * grade.basic, clipMp);
    addLoad(loads, "grade_rgb", length * grade.rgb, length * grade.rgb, clipMp);
    addLoad(loads, "grade_wheels", length * grade.wheels, length * grade.wheels, clipMp);

    const speed = clamp(Number(clip.speed ?? 1) || 1, MIN_SPEED, MAX_SPEED);
    if (Math.abs(speed - 1) > 1e-6)
      addLoad(loads, "speed_change", length * Math.max(1, speed), length * Math.max(1, speed), 0);

    const { left, right, top, bottom } = pc.media.crop;
    if (left > 0 || right > 0 || top > 0 || bottom > 0 || pc.media.flip.h || pc.media.flip.v)
      addLoad(loads, "crop_flip", length, length, clipMp);

    frames[still ? "still" : "video"] += length;
    inputs[still ? "still" : "video"]++;
    layerFrames += length;
    events.set(start, (events.get(start) ?? 0) + 1);
    events.set(finish, (events.get(finish) ?? 0) - 1);
    clips.push({
      id: pc.srcClipId,
      kind: still ? "still" : "video",
      frames: length,
      mp: boxMp,
      sourceMp: facts ? (facts.width * facts.height) / 1e6 : null,
      tenBit: facts ? overEightBit(facts.pixFmt) : null,
      bytesPerPixel: facts ? bytesPerPixelOf(facts.pixFmt) : null,
      known: facts !== null,
      loads,
    });
  }

  let layers = 0;
  let peakLayers = 0;
  for (const [, delta] of [...events].sort(([a], [b]) => a - b)) {
    layers += delta;
    peakLayers = Math.max(peakLayers, layers);
  }
  const activeBands = bands.filter((entry) => entry.active).length;
  if (activeBands > 0)
    addLoad(common, "captions", activeBands * canvasFrames, unionLength(captionSpans), canvasMp);

  return {
    canvas: { width, height, fps },
    canvasFrames,
    frames,
    clips,
    common,
    layerFrames,
    peakLayers,
    meanLayers: canvasFrames > 0 ? layerFrames / canvasFrames : 0,
    captionBands: activeBands,
    inputs,
    unknownSources: unknownSources.size,
    unpricedFeatures,
  };
}

/** The cost shape of a project, or of a range of its frames: null when it cannot be computed (never throws). An empty project is a zero shape. */
export function summarizeCostShape(
  timeline: Timeline,
  options?: {
    range?: { fromFrame: number; toFrame: number } | null;
    facts?: SourceFactsLookup | null;
  },
): CostShape | null {
  try {
    return summarize(timeline, options ?? {});
  } catch {
    return null;
  }
}

/** A feature's load summed over every clip and the common part. */
export function featureTotals(shape: CostShape): FeatureLoads {
  const totals: FeatureLoads = {};
  for (const loads of [shape.common, ...shape.clips.map((clip) => clip.loads)])
    for (const feature of COST_FEATURES) {
      const load = loads[feature];
      if (!load) continue;
      const have = totals[feature];
      if (have) {
        have.frames += load.frames;
        have.windowFrames += load.windowFrames;
        have.mp = Math.max(have.mp, load.mp);
      } else totals[feature] = { ...load };
    }
  return totals;
}
