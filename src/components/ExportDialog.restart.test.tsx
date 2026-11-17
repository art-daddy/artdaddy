// When the app starts an export again by itself (the chip stopped it, the PC ran short of memory) the Export dialog's bar goes back to the start. The chat card has always said why, in the words of the
// restart's reason; the dialog must say the same, for the attempt that is live now. Driven through the real export tool and queue over FakeJobs, like the card's own journeys.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __setExportFlag } from "../api/exportFlags";
import { useAuth } from "../store/auth";
import { useEditor } from "../store/editor";
import { useExportJob } from "../store/exportJob";
import {
  DRIVER_ERROR,
  GIB,
  MEMORY_SHORT,
  amdChip,
  flush,
  longProject as measuredProject,
  type ExportRig,
} from "../test/chipExportKit";
import { resetTestDocuments } from "../test/timelineKit";
import { __resetProjectJobs } from "../tools/genJobs";
import { __resetJobSupervisor } from "../tools/jobSupervisor";
import { findChip, markChipSuspect } from "../timeline/chipTest";
import {
  __resetExportQueue,
  cancelExport,
  listExportRecords,
  listExports,
  restartWords,
  whenExportsSettle,
} from "../timeline/exportQueue";
import ExportCard from "./ExportCard";
import ExportDialog from "./ExportDialog";

vi.mock("../api/exportEvents", () => ({ reportExport: async () => undefined }));
vi.mock("../timeline/chipTest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../timeline/chipTest")>()),
  findChip: vi.fn(async () => ({ chip: null, events: [] })),
  markChipSuspect: vi.fn(),
}));
const pc = vi.hoisted(() => ({ available: null as number | null }));
vi.mock("../platform/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform/host")>()),
  resolveExportResources: vi.fn(async () => ({
    total_memory_bytes: null,
    available_memory_bytes: pc.available,
    scratch_free_bytes: null,
    destination_free_bytes: null,
    budgets: { memoryBytes: null, temporaryBytes: null, executionSeconds: null },
    adapters: [],
  })),
}));

const longProject = async (): Promise<ExportRig> => {
  const t = await measuredProject(amdChip());
  vi.mocked(markChipSuspect).mockClear();
  useEditor.setState({ projectId: "p", store: t.store });
  return t;
};

beforeEach(() => {
  localStorage.clear();
  useAuth.setState({ profile: null });
  useExportJob.getState().reset();
  pc.available = 8 * GIB;
  __setExportFlag("faster_x264", false);
  vi.mocked(findChip).mockReset();
  vi.mocked(findChip).mockResolvedValue({ chip: null, events: [] });
  vi.mocked(markChipSuspect).mockReset();
});
afterEach(async () => {
  cleanup();
  await resetTestDocuments();
  for (const running of listExports()) cancelExport(running.job_id, "app");
  await Promise.race([whenExportsSettle(), new Promise((resolve) => setTimeout(resolve, 4_000))]);
  __resetExportQueue();
  __resetProjectJobs();
  __resetJobSupervisor();
  useExportJob.getState().reset();
  useExportJob.setState({ calibrations: [] });
  useEditor.setState({ projectId: null, store: null });
  for (const flag of ["auto_restart", "chip_restart", "memory_restart", "faster_x264"] as const)
    __setExportFlag(flag, true);
  localStorage.clear();
});

const settle = () =>
  act(async () => {
    await flush(40);
  });
const restartedLine = () => screen.queryByTestId("export-dialog-restarted");

describe("the Export dialog, when the app starts the export again by itself", () => {
  it.each([
    ["the graphics chip stopped it", DRIVER_ERROR, "chip_failed"],
    ["the PC ran short of memory", MEMORY_SHORT, "memory_short"],
  ])(
    "says why the bar went back to the start, in the reason's own words and the card's: %s",
    async (_why, error, reason) => {
      const t = await longProject();
      const started = await t.exportNow("long");
      await flush();
      // the dialog follows the export by the id of its first attempt, as the Export menu hands it over
      useExportJob.getState().begin(null);
      act(() => useExportJob.getState().attach(started.job_id));
      act(() => useExportJob.getState().setLiveStage(started.job_id, "rendering"));
      render(
        <>
          <ExportDialog open onCancel={() => {}} onStart={() => {}} />
          <ExportCard />
        </>,
      );
      // the first attempt has nothing to explain
      expect(restartedLine()).toBeNull();

      t.jobs.exit(started.job_id, -1, error);
      await settle();
      expect(listExportRecords()[0]).toMatchObject({ attempt: 2, restartReason: reason });
      const words = restartWords(reason);
      expect(words?.after.length ?? 0).toBeGreaterThan(20);
      expect(restartedLine()?.textContent).toBe(words!.after);
      // one export, one explanation: whichever of the two places it is read in
      expect(screen.getByTestId("export-card-restarted").textContent).toBe(
        restartedLine()?.textContent,
      );
      expect(screen.queryByText("Export stopped")).toBeNull();
    },
  );

  it("says nothing more once the restarted export has ended", async () => {
    const t = await longProject();
    const started = await t.exportNow("long");
    await flush();
    useExportJob.getState().begin(null);
    act(() => useExportJob.getState().attach(started.job_id));
    act(() => useExportJob.getState().setLiveStage(started.job_id, "rendering"));
    render(<ExportDialog open onCancel={() => {}} onStart={() => {}} />);
    t.jobs.exit(started.job_id, -1, DRIVER_ERROR);
    await settle();
    expect(restartedLine()).not.toBeNull();
    t.jobs.exit(t.jobs.submitted.at(-1)!.id, 0);
    await settle();
    act(() =>
      useExportJob.getState().finish({ phase: "done", fraction: 1, savedTo: "D:/long.mp4" }),
    );
    expect(restartedLine()).toBeNull();
  });
});
