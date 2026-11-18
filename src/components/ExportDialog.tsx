// The export dialog: choose the delivery settings, then watch the render.
//
// Non-blocking by design (Premiere's Media Encoder, not a modal): dismissing it leaves the render
// running and the menu bar keeps a live percentage, so a long export does not hold the editor
// hostage. Re-opening rejoins the job already in progress rather than starting a second one.
import { useCallback, useEffect, useMemo, useReducer, useState, useSyncExternalStore } from "react";

import { formatEta } from "../timeline/ffmpegProgress";
import { attempts } from "../timeline/exportAttempts";
import { decideExportEncoder, type ExportEncoderDecision } from "../timeline/exportChoice";
import { dialogEstimate } from "../timeline/dialogEstimate";
import { CHECKING_LINE } from "../timeline/estimateWords";
import { holdExportAsk } from "../timeline/exportAsk";
import { lowerAdvice3c } from "../timeline/exportHelpWatch";
import {
  resolutionChoices,
  usableCanvas,
  type ExportMode,
  type ExportQuality,
  type ExportResolution,
} from "../timeline/exportOptions";
import {
  cancelExport,
  listExportRecords,
  restartWords,
  subscribeExports,
} from "../timeline/exportQueue";
import {
  describeDialogProgress,
  describeFailureHere,
  describeModeLines,
  failureOf,
  STATUS_REFRESH_MS,
  type ModeView,
} from "../timeline/exportWords";
import { flags3cNow } from "../timeline/flags3c";
import type { RenderWorkload } from "../timeline/renderPlan";
import { useEditor } from "../store/editor";
import { liveFeedOf, useExportJob, type ExportPhase } from "../store/exportJob";
import ExportProgressBar from "./ExportProgressBar";
import ExportQueuePane from "./ExportQueuePane";
import ExportHelpBanner from "./ExportHelpBanner";
import SpeedCheckLine from "./SpeedCheckLine";
import { useSpeedCheck } from "./useSpeedCheck";
import ChipRow from "./ChipRow";

export interface ExportSettings {
  resolution: ExportResolution;
  quality: ExportQuality;
  fps: number | null;
  /** What the person picked in the Mode row, or null when they did not: the app then decides, as it does for every
   *  other way an export starts (exportChoice.ts). */
  mode: ExportMode | null;
}

/** The words for every preset, in the order the list shows them. Which of them a project is offered is `resolutionChoices`' to say (exportOptions.ts). */
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

/** What the dialog knows of the Graphics chip row, which the old Mode row gives way to: nothing yet (the row's first look has not answered), drawn, not drawn since the
 *  settings were shown, or drawn and gone since (the person moved to a picture size the chip does not serve). */
