import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { planQuestions, type ExportAnswer, type ExportQuestion } from "../timeline/exportQuestions";
import {
  __resetExportQuestions,
  answerQuestion,
  askQuestion,
  chooseQuestionFolder,
  hostMounted,
  mountQuestionCard,
  mountQuestionHost,
  movesTheFile,
  setQuestionHidden,
  useExportQuestions,
  type QuestionOutcome,
} from "./exportQuestionHost";

const attention = vi.hoisted(() => ({ askForAttention: vi.fn(async () => undefined) }));
vi.mock("../lib/attention", () => attention);

const base = planQuestions({
  via: "chat",
  count: 1,
  reasons: new Set(["memory_shortage"]),
  memoryNeededBytes: 3.2e9,
  memoryUsableBytes: 1.9e9,
  spaceNeededBytes: null,
  destinationFreeBytes: null,
  scratchFreeBytes: null,
  destinationShort: false,
  scratchShort: false,
  drive: null,
  movable: false,
  seconds: null,
  secondsGuessed: false,
  executionLimitSeconds: null,
})[0];
const question = (title: string): ExportQuestion => ({ ...base, title });

const openTitle = (): string | null => useExportQuestions.getState().open?.question.title ?? null;
const openId = (): number => useExportQuestions.getState().open!.id;

let unmount: () => void;
beforeEach(() => {
  __resetExportQuestions();
  attention.askForAttention.mockClear();
  unmount = mountQuestionHost();
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
});

describe("the one question on screen", () => {
  it("shows the first question and holds the others in the order they came", async () => {
    const a = askQuestion(question("A"), { projectDir: "p" });
    const b = askQuestion(question("B"), { projectDir: "p" });
    const c = askQuestion(question("C"), { projectDir: "p" });
    expect(openTitle()).toBe("A");
    expect(answerQuestion(openId(), "continue", "dialog")).toBe("accepted");
    expect(openTitle()).toBe("B");
    expect(answerQuestion(openId(), "cancel", "card")).toBe("accepted");
    expect(openTitle()).toBe("C");
    expect(answerQuestion(openId(), "start_anyway", "dialog")).toBe("accepted");
    expect(openTitle()).toBeNull();
    expect(await a).toMatchObject({ answer: "continue", by: "dialog" });
    expect(await b).toMatchObject({ answer: "cancel", by: "card" });
    expect(await c).toMatchObject({ answer: "start_anyway", by: "dialog" });
  });

  it("remembers which project asked, so a card in another project does not show it", () => {
    void askQuestion(question("A"), { projectDir: "C:/projects/one" });
    expect(useExportQuestions.getState().open?.projectDir).toBe("C:/projects/one");
  });

  it("lets exactly one answer win and tells the loser, once", async () => {
    const ignored: Array<[ExportAnswer, string, string]> = [];
    const outcome = askQuestion(question("A"), {
      projectDir: "p",
      onIgnored: (answer, by, winner) => ignored.push([answer, by, winner]),
    });
    const id = openId();
    expect(answerQuestion(id, "continue", "dialog")).toBe("accepted");
    expect(answerQuestion(id, "cancel", "card")).toBe("ignored");
    expect(answerQuestion(id, "start_anyway", "card")).toBe("ignored");
    expect(await outcome).toMatchObject({ answer: "continue", by: "dialog" });
    // Each late answer is reported with who had already won (a second click, or the other surface a
    // moment later).
    expect(ignored).toEqual([
      ["cancel", "card", "dialog"],
      ["start_anyway", "card", "dialog"],
    ]);
  });

  it("says the app won when the request was stopped before a late answer came", async () => {
    const stop = new AbortController();
    const ignored: Array<[ExportAnswer, string, string]> = [];
    void askQuestion(question("A"), {
      projectDir: "p",
      signal: stop.signal,
      onIgnored: (answer, by, winner) => ignored.push([answer, by, winner]),
    });
    const id = openId();
    stop.abort();
    expect(answerQuestion(id, "continue", "card")).toBe("ignored");
    expect(ignored).toEqual([["continue", "card", "app"]]);
  });

  it("ignores an answer for a question that is not on screen, without throwing", () => {
    expect(answerQuestion(123_456, "continue", "card")).toBe("ignored");
    void askQuestion(question("A"), { projectDir: "p" });
    void askQuestion(question("B"), { projectDir: "p" });
    // B is waiting behind A: only what is on screen can be answered.
    const onScreen = openId();
    expect(answerQuestion(onScreen + 1, "continue", "card")).toBe("ignored");
    expect(openTitle()).toBe("A");
  });

  it("closes the question of a request that was stopped, and shows the next", async () => {
    const stop = new AbortController();
    const a = askQuestion(question("A"), { projectDir: "p", signal: stop.signal });
    void askQuestion(question("B"), { projectDir: "p" });
    stop.abort();
    expect(await a).toMatchObject({ answer: "aborted" });
    expect(openTitle()).toBe("B");
  });

  it("never shows a question whose request was stopped while it waited", async () => {
    void askQuestion(question("A"), { projectDir: "p" });
    const stop = new AbortController();
    const b = askQuestion(question("B"), { projectDir: "p", signal: stop.signal });
    void askQuestion(question("C"), { projectDir: "p" });
    stop.abort();
    expect(await b).toMatchObject({ answer: "aborted" });
    answerQuestion(openId(), "continue", "dialog");
    expect(openTitle()).toBe("C");
  });

  it("does not even open the question of a request that was already stopped", async () => {
    const stop = new AbortController();
    stop.abort();
    const outcome = await askQuestion(question("A"), { projectDir: "p", signal: stop.signal });
    expect(outcome).toMatchObject({ answer: "aborted" });
    expect(openTitle()).toBeNull();
    expect(attention.askForAttention).not.toHaveBeenCalled();
  });

  it("is gone from the screen the moment it is answered, whoever answered", () => {
    void askQuestion(question("A"), { projectDir: "p" });
    answerQuestion(openId(), "continue", "card");
    expect(useExportQuestions.getState().open).toBeNull();
  });
});

