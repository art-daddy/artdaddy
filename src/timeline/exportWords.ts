// The words an export uses about itself, once: where it is, how far, what stopped it. Pure, so the chat
// card, the assistant's export list and the tests all say the same thing, and a number that is not a
// number never reaches a sentence.
import { reasonOfError, type ExportReasonCode } from "../api/exportReason";
import type { ModeReason } from "./exportEncoder";
import {
  describeExportSize,
  describeExportTime,
  type DialogEstimate,
  type ExportMode,
} from "./exportOptions";

export type LiveStageName = "queued" | "preparing" | "rendering" | "checking" | "saving";

/** What the card knows about the export that is running: the stage, how far, and when the render last
 *  moved (an output position or a frame count that changed), which is what "no progress" counts from. */
export interface LiveFacts {
  readonly stage: LiveStageName;
  /** When this export's turn began (ms since the epoch). */
  readonly startedAt: number;
  readonly fraction: number | null;
  readonly etaSec: number | null;
  /** The part of a streamed render being made (0-based) and how many there are, the last being the encode. */
  readonly step: number | null;
  readonly steps: number | null;
  readonly lastMoveAt: number;
}

/** A render that has not moved for this long is said to have made no progress (the same silence the
 *  report logs as a stall; a test pins the two together). */
export const QUIET_SECONDS = 60;

/** How often a line that counts minutes is redrawn while an export runs: well inside the minute it promises. The chat
 *  card and the Export dialog share it. */
export const STATUS_REFRESH_MS = 10_000;

const whole = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;

/** Seconds since the render last moved, while it is preparing or rendering; zero in any other stage
 *  (checking the file and saving are not the render standing still). */
export function quietSeconds(live: LiveFacts, now: number): number {
  if (live.stage !== "preparing" && live.stage !== "rendering") return 0;
  return whole((now - live.lastMoveAt) / 1000);
}

export function describeStage(live: LiveFacts): string {
  switch (live.stage) {
    case "queued":
      return "Waiting";
    case "preparing":
      return "Preparing · checking your clips";
    case "checking":
      return "Checking the file";
    case "saving":
      return "Saving";
    case "rendering": {
      const { step, steps } = live;
      if (
        step !== null &&
        steps !== null &&
        Number.isInteger(step) &&
        Number.isInteger(steps) &&
        steps > 1 &&
        step >= 0 &&
        step < steps
      )
        return step === steps - 1 ? "Encoding" : `Rendering part ${step + 1} of ${steps - 1}`;
      return "Rendering and encoding";
    }
  }
}

/** A render's own guess at the time left, or null when it cannot be one: not a number, negative, or more than two days. */
function plausibleEta(eta: number | null): number | null {
  return eta === null || !Number.isFinite(eta) || eta < 0 || eta > 48 * 3600 ? null : eta;
}

/** How long a render thinks is left, in seconds, or null when that is not worth saying: the render is not
 *  under way, it has stopped moving, or the number cannot be a time left. The one rule the status line and
 *  the assistant's export list share. */
export function timeLeftSeconds(live: LiveFacts, now: number): number | null {
  if (live.stage !== "rendering" || quietSeconds(live, now) >= QUIET_SECONDS) return null;
  return plausibleEta(live.etaSec);
}

/** The front of the one line under the bar: how long it has been going or that it has made no progress, the stage by
 *  name, and how far a render is. Everything but the time left, which the Export dialog shows on its own side of the
 *  panel. Refreshed by a clock (at least every minute), not by the progress feed, which goes quiet exactly when the line
 *  matters most. */
export function describeStageLine(live: LiveFacts, now: number): string {
  if (live.stage === "queued") return describeStage(live);
  const quiet = quietSeconds(live, now);
  const parts: string[] = [];
  if (quiet >= QUIET_SECONDS)
    parts.push(`No progress for ${quiet < 120 ? `${quiet} s` : `${Math.floor(quiet / 60)} min`}`);
  else {
    // Checking the file and saving go on for minutes on a long export, and a line that never changed
    // would look as stuck as one that is.
    const minutes = Math.floor(whole(now - live.startedAt) / 60_000);
    if (minutes >= 1) parts.push("Still working", `${minutes} min in`);
  }
  parts.push(describeStage(live));
  if (live.stage === "rendering" && live.fraction !== null && Number.isFinite(live.fraction))
    parts.push(`${Math.round(Math.min(1, Math.max(0, live.fraction)) * 100)}%`);
  return parts.join(" · ");
}

