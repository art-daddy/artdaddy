// The slow banner and the failure advice in the Export dialog's panel: the same state as the chat card's (answering in either place closes both), the same words, and, once the export has failed,
// the card's plain sentence for why (the text of the failure is one click away) and the one sentence of what to lower under it. Driven through the real queue and the real live feed.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ExportCard from "./ExportCard";
import ExportDialog from "./ExportDialog";
import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { reasonOfError } from "../api/exportReason";
import { __setExportConfirmationForTests } from "../lib/confirm";
import * as host from "../platform/host";
import { useEditor } from "../store/editor";
import { useExportJob } from "../store/exportJob";
import { EXPORT_SPEED_REVISION } from "../timeline/exportOptions";
import {
  __resetExportQueue,
  submitExport,
  whenExportsSettle,
  type ExportSubmission,
} from "../timeline/exportQueue";
import { describeChipFailure, plainFailure } from "../timeline/exportWords";
import {
  ENCODER_FAILURE_LOG,
  ENCODER_FAILURE_PIECES,
  FAILURE_TEXT_ROWS,
} from "../test/failureTexts";
import { ExportMemFs } from "../test/timelineKit";
import { ProjectStoreAccess } from "../tools/store";

vi.mock("../tools/genJobs", () => ({
  openProjectJobs: async () => ({
    begin: async () => `job-${Math.random().toString(36).slice(2, 8)}`,
    settle: async () => undefined,
  }),
}));
vi.mock("../store/jobNotes", () => ({ notifyJobSettled: () => undefined }));
vi.mock("../lib/attention", () => ({ askForAttention: vi.fn(async () => undefined) }));

const GB = 1e9;
const NOW = 5_000_000;
const WORKLOAD = {
  width: 1920,
  height: 1080,
  fps: 30,
  durationSeconds: 120,
  visualClips: 6,
  captionClips: 1,
  audioClips: 1,
  peakVisualLayers: 2,
  peakMediaLayers: 2,
};
const DESCRIPTOR = {
  workload: WORKLOAD,
  output: { width: 1920, height: 1080, fps: 30 },
  quality: "medium",
  engine: "file-sequence-v1" as const,
  encoder: "x264-crf" as const,
  revision: EXPORT_SPEED_REVISION,
};
/** Measured on this PC: 300 s, so the banner holds the render to three times that. */
const MEASURED = {
  ...DESCRIPTOR,
  elapsedSeconds: 300,
  finalBytes: 48_000_000,
  memoryBytes: null,
  temporaryBytes: null,
};

let fs: ExportMemFs;
let store: ProjectStoreAccess;
const gates: Array<() => void> = [];
function gated() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  gates.push(release);
  return { wait: () => gate, open: () => release() };
}

/** An export the Export MENU started, described the way a real one is. */
async function startFromMenu(
  filename: string,
  run: () => Promise<unknown>,
  over: { encoder?: "amd" } = {},
): Promise<ExportSubmission> {
  const sub = await submitExport({
    store,
    dependencies: [],
    destPath: `/out/${filename}`,
    stagePath: `/out/${filename}.partial`,
    filename,
    workload: WORKLOAD,
    meta: {
      duration_s: 120,
      width: 1920,
      height: 1080,
      fps: 30,
      quality: "medium",
      project_id: "",
      calibration: DESCRIPTOR,
      ...(over.encoder
        ? {
            choice: {
              encoder: over.encoder,
              reason: "over_minute",
              tests: [],
              adapter: { maker: "amd" as const, device: "15bf", driver: "32.0.1" },
            },
          }
        : {}),
    },
    run: async () => {
      await run();
      await fs.writeTextFile(`/out/${filename}.partial`, `encoded ${filename}`);
      return {};
    },
  });
  if (sub.queue_position === 0)
    for (let turn = 0; turn < 50 && useExportJob.getState().live?.jobId !== sub.job_id; turn++)
      await Promise.resolve();
  return sub;
}

const report = (over: Parameters<ReturnType<typeof useExportJob.getState>["update"]>[0]) =>
  act(() => useExportJob.getState().update({ phase: "rendering", ...over }));
