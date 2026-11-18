// The Fast choice of the Export dialog (the person sees "Fast" beside "Quality"; the names in code keep "quick"): what it changes, whether it is on
// offer, and the two small questions a dialog asks of it (the figure in brackets, the "Are you sure?"). Pure: nothing here reads the PC, a switch,
// the project or an estimate, so the Export dialog, the export tool and the tests all get one answer from the same facts, and every figure of
// the bundle is in the one constant below.
//
// Quick is a bundle of ordinary options, never a new way to render: a smaller picture (by default one rung below the project's size on the
// ladder, by its short side), at most 30 frames a second, Medium quality, and for the encoder the graphics chip where it passed its test and
// is not switched Off, else the processor's faster setting (that part is `chooseEncoder`'s `quick` request, not here). It never overrides a
// size, a rate or a quality that was set, never enlarges, and is on offer whenever its switch is on: nothing here looks at how long an export
// would take. Every function answers "no Quick" or leaves the settings alone on input it cannot read, and none of them throws.
import { outputFps, outputSize, type ExportQuality, type ExportResolution } from "./exportOptions";
import type { ExplicitSettings, PcClass, QuickOffer, RouteKind } from "./exportTypes3c";

/** A size preset that names a size: every `ExportResolution` except "same as the project". */
export type SizePreset = Exclude<ExportResolution, "source">;

/** The short side each size preset targets, as `outputSize` in exportOptions.ts reads it (a test holds this table to that function). A record over the
 *  preset type: a preset added there does not compile here until it is listed. */
const SHORT_SIDE: Readonly<Record<SizePreset, number>> = {
  "2160p": 2160,
  "1440p": 1440,
  "1080p": 1080,
  "720p": 720,
  "480p": 480,
};

/** Every size preset, largest first: the sizes a person may pick from, below the project's own. */
export const SIZE_PRESETS: readonly SizePreset[] = Object.freeze(
  (Object.keys(SHORT_SIDE) as SizePreset[]).sort((a, b) => SHORT_SIDE[b] - SHORT_SIDE[a]),
);

/** A range of one project fact, both ends included; an end that is missing is open. */
export interface FactRange {
  readonly min?: number;
  readonly max?: number;
}

/** One figure the lab measured, and the projects it may be claimed for: a project is covered when every range the row names holds for it. */
export interface FastSpeedupRow {
  readonly shortSide?: FactRange;
  readonly fps?: FactRange;
  readonly durationSeconds?: FactRange;
  /** "Fast is about this many times as fast": the number shown in brackets on the Fast choice. A figure that is not above 1 is never claimed. */
  readonly figure: number;
}

export interface QuickBundle {
  /** The size ladder by short side, largest first: Fast's default size is the largest rung strictly below the project's short side, and none for a
   *  project at or below the last rung. */
  readonly ladder: readonly SizePreset[];
  /** Fast never delivers more frames a second than this (the rule in `quickRate`). */
  readonly maxFps: number;
  /** The quality Fast starts on where none was set. */
  readonly quality: ExportQuality;
  /** The cut-offs of the question before a heavy export is started: a project is big when its short side is at least `shortSide`, or its rate at
   *  least `fps`, or it is longer than `durationSeconds` (`needsSlowConfirm`). */
  readonly confirm: {
    readonly shortSide: number;
    readonly fps: number;
    readonly durationSeconds: number;
  };
  /** The lab's figures for the brackets on the Fast choice, the first covering row wins. Empty until the lab has them: no row, no figure, no question. */
  readonly speedup: readonly FastSpeedupRow[];
}

/** THE bundle: every figure of Fast export in one place. Frozen, so a caller cannot change it by accident; a function that reads it takes a bundle as
 *  its last argument, so a test can give it other data. */
export const QUICK_BUNDLE: QuickBundle = Object.freeze({
  ladder: Object.freeze<SizePreset[]>(["2160p", "1080p", "720p", "480p"]),
  maxFps: 30,
  quality: "medium",
  confirm: Object.freeze({ shortSide: 2160, fps: 50, durationSeconds: 600 }),
  speedup: Object.freeze<FastSpeedupRow[]>([]),
});

