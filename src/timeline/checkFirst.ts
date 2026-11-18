// HELD OFF, NOT DELETED (owner decision 2026-11-18): part of the held export-time guess machinery (flags `estimate_v2`,
// `pc_check`, both in OFF_IN_THIS_BUILD in `api/exportFlags.ts`), kept for a later release, so do not remove it as unused;
// see docs/EXPORTER_ARCHITECTURE.md, "Deferred Export Speed And Settings Work".
//
// Whether an export that starts without the Export dialog should first offer to check this PC's speed (the question "Check this PC's speed first?"). Pure: the caller
// says how the export was asked for and what it knows. The question is asked once per export, only for a heavy export on a PC that has no class and no measured time
// for this shape, and never because of the very check it would offer (a check that is running or has just been asked about does not count as a reason to ask again).
import type { PcClass } from "./exportTypes3c";

export interface CheckFirstInput {
  /** How the export was asked for: only an export that starts without the dialog (chat, MCP, another start) is asked about; the dialog shows the check on its own. */
  via: "menu" | "chat" | "mcp" | "other";
  pcClass: PcClass;
  /** This PC has a finished export of the same shape: its time is measured, nothing needs checking. */
  matchingHistory: boolean;
  /** The project is heavy: over its promise line, over 10 minutes on the prior, or its predicted memory does not fit. */
  heavy: boolean;
  /** The question was already asked for this export, or a check is running or has just been refused. */
  alreadyAsked: boolean;
}

export function checkFirstDue(input: CheckFirstInput): boolean {
  return (
    input.via !== "menu" &&
    input.pcClass === "unknown" &&
    !input.matchingHistory &&
    input.heavy &&
    !input.alreadyAsked
  );
}
