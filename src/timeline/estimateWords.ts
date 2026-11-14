// The words about an estimate: the line under the Export dialog's three settings, the amber lines for a project that could take much longer
// or is heavy, and the lines about the PC's speed check. Pure, so a number in a sentence is always the estimate record's own, and a
// rough guess is never dressed as anything else.
//
// Every sentence is the owner's copy, word for word, with its numbers filled in. Times and sizes go through the baseline's
// describeExportTime and describeExportSize so the style matches the card's.
import { describeExportSize, describeExportTime } from "./exportOptions";
import type { HonestEstimate, PcClass } from "./exportTypes3c";

/** A single time is shown when the estimate's high end is at most this many times its low end; a range when it is more. */
export const RANGE_RATIO = 1.8;

/** The parts of an estimate its line is made of. A `HonestEstimate` is one. */
export type EstimateWordsInput = Pick<
  HonestEstimate,
  "seconds" | "low" | "high" | "basis" | "bytes"
>;

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** A time without its "about": "50 min", for the two ends of a range. */
const bare = (text: string): string => text.replace(/^about /, "");

/** "about 50 min" for a narrow estimate, "50 min to 2 h" for a wide one, or "" when the estimate has no time worth saying. */
function spanOf(estimate: EstimateWordsInput): string {
  const single = describeExportTime(estimate.seconds);
  if (!single) return "";
  const { low, high } = estimate;
  if (finite(low) && finite(high) && low > 0 && high > low && high / low > RANGE_RATIO) {
    const from = bare(describeExportTime(low));
    const to = bare(describeExportTime(high));
    if (from && to && from !== to) return `${from} to ${to}`;
  }
  return single;
}

/** The line under the three settings: the time, and where it came from. "A rough guess" is said whenever it is one. Empty when there is no
 *  estimate, so no line is shown. `pcClass` tells a guess made because the speed check could not finish from one made before any check. */
export function describeEstimateLine(
  estimate: EstimateWordsInput | null | undefined,
  pcClass?: PcClass,
): string {
  try {
    if (!estimate) return "";
    const span = spanOf(estimate);
    if (!span) return "";
    if (estimate.basis === "pc_check")
      return `Expected: ${span}, from a quick check of this PC's speed.`;
    if (estimate.basis === "history") {
      const size = describeExportSize(estimate.bytes);
      return `Expected: ${span}${size ? `, a file of ${size}` : ""}, from earlier exports on this PC.`;
    }
    return pcClass === "unfinished"
      ? `Expected: ${span}. A rough guess: the speed check could not finish, so this PC is treated as slower than most.`
      : `Expected: ${span}. A rough guess: this PC's speed has not been checked yet.`;
  } catch {
    return "";
  }
}

export const MUCH_LONGER_LINE =
  "This project is heavier than what the check measured, so it could take much longer.";
export const UNREAD_SOURCES_LINE =
  "ArtDaddy has not read some of your clips yet, so this could take much longer.";

/** The amber line for an estimate that could be far off: a source nobody has read yet, or a project heavier than the check measured.
 *  Null where there is nothing to warn about. */
export function describeMuchLonger(
  estimate: Pick<HonestEstimate, "muchLonger"> | null | undefined,
  options: { sourcesUnread?: boolean } = {},
): string | null {
  if (options?.sourcesUnread === true) return UNREAD_SOURCES_LINE;
  return estimate?.muchLonger === true ? MUCH_LONGER_LINE : null;
}

export interface HeavyProjectInput {
  seconds: number | null;
  quickSeconds: number | null;
  /** Quick is on offer for this project. */
  quickOffered: boolean;
}

/** The amber line before a heavy export: how long it would take, and what makes it faster: Quick, where it is on offer. */
export function describeHeavyProject(input: HeavyProjectInput): string | null {
  try {
    const time = describeExportTime(input.seconds);
    if (!time) return null;
    const quick = describeExportTime(input.quickSeconds);
    return input.quickOffered === true && quick
      ? `This project is heavy for this PC: ${time}. Quick export would take ${quick}; lowering the picture size or frame rate also helps.`
      : `This project is heavy for this PC: ${time}. To go faster, lower the picture size or frame rate, or export a shorter section.`;
  } catch {
    return null;
  }
}

export const CHECKING_LINE = "Checking this PC's speed… (about 10 seconds)";
/** The link at the end of the check's result line. */
export const CHECK_AGAIN_LABEL = "Check again";
export const MEMORY_PREDICTION_FACT = "Worked out from the size and number of your clips";

const CHECK_NAMES: Partial<Record<PcClass, string>> = { fast: "fast", ok: "OK", weak: "slow" };

/** The check's result line: the class in the person's words, the day it was made, and the link to make it again. Nothing where no check
 *  has been made. */
export function describeSpeedCheck(pcClass: PcClass, day: string = ""): string {
  if (pcClass === "unfinished")
    return "Speed check: not finished (this PC was busy) · treated as slower than most · Check again";
  const name = CHECK_NAMES[pcClass];
  if (!name) return "";
  const when = typeof day === "string" ? day.trim() : "";
  return ["Speed check: " + name, when, CHECK_AGAIN_LABEL].filter((part) => part).join(" · ");
}

/** The day a check was made, as it is said: today, yesterday, so many days ago. "" for a time that is not one. */
export function describeCheckDay(madeAt: number, now: number): string {
  if (!finite(madeAt) || !finite(now)) return "";
  const dayOf = (ms: number): number => {
    const date = new Date(ms);
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
  };
  const days = Math.round(dayOf(now) - dayOf(madeAt));
  if (!finite(days)) return "";
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return days <= 30 ? `${days} days ago` : "over a month ago";
}
