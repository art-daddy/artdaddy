// What a failed export tells the person to lower: one sentence added where there is something true to say, and nothing where the cause is not known, because a guess could send the person the wrong way.
// Pure, so the card, the Export dialog and the assistant's export list say the same thing. Quick is named only where it exists.
import type { ExportReasonCode } from "../api/exportReason";

export interface LowerInput {
  /** Why the export failed (`reasonOfError`). */
  code: ExportReasonCode;
  /** The graphics chip stopped it and nothing started it again: what makes the next try shorter is what is said, whatever the code under it. */
  chipFailed?: boolean;
  /** Quick export exists for this export. */
  quick: boolean;
}

/** The one sentence to add after 0.27.0's own, or "" when there is nothing true to say. Never throws. */
export function describeLower(input: LowerInput): string {
  try {
    const quick = input?.quick === true;
    if (input?.chipFailed === true)
      return quick
        ? "To make that shorter, lower the picture size or frame rate, or use Quick export."
        : "To make that shorter, lower the picture size or frame rate.";
    if (input?.code === "memory_limit")
      return "To use less memory, lower the picture size or frame rate, or export a shorter section.";
    if (input?.code === "time_limit")
      return quick
        ? "On this PC a lower picture size or frame rate, a shorter section, or Quick export is faster."
        : "On this PC a lower picture size or frame rate, or a shorter section, is faster.";
    return "";
  } catch {
    return "";
  }
}
