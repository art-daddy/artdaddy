// Phase 3c: the prices the honest estimate uses. DATA ONLY, and every number in this file is a PLACEHOLDER: seeded from the audit's per-frame
// measurements (LAB-AUDIT FILTER-MAP.md sections 8.5 to 8.11, one PC, one repetition each) and the lab's own notes in exportEncoder.ts and
// exportPlan.ts, then rounded. None of it was fitted. The lane fits it on the rig matrix and replaces the numbers, not the shape of the table.
//
// THE UNIT. "rf" is a reference frame: what one frame of the REFERENCE export costs on whatever PC is being priced, where the reference export is
// a plain 1080p30 clip with sound, delivered at 1080p30, quality Medium, the processor's normal setting, one layer, no effect. The PC check
// measures the reference export's seconds per second of video (`rHat`), so one rf is `rHat / 30` seconds on that PC and every other price is a
// multiple of it. On the audit's PC one rf is about 13 ms (a plain 1080x1920 clip: 12 to 14 ms a frame, FILTER-MAP.md 8.5). A price per
// "megapixel frame" is rf per megapixel per frame, so a per-pixel mask costs more on a bigger picture, as measured.
import { FASTER_X264_GAIN, type ChipMaker } from "./exportEncoder";
import type { CostFeature } from "./costShape";

/** 1920 x 1080 in megapixels: the size the reference export runs at. 1080 x 1920 has the same number of pixels. */
export const REFERENCE_MEGAPIXELS = 2.0736;

/** What one reference frame is made of: reading and mixing (decode, scale, overlay) and encoding (x264 at Medium, and the check of the file).
 *  The two shares add to 1 (a conformance test). A PC whose speed test says its split differs moves cost between the two terms. */
export const REFERENCE_FRAME = { readMix: 0.4, encode: 0.6 } as const;

/** Read-and-mix cost that every project pays, in rf at the reference size: per frame of the canvas (the black base, the final conversions) and
 *  per frame of each visible picture layer (decode, scale, convert to alpha, blend). One layer is exactly the reference's `readMix`. */
export const BASE = { canvasFrame: 0.1, layerFrame: 0.3 } as const;

/** What a branded export adds (FILTER-MAP.md 8.10: +1 to 2 s and 4 to 11 CPU-s on the audit's PC): the end card is scaled, converted and encoded
 *  as 61 more frames, and the full-frame watermark costs about 0.015 CPU-s a frame, an eighth of a plain frame. The estimate assumes branding
 *  (every export unless the account is exempt), so an exempt account sees a figure about two seconds high. */
export const BRANDING = { endCardFrames: 61, watermarkFrame: 0.125 } as const;

/** The part of the time that does not grow with the video: start-up, probing and opening each input, saving, the check of the file. Seconds. */
export const FIXED = { seconds: 3, perInputSeconds: 0.15 } as const;

/** What the encode term is divided by on each route. Never the whole time: only `REFERENCE_FRAME.encode` shrinks, so a project that is mostly
 *  read-and-mix gets a small saving (the lab: 5 to 10 percent on busy projects) and a plain one a large saving.
 *  - The faster setting: the lab's 2.1 (exportEncoder.ts `FASTER_X264_GAIN`); a PC whose speed test measured it lower uses its own.
 *  - A chip, per maker. AMD from the lab (3.8 times on one plain clip, 1.0 to 1.9 times on real projects) with a margin; NVIDIA and Intel are
 *    cautious because they cannot be measured here (design I-8). A chip export measured on this PC replaces these: history wins. */
export const ENCODE = {
  quality: { high: 1.15, medium: 1, low: 0.9 },
  fasterGain: FASTER_X264_GAIN,
  chipGain: { amd: 4, nvidia: 2, intel: 2 } satisfies Record<ChipMaker, number>,
} as const;

/** The streamed engine runs every filter of a partition on one core, one partition at a time (FILTER-MAP.md section 1, `stream.rs`), so its
 *  read-and-mix term is multiplied by `perCore x cores`, between `min` and `max` (RED: 4.6 to 6.8 times slower than one-pass on 16 processors on
 *  four shapes). Each partition (`partitionSeconds` of video) also starts a process. */
export const ENGINE = {
  streamed: { perCore: 0.35, min: 1.5, max: 6 },
  partitionSeconds: 60,
  partitionStartSeconds: 2,
} as const;

/** The time of a gentler rung against the normal one (exportPlan.ts lab note, 8K HEVC: 22.7 s, 39.4 s, 52.5 s). Index = rung. */
export const RUNG_TIME_FACTOR = [1, 1.7, 2.3] as const;

