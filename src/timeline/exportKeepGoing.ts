// The person's Keep going on the slow banner (the card's and the Export dialog's). The state of the export is read here, at the click: once its render is over (it is being checked or saved, or it has ended) there is
// nothing to keep going and the click is refused with a line, leaving no state behind. The id given is any attempt's of the export.
import { liveFeedOf, useExportJob } from "../store/exportJob";
import { attempts } from "./exportAttempts";
import {
  keepGoing3c,
  type KeepGoingKind,
  type KeepGoingResult,
  type RunPhase,
} from "./exportHelpWatch";
import { listExportRecords } from "./exportQueue";

export function keepExportGoing(jobId: string, kind: KeepGoingKind): KeepGoingResult {
  const id = attempts.current(jobId);
  const stage = liveFeedOf(useExportJob.getState(), id)?.stage;
  const phase: RunPhase =
    listExportRecords().find((r) => r.job_id === id)?.state !== "running"
      ? "ended"
      : stage === "preparing" || stage === "rendering"
        ? "rendering"
        : "finishing";
  return keepGoing3c(id, kind, phase);
}
