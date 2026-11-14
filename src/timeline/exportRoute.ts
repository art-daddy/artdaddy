// Quick export: what it changes, whether it is on offer, and whether the chat asks about it. Pure: nothing here reads the PC, a switch
// or the project, so the Export dialog, the chat card and the tests all get one answer from the same facts.
//
// Quick is a bundle of ordinary options (a smaller picture, at most 30 frames a second, the chip or the faster setting), never a new way
// to render. It never overrides a size or a rate that was set, is never selected for an export of a minute or less, and is never offered
// where it would save under a quarter of the time. Every function answers "no Quick" or leaves the settings alone on input it cannot
// read, and none of them throws.
import { FAST_DEFAULT_SECONDS, FAST_MIN_SAVING } from "./exportEncoder";
import { outputFps, outputSize, type ExportQuality, type ExportResolution } from "./exportOptions";
import type {
  ExplicitSettings,
  PcClass,
  QuickOffer,
  RouteEstimate,
  RouteKind,
} from "./exportTypes3c";

/** Quick never delivers more frames a second than this. */
export const QUICK_MAX_FPS = 30;
/** The chat card asks about an export expected over this long even on a PC that is not weak (the one constant of the question rule). */
export const ROUTE_QUESTION_SECONDS = 10 * 60;

const RESOLUTIONS: readonly ExportResolution[] = [
  "source",
  "2160p",
  "1440p",
  "1080p",
  "720p",
  "480p",
];
const isResolution = (value: unknown): value is ExportResolution =>
  RESOLUTIONS.includes(value as ExportResolution);

/** A PC whose class makes Quick the preselected way and caps Quick's picture at 720p: weak, or one whose check could not finish. */
export function isWeakPc(pcClass: PcClass): boolean {
  return pcClass === "weak" || pcClass === "unfinished";
}

/** The rate Quick delivers for a source rate: rates up to 30 are kept; above that the rate is halved for as long as it stays a whole
 *  number above 30 (60 gives 30, 50 gives 25, 48 gives 24, 120 gives 30), and 30 where it does not (59.94 and 90 give 30). The halving
 *  goes on while it stays whole, so 72 gives 18 and 32 gives 16. `null` for a rate that is not a positive number. */
export function quickRate(rate: number): number | null {
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
  let capped = rate;
  while (capped > QUICK_MAX_FPS) {
    const half = capped / 2;
    if (!Number.isInteger(half)) return QUICK_MAX_FPS;
    capped = half;
  }
  return capped;
}

export interface QuickSettingsInput {
  canvas: { width: number; height: number; fps: number };
  requested: { resolution?: ExportResolution; fps?: number; quality?: ExportQuality };
  /** Weak or unfinished: the size cap is 720; any other class: 1080. */
  pcClass: PcClass;
  /** A size or a rate the person or the assistant set is left alone. Anything but a plain `false` is read as set. */
  explicit: ExplicitSettings;
}

export interface QuickSettings {
  resolution: ExportResolution;
  fps: number | undefined;
  changedSize: boolean;
  changedFps: boolean;
}

/** The short side a resolution delivers for this canvas. `outputSize` never upscales, so this never exceeds the canvas. */
function deliveredShortSide(
  canvas: { width: number; height: number },
  resolution: ExportResolution,
): number {
  const sized = outputSize(canvas.width, canvas.height, resolution);
  return sized ? Math.min(sized.w, sized.h) : Math.min(canvas.width, canvas.height);
}

/** What Quick delivers for a request: the picture capped at 1080p (720p on a weak PC) and the rate at 30, each only where it is not set
 *  and only ever lowered. The quality tier is not touched, so it is not here. */
export function quickSettings(input: QuickSettingsInput): QuickSettings {
  const requested = input?.requested;
  const resolution: ExportResolution = isResolution(requested?.resolution)
    ? requested.resolution
    : "source";
  const fps =
    typeof requested?.fps === "number" && Number.isFinite(requested.fps)
      ? requested.fps
      : undefined;
  const result: QuickSettings = { resolution, fps, changedSize: false, changedFps: false };
  try {
    const { canvas, explicit } = input;
    if (
      explicit?.size === false &&
      Number.isFinite(canvas.width) &&
      Number.isFinite(canvas.height) &&
      canvas.width > 0 &&
      canvas.height > 0
    ) {
      const cap = isWeakPc(input.pcClass) ? 720 : 1080;
      const preset: ExportResolution = cap === 720 ? "720p" : "1080p";
      if (
        deliveredShortSide(canvas, resolution) > cap &&
        outputSize(canvas.width, canvas.height, preset) !== null
      ) {
        result.resolution = preset;
        result.changedSize = true;
      }
    }
    if (explicit?.fps === false && Number.isFinite(canvas.fps) && canvas.fps > 0) {
      const delivered = outputFps(canvas.fps, fps);
      const capped = quickRate(delivered);
      if (capped !== null && capped < delivered) {
        result.fps = capped;
        result.changedFps = true;
      }
    }
    return result;
  } catch {
    return { resolution, fps, changedSize: false, changedFps: false };
  }
}