/** Fast never delivers more frames a second than this. */
export const QUICK_MAX_FPS: number = QUICK_BUNDLE.maxFps;
/** The quality Fast starts on where none was set; one that was set is kept. */
export const QUICK_QUALITY: ExportQuality = QUICK_BUNDLE.quality;
/** The chat card asks about an export expected over this long (the one constant of the question rule; nothing asks in this build). */
export const ROUTE_QUESTION_SECONDS = 10 * 60;

const QUALITIES: readonly ExportQuality[] = ["high", "medium", "low"];
const isPreset = (value: unknown): value is SizePreset =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(SHORT_SIDE, value);
const isResolution = (value: unknown): value is ExportResolution =>
  value === "source" || isPreset(value);
const isQuality = (value: unknown): value is ExportQuality =>
  QUALITIES.includes(value as ExportQuality);
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isPositive = (value: unknown): value is number => isNumber(value) && value > 0;

/** The size the render composites at: the authored side cut to a whole number and made even (`canvasPx` in render.ts; a test holds the two equal). */
const compositeSide = (side: number): number => Math.max(2, Math.round(Math.trunc(side) / 2) * 2);

/** A PC whose class makes Quick the preselected way and caps Quick's picture at 720p: weak, or one whose check could not finish. Kept for the wording
 *  of the estimate design (routeWords.ts); no rule of the Fast choice reads a PC class. */
export function isWeakPc(pcClass: PcClass): boolean {
  return pcClass === "weak" || pcClass === "unfinished";
}

/** The picture the render makes of a canvas under a size preset, by the export's own functions: both sides even, never larger than the canvas. */
function sizeOf(
  canvas: { width: number; height: number },
  resolution: ExportResolution,
): { width: number; height: number } {
  const width = compositeSide(canvas.width);
  const height = compositeSide(canvas.height);
  const sized = outputSize(width, height, resolution);
  return { width: sized?.w ?? width, height: sized?.h ?? height };
}

const shortOf = (size: { width: number; height: number }): number =>
  Math.min(size.width, size.height);

/** Fast's default size for a canvas: the largest rung of the ladder strictly below the canvas's short side (1080 by 1920 gives 720p, a 2160 canvas
 *  gives 1080p, a 1440 canvas gives 1080p, 720 gives 480p), or `null` where there is none (480 or smaller: the size is left as it is). The short side is
 *  the one the render composites at. The assistant's Fast uses this size. */
export function quickDefaultSize(
  canvas: { width: number; height: number },
  bundle: QuickBundle = QUICK_BUNDLE,
): SizePreset | null {
  try {
    if (!isPositive(canvas.width) || !isPositive(canvas.height)) return null;
    const short = shortOf({
      width: compositeSide(canvas.width),
      height: compositeSide(canvas.height),
    });
    let best: SizePreset | null = null;
    for (const rung of bundle.ladder)
      if (
        isPreset(rung) &&
        SHORT_SIDE[rung] < short &&
        (best === null || SHORT_SIDE[rung] > SHORT_SIDE[best])
      )
        best = rung;
    return best;
  } catch {
    return null;
  }
}

/** The sizes the Resolution list may offer for a canvas, in Fast and in Quality alike: "the same as the project" and every size preset whose short side is
 *  smaller than the canvas's, largest first. Never one that is larger or equal. */
export function quickSizeChoices(canvas: { width: number; height: number }): ExportResolution[] {
  try {
    if (!isPositive(canvas.width) || !isPositive(canvas.height)) return ["source"];
    const short = shortOf({
      width: compositeSide(canvas.width),
      height: compositeSide(canvas.height),
    });
    return ["source", ...SIZE_PRESETS.filter((preset) => SHORT_SIDE[preset] < short)];
  } catch {
    return ["source"];
  }
}

