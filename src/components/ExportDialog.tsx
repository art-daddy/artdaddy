// The export dialog: choose the delivery settings, then watch the render.
//
// Non-blocking by design (Premiere's Media Encoder, not a modal): dismissing it leaves the render
// running and the menu bar keeps a live percentage, so a long export does not hold the editor
// hostage. Re-opening rejoins the job already in progress rather than starting a second one.
import { useEffect, useState } from "react";

import { formatEta } from "../timeline/ffmpegProgress";
import type { ExportQuality, ExportResolution } from "../timeline/exportOptions";
import { useExportJob } from "../store/exportJob";
import ExportQueuePane from "./ExportQueuePane";
import { cn } from "./ui";

export interface ExportSettings {
  resolution: ExportResolution;
  quality: ExportQuality;
  fps: number | null;
}

const RESOLUTIONS: { value: ExportResolution; label: string }[] = [
  { value: "source", label: "Same as project" },
  { value: "2160p", label: "2160p (4K)" },
  { value: "1440p", label: "1440p" },
  { value: "1080p", label: "1080p" },
  { value: "720p", label: "720p" },
  { value: "480p", label: "480p" },
];

const QUALITIES: { value: ExportQuality; label: string; hint: string }[] = [
  { value: "high", label: "High", hint: "Near-lossless, large file" },
  { value: "medium", label: "Medium", hint: "The usual delivery trade-off" },
  { value: "low", label: "Low", hint: "Small file, visible compression" },
];

const FPS_CHOICES = [null, 24, 25, 30, 50, 60];

