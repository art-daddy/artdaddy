// HELD OFF ON PURPOSE, NOT DELETED (owner decision 2026-11-18): part of the held export-time guess machinery (flags
// `estimate_v2` and `pc_check`, both in OFF_IN_THIS_BUILD). Kept for a later release, so do not remove it as unused.
// The full note is in src/api/exportFlags.ts.
//
// The seam between the speed check's stored answer and the estimator's idea of this PC's pace. A finished check is this PC's measured pace; one that could not finish
// is a weak PC on a rough guess (nothing was measured); no result, a damaged one or a check that is off is no pace, and the estimator then prices the prior PC.
// The class cut-offs are an argument, always the pair the flags reader holds right now: this module keeps no copy of them.
import { WEAK_PRIOR_PACE } from "./costTable";
import type { PcPace } from "./estimator";
import { checkedRecord, classOf, type Cutoffs, type PcCheckRecord } from "./pcClass";

/** The estimator's pace for a stored speed check, or null when there is none to give. Never throws. */
export function paceOfCheck(
  result: PcCheckRecord | null | undefined,
  cutoffs: Cutoffs | null | undefined,
  cores: number,
): PcPace | null {
  try {
    // A record is believed only if this app could have written it, whoever handed it over.
    const record = checkedRecord(result);
    if (!record) return null;
    const machine =
      typeof cores === "number" && Number.isFinite(cores) && cores >= 1
        ? Math.floor(cores)
        : record.cores;
    if (record.outcome === "unfinished")
      return {
        rHat: WEAK_PRIOR_PACE.rHat,
        aFps: null,
        bFps: null,
        cFps: null,
        cores: machine,
        cls: "unfinished",
      };
    const { rHat } = record;
    if (rHat === null || !(rHat > 0)) return null;
    return {
      rHat,
      aFps: record.aFps,
      bFps: record.bFps,
      cFps: record.cFps,
      cores: machine,
      cls: classOf(rHat, cutoffs ?? undefined),
    };
  } catch {
    return null;
  }
}