describe("putting a question away, to look at the project or the chat", () => {
  const open = () => useExportQuestions.getState().open;

  it("keeps the question open while it is put away: it can still be answered, and it comes back", async () => {
    const card = mountQuestionCard("p");
    const outcome = askQuestion(question("A"), { projectDir: "p" });
    const id = openId();
    expect(open()).toMatchObject({ id, hidden: false, canHide: true });
    expect(setQuestionHidden(id, true)).toBe(true);
    expect(open()).toMatchObject({ id, hidden: true });
    expect(setQuestionHidden(id, true)).toBe(false); // nothing changed
    expect(setQuestionHidden(id, false)).toBe(true);
    expect(open()?.hidden).toBe(false);
    expect(setQuestionHidden(id, true)).toBe(true);
    // Answered while put away (that is what the card is for): the asker hears it, the screen is clear.
    expect(answerQuestion(id, "continue", "card")).toBe("accepted");
    expect(await outcome).toMatchObject({ answer: "continue", by: "card" });
    expect(open()).toBeNull();
    card();
  });

  it("is not offered for a question nothing else could show: no card for its project", () => {
    void askQuestion(question("A"), { projectDir: "p" });
    expect(open()?.canHide).toBe(false);
    expect(setQuestionHidden(openId(), true)).toBe(false);
    const elsewhere = mountQuestionCard("somewhere/else"); // another project's card does not count
    expect(open()?.canHide).toBe(false);
    expect(setQuestionHidden(openId(), true)).toBe(false);
    elsewhere();
  });

  it("only ever puts away the question that is on screen", () => {
    const card = mountQuestionCard("p");
    void askQuestion(question("A"), { projectDir: "p" });
    void askQuestion(question("B"), { projectDir: "p" });
    expect(setQuestionHidden(openId() + 1, true)).toBe(false); // B is still waiting
    expect(setQuestionHidden(987_654, true)).toBe(false);
    expect(open()?.hidden).toBe(false);
    card();
  });

  it("shows the next question in full, not put away", () => {
    const card = mountQuestionCard("p");
    void askQuestion(question("A"), { projectDir: "p" });
    void askQuestion(question("B"), { projectDir: "p" });
    setQuestionHidden(openId(), true);
    answerQuestion(openId(), "continue", "card");
    expect(openTitle()).toBe("B");
    expect(open()?.hidden).toBe(false);
    card();
  });

  it("comes back on its own when the last card that could carry it goes away (the chat was closed)", () => {
    const one = mountQuestionCard("p");
    const two = mountQuestionCard("p");
    void askQuestion(question("A"), { projectDir: "p" });
    setQuestionHidden(openId(), true);
    one();
    expect(open()).toMatchObject({ hidden: true, canHide: true }); // another card still has it
    two();
    expect(open()).toMatchObject({ hidden: false, canHide: false }); // nothing can: it is on screen again
    expect(openTitle()).toBe("A");
  });

  it("ignores a card that was removed twice, or after the store was reset", () => {
    const one = mountQuestionCard("p");
    const two = mountQuestionCard("p");
    one();
    one(); // a second call must not take the other card's place away
    void askQuestion(question("A"), { projectDir: "p" });
    expect(open()?.canHide).toBe(true);
    __resetExportQuestions();
    unmount = mountQuestionHost();
    void askQuestion(question("B"), { projectDir: "p" });
    two(); // stale: belongs to the world before the reset
    expect(open()?.canHide).toBe(false);
  });
});

