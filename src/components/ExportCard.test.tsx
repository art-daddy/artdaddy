// The export card above the chat box, driven through the real queue, the real live feed and the real
// question store. What matters is what a person who started an export from the CHAT (or whose assistant
// did) can see: that it is running and how far, that it is waiting its turn, that it needs an answer,
// and how it ended. None of that was visible before: the Export dialog's own job is begun only by the
// menu, so an export started from anywhere else moved no bar at all.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ExportCard from "./ExportCard";
import {
  __resetExportQuestions,
  answerQuestion,
  askQuestion,
  mountQuestionHost,
  setQuestionHidden,
  useExportQuestions,
} from "../store/exportQuestionHost";
import { useEditor } from "../store/editor";
import { useExportJob } from "../store/exportJob";
import { __setExportFlag } from "../api/exportFlags";
import {
  __resetExportQueue,
  listExportRecords,
  offerExportRetry,
  submitExport,
  whenExportsSettle,
} from "../timeline/exportQueue";
import { answerButtons, planQuestions } from "../timeline/exportQuestions";
import { ExportMemFs } from "../test/timelineKit";
import { FakeJobs } from "../test/fakeJobs";
import { ProjectStoreAccess } from "../tools/store";

vi.mock("../tools/genJobs", () => ({
  openProjectJobs: async () => ({
    begin: async () => `job-${Math.random().toString(36).slice(2, 8)}`,
    settle: async () => undefined,
  }),
}));
vi.mock("../store/jobNotes", () => ({ notifyJobSettled: () => undefined }));
vi.mock("../lib/attention", () => ({ askForAttention: vi.fn(async () => undefined) }));

let fs: ExportMemFs;
let store: ProjectStoreAccess;
const gates: Array<() => void> = [];

/** An encode that only finishes when we say so, so a running and a waiting export can be looked at. */
function gated() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  gates.push(release);
  return { wait: () => gate, open: () => release() };
}

const AGENT = { chatSessionId: "t1", branchId: 0, executionId: 1 };

function start(
  filename: string,
  run: (signal: AbortSignal) => Promise<unknown>,
  over: {
    store?: ProjectStoreAccess;
    fs?: ExportMemFs;
    rung?: 1 | 2;
    /** How the encoder was chosen (exportChoice.ts); the normal setting when left out. */
    encoder?: "x264" | "x264_fast" | "amd" | "nvidia" | "intel";
    reason?: "over_minute" | "person" | "promise_line" | "none";
  } = {},
) {
  const useStore = over.store ?? store;
  const useFs = over.fs ?? fs;
  return submitExport({
    store: useStore,
    dependencies: [],
    destPath: `/out/${filename}`,
    stagePath: `/out/${filename}.partial`,
    filename,
    origin: AGENT, // the chat asked: the Export dialog's own job is not begun
    ...(over.rung || over.encoder
      ? {
          meta: {
            duration_s: 10,
            width: 1920,
            height: 1080,
            fps: 30,
            quality: "medium",
            project_id: "",
            ...(over.rung ? { plan: { rung: over.rung } } : {}),
            ...(over.encoder
              ? {
                  choice: {
                    encoder: over.encoder,
                    reason: over.reason ?? "over_minute",
                    tests: [],
                    adapter: { maker: "amd" as const, device: "15bf", driver: "32.0.1" },
                  },
                }
              : {}),
          },
        }
      : {}),
    run: async (signal) => {
      await run(signal);
      await useFs.writeTextFile(`/out/${filename}.partial`, `encoded ${filename}`);
      return {};
    },
  }).then(async (sub) => {
    // An export that is at the head of the queue begins its run a moment after it is submitted: let it.
    if (sub.queue_position === 0)
      for (let turn = 0; turn < 50 && useExportJob.getState().live?.jobId !== sub.job_id; turn++)
        await Promise.resolve();
    return sub;
  });
}

const status = () => screen.getByTestId("export-card-status").textContent;
const report = (over: Partial<Parameters<ReturnType<typeof useExportJob.getState>["update"]>[0]>) =>
  act(() => useExportJob.getState().update({ phase: "rendering", ...over }));

