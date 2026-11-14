// What the speech planner decided, kept in memory for the last few starts (S2-07's tokens, but LOCAL: the app
// sends none of this, T1-10 = C). The indexer's admission, the boundary every whole-file start passes and
// the running-job monitor write here; tests and a later disclosure read it. Nothing shows it to the person.
import type { PlanWhy } from "./speechPlan";
import type { SpeechBackend } from "./speechPace";

/** How many decisions are kept: enough to read back a session's starts, never a growing list. */
export const PLAN_LOG_KEEP = 50;

export interface PlanRecord {
  /** Epoch ms. */
  at: number;
  /** What the person calls the file (its name), as the chip does; shown nowhere else. */
  file: string;
  /** `whole`: the run was allowed (or kept going). `ondemand`: it was not started by itself, or was
   *  stopped once it ran, and the parts a request uses are transcribed when asked for. */
  plan: "whole" | "ondemand";
  why: PlanWhy;
  /** About how long the whole file takes on the backend that would run it; null when its length is not known. */
  projectedS: number | null;
  backend: SpeechBackend;
  /** The chip was being kept off after a crash. */
  held: boolean;
  /** Who decided: the indexer's queue, the boundary of `runWhisper`, or the running job's live check. */
  where: "indexer" | "boundary" | "live";
}

const records: PlanRecord[] = [];

/** Keep one decision. Never throws, and never grows beyond {@link PLAN_LOG_KEEP}. */
export function recordPlan(record: PlanRecord): void {
  records.push({ ...record });
  if (records.length > PLAN_LOG_KEEP) records.splice(0, records.length - PLAN_LOG_KEEP);
}

/** The decisions kept, oldest first (a copy). */
export function recentPlans(): PlanRecord[] {
  return records.map((r) => ({ ...r }));
}

/** Tests only. */
export function __resetPlanLog(): void {
  records.length = 0;
}