describe("when nothing can show the question", () => {
  it("says whether a dialog is mounted to ask", () => {
    expect(hostMounted()).toBe(true);
    unmount();
    expect(hostMounted()).toBe(false);
    unmount = mountQuestionHost();
    expect(hostMounted()).toBe(true);
  });

  it("answers 'unavailable' at once when no dialog is mounted, so the caller can fall back", async () => {
    unmount();
    expect(await askQuestion(question("A"), { projectDir: "p" })).toMatchObject({
      answer: "unavailable",
    });
    expect(openTitle()).toBeNull();
  });

  it("ends every open and waiting question as 'unavailable' when the last dialog goes away", async () => {
    const second = mountQuestionHost();
    const a = askQuestion(question("A"), { projectDir: "p" });
    const b = askQuestion(question("B"), { projectDir: "p" });
    second(); // one dialog is still mounted: nothing changes
    expect(openTitle()).toBe("A");
    unmount(); // the last one: nobody can answer now
    expect(await a).toMatchObject({ answer: "unavailable" });
    expect(await b).toMatchObject({ answer: "unavailable" });
    expect(openTitle()).toBeNull();
  });
});

describe("the attention hint and the time it took", () => {
  it("asks the system to draw the eye once per question, when it appears (not while it waits)", () => {
    void askQuestion(question("A"), { projectDir: "p" });
    void askQuestion(question("B"), { projectDir: "p" });
    expect(attention.askForAttention).toHaveBeenCalledTimes(1);
    answerQuestion(openId(), "continue", "dialog");
    expect(attention.askForAttention).toHaveBeenCalledTimes(2);
  });

  it("measures how long a question was on screen, not how long it waited behind another", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const a = askQuestion(question("A"), { projectDir: "p" });
    const b = askQuestion(question("B"), { projectDir: "p" });
    vi.advanceTimersByTime(3_000);
    answerQuestion(openId(), "continue", "dialog");
    vi.advanceTimersByTime(7_000);
    answerQuestion(openId(), "cancel", "card");
    expect(((await a) as Extract<QuestionOutcome, { answer: ExportAnswer }>).waitedMs).toBe(3_000);
    expect(((await b) as Extract<QuestionOutcome, { answer: ExportAnswer }>).waitedMs).toBe(7_000);
  });
});

