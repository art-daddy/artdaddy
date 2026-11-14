// The slow-export banner's view-model: what a running export shows when it is going much slower than it was said to, or has stopped
// moving, and which buttons go with it. Pure: it is handed the facts, so the card, the Export dialog and the assistant's export list can
// read one state.
//
// The banner is a courtesy and never a decision: it changes nothing about the export, and every number it cannot read gives no banner.
import type { EstimateBasis } from "./exportTypes3c";
import { QUIET_SECONDS } from "./exportWords";
import {
  describeQuietBanner,
  describeSlowBanner,
  type BannerButton,
  type QuickHelp,
} from "./routeWords";

/** At least this long into the run before a slow banner can show: the first seconds of a render are not its pace. */
export const SLOW_AFTER_SECONDS = 90;
/** ... and at least this much of the project produced. */
export const SLOW_MIN_PRODUCED = 0.02;
/** The projection must be over this many times the estimate that was shown ... */
export const SLOW_OVER_ESTIMATE = 3;
/** ... or, where no measured estimate was shown, over this long. */
export const SLOW_OVER_SECONDS_UNMEASURED = 30 * 60;
/** Keep going silences the banner until the projection has doubled again. */
export const SLOW_REARM_FACTOR = 2;
/** Slow banners the person is shown for one export, at most. */
export const MAX_SLOW_BANNERS = 2;
/** Switch to Quick is offered only when Quick would finish at least this much sooner than what is left. */
export const QUICK_MIN_SAVING_OF_LEFT = 0.4;

/** What the processor is doing while an export makes no progress, as the stall rule reads it. */
export type ActivityVerdict = "busy" | "idle" | "unknown";

export interface HelpInput {
  elapsedSeconds: number;
  /** The share of the project produced so far, 0 to 1. It is 1 once the render is over (checking and saving), which shows no banner. */
  producedFraction: number;
  /** The render's own time left. Null where it has none to give (a streamed or a sequence export, whose own figure is not a time left, or
   *  a render that has stopped moving): the projection then comes from the produced fraction. */
  renderEtaSeconds: number | null;
  /** The estimate that was shown before the start, and where it came from. */
  expectedSeconds: number | null;
  expectedBasis: EstimateBasis | null;
  /** Quick's estimate for the same project, from the start. */
  quickSeconds: number | null;
  /** How long the render has not moved. */
  quietSeconds: number;
  verdict: ActivityVerdict;
  /** A whole-timeline export with a retry closure, still rendering (not checking or saving), with Quick on offer. */
  canSwitch: boolean;
  shown: {
    /** Slow banners the person has already answered with Keep going. */
    slowShown: number;
    /** The projection at the moment of the last Keep going, or null if there has been none. */
    silencedAtProjection: number | null;
    /** The stopped-moving banner has already been answered. */
    quietShown: boolean;
  };
  /** The remote switch `export_help`. */
  flagOn: boolean;
}

export interface HelpView {
  kind: "none" | "slow" | "quiet";
  /** The headline first, then the rest. */
  lines: string[];
  buttons: BannerButton[];
  /** The Switch to Quick button is among the buttons. */
  quickAvailable: boolean;
  /** Quick's estimate in whole seconds, present only where Switch to Quick is available (the assistant's row says it only then). */
  quickSeconds: number | null;
  /** The projected length of the whole export, in whole seconds, when there is a projection. */
  projectedTotalSeconds: number | null;
}

const none = (): HelpView => ({
  kind: "none",
  lines: [],
  buttons: [],
  quickAvailable: false,
  quickSeconds: null,
  projectedTotalSeconds: null,
});

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const atLeastZero = (value: unknown): number => (finite(value) && value > 0 ? value : 0);
const positive = (value: unknown): number | null => (finite(value) && value > 0 ? value : null);
const unit = (value: unknown): number => (finite(value) ? Math.min(1, Math.max(0, value)) : 0);

/** The projected length of the whole export: the run so far plus the render's own time left, or, without that, the run so far over
 *  the share produced. Null when neither can be said. */
function projectionOf(elapsed: number, produced: number, eta: unknown): number | null {
  if (finite(eta) && eta >= 0) return elapsed + eta;
  return produced >= SLOW_MIN_PRODUCED ? elapsed / produced : null;
}

function viewOf(
  kind: "slow" | "quiet",
  lines: string[],
  quickAvailable: boolean,
  quick: number | null,
  projected: number | null,
): HelpView {
  return {
    kind,
    lines,
    buttons: quickAvailable
      ? ["switch_to_quick", "keep_going", "cancel"]
      : ["keep_going", "cancel"],
    quickAvailable,
    quickSeconds: quickAvailable && quick !== null ? Math.round(quick) : null,
    projectedTotalSeconds: projected === null ? null : Math.round(projected),
  };
}

function help(input: HelpInput): HelpView {
  if (input.flagOn !== true) return none();
  const elapsed = atLeastZero(input.elapsedSeconds);
  const produced = unit(input.producedFraction);
  if (produced >= 1) return none();
  const quiet = atLeastZero(input.quietSeconds);
  const verdict: ActivityVerdict =
    input.verdict === "busy" || input.verdict === "idle" ? input.verdict : "unknown";
  const expected = positive(input.expectedSeconds);
  const measured =
    expected !== null && (input.expectedBasis === "pc_check" || input.expectedBasis === "history");
  const quick = finite(input.quickSeconds) && input.quickSeconds >= 0 ? input.quickSeconds : null;
  const switchable = input.canSwitch === true && quick !== null;
  const projected = projectionOf(elapsed, produced, input.renderEtaSeconds);
  const helps = (left: number | null): boolean =>
    switchable && left !== null && quick !== null && quick <= left * (1 - QUICK_MIN_SAVING_OF_LEFT);

  if (quiet >= QUIET_SECONDS) {
    // A busy processor is the stall rule's "still working": that line stands and this adds no text.
    if (verdict === "busy" || input.shown?.quietShown === true) return none();
    const left = projected !== null ? Math.max(0, projected - elapsed) : expected;
    const offer = helps(left);
    return viewOf(
      "quiet",
      describeQuietBanner({
        quietSeconds: quiet,
        quickSeconds: quick,
        quick: offer ? "helps" : "none",
        idle: verdict === "idle",
      }),
      offer,
      quick,
      projected,
    );
  }

  if (projected === null || elapsed < SLOW_AFTER_SECONDS || produced < SLOW_MIN_PRODUCED)
    return none();
  const slow =
    expected !== null && measured
      ? projected > SLOW_OVER_ESTIMATE * expected
      : projected > SLOW_OVER_SECONDS_UNMEASURED;
  if (!slow) return none();
  if (Math.floor(atLeastZero(input.shown?.slowShown)) >= MAX_SLOW_BANNERS) return none();
  const silenced = positive(input.shown?.silencedAtProjection);
  if (silenced !== null && projected < SLOW_REARM_FACTOR * silenced) return none();

  const left = Math.max(0, projected - elapsed);
  const offer = helps(left);
  const advice: QuickHelp = offer ? "helps" : switchable ? "no_help" : "none";
  return viewOf(
    "slow",
    describeSlowBanner({
      leftSeconds: left,
      expectedSeconds: expected,
      quickSeconds: quick,
      quick: advice,
    }),
    offer,
    quick,
    projected,
  );
}

/** What the banner shows now: a slow export, a stopped one, or nothing. Never throws; what it cannot read it does not show. */
export function exportHelp(input: HelpInput): HelpView {
  try {
    return help(input);
  } catch {
    return none();
  }
}
