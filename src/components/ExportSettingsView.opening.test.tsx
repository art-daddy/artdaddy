// Every opening of the Export dialog starts afresh (the owner's yes, OD-12: this CHANGES 0.28.0, which kept the size, the quality and the frame rate until the app was closed). The settings view is a child that mounts when the
// dialog opens and unmounts when it closes, so everything it keeps is for one opening: a view mounted again is a new opening. A draw of the same view (no unmount) is not one, and keeps the picks, so that the two can be
// told apart. The one thing that lives longer is the Graphics chip's own switch, which is the browser's per-PC storage. The only boundaries mocked are the ones the dialog tests mock.
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { processorName, resolveExportResources, runCapabilityProbe } from "../platform/host";
import { useEditor } from "../store/editor";
import { useExportJob } from "../store/exportJob";
import { amd, harness } from "../test/chipHarness";
import { CHIP_PREF_KEY } from "../timeline/chipPref";
import { __resetChipTests } from "../timeline/chipTest";
import { __resetExportAsk } from "../timeline/exportAsk";
import { decideExportEncoder, type ExportEncoderDecision } from "../timeline/exportChoice";
import { emptyTimeline } from "../timeline/model";
import type { RenderWorkload } from "../timeline/renderPlan";
import type { ExportSettings } from "./ExportDialog";
import ExportSettingsView from "./ExportSettingsView";

vi.mock("../timeline/exportChoice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../timeline/exportChoice")>()),
  decideExportEncoder: vi.fn(),
}));
vi.mock("../platform/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform/host")>()),
  runCapabilityProbe: vi.fn(),
  resolveExportResources: vi.fn(),
  processorName: vi.fn(),
}));
vi.mock("../tools/dataRoot", () => ({ appCacheRoot: async () => "C:/cache" }));
vi.mock("../tools/tauri", () => ({
  TauriFs: class {
    async mkdir(): Promise<void> {}
    async remove(): Promise<void> {}
  },
}));

const decision = (over: Partial<ExportEncoderDecision> = {}): ExportEncoderDecision => ({
  mode: "quality",
  reason: "none",
  showRow: false,
  defaultMode: "quality",
  fullSeconds: 40,
  fastSeconds: null,
  fullGuessed: true,
  tests: [],
  facts: { encoder: "x264", reason: "none", tests: [] },
  ...over,
});

/** The PC the Graphics chip row asks: these adapters, and nothing else to say. */
function pcWith(adapters: (typeof amd)[]) {
  const scripted = harness(adapters);
  vi.mocked(runCapabilityProbe).mockReset();
  vi.mocked(runCapabilityProbe).mockImplementation((args, options) =>
    scripted.deps.probe(args, options),
  );
  vi.mocked(resolveExportResources).mockReset();
  vi.mocked(resolveExportResources).mockResolvedValue({
    total_memory_bytes: null,
    available_memory_bytes: null,
    scratch_free_bytes: null,
    destination_free_bytes: null,
    budgets: { memoryBytes: null, temporaryBytes: null, executionSeconds: null },
    adapters,
  });
  vi.mocked(processorName).mockReset();
  vi.mocked(processorName).mockResolvedValue(null);
}

beforeEach(() => {
  localStorage.clear();
  __resetChipTests();
  __setExportFlag("quick_export", true);
  useExportJob.getState().reset();
  useExportJob.setState({ calibrations: [], modeRowOnScreen: null });
  useEditor.setState({ timeline: null });
  vi.mocked(decideExportEncoder).mockReset();
  vi.mocked(decideExportEncoder).mockImplementation(async () => decision());
  pcWith([]);
});
afterEach(() => {
  cleanup();
  __resetExportAsk();
  __resetExportFlags();
  useEditor.setState({ timeline: null });
});

const setCanvas = (width: number, height: number, fps: number) =>
  useEditor.setState({ timeline: { ...emptyTimeline(), canvas: { width, height, fps } } });
const workloadOf = (width: number, height: number, fps: number): RenderWorkload => ({
  width,
  height,
  fps,
  durationSeconds: 120,
  visualClips: 6,
  captionClips: 1,
  audioClips: 1,
  peakVisualLayers: 2,
  peakMediaLayers: 2,
});
const settle = () =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));

const NOT_ASKED = { onCancel: vi.fn(), onStart: vi.fn() };
function mount(workload: RenderWorkload | null = null, onStart = vi.fn<(s: ExportSettings) => void>()) {
  const user = userEvent.setup();
  const view = render(<ExportSettingsView workload={workload} onCancel={NOT_ASKED.onCancel} onStart={onStart} />);
  return { ...view, onStart, user };
}
type Mounted = ReturnType<typeof mount>;

type Box = "resolution" | "frame rate" | "quality";
const box = (name: Box) => screen.getByRole("combobox", { name });
const door = () => screen.getByRole("button", { name: "Advanced settings" });
const exportButton = () => screen.getByRole("button", { name: "Export" });
const openDoor = async (user: Mounted["user"]) => {
  if (door().getAttribute("aria-expanded") !== "true") await user.click(door());
};
async function choose(view: Mounted, name: Box, entry: string) {
  if (name !== "resolution") await openDoor(view.user);
  await view.user.selectOptions(box(name), entry);
}
/** The picks the person made in an opening: all three, and the door left open. */
async function pickEverything(view: Mounted) {
  await choose(view, "resolution", "720p");
  await choose(view, "frame rate", "24 fps");
  await choose(view, "quality", "High");
  expect(box("resolution")).toHaveValue("720p");
  expect(box("frame rate")).toHaveValue("24");
  expect(box("quality")).toHaveValue("high");
  expect(door()).toHaveAttribute("aria-expanded", "true");
}
/** What a fresh opening shows: every list on its first entry, Medium, and the door shut with its region hidden. */
function expectFresh() {
  expect(box("resolution")).toHaveValue("source");
  expect(door()).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByTestId("export-advanced")).not.toBeVisible();
}
async function expectFreshBehindTheDoor(view: Mounted) {
  await openDoor(view.user);
  expect(box("frame rate")).toHaveValue("");
  expect(box("quality")).toHaveValue("medium");
}