const open = () => render(<ExportDialog open onCancel={() => {}} onStart={() => {}} />);
const banner = () => screen.queryByRole("group", { name: "slow export" });
const KEPT = "Keeping going. ArtDaddy will tell you again if it gets much slower.";
const paced = (total: number, t: number) => ({
  fraction: t / total,
  etaSec: Math.max(0, total - t),
  frame: Math.max(1, t),
  speed: 1,
});
function play(from: number, to: number, total: number) {
  for (let t = from + 5; t <= to; t += 5) {
    report(paced(total, t));
    act(() => void vi.advanceTimersByTime(5000));
  }
}

beforeEach(() => {
  __resetExportQueue();
  __resetExportFlags();
  fs = new ExportMemFs();
  store = new ProjectStoreAccess("/proj", fs);
  useExportJob.getState().reset();
  useExportJob.setState({ live: null, finishing: {}, calibrations: [MEASURED] });
  useEditor.setState({ projectId: "p", store });
  __setExportConfirmationForTests(async () => "continue");
  vi.spyOn(host, "resolveExportResources").mockResolvedValue({
    total_memory_bytes: 16 * GB,
    available_memory_bytes: 12 * GB,
    scratch_free_bytes: 500 * GB,
    destination_free_bytes: 500 * GB,
    local_fast_candidate: false,
    budgets: { memoryBytes: 8 * GB, temporaryBytes: 18 * GB, executionSeconds: 28_800 },
  });
  vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval"] });
});
afterEach(async () => {
  cleanup();
  for (const release of gates.splice(0)) release();
  await whenExportsSettle();
  __resetExportQueue();
  __resetExportFlags();
  vi.useRealTimers();
  vi.restoreAllMocks();
  __setExportConfirmationForTests(null);
  useExportJob.setState({ calibrations: [] });
  useEditor.setState({ projectId: null, store: null });
});

