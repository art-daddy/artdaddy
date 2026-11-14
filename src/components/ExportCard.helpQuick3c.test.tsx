// With Quick on offer (what the route side will say once it is merged) the card draws Switch to Quick export exactly as the copy pack has it, and only when it was given something to do with it. The route side is
// stood in for by the one answer the help asks it for; nothing else of it is used.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ExportCard from "./ExportCard";
import { __resetExportFlags } from "../api/exportFlags";
import { __setExportConfirmationForTests } from "../lib/confirm";
import * as host from "../platform/host";
import { useEditor } from "../store/editor";
import { useExportJob } from "../store/exportJob";
import { __resetHelp3c, noteHelpTick3c } from "../timeline/exportHelpWatch";
import { EXPORT_SPEED_REVISION } from "../timeline/exportOptions";
import {
  __resetExportQueue,
  listExportRecords,
  offerExportRetry,
  submitExport,
  whenExportsSettle,
} from "../timeline/exportQueue";
import { quickAvailable } from "../timeline/quickAvailable";
import { ExportMemFs } from "../test/timelineKit";
import { ProjectStoreAccess } from "../tools/store";

vi.mock("../timeline/quickAvailable", () => ({ quickAvailable: vi.fn(() => true) }));
vi.mock("../tools/genJobs", () => ({
  openProjectJobs: async () => ({
    begin: async () => `job-${Math.random().toString(36).slice(2, 8)}`,
    settle: async () => undefined,
  }),
}));
vi.mock("../store/jobNotes", () => ({ notifyJobSettled: () => undefined }));
vi.mock("../lib/attention", () => ({ askForAttention: vi.fn(async () => undefined) }));
vi.mock("../lib/pickFolder", () => ({ pickFolder: vi.fn(async () => null) }));

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
const MEASURED = {
  ...DESCRIPTOR,
  elapsedSeconds: 300,
  finalBytes: 48_000_000,
  memoryBytes: null,
  temporaryBytes: null,
};
const AGENT = { chatSessionId: "t1", branchId: 0, executionId: 1 };

let fs: ExportMemFs;
let store: ProjectStoreAccess;
const gates: Array<() => void> = [];

const meta = (over: Record<string, unknown> = {}) => ({
  duration_s: 120,
  width: 1920,
  height: 1080,
  fps: 30,
  quality: "medium",
  project_id: "",
  calibration: DESCRIPTOR,
  ...over,
});

async function start(
  run: () => Promise<unknown>,
  metaOver: Record<string, unknown> = {},
  retry = false,
) {
  const sub = await submitExport({
    store,
    dependencies: [],
    destPath: "/out/one.mp4",
    stagePath: "/out/one.mp4.partial",
    filename: "one.mp4",
    origin: AGENT,
    workload: WORKLOAD,
    meta: meta(metaOver),
    run: async () => {
      await run();
      await fs.writeTextFile("/out/one.mp4.partial", "encoded");
      return {};
    },
  });
  for (let turn = 0; turn < 50 && useExportJob.getState().live?.jobId !== sub.job_id; turn++)
    await Promise.resolve();
  if (retry) offerExportRetry(sub.job_id, async () => ({ ok: true }));
  return sub;
}

beforeEach(() => {
  __resetExportQueue();
  __resetExportFlags();
  __resetHelp3c();
  fs = new ExportMemFs();
  store = new ProjectStoreAccess("/proj", fs);
  useExportJob.getState().reset();
  useExportJob.setState({ live: null, finishing: {}, calibrations: [MEASURED] });
  useEditor.setState({ projectId: "p", store });
  __setExportConfirmationForTests(async () => "continue");
  vi.mocked(quickAvailable).mockReturnValue(true);
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
  __resetHelp3c();
  vi.useRealTimers();
  vi.restoreAllMocks();
  __setExportConfirmationForTests(null);
  useExportJob.setState({ calibrations: [] });
  useEditor.setState({ projectId: null, store: null });
});

describe("Switch to Quick export, on the card", () => {
  /** 90 s in, on course for 1,200 s against 300 s measured, with Quick at `quickSeconds`: handed to the help as the route side will hand it. */
  async function slowRender(quickSeconds: number | null, onSwitchToQuick?: (id: string) => void) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    gates.push(release);
    await start(() => gate, {}, true);
    render(<ExportCard onSwitchToQuick={onSwitchToQuick} />);
    const id = useExportJob.getState().live!.jobId;
    act(() => useExportJob.getState().setLiveStage(id, "rendering"));
    vi.setSystemTime(NOW + 90_000);
    act(() =>
      useExportJob
        .getState()
        .update({ phase: "rendering", fraction: 0.075, etaSec: 1110, frame: 90, speed: 1 }),
    );
    act(() =>
      noteHelpTick3c(
        id,
        {
          record: listExportRecords()[0],
          feed: useExportJob.getState().live,
          quickSeconds,
        },
        NOW + 90_000,
      ),
    );
    return id;
  }

  it("is the first button, in the copy pack's words with Quick's time, and calls what the card was given with the export's id", async () => {
    const onSwitch = vi.fn();
    const id = await slowRender(600, onSwitch);
    const group = screen.getByRole("group", { name: "slow export" });
    expect(
      within(group).getByText("This PC is slower than expected: about 19 min left"),
    ).toBeVisible();
    expect(within(group).getByText("It was expected to take about 5 min.")).toBeVisible();
    expect(
      within(group).getByText("Quick export would take about 10 min, starting over."),
    ).toBeVisible();
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Switch to Quick export", "Keep going", "Cancel"]);
    fireEvent.click(within(group).getByRole("button", { name: "Switch to Quick export" }));
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onSwitch).toHaveBeenCalledWith(id);
  });

  it("says Quick would not help, and draws no button for it, when Quick is not 40 % sooner than what is left", async () => {
    await slowRender(900, vi.fn());
    const group = screen.getByRole("group", { name: "slow export" });
    expect(
      within(group).getByText(
        "Quick export would not be much faster than what is left. To go faster, cancel, use fewer layers or clips, and export again.",
      ),
    ).toBeVisible();
    expect(within(group).queryByRole("button", { name: /quick/i })).toBeNull();
  });

  it("draws no button for it when the card was given nothing to do with it", async () => {
    await slowRender(600, undefined);
    expect(screen.queryByRole("button", { name: /switch to quick/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Keep going" })).toBeVisible();
  });
});

describe("the advice, with Quick on offer", () => {
  const failing = (error: string, metaOver: Record<string, unknown> = {}) =>
    start(async () => {
      throw new Error(error);
    }, metaOver);

  it("names Quick where the copy pack does: for a failure of time and for a chip failure with no restart, and not for memory", async () => {
    await failing("export deadline exceeded");
    await whenExportsSettle();
    render(<ExportCard />);
    expect(
      screen.getByText(
        "On this PC a lower picture size or frame rate, a shorter section, or Quick export is faster.",
      ),
    ).toBeVisible();
    cleanup();
    __resetExportQueue();
    await failing("Error while filtering: Cannot allocate memory");
    await whenExportsSettle();
    render(<ExportCard />);
    expect(
      screen.getByText(
        "To use less memory, lower the picture size or frame rate, or export a shorter section.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("region", { name: "exports" }).textContent).not.toMatch(/quick/i);
  });
});
