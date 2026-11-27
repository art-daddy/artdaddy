// How a run reads in a report, and the form a known failure's backlog reference takes.
import type { RunStatus, ScenarioResult } from "./types";

/** A backlog reference as a known failure must carry it: "owner/repo#number". */
export const KNOWN_FAILURE_REF = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/;

/** A case marked as a known failure is not a regression while it fails, and is "fixed" on the
 *  first run where it passes (then the mark is removed). */
export function runStatus(
  r: Pick<ScenarioResult, "passed" | "knownFailure" | "skipped" | "harnessError">,
): RunStatus {
  if (r.skipped) return "skipped";
  if (r.harnessError) return "harness_error";
  if (r.knownFailure) return r.passed ? "fixed" : "known_failure";
  return r.passed ? "pass" : "fail";
}