type ChipRowSeen = "unknown" | "drawn" | "absent" | "left";

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
  // What the person picked in the Resolution list, which the list may no longer hold: it follows the project's size.
  const [pickedResolution, setPickedResolution] = useState<ExportResolution>("source");
  // The project's size NOW. The assistant or an MCP client can change it while this dialog is open, so the live canvas is read here and the `workload` taken when the dialog
  // opened is only the fallback. Each side is its own number, so the dialog draws again only when the width or the height changes. With no size to go by (no project open and
  // no workload) the list is Same as project alone.
  const liveWidth = useEditor((s) => s.timeline?.canvas?.width);
  const liveHeight = useEditor((s) => s.timeline?.canvas?.height);
  const canvas =
    usableCanvas(liveWidth, liveHeight) ?? usableCanvas(workload?.width, workload?.height);
  const sizes = resolutionChoices(canvas);
  // What is shown, asked about, estimated and sent is never a size the list does not hold: such a pick reads as Same as project in every render.
  const resolution: ExportResolution = sizes.includes(pickedResolution)
    ? pickedResolution
    : "source";
  // And it is forgotten, so a project that grows again does not bring the old pick back.
  useEffect(() => {
    if (pickedResolution !== resolution) setPickedResolution(resolution);
  }, [pickedResolution, resolution]);
  const [quality, setQuality] = useState<ExportQuality>("medium");
  const [fps, setFps] = useState<number | null>(null);
  // What the person picked in the Mode row; null until they touch it (the app's own choice shows then).
  const [picked, setPicked] = useState<ExportMode | null>(null);
  // Whether the Graphics chip row is on screen, as the row itself says (its `onDrawn`). The old Mode row is drawn only where the chip row is not: both
  // speak for the same chip, and the chip row is the one the person can switch Off for good. While the chip row has not answered nothing is known of it,
  // and neither row is drawn for the chip: the Mode row waits (it comes back the moment the chip row says it is not there).
  const [chipRow, setChipRow] = useState<ChipRowSeen>("unknown");
  const onChipRowDrawn = useCallback((drawn: boolean) => {
    setChipRow((before) =>
      drawn ? "drawn" : before === "drawn" || before === "left" ? "left" : "absent",
    );
  }, []);
  // Counts what the person changes about the graphics chip (its switch, Try it again now): the app's answer below is asked again.
  const [chipEpoch, bumpChip] = useReducer((n: number) => n + 1, 0);
  // What the app decided about the encoder (exportChoice.ts): whether the Mode row is shown and what it starts on. Kept with
  // what it was decided for (the settings, and the history of this PC's exports, which the estimates and so the choice are made
  // from), so the dialog knows whether the answer it has is for what is on screen: an answer to a question the settings or
  // the history have since changed is not to be sent on, and one that has not come yet, or never will (the look failed), is
  // not mistaken for "no row".
  const askedFor = `${resolution}|${quality}|${fps ?? ""}|${workload ? JSON.stringify(workload) : ""}|${chipEpoch}`;
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
  // In the gap (the app's answer wants a row and the chip row has not answered) neither row is drawn and Export sends Full quality, so the estimate is priced for Full too:
  // the line says what the export will do. Once the chip row answers, it is the app's own pick again.
  const mode: ExportMode =
    decision?.showRow === true && chipRow === "unknown" ? "quality" : lines.selected;
  // The Mode row, with its hint, its amber note and its "would take" line, is on screen only where the app's answer wants it and the chip row is not
  // there. A chip row that was drawn and has gone does not bring the row back for an answer that is not for what is on screen now (the picture size
  // changed under it); for one that is, it does (the server's switch for the chip row went off: the dialog is then the old one). What the estimate is priced for
  // follows the app's own pick (`mode`) whether or not the row is drawn: that is what the export will do.
  const modeRowShown =
    decision?.showRow === true && (chipRow === "absent" || (chipRow === "left" && answered));
  // The answer on screen is one the person has been offered, unless it wants a row and neither row is there yet (the chip row's first look is still out): then it is
  // treated like an answer that has not come, and the app does not choose for them.
  const offered = answered && decision !== null && !(decision.showRow && chipRow === "unknown");

  // Read-only information: what this PC has measured for settings like these, else the honest estimate or a rough guess. For the way that is
  // selected: Fast is the chip's estimate, Full the processor's (with its faster setting where the app will use it). While the PC's speed check runs
  // the line says so; the Export button never waits for it.
  const check = useSpeedCheck();
  // The two switches the estimate is priced under, read at every draw so that one the server turns while the dialog is open applies at the next, as it does at
  // the admission door. The checking line belongs to the new estimate: with it switched off the line is 0.27.0's, whatever the check is doing.
  const { estimate_v2: honestEstimate, pc_check: checkOn } = flags3cNow();
  const estimated = useMemo(
    () =>
      dialogEstimate({
        workload,
        settings: { resolution, quality, fps },
        mode,
        chip: decision?.facts.chip,
        faster: decision?.faster === true,
        history: calibrations,
        openTimeline: () => useEditor.getState().timeline,
      }),
    // `check.key` changes when the check's answer does, which is what the estimate is priced on.
    [
      workload,
      resolution,
      quality,
      fps,
      mode,
      calibrations,
      decision,
      check.key,
      honestEstimate,
      checkOn,
    ],
  );
  const expected = workload && honestEstimate && check.running ? CHECKING_LINE : estimated.line;

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

  // The chip row is drawn anew each time the settings are shown (it is not there while an export runs, nor without a project) and its first look starts
  // over: until it has answered, nothing is known of it.
  const settingsShown = open && phase === "idle" && !!workload;
  useEffect(() => {
    if (!settingsShown) setChipRow("unknown");
  }, [settingsShown]);

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
                onChange={(e) => setPickedResolution(e.target.value as ExportResolution)}
                className={selectCls}
              >
                {RESOLUTIONS.filter((r) => sizes.includes(r.value)).map((r) => (
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
            {workload && (
              <ChipRow
                workload={workload}
                resolution={resolution}
                fps={fps}
                onChange={bumpChip}
                onDrawn={onChipRowDrawn}
              />
            )}
            {modeRowShown && (
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
            {modeRowShown && lines.note && (
              <p className="text-xs leading-snug text-amber-300">{lines.note}</p>
            )}
            {expected && (
              <p aria-label="export estimate" className="text-xs leading-snug text-neutral-300">
                {expected}
              </p>
            )}
            {!check.running && estimated.muchLonger && (
              <p data-testid="estimate-much-longer" className="text-xs leading-snug text-amber-300">
                {estimated.muchLonger}
              </p>
            )}
            <SpeedCheckLine check={check} />
            {modeRowShown && lines.alternative && (
              <p className="text-xs leading-snug text-neutral-400">{lines.alternative}</p>
            )}
            {lines.faster && (
              <p className="text-xs leading-snug text-neutral-400">{lines.faster}</p>
            )}
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
                onClick={() => {
                  // The request is on its way: a speed check in progress stops now and the export starts on a labelled rough guess.
                  holdExportAsk();
                  // What the dialog showed: the export's record of the Mode row says "shown" only if it was (timeline/render.ts).
                  useExportJob.getState().setModeRowOnScreen(modeRowShown);
                  onStart({
                    resolution,
                    quality,
                    fps,
                    // What the person chose, never more. Only an answer that is in, for exactly what is on screen, is
                    // one the person has seen: then the row's pick if the row is on screen, else nothing (the app
                    // decides, and said so under the settings: the Mode row, or the chip row in its place). Without one
                    // (no project to ask about, the look failed, it has not come back, or the history changed under it)
                    // the person has been offered nothing, so the app does not choose for them: Full quality, or what
                    // they had picked.
                    mode:
                      workload && offered ? (modeRowShown ? picked : null) : (picked ?? "quality"),
                  });
                }}
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
  const abort = useExportJob((s) => s.abort);
  // A clock, not the progress feed: a stage that drags on (checking a long file) reports nothing at all, and that is
  // exactly when the line has to keep changing.
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(redraw, STATUS_REFRESH_MS);
    return () => clearInterval(id);
  }, [running]);

  const own = running && jobId ? liveFeedOf({ live, finishing }, jobId) : null;
  // Its place in line, while it waits for its turn (the same line the chat card counts). The queue lists the live attempt, and
  // the dialog holds the export's first attempt's id (exportAttempts.ts): an export the app started again waits as its new attempt.
  const place =
    running && jobId && own === null
      ? rows
          .filter((r) => r.state === "queued" && !r.cancelling)
          .findIndex((r) => r.job_id === attempts.current(jobId)) + 1
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
  // When the app started the export again by itself the bar goes back to the start: the card says why (its reason's own words) and so does the dialog, for the attempt that is live now.
  const liveRow =
    running && jobId ? rows.find((row) => row.job_id === attempts.current(jobId)) : undefined;
  const again =
    liveRow?.attempt && liveRow.attempt > 1
      ? (restartWords(liveRow.restartReason)?.after ?? null)
      : null;
  // What to lower, under the sentence the dialog says for the failure, where there is something true to say.
  const failedRow =
    phase === "failed" && jobId
      ? rows.find((row) => row.job_id === attempts.current(jobId))
      : undefined;
  const lower =
    phase === "failed" && error
      ? lowerAdvice3c(failureOf(error).code, failedRow?.chipFailed === true)
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
      {again && (
        <p data-testid="export-dialog-restarted" className="mt-1 text-[11px] text-neutral-500">
          {again}
        </p>
      )}
      {running && jobId && (
        <ExportHelpBanner
          jobId={jobId}
          onCancel={() => (abort ? abort() : cancelExport(jobId, "person_dialog"))}
        />
      )}
      {savedTo && (
        <p className="mt-2 break-all text-xs text-neutral-300">
          {/* The user picks the folder on desktop, so name it. Only the web build (no save
              dialog) gets a bare filename back, and only that build still means Downloads. */}
          {/[\\/]/.test(savedTo) ? `Saved to ${savedTo}` : `Saved ${savedTo} to Downloads.`}
        </p>
      )}
      {error && (
        <>
          {/* The card's sentence for why it stopped. The failure's own text (the encoder's log, the app's diagnostics) is not for the face of
              the dialog: it is one click away, for a report. */}
          <p data-testid="export-error" className="mt-2 text-xs text-red-300">
            {describeFailureHere(error, failedRow?.chipFailed === true)}
          </p>
          <details data-testid="export-error-details" className="mt-1">
            <summary className="cursor-pointer text-[11px] text-neutral-500 hover:text-neutral-300">
              Show details
            </summary>
            <pre className="mt-1 max-h-40 select-text overflow-auto whitespace-pre-wrap break-words text-[11px] text-neutral-400">
              {error}
            </pre>
          </details>
        </>
      )}
      {lower && (
        <p data-testid="export-lower" className="mt-1 text-xs text-neutral-400">
          {lower}
        </p>
      )}
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
