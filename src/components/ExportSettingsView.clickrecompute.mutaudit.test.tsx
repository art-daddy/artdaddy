// The click recomputes what it sends from the live project and from what the view offers, so Export sends what the select shows even where the state still holds a pick the list does not (a mutation audit, round 3, found no test for it):
// the clamp effect that drops such a pick for good is taken out of the way here (it runs after the paint, so a click can come first), and a view told to stop offering Fast must still send the Quality object, not Fast's own rate.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { processorName, resolveExportResources, runCapabilityProbe } from "../platform/host";
import { useEditor } from "../store/editor";
import { useExportJob } from "../store/exportJob";
import { harness } from "../test/chipHarness";
import { __resetChipTests } from "../timeline/chipTest";
import * as exportAsk from "../timeline/exportAsk";
import { decideExportEncoder, type ExportEncoderDecision } from "../timeline/exportChoice";
import { clampOverrides } from "../timeline/exportChoiceView";
import { emptyTimeline } from "../timeline/model";
import type { RenderWorkload } from "../timeline/renderPlan";
import type { ExportSettings } from "./ExportDialog";
import ExportSettingsView from "./ExportSettingsView";

// only the view's own call (its effect) goes through this export: `resolveChoice` inside the module calls its own clamp
vi.mock("../timeline/exportChoiceView", async (importOriginal) => {
  const real = await importOriginal<typeof import("../timeline/exportChoiceView")>();
  return { ...real, clampOverrides: vi.fn(real.clampOverrides) };
});
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

beforeEach(() => {
  localStorage.clear();
  __resetChipTests();
  __setExportFlag("quick_export", true);
  useExportJob.getState().reset();
  useExportJob.setState({ calibrations: [], modeRowOnScreen: null });
  useEditor.setState({ timeline: null });
  vi.mocked(decideExportEncoder).mockReset();
  vi.mocked(decideExportEncoder).mockImplementation(async () => decision());
  const scripted = harness([]);
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
    adapters: [],
  });
  vi.mocked(processorName).mockReset();
  vi.mocked(processorName).mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  exportAsk.__resetExportAsk();
  __resetExportFlags();
  useEditor.setState({ timeline: null });
});

const workload72: RenderWorkload = {
  width: 1920,
  height: 1080,
  fps: 72,
  durationSeconds: 120,
  visualClips: 6,
  captionClips: 1,
  audioClips: 1,
  peakVisualLayers: 2,
  peakMediaLayers: 2,
};

/** Opens the dialog on a 1080p project at 72 fps with Fast chosen: the Frame rate list is Same, 60, 50, 30, 25, 24 and 18 (Fast's own rate) while Fast is offered. */
async function openFast72() {
  useEditor.setState({
    timeline: { ...emptyTimeline(), canvas: { width: 1920, height: 1080, fps: 72 } },
  });
  const onStart = vi.fn<(settings: ExportSettings) => void>();
  const user = userEvent.setup();
  const props = { workload: workload72, onCancel: () => undefined, onStart };
  const view = render(<ExportSettingsView {...props} />);
  const offerFast = (offered: boolean) =>
    view.rerender(<ExportSettingsView {...props} fastChoice={offered} />);
  await user.click(screen.getByRole("radio", { name: "Fast" }));
  await user.click(screen.getByRole("button", { name: "Advanced settings" }));
  const box = () =>
    screen.getByRole("combobox", { name: "frame rate", hidden: true }) as HTMLSelectElement;
  const pick = (name: string) =>
    user.selectOptions(box(), within(box()).getByRole("option", { name, hidden: true }));
  const sent = async (): Promise<ExportSettings> => {
    await user.click(screen.getByRole("button", { name: "Export" }));
    expect(onStart).toHaveBeenCalledTimes(1);
    return onStart.mock.calls[0]![0];
  };
  return { box, pick, sent, offerFast };
}

describe("Export sends what the select shows although the state still holds a pick the list does not", () => {
  it("a view told to stop offering Fast sends the project's own rate, not Fast's own 18 fps (the clamp effect has not run)", async () => {
    const { box, pick, sent, offerFast } = await openFast72();
    await pick("18 fps");
    expect(box().value).toBe("18");

    vi.mocked(clampOverrides).mockImplementation((overrides) => overrides);
    act(() => offerFast(false));
    // the list is the ladder alone and the choice is Quality: Same as project is shown
    expect(box().value).toBe("");
    const settings = await sent();
    expect(settings.fps).toBeNull();
    expect("route" in settings).toBe(false);
  });

  it("a view that still offers Fast sends the same pick, as a pick of the Quick route (18 fps)", async () => {
    const { box, pick, sent } = await openFast72();
    await pick("18 fps");
    vi.mocked(clampOverrides).mockImplementation((overrides) => overrides);
    expect(box().value).toBe("18");
    const settings = await sent();
    expect(settings.fps).toBe(18);
    expect(settings.route).toEqual({
      route: "quick",
      explicit: { size: false, fps: true, quality: false },
    });
  });
});
