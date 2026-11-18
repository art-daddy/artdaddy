// What the Frame rate select shows is what Export sends, also when the project's rate changes under the open dialog. A rate that was an entry of the list (Fast's own rate is an entry where the ladder
// has none: 72 gives 18, 64 gives 16) can stop being one while it is still below the project's rate; it is then dropped, never sent while the select shows another value.
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

/** Opens the dialog on a 1080p project at 72 fps (Frame rate list: Same, 60, 50, 30, 25, 24 and 18, Fast's own), with the door open. */
async function open72(choice: "quality" | "fast") {
  setCanvas(1920, 1080, 72);
  const onStart = vi.fn<(settings: ExportSettings) => void>();
  const user = userEvent.setup();
  render(
    <ExportSettingsView
      workload={workloadOf(1920, 1080, 72)}
      onCancel={() => undefined}
      onStart={onStart}
    />,
  );
  if (choice === "fast") await user.click(screen.getByRole("radio", { name: "Fast" }));
  await user.click(screen.getByRole("button", { name: "Advanced settings" }));
  const box = () =>
    screen.getByRole("combobox", { name: "frame rate", hidden: true }) as HTMLSelectElement;
  const listed = () =>
    within(box())
      .getAllByRole("option", { hidden: true })
      .map((option) => option.textContent);
  const pick = (name: string) =>
    user.selectOptions(box(), within(box()).getByRole("option", { name, hidden: true }));
  const sent = async (): Promise<ExportSettings> => {
    await user.click(screen.getByRole("button", { name: "Export" }));
    expect(onStart).toHaveBeenCalledTimes(1);
    return onStart.mock.calls[0]![0];
  };
  return { box, listed, pick, sent };
}

describe("the Frame rate select and Export agree after the project's rate changed under the dialog", () => {
  it.each(["quality", "fast"] as const)(
    "%s: Fast's own rate of the old project (18 at 72 fps) is dropped when the new project (64 fps) does not list it, and what is shown is what is sent",
    async (choice) => {
      const { box, listed, pick, sent } = await open72(choice);
      expect(listed()).toEqual([
        "Same as project (72 fps)",
        "60 fps",
        "50 fps",
        "30 fps",
        "25 fps",
        "24 fps",
        "18 fps",
      ]);
      await pick("18 fps");
      expect(box().value).toBe("18");

      // 64 fps: the ladder still gives 60, 50, 30, 25, 24 and Fast's own rate is now 16; 18 is below the project's rate and no longer an entry
      act(() => setCanvas(1920, 1080, 64));
      expect(listed()).toEqual([
        "Same as project (64 fps)",
        "60 fps",
        "50 fps",
        "30 fps",
        "25 fps",
        "24 fps",
        "16 fps",
      ]);
      // the pick is gone: the select shows the choice's own rate, Same as project for Quality and Fast's own 16 for Fast
      expect(box().value).toBe(choice === "fast" ? "16" : "");

      const settings = await sent();
      expect(settings.fps).toBe(choice === "fast" ? 16 : null);
      if (choice === "fast")
        expect(settings.route).toEqual({
          route: "quick",
          explicit: { size: false, fps: false, quality: false },
        });
      else expect("route" in settings).toBe(false);
    },
  );

  it.each(["quality", "fast"] as const)(
    "%s: a pick the new list still holds stays, shown and sent (24 at 72 fps, then 64 fps)",
    async (choice) => {
      const { box, pick, sent } = await open72(choice);
      await pick("24 fps");
      act(() => setCanvas(1920, 1080, 64));
      expect(box().value).toBe("24");
      const settings = await sent();
      expect(settings.fps).toBe(24);
      if (choice === "fast") expect(settings.route?.explicit.fps).toBe(true);
    },
  );

  it("Fast's own rate off the ladder, picked on the project that lists it, is sent as a pick (18 at 72 fps)", async () => {
    const { pick, sent } = await open72("fast");
    await pick("18 fps");
    const settings = await sent();
    expect(settings.fps).toBe(18);
    expect(settings.route).toEqual({
      route: "quick",
      explicit: { size: false, fps: true, quality: false },
    });
  });
});