describe("the slow banner in the dialog's panel", () => {
  async function running(abort: (() => void) | null = null) {
    const g = gated();
    useExportJob.getState().begin(abort);
    const sub = await startFromMenu("film.mp4", g.wait);
    act(() => useExportJob.getState().attach(sub.job_id));
    act(() => useExportJob.getState().setLiveStage(sub.job_id, "rendering"));
    return { g, sub };
  }

  it("shows the card's own banner, in the same words, 90 s into a render on course for over three times its estimate, and not before", async () => {
    const { g } = await running();
    open();
    play(0, 85, 1170);
    expect(banner()).toBeNull();
    play(85, 90, 1170);
    const shown = banner();
    expect(shown).not.toBeNull();
    expect(
      within(shown!).getByText("This PC is slower than expected: about 18 min left"),
    ).toBeVisible();
    expect(within(shown!).getByText("It was expected to take about 5 min.")).toBeVisible();
    expect(
      within(shown!).getByText(
        "To go faster, cancel, use fewer layers or clips, and export again.",
      ),
    ).toBeVisible();
    expect(
      within(shown!)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Keep going", "Cancel"]);
    expect(screen.getByRole("dialog").textContent).not.toMatch(/quick/i);
    g.open();
  });

  it("answers Keep going for the card too: one state for the export, wherever it is looked at", async () => {
    const { g } = await running();
    useEditor.setState({ projectId: "p", store });
    render(
      <>
        <ExportDialog open onCancel={() => {}} onStart={() => {}} />
        <ExportCard />
      </>,
    );
    play(0, 90, 1170);
    expect(screen.getAllByRole("group", { name: "slow export" })).toHaveLength(2);
    fireEvent.click(
      within(screen.getAllByRole("group", { name: "slow export" })[0]).getByRole("button", {
        name: "Keep going",
      }),
    );
    expect(banner()).toBeNull();
    expect(screen.getAllByText(KEPT)).toHaveLength(2);
    g.open();
  });

  it("cancels through the dialog's own Cancel render, which is what the person means by Cancel here", async () => {
    const abort = vi.fn();
    const { g } = await running(abort);
    open();
    play(0, 90, 1170);
    fireEvent.click(within(banner()!).getByRole("button", { name: "Cancel" }));
    expect(abort).toHaveBeenCalledTimes(1);
    g.open();
  });

  it("is not there with the switch off, and says nothing of its own for a healthy render", async () => {
    const { g } = await running();
    open();
    play(0, 280, 290);
    expect(banner()).toBeNull();
    __setExportFlag("export_help", false);
    play(280, 285, 1170);
    expect(banner()).toBeNull();
    expect(screen.queryByText(KEPT)).toBeNull();
    g.open();
  });

  it("goes with the render: nothing is left once the export has ended", async () => {
    const { g, sub } = await running();
    open();
    play(0, 90, 1170);
    expect(banner()).not.toBeNull();
    g.open();
    await whenExportsSettle();
    act(() =>
      useExportJob.getState().finish({ phase: "done", fraction: 1, savedTo: "D:/film.mp4" }),
    );
    expect(banner()).toBeNull();
    expect(screen.queryByText(KEPT)).toBeNull();
    void sub;
  });
});

const MEMORY = "ffmpeg render failed (code=1): Error while filtering: Cannot allocate memory";
const DRIVER =
  "native render failed: [h264_amf @ 0000028f] Error submitting video frame to the encoder";

/** An export that fails with `error` while the dialog is open, as it does for a person who watches it. */
async function failed(error: string, over: { encoder?: "amd" } = {}) {
  useExportJob.getState().begin(null);
  const sub = await startFromMenu(
    "film.mp4",
    async () => {
      throw new Error(error);
    },
    over,
  );
  act(() => useExportJob.getState().attach(sub.job_id));
  // the dialog is open while the export runs and fails, as it is for a person who watches it
  open();
  await whenExportsSettle();
  act(() => useExportJob.getState().finish({ phase: "failed", error }));
  return sub;
}

describe("what to lower, under the error the dialog shows (A1)", () => {
  it("adds the sentence for a memory failure under the card's sentence for it", async () => {
    await failed(MEMORY);
    expect(screen.getByTestId("export-error")).toBeVisible();
    expect(screen.getByTestId("export-error")).toHaveTextContent(plainFailure("memory_limit"));
    expect(screen.getByTestId("export-lower")).toHaveTextContent(
      "To use less memory, lower the picture size or frame rate, or export a shorter section.",
    );
  });

  it("adds the sentence for a failure of time, without Quick", async () => {
    await failed("export deadline exceeded");
    expect(screen.getByTestId("export-error")).toBeVisible();
    expect(screen.getByTestId("export-error")).toHaveTextContent(plainFailure("time_limit"));
    expect(screen.getByTestId("export-lower")).toHaveTextContent(
      "On this PC a lower picture size or frame rate, or a shorter section, is faster.",
    );
  });

  it("adds what makes it shorter when the graphics chip stopped it", async () => {
    __setExportFlag("chip_restart", false);
    await failed(DRIVER, { encoder: "amd" });
    expect(screen.getByTestId("export-error")).toBeVisible();
    expect(screen.getByTestId("export-error")).toHaveTextContent(describeChipFailure("again"));
    expect(screen.getByTestId("export-lower")).toHaveTextContent(
      "To make that shorter, lower the picture size or frame rate.",
    );
  });

  it.each([
    ["ENOSPC: no space left on device", "storage_full"],
    ["ENOENT: no such file or directory", "source_unavailable"],
    ["ffmpeg render failed (code=1)", "render_failed"],
    ["something odd", "unknown"],
  ] as const)(
    "adds nothing for %s: when the cause is not known no advice is given",
    async (error, code) => {
      await failed(error);
      expect(screen.getByTestId("export-error")).toBeVisible();
      expect(screen.getByTestId("export-error")).toHaveTextContent(plainFailure(code));
      expect(screen.queryByTestId("export-lower")).toBeNull();
      expect(screen.getByRole("dialog").textContent).not.toMatch(
        /lower the picture size|a lower picture size|shorter section|quick/i,
      );
    },
  );

  it("shows the plain sentence alone, with no sentence of what to lower, with the switch off", async () => {
    __setExportFlag("export_help", false);
    await failed(MEMORY);
    expect(screen.getByTestId("export-error")).toBeVisible();
    expect(screen.getByTestId("export-error")).toHaveTextContent(plainFailure("memory_limit"));
    expect(screen.queryByTestId("export-lower")).toBeNull();
    expect(screen.getByRole("dialog").textContent).not.toMatch(/lower the picture size/);
  });
});

// R-1: a failed export speaks plainly. The dialog's red line and the queue row's right-hand column say the card's sentence for why it
// stopped (the card's sentence for the graphics chip, in the form for a place with no Try again, where the chip stopped it); the text of the
// failure (the encoder's log and the app's own diagnostics) is one click away, under Show details, and is on no other face of the dialog.
describe("a failed export, in the Export dialog and in its queue row", () => {
  /** What the dialog says on its face: all of it but what a closed Show details holds. */
  const face = (): string => {
    const copy = screen.getByRole("dialog").cloneNode(true) as HTMLElement;
    copy.querySelectorAll("details").forEach((fold) => fold.remove());
    return copy.textContent ?? "";
  };
  /** The queue's row for the export `failed` starts. */
  const row = (): HTMLElement => screen.getByText("film.mp4").closest("li")!;

  it("shows none of the encoder's log on the face of the dialog or in the queue row", async () => {
    await failed(ENCODER_FAILURE_LOG);
    for (const piece of ENCODER_FAILURE_PIECES) {
      expect(face(), piece).not.toContain(piece);
      expect(row().textContent, piece).not.toContain(piece);
    }
  });

  it("says the card's plain sentence for the failure in red, then Show details, then what to lower", async () => {
    await failed(MEMORY);
    const said = screen.getByTestId("export-error");
    expect(said).toBeVisible();
    expect(said.textContent).toBe(plainFailure("memory_limit"));
    const fold = screen.getByTestId("export-error-details");
    const lower = screen.getByTestId("export-lower");
    // in that order, down the dialog
    expect(said.compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(fold.compareDocumentPosition(lower) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the whole log under a Show details that is closed, where nothing of it can be seen", async () => {
    await failed(ENCODER_FAILURE_LOG);
    const fold = screen.getByTestId("export-error-details") as HTMLDetailsElement;
    expect(fold.tagName).toBe("DETAILS");
    expect(fold.open).toBe(false);
    expect(within(fold).getByText("Show details").tagName).toBe("SUMMARY");
    // every element that holds a piece of the log is inside that closed fold
    for (const piece of ENCODER_FAILURE_PIECES) {
      const holders = within(screen.getByRole("dialog")).getAllByText(piece, { exact: false });
      for (const holder of holders) {
        expect(holder.closest("details"), piece).toBe(fold);
        expect(holder, piece).not.toBeVisible();
      }
    }
  });

  it("opens on a click on Show details, and then shows the log as it came, in a box of bounded height", async () => {
    await failed(ENCODER_FAILURE_LOG);
    const fold = screen.getByTestId("export-error-details") as HTMLDetailsElement;
    fireEvent.click(within(fold).getByText("Show details"));
    expect(fold.open).toBe(true);
    const body = Array.from(fold.children).filter((child) => child.tagName !== "SUMMARY");
    expect(body).toHaveLength(1);
    expect(body[0]).toBeVisible();
    expect(body[0].textContent).toBe(ENCODER_FAILURE_LOG);
    // a long log scrolls inside the dialog instead of pushing it off the screen (there is no layout here, so the classes are what can be read)
    expect(body[0].className).toMatch(/\bmax-h-/);
    expect(body[0].className).toMatch(/\boverflow-(?:y-)?auto\b/);
    // the sentence is still the one above it
    expect(screen.getByTestId("export-error").textContent).toBe(plainFailure("render_failed"));
  });

  it.each(FAILURE_TEXT_ROWS)(
    "says the card's sentence for %s in the dialog and in the queue row, and not the text of the failure",
    async (code, text) => {
      // the table cannot drift from the rule
      expect(reasonOfError(text)).toBe(code);
      await failed(text);
      const sentence = plainFailure(code);
      expect(screen.getByTestId("export-error").textContent).toBe(sentence);
      expect(within(row()).getByText(sentence)).toBeVisible();
      expect(row().textContent).not.toContain(text);
      expect(face()).not.toContain(text);
    },
  );

  it("says the card's sentence for a place with no Try again where the graphics chip stopped it, in the dialog and in the queue row", async () => {
    __setExportFlag("chip_restart", false); // nothing starts it again, so the person is told what to do
    await failed(DRIVER, { encoder: "amd" });
    const chip = describeChipFailure("again");
    expect(screen.getByTestId("export-error").textContent).toBe(chip);
    expect(within(row()).getByText(chip)).toBeVisible();
    // neither the generic sentence, nor the card's own, which points at a Try again button the dialog does not have
    expect(face()).not.toContain(plainFailure("render_failed"));
    expect(face()).not.toContain(describeChipFailure("card"));
  });

  it("says the generic sentence for the very same text where the graphics chip did not run it", async () => {
    await failed(DRIVER);
    expect(screen.getByTestId("export-error").textContent).toBe(plainFailure("render_failed"));
    expect(within(row()).getByText(plainFailure("render_failed"))).toBeVisible();
    expect(face()).not.toContain(describeChipFailure("again"));
  });
});
