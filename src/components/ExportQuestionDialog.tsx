// The question an export asks before it starts: not enough free memory, not enough room on a drive, or a
// heads-up about a very large or very long export. Always the same shape: what is wrong, the numbers,
// what to do, and a way out. It shows whatever question is open in the store; the card above the chat
// box shows the same record when the person puts the dialog away ("Answer in chat"), so an answer in
// either closes both.
//
// Mounted once, at the root of the app. While it is mounted a request can ask here instead of in a
// native message box, which cannot be closed from code and cannot say which resource is short.
import { useEffect, useRef } from "react";

import {
  answerQuestion,
  mountQuestionHost,
  movesTheFile,
  setQuestionHidden,
  useExportQuestions,
} from "../store/exportQuestionHost";
import { answerButtons } from "../timeline/exportQuestions";
import { useAnswerShield } from "./answerShield";
import SaveToRow from "./SaveToRow";
import { cn } from "./ui";

/** Another full-screen layer (the Export dialog, a settings box) sits on top of the chat and would hide the
 *  card that carries a put-away question. The question's own layer is marked and does not count. */
function otherLayerOpen(): boolean {
  return document.querySelector(".fixed.inset-0:not([data-export-question])") !== null;
}

export default function ExportQuestionDialog(): JSX.Element | null {
  useEffect(() => mountQuestionHost(), []);
  const open = useExportQuestions((s) => s.open);
  const guard = useAnswerShield();
  const box = useRef<HTMLDivElement>(null);
  const id = open?.id;
  const onScreen = open !== null && !open.hidden;

  // Focus the dialog itself, not a button: a stray Enter from someone typing in the chat when it
  // appears must not answer it.
  useEffect(() => {
    if (id !== undefined && onScreen) box.current?.focus();
  }, [id, onScreen]);

  // Escape means Cancel: nothing starts and nothing changes. Only while the dialog is on screen: put
  // away, the key belongs to whatever the person is doing instead.
  useEffect(() => {
    if (id === undefined || !onScreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      guard(() => void answerQuestion(id, "cancel", "dialog"));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [id, onScreen, guard]);

  if (!open || open.hidden) return null;
  const q = open.question;
  const answer = (choice: "continue" | "start_anyway" | "cancel") =>
    guard(() => void answerQuestion(open.id, choice, "dialog"));
  const buttons = answerButtons(q);
  // The quiet link is about the folder the file was going to: once another one is picked, that folder has not
  // been looked at yet, so there is nothing to start anyway.
  const quietButton = movesTheFile(open.folder)
    ? undefined
    : buttons.find((b) => b.answer === "start_anyway");

  return (
    <div
      data-export-question
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-6"
    >
      <div
        ref={box}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={q.title}
        className="w-[460px] max-w-[92vw] rounded-xl border border-neutral-800 bg-neutral-900 p-6 text-neutral-100 shadow-xl outline-none"
      >
        <h1 className="text-lg font-semibold tracking-tight">{q.title}</h1>
        {q.lines.map((line) => (
          <p key={line} className="mt-2 text-sm text-neutral-300">
            {line}
          </p>
        ))}
        {q.facts.length > 0 && (
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md bg-neutral-950/60 px-3 py-2 text-sm">
            {q.facts.map((fact) => (
              <div key={fact.label} className="contents">
                <dt className="text-neutral-400">{fact.label}</dt>
                <dd className="tabular-nums text-neutral-100">{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}
        <p className="mt-3 text-sm text-neutral-300">{q.advice}</p>
        {open.folder && <SaveToRow id={open.id} folder={open.folder} />}
        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          {open.canHide && !otherLayerOpen() && (
            <button
              type="button"
              onClick={() => {
                // Checked again at the click: a layer may have opened since the dialog was drawn.
                if (!otherLayerOpen()) setQuestionHidden(open.id, true);
              }}
              className="mr-auto rounded-md px-2 py-1.5 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
            >
              Answer in chat
            </button>
          )}
          {buttons
            .filter((b) => b.answer !== "start_anyway")
            .map((b) => (
              <button
                key={b.answer}
                type="button"
                onClick={() => answer(b.answer)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm",
                  b.answer === "continue"
                    ? "bg-neutral-100 font-medium text-neutral-900 hover:bg-white"
                    : "text-neutral-300 hover:bg-neutral-800",
                )}
              >
                {b.label}
              </button>
            ))}
        </div>
        {quietButton && (
          <p className="mt-3 text-right text-xs text-neutral-500">
            {q.startAnywayNote}{" "}
            <button
              type="button"
              onClick={() => answer("start_anyway")}
              className="text-neutral-400 underline underline-offset-2 hover:text-neutral-200"
            >
              {quietButton.label}
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