/** The rate Fast delivers for a source rate: rates up to the cap (30) are kept; above that the rate is halved for as long as it stays a whole
 *  number above the cap (60 gives 30, 50 gives 25, 48 gives 24, 120 gives 30), and the cap where it does not (59.94 and 90 give 30). The halving
 *  goes on while it stays whole, so 72 gives 18 and 32 gives 16. `null` for a rate that is not a positive number. Never raises a rate. */
export function quickRate(rate: number, maxFps: number = QUICK_BUNDLE.maxFps): number | null {
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
  let capped = rate;
  while (capped > maxFps) {
    const half = capped / 2;
    if (!Number.isInteger(half)) return maxFps;
    capped = half;
  }
  return capped;
}

export interface QuickSettingsInput {
  canvas: { width: number; height: number; fps: number };
  requested: { resolution?: ExportResolution; fps?: number; quality?: ExportQuality };
  /** What the person or the assistant set. Fast leaves a set size, rate or quality alone; anything but a plain `false` is read as set. */
  explicit: ExplicitSettings;
  /** The figures to read; the bundle above where it is left out. */
  bundle?: QuickBundle;
}

/** The picture and the rate an export delivers: what the render says its output is (`output` of the plan), for a size and a rate. */
export interface DeliveredPicture {
  width: number;
  height: number;
  fps: number;
}

export interface QuickSettings {
  /** What to ask the export for: Fast's size where it made the picture smaller, else the request's own. */
  resolution: ExportResolution;
  fps: number | undefined;
  /** Medium where none was set, else the request's own. */
  quality: ExportQuality | undefined;
  /** What an export delivers with these three settings (even sides, never larger than the project's picture), or null where the canvas cannot be read. */
  delivered: DeliveredPicture | null;
  changedSize: boolean;
  changedFps: boolean;
  changedQuality: boolean;
}

/** What an export delivers for a canvas under a size and a rate: the size by `outputSize` over the picture the render composites at, the rate by
 *  `outputFps` over the project's rate cut to a whole number, as the render does, so this is the `output` its plan reports. */
function deliveredOf(
  canvas: { width: number; height: number; fps: number },
  resolution: ExportResolution,
  fps: number | undefined,
): DeliveredPicture {
  return { ...sizeOf(canvas, resolution), fps: outputFps(Math.trunc(canvas.fps), fps) };
}

/** What Fast delivers for a request: the size one rung below the project's (`quickDefaultSize`), the rate at 30 at most (`quickRate`) and the quality
 *  Medium, each only where it was not set, and only ever lowered (the size and the rate; a quality is replaced, never one that was set). The encoder is not
 *  here: it is `chooseEncoder`'s `quick` request. */
export function quickSettings(input: QuickSettingsInput): QuickSettings {
  const requested = input?.requested;
  const resolution: ExportResolution = isResolution(requested?.resolution)
    ? requested.resolution
    : "source";
  const fps = isNumber(requested?.fps) ? requested.fps : undefined;
  const quality = isQuality(requested?.quality) ? requested.quality : undefined;
  const state = {
    resolution,
    fps,
    quality,
    changedSize: false,
    changedFps: false,
    changedQuality: false,
  };
  try {
    const { canvas, explicit } = input;
    const bundle = input.bundle ?? QUICK_BUNDLE;
    const sizeKnown = isPositive(canvas.width) && isPositive(canvas.height);
    const rateKnown = isPositive(canvas.fps);
    if (sizeKnown && explicit?.size === false) {
      const target = quickDefaultSize(canvas, bundle);
      // A smaller size that was asked for stays: Fast only ever lowers.
      if (
        target !== null &&
        shortOf(sizeOf(canvas, target)) < shortOf(sizeOf(canvas, state.resolution))
      ) {
        state.resolution = target;
        state.changedSize = true;
      }
    }
    if (rateKnown && explicit?.fps === false) {
      const delivered = outputFps(Math.trunc(canvas.fps), state.fps);
      const capped = quickRate(delivered, bundle.maxFps);
      if (capped !== null && capped < delivered) {
        state.fps = capped;
        state.changedFps = true;
      }
    }
    if (
      explicit?.quality === false &&
      isQuality(bundle.quality) &&
      state.quality !== bundle.quality
    ) {
      state.quality = bundle.quality;
      state.changedQuality = true;
    }
    const delivered =
      sizeKnown && rateKnown ? deliveredOf(canvas, state.resolution, state.fps) : null;
    return { ...state, delivered };
  } catch {
    return {
      resolution,
      fps,
      quality,
      delivered: null,
      changedSize: false,
      changedFps: false,
      changedQuality: false,
    };
  }
}

