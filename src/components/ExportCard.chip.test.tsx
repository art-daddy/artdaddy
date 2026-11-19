// What the person reads on the chat card about the graphics chip: the quiet Turn off, and the words of a chip that stopped an export and was
// started again on the processor by the app. Driven through the real export tool and queue over FakeJobs, like the card's other journeys.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
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
  holdTheRestart,
  longProject as measuredProject,
  type ExportRig,
} from "../test/chipExportKit";
import { resetTestDocuments } from "../test/timelineKit";
import { __resetProjectJobs } from "../tools/genJobs";
import { __resetJobSupervisor } from "../tools/jobSupervisor";
import { addClipsTool } from "../timeline/placement";
import { CHIP_PREF_KEY } from "../timeline/chipPref";
import { findChip, markChipSuspect } from "../timeline/chipTest";
import {
  __resetExportQueue,
  cancelExport,
  listExportRecords,
  listExports,
  whenExportEnds,
  whenExportsSettle,
} from "../timeline/exportQueue";
import ExportCard from "./ExportCard";
import { CHIP_TURNED_OFF_LINE } from "./ChipLine";

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

const CHIP_LINE = "Using your graphics chip · the file is larger";
const OLD_END =
  "The graphics chip stopped this export. Try again uses the processor instead, which takes longer.";
const GAP = "The graphics chip stopped this export. Starting again on the processor…";
const AFTER =
  "Started again on the processor because the graphics chip stopped the first try. It will take longer. Your export settings are kept.";

const longProject = async (
  chip: ReturnType<typeof amdChip> | null = amdChip(),
): Promise<ExportRig> => {
  const t = await measuredProject(chip);
  vi.mocked(markChipSuspect).mockClear();
  useEditor.setState({ projectId: "p", store: t.store });
  return t;
};

beforeEach(() => {
  localStorage.clear();
  useAuth.setState({ profile: null });
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
  useExportJob.setState({ calibrations: [] });
  useEditor.setState({ projectId: null, store: null });
  for (const flag of ["auto_restart", "chip_restart", "quick_export", "faster_x264"] as const)
    __setExportFlag(flag, true);
  localStorage.clear();
});

const status = () => screen.getByTestId("export-card-status").textContent;
const settle = () =>
  act(async () => {
    await flush(40);
  });

describe("the card's quiet Turn off on a chip export", () => {
  it("turns the chip off for the next exports and leaves the running one alone, and says so", async () => {
    const t = await longProject();
    const started = await t.exportNow("long");
    await flush();
    render(createElement(ExportCard));
    expect(screen.getByText(CHIP_LINE)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "turn off the graphics chip" }));
    expect(localStorage.getItem(CHIP_PREF_KEY)).toBe("off");
    expect(screen.getByTestId("export-card-chip-off")).toHaveTextContent(CHIP_TURNED_OFF_LINE);
    expect(screen.queryByRole("button", { name: "turn off the graphics chip" })).toBeNull();
    // the export that is running keeps going, on the chip it started on
    expect(screen.getByText(CHIP_LINE)).toBeVisible();
    expect(listExportRecords().find((r) => r.job_id === started.job_id)).toMatchObject({
      state: "running",
    });
    expect(t.jobs.killed).toEqual([]);
    t.jobs.exit(started.job_id, 0);
    expect((await whenExportEnds(started.job_id))?.state).toBe("done");
  });

  it("says it was turned off when the person did that in the dialog, and offers nothing more", async () => {
    const t = await longProject();
    await t.exportNow("long");
    await flush();
    localStorage.setItem(CHIP_PREF_KEY, "off");
    render(createElement(ExportCard));
    expect(screen.getByTestId("export-card-chip-off")).toHaveTextContent(CHIP_TURNED_OFF_LINE);
    expect(screen.queryByRole("button", { name: "turn off the graphics chip" })).toBeNull();
  });

  it("is not there with the server's switch for Quick export off: the card says what it said", async () => {
    __setExportFlag("quick_export", false);
    const t = await longProject();
    await t.exportNow("long");
    await flush();
    render(createElement(ExportCard));
    expect(screen.getByText(CHIP_LINE)).toBeVisible();
    expect(screen.queryByRole("button", { name: "turn off the graphics chip" })).toBeNull();
    expect(screen.queryByTestId("export-card-chip-off")).toBeNull();
  });

  it("is not on an export that runs on the processor", async () => {
    const t = await longProject(null);
    await t.exportNow("long");
    await flush();
    render(createElement(ExportCard));
    expect(screen.queryByText(/graphics chip/)).toBeNull();
    expect(screen.queryByRole("button", { name: "turn off the graphics chip" })).toBeNull();
  });
});

