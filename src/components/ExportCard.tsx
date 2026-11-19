// The card above the chat box: what the exports of the open project are doing, and what they need.
//
// A person who asked their assistant to export (or whose assistant did) used to see nothing: the bar in
// the Export dialog is begun by the menu only. This card follows the queue's own view of the run, so
// every export shows here the same way, whoever asked for it:
//   - a question that needs the person, once they have put the dialog away ("Answer in chat"): the same
//     record the dialog shows, so answering in either closes both. While the dialog is on screen it is
//     modal and covers this card, so the card says nothing about the question then.
//   - every running export: its name, a bar, one line saying where it is and how long is left (refreshed by a clock, so it
//     never goes stale; the time left is the answer of the rule that reads the render's pace: a figure, "Finishing" or
//     "taking longer than expected", the same one the Export dialog and the assistant's list give), what it was expected to take
//     when earlier exports on this PC say so (in the words the Export dialog used before the click; a guess is not shown here),
//     and Cancel. More than one can be running when the next export's turn has begun
//     while the last one's file is still being checked or saved; each has its own feed.
//   - the exports waiting behind it, with their place in line
//   - how the last ones ended, in plain words
// It is a view, not a message: nothing is written into the conversation, no tokens are spent and nobody
// is woken. Every number it shows comes from the same feed as the dialog's.
import { useEffect, useReducer, useSyncExternalStore } from "react";

import { pickFolder } from "../lib/pickFolder";
import { useEditor } from "../store/editor";
import {
  answerQuestion,
  mountQuestionCard,
  movesTheFile,
  setQuestionHidden,
  useExportQuestions,
} from "../store/exportQuestionHost";
import { liveFeedOf, useExportJob } from "../store/exportJob";
import {
  cancelExport,
  dismissExport,
  gentlestRungOf,
  isCeilingStop,
  listExportRecords,
  restartWords,
  retryExport,
  subscribeExports,
} from "../timeline/exportQueue";
import { answerButtons } from "../timeline/exportQuestions";
import { describeEstimateLine } from "../timeline/estimateWords";
import { lowerAdvice3c } from "../timeline/exportHelpWatch";
import {
  canSaveElsewhere,
  describeChipFailure,
  describeEncoder,
  describeExpected,
  describeLiveStatus,
  describeQuietNote,
  describeResult,
  describeRung,
  describeTryAgain,
  describeWaiting,
  failureOf,
  SAVE_ELSEWHERE_LINE,
  STATUS_REFRESH_MS,
} from "../timeline/exportWords";
import ExportProgressBar from "./ExportProgressBar";
import ChipLine from "./ChipLine";
import ExportHelpBanner from "./ExportHelpBanner";
import SaveToRow from "./SaveToRow";
import { cn } from "./ui";

/** How long good news stays: a finished export is a moment, a failed one stays until dismissed. */
const GOOD_NEWS_MS = 60_000;

const quiet = "rounded px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800";

/** Ask for a folder and start the failed export again there. A picker closed without a choice, or one that cannot
 *  open, changes nothing. */
async function saveSomewhereElse(jobId: string): Promise<void> {
  try {
    const dir = await pickFolder("Save the video to");
    if (dir) await retryExport(jobId, useEditor.getState().store ?? undefined, { saveTo: dir });
  } catch {
    /* nothing chosen */
  }
}

