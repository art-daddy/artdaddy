// The note under the Graphics chip row follows the choice. Under Quality the chip is used when it saves time, and the note says so; a Fast export uses a chip that passed whether or not it saves time
// (`chooseEncoder`, request "quick"), so under Fast the note must not say "when it saves time". Without the choice row the dialog is Quality only and keeps the first sentence.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import {
  processorName,
  resolveExportResources,
  runCapabilityProbe,
  type GraphicsAdapter,
} from "../platform/host";
import { useEditor } from "../store/editor";
import { useExportJob } from "../store/exportJob";
import { amd, harness } from "../test/chipHarness";
import { __resetChipTests } from "../timeline/chipTest";
import * as exportAsk from "../timeline/exportAsk";
import { decideExportEncoder, type ExportEncoderDecision } from "../timeline/exportChoice";
import { emptyTimeline } from "../timeline/model";
import type { RenderWorkload } from "../timeline/renderPlan";
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

function pcWith(adapters: GraphicsAdapter[]): void {
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
  useEditor.setState({
    timeline: { ...emptyTimeline(), canvas: { width: 1920, height: 1080, fps: 30 } },
  });
  vi.mocked(decideExportEncoder).mockReset();
  vi.mocked(decideExportEncoder).mockImplementation(async () => decision());
  pcWith([amd]);
});
afterEach(() => {
  cleanup();
  exportAsk.__resetExportAsk();
  __resetExportFlags();
  useEditor.setState({ timeline: null });
});

const workload: RenderWorkload = {
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

const QUALITY_NOTE =
  "Auto: used when it saves time. The file is usually larger and the picture can differ slightly.";
const FAST_NOTE =
  "Auto: used on this PC. The file is usually larger and the picture can differ slightly.";

const noteIs = (text: string) =>
  waitFor(() => expect(screen.getByTestId("chip-row-note").textContent).toBe(text));

describe("the Graphics chip note for a chip that passed, by choice", () => {
  it("says when the chip is used under Quality, and what a Fast export does under Fast, and follows the choice both ways", async () => {
    const user = userEvent.setup();
    render(
      <ExportSettingsView
        workload={workload}
        onCancel={() => undefined}
        onStart={() => undefined}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Advanced settings" }));
    await noteIs(QUALITY_NOTE);

    await user.click(screen.getByRole("radio", { name: "Fast" }));
    await noteIs(FAST_NOTE);
    expect(screen.getByTestId("chip-row-note").textContent).not.toMatch(/saves time/);

    await user.click(screen.getByRole("radio", { name: "Quality" }));
    await noteIs(QUALITY_NOTE);
  });

  it("keeps the Quality sentence where the dialog has no choice row", async () => {
    const user = userEvent.setup();
    render(
      <ExportSettingsView
        workload={workload}
        onCancel={() => undefined}
        onStart={() => undefined}
        fastChoice={false}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Advanced settings" }));
    await noteIs(QUALITY_NOTE);
    expect(screen.queryByRole("radio", { name: "Fast" })).toBeNull();
  });
});
