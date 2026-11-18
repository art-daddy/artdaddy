// HELD OFF, NOT DELETED (owner decision 2026-11-18): part of the held export-time guess machinery (flags `estimate_v2`,
// `pc_check`, both in OFF_IN_THIS_BUILD in `api/exportFlags.ts`), kept for a later release, so do not remove it as unused;
// see docs/EXPORTER_ARCHITECTURE.md, "Deferred Export Speed And Settings Work".
//
// The six NEW report facts of Phase 3c, kept as a LOCAL record per export. The client send is HELD until the owner approves the one privacy text: nothing in this file
// reaches a report, a request or the network, and `factsForReport` refuses to hand anything out while the constant below is false. Every part of the app that learns
// a fact (the estimate side, the route side, the help side) notes it here; the record is bounded so an app left open for weeks does not grow it.
import type { HelpWord, ReportFacts3c } from "./exportTypes3c";

/** The owner's decision of 14 Nov: not yet. Turning it on is the LAST step of the build, together with the report's wire lists and the privacy text. */
export const SEND_3C_FACTS = false;

const MAX_RECORDS = 200;
const facts = new Map<string, Partial<ReportFacts3c>>();

/** Adds what one part of the app knows about an export. A later note for the same fact replaces the earlier one, except `help_shown`, which accumulates (each word once). Never throws. */
export function noteFact3c(jobId: string, next: Partial<ReportFacts3c>): void {
  try {
    if (typeof jobId !== "string" || jobId === "" || !next || typeof next !== "object") return;
    const known = facts.get(jobId);
    const merged: Partial<ReportFacts3c> = { ...known, ...next };
    if (next.help_shown !== undefined) {
      const words = new Set<HelpWord>([
        ...(known?.help_shown ?? []),
        ...(Array.isArray(next.help_shown) ? next.help_shown : []),
      ]);
      merged.help_shown = [...words];
    }
    facts.delete(jobId);
    facts.set(jobId, merged);
    while (facts.size > MAX_RECORDS) facts.delete(facts.keys().next().value as string);
  } catch {
    // A record that cannot be kept is no record; the export is not told.
  }
}

/** What is known locally about one export (a copy), or undefined. */
export function factsOf3c(jobId: string): Partial<ReportFacts3c> | undefined {
  const known = facts.get(jobId);
  return known
    ? { ...known, ...(known.help_shown ? { help_shown: [...known.help_shown] } : {}) }
    : undefined;
}

/** The only door a report may use: nothing while the send is held. */
export function factsForReport(jobId: string): Partial<ReportFacts3c> | undefined {
  return SEND_3C_FACTS ? factsOf3c(jobId) : undefined;
}

export function forgetFacts3c(jobId: string): void {
  facts.delete(jobId);
}

export function __resetFacts3c(): void {
  facts.clear();
}
