import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetExportQuestions,
  answerQuestion,
  askQuestion,
  hostMounted,
  mountQuestionCard,
  setQuestionHidden,
  useExportQuestions,
} from "../store/exportQuestionHost";
import {
  answerButtons,
  planQuestions,
  type ExportQuestion,
  type PreflightPicture,
} from "../timeline/exportQuestions";
import ExportQuestionDialog from "./ExportQuestionDialog";

vi.mock("../lib/attention", () => ({ askForAttention: vi.fn(async () => undefined) }));
const picker = vi.hoisted(() => ({
  pickFolder: vi.fn(async (_title: string, _from?: string): Promise<string | null> => null),
}));
vi.mock("../lib/pickFolder", () => picker);

const picture = (over: Partial<PreflightPicture>): PreflightPicture => ({
  via: "chat",
  count: 1,
  reasons: new Set(),
  memoryNeededBytes: 3.2e9,
  memoryUsableBytes: 1.9e9,
  spaceNeededBytes: 3.4e9,
  destinationFreeBytes: 1.2e9,
  scratchFreeBytes: 2e9,
  destinationShort: true,
  scratchShort: false,
  drive: "D:",
  movable: false,
  seconds: 1500,
  secondsGuessed: false,
  executionLimitSeconds: 28_800,
  ...over,
});
const first = (over: Partial<PreflightPicture>): ExportQuestion => planQuestions(picture(over))[0];
const MEMORY = () => first({ reasons: new Set(["memory_shortage"]) });
const SPACE = () => first({ reasons: new Set(["disk_shortage"]) });
const WARNING = () => first({ reasons: new Set(["outside_promise"]) });
const HEADS_UP = () => first({ reasons: new Set(["long"]) });

beforeEach(() => __resetExportQuestions());
afterEach(() => {
  cleanup();
  __resetExportQuestions();
  vi.useRealTimers();
});

