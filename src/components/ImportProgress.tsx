// Non-modal import progress, bottom-left above the status bar.
//
// Premiere reports ingest in its status area and other NLEs uses a media-panel toast; neither
// blocks the editor. A 1.75 GB file takes ~55s to hash, and silence for that long reads as a
// hang even when the window is perfectly responsive.
//
// The speech model shares this area: it is a 465 MiB download that installs once, and the same
// silence cost us a user who waited 2m21s on a caption request with nothing on screen. It says
// what it is, how far it is and how long is left, that it only happens once, and it can be stopped.
import { useImportJobs } from "../store/importJobs";
import {
  downloadEtaSeconds,
  modelDownloadMessage,
  modelDownloadNote,
  percent,
  setModelDownloadFailure,
  useModelDownload,
} from "../store/modelDownload";
import { MODEL_FAILURE_WORDS } from "../tools/modelFailure";

/** The prefetch is loaded on first use, as the app's start loads it: the card only exists after a download
 *  has failed, by when it is long loaded. */
function retryDownload(): void {
  void import("../tools/modelPrefetch").then((m) => m.retrySpeechModelDownload());
}

export default function ImportProgress(): JSX.Element | null {
  const jobs = useImportJobs((s) => s.jobs);
  const received = useModelDownload((s) => s.received);
  const total = useModelDownload((s) => s.total);
  const startedAt = useModelDownload((s) => s.startedAt);
  const startReceived = useModelDownload((s) => s.startReceived);
  const cancel = useModelDownload((s) => s.cancel);
  const failure = useModelDownload((s) => s.failure);
  const again = useModelDownload((s) => s.again);
  const retryScheduled = useModelDownload((s) => s.nextAttemptAt !== null);
  const modelPct = total > 0 ? percent(received, total) : null;
  // "Downloading" and "failed" are never shown together, whatever the store holds.
  const failed = modelPct === null ? failure : null;
  if (!jobs.length && modelPct === null && failed === null) return null;
  const eta = downloadEtaSeconds({ received, total, startedAt, startReceived });
  return (
    <div
      role="status"
      aria-label={
        jobs.length
          ? "importing media"
          : failed !== null
            ? "speech model download failed"
            : "downloading speech model"
      }
      className="pointer-events-none fixed bottom-4 left-4 z-[70] w-72 space-y-2"
    >
      {failed !== null && (
        <div
          data-testid="model-failure"
          data-reason={failed}
          className="rounded-md border border-edge bg-panel/95 px-3 py-2 text-xs text-neutral-200 shadow-xl"
        >
          <div className="leading-snug">Could not download the speech model.</div>
          <div className="mt-0.5 leading-snug text-neutral-400">{MODEL_FAILURE_WORDS[failed]}</div>
          <div className="mt-0.5 leading-snug text-neutral-400">
            {retryScheduled
              ? "The app will try again by itself."
              : "Speech features wait until the model is downloaded."}
          </div>
          <div className="pointer-events-auto mt-1.5 flex items-baseline gap-3">
            <button
              type="button"
              onClick={retryDownload}
              className="text-neutral-200 underline hover:text-white"
            >
              Retry
            </button>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setModelDownloadFailure(null)}
              className="text-neutral-400 hover:text-neutral-200"
            >
              ×
            </button>
          </div>
        </div>
      )}
      {modelPct !== null && (
        <div
          data-testid="model-download"
          data-pct={String(modelPct)}
          className="rounded-md border border-edge bg-panel/95 px-3 py-2 text-xs text-neutral-200 shadow-xl"
        >
          <div className="leading-snug">{modelDownloadMessage(received, total, eta, again)}</div>
          <div className="mt-0.5 leading-snug text-neutral-400">{modelDownloadNote(again)}</div>
          <div className="mt-1.5 h-1 overflow-hidden rounded bg-neutral-800">
            <div
              className="h-full rounded bg-accent transition-[width] duration-200"
              style={{ width: `${modelPct}%` }}
            />
          </div>
          {cancel && (
            <button
              type="button"
              onClick={cancel}
              className="pointer-events-auto mt-1.5 text-neutral-400 underline hover:text-neutral-200"
            >
              Cancel
            </button>
          )}
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
