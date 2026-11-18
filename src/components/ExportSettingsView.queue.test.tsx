// V22 of the round-2 mutation run: the settings view draws the export queue (the list of exports waiting behind the running one, and the ones that ended) between the settings and the footer, and no test named
// it: the pane draws nothing while the queue is empty, so every other test of the view held with or without it. These tests drive the REAL queue (the way ExportQueuePane.test.tsx does) and read the view the way a
// person does: the pane's words are on screen when an export waits, a settled export keeps its row until it is dismissed, and none of it is drawn while the queue is empty. The expected words are written out here.
// Mutant this file must kill: the view not drawing the queue pane.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useEditor } from "../store/editor";
import { useExportJob } from "../store/exportJob";
import { ExportMemFs } from "../test/timelineKit";
import { __resetChipTests } from "../timeline/chipTest";
import { __resetExportAsk } from "../timeline/exportAsk";
import { decideExportEncoder, type ExportEncoderDecision } from "../timeline/exportChoice";
import { __resetExportQueue, submitExport, whenExportsSettle } from "../timeline/exportQueue";
import type { RenderWorkload } from "../timeline/renderPlan";
import { ProjectStoreAccess } from "../tools/store";
import ExportSettingsView from "./ExportSettingsView";

vi.mock("../timeline/exportChoice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../timeline/exportChoice")>()),
  decideExportEncoder: vi.fn(),
}));
// the same two doors ExportQueuePane.test.tsx closes: the queue records its jobs and tells the person when one settles
vi.mock("../tools/genJobs", () => ({
  openProjectJobs: async () => ({
    begin: async () => `job-${Math.random().toString(36).slice(2, 8)}`,
    settle: async () => undefined,
  }),
}));
vi.mock("../store/jobNotes", () => ({ notifyJobSettled: () => undefined }));

const decision = (): ExportEncoderDecision => ({
  mode: "quality",
  reason: "none",
  showRow: false,
  defaultMode: "quality",
  fullSeconds: 40,
  fastSeconds: null,
  fullGuessed: true,
  tests: [],
  facts: { encoder: "x264", reason: "none", tests: [] },
});

const PROJECT: RenderWorkload = {
  width: 1080,
  height: 1920,
  fps: 30,
  durationSeconds: 120,
  visualClips: 6,
  captionClips: 1,
  audioClips: 1,
  peakVisualLayers: 2,
  peakMediaLayers: 2,
};

let fs: ExportMemFs;
let store: ProjectStoreAccess;
const pendingGates: Array<() => void> = [];

/** An encode that only finishes when we say so, so a QUEUED row is observable. */
function gated(): { run: (s: AbortSignal) => Promise<{ warnings?: string[] }>; open: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  pendingGates.push(release);
  return {
    run: async () => {
      await gate;
      return {};
    },
    open: () => release(),
  };
}

const submit = (filename: string, run: (s: AbortSignal) => Promise<{ warnings?: string[] }>) => {
  const requestFs = fs;
  return submitExport({
    store,
    dependencies: [],
    destPath: `/out/${filename}`,
    stagePath: `/out/${filename}.partial`,
    filename,
    run: async (signal) => {
      const result = await run(signal);
      await requestFs.writeTextFile(`/out/${filename}.partial`, `encoded ${filename}`);
      return result;
    },
  });
};

beforeEach(() => {
  __resetExportQueue();
  fs = new ExportMemFs();
  store = new ProjectStoreAccess("/proj", fs);
  localStorage.clear();
  __resetChipTests();
  useExportJob.getState().reset();
  useExportJob.setState({ calibrations: [], modeRowOnScreen: null });
  useEditor.setState({ timeline: null });
  vi.mocked(decideExportEncoder).mockReset();
  vi.mocked(decideExportEncoder).mockImplementation(async () => decision());
});
afterEach(async () => {
  cleanup();
  for (const release of pendingGates.splice(0)) release();
  await whenExportsSettle();
  __resetExportQueue();
  __resetExportAsk();
  useEditor.setState({ timeline: null });
});

const settle = () =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));
const mount = () =>
  render(<ExportSettingsView workload={PROJECT} onCancel={vi.fn()} onStart={vi.fn()} />);
const pane = () => screen.queryByRole("region", { name: "export queue" });

describe("the export queue in the settings view", () => {
  it("draws the queue's words under the settings while an export waits behind the running one", async () => {
    const first = gated();
    await submit("one.mp4", first.run);
    await submit("two.mp4", async () => ({}));
    mount();
    await settle();

    const list = screen.getByRole("region", { name: "export queue" });
    expect(list).toBeVisible();
    expect(within(list).getByText("Export queue")).toBeVisible();
    expect(within(list).getByText("2")).toBeVisible();
    expect(within(list).getByText("one.mp4")).toBeVisible();
    expect(within(list).getByText("two.mp4")).toBeVisible();
    expect(within(list).getByText("Queued")).toBeVisible();
    expect(within(list).getByRole("button", { name: "cancel one.mp4" })).toBeVisible();
    expect(within(list).getByRole("button", { name: "cancel two.mp4" })).toBeVisible();
    // the settings and the footer are still there around it
    expect(screen.getByRole("button", { name: "Advanced settings" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Export" })).toBeVisible();

    first.open();
    await whenExportsSettle();
  });

  it("draws nothing of the queue while no export is waiting, running or finished", async () => {
    mount();
    await settle();

    expect(pane()).toBeNull();
    expect(screen.queryByText("Export queue")).toBeNull();
    expect(screen.queryByText("Queued")).toBeNull();
    expect(screen.queryByText("Clear finished")).toBeNull();
    // the rest of the view is drawn all the same
    expect(screen.getByRole("button", { name: "Advanced settings" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Export" })).toBeVisible();
  });

  it("follows the queue while the view is open: an export that finishes appears, and goes when it is dismissed", async () => {
    mount();
    await settle();
    expect(pane()).toBeNull();

    await act(async () => {
      await submit("good.mp4", async () => ({}));
      await whenExportsSettle();
    });
    const list = screen.getByRole("region", { name: "export queue" });
    expect(within(list).getByText("good.mp4")).toBeVisible();
    expect(within(list).getByText("Completed")).toBeVisible();

    await userEvent.setup().click(within(list).getByRole("button", { name: "dismiss good.mp4" }));
    expect(pane()).toBeNull();
    expect(screen.queryByText("good.mp4")).toBeNull();
  });
});
