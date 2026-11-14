// Phase 3c (honest estimates, the lighter Quick route, the slow banner, the graphics-chip safeguards): the closed lists and plain types
// the 3c modules share. Types and frozen constants only: no logic, no storage, no import of app state.
//
// Each list below is the ONE definition the 3c modules use. The report's wire lists belong to lane L2 (`src/api/export*.ts`) and are written
// separately; a conformance test compares the two when the facts are wired. That wiring is HELD until the owner says yes to the privacy text:
// nothing in this file is sent anywhere.
import type { ChipMaker } from "./exportEncoder";
import type { ExportQuality, ExportResolution } from "./exportOptions";
import type { RenderWorkload } from "./renderPlan";

/** The PC's class from the hidden speed test. `unfinished` = the check could not finish in its time box (counts as weak); `unknown` = no check yet or the check is off. */
export const PC_CLASSES = ["fast", "ok", "weak", "unfinished", "unknown"] as const;
export type PcClass = (typeof PC_CLASSES)[number];

/** Where an estimate came from: a quick check of this PC, earlier exports on this PC (stopped runs included), or a rough guess. */
export const ESTIMATE_BASES = ["pc_check", "history", "guess"] as const;
export type EstimateBasis = (typeof ESTIMATE_BASES)[number];

/** Which kind of export: Full quality (`standard`) or Quick. This is the ONLY meaning of the word `route` in the report and in the assistant's list row. */
export const ROUTE_KINDS = ["standard", "quick"] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];

/** Why Quick was or was not on offer: preselected, offered, not offered because it would save under 25 %, because the export is a minute or less,
 *  because the person or the assistant set a size or rate, or because the remote switch is off. */
export const QUICK_OFFERS = [
  "selected",
  "offered",
  "small_gain",
  "short",
  "explicit",
  "off",
] as const;
export type QuickOffer = (typeof QUICK_OFFERS)[number];

/** Which help the person saw while exporting: the heavy-export line before the start, the memory warning, the slow banner, the stopped-moving banner. */
export const HELP_WORDS = ["heavy", "memory", "slow", "quiet"] as const;
export type HelpWord = (typeof HELP_WORDS)[number];

/** The encoder family a time or a ratio belongs to: the processor (x264, normal or faster setting) or a graphics chip. A ratio learned on one never corrects the other. */
export type EncoderFamily = "processor" | "chip";

/** The estimate every number the person is told comes from. Whole seconds; `low <= seconds <= high`. */
export interface HonestEstimate {
  /** The central value in whole seconds (at least 1). */
  seconds: number;
  /** The range the estimate stands behind, whole seconds. */
  low: number;
  high: number;
  basis: EstimateBasis;
  /** The file size this PC has measured for this export, else null. */
  bytes: number | null;
  /** `high` is over four times `seconds`, or a feature in the project could not be priced: "could take much longer". */
  muchLonger: boolean;
  /** The encoder family the number is for. */
  family: EncoderFamily;
}

/** What a route decision needs to know about one way of exporting. `null` = no estimate (the estimator failed soft). A `HonestEstimate` is assignable to it. */
export interface RouteEstimate {
  seconds: number | null;
  basis: EstimateBasis | null;
}

/** The honest estimate of each way an export could run, for the route decision, the dialog and the chat question. `null` = no estimate for that way:
 *  it is then not offered and not chosen. */
export interface RouteEstimates {
  /** The speed class of this PC (the estimate side knows it: it priced the estimates from it); `unknown` when there is no check or the check is off. */
  pcClass: PcClass;
  /** The processor's normal setting at the person's own settings (Full quality). */
  standard: HonestEstimate | null;
  /** Quick: its own size and rate and the processor's faster setting. */
  quick: HonestEstimate | null;
  /** The graphics chip, where one passed its test for this picture. */
  chip: HonestEstimate | null;
  /** The processor's faster setting at the person's own settings. */
  faster: HonestEstimate | null;
}

/** What the dialog, the chat question and the admission door ask the estimate side for (see `routeEstimatesPort.ts`). */
export interface RouteEstimatesRequest {
  workload: RenderWorkload;
  settings: {
    resolution: ExportResolution | undefined;
    quality: ExportQuality | undefined;
    fps: number | null | undefined;
  };
  /** Which of size and rate the person or the assistant set explicitly: Quick never overrides one that was set. */
  explicit: ExplicitSettings;
  /** The chip that passed its test for this picture, or null. */
  chipMaker: ChipMaker | null;
}

/** What the person or the assistant set explicitly. Quick never overrides a size or a frame rate that was set. */
export interface ExplicitSettings {
  size: boolean;
  fps: boolean;
}

/** The remote switches the 3c modules read. A module takes this as a PARAMETER (never reads the flag store itself); one reader of the switches builds it.
 *  The first six are new in Phase 3c (lane L2's flags 24 to 29); the next eight exist since Phase 3; `auto_restart` is lane L3b's master of every automatic restart. */
export const FLAGS_3C = [
  "pc_check",
  "estimate_v2",
  "memory_shape",
  "quick_export",
  "export_help",
  "chip_restart",
  "stall_stop",
  "plan_rung",
  "pc_floor",
  "chip_amd",
  "chip_nvidia",
  "chip_intel",
  "chip_default",
  "faster_x264",
  "auto_restart",
] as const;
export type Flag3cName = (typeof FLAGS_3C)[number];
export type Flags3c = Readonly<Record<Flag3cName, boolean>>;

/** Every switch on (the compiled defaults: the server only ever switches things OFF). */
export function flags3cAllOn(): Flags3c {
  return Object.fromEntries(FLAGS_3C.map((name) => [name, true])) as Flags3c;
}

/** Every switch off: the app as 0.27.0 ran it. */
export function flags3cAllOff(): Flags3c {
  return Object.fromEntries(FLAGS_3C.map((name) => [name, false])) as Flags3c;
}

/** The six NEW facts of one export report as a LOCAL record. Nothing here is sent: the client send is HELD until the owner says yes to the one privacy text,
 *  and it is the last step of the build. `encoder`, `chip` and `mode_reason` already exist in the report since Phase 3 and are not here. */
export interface ReportFacts3c {
  speed_class: PcClass;
  /** The central estimate shown before the start, whole seconds, or null when there was none. */
  estimate_s: number | null;
  estimate_basis: EstimateBasis | null;
  route: RouteKind;
  /** Absent for a clip or library export. */
  quick_offer: QuickOffer | null;
  help_shown: HelpWord[];
}
