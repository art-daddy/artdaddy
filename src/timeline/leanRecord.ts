// What the lean render paths did in ONE export (Phase 3a: the render-cost fixes). A plan's local record, read by the export report
// (the report builder maps `ran` to `lean_ran` and `kept` to `lean_kept`; both are closed lists of DISTINCT words, in the order of
// the lists below: no counts, no per-clip words, nothing about the project's content).
//
//   ran   which of the six speed-ups changed at least one clip's recipe in this export
//   kept  why a clip stayed on the recipe 0.27.0 uses
//         see_through     the picture has see-through areas (alpha), which the exact mask would drop
//         unknown_source  its size or pixel format could not be read, so nothing was proven about it
//         over_budget     the zoom was too long or complicated for the safe limit (graph size)
//         not_proven      a shape the lab has not proven (a wipe-right clip that zooms, rotates or moves, a picture too big for
//                         the decoder cap, a grade with a frame-dependent effect, ...)
//         flag_off        switched off from our server
//         error           the speed-up code declined (it never throws: it keeps today's recipe)
export const LEAN_FIXES = ["zoom", "fades", "dip", "stills", "grade", "decoders"] as const;
export type LeanFix = (typeof LEAN_FIXES)[number];

export const LEAN_KEPT_REASONS = [
  "see_through",
  "unknown_source",
  "over_budget",
  "not_proven",
  "flag_off",
  "error",
] as const;
export type LeanKeptReason = (typeof LEAN_KEPT_REASONS)[number];

/** The plan's record: two lists of distinct closed-list words (the type the report builder reads). */
export interface LeanRecord {
  ran: LeanFix[];
  kept: LeanKeptReason[];
}

/** What a builder collects while it decides, clip by clip. Counts stay HERE (the proof harness may read them);
 *  the plan carries only the two lists. */
export class LeanTally {
  private readonly ranBy = new Map<LeanFix, number>();
  private readonly keptBy = new Map<LeanKeptReason, number>();

  ran(fix: LeanFix): void {
    this.ranBy.set(fix, (this.ranBy.get(fix) ?? 0) + 1);
  }

  kept(reason: LeanKeptReason): void {
    this.keptBy.set(reason, (this.keptBy.get(reason) ?? 0) + 1);
  }

  /** Per-fix and per-reason counts for tests and the proof harness; not part of the plan. */
  counts(): { ran: Record<string, number>; kept: Record<string, number> } {
    return {
      ran: Object.fromEntries(this.ranBy),
      kept: Object.fromEntries(this.keptBy),
    };
  }

  record(): LeanRecord {
    return {
      ran: LEAN_FIXES.filter((fix) => this.ranBy.has(fix)),
      kept: LEAN_KEPT_REASONS.filter((reason) => this.keptBy.has(reason)),
    };
  }
}

/** The union of several records (the parts of a streamed export, or its pieces), still distinct and in list order. */
export function mergeLeanRecords(records: ReadonlyArray<LeanRecord | undefined>): LeanRecord {
  const ran = new Set<LeanFix>();
  const kept = new Set<LeanKeptReason>();
  for (const record of records) {
    if (!record) continue;
    for (const fix of record.ran) ran.add(fix);
    for (const reason of record.kept) kept.add(reason);
  }
  return {
    ran: LEAN_FIXES.filter((fix) => ran.has(fix)),
    kept: LEAN_KEPT_REASONS.filter((reason) => kept.has(reason)),
  };
}