/** The one line under the bar: the front ({@link describeStageLine}) and how long the render thinks is left. */
export function describeLiveStatus(live: LiveFacts, now: number): string {
  const front = describeStageLine(live, now);
  if (live.stage === "queued") return front;
  const left = timeLeftSeconds(live, now);
  const leftText = left === null ? "" : describeExportTime(left);
  return leftText ? `${front} · ${leftText} left` : front;
}

/** What an export is expected to take: one sentence for the Export dialog before the click, the chat card while it runs,
 *  and an assistant's answer when it starts one, so all three say the same thing. Nothing when there is no time to say.
 *  `all` is for several files run one after another: it names the time in all and no size, which is one file's. */
export function describeExpected(
  estimate: DialogEstimate | null | undefined,
  scope: "file" | "all" = "file",
): string {
  if (!estimate) return "";
  const time = describeExportTime(estimate.seconds);
  if (!time) return "";
  const span = scope === "all" ? `${time} in all` : time;
  if (estimate.guessed)
    return `Expected: ${span}. A rough guess: nothing like this has been exported on this PC yet.`;
  const size = scope === "all" ? "" : describeExportSize(estimate.finalBytes);
  return `Expected: ${span}${size ? `, a file of ${size}` : ""}, from earlier exports on this PC.`;
}

/** What the Export dialog's panel says while its own export goes. */
export interface DialogProgress {
  /** Left of the panel: the stage by name, and how far a render is. */
  readonly status: string;
  /** The bar: how far, or null when that is not known. */
  readonly fraction: number | null;
  /** Right of the panel: how fast the render goes (a multiple of the video's length), or null when not worth saying. */
  readonly speed: number | null;
  /** Right of the panel: how long the render thinks is left, in seconds, or null when not worth saying. */
  readonly left: number | null;
}

const unitOrNull = (value: number | null): number | null =>
  value !== null && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
const rateOrNull = (value: number): number | null =>
  Number.isFinite(value) && value > 0 ? value : null;

/** What the Export dialog's panel says about the export it follows. `own` is that export's own feed (it has none until
 *  its turn comes, and none once it has settled), `place` its place in line while it waits. The dialog's own job, the
 *  last four fields, is moved by WHICHEVER export is rendering, so it is trusted only before the export has an id: once it
 *  has one, a panel that read the job would say another export's percent. */
export function describeDialogProgress(
  view: {
    readonly own: (LiveFacts & { readonly speed: number }) | null;
    readonly place: number | null;
    readonly phase: "preparing" | "rendering";
    readonly fraction: number | null;
    readonly etaSec: number | null;
    readonly speed: number;
  },
  now: number,
): DialogProgress {
  const { own } = view;
  if (own)
    return {
      status: describeStageLine(own, now),
      fraction: unitOrNull(own.fraction),
      speed: own.stage === "rendering" ? rateOrNull(own.speed) : null,
      left: timeLeftSeconds(own, now),
    };
  if (view.place !== null)
    return { status: describeWaiting(view.place), fraction: null, speed: null, left: null };
  const rendering = view.phase === "rendering";
  const fraction = unitOrNull(view.fraction);
  return {
    status: !rendering
      ? "Preparing…"
      : fraction === null
        ? "Starting…"
        : `${Math.round(fraction * 100)}%`,
    fraction,
    speed: rendering ? rateOrNull(view.speed) : null,
    // The same rule as the feed's: a number that cannot be a time left is not said.
    left: rendering ? plausibleEta(view.etaSec) : null,
  };
}

/** One line for an export that runs below the normal setting: it says why and what it costs. Nothing for the
 *  normal setting, which needs no explaining. */