describe("whatever happens, every question ends exactly once and the screen shows the oldest live one", () => {
  type Op =
    | { op: "ask" }
    | { op: "answer"; answer: ExportAnswer }
    | { op: "abort"; which: number }
    | { op: "stale" }
    | { op: "hide"; hidden: boolean }
    | { op: "card"; mount: boolean };
  const ops = fc.array(
    fc.oneof(
      fc.constant<Op>({ op: "ask" }),
      fc.constantFrom<ExportAnswer>("continue", "start_anyway", "cancel").map<Op>((answer) => ({
        op: "answer",
        answer,
      })),
      fc.nat(20).map<Op>((which) => ({ op: "abort", which })),
      fc.constant<Op>({ op: "stale" }),
      fc.boolean().map<Op>((hidden) => ({ op: "hide", hidden })),
      fc.boolean().map<Op>((mount) => ({ op: "card", mount })),
    ),
    { minLength: 1, maxLength: 60 },
  );

  it("holds for any order of asking, answering, stopping, putting away and stale answers", async () => {
    await fc.assert(
      fc.asyncProperty(ops, async (sequence) => {
        __resetExportQuestions();
        const stop = mountQuestionHost();
        const cards: Array<() => void> = [];
        const live: Array<{ title: string; abort: AbortController; settled: boolean }> = [];
        const ends: Array<Promise<QuestionOutcome>> = [];
        const resolved: number[] = [];
        let counter = 0;
        for (const step of sequence) {
          if (step.op === "ask") {
            const index = counter++;
            const abort = new AbortController();
            const entry = { title: `q${index}`, abort, settled: false };
            live.push(entry);
            ends.push(
              askQuestion(question(entry.title), { projectDir: "p", signal: abort.signal }).then(
                (outcome) => {
                  resolved.push(index);
                  entry.settled = true;
                  return outcome;
                },
              ),
            );
          } else if (step.op === "answer") {
            const open = useExportQuestions.getState().open;
            if (open) answerQuestion(open.id, step.answer, "dialog");
          } else if (step.op === "abort") {
            live[step.which % Math.max(1, live.length)]?.abort.abort();
          } else if (step.op === "hide") {
            const open = useExportQuestions.getState().open;
            if (open) setQuestionHidden(open.id, step.hidden);
          } else if (step.op === "card") {
            if (step.mount) cards.push(mountQuestionCard("p"));
            else cards.pop()?.();
          } else {
            answerQuestion(999_999, "continue", "card");
          }
          await Promise.resolve();
          const alive = live.filter((entry) => !entry.settled);
          const open = useExportQuestions.getState().open;
          expect(open?.question.title ?? null).toBe(alive[0]?.title ?? null);
          // A question is never put away with nothing to carry it.
          if (open?.hidden) expect(open.canHide).toBe(true);
          expect(open?.canHide ?? cards.length > 0).toBe(cards.length > 0);
        }
        stop();
        for (const gone of cards) gone();
        const outcomes = await Promise.all(ends);
        expect(outcomes).toHaveLength(counter);
        expect(new Set(resolved).size).toBe(resolved.length); // nobody ended twice
        expect(resolved).toHaveLength(counter); // nobody was left hanging
        expect(useExportQuestions.getState().open).toBeNull();
      }),
      { numRuns: 200 },
    );
  });
});