describe("what the card says when the graphics chip stops an export", () => {
  it("says it is starting again on the processor, then which attempt it is and why, and never calls it a failure", async () => {
    const t = await longProject();
    const gate = holdTheRestart(t);
    const started = await t.exportNow("long");
    await flush();
    render(createElement(ExportCard));
    expect(screen.getByText("Exporting “long.mp4”")).toBeVisible();

    gate.arm();
    t.jobs.exit(started.job_id, -1, DRIVER_ERROR);
    await settle();
    expect(status()).toBe(GAP);
    expect(screen.queryByText("Export stopped")).toBeNull();
    expect(screen.getByRole("button", { name: "cancel long.mp4" })).toBeVisible();

    gate.release();
    await settle();
    expect(screen.getByText("Exporting “long.mp4” · attempt 2")).toBeVisible();
    expect(screen.getByTestId("export-card-restarted").textContent).toBe(AFTER);
    expect(screen.queryByText("Export stopped")).toBeNull();
    // the second try is on the processor: the chip's line and its Turn off are gone
    expect(screen.queryByText(CHIP_LINE)).toBeNull();
    expect(screen.queryByRole("button", { name: "turn off the graphics chip" })).toBeNull();
    // nothing on the card promises the picture or a speed
    expect(document.body.textContent).not.toMatch(
      /same quality|identical|pixel|lossless|times (faster|longer)/i,
    );

    t.jobs.exit(t.jobs.submitted.at(-1)!.id, 0);
    await settle();
    expect(screen.getByText("Exported “long.mp4”")).toBeVisible();
  });

  it("is stopped for good by the card's own Cancel while it is starting again", async () => {
    const t = await longProject();
    const gate = holdTheRestart(t);
    const started = await t.exportNow("long");
    await flush();
    render(createElement(ExportCard));
    gate.arm();
    const jobsBefore = t.jobs.submitted.length;
    t.jobs.exit(started.job_id, -1, DRIVER_ERROR);
    await settle();
    expect(status()).toBe(GAP);
    fireEvent.click(screen.getByRole("button", { name: "cancel long.mp4" }));
    gate.release();
    await settle();
    expect(screen.getByText("Export cancelled")).toBeVisible();
    expect(screen.queryByText(/attempt 2/)).toBeNull();
    expect(t.jobs.submitted).toHaveLength(jobsBefore);
  });

  it.each([
    [
      "the project was edited after the first try",
      async (t: ExportRig) =>
        void (await addClipsTool(
          { entries: [{ media_ref: "a.mp4", timeline_in: 60, timeline_out: 120 }] },
          t.nextPage(),
        )),
    ],
    [
      "the switch for the app's own restarts is off",
      async () => __setExportFlag("chip_restart", false),
    ],
    ["the master switch for restarts is off", async () => __setExportFlag("auto_restart", false)],
  ])(
    "keeps today's words and Try again when it was not started again: %s",
    async (_why, arrange) => {
      const t = await longProject();
      const started = await t.exportNow("long");
      await flush();
      await arrange(t);
      render(createElement(ExportCard));
      t.jobs.exit(started.job_id, -1, DRIVER_ERROR);
      await settle();
      expect(screen.getByText("Export stopped")).toBeVisible();
      expect(screen.getByText(OLD_END)).toBeVisible();
      expect(screen.getByRole("button", { name: "try again long.mp4" })).toBeVisible();
      expect(screen.queryByText(/attempt 2|Starting again on the processor/)).toBeNull();
    },
  );

  it("says what is true when the processor then runs short of memory: the plain sentence, and Try again", async () => {
    const t = await longProject();
    const started = await t.exportNow("long");
    await flush();
    render(createElement(ExportCard));
    t.jobs.exit(started.job_id, -1, DRIVER_ERROR);
    await settle();
    expect(screen.getByTestId("export-card-restarted").textContent).toBe(AFTER);
    t.jobs.exit(t.jobs.submitted.at(-1)!.id, -1, MEMORY_SHORT);
    await settle();
    expect(screen.getByText("Export stopped")).toBeVisible();
    expect(
      screen.getByText("Your PC ran short of memory. Close other programs and try again."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "try again long.mp4" })).toBeVisible();
  });
});