export function describeRung(rung: unknown): string {
  if (rung === 1)
    return "Using a gentler setting to fit this PC's memory · it may take a little longer";
  if (rung === 2) return "Using the gentlest setting to fit this PC's memory · it will take longer";
  return "";
}

/** What the Export dialog knows about the mode: what the app decided (exportChoice.ts) and what each way is estimated to
 *  take. */
export interface ModeView {
  /** The Mode row is shown (a graphics chip has proven itself and would save a quarter of the time). */
  readonly showRow: boolean;
  /** What the row starts on. */
  readonly defaultMode: ExportMode;
  readonly reason: ModeReason;
  /** The processor's faster setting will be used (no row, no chip). */
  readonly faster: boolean;
  readonly fullSeconds: number | null;
  readonly fastSeconds: number | null;
}

export interface ModeLines {
  /** The mode the dialog shows as chosen: Fast only where the row is shown. */
  readonly selected: ExportMode;
  /** Under the Mode row. */
  readonly hint: string | null;
  /** The amber note: why Fast is selected, or what it costs. */
  readonly note: string | null;
  /** What the other mode would take. */
  readonly alternative: string | null;
  /** The note for the faster processor setting, where there is no row. */
  readonly faster: string | null;
}

export const FAST_HINT =
  "Fast uses your graphics chip: usually quicker, and the file is usually larger.";
export const FASTER_SETTING_LINE =
  "To save time, ArtDaddy will use a faster setting; the picture may be slightly softer.";

/** The words of the Export dialog's Mode row (exporter document, Appendix A): the row, what it starts on and why, what
 *  each way takes, and the faster setting where there is no row. `picked` is what the person chose in the row, or null
 *  while they have not touched it. */
export function describeModeLines(view: ModeView | null, picked: ExportMode | null): ModeLines {
  const none = {
    selected: "quality" as const,
    hint: null,
    note: null,
    alternative: null,
    faster: null,
  };
  if (!view) return none;
  const selected: ExportMode = view.showRow ? (picked ?? view.defaultMode) : "quality";
  const full = describeExportTime(view.fullSeconds);
  const fast = describeExportTime(view.fastSeconds);
  if (!view.showRow) return { ...none, faster: view.faster ? FASTER_SETTING_LINE : null };
  const alternative =
    selected === "fast"
      ? full
        ? `Full quality would take ${full}.`
        : null
      : fast
        ? `Fast would take ${fast}.`
        : null;
  const note =
    selected !== "fast"
      ? null
      : picked === null && view.reason === "over_minute"
        ? `Fast is selected because this export would take over a minute on this PC${full ? ` (${full})` : ""}. The file will be larger and the picture can differ slightly. Choose Full quality for the smallest file.`
        : "The file will be larger and the picture can differ slightly from Full quality.";
  return { selected, hint: FAST_HINT, note, alternative, faster: null };
}

/** One line for an export that runs on something other than the processor's normal setting: what it is and what it costs.
 *  Nothing for the normal setting, which needs no explaining. */
export function describeEncoder(encoder: unknown, reason: unknown): string {
  if (encoder === "amd" || encoder === "nvidia" || encoder === "intel")
    return `Using your graphics chip${reason === "over_minute" ? " to save time" : ""} · the file is larger and the picture can differ slightly`;
  if (encoder === "x264_fast")
    return "Using a faster setting to save time · the picture may be slightly softer";
  return "";
}

/** What to say when the graphics chip stopped an export: to the person (the card's Try again, or where there is none), and
 *  to the assistant (which has no Try again: it exports again, and the app then keeps off the chip). */
export function describeChipFailure(audience: "card" | "again" | "assistant"): string {
  if (audience === "card")
    return "The graphics chip stopped this export. Try again uses the processor instead, which takes longer.";
  if (audience === "again")
    return "The graphics chip stopped this export. Export it again and the processor will be used, which takes longer.";
  return "The graphics chip stopped this export before it finished. It is set aside for a day: export again and the processor is used, which takes longer.";
}

