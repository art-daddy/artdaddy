// The one question on screen, and who may answer it.
//
// A request that needs the person (not enough memory or space, a heads-up) opens a question here and
// waits for its answer. The dialog at the root of the app and the card above the chat box both show the
// SAME record and both answer through `answerQuestion`, so the first answer wins and the other surface
// simply sees the question go away. Questions are shown one at a time, in the order they came.
//
// A question ends exactly once: by an answer, by the request being stopped (its signal), or because no
// dialog is left to show it (the caller then gets "unavailable" and refuses the export, never a hang).
import { create } from "zustand";

import { askForAttention } from "../lib/attention";
import { sameFolder, type ExportAnswer, type ExportQuestion } from "../timeline/exportQuestions";

export type AnsweredBy = "dialog" | "card" | "assistant";

export type QuestionOutcome =
  | {
      answer: ExportAnswer;
      by: AnsweredBy;
      waitedMs: number;
      /** The folder the person chose to save the video in, present only on a Continue whose pick is not the
       *  folder the file was already going to. */
      folder?: string;
    }
  | { answer: "aborted" | "unavailable"; by: "app"; waitedMs: number };

/** The folder a question is about: where the file goes now, and the one the person has picked instead. */
export interface QuestionFolder {
  readonly now: string;
  readonly picked: string | null;
}

/** Whether the pick would move the file: another folder than the one it is going to, however either is spelled.
 *  The one rule the dialog, the card and the answer share. */
export function movesTheFile(folder: QuestionFolder | null | undefined): boolean {
  return folder?.picked != null && !sameFolder(folder.picked, folder.now);
}

export interface OpenQuestion {
  readonly id: number;
  readonly question: ExportQuestion;
  /** The project that asked, so a card in another project does not show it. */
  readonly projectDir: string;
  /** When it appeared on screen (not when it was asked: it may have waited behind another). */
  readonly shownAt: number;
  /** Put away by the person to look at the project or the chat: the dialog is not showing it, and the
   *  card above the chat box carries it instead. Still open and still answerable. */
  readonly hidden: boolean;
  /** A card for its project is there to carry it, so it may be put away. */
  readonly canHide: boolean;
  /** Where the file goes and what the person picked instead, for a question with a Save to box; null for any
   *  other. Held here, not in the question, which carries no path. */
  readonly folder: QuestionFolder | null;
}

interface Entry {
  readonly id: number;
  readonly question: ExportQuestion;
  readonly projectDir: string;
  /** Where the file goes now, when the question has a Save to box and the asker said. */
  readonly folderNow: string | null;
  picked: string | null;
  shownAt: number;
  hidden: boolean;
  /** Who ended it, once it has ended ("app" for a stop or for no dialog being left). */
  winner?: AnsweredBy | "app";
  readonly finish: (outcome: QuestionOutcome) => void;
  readonly onIgnored?: (answer: ExportAnswer, by: AnsweredBy, winner: AnsweredBy | "app") => void;
}

interface HostState {
  open: OpenQuestion | null;
}

export const useExportQuestions = create<HostState>(() => ({ open: null }));

let nextId = 1;
let generation = 0;
let mounted = 0;
const waiting: Entry[] = [];
let current: Entry | null = null;
/** Cards above a chat box that are mounted, by the project they show. */
const cards = new Map<string, number>();
const hasCard = (projectDir: string): boolean => (cards.get(projectDir) ?? 0) > 0;
/** Questions that just ended, so a late answer (a second click, the other surface a moment later) can
 *  still be told it lost. Bounded. */
const recent = new Map<number, Entry>();
const RECENT_MAX = 20;

function publish(): void {
  // A question is never left put away with nothing to carry it (the chat was closed): it comes back.
  if (current && current.hidden && !hasCard(current.projectDir)) current.hidden = false;
  useExportQuestions.setState({
    open: current
      ? {
          id: current.id,
          question: current.question,
          projectDir: current.projectDir,
          shownAt: current.shownAt,
          hidden: current.hidden,
          canHide: hasCard(current.projectDir),
          folder:
            current.folderNow === null ? null : { now: current.folderNow, picked: current.picked },
        }
      : null,
  });
}

function remember(entry: Entry): void {
  recent.set(entry.id, entry);
  if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value as number);
}

/** Put the oldest waiting question on screen. */
function promote(): void {
  if (current || waiting.length === 0) return;
  current = waiting.shift()!;
  current.shownAt = Date.now();
  publish();
  // A question can appear while the window is behind another; the system's own hint (taskbar flash)
  // is how the person finds out. Nothing is shown inside the app by this call.
  void askForAttention();
}

/** True while at least one dialog is mounted to show a question. */
export function hostMounted(): boolean {
  return mounted > 0;
}

/** A dialog announces itself; the returned function removes it. When the last one goes, every open and
 *  waiting question ends as "unavailable". */
