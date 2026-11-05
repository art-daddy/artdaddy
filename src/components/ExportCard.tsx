// The card above the chat box: what the exports of the open project are doing, and what they need.
//
// A person who asked their assistant to export (or whose assistant did) used to see nothing: the bar in
// the Export dialog is begun by the menu only. This card follows the queue's own view of the run, so
// every export shows here the same way, whoever asked for it:
//   - a question that needs the person, once they have put the dialog away ("Answer in chat"): the same
//     record the dialog shows, so answering in either closes both. While the dialog is on screen it is
//     modal and covers this card, so the card says nothing about the question then.
//   - every running export: its name, a bar, one line saying where it is (refreshed by a clock, so it
//     never goes stale), and Cancel. More than one can be running when the next export's turn has begun
//     while the last one's file is still being checked or saved; each has its own feed.
//   - the exports waiting behind it, with their place in line
//   - how the last ones ended, in plain words
// It is a view, not a message: nothing is written into the conversation, no tokens are spent and nobody
// is woken. Every number it shows comes from the same feed as the dialog's.
import { useEffect, useReducer, useSyncExternalStore } from "react";

import { useEditor } from "../store/editor";
import {
  answerQuestion,
  mountQuestionCard,
  setQuestionHidden,
  useExportQuestions,
} from "../store/exportQuestionHost";
import { liveFeedOf, useExportJob } from "../store/exportJob";
import {
  cancelExport,
  dismissExport,
  gentlestRungOf,
  listExportRecords,
  retryExport,
  subscribeExports,
} from "../timeline/exportQueue";
import { answerButtons } from "../timeline/exportQuestions";
import {
  describeLiveStatus,
  describeResult,
  describeRung,
  describeTryAgain,
  describeWaiting,
  failureOf,
} from "../timeline/exportWords";
import ExportProgressBar from "./ExportProgressBar";
import { cn } from "./ui";

/** How often the line is redrawn while something is running: well inside the minute it promises. */
const TICK_MS = 10_000;
/** How long good news stays: a finished export is a moment, a failed one stays until dismissed. */
const GOOD_NEWS_MS = 60_000;

const quiet = "rounded px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800";

export default function ExportCard(): JSX.Element | null {
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
    const id = setInterval(redraw, TICK_MS);
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
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {answerButtons(asked.question).map((b) => (
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
        return (
          <div key={r.job_id}>
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-medium text-neutral-100">
                {`Exporting “${r.filename}”`}
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
              {r.cancelling ? "Cancelling…" : feed ? describeLiveStatus(feed, now) : "Working…"}
            </div>
            {r.rung && (
              <div className="mt-0.5 text-[11px] text-neutral-500">{describeRung(r.rung)}</div>
            )}
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
        const tryAgain =
          r.state === "failed" && r.canRetry
            ? describeTryAgain(failureOf(r.error).code, r.rung, gentlestRungOf(r))
            : "";
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
              {result.detail && <div className="text-[11px] text-neutral-400">{result.detail}</div>}
              {tryAgain && <div className="text-[11px] text-neutral-400">{tryAgain}</div>}
              {r.note && <div className="text-[11px] text-amber-300">{r.note}</div>}
              {r.state === "failed" && r.canRetry && (
                <button
                  type="button"
                  aria-label={`try again ${r.filename}`}
                  disabled={r.retrying === true}
                  onClick={() =>
                    void retryExport(r.job_id, useEditor.getState().store ?? undefined)
                  }
                  className="mt-1.5 rounded-md bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-900 hover:bg-white disabled:cursor-default disabled:opacity-60"
                >
                  {r.retrying ? "Starting…" : "Try again"}
                </button>
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