/** What Try again will do after a failure, when it does anything beyond starting again: after running short of
 *  memory or time it uses a gentler setting, and when the setting that failed was already the lightest this export
 *  has it says so rather than promise a lighter run. Nothing for a failure a gentler setting does not touch.
 *  `lastRung` is the gentlest this export has (`gentlestRungOf`): the streamed engine has none, and with the switch
 *  for rungs off nothing gentler is offered. */
export function describeTryAgain(
  reason: ExportReasonCode,
  failedRung: unknown,
  lastRung: number = 2,
): string {
  if (reason !== "memory_limit" && reason !== "time_limit") return "";
  const ran = failedRung === 1 || failedRung === 2 ? failedRung : 0;
  if (ran >= lastRung)
    return "It was already running at its lightest setting, so trying again will not make it lighter.";
  return "Try again uses a gentler setting: it needs less memory and may take longer.";
}

export function ordinal(n: number): string {
  const k = Math.floor(Math.abs(n));
  const teen = k % 100 >= 11 && k % 100 <= 13;
  const suffix = teen ? "th" : (["th", "st", "nd", "rd"][k % 10] ?? "th");
  return `${k}${k % 10 > 3 ? "th" : suffix}`;
}

/** What a queued export says: its place in line. */
export function describeWaiting(position: number): string {
  return Number.isFinite(position) && position >= 1
    ? `Waiting · ${ordinal(position)} in line`
    : "Waiting";
}

/** After a failure about the place the file was going (a drive that filled up, a folder that would not take it) the
 *  person can choose another folder and the export starts again there (the card's Save somewhere else). A failure
 *  anywhere else is not helped by a different folder, so none is offered. */
export function canSaveElsewhere(reason: ExportReasonCode): boolean {
  return reason === "storage_unavailable" || reason === "storage_full";
}

/** What the card says about Save somewhere else, beside Try again. */
export const SAVE_ELSEWHERE_LINE =
  "Or save it somewhere else: choose a folder and the export starts again there.";

const PLAIN: Record<ExportReasonCode, string> = {
  none: "The export finished.",
  source_unavailable:
    "Some clips couldn't be read. They may have been moved or renamed, or are on a drive that is disconnected.",
  storage_unavailable:
    "ArtDaddy couldn't save to that folder. It may be read-only, the file may be open in another program, or the drive may be disconnected.",
  storage_full: "A drive ran out of space. Free up some space and try again.",
  memory_limit: "Your PC ran short of memory. Close other programs and try again.",
  time_limit: "The export took longer than ArtDaddy allows, or stopped making progress.",
  verification_failed:
    "The finished video didn't pass ArtDaddy's check, so it wasn't saved. Your project was not changed.",
  render_failed: "Something went wrong while exporting. Your project was not changed.",
  interrupted: "ArtDaddy closed while exporting. The unfinished file was removed.",
  cancelled: "The export was cancelled.",
  declined: "You chose not to continue.",
  unknown: "Something went wrong while exporting. Your project was not changed.",
};

export function plainFailure(code: ExportReasonCode): string {
  return PLAIN[code];
}

/** Why a failed export stopped: the reason its text points at, and the sentence for the person. */
export function failureOf(error: string | undefined): { code: ExportReasonCode; plain: string } {
  const code = reasonOfError(error ?? "");
  return { code, plain: plainFailure(code) };
}

/** "4 min 12 s", "45 s", "1 h 3 min": how long something took, the way a person says it. */
export function describeTook(ms: number): string {
  const seconds = Math.floor(whole(ms) / 1000);
  if (seconds < 1) return "under a second";
  if (seconds >= 99 * 3600) return "over 99 h";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
  if (minutes > 0) return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  return `${rest} s`;
}

/** The line a finished export leaves on the card. */
export function describeResult(r: {
  state: "done" | "failed" | "cancelled";
  filename: string;
  elapsedMs: number;
  error?: string;
}): { title: string; detail: string } {
  if (r.state === "done")
    return { title: `Exported “${r.filename}”`, detail: `Took ${describeTook(r.elapsedMs)}` };
  if (r.state === "cancelled") return { title: "Export cancelled", detail: "" };
  return { title: "Export stopped", detail: failureOf(r.error).plain };
}