beforeEach(() => {
  __resetExportQueue();
  __resetExportQuestions();
  fs = new ExportMemFs();
  store = new ProjectStoreAccess("/proj", fs);
  useExportJob.getState().reset();
  useExportJob.setState({ live: null, finishing: {} });
  useEditor.setState({ projectId: "p", store });
});
afterEach(async () => {
  cleanup();
  for (const release of gates.splice(0)) release();
  await whenExportsSettle();
  __resetExportQueue();
  __resetExportQuestions();
  vi.useRealTimers();
  useEditor.setState({ projectId: null, store: null });
});

describe("ExportCard", () => {
  it("shows nothing until something about an export is worth saying", () => {
    const { container } = render(<ExportCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows an export the CHAT started: its name, a bar and a line saying where it is, with no menu involved", async () => {
    const g = gated();
    await start("one.mp4", g.wait);
    render(<ExportCard />);
    expect(useExportJob.getState().phase).toBe("idle"); // the dialog's job was never begun
    expect(screen.getByText("Exporting “one.mp4”")).toBeVisible();
    expect(status()).toBe("Preparing · checking your clips");
    // ffmpeg starts reporting, the way render.ts publishes it.
    report({ fraction: 0.4, etaSec: 90, speed: 1, frame: 120 });
    act(() =>
      useExportJob.getState().setLiveStage(useExportJob.getState().live!.jobId, "rendering"),
    );
    expect(status()).toBe("Rendering and encoding · 40% · about 2 min left");
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "40");
    g.open();
  });

  it("says, under the status line, when an export runs below the normal setting, and why", async () => {
    const g = gated();
    await start("one.mp4", g.wait, { rung: 1 });
    await start("two.mp4", g.wait, { rung: 2 });
    render(<ExportCard />);
    expect(
      screen.getByText(
        "Using a gentler setting to fit this PC's memory · it may take a little longer",
      ),
    ).toBeVisible();
    g.open();
    await whenExportsSettle();
  });

  it("says nothing of the sort for an export at the normal setting", async () => {
    const g = gated();
    await start("one.mp4", g.wait);
    render(<ExportCard />);
    expect(screen.queryByText(/gentler setting|gentlest setting/)).toBeNull();
    expect(screen.queryByText(/graphics chip|faster setting/)).toBeNull();
    g.open();
  });

  it.each([
    [
      "the graphics chip, chosen by the app",
      "amd",
      "over_minute",
      "Using your graphics chip to save time · the file is larger and the picture can differ slightly",
    ],
    [
      "the graphics chip, picked by the person",
      "nvidia",
      "person",
      "Using your graphics chip · the file is larger and the picture can differ slightly",
    ],
    [
      "the faster setting",
      "x264_fast",
      "promise_line",
      "Using a faster setting to save time · the picture may be slightly softer",
    ],
  ] as const)(
    "says, under the status line, what an export runs on, and why: %s",
    async (_name, encoder, reason, line) => {
      const g = gated();
      await start("one.mp4", g.wait, { encoder, reason });
      render(<ExportCard />);
      expect(screen.getByText(line)).toBeVisible();
      g.open();
    },
  );

  it("says nothing about the encoder for an export on the processor's normal setting, even when the app recorded that", async () => {
    const g = gated();
    await start("one.mp4", g.wait, { encoder: "x264", reason: "none" });
    render(<ExportCard />);
    expect(screen.queryByText(/graphics chip|faster setting/)).toBeNull();
    g.open();
  });

  it("draws a bar that is not a number yet, rather than claiming nothing has happened", async () => {
    const g = gated();
    await start("one.mp4", g.wait);
    render(<ExportCard />);
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
    g.open();
  });

  describe("a line that is refreshed by a clock", () => {
    it("says how long it has been at it, at least once a minute, even when nothing new was reported", async () => {
      vi.useFakeTimers({ now: 5_000_000, toFake: ["Date", "setInterval", "clearInterval"] });
      const g = gated();
      await start("one.mp4", g.wait);
      render(<ExportCard />);
      report({ fraction: 0.2, etaSec: 300, frame: 10 });
      act(() =>
        useExportJob.getState().setLiveStage(useExportJob.getState().live!.jobId, "rendering"),
      );
      expect(status()).toBe("Rendering and encoding · 20% · about 5 min left");
      // It keeps moving, a block every 20 s, for three minutes.
      for (let second = 20; second <= 190; second += 20) {
        vi.setSystemTime(5_000_000 + second * 1000);
        report({ fraction: 0.2 + second / 1000, etaSec: 300 - second, frame: 10 + second });
        act(() => void vi.advanceTimersByTime(10_000));
      }
      expect(status()).toContain("Still working · 3 min in");
      g.open();
    });

    it("says there is no progress, for how long, and goes back to normal when it moves again", async () => {
      vi.useFakeTimers({ now: 5_000_000, toFake: ["Date", "setInterval", "clearInterval"] });
      const g = gated();
      await start("one.mp4", g.wait);
      render(<ExportCard />);
      report({ fraction: 0.38, etaSec: 100, frame: 100 });
      act(() =>
        useExportJob.getState().setLiveStage(useExportJob.getState().live!.jobId, "rendering"),
      );
      // The same block over and over for 75 s: ffmpeg is printing, but nothing is happening.
      for (let second = 10; second <= 75; second += 5) {
        vi.setSystemTime(5_000_000 + second * 1000);
        report({ fraction: 0.38, etaSec: 100, frame: 100 });
      }
      act(() => void vi.advanceTimersByTime(10_000));
      expect(status()).toMatch(/^No progress for 8\d s · Rendering and encoding · 38%$/);
      expect(status()).not.toMatch(/retry|gentler/i);
      vi.setSystemTime(5_000_000 + 90_000);
      report({ fraction: 0.39, etaSec: 99, frame: 101 }); // it moved
      expect(status()).toMatch(/^Still working · 1 min in · Rendering and encoding · 39%/);
      g.open();
    });
  });

  describe("exports waiting their turn", () => {
    it("lists each under the running one with its place in line, and each can be cancelled", async () => {
      const g = gated();
      await start("one.mp4", g.wait);
      await start("two.mp4", async () => undefined);
      await start("three.mp4", async () => undefined);
      render(<ExportCard />);
      expect(screen.getByText("Waiting · 1st in line · two.mp4")).toBeVisible();
      expect(screen.getByText("Waiting · 2nd in line · three.mp4")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "cancel two.mp4" }));
      // As soon as the cancel is accepted: it says it is cancelling, the button is gone, and the one
      // behind it moves up.
      expect(await screen.findByText("Cancelling · two.mp4")).toBeVisible();
      expect(screen.queryByRole("button", { name: "cancel two.mp4" })).toBeNull();
      expect(screen.getByText("Waiting · 1st in line · three.mp4")).toBeVisible();
      g.open();
      await whenExportsSettle();
      expect(await fs.exists("/out/two.mp4")).toBe(false);
    });

    it("cancels the running export from its own card, and says it is cancelling until it has stopped", async () => {
      const g = gated();
      let aborted = false;
      await start("one.mp4", async (signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        await g.wait();
        if (signal.aborted) throw new Error("export cancelled");
      });
      render(<ExportCard />);
      fireEvent.click(screen.getByRole("button", { name: "cancel one.mp4" }));
      await waitFor(() => expect(status()).toBe("Cancelling…"));
      expect(screen.queryByRole("button", { name: "cancel one.mp4" })).toBeNull();
      g.open();
      await whenExportsSettle();
      expect(aborted).toBe(true);
      expect(await fs.exists("/out/one.mp4")).toBe(false);
    });
  });

  describe("how an export ended", () => {
    it("says what was exported and how long it took, and goes away by itself after a minute", async () => {
      vi.useFakeTimers({ now: 5_000_000, toFake: ["Date", "setInterval", "clearInterval"] });
      await start("one.mp4", async () => {
        vi.setSystemTime(5_000_000 + 252_000);
      });
      await whenExportsSettle();
      render(<ExportCard />);
      expect(screen.getByText("Exported “one.mp4”")).toBeVisible();
      expect(screen.getByText("Took 4 min 12 s")).toBeVisible();
      act(() => {
        vi.setSystemTime(5_000_000 + 252_000 + 61_000);
        vi.advanceTimersByTime(10_000);
      });
      expect(screen.queryByText("Exported “one.mp4”")).toBeNull();
    });

    it("keeps a failed export on the card, with the reason in plain words, until it is dismissed", async () => {
      vi.useFakeTimers({ now: 5_000_000, toFake: ["Date", "setInterval", "clearInterval"] });
      await start("one.mp4", async () => {
        throw new Error("Error while filtering: Cannot allocate memory");
      });
      await whenExportsSettle();
      render(<ExportCard />);
      expect(screen.getByText("Export stopped")).toBeVisible();
      expect(
        screen.getByText("Your PC ran short of memory. Close other programs and try again."),
      ).toBeVisible();
      expect(screen.queryByText(/Cannot allocate/)).toBeNull(); // no ffmpeg words
      act(() => {
        vi.setSystemTime(5_000_000 + 10 * 60_000);
        vi.advanceTimersByTime(10_000);
      });
      expect(screen.getByText("Export stopped")).toBeVisible(); // still there after ten minutes
      fireEvent.click(screen.getByRole("button", { name: "dismiss one.mp4" }));
      expect(screen.queryByText("Export stopped")).toBeNull();
    });

    it("says a cancelled export was cancelled", async () => {
      const g = gated();
      const first = await start("one.mp4", async (signal) => {
        signal.addEventListener("abort", () => g.open());
        await g.wait();
        if (signal.aborted) throw new Error("export cancelled");
      });
      render(<ExportCard />);
      fireEvent.click(screen.getByRole("button", { name: "cancel one.mp4" }));
      await whenExportsSettle();
      expect(first.job_id).toBeTruthy();
      expect(screen.getByText("Export cancelled")).toBeVisible();
    });
  });

  describe("Try again on a failed export", () => {
    const failing = (error: string, rung?: 1 | 2) =>
      start(
        "one.mp4",
        async () => {
          throw new Error(error);
        },
        rung ? { rung } : {},
      );
    const MEMORY = "Error while filtering: Cannot allocate memory";

    it("offers one click, says what it will do, and the failed row goes once the new export is started", async () => {
      const sub = await failing(MEMORY);
      const asked: number[] = [];
      offerExportRetry(sub.job_id, async (rung) => {
        asked.push(rung);
        return { ok: true };
      });
      await whenExportsSettle();
      render(<ExportCard />);
      expect(
        screen.getByText(
          "Try again uses a gentler setting: it needs less memory and may take longer.",
        ),
      ).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "try again one.mp4" }));
      await waitFor(() => expect(screen.queryByText("Export stopped")).toBeNull());
      expect(asked).toEqual([1]);
    });

    it("says the lightest setting was already the one that failed, instead of promising a lighter run", async () => {
      const sub = await failing(MEMORY, 2);
      offerExportRetry(sub.job_id, async () => ({ ok: true }));
      await whenExportsSettle();
      render(<ExportCard />);
      expect(screen.getByText(/already running at its lightest setting/)).toBeVisible();
      expect(screen.queryByText(/needs less memory/)).toBeNull();
    });

    it("promises nothing gentler for an export that has no gentler rung, nor while the switch for rungs is off", async () => {
      const sub = await failing(MEMORY);
      offerExportRetry(sub.job_id, async () => ({ ok: true }));
      await whenExportsSettle();
      // The plan said this export has only its normal rung (the streamed engine, say): it is already the lightest.
      const row = listExportRecords().find((r) => r.job_id === sub.job_id)!;
      expect(row.maxRung).toBeUndefined();
      cleanup();
      __setExportFlag("plan_rung", false);
      try {
        render(<ExportCard />);
        expect(screen.getByText(/already running at its lightest setting/)).toBeVisible();
        expect(screen.queryByText(/gentler setting/)).toBeNull();
      } finally {
        __setExportFlag("plan_rung", true);
      }
    });

    it("says nothing about a gentler setting after a failure that one would not touch", async () => {
      const sub = await failing("ENOSPC: no space left on device");
      offerExportRetry(sub.job_id, async () => ({ ok: true }));
      await whenExportsSettle();
      render(<ExportCard />);
      expect(screen.getByRole("button", { name: "try again one.mp4" })).toBeVisible();
      expect(screen.queryByText(/gentler setting|gentlest setting/)).toBeNull();
    });

    describe("after the graphics chip stopped the export", () => {
      const onChip = (error: string) =>
        start(
          "one.mp4",
          async () => {
            throw new Error(error);
          },
          { encoder: "amd", reason: "over_minute" },
        );
      const DRIVER =
        "native render failed: [h264_amf @ 0000028f] Error submitting video frame to the encoder";

      it("says so, promises the processor, and Try again asks for it from its normal setting", async () => {
        const sub = await onChip(DRIVER);
        const asked: Array<[number, boolean | undefined]> = [];
        offerExportRetry(sub.job_id, async (rung, _failed, options) => {
          asked.push([rung, options.processor]);
          return { ok: true };
        });
        await whenExportsSettle();
        render(<ExportCard />);
        expect(
          screen.getByText(
            "The graphics chip stopped this export. Try again uses the processor instead, which takes longer.",
          ),
        ).toBeVisible();
        expect(screen.queryByText(/gentler setting/)).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "try again one.mp4" }));
        await waitFor(() => expect(screen.queryByText("Export stopped")).toBeNull());
        expect(asked).toEqual([[0, true]]);
      });

      it("tells an export that has no Try again (a clip on its own, or one a restarted app finished) what to do instead", async () => {
        await onChip(DRIVER); // no way to start it again was offered
        await whenExportsSettle();
        render(<ExportCard />);
        expect(
          screen.getByText(
            "The graphics chip stopped this export. Export it again and the processor will be used, which takes longer.",
          ),
        ).toBeVisible();
        expect(screen.queryByRole("button", { name: "try again one.mp4" })).toBeNull();
      });

      it("does not blame the chip for a failure that is the PC's memory: that one still asks for a gentler setting on the same chip", async () => {
        const sub = await onChip(MEMORY);
        const asked: Array<[number, boolean | undefined]> = [];
        offerExportRetry(sub.job_id, async (rung, _failed, options) => {
          asked.push([rung, options.processor]);
          return { ok: true };
        });
        await whenExportsSettle();
        render(<ExportCard />);
        expect(screen.queryByText(/graphics chip stopped/)).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "try again one.mp4" }));
        await waitFor(() => expect(screen.queryByText("Export stopped")).toBeNull());
        expect(asked).toEqual([[1, undefined]]);
      });
    });

    it("is not offered when there is no way to start that export again", async () => {
      await failing(MEMORY);
      await whenExportsSettle();
      render(<ExportCard />);
      expect(screen.getByText("Export stopped")).toBeVisible();
      expect(screen.queryByRole("button", { name: "try again one.mp4" })).toBeNull();
      expect(screen.queryByText(/Try again uses/)).toBeNull();
    });

    it("says it is starting and cannot be pressed twice while the new export is being started", async () => {
      const sub = await failing(MEMORY);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const asked: number[] = [];
      offerExportRetry(sub.job_id, async (rung) => {
        asked.push(rung);
        await held;
        return { ok: true };
      });
      await whenExportsSettle();
      render(<ExportCard />);
      const button = screen.getByRole("button", { name: "try again one.mp4" });
      fireEvent.click(button);
      await waitFor(() => expect(button).toBeDisabled());
      expect(button).toHaveTextContent("Starting…");
      fireEvent.click(button);
      release();
      await waitFor(() => expect(screen.queryByText("Export stopped")).toBeNull());
      expect(asked).toEqual([1]);
    });

    it("keeps the failed row and says why when the new export was refused, and the button works again", async () => {
      const sub = await failing(MEMORY);
      offerExportRetry(sub.job_id, async () => ({
        ok: false,
        error: "an export to one.mp4 is already queued or running",
      }));
      await whenExportsSettle();
      render(<ExportCard />);
      fireEvent.click(screen.getByRole("button", { name: "try again one.mp4" }));
      expect(
        await screen.findByText(/Could not start again: an export to one.mp4 is already queued/),
      ).toBeVisible();
      expect(screen.getByRole("button", { name: "try again one.mp4" })).toBeEnabled();
      expect(screen.getByText("Export stopped")).toBeVisible();
    });
  });

  describe("only the open project's exports", () => {
    it("does not show another project's export, and shows it when that project is open", async () => {
      const otherFs = new ExportMemFs();
      const other = new ProjectStoreAccess("/other", otherFs);
      const g = gated();
      await start("theirs.mp4", g.wait, { store: other, fs: otherFs });
      const { container } = render(<ExportCard />);
      expect(container).toBeEmptyDOMElement();
      act(() => useEditor.setState({ projectId: "q", store: other }));
      expect(screen.getByText("Exporting “theirs.mp4”")).toBeVisible();
      g.open();
    });
  });

  describe("a question that needs the person", () => {
    const questionOf = (reasons: string[]) =>
      planQuestions({
        via: "chat",
        count: 1,
        reasons: new Set(reasons) as never,
        memoryNeededBytes: 3.2e9,
        memoryUsableBytes: 1.9e9,
        spaceNeededBytes: 3.4e9,
        destinationFreeBytes: 1.2e9,
        scratchFreeBytes: 2e9,
        destinationShort: true,
        scratchShort: false,
        drive: "D:",
        seconds: 1500,
        secondsGuessed: false,
        executionLimitSeconds: 28_800,
      })[0];
    const question = () => questionOf(["memory_shortage"]);
    const putAway = () =>
      act(() => void setQuestionHidden(useExportQuestions.getState().open!.id, true));
    // The app mounts the dialog, which is what asks. The card carries the question only once the person
    // puts the dialog away: the dialog is modal, so a card under it could never be clicked.
    beforeEach(async () => {
      mountQuestionHost();
    });

    it("is not shown while the dialog is showing it", async () => {
      const { container } = render(<ExportCard />);
      void askQuestion(question(), { projectDir: "/proj" });
      await act(async () => undefined);
      expect(screen.queryByRole("group", { name: "export question" })).toBeNull();
      expect(container).toBeEmptyDOMElement();
    });

    it("is shown in short form with the same buttons once the dialog is put away, and answering there answers it for everyone", async () => {
      render(<ExportCard />);
      const outcome = askQuestion(question(), { projectDir: "/proj" });
      await act(async () => undefined);
      putAway();
      const box = await screen.findByRole("group", { name: "export question" });
      expect(within(box).getByText("Not enough free memory")).toBeVisible();
      expect(within(box).getByText(/Needed about 3\.2 GB/)).toBeVisible();
      expect(within(box).getByText(/Available now about 1\.9 GB/)).toBeVisible();
      fireEvent.click(within(box).getByRole("button", { name: "Continue" }));
      expect(await outcome).toMatchObject({ answer: "continue", by: "card" });
      expect(screen.queryByRole("group", { name: "export question" })).toBeNull();
    });

    it("offers Start anyway where the dialog does, and Cancel as a quiet way out", async () => {
      render(<ExportCard />);
      const outcome = askQuestion(question(), { projectDir: "/proj" });
      await act(async () => undefined);
      putAway();
      const box = await screen.findByRole("group", { name: "export question" });
      fireEvent.click(within(box).getByRole("button", { name: "Start anyway" }));
      expect(await outcome).toMatchObject({ answer: "start_anyway", by: "card" });
    });

    it("has a way back to the dialog, which shows the same question again", async () => {
      render(<ExportCard />);
      void askQuestion(question(), { projectDir: "/proj" });
      await act(async () => undefined);
      putAway();
      const box = await screen.findByRole("group", { name: "export question" });
      fireEvent.click(within(box).getByRole("button", { name: "Show dialog" }));
      expect(useExportQuestions.getState().open).toMatchObject({ hidden: false });
      expect(screen.queryByRole("group", { name: "export question" })).toBeNull();
    });

    it("has its buttons in the order the question lists them, whatever the question", async () => {
      render(<ExportCard />);
      for (const reasons of [
        ["memory_shortage"],
        ["disk_shortage"],
        ["long"],
        ["outside_promise"],
      ]) {
        const q = questionOf(reasons);
        act(() => void askQuestion(q, { projectDir: "/proj" }));
        putAway();
        const box = await screen.findByRole("group", { name: "export question" });
        const shown = within(box)
          .getAllByRole("button")
          .map((button) => button.textContent)
          .filter((text) => text !== "Show dialog");
        expect(shown).toEqual(answerButtons(q).map((button) => button.label));
        act(() => void answerQuestion(useExportQuestions.getState().open!.id, "cancel", "card"));
      }
    });

    it("brings the dialog back when the chat is closed with the question put away (nothing is left to carry it)", async () => {
      const view = render(<ExportCard />);
      void askQuestion(question(), { projectDir: "/proj" });
      await act(async () => undefined);
      putAway();
      expect(useExportQuestions.getState().open).toMatchObject({ hidden: true });
      view.unmount();
      expect(useExportQuestions.getState().open).toMatchObject({ hidden: false, canHide: false });
    });

    it("does not show another project's question, and cannot be asked to put it away", async () => {
      const { container } = render(<ExportCard />);
      void askQuestion(question(), { projectDir: "/somewhere/else" });
      await act(async () => undefined);
      expect(container).toBeEmptyDOMElement();
      expect(useExportQuestions.getState().open?.canHide).toBe(false);
    });
  });

  describe("exports that overlap: one is still being checked while the next one renders", () => {
    it("shows each with its own line and bar, so neither is hidden and neither is left on 'Working…'", async () => {
      const jobs = new FakeJobs();
      let finishCheck!: () => void;
      const checking = new Promise<void>((resolve) => (finishCheck = resolve));
      gates.push(() => finishCheck());
      let finishSecond!: () => void;
      const secondRuns = new Promise<void>((resolve) => (finishSecond = resolve));
      gates.push(() => finishSecond());
      let secondQueued!: () => void;
      const queued = new Promise<void>((resolve) => (secondQueued = resolve));
      const block = (frame: number, outMs: number) =>
        `frame=${frame}\nfps=30\nout_time_us=${outMs * 1000}\nspeed=1.0x\nprogress=continue\n`;
      const spec = (name: string, run: (id: string) => Promise<void>) => ({
        store,
        supervisor: jobs,
        dependencies: [],
        origin: AGENT,
        destPath: `/out/${name}`,
        stagePath: `/out/${name}.partial`,
        filename: name,
        run: async (_signal: AbortSignal, id: string) => {
          await jobs.submit({ id, lane: "measurement", program: "ffmpeg", args: [], meta: {} });
          await run(id);
          await fs.writeTextFile(`/out/${name}.partial`, `encoded ${name}`);
          return {};
        },
      });
      const first = await submitExport(
        spec("first.mp4", async (id) => {
          jobs.stdout(id, block(1800, 60_000));
          act(() =>
            useExportJob.getState().update({ fraction: 1, etaSec: 0, frame: 1800, speed: 1 }),
          );
          await queued; // the second is waiting behind it in the supervisor's line
          jobs.exit(id, 0, ""); // the render is over: the second starts while this file is checked
          await checking;
        }),
      );
      const second = await submitExport(
        spec("second.mp4", async (id) => {
          secondQueued();
          await vi.waitFor(() => expect(jobs.started).toContain(id));
          jobs.stdout(id, block(180, 6_000));
          act(() =>
            useExportJob.getState().update({ fraction: 0.1, etaSec: 90, frame: 180, speed: 1 }),
          );
          await secondRuns;
          jobs.exit(id, 0, "");
        }),
      );
      await vi.waitFor(() => expect(useExportJob.getState().live?.jobId).toBe(second.job_id));
      await vi.waitFor(() => expect(useExportJob.getState().live?.fraction).toBe(0.1));
      expect(first.job_id).not.toBe(second.job_id);

      render(<ExportCard />);
      expect(screen.getByText("Exporting “first.mp4”")).toBeVisible();
      expect(screen.getByText("Exporting “second.mp4”")).toBeVisible();
      expect(screen.getAllByTestId("export-card-status").map((line) => line.textContent)).toEqual([
        "Checking the file",
        "Rendering and encoding · 10% · about 2 min left",
      ]);
      const bars = screen.getAllByRole("progressbar");
      expect(bars.map((bar) => bar.getAttribute("aria-valuenow"))).toEqual(["100", "10"]);
      finishCheck();
      finishSecond();
    });
  });

  it("says how long the export itself took, not how long it waited in line behind another", async () => {
    vi.useFakeTimers({ now: 5_000_000, toFake: ["Date", "setInterval", "clearInterval"] });
    const g = gated();
    await start("one.mp4", g.wait);
    await start("two.mp4", async () => {
      vi.setSystemTime(5_000_000 + 100_000 + 5_000); // five seconds of its own
    });
    vi.setSystemTime(5_000_000 + 100_000); // it waited behind the first for 100 s
    g.open();
    await whenExportsSettle();
    render(<ExportCard />);
    expect(screen.getByText("Exported “two.mp4”")).toBeVisible();
    expect(screen.getByText("Took 5 s")).toBeVisible();
  });

  it("says it is working, without made-up numbers, when the live feed is not there (an export that just began)", async () => {
    const g = gated();
    await start("one.mp4", g.wait);
    render(<ExportCard />);
    act(() => useExportJob.setState({ live: null }));
    expect(screen.getByText("Exporting “one.mp4”")).toBeVisible();
    expect(status()).toBe("Working…");
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
    g.open();
  });
});
