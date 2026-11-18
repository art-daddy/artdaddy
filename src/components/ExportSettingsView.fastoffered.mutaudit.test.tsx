// Rules of the Quality | Fast settings view that a mutation audit (round 3) found no test for. Each case fails on a one-line break of the view and passes on the real code:
//  - a Frame rate dropped because the view stopped offering Fast is dropped for good: it does not come back when Fast is offered again (the clamp effect reads `fastChoice` and re-runs when it changes);
//  - what the view draws is the same at the first render after the change as after the effects have run (no frame shows a rate the list does not hold): the app's look is never asked about it.
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

/** Opens the dialog on a 1080p project at 72 fps: the Frame rate list is Same, 60, 50, 30, 25, 24 and 18 (Fast's own rate, which the ladder has not got) while Fast is offered. */
async function open72(choice: "quality" | "fast") {
  useEditor.setState({
    timeline: { ...emptyTimeline(), canvas: { width: 1920, height: 1080, fps: 72 } },
  });
  const onStart = vi.fn<(settings: ExportSettings) => void>();
  const user = userEvent.setup();
  const props = { workload: workload72, onCancel: () => undefined, onStart };
  const view = render(<ExportSettingsView {...props} />);
  const offerFast = (offered: boolean) =>
    view.rerender(<ExportSettingsView {...props} fastChoice={offered} />);
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
  return { box, listed, pick, sent, offerFast, user };
}

const WITH_FAST = [
  "Same as project (72 fps)",
  "60 fps",
  "50 fps",
  "30 fps",
  "25 fps",
  "24 fps",
  "18 fps",
];
const LADDER_ONLY = WITH_FAST.slice(0, -1);

describe("a Frame rate dropped because the view stopped offering Fast", () => {
  it("stays dropped when Fast is offered again: the select shows the choice's own rate and Export sends it", async () => {
    // Quality is the choice, so 18 fps is a pick (Fast's own rate would be shown with or without the pick)
    const { box, listed, pick, sent, offerFast } = await open72("quality");
    expect(listed()).toEqual(WITH_FAST);
    await pick("18 fps");
    expect(box().value).toBe("18");

    act(() => offerFast(false));
    expect(listed()).toEqual(LADDER_ONLY);
    expect(box().value).toBe("");

    act(() => offerFast(true));
    expect(listed()).toEqual(WITH_FAST);
    expect(box().value).toBe("");
    const settings = await sent();
    expect(settings.fps).toBeNull();
    expect("route" in settings).toBe(false);
  });

  it("is never what the app's look is asked about, not even for the first draw after the change", async () => {
    const { box, pick, offerFast } = await open72("fast");
    await pick("18 fps");
    expect(box().value).toBe("18");
    const asked = () =>
      vi.mocked(decideExportEncoder).mock.calls.map(([request]) => request.settings.fps ?? null);
    expect(asked()).toContain(18);

    vi.mocked(decideExportEncoder).mockClear();
    act(() => offerFast(false));
    // the look is asked for Quality's own values (the project's rate), and never for 18 on the way
    expect(asked().length).toBeGreaterThan(0);
    expect(asked()).not.toContain(18);
    expect(asked()[asked().length - 1]).toBeNull();
  });
});
