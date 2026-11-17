// The slow-export banner for one export, joined to the exporter's watch: it reads that export's banner state, answers Keep going through the queue (which refuses a click that comes after the render is over), and is not
// drawn for an export that is being cancelled. The chat card and the Export dialog each mount one and read the same state, so answering in either closes both.
import { useSyncExternalStore } from "react";

import { attempts } from "../timeline/exportAttempts";
import { helpOf3c, subscribeHelp3c } from "../timeline/exportHelpWatch";
import { keepExportGoing } from "../timeline/exportKeepGoing";
import { listExportRecords, subscribeExports } from "../timeline/exportQueue";
import SlowBanner from "./SlowBanner";

export default function ExportHelpBanner({
  jobId,
  onCancel,
  onSwitchToQuick,
}: {
  /** Any attempt's id of the export. */
  jobId: string;
  onCancel: () => void;
  /** Starts the export again as a Quick export; given only where Quick exists. */
  onSwitchToQuick?: (jobId: string) => void;
}): JSX.Element | null {
  const id = attempts.current(jobId);
  const state = useSyncExternalStore(
    subscribeHelp3c,
    () => helpOf3c(id),
    () => null,
  );
  const rows = useSyncExternalStore(subscribeExports, listExportRecords, listExportRecords);
  if (!state || rows.find((row) => row.job_id === id)?.cancelling) return null;
  const kind = state.view.kind === "quiet" ? "quiet" : "slow";
  return (
    <SlowBanner
      key={state.view.kind}
      view={state.view}
      keptGoing={state.keptGoing}
      mayWarnAgain={state.mayWarnAgain}
      onKeepGoing={() => keepExportGoing(jobId, kind)}
      onCancel={onCancel}
      onSwitchToQuick={onSwitchToQuick ? () => onSwitchToQuick(id) : undefined}
    />
  );
}
