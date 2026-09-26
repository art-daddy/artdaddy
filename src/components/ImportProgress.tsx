// Non-modal import progress, bottom-left above the status bar.
//
// Premiere reports ingest in its status area and other NLEs uses a media-panel toast; neither
// blocks the editor. A 1.75 GB file takes ~55s to hash, and silence for that long reads as a
// hang even when the window is perfectly responsive.
//
// The speech model shares this area: it is a 465 MiB download that installs once, and the same
// silence cost us a user who waited 2m21s on a caption request with nothing on screen.
import { useImportJobs } from "../store/importJobs";
import { modelDownloadMessage, percent, useModelDownload } from "../store/modelDownload";

export default function ImportProgress(): JSX.Element | null {
  const jobs = useImportJobs((s) => s.jobs);
  const received = useModelDownload((s) => s.received);
  const total = useModelDownload((s) => s.total);
  const modelPct = total > 0 ? percent(received, total) : null;
  if (!jobs.length && modelPct === null) return null;
  return (
    <div
      role="status"
      aria-label={jobs.length ? "importing media" : "downloading speech model"}
      className="pointer-events-none fixed bottom-4 left-4 z-[70] w-72 space-y-2"
    >
      {modelPct !== null && (
        <div
          data-testid="model-download"
          data-pct={String(modelPct)}
          className="rounded-md border border-edge bg-panel/95 px-3 py-2 text-xs text-neutral-200 shadow-xl"
        >
          <div className="leading-snug">{modelDownloadMessage(received, total)}</div>
          <div className="mt-1.5 h-1 overflow-hidden rounded bg-neutral-800">
            <div
              className="h-full rounded bg-accent transition-[width] duration-200"
              style={{ width: `${modelPct}%` }}
            />
          </div>
        </div>
      )}
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