/** What the person or the assistant set in a call to the `export` tool: "the same as the project" is the default and not a size anyone chose (the Export
 *  menu sends it every time); any other size, any frame rate and any quality named is a setting. The Export dialog knows better than its arguments what the
 *  person set (a "same as the project" that was picked is a setting too), so it says so in `ExportRouteSlot.explicit` and this is for the calls that have no slot. */
export function explicitOfCall(args: Record<string, unknown> | null | undefined): ExplicitSettings {
  const resolution = args?.resolution;
  const quality = args?.quality;
  return {
    size:
      typeof resolution === "string" &&
      resolution.trim() !== "" &&
      resolution.trim().toLowerCase() !== "source",
    fps: isNumber(args?.fps),
    quality: typeof quality === "string" && quality.trim() !== "",
  };
}

/** What a project is, for the two questions below: its canvas, its rate and its length in seconds (a `RenderWorkload` fits). */
export interface ProjectFacts {
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
}

/** What the dialog has chosen, as far as these questions need: Quality or Fast, the Resolution list's value ("source" is the same as the project), the frame
 *  rate in Advanced settings (`null` is the project's own) and which of the size, the rate and the quality the person set (the dialog knows: the values alone
 *  cannot say whether "the same as the project" was picked or left). */
export interface ChoiceSettings {
  route: RouteKind;
  resolution: ExportResolution;
  fps: number | null;
  explicit: ExplicitSettings;
}

const rangeHolds = (range: FactRange | undefined, value: number): boolean =>
  range === undefined ||
  ((range.min === undefined || (isNumber(range.min) && value >= range.min)) &&
    (range.max === undefined || (isNumber(range.max) && value <= range.max)));

/** The facts the two questions read: the short side the render composites at, the rate it runs at and the length. Null where the project cannot be read. */
function factsOf(
  facts: ProjectFacts,
): { shortSide: number; fps: number; durationSeconds: number } | null {
  if (!isPositive(facts?.width) || !isPositive(facts?.height) || !isPositive(facts?.fps))
    return null;
  if (!isNumber(facts.durationSeconds) || facts.durationSeconds < 0) return null;
  return {
    shortSide: shortOf({ width: compositeSide(facts.width), height: compositeSide(facts.height) }),
    fps: Math.trunc(facts.fps),
    durationSeconds: facts.durationSeconds,
  };
}

/** The figure shown in brackets on the Fast choice ("about this many times as fast"), or `null` where no figure may be claimed. A figure comes only from
 *  a row of the lab's table that covers the project, and the table is empty until the lab has measured: no row, no figure. Never a time. */
export function fastSpeedupLabel(
  facts: ProjectFacts,
  bundle: QuickBundle = QUICK_BUNDLE,
): number | null {
  try {
    const known = factsOf(facts);
    if (known === null) return null;
    for (const row of bundle.speedup) {
      if (!isNumber(row.figure) || row.figure <= 1) continue;
      if (
        rangeHolds(row.shortSide, known.shortSide) &&
        rangeHolds(row.fps, known.fps) &&
        rangeHolds(row.durationSeconds, known.durationSeconds)
      )
        return row.figure;
    }
    return null;
  } catch {
    return null;
  }
}

/** Whether pressing Export should ask "Are you sure?" first. Only when ALL of these hold, and never from a guess at a time:
 *  1. the project is big by its own facts: its short side is at least the cut-off (2160), or its rate is (50), or it is longer than the length (600 s);
 *  2. the choice keeps the output heavier than Fast's own settings: for a Fast choice only where an override puts the size above `quickDefaultSize` or the
 *     rate above the cap (a quality override alone does not count); for a Quality choice (the project's own size and rate, or what the Resolution list and
 *     the frame rate say) unless the project is already at or below Fast's default size and rate;
 *  3. `fastSpeedupLabel` has a figure for the project: no figure, no question, because only something true about the benefit may be said.
 *  Anything it cannot read gives `false`. */
