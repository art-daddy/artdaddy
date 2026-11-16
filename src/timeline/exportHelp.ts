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
/** Where the watch saw the first picture arrive, the pace is read from it, and only once it is this old: a render's first seconds are not its pace. */
export const SLOW_MIN_SINCE_FIRST_PICTURE_SECONDS = 30;
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

/** The look at which the watch first found a picture, after a look that found none. */
export interface FirstPicture {
  /** Seconds since the export's start. */
  atSeconds: number;
  /** The share of the project produced then, over 0 and up to 1. */
  produced: number;
}

export interface HelpInput {
  elapsedSeconds: number;
  /** The share of the project produced so far, 0 to 1. It is 1 once the render is over (checking and saving), which shows no banner. */
  producedFraction: number;
  /** The render's own time left. Null where it has none to give (a streamed or a sequence export, whose own figure is not a time left, or
   *  a render that has stopped moving): the projection then comes from the produced fraction. */
  renderEtaSeconds: number | null;
  /** Where the watch saw the first picture arrive, when it was watching for it. The render's own time left and the share produced both count the time before the first picture
   *  as time at the render's pace, so a big project that spends minutes starting up looks several times slower than it is. Given this, the slow banner reads the pace from
   *  the first picture on, and never projects a longer run than the reading from the start does. Absent, or not readable: the projection is counted from the start. */
  firstPicture?: FirstPicture | null;
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

/** The projected length of the whole export, counted from the start: the run so far plus the render's own time left, or, without that, the run so far over
 *  the share produced. Null when neither can be said. */
function projectionOf(elapsed: number, produced: number, eta: unknown): number | null {
  if (finite(eta) && eta >= 0) return elapsed + eta;
  return produced >= SLOW_MIN_PRODUCED ? elapsed / produced : null;
}

/** The first picture as the rule can use it, or null when it was not given or cannot be read. */
function readFirstPicture(value: unknown): FirstPicture | null {
  if (typeof value !== "object" || value === null) return null;
  const { atSeconds, produced } = value as Partial<FirstPicture>;
  return finite(atSeconds) && atSeconds >= 0 && finite(produced) && produced > 0 && produced <= 1
    ? { atSeconds, produced }
    : null;
}

/** The projected length of the whole export from the pace since the first picture: what is left of the project, at the share made per second since then. Never longer than
 *  `fromStart`, the projection counted from the start. Null while that picture is too new, or the share has not moved since, for a pace to be read. */
function projectionSincePicture(
  elapsed: number,
  produced: number,
  first: FirstPicture,
  fromStart: number | null,
): number | null {
  const since = elapsed - first.atSeconds;
  const made = produced - first.produced;
  if (!(since >= SLOW_MIN_SINCE_FIRST_PICTURE_SECONDS) || !(made > 0)) return null;
  const paced = elapsed + ((1 - produced) * since) / made;
  return fromStart !== null ? Math.min(fromStart, paced) : paced;
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

  // The slow banner judges the pace since the first picture where the watch saw it arrive; the stopped-moving banner above is a different rule and reads the projection from the start.
  const first = readFirstPicture(input.firstPicture);
  const paced = first ? projectionSincePicture(elapsed, produced, first, projected) : projected;
  if (paced === null || elapsed < SLOW_AFTER_SECONDS || produced < SLOW_MIN_PRODUCED) return none();
  const slow =
    expected !== null && measured
      ? paced > SLOW_OVER_ESTIMATE * expected
      : paced > SLOW_OVER_SECONDS_UNMEASURED;
  if (!slow) return none();
  if (Math.floor(atLeastZero(input.shown?.slowShown)) >= MAX_SLOW_BANNERS) return none();
  const silenced = positive(input.shown?.silencedAtProjection);
  if (silenced !== null && paced < SLOW_REARM_FACTOR * silenced) return none();

  const left = Math.max(0, paced - elapsed);
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
    paced,
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
