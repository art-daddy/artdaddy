// The caption-knob table, shared by the two lanes that walk it:
//   assCaption.knobs.test.ts       — the knob reaches the .ass  (fast, always runs)
//   assCaption.knobs.smoke.e2e.ts  — the knob reaches the PIXELS (real ffmpeg/libass)
// It lives in its own module so importing it does not drag one lane's tests into the other's run.
//
// `Record<keyof CaptionSpec, Knob>` is the enforcement: add a field to CaptionSpec and this file
// stops compiling until you declare how it varies, so a new knob cannot arrive uncovered.
import { buildBandAss, type CaptionSpec } from "./assCaption";
import type { ResolvedRun } from "./renderPlan";

export const CANVAS = { w: 320, h: 240 };

/** Every field explicit, so the compiler — not my memory — decides the fixture is complete. */
export const BASE_CAPTION: CaptionSpec = {
  text: "hello there world",
  rawAss: "",
  font: "Poppins",
  sizePx: 40,
  color: "#ffffff",
  align: "center",
  anchorV: "middle",
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  weight: null,
  spacingPx: 0,
  scalePct: 100,
  fadeInMs: 0,
  fadeOutMs: 0,
  entranceMotion: null,
  karaoke: null,
  highlightColor: "",
  karaokeReveal: false,
  runs: null,
  emphasisSpec: null,
  outline: null,
  shadow: null,
  box: null,
  cxPx: 160,
  cyPx: 120,
  wPx: 260,
  startSec: 0,
  endSec: 2,
};

const RUN: ResolvedRun = {
  text: "hello",
  font: "Poppins",
  sizePx: 40,
  color: "#ffffff",
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  weight: null,
  outline: null,
  emphasis: false,
};

const KARAOKE = [
  { word: "hello", durCs: 50 },
  { word: "there", durCs: 50 },
];

export interface Knob {
  /** Fields BOTH sides need before this knob is live at all (a karaoke colour needs karaoke). */
  readonly context?: Partial<CaptionSpec>;
  /** The non-default value whose effect must reach the output. */
  readonly vary: Partial<CaptionSpec>;
  /** Seconds at which the pixel lane samples the frame. Defaults to mid-caption. */
  readonly atSec?: number;
}

export const KNOBS: Record<keyof CaptionSpec, Knob> = {
  text: { vary: { text: "different words entirely" } },
  rawAss: { vary: { rawAss: "{\\an5\\pos(160,120)\\fs60}RAW" } },
  font: { vary: { font: "Anton" } },
  sizePx: { vary: { sizePx: 22 } },
  color: { vary: { color: "#ff0000" } },
  align: { vary: { align: "left" } },
  anchorV: { vary: { anchorV: "top" } },
  bold: { vary: { bold: true } },
  italic: { vary: { italic: true } },
  underline: { vary: { underline: true } },
  strike: { vary: { strike: true } },
  weight: { vary: { weight: 700 } },
  spacingPx: { vary: { spacingPx: 6 } },
  scalePct: { vary: { scalePct: 160 } },
  fadeInMs: { vary: { fadeInMs: 600 }, atSec: 0.15 },
  fadeOutMs: { vary: { fadeOutMs: 600 }, atSec: 1.85 },
  entranceMotion: { vary: { entranceMotion: { kind: "slide-up", ms: 600 } }, atSec: 0.15 },
  karaoke: { vary: { karaoke: KARAOKE } },
  // The karaoke fields only exist once there IS a karaoke line, so both sides carry one.
  highlightColor: {
    context: { karaoke: KARAOKE },
    vary: { highlightColor: "#ff0000" },
    atSec: 0.75,
  },
  karaokeReveal: { context: { karaoke: KARAOKE }, vary: { karaokeReveal: true }, atSec: 0.25 },
  runs: { vary: { runs: [RUN, { ...RUN, text: "world", color: "#00ff00" }] } },
  // Emphasis is a treatment applied to a hero RUN — without one there is nothing to treat.
  emphasisSpec: {
    context: { runs: [RUN, { ...RUN, text: "world", emphasis: true }] },
    vary: { emphasisSpec: { kind: "box-invert", color: "#ff0000", scalePct: 140 } },
  },
  outline: { vary: { outline: { widthPx: 4, color: "#ff0000" } } },
  shadow: { vary: { shadow: { depthPx: 5, color: "#ff0000" } } },
  box: { vary: { box: { color: "#ff0000", opacity: 1, paddingPx: 10 } } },
  cxPx: { vary: { cxPx: 60 } },
  cyPx: { vary: { cyPx: 200 } },
  // A narrower wrap box has to re-wrap the line, which is why the base text is long enough to wrap.
  wPx: { vary: { wPx: 90 } },
  // Timing knobs are seen by sampling an instant the two sides disagree about.
  startSec: { vary: { startSec: 1.2 }, atSec: 0.5 },
  endSec: { vary: { endSec: 0.8 }, atSec: 1.5 },
};

export const KNOB_NAMES = Object.keys(KNOBS) as (keyof CaptionSpec)[];

export function assFor(knob: Knob, side: "base" | "varied"): string {
  const spec: CaptionSpec = {
    ...BASE_CAPTION,
    ...knob.context,
    ...(side === "varied" ? knob.vary : {}),
  };
  return buildBandAss([spec], CANVAS);
}
