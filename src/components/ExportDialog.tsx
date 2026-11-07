// The export dialog: choose the delivery settings, then watch the render.
//
// Non-blocking by design (Premiere's Media Encoder, not a modal): dismissing it leaves the render
// running and the menu bar keeps a live percentage, so a long export does not hold the editor
// hostage. Re-opening rejoins the job already in progress rather than starting a second one.
import { useEffect, useMemo, useReducer, useState, useSyncExternalStore } from "react";

import { formatEta } from "../timeline/ffmpegProgress";
import { decideExportEncoder, type ExportEncoderDecision } from "../timeline/exportChoice";
import {
  estimateForDialog,
  type ExportMode,
  type ExportQuality,
  type ExportResolution,
} from "../timeline/exportOptions";
import { listExportRecords, subscribeExports } from "../timeline/exportQueue";
import {
  describeDialogProgress,
  describeExpected,
  describeModeLines,
  STATUS_REFRESH_MS,
  type ModeView,
} from "../timeline/exportWords";
import type { RenderWorkload } from "../timeline/renderPlan";
import { liveFeedOf, useExportJob, type ExportPhase } from "../store/exportJob";
import ExportProgressBar from "./ExportProgressBar";
import ExportQueuePane from "./ExportQueuePane";

export interface ExportSettings {
  resolution: ExportResolution;
  quality: ExportQuality;
  fps: number | null;
  /** What the person picked in the Mode row, or null when they did not: the app then decides, as it does for every
   *  other way an export starts (exportChoice.ts). */
  mode: ExportMode | null;
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
  workload = null,
}: {
  open: boolean;
  onCancel: () => void;
  onStart: (s: ExportSettings) => void;
  /** The open project's size and layers, to say roughly how long the export will take and how big
   *  the file will be before the person clicks. Absent: the dialog says nothing about either. */
  workload?: RenderWorkload | null;
}): JSX.Element | null {
  const [resolution, setResolution] = useState<ExportResolution>("source");
  const [quality, setQuality] = useState<ExportQuality>("medium");
  const [fps, setFps] = useState<number | null>(null);
  // What the person picked in the Mode row; null until they touch it (the app's own choice shows then).
  const [picked, setPicked] = useState<ExportMode | null>(null);
  // What the app decided about the encoder (exportChoice.ts): whether the Mode row is shown and what it starts on. Kept with
  // what it was decided for (the settings, and the history of this PC's exports, which the estimates and so the choice are made
  // from), so the dialog knows whether the answer it has is for what is on screen: an answer to a question the settings or
  // the history have since changed is not to be sent on, and one that has not come yet, or never will (the look failed), is
  // not mistaken for "no row".
  const askedFor = `${resolution}|${quality}|${fps ?? ""}|${workload ? JSON.stringify(workload) : ""}`;
  const calibrations = useExportJob((s) => s.calibrations);
  const [answer, setAnswer] = useState<{
    readonly for: string;
    readonly history: typeof calibrations;
    readonly decision: ExportEncoderDecision | null;
  } | null>(null);
  const decision = answer?.decision ?? null;
  const answered = answer !== null && answer.for === askedFor && answer.history === calibrations;

  const view: ModeView | null = decision
    ? {
        showRow: decision.showRow,
        defaultMode: decision.defaultMode,
        reason: decision.reason,
        faster: decision.faster === true,
        fullSeconds: decision.fullSeconds,
        fastSeconds: decision.fastSeconds,
      }
    : null;
  const lines = describeModeLines(view, picked);
  const mode = lines.selected;

  // Read-only information: what this PC has measured for settings like these, else a rough guess. For the way that is
  // selected: Fast is the chip's estimate, Full the processor's (with its faster setting where the app will use it).
  const expected = useMemo(() => {
    if (!workload) return "";
    const route =
      mode === "fast" ? { chip: decision?.facts.chip } : { faster: decision?.faster === true };
    return describeExpected(
      estimateForDialog(workload, { resolution, quality, fps, mode }, calibrations, route),
    );
  }, [workload, resolution, quality, fps, mode, calibrations, decision]);

  const phase = useExportJob((s) => s.phase);
  const jobId = useExportJob((s) => s.jobId);
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

  // The app is asked as the dialog opens and whenever the settings change (a chip's test, if it has not been done on this
  // PC yet, runs now, in the seconds the person spends choosing). A look: the test's results are left for the export.
  useEffect(() => {
    if (!open || phase !== "idle" || !workload) {
      setAnswer(null);
      return;
    }
    let stale = false;
    void decideExportEncoder({
      request: "auto",
      workload,
      settings: { resolution, quality, fps },
      history: calibrations,
      preview: true,
      waitMs: Infinity,
    })
      .then((decided) => {
        if (!stale) setAnswer({ for: askedFor, history: calibrations, decision: decided });
      })
      .catch(() => {
        if (!stale) setAnswer({ for: askedFor, history: calibrations, decision: null });
      });
    return () => {
      stale = true;
    };
  }, [open, phase, workload, resolution, quality, fps, calibrations, askedFor]);

  // A pick is for one opening of the dialog.
  useEffect(() => {
    if (open && phase === "idle") setPicked(null);
  }, [open, phase]);

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
            jobId={jobId}
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
            {decision?.showRow && (
              <div className="text-xs text-neutral-400">
                <div className="flex items-center gap-3">
                  <span className="w-20 shrink-0">Mode</span>
                  <div
                    role="radiogroup"
                    aria-label="export mode"
                    className="flex min-h-9 min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 text-sm"
                  >
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="radio"
                        name="export-mode"
                        value="quality"
                        checked={mode === "quality"}
                        onChange={() => setPicked("quality")}
                        className="accent-accent"
                      />
                      Full quality
                    </label>
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="radio"
                        name="export-mode"
                        value="fast"
                        checked={mode === "fast"}
                        onChange={() => setPicked("fast")}
                        className="accent-accent"
                      />
                      Fast
                    </label>
                  </div>
                </div>
                {lines.hint && <p className="mt-0.5 pl-[5.75rem] leading-snug">{lines.hint}</p>}
              </div>
            )}
            {lines.note && <p className="text-xs leading-snug text-amber-300">{lines.note}</p>}
            {expected && (
              <p aria-label="export estimate" className="text-xs leading-snug text-neutral-300">
                {expected}
              </p>
            )}
            {lines.alternative && (
              <p className="text-xs leading-snug text-neutral-400">{lines.alternative}</p>
            )}
            {lines.faster && (
              <p className="text-xs leading-snug text-neutral-400">{lines.faster}</p>
            )}
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
                onClick={() =>
                  onStart({
                    resolution,
                    quality,
                    fps,
                    // What the person chose, never more. Only an answer that is in, for exactly what is on screen, is
                    // one the person has seen: then the row's pick if the row is shown, else nothing (the app decides,
                    // and said so under the settings). Without one (no project to ask about, the look failed, it has
                    // not come back, or the history changed under it) the person has been offered nothing, so the app
                    // does not choose for them: Full quality, or what they had picked.
                    mode:
                      workload && answered && decision
                        ? decision.showRow
                          ? picked
                          : null
                        : (picked ?? "quality"),
                  })
                }
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
  jobId,
  fraction,
  etaSec,
  speed,
  savedTo,
  error,
}: {
  phase: ExportPhase;
  /** The export this job follows, once the queue has given it an id. */
  jobId: string | null;
  fraction: number | null;
  etaSec: number | null;
  speed: number;
  savedTo: string | null;
  error: string | null;
}): JSX.Element {
  const done = phase === "done";
  // Where the export is comes from ITS OWN feed, as the chat card reads it: the job above is moved by whichever
  // export is rendering, so an export waiting behind another would say that one's percent. Before the export has an
  // id the job is all there is.
  const live = useExportJob((s) => s.live);
  const finishing = useExportJob((s) => s.finishing);
  const rows = useSyncExternalStore(subscribeExports, listExportRecords, listExportRecords);
  const running = phase === "preparing" || phase === "rendering";
  // A clock, not the progress feed: a stage that drags on (checking a long file) reports nothing at all, and that is
  // exactly when the line has to keep changing.
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(redraw, STATUS_REFRESH_MS);
    return () => clearInterval(id);
  }, [running]);

  const own = running && jobId ? liveFeedOf({ live, finishing }, jobId) : null;
  // Its place in line, while it waits for its turn (the same line the chat card counts).
  const place =
    running && jobId && own === null
      ? rows
          .filter((r) => r.state === "queued" && !r.cancelling)
          .findIndex((r) => r.job_id === jobId) + 1
      : 0;
  const shown =
    phase === "preparing" || phase === "rendering"
      ? describeDialogProgress(
          { own, place: place > 0 ? place : null, phase, fraction, etaSec, speed },
          Date.now(),
        )
      : null;
  const pace = shown
    ? [
        shown.speed === null ? "" : `${shown.speed.toFixed(1)}×`,
        shown.left === null ? "" : `${formatEta(shown.left)} left`,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  return (
    <div className="mt-3">
      <ExportProgressBar
        fraction={shown ? shown.fraction : fraction}
        state={phase === "failed" ? "failed" : done ? "done" : "running"}
      />
      <div className="mt-2 flex items-baseline justify-between gap-3 text-[11px] text-neutral-400">
        <span data-testid="export-status" className="min-w-0">
          {shown
            ? shown.status
            : done
              ? "Done"
              : phase === "failed"
                ? "Failed"
                : phase === "cancelled"
                  ? "Cancelled"
                  : ""}
        </span>
        <span data-testid="export-pace" className="shrink-0 tabular-nums">
          {pace}
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
  "min-w-0 flex-1 truncate rounded border border-edge bg-neutral-800 px-2 py-1 text-xs text-neutral-100 outline-none";
const ghostCls = "rounded-md px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800";
const primaryCls =
  "rounded-md bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white";
