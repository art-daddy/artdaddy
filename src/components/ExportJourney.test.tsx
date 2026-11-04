// The journey S2 exists for, replayed end to end with the real pieces: the real queue and its checks, the
// real question store, the dialog and the card side by side, the real live feed and the real report.
//
// A person asks their assistant to export. The PC is short of memory. What used to happen: a native
// message box with a wall of text (and nothing at all for an export the assistant started once it ran:
// no bar, no place in line, no reason when it failed). What must happen now: a plain question with the
// numbers, answerable in the dialog or on the card, then a card that says where the export is, that it is
// waiting, when it has stopped moving, and in plain words why it ended.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ExportCard from "./ExportCard";
import ExportQuestionDialog from "./ExportQuestionDialog";
import { __resetExportQuestions } from "../store/exportQuestionHost";
import { useEditor } from "../store/editor";
import { useExportJob } from "../store/exportJob";
import {
  __resetExportQueue,
  listExportRecords,
  manageExportsTool,
  submitExports,
  whenExportsSettle,
  whenExportTelemetrySettles,
} from "../timeline/exportQueue";
import { EXPORT_SPEED_REVISION, type ExportCalibration } from "../timeline/exportOptions";
import * as host from "../platform/host";
import { ExportMemFs } from "../test/timelineKit";
import { ProjectStoreAccess } from "../tools/store";