/** The PC every estimate without a PC check is priced on: the field's median finished 1080p export took 2.44 times the video's length
 *  (ALIGNMENT.md F-14, n 45), which is the reference export's `rHat` for a median PC. It mixes project cost and PC pace (inference). */
export const PRIOR_PACE = { rHat: 2.4, cores: 8 } as const;

/** The PC a speed check that could not finish is priced as: a weak one (more than 4 times the video's length for the reference export, the owner's line
 *  for weak), on a rough guess because nothing was measured. A placeholder to be fitted on the weak-4 rig profile. `cores` is only the fallback when the caller
 *  does not know this PC's. */
export const WEAK_PRIOR_PACE = { rHat: 6, cores: 4 } as const;

/** What a PC check's numbers may be taken to mean. `rHat` outside the bounds, or a read-and-mix share outside its bounds, is clamped, not trusted. */
export const PACE_LIMITS = {
  rHat: { min: 0.02, max: 1000 },
  readMixShare: { min: 0.1, max: 0.95 },
} as const;

/** A project whose cost shape is unknown (`summarizeCostShape` could not read it) is priced as plain layers times this, and its range widens. */
export const PRIOR_SHAPE = { featureMultiple: 1.5 } as const;

/** How wide the estimate's range is around the variable part of the time: `low` and `high` are multiples of it (the fixed part is added to both).
 *  `history` is a matching earlier export; `derived` is one of another route, scaled by the model's route ratio; `pc_check` and `guess` are the
 *  model on this PC's pace and on the prior PC. The lane fits them so that at least 90 % of actual times fall inside.
 *  `unknownFactsExtra`: each clip whose source facts are unknown may cost this share more than priced, on its base layer and the features that
 *  depend on the source's size (added to `high` only). `unpricedExtra`: each use of a feature that cannot be priced adds this share of the
 *  variable part to `high`. `unknownShapeHigh`: a project with no cost shape may cost this many times the model's high. `muchLongerOver`: "could
 *  take much longer" is said when `high` is over this many times the central value. */
export const RANGE = {
  history: { low: 0.8, high: 1.3 },
  derived: { low: 0.65, high: 1.6 },
  pc_check: { low: 0.6, high: 1.6 },
  guess: { low: 0.35, high: 3 },
  unknownFactsExtra: 1,
  unpricedExtra: 0.5,
  unknownShapeHigh: 2,
  muchLongerOver: 4,
} as const;

/** Where a price comes from: `measured` in the audit, `read` from the exporter's graph without a timing, `assumed` (neither). */
export type PriceBasis = "measured" | "read" | "assumed";

/** What a feature costs in one recipe: `frame` on every frame its filter runs on, `window` more on the frames it does useful work on. Today's
 *  recipe runs a mask on every frame of its clip and pays `frame` alone; lane L3's lean recipe passes the other frames through, so its `frame`
 *  is small and its `window` carries the work. */
export interface RecipePrice {
  frame: number;
  window: number;
}

export interface FeaturePrice {
  /** `megapixel_frame`: the prices are rf per megapixel per frame; `frame`: rf per frame whatever the picture size. */
  unit: "megapixel_frame" | "frame";
  today: RecipePrice;
  lean: RecipePrice;
  basis: PriceBasis;
  /** The audit row or note the numbers were taken from, and the arithmetic. */
  seed: string;
}

/** The price of every feature the cost shape can contain, in both recipes. Where lane L3's fixes do not touch a feature the lean price IS
 *  today's. A lean price never exceeds today's, for any load (a conformance test): `lean.frame <= today.frame` and
 *  `lean.frame + lean.window <= today.frame + today.window`. The seeds read the audit's added milliseconds a frame at 1080x1920 (2.0736 MP)
 *  against its 13 ms plain frame. */