export function mountQuestionHost(): () => void {
  const mine = generation;
  let gone = false;
  mounted++;
  return () => {
    if (gone || mine !== generation) return;
    gone = true;
    mounted = Math.max(0, mounted - 1);
    if (mounted > 0) return;
    const ended = [...(current ? [current] : []), ...waiting.splice(0)];
    current = null;
    publish();
    for (const entry of ended) {
      entry.winner = "app";
      remember(entry);
      entry.finish({ answer: "unavailable", by: "app", waitedMs: 0 });
    }
  };
}

/** A card above a chat box announces itself for its project; the returned function removes it. While one is
 *  there the question of that project may be put away, and when the last one goes a question that was put
 *  away comes back to the screen. */
export function mountQuestionCard(projectDir: string): () => void {
  const mine = generation;
  let gone = false;
  cards.set(projectDir, (cards.get(projectDir) ?? 0) + 1);
  publish();
  return () => {
    if (gone || mine !== generation) return;
    gone = true;
    const left = (cards.get(projectDir) ?? 1) - 1;
    if (left > 0) cards.set(projectDir, left);
    else cards.delete(projectDir);
    publish();
  };
}

/** Put the question on screen away (so the project or the chat can be looked at) or bring it back. It
 *  stays open either way. False when nothing changed: it is not the one on screen, it already is that
 *  way, or no card is there to carry it. */
export function setQuestionHidden(id: number, hidden: boolean): boolean {
  if (!current || current.id !== id || current.hidden === hidden) return false;
  if (hidden && !hasCard(current.projectDir)) return false;
  current.hidden = hidden;
  publish();
  return true;
}

/** Ask a question and wait for its end. With no dialog mounted the answer is "unavailable" at once. */
export function askQuestion(
  question: ExportQuestion,
  options: {
    projectDir: string;
    /** The request's own signal: stopping the request closes its question. */
    signal?: AbortSignal;
    /** Told of every answer that arrived after the question had ended, and who had ended it. */
    onIgnored?: (answer: ExportAnswer, by: AnsweredBy, winner: AnsweredBy | "app") => void;
    /** Where the file goes now. Only a question with a Save to box uses it: without one the question has no
     *  folder, whatever is passed. */
    folderNow?: string;
  },
): Promise<QuestionOutcome> {
  if (options.signal?.aborted)
    return Promise.resolve({ answer: "aborted", by: "app", waitedMs: 0 });
  if (!hostMounted()) return Promise.resolve({ answer: "unavailable", by: "app", waitedMs: 0 });
  return new Promise<QuestionOutcome>((resolve) => {
    let ended = false;
    const folderNow =
      question.folderBox !== null && options.folderNow?.trim() ? options.folderNow.trim() : null;
    const entry: Entry = {
      id: nextId++,
      question,
      projectDir: options.projectDir,
      folderNow,
      picked: null,
      shownAt: 0,
      hidden: false,
      onIgnored: options.onIgnored,
      finish: (outcome) => {
        if (ended) return;
        ended = true;
        options.signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      },
    };
    const onAbort = (): void => {
      const queued = waiting.indexOf(entry);
      if (queued >= 0) waiting.splice(queued, 1);
      else if (current === entry) {
        current = null;
        promote();
        publish();
      } else return;
      entry.winner = "app";
      remember(entry);
      entry.finish({ answer: "aborted", by: "app", waitedMs: 0 });
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    waiting.push(entry);
    promote();
    publish();
  });
}

/** Pick the folder the video is saved in instead, for the question on screen: the dialog and the card both
 *  show the pick, and whichever presses Continue carries it. A null `folder` takes the pick back. False when
 *  nothing changed: it is not the question on screen, it has no Save to box, or the folder is blank. */
export function chooseQuestionFolder(id: number, folder: string | null): boolean {
  if (!current || current.id !== id || current.folderNow === null) return false;
  const clean = folder === null ? null : folder.trim();
  if (clean === "") return false;
  current.picked = clean;
  publish();
  return true;
}

/** Answer the question on screen. "accepted" when this answer ended it; "ignored" when it did not (it
 *  had already ended, or it is not the one on screen), in which case the question's own asker is told. */
export function answerQuestion(
  id: number,
  answer: ExportAnswer,
  by: AnsweredBy,
): "accepted" | "ignored" {
  if (current && current.id === id) {
    const entry = current;
    const waitedMs = Math.max(0, Date.now() - entry.shownAt);
    // Only Continue moves the file: a pick made and then not followed is not an answer.
    const folder =
      answer === "continue" &&
      entry.folderNow !== null &&
      movesTheFile({ now: entry.folderNow, picked: entry.picked })
        ? entry.picked!
        : undefined;
    current = null;
    entry.winner = by;
    remember(entry);
    promote();
    publish();
    entry.finish({ answer, by, waitedMs, ...(folder === undefined ? {} : { folder }) });
    return "accepted";
  }
  const late = recent.get(id);
  if (late) {
    try {
      late.onIgnored?.(answer, by, late.winner ?? "app");
    } catch {
      /* a listener must never break an answer */
    }
  }
  return "ignored";
}

/** Tests only. */
export function __resetExportQuestions(): void {
  generation++;
  mounted = 0;
  current = null;
  waiting.length = 0;
  cards.clear();
  recent.clear();
  nextId = 1;
  publish();
}
