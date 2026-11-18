// A canvas that the editor holds but the view cannot read (width NaN, height a string, rate 0, ...), while the dialog's snapshot of the project is given. `factsOf` in ExportSettingsView.tsx reads the open project's
// canvas when all three numbers are PRESENT, and falls back to the snapshot only when one is absent: a canvas that is present and unusable is not a stand-in for the snapshot, so the project has no facts, the lists
// have nothing to offer and Export sends the plain Quality settings. Only the pure model was tested for this; this file reads it the way a person does: the rows on screen and what onStart received. The expected
// values are written out here. The only boundaries mocked are the ones the dialog tests mock: the app's look at the encoder and the PC the Graphics chip row asks.
// Mutant this file must kill: the view falling back to the snapshot's size and rate when the live canvas is unreadable (it would draw a Resolution row and a Frame rate row from a canvas that is not there).
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { processorName, resolveExportResources, runCapabilityProbe } from "../platform/host";
import { useEditor } from "../store/editor";
import { useExportJob } from "../store/exportJob";
import { amd, harness } from "../test/chipHarness";
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

/** What the dialog snapshotted when it opened: a good project, 1080 x 1920 at 30, two minutes long. */
const SNAPSHOT: RenderWorkload = {
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

/** A canvas written straight into the store: the types forbid these values, a damaged project file does not. */
const setCanvas = (canvas: Record<string, unknown>) =>
  useEditor.setState({
    timeline: {
      ...emptyTimeline(),
      canvas: canvas as unknown as ReturnType<typeof emptyTimeline>["canvas"],
    },
  });

const settle = () =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));
const optionNames = (box: HTMLElement) =>
  within(box)
    .getAllByRole("option")
    .map((option) => option.textContent);
const resolutionBox = () => screen.queryByRole("combobox", { name: "resolution" });
const rateBox = () => screen.queryByRole("combobox", { name: "frame rate" });
const door = () => screen.getByRole("button", { name: "Advanced settings" });

function mount() {
  const onStart = vi.fn<(settings: ExportSettings) => void>();
  render(<ExportSettingsView workload={SNAPSHOT} onCancel={vi.fn()} onStart={onStart} />);
  return { onStart, user: userEvent.setup() };
}

const UNREADABLE: [string, Record<string, unknown>][] = [
  ["a width that is NaN", { width: Number.NaN, height: 1920, fps: 30 }],
  ["a height that is a string", { width: 1080, height: "1920", fps: 30 }],
  ["a frame rate of 0", { width: 1080, height: 1920, fps: 0 }],
  ["a negative width", { width: -1080, height: 1920, fps: 30 }],
  ["an infinite height", { width: 1080, height: Number.POSITIVE_INFINITY, fps: 30 }],
];

describe("a canvas that is present but not readable, with a good snapshot of the project", () => {
  it.each(UNREADABLE)(
    "%s: no Resolution row, no Frame rate row, and Export sends the plain settings",
    async (_name, canvas) => {
      setCanvas(canvas);
      const { onStart, user } = mount();
      await settle();

      // the snapshot is not a stand-in for a canvas that is there but cannot be read
      expect(resolutionBox()).toBeNull();
      await user.click(door());
      expect(rateBox()).toBeNull();
      // the door is not empty: Quality is still offered, on Medium, and it is the only select on the page
      expect(screen.getByRole("combobox", { name: "quality" })).toHaveValue("medium");
      expect(screen.getAllByRole("combobox")).toHaveLength(1);

      await user.click(screen.getByRole("button", { name: "Export" }));
      expect(onStart).toHaveBeenCalledTimes(1);
      // the look has answered for these settings (no row wanted), so the app decides how: `mode` is null
      expect(onStart.mock.calls[0][0]).toStrictEqual({
        resolution: "source",
        quality: "medium",
        fps: null,
        mode: null,
      });
    },
  );

  it("with the app's answer not in, Export sends Quality as the way and the plain size and rate", async () => {
    vi.mocked(decideExportEncoder).mockImplementation(
      () => new Promise<ExportEncoderDecision>(() => undefined),
    );
    setCanvas({ width: Number.NaN, height: 1920, fps: 30 });
    const { onStart, user } = mount();
    await settle();
    await user.click(screen.getByRole("button", { name: "Export" }));
    expect(onStart.mock.calls[0][0]).toStrictEqual({
      resolution: "source",
      quality: "medium",
      fps: null,
      mode: "quality",
    });
  });
});

describe("the snapshot is read where the project has no canvas to read (the other side of the same rule)", () => {
  const SNAPSHOT_SIZES = ["Same as project (1080 x 1920)", "720p", "480p"];
  const SNAPSHOT_RATES = ["Same as project (30 fps)", "25 fps", "24 fps"];

  it("with no project open: the rows come from the snapshot", async () => {
    const { user } = mount();
    await settle();
    expect(optionNames(resolutionBox()!)).toEqual(SNAPSHOT_SIZES);
    await user.click(door());
    expect(optionNames(rateBox()!)).toEqual(SNAPSHOT_RATES);
  });

  it("with a canvas that lacks its rate (absent, not unreadable): the rows come from the snapshot", async () => {
    setCanvas({ width: 1280, height: 720 });
    const { user } = mount();
    await settle();
    expect(optionNames(resolutionBox()!)).toEqual(SNAPSHOT_SIZES);
    await user.click(door());
    expect(optionNames(rateBox()!)).toEqual(SNAPSHOT_RATES);
  });
});
