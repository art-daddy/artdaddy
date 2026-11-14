// The Graphics chip row as the Export dialog mounts it: where the app finds a chip, only with the server's switch for Quick export on, and
// the dialog asks the app about the encoder again when the person changes the switch.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __setExportFlag } from "../api/exportFlags";
import { resolveExportResources, runCapabilityProbe, processorName } from "../platform/host";
import { useExportJob } from "../store/exportJob";
import { amd, harness } from "../test/chipHarness";
import { CHIP_PREF_KEY } from "../timeline/chipPref";
import { __resetChipTests } from "../timeline/chipTest";
import { decideExportEncoder, type ExportEncoderDecision } from "../timeline/exportChoice";
import ExportDialog from "./ExportDialog";

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
const PROJECT = {
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
  useExportJob.getState().setEngine("auto");
  useExportJob.setState({ calibrations: [] });
  vi.mocked(decideExportEncoder).mockReset();
  vi.mocked(decideExportEncoder).mockImplementation(async () => decision());
});
afterEach(() => {
  cleanup();
  __setExportFlag("quick_export", true);
});

const open = () =>
  render(
    <ExportDialog open onCancel={() => undefined} onStart={() => undefined} workload={PROJECT} />,
  );

describe("the Export dialog and the Graphics chip row", () => {
  it("shows the row under the settings where the app finds a chip, and not on a PC with none", async () => {
    pcWith([]);
    const bare = open();
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));
    expect(screen.queryByRole("radiogroup", { name: "Graphics chip" })).toBeNull();
    bare.unmount();

    pcWith([amd]);
    open();
    expect(await screen.findByRole("radiogroup", { name: "Graphics chip" })).toBeVisible();
    // the settings above it are untouched
    for (const name of ["resolution", "quality", "frame rate"])
      expect(screen.getByRole("combobox", { name })).toBeVisible();
  });

  it("is not there with the server's switch for Quick export off: the dialog is the one it was", async () => {
    pcWith([amd]);
    __setExportFlag("quick_export", false);
    open();
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));
    expect(screen.queryByTestId("chip-row")).toBeNull();
    expect(screen.queryByText("Graphics chip")).toBeNull();
    expect(screen.getAllByRole("combobox").map((box) => box.getAttribute("aria-label"))).toEqual([
      "resolution",
      "quality",
      "frame rate",
    ]);
  });

  it("says nothing of the chip, and tests nothing, when the dialog has no project to export", async () => {
    pcWith([amd]);
    render(<ExportDialog open onCancel={() => undefined} onStart={() => undefined} />);
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));
    expect(screen.queryByTestId("chip-row")).toBeNull();
    expect(runCapabilityProbe).not.toHaveBeenCalled();
  });

  it("asks the app about the encoder again when the person switches the chip Off, and the chip is then not offered", async () => {
    pcWith([amd]);
    open();
    await screen.findByRole("radiogroup", { name: "Graphics chip" });
    await waitFor(() => expect(decideExportEncoder).toHaveBeenCalled());
    const asked = vi.mocked(decideExportEncoder).mock.calls.length;
    fireEvent.click(screen.getByRole("radio", { name: "Off" }));
    await waitFor(() =>
      expect(vi.mocked(decideExportEncoder).mock.calls.length).toBeGreaterThan(asked),
    );
    expect(localStorage.getItem(CHIP_PREF_KEY)).toBe("off");
    expect(screen.getByTestId("chip-row-note")).toHaveTextContent(
      "Off: the graphics chip is not tested, offered or used on this PC.",
    );
  });
});