export default function ExportCard({
  onSwitchToQuick,
}: {
  /** Starts a running export again as a Quick export; given only where Quick exists. */
  onSwitchToQuick?: (jobId: string) => void;
} = {}): JSX.Element | null {
  const projectDir = useEditor((s) => s.store?.projectDir ?? null);
  const rows = useSyncExternalStore(subscribeExports, listExportRecords, listExportRecords);
  const live = useExportJob((s) => s.live);
  const finishing = useExportJob((s) => s.finishing);
  const open = useExportQuestions((s) => s.open);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const now = Date.now();

  // Announce this card for its project: while one is there, a question may be put away from the dialog
  // and carried here, and when the last one goes (the chat is closed) the dialog comes back.
  useEffect(() => (projectDir === null ? undefined : mountQuestionCard(projectDir)), [projectDir]);

  const mine = projectDir === null ? [] : rows.filter((r) => r.projectDir === projectDir);
  const running = mine.filter((r) => r.state === "running");
  const waiting = mine.filter((r) => r.state === "queued");
  // The line is one for the whole app (one export runs at a time): a place in it counts every export
  // still waiting, in any project, that has not been cancelled.
  const line = rows.filter((r) => r.state === "queued" && !r.cancelling);
  const failed = mine
    .filter((r) => r.state === "failed")
    .slice(-3)
    .reverse();
  const goodNews = [...mine]
    .reverse()
    .find(
      (r) =>
        (r.state === "done" || r.state === "cancelled") &&
        r.endedAt !== undefined &&
        now - r.endedAt < GOOD_NEWS_MS,
    );
  const asked = open !== null && open.hidden && open.projectDir === projectDir ? open : null;

  // A clock, not the progress feed: a stuck export stops reporting exactly when the line matters.
  const ticking = running.length > 0 || goodNews !== undefined;
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(redraw, STATUS_REFRESH_MS);
    return () => clearInterval(id);
  }, [ticking]);

  if (!asked && running.length === 0 && waiting.length === 0 && failed.length === 0 && !goodNews)
    return null;
  const results = goodNews ? [...failed, goodNews] : failed;

  return (
    <section
      aria-label="exports"
      className="mb-2 space-y-2 rounded-lg border border-edge bg-neutral-900/60 px-3 py-2 text-xs"
    >
      {asked && (
        <div
          role="group"
          aria-label="export question"
          className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2"
        >
          <div className="font-medium text-neutral-100">{asked.question.title}</div>
          {asked.question.lines[0] && (
            <div className="mt-0.5 text-neutral-300">{asked.question.lines[0]}</div>
          )}
          {asked.question.facts.length > 0 && (
            <div className="mt-0.5 tabular-nums text-neutral-300">
              {asked.question.facts.map((fact) => `${fact.label} ${fact.value}`).join(" · ")}
            </div>
          )}
          {asked.folder && <SaveToRow id={asked.id} folder={asked.folder} compact />}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {answerButtons(asked.question)
              .filter((b) => b.answer !== "start_anyway" || !movesTheFile(asked.folder))
              .map((b) => (
                <button
                  key={b.answer}
                  type="button"
                  onClick={() => answerQuestion(asked.id, b.answer, "card")}
                  className={
                    b.answer === "continue"
                      ? "rounded-md bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-900 hover:bg-white"
                      : cn(quiet, b.answer === "start_anyway" && "underline underline-offset-2")
                  }
                >
                  {b.label}
                </button>
              ))}
            <button
              type="button"
              onClick={() => void setQuestionHidden(asked.id, false)}
              className={cn(quiet, "ml-auto text-neutral-500")}
            >
              Show dialog
            </button>
          </div>
        </div>
      )}

      {running.map((r) => {
        const feed = liveFeedOf({ live, finishing }, r.job_id);
        // The honest estimate's own words (its range, where the number came from) when the export was admitted with one. What was
        // expected is said only when it came from this PC's own earlier exports: a guess from the size of the export is not shown.
        const expected =
          (r.estimate ? describeEstimateLine(r.estimate, r.estimateClass) : "") ||
          (r.expected?.guessed ? "" : describeExpected(r.expected));
        const again =
          r.attempt && r.attempt > 1 ? (restartWords(r.restartReason)?.after ?? null) : null;
        const quietNote = feed ? describeQuietNote(feed, now) : null;
        return (
          <div key={r.job_id}>
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-medium text-neutral-100">
                {`Exporting “${r.filename}”${r.attempt && r.attempt > 1 ? ` · attempt ${r.attempt}` : ""}`}
              </span>
              {!r.cancelling && (
                <button
                  type="button"
                  aria-label={`cancel ${r.filename}`}
                  onClick={() => cancelExport(r.job_id, "person_card")}
                  className={cn(quiet, "hover:text-red-400")}
                >
                  Cancel
                </button>
              )}
            </div>
            <div className="mt-1.5">
              <ExportProgressBar fraction={feed?.fraction ?? null} />
            </div>
            <div data-testid="export-card-status" className="mt-1 text-[11px] text-neutral-400">
              {r.cancelling
                ? "Cancelling…"
                : r.restarting
                  ? r.restarting
                  : feed
                    ? describeLiveStatus(feed, now)
                    : "Working…"}
            </div>
            {again && !r.cancelling && (
              <div
                data-testid="export-card-restarted"
                className="mt-0.5 text-[11px] text-neutral-500"
              >
                {again}
              </div>
            )}
            {quietNote && !r.cancelling && (
              <div
                data-testid="export-card-quiet-note"
                className="mt-0.5 text-[11px] text-neutral-500"
              >
                {quietNote}
              </div>
            )}
            {/* What it was expected to take when it began, for the whole run, when this PC's own earlier exports said so: the time left
                above is the rule's, and only appears once the render has run long enough to read a pace from. */}
            {expected && !r.cancelling && (
              <div
                data-testid="export-card-expected"
                className="mt-0.5 text-[11px] text-neutral-500"
              >
                {expected}
              </div>
            )}
            {r.rung && (
              <div className="mt-0.5 text-[11px] text-neutral-500">{describeRung(r.rung)}</div>
            )}
            {describeEncoder(r.encoder, r.reason) && (
              <ChipLine
                line={describeEncoder(r.encoder, r.reason)}
                chip={r.encoder === "amd" || r.encoder === "nvidia" || r.encoder === "intel"}
              />
            )}
            <ExportHelpBanner
              jobId={r.job_id}
              onCancel={() => cancelExport(r.job_id, "person_card")}
              onSwitchToQuick={onSwitchToQuick}
            />
          </div>
        );
      })}

      {waiting.map((r) => (
        <div key={r.job_id} className="flex items-center justify-between gap-2 text-neutral-300">
          <span className="min-w-0 truncate">
            {r.cancelling
              ? `Cancelling · ${r.filename}`
              : `${describeWaiting(line.indexOf(r) + 1)} · ${r.filename}`}
          </span>
          {!r.cancelling && (
            <button
              type="button"
              aria-label={`cancel ${r.filename}`}
              onClick={() => cancelExport(r.job_id, "person_card")}
              className={cn(quiet, "hover:text-red-400")}
            >
              ✕
            </button>
          )}
        </div>
      ))}

      {results.map((r) => {
        const result = describeResult({
          state: r.state as "done" | "failed" | "cancelled",
          filename: r.filename,
          elapsedMs: (r.endedAt ?? now) - (r.ranAt ?? r.startedAt),
          error: r.error,
        });
        // A restart the app made that failed the same way says so in the reason's own words.
        const failedAgain =
          r.state === "failed" &&
          r.attempt &&
          r.attempt > 1 &&
          failureOf(r.error).code === "memory_limit"
            ? (restartWords(r.restartReason)?.failedAgain ?? null)
            : null;
        const detail = failedAgain ?? result.detail;
        const tryAgain =
          r.state === "failed" && r.canRetry
            ? r.chipFailed
              ? describeChipFailure("card")
              : describeTryAgain(
                  failureOf(r.error).code,
                  r.rung,
                  gentlestRungOf(r),
                  isCeilingStop(r.error),
                )
            : r.state === "failed" && r.chipFailed
              ? describeChipFailure("again")
              : "";
        const elsewhere =
          r.state === "failed" && r.canRetry === true && canSaveElsewhere(failureOf(r.error).code);
        // What to lower, after the plain sentence and Try again's line, where there is something true to say.
        const lower =
          r.state === "failed" ? lowerAdvice3c(failureOf(r.error).code, r.chipFailed === true) : "";
        return (
          <div key={r.job_id} className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div
                className={cn(
                  "truncate",
                  r.state === "failed" ? "text-red-300" : "text-neutral-200",
                )}
              >
                {result.title}
              </div>
              {r.state !== "done" && (
                <div className="truncate text-[11px] text-neutral-500">{r.filename}</div>
              )}
              {detail && <div className="text-[11px] text-neutral-400">{detail}</div>}
              {tryAgain && <div className="text-[11px] text-neutral-400">{tryAgain}</div>}
              {lower && (
                <div data-testid="export-card-lower" className="text-[11px] text-neutral-400">
                  {lower}
                </div>
              )}
              {elsewhere && (
                <div className="text-[11px] text-neutral-400">{SAVE_ELSEWHERE_LINE}</div>
              )}
              {r.note && <div className="text-[11px] text-amber-300">{r.note}</div>}
              {r.state === "failed" && r.canRetry && (
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    aria-label={`try again ${r.filename}`}
                    disabled={r.retrying === true}
                    onClick={() =>
                      void retryExport(r.job_id, useEditor.getState().store ?? undefined)
                    }
                    className="rounded-md bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-900 hover:bg-white disabled:cursor-default disabled:opacity-60"
                  >
                    {r.retrying ? "Starting…" : "Try again"}
                  </button>
                  {elsewhere && (
                    <button
                      type="button"
                      aria-label={`save ${r.filename} somewhere else`}
                      disabled={r.retrying === true}
                      onClick={() => void saveSomewhereElse(r.job_id)}
                      className={cn(quiet, "underline underline-offset-2 disabled:opacity-60")}
                    >
                      Save somewhere else…
                    </button>
                  )}
                </div>
              )}
            </div>
            <button
              type="button"
              aria-label={`dismiss ${r.filename}`}
              onClick={() => dismissExport(r.job_id)}
              className={cn(quiet, "text-neutral-600 hover:text-neutral-300")}
            >
              ✕
            </button>
          </div>
        );
      })}
    </section>
  );
}