export interface RouteInput {
  pcClass: PcClass;
  /** `chat` is the chat card, MCP and the Export menu's tool call: the person is asked. It does not change the decision. */
  via: "dialog" | "chat";
  /** What Full quality will really run (the chip, the faster setting or the normal setting, as the encoder rule decides). */
  full: RouteEstimate;
  quick: RouteEstimate;
  explicit: ExplicitSettings;
  /** The remote switch `quick_export`. */
  quickFlagOn: boolean;
  /** The person's pick in this opening of the dialog. */
  picked: RouteKind | null;
  /** Used only when both the size and the rate are set: what Quick's encoder alone would save, as a share of Full quality's time. */
  encoderOnlySavingFraction?: number | null;
}

export interface RouteDecision {
  offered: boolean;
  selected: RouteKind;
  reason: QuickOffer;
  /** The share of Full quality's time Quick saves, 0 to 1, or null when that is not known. */
  savedFraction: number | null;
}

const refused = (reason: QuickOffer, savedFraction: number | null = null): RouteDecision => ({
  offered: false,
  selected: "standard",
  reason,
  savedFraction,
});

const secondsOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

const unitOf = (value: number): number => Math.min(1, Math.max(0, value));

/** Whether Quick is on offer, and which way the dialog or the card starts on. An export that is a minute or less, or has no estimate, is
 *  not offered Quick (nothing is gained, and with no estimate nothing can be shown); an estimate for Quick that is missing is read the
 *  same way. Full quality is always available: `selected` is `standard` whenever Quick is not offered. */
export function chooseRoute(input: RouteInput): RouteDecision {
  try {
    if (input.quickFlagOn !== true) return refused("off");
    const full = secondsOf(input.full?.seconds);
    if (full === null || full <= FAST_DEFAULT_SECONDS) return refused("short");

    let saved: number;
    if (input.explicit?.size === true && input.explicit?.fps === true) {
      // Both are set, so Quick is only the encoder: it is judged by what the encoder alone saves, and the reason is `explicit` rather than
      // `small_gain` whatever Quick's own estimate says.
      const encoderOnly = input.encoderOnlySavingFraction;
      const known = typeof encoderOnly === "number" && Number.isFinite(encoderOnly);
      if (!known) return refused("explicit");
      if (encoderOnly < FAST_MIN_SAVING) return refused("explicit", unitOf(encoderOnly));
      saved = unitOf(encoderOnly);
    } else {
      const quick = secondsOf(input.quick?.seconds);
      if (quick === null) return refused("short");
      saved = unitOf(1 - quick / full);
      if (quick > full * (1 - FAST_MIN_SAVING)) return refused("small_gain", saved);
    }

    const weak = isWeakPc(input.pcClass);
    const selected: RouteKind =
      input.picked === "quick" || input.picked === "standard"
        ? input.picked
        : weak
          ? "quick"
          : "standard";
    return {
      offered: true,
      selected,
      reason: weak && selected === "quick" ? "selected" : "offered",
      savedFraction: saved,
    };
  } catch {
    return refused("off");
  }
}

/** Whether the chat card asks "Full quality or Quick?" before an export the assistant started: on a weak PC whenever Quick is on offer,
 *  elsewhere only for an export expected over ten minutes, and never when Quick is not on offer. */
export function routeQuestionDue(input: {
  pcClass: PcClass;
  decision: RouteDecision;
  fullSeconds: number | null;
}): boolean {
  try {
    if (input.decision?.offered !== true) return false;
    if (isWeakPc(input.pcClass)) return true;
    const full = secondsOf(input.fullSeconds);
    return full !== null && full > ROUTE_QUESTION_SECONDS;
  } catch {
    return false;
  }
}
