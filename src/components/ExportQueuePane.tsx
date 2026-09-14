// The export queue, as a list the user can actually see.
//
// The queue has always been able to hold several exports (submit returns a position, encodes run
// one at a time), but nothing rendered it: the menu-bar badge shows the RUNNING job only, and a
// job vanished from every surface the moment it settled. So a user who queued three exports could
// not tell two were waiting, and one who looked away while an export failed learned nothing at
// all. Mirrors Adobe Media Encoder's queue and other NLEs' export logs: one row per job, terminal
// rows kept until dismissed.
import { useSyncExternalStore } from "react";

import {
  cancelExport,
  clearFinishedExports,
  dismissExport,
  listExportRecords,
  subscribeExports,
  type ExportRecord,
} from "../timeline/exportQueue";
import { useExportJob } from "../store/exportJob";
import { cn } from "./ui";

const LABEL: Record<ExportRecord["state"], string> = {
  queued: "Queued",
  running: "Rendering",
  done: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const DOT: Record<ExportRecord["state"], string> = {
  queued: "bg-neutral-500",
  running: "bg-accent animate-pulse",
  done: "bg-emerald-500",
  failed: "bg-red-500",
  cancelled: "bg-neutral-600",
};

function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function ExportQueuePane(): JSX.Element | null {
  const rows = useSyncExternalStore(subscribeExports, listExportRecords, listExportRecords);
  // Only one export encodes at a time, so the job store's progress belongs to whichever row is
  // running. Reading it per row would imply a per-job number the queue does not produce.
  const fraction = useExportJob((s) => s.fraction);

  if (!rows.length) return null;
  const settled = rows.some((r) => r.state !== "running" && r.state !== "queued");

  return (
    <section className="mt-4 border-t border-edge pt-3" aria-label="export queue">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-neutral-300">
          Export queue
          <span className="ml-1.5 text-[11px] font-normal text-neutral-500">{rows.length}</span>
        </h3>
        {settled && (
          <button
            onClick={clearFinishedExports}
            className="rounded px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800"
          >
            Clear finished
          </button>
        )}
      </div>

      <ul className="mt-2 max-h-48 space-y-px overflow-y-auto">
        {[...rows].reverse().map((r) => (
          <li
            key={r.job_id}
            className="flex items-center gap-2 rounded px-1.5 py-1 text-[11px] hover:bg-neutral-900"
            title={
              r.error
                ? `${r.destPath}\n${r.error}${r.stderrTail ? `\n\n${r.stderrTail}` : ""}`
                : r.destPath
            }
          >
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT[r.state])} aria-hidden />
            <span className="w-10 shrink-0 tabular-nums text-neutral-500">
              {timeOf(r.startedAt)}
            </span>
            <span className="min-w-0 flex-1 truncate text-neutral-200">{r.filename}</span>

            {r.state === "running" && (
              <span className="flex w-24 shrink-0 items-center gap-1.5">
                <span className="h-1 flex-1 overflow-hidden rounded bg-neutral-800">
                  <span
                    className="block h-full bg-accent transition-[width]"
                    style={{ width: `${Math.round((fraction ?? 0) * 100)}%` }}
                  />
                </span>
                <span className="w-8 shrink-0 text-right tabular-nums text-neutral-400">
                  {fraction === null ? "" : `${Math.round(fraction * 100)}%`}
                </span>
              </span>
            )}
            {r.state !== "running" && (
              <span
                className={cn(
                  "w-24 shrink-0 truncate text-right",
                  r.state === "failed" ? "text-red-400" : "text-neutral-500",
                )}
              >
                {r.state === "failed" && r.error ? r.error : LABEL[r.state]}
              </span>
            )}

            {r.state === "running" || r.state === "queued" ? (
              <button
                aria-label={`cancel ${r.filename}`}
                onClick={() => cancelExport(r.job_id)}
                className="shrink-0 rounded px-1 text-neutral-400 hover:bg-neutral-800 hover:text-red-400"
              >
                ✕
              </button>
            ) : (
              <button
                aria-label={`dismiss ${r.filename}`}
                onClick={() => dismissExport(r.job_id)}
                className="shrink-0 rounded px-1 text-neutral-600 hover:bg-neutral-800 hover:text-neutral-300"
              >
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
