// Non-modal import progress, bottom-left above the status bar.
//
// Premiere reports ingest in its status area and other NLEs uses a media-panel toast; neither
// blocks the editor. A 1.75 GB file takes ~55s to hash, and silence for that long reads as a
// hang even when the window is perfectly responsive.
import { useImportJobs } from "../store/importJobs";

export default function ImportProgress(): JSX.Element | null {
  const jobs = useImportJobs((s) => s.jobs);
  if (!jobs.length) return null;
  return (
    <div
      role="status"
      aria-label="importing media"
      className="pointer-events-none fixed bottom-4 left-4 z-[70] w-72 space-y-2"
    >
      {jobs.map((j) => (
        <div
          key={j.path}
          className="rounded-md border border-edge bg-panel/95 px-3 py-2 text-xs text-neutral-200 shadow-xl"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate" title={j.path}>
              {j.name}
            </span>
            <span
              data-testid="import-pct"
              data-pct={j.fraction === null ? "" : String(Math.round(j.fraction * 100))}
              className="shrink-0 tabular-nums text-neutral-400"
            >
              {j.phase === "analysing" || j.fraction === null
                ? "analysing…"
                : `${Math.round(j.fraction * 100)}%`}
            </span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded bg-neutral-800">
            <div
              className={
                j.fraction === null
                  ? "h-full w-1/3 animate-pulse rounded bg-accent"
                  : "h-full rounded bg-accent transition-[width] duration-200"
              }
              style={
                j.fraction === null ? undefined : { width: `${Math.round(j.fraction * 100)}%` }
              }
            />
          </div>
        </div>
      ))}
    </div>
  );
}