// The folder a question may be answered with (Phase 3, S3b). The question itself carries no path (a flag
// says it has a Save to box); the folder it is about and the one the person picked live here, so the dialog
// and the card above the chat box show the same pick and either one's Continue carries it.
describe("whether a pick moves the file", () => {
  it("is true only for a pick of another folder: nothing picked, or the same folder spelled another way, moves nothing", () => {
    expect(movesTheFile(null)).toBe(false);
    expect(movesTheFile({ now: "D:/Videos", picked: null })).toBe(false);
    expect(movesTheFile({ now: "D:/Videos", picked: "E:\\Else" })).toBe(true);
    for (const same of ["D:/Videos", "d:\\videos\\", "D:\\Videos\\\\"])
      expect(movesTheFile({ now: "D:/Videos", picked: same }), same).toBe(false);
  });

  it("agrees with what Continue carries: a folder comes with the answer exactly when the pick moves the file", async () => {
    for (const picked of ["E:\\Else", "d:\\videos\\", "D:/Videos 2"]) {
      const outcome = askQuestion(
        { ...base, kind: "output_space", code: "b2", folderBox: "save_to" },
        { projectDir: "p", folderNow: "D:/Videos" },
      );
      chooseQuestionFolder(openId(), picked);
      const moves = movesTheFile(useExportQuestions.getState().open!.folder);
      answerQuestion(openId(), "continue", "dialog");
      expect(((await outcome) as { folder?: string }).folder !== undefined, picked).toBe(moves);
    }
  });
});

