// A rule of the Quality | Fast settings view that a mutation audit found no test for (the case fails on a one-line break of the view and passes on the real code):
//  - without the row the choice is Quality: a view that was told to stop offering Fast after Fast was picked sends the Quality object again.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These tests are about the Quality | Fast row, so they hold the choice offered whatever the constant says (the real dialog without it is held by ExportDialog.noChoiceConstant.test.tsx).
vi.mock("../timeline/exportChoiceView", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../timeline/exportChoiceView")>()),
  FAST_CHOICE_OFFERED: true,
}));

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { processorName, resolveExportResources, runCapabilityProbe } from "../platform/host";
import { useEditor } from "../store/editor";
import { useExportJob } from "../store/exportJob";
import { harness } from "../test/chipHarness";
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
  useExportJob.getState().setEngine("auto");
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
  __resetExportAsk();
  __resetExportFlags();
  useEditor.setState({ timeline: null });
});

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
const setCanvas = (width: number, height: number, fps: number) =>
  useEditor.setState({ timeline: { ...emptyTimeline(), canvas: { width, height, fps } } });
const settle = () =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, 30))));
const noop = (): void => undefined;

describe("without the row the choice is Quality", () => {
  it("a view told to stop offering Fast after Fast was picked sends the Quality object", async () => {
    setCanvas(3840, 2160, 60);
    const onStart = vi.fn<(settings: ExportSettings) => void>();
    const props = {
      workload: workloadOf(3840, 2160, 60),
      onCancel: noop,
      onStart,
    };
    const view = render(<ExportSettingsView {...props} />);
    await settle();
    fireEvent.click(screen.getByRole("radio", { name: "Fast" }));
    await settle();
    view.rerender(<ExportSettingsView {...props} fastChoice={false} />);
    await settle();
    expect(screen.queryByRole("radiogroup", { name: "export choice", hidden: true })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(onStart).toHaveBeenCalledTimes(1);
    const sent = onStart.mock.calls[0][0];
    // the project's own size and rate at Medium (Fast would have sent 1080p at 30), and no route
    expect(sent.resolution).toBe("source");
    expect(sent.fps).toBeNull();
    expect(sent.quality).toBe("medium");
    expect(sent).not.toHaveProperty("route");
    expect(Object.keys(sent).sort()).toEqual(["fps", "mode", "quality", "resolution"]);
  });
});
