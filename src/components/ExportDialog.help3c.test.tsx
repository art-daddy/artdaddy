// The slow banner and the failure advice in the Export dialog's panel: the same state as the chat card's (answering in either place closes both), the same words, and, once the export has failed,
// the one sentence of what to lower under the error the dialog has always shown. Driven through the real queue and the real live feed.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ExportCard from "./ExportCard";
import ExportDialog from "./ExportDialog";
import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
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

describe("what to lower, under the error the dialog shows (A1)", () => {
  const MEMORY = "ffmpeg render failed (code=1): Error while filtering: Cannot allocate memory";
  const DRIVER =
    "native render failed: [h264_amf @ 0000028f] Error submitting video frame to the encoder";

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

  it("keeps the error as it was and adds the sentence for a memory failure under it", async () => {
    await failed(MEMORY);
    expect(screen.getAllByText(MEMORY)[0]).toBeVisible();
    expect(screen.getByTestId("export-lower")).toHaveTextContent(
      "To use less memory, lower the picture size or frame rate, or export a shorter section.",
    );
  });

  it("adds the sentence for a failure of time, without Quick", async () => {
    await failed("export deadline exceeded");
    expect(screen.getAllByText("export deadline exceeded")[0]).toBeVisible();
    expect(screen.getByTestId("export-lower")).toHaveTextContent(
      "On this PC a lower picture size or frame rate, or a shorter section, is faster.",
    );
  });

  it("adds what makes it shorter when the graphics chip stopped it", async () => {
    __setExportFlag("chip_restart", false);
    await failed(DRIVER, { encoder: "amd" });
    expect(screen.getAllByText(DRIVER)[0]).toBeVisible();
    expect(screen.getByTestId("export-lower")).toHaveTextContent(
      "To make that shorter, lower the picture size or frame rate.",
    );
  });

  it.each([
    "ENOSPC: no space left on device",
    "ENOENT: no such file or directory",
    "ffmpeg render failed (code=1)",
    "something odd",
  ])("adds nothing for %s: when the cause is not known no advice is given", async (error) => {
    await failed(error);
    expect(screen.getAllByText(error)[0]).toBeVisible();
    expect(screen.queryByTestId("export-lower")).toBeNull();
    expect(screen.getByRole("dialog").textContent).not.toMatch(
      /lower the picture size|a lower picture size|shorter section|quick/i,
    );
  });

  it("shows the error alone, as 0.27.0 did, with the switch off", async () => {
    __setExportFlag("export_help", false);
    await failed(MEMORY);
    expect(screen.getAllByText(MEMORY)[0]).toBeVisible();
    expect(screen.queryByTestId("export-lower")).toBeNull();
    expect(screen.getByRole("dialog").textContent).not.toMatch(/lower the picture size/);
  });
});