export function needsSlowConfirm(
  settings: ChoiceSettings,
  facts: ProjectFacts,
  bundle: QuickBundle = QUICK_BUNDLE,
): boolean {
  try {
    const known = factsOf(facts);
    if (known === null || typeof settings?.explicit !== "object" || settings.explicit === null)
      return false;
    const big =
      known.shortSide >= bundle.confirm.shortSide ||
      known.fps >= bundle.confirm.fps ||
      known.durationSeconds > bundle.confirm.durationSeconds;
    if (!big) return false;
    const canvas = { width: facts.width, height: facts.height, fps: facts.fps };
    const requested = {
      resolution: isResolution(settings.resolution) ? settings.resolution : "source",
      fps: isNumber(settings.fps) ? settings.fps : undefined,
    };
    // What the choice delivers: Fast composes its own size and rate where they were not set, Quality delivers what the settings say.
    const chosen =
      settings.route === "quick"
        ? quickSettings({ canvas, requested, explicit: settings.explicit, bundle }).delivered
        : deliveredOf(canvas, requested.resolution, requested.fps);
    if (chosen === null) return false;
    // Fast's own settings: its default size (the project's own where the ladder has none below it) and the cap on the rate.
    const fastSize = quickDefaultSize(canvas, bundle);
    const fastShort = fastSize === null ? known.shortSide : SHORT_SIDE[fastSize];
    if (!(shortOf(chosen) > fastShort || chosen.fps > bundle.maxFps)) return false;
    return fastSpeedupLabel(facts, bundle) !== null;
  } catch {
    return false;
  }
}

export interface RouteInput {
  /** The remote switch `quick_route`. */
  quickRouteOn: boolean;
  /** The person's pick in this opening of the dialog (or what a call to the tool carries); null where nothing was picked. */
  picked: RouteKind | null;
}

/** Why Fast is or is not on offer: nothing but the switch decides it, so only these two of the report's `QuickOffer` words are ever given. */
export type RouteReason = Extract<QuickOffer, "offered" | "off">;

export interface RouteDecision {
  /** Fast is on offer. Quality is always there. */
  offered: boolean;
  /** Which way the dialog starts on and the export runs: Fast only where it is on offer AND the person picked it, never preselected. */
  selected: RouteKind;
  reason: RouteReason;
}

const NOT_OFFERED: Readonly<RouteDecision> = Object.freeze<RouteDecision>({
  offered: false,
  selected: "standard",
  reason: "off",
});

/** Whether Fast is on offer, and which way the dialog or the call goes: Fast is on offer exactly when its switch is on, on every project and every PC (no
 *  estimate, no PC class and no length decides it), and it is selected only by a pick of it. Quality is always available: `selected` is `standard` for
 *  anything else, and for every input it cannot read. */
export function chooseRoute(input: RouteInput): RouteDecision {
  try {
    if (input.quickRouteOn !== true) return { ...NOT_OFFERED };
    return {
      offered: true,
      selected: input.picked === "quick" ? "quick" : "standard",
      reason: "offered",
    };
  } catch {
    return { ...NOT_OFFERED };
  }
}

/** Whether the chat card would ask "Quality or Fast?" before an export the assistant started without saying: Fast is on offer and the app's rough guess for
 *  Quality (the 0.27.0 estimate, which is still available) is over ten minutes. Nothing asks in this build; the rule is here for the screens that will. */
export function routeQuestionDue(input: {
  decision: RouteDecision;
  fullSeconds: number | null;
}): boolean {
  try {
    if (input.decision?.offered !== true) return false;
    const full = input.fullSeconds;
    return isNumber(full) && full > ROUTE_QUESTION_SECONDS;
  } catch {
    return false;
  }
}