describe("ExportQuestionDialog", () => {
  it("is a dialog mounted for as long as it is on screen, and shows nothing without a question", () => {
    expect(hostMounted()).toBe(false);
    const view = render(<ExportQuestionDialog />);
    expect(hostMounted()).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    view.unmount();
    expect(hostMounted()).toBe(false);
  });

  it("shows the memory question with what is needed, what is available and what to do", async () => {
    render(<ExportQuestionDialog />);
    void askQuestion(MEMORY(), { projectDir: "p" });
    const dialog = await screen.findByRole("dialog", { name: "Not enough free memory" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByText(/needs more memory than your PC can give it/)).toBeVisible();
    expect(within(dialog).getByText("Needed")).toBeVisible();
    expect(within(dialog).getByText("about 3.2 GB")).toBeVisible();
    expect(within(dialog).getByText("Available now")).toBeVisible();
    expect(within(dialog).getByText("about 1.9 GB")).toBeVisible();
    expect(within(dialog).getByText(/Close other programs/)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Continue" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Start anyway" })).toBeVisible();
  });

  it("answers Continue as the dialog, and the asker hears it", async () => {
    render(<ExportQuestionDialog />);
    const outcome = askQuestion(MEMORY(), { projectDir: "p" });
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await outcome).toMatchObject({ answer: "continue", by: "dialog" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("answers Start anyway and Cancel as themselves", async () => {
    vi.useFakeTimers({ now: 20_000_000, toFake: ["Date"] });
    render(<ExportQuestionDialog />);
    const start = askQuestion(MEMORY(), { projectDir: "p" });
    fireEvent.click(await screen.findByRole("button", { name: "Start anyway" }));
    expect(await start).toMatchObject({ answer: "start_anyway", by: "dialog" });
    vi.setSystemTime(20_000_000 + 1_000); // a person reading the next question, not a double-click
    const cancel = askQuestion(SPACE(), { projectDir: "p" });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await cancel).toMatchObject({ answer: "cancel", by: "dialog" });
  });

  it("treats Escape as Cancel: nothing starts", async () => {
    render(<ExportQuestionDialog />);
    const outcome = askQuestion(MEMORY(), { projectDir: "p" });
    await screen.findByRole("dialog");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await outcome).toMatchObject({ answer: "cancel", by: "dialog" });
  });

  it("does not put a button under a stray Enter: the dialog itself has the focus", async () => {
    render(<ExportQuestionDialog />);
    void askQuestion(MEMORY(), { projectDir: "p" });
    const dialog = await screen.findByRole("dialog");
    expect(document.activeElement).toBe(dialog);
  });

  it("names the drive in the space question and offers the same quiet way past", async () => {
    render(<ExportQuestionDialog />);
    void askQuestion(SPACE(), { projectDir: "p" });
    const dialog = await screen.findByRole("dialog", {
      name: "Not enough space for the exported file",
    });
    expect(within(dialog).getByText("Free on D:")).toBeVisible();
    expect(within(dialog).getByText("about 1.2 GB")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Start anyway" })).toBeVisible();
  });

  it("says 'Continue anyway' when something is known to be wrong, 'Continue' for a heads-up, and never offers Start anyway there", async () => {
    render(<ExportQuestionDialog />);
    void askQuestion(WARNING(), { projectDir: "p" });
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Continue anyway" })).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "Start anyway" })).toBeNull();
    act(() => void answerQuestion(useExportQuestions.getState().open!.id, "cancel", "card"));
    void askQuestion(HEADS_UP(), { projectDir: "p" });
    dialog = await screen.findByRole("dialog", { name: "This export will take a long time" });
    expect(within(dialog).getByRole("button", { name: "Continue" })).toBeVisible();
    expect(within(dialog).getByText(/Estimated time/)).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "Continue anyway" })).toBeNull();
  });

  it("goes away when the question is answered somewhere else, and the late click is turned down", async () => {
    render(<ExportQuestionDialog />);
    const ignored = vi.fn();
    const outcome = askQuestion(MEMORY(), { projectDir: "p", onIgnored: ignored });
    const dialog = await screen.findByRole("dialog");
    const button = within(dialog).getByRole("button", { name: "Continue" });
    const id = useExportQuestions.getState().open!.id;
    act(() => void answerQuestion(id, "cancel", "card")); // answered on the card first
    expect(await outcome).toMatchObject({ answer: "cancel", by: "card" });
    expect(screen.queryByRole("dialog")).toBeNull();
    // A click that was already on its way lands on nothing: the answer is refused, not applied.
    fireEvent.click(button);
    expect(ignored).not.toHaveBeenCalled(); // the dialog's button no longer knows the question
    expect(answerQuestion(id, "continue", "dialog")).toBe("ignored");
    expect(ignored).toHaveBeenCalledWith("continue", "dialog", "card");
  });

  it("shows the questions one after another, in the order they were asked", async () => {
    render(<ExportQuestionDialog />);
    void askQuestion(MEMORY(), { projectDir: "p" });
    void askQuestion(SPACE(), { projectDir: "p" });
    expect(await screen.findByRole("dialog", { name: "Not enough free memory" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByRole("dialog", { name: "Not enough space for the exported file" }),
    ).toBeVisible();
  });

  it("closes when the request that asked is stopped", async () => {
    render(<ExportQuestionDialog />);
    const stop = new AbortController();
    const outcome = askQuestion(MEMORY(), { projectDir: "p", signal: stop.signal });
    await screen.findByRole("dialog");
    act(() => stop.abort());
    expect(await outcome).toMatchObject({ answer: "aborted" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  describe("a double-click", () => {
    it("answers one question, not the next one that appears under the cursor", async () => {
      vi.useFakeTimers({ now: 20_000_000, toFake: ["Date"] });
      render(<ExportQuestionDialog />);
      const first = askQuestion(MEMORY(), { projectDir: "p" });
      const second = askQuestion(SPACE(), { projectDir: "p" });
      const button = await screen.findByRole("button", { name: "Continue" });
      fireEvent.click(button);
      expect(await first).toMatchObject({ answer: "continue", by: "dialog" });
      // The second click of the same double-click: the next question is already there, and is not answered.
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(
        await screen.findByRole("dialog", { name: "Not enough space for the exported file" }),
      ).toBeVisible();
      expect(useExportQuestions.getState().open?.question.title).toBe(
        "Not enough space for the exported file",
      );
      // A person who has read it answers it normally.
      vi.setSystemTime(20_000_000 + 1_000);
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(await second).toMatchObject({ answer: "continue", by: "dialog" });
    });

    it("does not stop an assistant's answer, which no click is behind", async () => {
      vi.useFakeTimers({ now: 20_000_000, toFake: ["Date"] });
      render(<ExportQuestionDialog />);
      void askQuestion(MEMORY(), { projectDir: "p" });
      const second = askQuestion(SPACE(), { projectDir: "p" });
      fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
      act(() => void answerQuestion(useExportQuestions.getState().open!.id, "cancel", "assistant"));
      expect(await second).toMatchObject({ answer: "cancel", by: "assistant" });
    });

    it("does not let Escape pressed twice cancel two questions", async () => {
      vi.useFakeTimers({ now: 20_000_000, toFake: ["Date"] });
      render(<ExportQuestionDialog />);
      const first = askQuestion(MEMORY(), { projectDir: "p" });
      void askQuestion(SPACE(), { projectDir: "p" });
      await screen.findByRole("dialog");
      fireEvent.keyDown(window, { key: "Escape" });
      fireEvent.keyDown(window, { key: "Escape" });
      expect(await first).toMatchObject({ answer: "cancel", by: "dialog" });
      expect(useExportQuestions.getState().open?.question.title).toBe(
        "Not enough space for the exported file",
      );
    });
    it("does not swallow answers when the clock steps backwards (a time sync, waking from sleep)", async () => {
      vi.useFakeTimers({ now: 20_000_000, toFake: ["Date"] });
      render(<ExportQuestionDialog />);
      const first = askQuestion(MEMORY(), { projectDir: "p" });
      fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
      expect(await first).toMatchObject({ answer: "continue", by: "dialog" });
      vi.setSystemTime(20_000_000 - 60_000); // the clock was corrected a minute backwards
      const second = askQuestion(SPACE(), { projectDir: "p" });
      fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
      expect(await second).toMatchObject({ answer: "cancel", by: "dialog" });
    });
  });

  describe("putting it away to answer from the chat", () => {
    const overlay = (): HTMLElement => {
      const layer = document.createElement("div");
      layer.className = "fixed inset-0 z-[100]"; // the Export dialog, a settings box: a full-screen layer
      document.body.appendChild(layer);
      return layer;
    };

    it("is not offered while another full-screen layer would sit on top of the chat and hide the card", async () => {
      const layer = overlay();
      try {
        render(<ExportQuestionDialog />);
        let card!: () => void;
        act(() => {
          card = mountQuestionCard("p");
        });
        void askQuestion(MEMORY(), { projectDir: "p" });
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).queryByRole("button", { name: "Answer in chat" })).toBeNull();
        expect(useExportQuestions.getState().open).toMatchObject({ hidden: false });
        act(() => card());
      } finally {
        layer.remove();
      }
    });

    it("is offered when no other layer is up, and a click is refused if one has opened since", async () => {
      render(<ExportQuestionDialog />);
      let card!: () => void;
      act(() => {
        card = mountQuestionCard("p");
      });
      void askQuestion(MEMORY(), { projectDir: "p" });
      const button = await screen.findByRole("button", { name: "Answer in chat" });
      const layer = overlay(); // opened between the dialog being drawn and the click
      try {
        fireEvent.click(button);
        expect(screen.getByRole("dialog")).toBeVisible(); // still here: the card would be covered
        expect(useExportQuestions.getState().open).toMatchObject({ hidden: false });
      } finally {
        layer.remove();
      }
      fireEvent.click(button);
      expect(useExportQuestions.getState().open).toMatchObject({ hidden: true });
      act(() => card());
    });
    it("is offered when a card above the chat box can carry the question, and not otherwise", async () => {
      render(<ExportQuestionDialog />);
      void askQuestion(MEMORY(), { projectDir: "p" });
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).queryByRole("button", { name: "Answer in chat" })).toBeNull();
      let card!: () => void;
      act(() => {
        card = mountQuestionCard("p");
      });
      expect(within(dialog).getByRole("button", { name: "Answer in chat" })).toBeVisible();
      act(() => card());
      expect(within(dialog).queryByRole("button", { name: "Answer in chat" })).toBeNull();
    });

    it("takes the dialog away without answering, and brings it back with the focus on it", async () => {
      render(<ExportQuestionDialog />);
      let card!: () => void;
      act(() => {
        card = mountQuestionCard("p");
      });
      const outcome = askQuestion(MEMORY(), { projectDir: "p" });
      const settled = vi.fn();
      void outcome.then(settled);
      fireEvent.click(await screen.findByRole("button", { name: "Answer in chat" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled(); // nothing was answered
      expect(useExportQuestions.getState().open).toMatchObject({ hidden: true });
      // Escape is for the dialog on screen: pressed while it is put away it must not cancel an export.
      fireEvent.keyDown(window, { key: "Escape" });
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      act(() => void setQuestionHidden(useExportQuestions.getState().open!.id, false));
      const dialog = await screen.findByRole("dialog");
      expect(document.activeElement).toBe(dialog);
      fireEvent.keyDown(window, { key: "Escape" });
      expect(await outcome).toMatchObject({ answer: "cancel", by: "dialog" });
      act(() => card());
    });
  });

  describe("the buttons", () => {
    it("are in the order the question lists them, whatever the question", async () => {
      render(<ExportQuestionDialog />);
      for (const make of [MEMORY, SPACE, WARNING, HEADS_UP]) {
        const q = make();
        act(() => void askQuestion(q, { projectDir: "p" }));
        const dialog = await screen.findByRole("dialog", { name: q.title });
        const shown = within(dialog)
          .getAllByRole("button")
          .map((button) => button.textContent);
        expect(shown).toEqual(answerButtons(q).map((button) => button.label));
        act(() => void answerQuestion(useExportQuestions.getState().open!.id, "cancel", "card"));
      }
    });
  });
});

// The Save to box (Phase 3, S3b): the question about the room for the exported file lets the person pick
// another folder. The pick is the host's (the card shows the same one); Continue carries it.
describe("ExportQuestionDialog: the Save to box", () => {
  const BOXED = () => first({ reasons: new Set(["disk_shortage"]), movable: true });
  const ask = (q: ExportQuestion = BOXED(), folderNow: string | undefined = "D:/Videos") =>
    askQuestion(q, { projectDir: "p", folderNow });

  beforeEach(() => picker.pickFolder.mockReset());

  it("shows where the video goes now and a Browse button, on the question that has the box, and no free-text field", async () => {
    render(<ExportQuestionDialog />);
    void ask();
    const dialog = await screen.findByRole("dialog", {
      name: "Not enough space for the exported file",
    });
    const row = within(dialog).getByRole("group", { name: "Save to" });
    expect(within(row).getByText("D:\\Videos")).toBeVisible();
    expect(within(row).getByRole("button", { name: /Browse/ })).toBeVisible();
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(within(dialog).getByText(/save the video somewhere else/i)).toBeVisible();
  });

  it("shows no such row on a question without the box, or when the asker did not say where the file goes", async () => {
    render(<ExportQuestionDialog />);
    void askQuestion(SPACE(), { projectDir: "p", folderNow: "D:/Videos" });
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("group", { name: "Save to" })).toBeNull();
    act(() => void answerQuestion(useExportQuestions.getState().open!.id, "cancel", "card"));
    void askQuestion(BOXED(), { projectDir: "p" });
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("group", { name: "Save to" })).toBeNull();
  });

  it("shows the folder the person picks, starts the picker where the file was going, and answers Continue with it", async () => {
    picker.pickFolder.mockResolvedValueOnce("E:\\Elsewhere");
    render(<ExportQuestionDialog />);
    const outcome = ask();
    fireEvent.click(await screen.findByRole("button", { name: /Browse/ }));
    expect(await screen.findByText("E:\\Elsewhere")).toBeVisible();
    expect(picker.pickFolder).toHaveBeenCalledWith(expect.any(String), "D:/Videos");
    expect(screen.queryByText("D:\\Videos")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await outcome).toMatchObject({
      answer: "continue",
      by: "dialog",
      folder: "E:\\Elsewhere",
    });
  });

  it("changes nothing when the picker is closed without a choice, or cannot open", async () => {
    render(<ExportQuestionDialog />);
    const outcome = ask();
    picker.pickFolder.mockResolvedValueOnce(null);
    fireEvent.click(await screen.findByRole("button", { name: /Browse/ }));
    await act(async () => undefined);
    expect(screen.getByText("D:\\Videos")).toBeVisible();
    picker.pickFolder.mockRejectedValueOnce(new Error("no dialog"));
    fireEvent.click(screen.getByRole("button", { name: /Browse/ }));
    await act(async () => undefined);
    expect(screen.getByText("D:\\Videos")).toBeVisible();
    // and the question is still there to be answered
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await outcome) as object).not.toHaveProperty("folder");
  });

  it("does not offer Start anyway once another folder is picked: that link was about the folder it was going to", async () => {
    picker.pickFolder.mockResolvedValueOnce("E:\\Elsewhere");
    render(<ExportQuestionDialog />);
    void ask();
    expect(await screen.findByRole("button", { name: "Start anyway" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Browse/ }));
    await screen.findByText("E:\\Elsewhere");
    expect(screen.queryByRole("button", { name: "Start anyway" })).toBeNull();
  });

  it("lets the person take a pick back: Undo shows the folder it was going to again, and Start anyway comes back with it", async () => {
    picker.pickFolder.mockResolvedValueOnce("E:\\Elsewhere");
    render(<ExportQuestionDialog />);
    const outcome = ask();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull(); // nothing to take back yet
    fireEvent.click(await screen.findByRole("button", { name: /Browse/ }));
    await screen.findByText("E:\\Elsewhere");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("D:\\Videos")).toBeVisible();
    expect(screen.queryByText("E:\\Elsewhere")).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.getByRole("button", { name: "Start anyway" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await outcome) as object).not.toHaveProperty("folder"); // nothing moves
  });

  it("does not treat a pick of the folder it was already going to as moving the file: Start anyway stays, and there is nothing to undo", async () => {
    picker.pickFolder.mockResolvedValueOnce("d:\\videos\\");
    render(<ExportQuestionDialog />);
    void ask();
    fireEvent.click(await screen.findByRole("button", { name: /Browse/ }));
    await screen.findByText("d:\\videos\\");
    expect(screen.getByRole("button", { name: "Start anyway" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("answers Cancel with no folder, whatever was picked", async () => {
    picker.pickFolder.mockResolvedValueOnce("E:\\Elsewhere");
    render(<ExportQuestionDialog />);
    const outcome = ask();
    fireEvent.click(await screen.findByRole("button", { name: /Browse/ }));
    await screen.findByText("E:\\Elsewhere");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const done = await outcome;
    expect(done).toMatchObject({ answer: "cancel" });
    expect(done).not.toHaveProperty("folder");
  });

  it("starts the next question from its own folder, not from the pick made for the one before", async () => {
    picker.pickFolder.mockResolvedValueOnce("E:\\Elsewhere");
    render(<ExportQuestionDialog />);
    const firstAnswer = ask(BOXED(), "D:/Videos");
    void ask(BOXED(), "F:/Other");
    fireEvent.click(await screen.findByRole("button", { name: /Browse/ }));
    await screen.findByText("E:\\Elsewhere");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await firstAnswer;
    expect(await screen.findByText("F:\\Other")).toBeVisible();
    expect(screen.queryByText("E:\\Elsewhere")).toBeNull();
  });
});
