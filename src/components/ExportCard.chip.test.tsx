// What the person reads on the chat card about the graphics chip: its line (with no switch of its own), and the words of a chip that stopped an export and was
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
  listExports,
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

describe("the card says what the chip is doing and offers no way to switch it", () => {
  /** What a link or a button that switches the chip would be called. The sentence about a chip that was turned off in the dialog says "turned off" and is no such name. */
  const SWITCH = /turn (it )?(off|on)|switch (it )?(off|on)/i;
  const controls = () => screen.queryAllByRole("button");
  const names = () => controls().map((b) => b.getAttribute("aria-label") ?? b.textContent ?? "");
  const nothingSwitchesIt = () => {
    expect(screen.queryByRole("button", { name: SWITCH })).toBeNull();
    expect(screen.queryByRole("link", { name: SWITCH })).toBeNull();
    expect(controls().filter((b) => SWITCH.test(b.textContent ?? ""))).toEqual([]);
  };

  it("shows the chip's line with no link beside it: the only control on a running chip export is Cancel, and pressing it writes no switch", async () => {
    const t = await longProject();
    await t.exportNow("long");
    await flush();
    render(createElement(ExportCard));
    expect(screen.getByText(CHIP_LINE)).toBeVisible();
    nothingSwitchesIt();
    expect(names()).toEqual(["cancel long.mp4"]);
    expect(screen.queryByTestId("export-card-chip-off")).toBeNull();
    // nothing on the card can change the person's switch for the next exports
    for (const control of controls()) fireEvent.click(control);
    await settle();
    expect(localStorage.getItem(CHIP_PREF_KEY)).toBeNull();
  });

  it("says it was turned off when the person did that in the dialog, and offers nothing: no link, and the stored switch is as the dialog left it", async () => {
    const t = await longProject();
    await t.exportNow("long");
    await flush();
    localStorage.setItem(CHIP_PREF_KEY, "off");
    render(createElement(ExportCard));
    expect(screen.getByTestId("export-card-chip-off")).toHaveTextContent(CHIP_TURNED_OFF_LINE);
    // the export that is running keeps going, on the chip it started on, and its line stays
    expect(screen.getByText(CHIP_LINE)).toBeVisible();
    nothingSwitchesIt();
    expect(names()).toEqual(["cancel long.mp4"]);
    for (const control of controls()) fireEvent.click(control);
    expect(localStorage.getItem(CHIP_PREF_KEY)).toBe("off");
  });

  it("is not there with the server's switch for Quick export off: the card says what it said, and the dialog's Off is not announced", async () => {
    __setExportFlag("quick_export", false);
    const t = await longProject();
    await t.exportNow("long");
    await flush();
    localStorage.setItem(CHIP_PREF_KEY, "off");
    render(createElement(ExportCard));
    expect(screen.getByText(CHIP_LINE)).toBeVisible();
    nothingSwitchesIt();
    expect(screen.queryByTestId("export-card-chip-off")).toBeNull();
  });

  it("is not on an export that runs on the processor", async () => {
    const t = await longProject(null);
    await t.exportNow("long");
    await flush();
    render(createElement(ExportCard));
    expect(screen.queryByText(/graphics chip/)).toBeNull();
    nothingSwitchesIt();
  });

  // The card's other states, each reached through the real queue: waiting behind the chip export, ended on the chip's own failure with Try again, finished.
  it("offers no switch while another export waits behind the chip's, when the chip stopped one for good (Try again), and when one has finished", async () => {
    __setExportFlag("chip_restart", false); // the chip's failure is then shown as a failure, with its own sentence and Try again
    const t = await longProject();
    const first = await t.exportNow("long");
    await t.exportNow("later");
    await flush();
    render(createElement(ExportCard));
    expect(screen.getByText(CHIP_LINE)).toBeVisible();
    expect(screen.getByText(/Waiting · 1st in line/)).toBeVisible();
    nothingSwitchesIt();

    t.jobs.exit(first.job_id, -1, DRIVER_ERROR);
    await settle();
    expect(screen.getByText("Export stopped")).toBeVisible();
    expect(screen.getByText(OLD_END)).toBeVisible();
    expect(screen.getByRole("button", { name: "try again long.mp4" })).toBeVisible();
    nothingSwitchesIt();

    t.jobs.exit(t.jobs.submitted.at(-1)!.id, 0);
    await settle();
    expect(screen.getByText("Exported “later.mp4”")).toBeVisible();
    nothingSwitchesIt();
    // pressing everything the card has, in this state too, never writes the person's switch
    for (const control of controls()) fireEvent.click(control);
    await settle();
    expect(localStorage.getItem(CHIP_PREF_KEY)).toBeNull();
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
    // the second try is on the processor: the chip's line is gone, and in every state the card has had nothing offered a switch
    expect(screen.queryByText(CHIP_LINE)).toBeNull();
    expect(screen.queryByRole("button", { name: /turn (it )?(off|on)/i })).toBeNull();
    // nothing on the card promises the picture or a speed, and none says the picture differs
    expect(document.body.textContent).not.toMatch(
      /same quality|identical|pixel|lossless|times (faster|longer)|differ|softer|slightly/i,
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