export default function ExportDialog({
  open,
  onCancel,
  onStart,
}: {
  open: boolean;
  onCancel: () => void;
  onStart: (s: ExportSettings) => void;
}): JSX.Element | null {
  const [resolution, setResolution] = useState<ExportResolution>("source");
  const [quality, setQuality] = useState<ExportQuality>("medium");
  const [fps, setFps] = useState<number | null>(null);

  const phase = useExportJob((s) => s.phase);
  const fraction = useExportJob((s) => s.fraction);
  const etaSec = useExportJob((s) => s.etaSec);
  const speed = useExportJob((s) => s.speed);
  const savedTo = useExportJob((s) => s.savedTo);
  const error = useExportJob((s) => s.error);
  const abort = useExportJob((s) => s.abort);
  const reset = useExportJob((s) => s.reset);

  // Re-opening after a finished render offers the settings again rather than last time's
  // result. Hiding the dialog mid-render and coming back still rejoins the running job.
  useEffect(() => {
    if (!open) return;
    const p = useExportJob.getState().phase;
    if (p === "done" || p === "failed" || p === "cancelled") reset();
  }, [open, reset]);

  // Escape dismisses, and only dismisses. It maps to the same door as Hide/Cancel/Close, so a
  // stray keypress during a render hides the dialog instead of killing the render.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      const p = useExportJob.getState().phase;
      if (p === "done" || p === "failed" || p === "cancelled") reset();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onCancel, reset]);

  if (!open) return null;
  const running = phase === "preparing" || phase === "rendering";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-6">
      <div
        role="dialog"
        aria-modal="false"
        aria-label="export video"
        className="w-[560px] max-w-[92vw] rounded-lg border border-edge bg-panel p-4 text-neutral-100 shadow-2xl"
      >
        <h2 className="text-sm font-semibold tracking-tight">Export video</h2>

        {running || phase === "done" || phase === "failed" || phase === "cancelled" ? (
          <Progress
            phase={phase}
            fraction={fraction}
            etaSec={etaSec}
            speed={speed}
            savedTo={savedTo}
            error={error}
          />
        ) : (
          <div className="mt-3 space-y-3">
            <Field label="Resolution">
              <select
                aria-label="resolution"
                value={resolution}
                onChange={(e) => setResolution(e.target.value as ExportResolution)}
                className={selectCls}
              >
                {RESOLUTIONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Quality">
              <select
                aria-label="quality"
                value={quality}
                onChange={(e) => setQuality(e.target.value as ExportQuality)}
                className={selectCls}
              >
                {QUALITIES.map((q) => (
                  <option key={q.value} value={q.value}>
                    {q.label} — {q.hint}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Frame rate">
              <select
                aria-label="frame rate"
                value={fps === null ? "" : String(fps)}
                onChange={(e) => setFps(e.target.value === "" ? null : Number(e.target.value))}
                className={selectCls}
              >
                {FPS_CHOICES.map((f) => (
                  <option key={String(f)} value={f === null ? "" : String(f)}>
                    {f === null ? "Same as project" : `${f} fps`}
                  </option>
                ))}
              </select>
            </Field>
            <p className="text-[11px] leading-snug text-neutral-500">
              Never upscales: a preset larger than the project is left at the project&apos;s own
              size.
            </p>
          </div>
        )}

        <ExportQueuePane />

        <div className="mt-5 flex justify-end gap-2">
          {running ? (
            <>
              <button type="button" onClick={onCancel} className={ghostCls}>
                Hide
              </button>
              <button
                type="button"
                onClick={() => abort?.()}
                disabled={!abort}
                className="rounded-md px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/10 disabled:opacity-40"
              >
                Cancel render
              </button>
            </>
          ) : phase === "done" || phase === "failed" || phase === "cancelled" ? (
            <button
              type="button"
              onClick={() => {
                reset();
                onCancel();
              }}
              className={primaryCls}
            >
              Close
            </button>
          ) : (
            <>
              <button type="button" onClick={onCancel} className={ghostCls}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => onStart({ resolution, quality, fps })}
                className={primaryCls}
              >
                Export
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Progress({
  phase,
  fraction,
  etaSec,
  speed,
  savedTo,
  error,
}: {
  phase: string;
  fraction: number | null;
  etaSec: number | null;
  speed: number;
  savedTo: string | null;
  error: string | null;
}): JSX.Element {
  const done = phase === "done";
  const pct = done ? 1 : (fraction ?? 0);
  const eta = formatEta(etaSec);
  return (
    <div className="mt-3">
      <div
        role="progressbar"
        aria-label="export progress"
        aria-valuemin={0}
        aria-valuemax={100}
        // Indeterminate until ffmpeg reports a position: an aria value of 0 would claim
        // "nothing has happened", which is a different statement from "not known yet".
        aria-valuenow={fraction === null && !done ? undefined : Math.round(pct * 100)}
        className="h-1.5 w-full overflow-hidden rounded bg-neutral-800"
      >
        <div
          className={cn(
            "h-full transition-[width] duration-200",
            phase === "failed" ? "bg-red-500" : done ? "bg-emerald-500" : "bg-accent",
            fraction === null && !done && "animate-pulse",
          )}
          style={{ width: `${Math.round((fraction === null && !done ? 0.06 : pct) * 100)}%` }}
        />
      </div>
      <div className="mt-2 flex items-baseline justify-between text-[11px] text-neutral-400">
        <span data-testid="export-status">
          {phase === "preparing" && "Preparing…"}
          {phase === "rendering" && (fraction === null ? "Starting…" : `${Math.round(pct * 100)}%`)}
          {done && "Done"}
          {phase === "failed" && "Failed"}
          {phase === "cancelled" && "Cancelled"}
        </span>
        <span className="tabular-nums">
          {phase === "rendering" && speed > 0 && `${speed.toFixed(1)}× · `}
          {phase === "rendering" && eta && `${eta} left`}
        </span>
      </div>
      {savedTo && (
        <p className="mt-2 break-all text-xs text-neutral-300">
          {/* The user picks the folder on desktop, so name it. Only the web build (no save
              dialog) gets a bare filename back, and only that build still means Downloads. */}
          {/[\\/]/.test(savedTo) ? `Saved to ${savedTo}` : `Saved ${savedTo} to Downloads.`}
        </p>
      )}
      {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="flex items-center gap-3 text-xs text-neutral-400">
      <span className="w-20 shrink-0">{label}</span>
      {children}
    </label>
  );
}

const selectCls =
  "flex-1 rounded border border-edge bg-neutral-800 px-2 py-1 text-xs text-neutral-100 outline-none";
const ghostCls = "rounded-md px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800";
const primaryCls =
  "rounded-md bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white";
