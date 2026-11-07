// What the Export dialog says while its own export goes: where it is (the stage, by name, as the chat card says it),
// driven through the real queue and the real live feed. The dialog's own job is moved by WHICHEVER export is
// rendering, so the failure that matters is the dialog reading another export's numbers, or going quiet while a
// stage drags on; both are checked from what a person would see on screen.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ExportDialog from "./ExportDialog";
import { useEditor } from "../store/editor";
import { useExportJob } from "../store/exportJob";
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

let fs: ExportMemFs;
let store: ProjectStoreAccess;
const gates: Array<() => void> = [];

function gated() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  gates.push(release);
  return { wait: () => gate, open: () => release() };
}

/** An export the Export MENU started: no chat turn asked for it, and the dialog's own job follows it. */
async function startFromMenu(
  filename: string,
  run: () => Promise<unknown>,
): Promise<ExportSubmission> {
  const sub = await submitExport({
    store,
    dependencies: [],
    destPath: `/out/${filename}`,
    stagePath: `/out/${filename}.partial`,
    filename,
    run: async () => {
      await run();
      await fs.writeTextFile(`/out/${filename}.partial`, `encoded ${filename}`);
      return {};
    },
  });
  // An export at the head of the queue begins its run a moment after it is submitted: let it.
  if (sub.queue_position === 0)
    for (let turn = 0; turn < 50 && useExportJob.getState().live?.jobId !== sub.job_id; turn++)
      await Promise.resolve();
  return sub;
}

const status = () => screen.getByTestId("export-status").textContent;
const pace = () => screen.getByTestId("export-pace").textContent;
const report = (over: Parameters<ReturnType<typeof useExportJob.getState>["update"]>[0]) =>
  act(() => useExportJob.getState().update({ phase: "rendering", ...over }));
const stage = (jobId: string, to: "preparing" | "rendering" | "checking" | "saving") =>
  act(() => useExportJob.getState().setLiveStage(jobId, to));
const open = () => render(<ExportDialog open onCancel={() => {}} onStart={() => {}} />);

beforeEach(() => {
  __resetExportQueue();
  fs = new ExportMemFs();
  store = new ProjectStoreAccess("/proj", fs);
  useExportJob.getState().reset();
  useExportJob.setState({ live: null, finishing: {}, calibrations: [] });
  useEditor.setState({ projectId: "p", store });
});
afterEach(async () => {
  cleanup();
  for (const release of gates.splice(0)) release();
  await whenExportsSettle();
  __resetExportQueue();
  vi.useRealTimers();
  useEditor.setState({ projectId: null, store: null });
});