describe("an opening starts afresh", () => {
  it("shows Same as project, Same as project, Medium and a closed door, whatever the opening before had picked", async () => {
    setCanvas(1080, 1920, 30);
    const before = mount(null);
    await pickEverything(before);
    before.unmount();

    const now = mount(null);
    expectFresh();
    await expectFreshBehindTheDoor(now);
    await now.user.click(exportButton());
    expect(now.onStart).toHaveBeenCalledTimes(1);
    expect(now.onStart.mock.calls[0][0]).toStrictEqual({
      resolution: "source",
      quality: "medium",
      fps: null,
      mode: "quality",
    });
  });

  it("is so for every opening, not only the second: picks never carry over", async () => {
    setCanvas(3840, 2160, 60);
    for (const entry of ["1440p", "1080p", "720p"]) {
      const view = mount(null);
      expectFresh();
      await choose(view, "resolution", entry);
      await choose(view, "quality", "Low");
      view.unmount();
    }
    const last = mount(null);
    expectFresh();
    await expectFreshBehindTheDoor(last);
  });

  it("is so on another project too: a pick the new project would also hold does not come along", async () => {
    setCanvas(1080, 1920, 30);
    const before = mount(null);
    await choose(before, "resolution", "720p");
    await choose(before, "frame rate", "25 fps");
    before.unmount();
    // 4K at 60 offers 720p and 25 fps as well
    setCanvas(3840, 2160, 60);
    const now = mount(null);
    expect(box("resolution")).toHaveValue("source");
    await expectFreshBehindTheDoor(now);
  });

  it("keeps the app's look to the opening too: an answer from the opening before is not taken for this one's", async () => {
    const before = mount(workloadOf(1080, 1920, 30));
    await settle();
    await before.user.click(exportButton());
    expect(before.onStart.mock.calls[0][0].mode).toBeNull(); // the app had answered
    before.unmount();

    // this opening's look is still out: nobody has been offered anything yet
    vi.mocked(decideExportEncoder).mockImplementation(() => new Promise(() => undefined));
    const now = mount(workloadOf(1080, 1920, 30));
    await settle();
    await now.user.click(exportButton());
    expect(now.onStart.mock.calls[0][0].mode).toBe("quality");
  });

  it("keeps the picks and the door through a draw of the same view: only a new opening resets", async () => {
    setCanvas(1080, 1920, 30);
    const view = mount(null);
    await pickEverything(view);
    // the dialog draws again (new callbacks, a new copy of the snapshot, the same view): not an opening
    view.rerender(
      <ExportSettingsView workload={null} onCancel={vi.fn()} onStart={view.onStart} />,
    );
    expect(box("resolution")).toHaveValue("720p");
    expect(box("frame rate")).toHaveValue("24");
    expect(box("quality")).toHaveValue("high");
    expect(door()).toHaveAttribute("aria-expanded", "true");
    await view.user.click(exportButton());
    expect(view.onStart.mock.calls[0][0]).toStrictEqual({
      resolution: "720p",
      quality: "high",
      fps: 24,
      mode: "quality",
    });
  });

  it("keeps the picks through a new snapshot of the same project", async () => {
    const first = workloadOf(1080, 1920, 30);
    const view = mount(first);
    await settle();
    await pickEverything(view);
    view.rerender(
      <ExportSettingsView
        workload={{ ...first }}
        onCancel={vi.fn()}
        onStart={view.onStart}
      />,
    );
    await settle();
    expect(box("resolution")).toHaveValue("720p");
    expect(box("frame rate")).toHaveValue("24");
    expect(box("quality")).toHaveValue("high");
  });

  it("two views at once are two openings: a pick in one is not in the other", async () => {
    setCanvas(1080, 1920, 30);
    const one = mount(null);
    const other = mount(null);
    const selects = screen.getAllByRole("combobox", { name: "resolution" });
    expect(selects).toHaveLength(2);
    await one.user.selectOptions(selects[0], "720p");
    expect(selects[0]).toHaveValue("720p");
    expect(selects[1]).toHaveValue("source");
    other.unmount();
  });

  it("is the one thing the Graphics chip's own switch is not: it is the browser's per-PC storage and outlives the opening", async () => {
    pcWith([amd]);
    const before = mount(workloadOf(1080, 1920, 30));
    await pickEverything(before);
    const off = await screen.findByRole("radio", { name: "Off" });
    await before.user.click(off);
    expect(localStorage.getItem(CHIP_PREF_KEY)).toBe("off");
    before.unmount();

    const now = mount(workloadOf(1080, 1920, 30));
    expectFresh(); // everything else starts afresh
    await openDoor(now.user);
    expect(await screen.findByRole("radio", { name: "Off" })).toBeChecked();
    expect(box("quality")).toHaveValue("medium");
  });
});