describe("the folder a question may be answered with", () => {
  type Done = Extract<QuestionOutcome, { answer: ExportAnswer }>;
  const boxed = (title = "B2"): ExportQuestion => ({
    ...base,
    title,
    kind: "output_space",
    code: "b2",
    folderBox: "save_to",
  });
  const ask = (q: ExportQuestion = boxed(), folderNow: string | undefined = "D:/Videos") =>
    askQuestion(q, { projectDir: "p", folderNow });
  const folderOnScreen = () => useExportQuestions.getState().open?.folder;

  it("shows where the file goes now, and no pick yet", () => {
    void ask();
    expect(folderOnScreen()).toEqual({ now: "D:/Videos", picked: null });
  });

  it("has no folder on a question without the box, whatever it is given, and refuses a pick for it", () => {
    void askQuestion(question("A"), { projectDir: "p", folderNow: "D:/Videos" });
    expect(folderOnScreen()).toBeNull();
    expect(chooseQuestionFolder(openId(), "E:/Other")).toBe(false);
  });

  it("has no folder when the asker did not say where the file goes", () => {
    void askQuestion(boxed(), { projectDir: "p" });
    expect(folderOnScreen()).toBeNull();
    expect(chooseQuestionFolder(openId(), "E:/Other")).toBe(false);
  });

  it("carries the pick to Continue, whichever surface presses it", async () => {
    for (const by of ["dialog", "card"] as const) {
      const outcome = ask();
      expect(chooseQuestionFolder(openId(), "E:/Elsewhere")).toBe(true);
      expect(folderOnScreen()).toEqual({ now: "D:/Videos", picked: "E:/Elsewhere" });
      answerQuestion(openId(), "continue", by);
      expect(await outcome).toMatchObject({ answer: "continue", by, folder: "E:/Elsewhere" });
    }
  });

  it("does not let a pick travel with Cancel or Start anyway: only Continue moves the file", async () => {
    for (const answer of ["cancel", "start_anyway"] as const) {
      const outcome = ask();
      chooseQuestionFolder(openId(), "E:/Elsewhere");
      answerQuestion(openId(), answer, "dialog");
      expect(await outcome).not.toHaveProperty("folder");
    }
  });

  it("answers Continue with no folder when nothing was picked", async () => {
    const outcome = ask();
    answerQuestion(openId(), "continue", "dialog");
    expect(await outcome).not.toHaveProperty("folder");
  });

  it("reads a pick of the folder it already has as no pick, however the path is written", async () => {
    for (const same of ["D:/Videos", "D:\\Videos", "d:/videos", "D:/Videos/", "D:\\Videos\\\\"]) {
      const outcome = ask();
      expect(chooseQuestionFolder(openId(), same)).toBe(true);
      answerQuestion(openId(), "continue", "dialog");
      expect(await outcome).not.toHaveProperty("folder");
    }
  });

  it("does not read a different folder as the same one", async () => {
    for (const other of ["D:/Videos 2", "D:/Video", "E:/Videos", "D:/Videos/Cuts", "/Videos"]) {
      const outcome = ask();
      chooseQuestionFolder(openId(), other);
      answerQuestion(openId(), "continue", "dialog");
      expect(((await outcome) as Done).folder, other).toBe(other);
    }
  });

  it("compares a drive path without regard to case, as Windows does, and any other path with it", async () => {
    const outcome = ask(boxed(), "/Users/me/Videos");
    chooseQuestionFolder(openId(), "/Users/me/videos");
    answerQuestion(openId(), "continue", "dialog");
    expect(((await outcome) as Done).folder).toBe("/Users/me/videos");
  });

  it("clears a pick when told to, refuses a blank one and leaves the old pick in that case", () => {
    void ask();
    const id = openId();
    chooseQuestionFolder(id, "E:/Elsewhere");
    expect(chooseQuestionFolder(id, "   ")).toBe(false);
    expect(chooseQuestionFolder(id, "")).toBe(false);
    expect(folderOnScreen()?.picked).toBe("E:/Elsewhere");
    expect(chooseQuestionFolder(id, null)).toBe(true);
    expect(folderOnScreen()?.picked).toBeNull();
  });

  it("keeps the pick while the question is put away and when it comes back", () => {
    const card = mountQuestionCard("p");
    void ask();
    const id = openId();
    chooseQuestionFolder(id, "E:/Elsewhere");
    expect(setQuestionHidden(id, true)).toBe(true);
    expect(folderOnScreen()?.picked).toBe("E:/Elsewhere");
    expect(setQuestionHidden(id, false)).toBe(true);
    expect(folderOnScreen()?.picked).toBe("E:/Elsewhere");
    card();
  });

  it("does not carry a pick over to the next question", async () => {
    const first = ask(boxed("first"));
    const second = ask(boxed("second"), "F:/Other");
    chooseQuestionFolder(openId(), "E:/Elsewhere");
    answerQuestion(openId(), "continue", "dialog");
    expect(await first).toMatchObject({ folder: "E:/Elsewhere" });
    expect(openTitle()).toBe("second");
    expect(folderOnScreen()).toEqual({ now: "F:/Other", picked: null });
    answerQuestion(openId(), "continue", "dialog");
    expect(await second).not.toHaveProperty("folder");
  });

  it("refuses a pick for a question that is waiting, or that has already ended", async () => {
    const first = ask(boxed("first"));
    void ask(boxed("second"));
    const shown = openId();
    expect(chooseQuestionFolder(shown + 1, "E:/Elsewhere")).toBe(false);
    answerQuestion(shown, "cancel", "dialog");
    await first;
    expect(chooseQuestionFolder(shown, "E:/Late")).toBe(false);
    expect(folderOnScreen()).toEqual({ now: "D:/Videos", picked: null });
  });

  it("lets the first answer win with ITS pick: a late Continue changes nothing", async () => {
    const outcome = ask();
    const id = openId();
    chooseQuestionFolder(id, "E:/First");
    expect(answerQuestion(id, "continue", "dialog")).toBe("accepted");
    expect(chooseQuestionFolder(id, "E:/Second")).toBe(false);
    expect(answerQuestion(id, "continue", "card")).toBe("ignored");
    expect(await outcome).toMatchObject({ by: "dialog", folder: "E:/First" });
  });

  it("holds for any pick: a folder only comes with Continue, is never blank or padded, and is never the folder it already has", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 40 }),
        fc.constantFrom<ExportAnswer>("continue", "start_anyway", "cancel"),
        async (raw, answer) => {
          __resetExportQuestions();
          const stop = mountQuestionHost();
          const outcome = ask();
          chooseQuestionFolder(openId(), raw);
          answerQuestion(openId(), answer, "dialog");
          const folder = ((await outcome) as Done).folder;
          stop();
          if (folder === undefined) return;
          expect(answer).toBe("continue");
          expect(folder).toBe(folder.trim());
          expect(folder.length).toBeGreaterThan(0);
          expect(folder.replace(/[\\/]+$/, "").toLowerCase()).not.toBe("d:/videos");
        },
      ),
      { numRuns: 100 },
    );
  });
});