describe("the Export dialog's panel, while its export goes", () => {
  it("names the stage the export is at, with how far it is, then the speed and time left, as the chat card does", async () => {
    const g = gated();
    useExportJob.getState().begin(null);
    const sub = await startFromMenu("film.mp4", g.wait);
    act(() => useExportJob.getState().attach(sub.job_id));
    open();
    expect(status()).toBe("Preparing · checking your clips");
    stage(sub.job_id, "rendering");
    report({ fraction: 0.4, etaSec: 90, speed: 2, frame: 120 });
    expect(status()).toBe("Rendering and encoding · 40%");
    expect(pace()).toBe("2.0× · 1m 30s left");
    // The render is over; the file is checked, then saved. Naming them is the point: the bar sits at 100% for minutes.
    stage(sub.job_id, "checking");
    expect(status()).toBe("Checking the file");
    expect(pace()).toBe(""); // nothing left to time
    stage(sub.job_id, "saving");
    expect(status()).toBe("Saving");
    g.open();
  });

  it("names the part of a streamed render it is on, so a long render does not look like one frozen number", async () => {
    const g = gated();
    useExportJob.getState().begin(null);
    const sub = await startFromMenu("film.mp4", g.wait);
    act(() => useExportJob.getState().attach(sub.job_id));
    open();
    stage(sub.job_id, "rendering");
    report({ fraction: 0.25, etaSec: 600, speed: 1, frame: 10, step: 1, steps: 4 });
    expect(status()).toBe("Rendering part 2 of 3 · 25%");
    report({ fraction: 0.9, etaSec: 30, speed: 1, frame: 400, step: 3, steps: 4 });
    expect(status()).toBe("Encoding · 90%");
    g.open();
  });

  // The failure direction. The dialog's job is moved by whichever export is rendering, so a menu export that is
  // waiting behind another would otherwise say it is 80% done.
  it("says it is waiting, and where, while another export has the turn, never the other export's percent", async () => {
    const first = gated();
    const firstSub = await startFromMenu("first.mp4", first.wait);
    useExportJob.getState().begin(null); // the person then exports from the menu
    const second = gated();
    const secondSub = await startFromMenu("second.mp4", second.wait);
    expect(secondSub.queue_position).toBeGreaterThan(0);
    act(() => useExportJob.getState().attach(secondSub.job_id));
    open();
    stage(firstSub.job_id, "rendering");
    report({ fraction: 0.8, etaSec: 20, speed: 3, frame: 900 }); // the FIRST export's progress
    expect(status()).toBe("Waiting · 1st in line");
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow"); // not 80% either
    expect(pace()).toBe("");
    // Its turn comes: now it says what it is doing.
    first.open();
    await vi.waitFor(() => expect(useExportJob.getState().live?.jobId).toBe(secondSub.job_id));
    expect(status()).toBe("Preparing · checking your clips");
    second.open();
  });

  it("keeps the old numbers for a job whose export has no id yet (the moment before it is admitted)", () => {
    useExportJob.getState().begin(null);
    open();
    expect(status()).toBe("Preparing…");
    report({ fraction: 0.42, etaSec: 90, speed: 2 });
    expect(status()).toBe("42%");
    expect(pace()).toBe("2.0× · 1m 30s left");
  });

  describe("a line that is refreshed by a clock", () => {
    const fake = () =>
      vi.useFakeTimers({ now: 5_000_000, toFake: ["Date", "setInterval", "clearInterval"] });

    it("says how long it has been at it, at least once a minute, even when nothing new was reported", async () => {
      fake();
      const g = gated();
      useExportJob.getState().begin(null);
      const sub = await startFromMenu("film.mp4", g.wait);
      act(() => useExportJob.getState().attach(sub.job_id));
      open();
      stage(sub.job_id, "checking"); // a long check reports nothing at all
      expect(status()).toBe("Checking the file");
      act(() => {
        vi.setSystemTime(5_000_000 + 190_000);
        vi.advanceTimersByTime(10_000);
      });
      expect(status()).toBe("Still working · 3 min in · Checking the file");
      g.open();
    });

    it("says there is no progress, for how long, once the render stops moving, and gives no time left then", async () => {
      fake();
      const g = gated();
      useExportJob.getState().begin(null);
      const sub = await startFromMenu("film.mp4", g.wait);
      act(() => useExportJob.getState().attach(sub.job_id));
      open();
      stage(sub.job_id, "rendering");
      report({ fraction: 0.4, etaSec: 90, speed: 2, frame: 120 });
      expect(pace()).toBe("2.0× · 1m 30s left");
      act(() => {
        vi.setSystemTime(5_000_000 + 75_000);
        vi.advanceTimersByTime(10_000);
      });
      expect(status()).toBe("No progress for 85 s · Rendering and encoding · 40%");
      expect(pace()).toBe("2.0×");
      // It moves again: back to normal.
      report({ fraction: 0.5, etaSec: 60, speed: 2, frame: 150 });
      expect(status()).toMatch(/^(Still working · 1 min in · )?Rendering and encoding · 50%$/);
      g.open();
    });

    it("leaves no clock running once the dialog is gone", () => {
      fake();
      const before = vi.getTimerCount();
      useExportJob.getState().begin(null);
      const view = open();
      expect(vi.getTimerCount()).toBeGreaterThan(before);
      view.unmount();
      expect(vi.getTimerCount()).toBe(before);
    });
  });

  it("says the result, not a stage, once the export has ended", async () => {
    const g = gated();
    useExportJob.getState().begin(null);
    const sub = await startFromMenu("film.mp4", g.wait);
    act(() => useExportJob.getState().attach(sub.job_id));
    open();
    stage(sub.job_id, "saving");
    g.open();
    await whenExportsSettle();
    act(() =>
      useExportJob.getState().finish({ phase: "done", fraction: 1, savedTo: "D:/Videos/film.mp4" }),
    );
    expect(status()).toBe("Done");
    expect(screen.getByText("Saved to D:/Videos/film.mp4")).toBeVisible();
  });
});