const exportBeacon = vi.hoisted(() => vi.fn(async (_event: unknown) => undefined));
vi.mock("../api/exportEvents", () => ({ reportExport: exportBeacon }));
const attention = vi.hoisted(() => ({ askForAttention: vi.fn(async () => undefined) }));
vi.mock("../lib/attention", () => attention);
vi.mock("../tools/genJobs", () => ({
  openProjectJobs: async () => ({
    begin: async () => `job-${Math.random().toString(36).slice(2, 8)}`,
    settle: async () => undefined,
  }),
}));
vi.mock("../store/jobNotes", () => ({ notifyJobSettled: () => undefined }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const GB = 1e9;
const AGENT = { chatSessionId: "t1", branchId: 0, executionId: 1 };

const calibration: Pick<
  ExportCalibration,
  "workload" | "output" | "quality" | "engine" | "revision"
> = {
  workload: {
    width: 1920,
    height: 1080,
    fps: 30,
    durationSeconds: 60,
    visualClips: 14,
    captionClips: 2,
    audioClips: 1,
    peakVisualLayers: 8,
    peakMediaLayers: 7,
  },
  output: { width: 1920, height: 1080, fps: 30 },
  quality: "medium",
  engine: "partition-pipes-v1",
  revision: EXPORT_SPEED_REVISION,
};

let fs: ExportMemFs;
let store: ProjectStoreAccess;
let pc: host.ExportResources;

beforeEach(() => {
  __resetExportQueue();
  __resetExportQuestions();
  fs = new ExportMemFs();
  store = new ProjectStoreAccess("/proj", fs);
  exportBeacon.mockClear();
  attention.askForAttention.mockClear();
  useExportJob.getState().reset();
  useExportJob.setState({ live: null, finishing: {} });
  useEditor.setState({ projectId: "p", store });
  // A laptop with 1.9 GB of memory free, which this project's exports are known to need 3.2 GB of.
  pc = {
    total_memory_bytes: 16 * GB,
    available_memory_bytes: 1.9 * GB,
    local_fast_candidate: false,
    scratch_free_bytes: 500 * GB,
    destination_free_bytes: 500 * GB,
    budgets: { memoryBytes: 8 * GB, temporaryBytes: 18 * GB, executionSeconds: 28_800 },
  };
  vi.spyOn(host, "resolveExportResources").mockImplementation(async () => pc);
  useExportJob.setState({
    calibrations: [
      {
        ...calibration,
        elapsedSeconds: 50,
        finalBytes: 1 * GB,
        memoryBytes: 3.2 * GB,
        temporaryBytes: 1 * GB,
      },
    ],
  });
});
afterEach(async () => {
  cleanup();
  __resetExportQueue();
  __resetExportQuestions();
  vi.useRealTimers();
  vi.restoreAllMocks();
  useEditor.setState({ projectId: null, store: null });
});

describe("an assistant's export on a PC that is short of memory", () => {
  it("is asked in plain words, answered on the card, followed while it runs and waits, and explained when it stops", async () => {
    vi.useFakeTimers({ now: 9_000_000, toFake: ["Date", "setInterval", "clearInterval"] });
    render(
      <>
        <ExportQuestionDialog />
        <ExportCard />
      </>,
    );
    let ran = 0;
    let failRun!: () => void;
    const failing = new Promise<void>(
      (_, reject) =>
        (failRun = () => reject(new Error("Error while filtering: Cannot allocate memory"))),
    );
    failing.catch(() => undefined);
    const spec = (name: string, run: () => Promise<unknown>) => {
      const destPath = `/out/${name}`;
      return {
        store,
        dependencies: [],
        destPath,
        stagePath: `${destPath}.partial`,
        filename: name,
        workload: calibration.workload,
        via: "chat" as const,
        origin: AGENT,
        meta: {
          duration_s: 60,
          width: 1920,
          height: 1080,
          fps: 30,
          quality: "medium",
          project_id: "",
          calibration,
        },
        run: async () => {
          ran++;
          await run();
          await fs.writeTextFile(`${destPath}.partial`, name);
          return {};
        },
      };
    };

    // 1. The assistant asks for the export. Nothing starts; the person is asked, in the dialog. The
    //    dialog is modal and covers the chat, so the card does not repeat the question underneath it.
    const firstRequest = submitExports([spec("reel.mp4", () => failing)]);
    const dialog = await screen.findByRole("dialog", { name: "Not enough free memory" });
    expect(within(dialog).getByText("about 3.2 GB")).toBeVisible();
    expect(within(dialog).getByText("about 1.9 GB")).toBeVisible();
    expect(screen.queryByRole("group", { name: "export question" })).toBeNull();
    expect(attention.askForAttention).toHaveBeenCalled(); // the window may be behind another
    expect(ran).toBe(0);
    expect(listExportRecords()).toHaveLength(0);

    // 2. The person wants the chat in view, so they put the dialog away: the same question is now on the
    //    card above the message box. They close their browser and press Continue there. The PC is
    //    measured again, the question goes away, and the export starts.
    fireEvent.click(within(dialog).getByRole("button", { name: "Answer in chat" }));
    const onCard = await screen.findByRole("group", { name: "export question" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(onCard).getByText(/Needed about 3\.2 GB/)).toBeVisible();
    pc = { ...pc, available_memory_bytes: 6 * GB };
    fireEvent.click(within(onCard).getByRole("button", { name: "Continue" }));
    await firstRequest;
    await vi.waitFor(() =>
      expect(screen.queryByRole("group", { name: "export question" })).toBeNull(),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    await vi.waitFor(() => expect(ran).toBe(1));
    expect(screen.getByText("Exporting “reel.mp4”")).toBeVisible();
    expect(useExportJob.getState().phase).toBe("idle"); // the Export dialog's job was never begun
    expect(screen.getByTestId("export-card-status").textContent).toBe(
      "Preparing · checking your clips",
    );

    // 3. A second export is asked for while the first runs (it fits the PC now): it waits its turn.
    const second = await submitExports([spec("teaser.mp4", async () => undefined)]);
    expect(second[0].queue_position).toBe(1);
    expect(screen.getByText("Waiting · 1st in line · teaser.mp4")).toBeVisible();

    // 4. ffmpeg starts reporting (as render.ts publishes it): the card follows, and so does the
    //    assistant's own export list.
    const jobId = useExportJob.getState().live!.jobId;
    act(() => {
      useExportJob.getState().setLiveStage(jobId, "rendering");
      useExportJob.getState().update({ fraction: 0.38, etaSec: 100, frame: 684, speed: 1.2 });
    });
    expect(screen.getByTestId("export-card-status").textContent).toBe(
      "Rendering and encoding · 38% · about 2 min left",
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "38");
    const listed = (((await manageExportsTool({ action: "list" })) as Any).exports as Any[]).map(
      (row) => ({
        state: row.state,
        stage: row.stage,
        pct: row.progress_percent,
        line: row.queue_position,
      }),
    );
    expect(listed).toEqual([
      { state: "running", stage: "rendering", pct: 38, line: undefined },
      { state: "queued", stage: undefined, pct: undefined, line: 1 },
    ]);

    // 5. The render stands still for 75 seconds (the same block, again and again): the card says so.
    for (let second = 5; second <= 75; second += 5) {
      vi.setSystemTime(9_000_000 + second * 1000);
      act(() => useExportJob.getState().update({ fraction: 0.38, etaSec: 100, frame: 684 }));
    }
    act(() => void vi.advanceTimersByTime(10_000));
    expect(screen.getByTestId("export-card-status").textContent).toMatch(
      /^No progress for 8\d s · Rendering and encoding · 38%$/,
    );
    expect(
      (((await manageExportsTool({ action: "list" })) as Any).exports as Any[])[0],
    ).toMatchObject({
      stalled_for_s: expect.any(Number),
    });

    // 6. It runs out of memory. The card says so in plain words, with no ffmpeg in them, and so does the
    //    assistant's list. The export that was waiting still runs.
    failRun();
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    expect(screen.getByText("Export stopped")).toBeVisible();
    expect(
      screen.getByText("Your PC ran short of memory. Close other programs and try again."),
    ).toBeVisible();
    expect(screen.queryByText(/Cannot allocate|ffmpeg/i)).toBeNull();
    const after = ((await manageExportsTool({ action: "list" })) as Any).exports as Any[];
    expect(after.map((row) => row.state)).toEqual(["failed", "done"]);
    expect(after[0]).toMatchObject({
      failure_code: "memory_limit",
      failure: "Your PC ran short of memory. Close other programs and try again.",
    });
    expect(ran).toBe(2);

    // 7. The report tells the whole story: who asked, what the person was asked and answered (on the
    //    card), the stage it reached, the limit that ended it.
    const report = exportBeacon.mock.calls
      .map((call) => call[0] as Any)
      .find((event) => event.status === "failed");
    const story = report.trace.map((e: Any) => (e.v ? `${e.e}:${e.v}` : e.e));
    // (The stage of "rendering" comes from ffmpeg's own output, which only the native supervisor feeds to
    // the watch; this replay runs the page's queue, so the watch saw a render that never moved. The
    // supervised stage trace is pinned in the queue's own tests.)
    expect(story).toEqual([
      "requested:chat",
      "dialog_shown:b1",
      "dialog_choice:continue",
      "stage:preparing",
      "stall_detected",
      "heartbeat_gap",
      "guard_tripped:os_refusal",
      "outcome:failed",
    ]);
    expect(report.trace[2]).toMatchObject({ m: 2 }); // answered on the card
    expect(report).toMatchObject({ started_by: "chat", limit: "os" });
  });
});