export const FEATURE_PRICES: Record<CostFeature, FeaturePrice> = {
  cover_zoom: {
    unit: "megapixel_frame",
    today: { frame: 28, window: 0 },
    lean: { frame: 3, window: 0 },
    basis: "measured",
    seed: "8.5/8.9b: 1,170 ms on a canvas-aspect clip at 2.5 MP, 2,500 to 2,750 on a 16:9 one at 7.9 MP, about 5,000 at 16.8 MP: 23 to 36 rf per MP-frame, middle taken. Lean: the exact mask stream, 120 to 164 ms a frame (7 to 17 times faster), 3 rf per MP-frame is above all three",
  },
  contain_zoom: {
    unit: "megapixel_frame",
    today: { frame: 0.33, window: 0 },
    lean: { frame: 0.33, window: 0 },
    basis: "measured",
    seed: "8.5: +9 ms a frame on a video clip (1.0 to 1.1 zoom) = 0.7 rf at 2.07 MP; with a grade +16 ms. Not touched by the fixes",
  },
  crossfade: {
    unit: "megapixel_frame",
    today: { frame: 0.82, window: 0 },
    lean: { frame: 0.22, window: 0.6 },
    basis: "measured",
    seed: "8.5: +22 ms on every frame of the incoming clip = 1.7 rf = 0.82 rf/MP. Lean: windowed mask 18.9 ms against 35, +5.9 ms left = 0.22 rf/MP on every frame, the rest in the window",
  },
  whip: {
    unit: "megapixel_frame",
    today: { frame: 2.67, window: 0 },
    lean: { frame: 0.59, window: 2.08 },
    basis: "measured",
    seed: "8.5: +72 ms = 5.5 rf = 2.67 rf/MP. Lean: windowed 29 ms against 85, +16 ms left = 0.59 rf/MP",
  },
  wipe: {
    unit: "megapixel_frame",
    today: { frame: 0.93, window: 0 },
    lean: { frame: 0.28, window: 0.65 },
    basis: "measured",
    seed: "8.5: wipe-r +25 ms = 1.9 rf = 0.93 rf/MP. Lean: windowed 20.5 ms against 38, +7.5 ms left = 0.28 rf/MP",
  },
  dip: {
    unit: "megapixel_frame",
    today: { frame: 2.2, window: 0 },
    lean: { frame: 0.1, window: 2.1 },
    basis: "measured",
    seed: "8.5: +60 ms on every frame of the WHOLE PROJECT per dip = 4.6 rf = 2.2 rf/MP (the flash layer is as long as the project; the incoming clip's own mask is folded in). Lean: a short layer and a window, 14 ms against 70 at 600 frames: +2.7 ms outside the window = 0.1 rf/MP",
  },
  fade: {
    unit: "megapixel_frame",
    today: { frame: 1.63, window: 0 },
    lean: { frame: 0.69, window: 0.94 },
    basis: "measured",
    seed: "8.5: +44 ms on every frame of the clip = 3.4 rf = 1.63 rf/MP. Lean: windowed 31.5 ms against 57, +18.5 ms left = 0.69 rf/MP",
  },
  opacity_animated: {
    unit: "megapixel_frame",
    today: { frame: 2.4, window: 0 },
    lean: { frame: 2.4, window: 0 },
    basis: "measured",
    seed: "8.5: +65 ms = 5 rf = 2.4 rf/MP. The audit found no window to gate (the value changes across the whole clip): not touched by the fixes",
  },
  opacity_constant: {
    unit: "megapixel_frame",
    today: { frame: 0.33, window: 0 },
    lean: { frame: 0.33, window: 0 },
    basis: "measured",
    seed: "8.5: +9 ms (+0.04 CPU-s) = 0.7 rf = 0.33 rf/MP",
  },
  blend: {
    unit: "megapixel_frame",
    today: { frame: 0.55, window: 0 },
    lean: { frame: 0.55, window: 0 },
    basis: "measured",
    seed: "8.10: screen over a second clip +14.7 ms = 1.1 rf = 0.55 rf/MP, on every frame of the project. The audit suggests a window; no fix is known to take it",
  },
  rotate: {
    unit: "megapixel_frame",
    today: { frame: 0.12, window: 0 },
    lean: { frame: 0.12, window: 0 },
    basis: "measured",
    seed: "8.10: a 7 degree rotate +6.5 ms = 0.5 rf on the 4.9 MP rotated surface = 0.10 rf/MP (CPU: 0.14)",
  },
  glow: {
    unit: "megapixel_frame",
    today: { frame: 0.08, window: 0 },
    lean: { frame: 0.08, window: 0 },
    basis: "measured",
    seed: "8.10: +0.024 CPU-s a frame (cheap), about 0.2 rf = 0.08 rf/MP",
  },
  blur: {
    unit: "megapixel_frame",
    today: { frame: 0.01, window: 0 },
    lean: { frame: 0.01, window: 0 },
    basis: "measured",
    seed: "8.11: free (no CPU measured above the control)",
  },
  vignette: {
    unit: "megapixel_frame",
    today: { frame: 0.05, window: 0 },
    lean: { frame: 0.05, window: 0 },
    basis: "measured",
    seed: "8.10: +0.006 CPU-s, +2.5 ms wall (one thread) = 0.19 rf = 0.09 rf/MP, rounded down",
  },
  grain: {
    unit: "megapixel_frame",
    today: { frame: 1, window: 0 },
    lean: { frame: 1, window: 0 },
    basis: "measured",
    seed: "8.11: +26 ms = 2 rf = 0.97 rf/MP (the noise must change every frame)",
  },
  denoise: {
    unit: "megapixel_frame",
    today: { frame: 0.01, window: 0 },
    lean: { frame: 0.01, window: 0 },
    basis: "measured",
    seed: "8.10: free on video (0 CPU-s above the control); not measured on a still",
  },
  sharpen: {
    unit: "megapixel_frame",
    today: { frame: 0.05, window: 0 },
    lean: { frame: 0.05, window: 0 },
    basis: "measured",
    seed: "8.11: +0.023 CPU-s (cheap), +1.4 ms = 0.1 rf = 0.05 rf/MP",
  },
  clarity: {
    unit: "megapixel_frame",
    today: { frame: 0.05, window: 0 },
    lean: { frame: 0.05, window: 0 },
    basis: "measured",
    seed: "8.10: +0.022 CPU-s (cheap), +0.9 ms = 0.07 rf = 0.03 rf/MP, rounded up to the sharpen row",
  },
  motion: {
    unit: "megapixel_frame",
    today: { frame: 0.3, window: 0 },
    lean: { frame: 0.3, window: 0 },
    basis: "assumed",
    seed: "NOT MEASURED (the audit did not run it): `tmix` averages 2 to 12 frames, sliced, N times the memory. Assumed 0.3 rf/MP, between the cheap filters and grain",
  },
  chroma: {
    unit: "megapixel_frame",
    today: { frame: 3, window: 0 },
    lean: { frame: 3, window: 0 },
    basis: "measured",
    seed: "8.11: 97.6 ms against 15.9 = +82 ms on one thread, on any PC = 6.3 rf = 3.0 rf/MP. A serial stage: it does not shrink with the cores, so a weak PC is over-estimated (inference)",
  },
  grade_basic: {
    unit: "megapixel_frame",
    today: { frame: 0.02, window: 0 },
    lean: { frame: 0.02, window: 0 },
    basis: "measured",
    seed: "8.4/8.5: contrast, saturation, brightness and gamma (`eq`) cost nothing measurable; per filter",
  },
  grade_rgb: {
    unit: "megapixel_frame",
    today: { frame: 0.26, window: 0 },
    lean: { frame: 0.26, window: 0 },
    basis: "measured",
    seed: "8.5: the 7-knob lab recipe is four RGB filters and one eq, +29 ms = 2.2 rf; (2.2 - 0.04) / 4 filters / 2.07 MP = 0.26 rf/MP per filter (every conversion-forcing knob counted once per filter)",
  },
  grade_wheels: {
    unit: "megapixel_frame",
    today: { frame: 0.34, window: 0 },
    lean: { frame: 0.34, window: 0 },
    basis: "measured",
    seed: "8.5: colour wheels and tint +6 to +11 ms wall = 0.7 rf at the middle / 2.07 MP = 0.34 rf/MP per filter",
  },
  still_decode: {
    unit: "megapixel_frame",
    today: { frame: 0.3, window: 0 },
    lean: { frame: 0.055, window: 0 },
    basis: "measured",
    seed: "8.5/8.10: a 12 MP JPEG +43 ms a frame (a serial decode) = 3.3 rf = 0.28 rf/MP; 24 MP +171 ms = 0.55 rf/MP; a 1080x1920 PNG +4 ms = 0.15 rf/MP; 0.3 taken. Lean: decode once, 82 % less (12 MP photo): 0.3 x 0.18",
  },
  speed_change: {
    unit: "frame",
    today: { frame: 0.05, window: 0 },
    lean: { frame: 0.05, window: 0 },
    basis: "assumed",
    seed: "8.11: 2x and 0.5x measured cheap (9.7 and 12 ms against 15.9), no penalty found; a speed-up decodes more source frames, so a small cost per source frame is assumed",
  },
  crop_flip: {
    unit: "megapixel_frame",
    today: { frame: 0.02, window: 0 },
    lean: { frame: 0.02, window: 0 },
    basis: "read",
    seed: "FILTER-MAP.md 3.5 P2: class C (crop, hflip sliced, vflip one thread); not timed. Assumed as cheap as the eq knobs",
  },
  loudness: {
    unit: "frame",
    today: { frame: 0.04, window: 0 },
    lean: { frame: 0.04, window: 0 },
    basis: "measured",
    seed: "8.11: loudnorm on an 8 s track +0.005 CPU-s a frame (free) = 0.04 rf; per frame of sound",
  },
  captions: {
    unit: "megapixel_frame",
    today: { frame: 0.01, window: 0.02 },
    lean: { frame: 0.01, window: 0.02 },
    basis: "measured",
    seed: "8.10/8.11: 60 captions and the slide-up, pop-in and headline presets 0 to +0.002 CPU-s a frame; the `ass` pass runs on every frame of the project (one band each) and draws only where a caption is on",
  },
};
