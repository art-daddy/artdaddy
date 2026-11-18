// HELD OFF ON PURPOSE, NOT DELETED (owner decision 2026-11-18): part of the held export-time guess machinery (flags
// `estimate_v2` and `pc_check`, both in OFF_IN_THIS_BUILD). Kept for a later release, so do not remove it as unused.
// The full note is in src/api/exportFlags.ts.
//
// The honest estimate at the admission door, and what the exporter learns when the run ends. The queue calls three things: `withHonestTime` where it already reads its one estimate (0.27.0's
// numbers with the honest time laid over them), `admitted3c` once the export is admitted (the local record of what was said, and what the pace log will be taught against), and `learnFromRun3c` once the run
// has ended. Every one of them fails soft: an estimate or a lesson that cannot be made is simply not made, and the export is never told.
import { admissionEstimateHere, estimateDepsNow } from "./estimateDeps";
import { forgetFacts3c, noteFact3c } from "./exportFacts3c";
import { EXPORT_SPEED_REVISION, type ExportEstimates } from "./exportOptions";
import type { PcClass } from "./exportTypes3c";
import { flags3cNow } from "./flags3c";
import { recordPace } from "./paceLog";
import { pcCheckService } from "./pcCheckHandle";
import type { AdmissionEstimate, AdmissionInput } from "./routeEstimates";

/** What the queue knows about how an export's estimate was made, for the record and for the lesson at the end. */
export interface Admission3c {
  /** The new estimate was on when the export was admitted. The decision is made once, here: a switch flipped mid-run changes nothing for this export. */
  v2: boolean;
  /** The estimate as the plan fixed it, or null when it could not be made. */
  honest: AdmissionEstimate | null;
}

export const NOT_ADMITTED_3C: Admission3c = Object.freeze({ v2: false, honest: null });

/** 0.27.0's estimate with the honest time laid over it. Sizes, memory and the disk stay 0.27.0's (they come from earlier exports and the new model does not claim them); the time is the honest
 *  central value, its low end rides along for the hard warning, and the figure is "a guess" unless earlier exports of this shape measured it. With the new estimate off it is `legacy` untouched; with
 *  it on and no honest time, it is no time at all (`time_unknown`), never a number the new model did not stand behind. */
export function withHonestTime(
  legacy: ExportEstimates,
  input: AdmissionInput,
): { estimates: ExportEstimates; read: Admission3c } {
  const v2 = flags3cNow().estimate_v2;
  if (!v2) return { estimates: legacy, read: NOT_ADMITTED_3C };
  const honest = admissionEstimateHere(input);
  if (!honest)
    return {
      estimates: {
        memoryBytes: legacy.memoryBytes,
        temporaryBytes: legacy.temporaryBytes,
        finalBytes: legacy.finalBytes,
        seconds: null,
      },
      read: { v2, honest: null },
    };
  const { seconds, low, basis } = honest.estimate;
  return {
    estimates: {
      memoryBytes: legacy.memoryBytes,
      temporaryBytes: legacy.temporaryBytes,
      finalBytes: legacy.finalBytes,
      seconds,
      secondsLow: low,
      ...(basis === "history" ? {} : { secondsGuessed: true }),
    },
    read: { v2, honest },
  };
}

const speedClassNow = (): PcClass => {
  try {
    return flags3cNow().pc_check ? (pcCheckService()?.pcClass() ?? "unknown") : "unknown";
  } catch {
    return "unknown";
  }
};

interface Pending {
  family: "processor" | "chip";
  /** The model's own figure for the whole export, without anything learned, kept from the admission. */
  predictedTotalSeconds: number | null;
  /** The figure the person was shown was a measurement of earlier exports: a ratio to it would count this PC twice. */
  measured: boolean;
  lastTickMs: number | null;
  slept: boolean;
}

const pending = new Map<string, Pending>();
const MAX_PENDING = 200;
/** The queue's watch ticks every few seconds; a gap this long between two means the PC was asleep (the watch's own rule). */
const SLEEP_GAP_MS = 30_000;

/** The export has been admitted: say locally what was said about its time (three of the six new facts; nothing is sent), and keep what the pace log will be taught against. */
export function admitted3c(jobId: string, read: Admission3c): void {
  try {
    if (!read.v2) return;
    const { honest } = read;
    noteFact3c(jobId, {
      estimate_s: honest ? honest.estimate.seconds : null,
      estimate_basis: honest ? honest.estimate.basis : null,
      speed_class: honest ? honest.pcClass : speedClassNow(),
    });
    if (!honest) return;
    pending.set(jobId, {
      family: honest.family,
      predictedTotalSeconds: honest.uncorrected ? honest.uncorrected.seconds : null,
      measured: honest.estimate.basis === "history",
      lastTickMs: null,
      slept: false,
    });
    while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value as string);
  } catch {
    // What is said about an export is never worth disturbing it.
  }
}

/** One tick of the queue's watch on a running export: a gap far longer than the watch's rhythm means the PC slept, and the run's time is then not the export's. */
export function noteWatchTick3c(jobId: string): void {
  try {
    const entry = pending.get(jobId);
    if (!entry) return;
    const now = Date.now();
    if (entry.lastTickMs !== null && now - entry.lastTickMs > SLEEP_GAP_MS) entry.slept = true;
    entry.lastTickMs = now;
  } catch {
    // A missed tick teaches at worst one lesson more.
  }
}

export interface RunEnd3c {
  jobId: string;
  ended: "done" | "failed" | "cancelled";
  /** The app stopped the run because it stood still with its processors idle: a hang, which teaches nothing. */
  hung: boolean;
  /** How much of the project had been made, 0 to 1 (1 for a finished run). */
  produced: number;
  /** The render is made in steps (the parts, then the final encode): its bar covers only part of the time, so a run that stopped part-way says nothing of how long the whole takes. */
  stepped: boolean;
  runSeconds: number;
  /** It was cancelled before it had made a picture. */
  beforeFirstPicture: boolean;
}

/** Teach the pace log what the run showed, under the rules of what a run may teach (the log refuses a hung run, a cancel before the first picture, a run a sleep crossed, a short run and one that made too little).
 *  Nothing is learned once the new estimate is switched off, though the run was admitted with it on, and nothing from a stepped run that did not finish. Never throws. */
export function learnFromRun3c(end: RunEnd3c): void {
  try {
    const entry = pending.get(end.jobId);
    pending.delete(end.jobId);
    if (!entry || entry.measured || entry.predictedTotalSeconds === null) return;
    if (!flags3cNow().estimate_v2) return;
    if (end.stepped && end.ended !== "done") return;
    recordPace(estimateDepsNow().storage(), {
      family: entry.family,
      runSeconds: end.runSeconds,
      producedFraction: end.produced,
      predictedTotalSeconds: entry.predictedTotalSeconds,
      outcome: end.hung ? "stopped_idle" : end.ended,
      cancelledBeforeFirstPicture: end.beforeFirstPicture,
      crossedBySleep: entry.slept,
      speedRevision: EXPORT_SPEED_REVISION,
      build: __ARTDADDY_RELEASE__,
      atMs: Date.now(),
    });
  } catch {
    // The estimate simply does not learn this time.
  }
}

/** The export's row is gone: what was said about its time, locally, goes with it, and nothing is learned from it any more. */
export function forgetAdmission3c(jobId: string): void {
  pending.delete(jobId);
  forgetFacts3c(jobId);
}

export function __resetAdmission3c(): void {
  pending.clear();
}
