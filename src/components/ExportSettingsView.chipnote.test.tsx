// The note under the Graphics chip row, for a chip that passed, is one true sentence under Quality and under Fast: the chip is used whenever it passed, so the note says it is used on this PC and what that
// costs, and never claims a saving or a kind of export. The view still hands the row the entry that belongs to the choice (`fastChosen`); the two entries are the same sentence now, so what is drawn is the
// same after every change of the choice. Without the choice row the dialog is Quality only and says the same. The last block holds the 0.28.0-style dialog (the one this build draws) to the same sentence.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These tests are about the Quality | Fast row, so they hold the choice offered whatever the constant says (the real dialog without it is held by ExportDialog.noChoiceConstant.test.tsx).
vi.mock("../timeline/exportChoiceView", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../timeline/exportChoiceView")>()),
  FAST_CHOICE_OFFERED: true,
}));

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
import ExportDialog from "./ExportDialog";
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

const NOTE = "Auto: used on this PC. The file is usually larger.";
/** What the note must never claim: a saving, a length or a kind of export. */
const CLAIMS_A_SAVING = /saves? time|saving|long exports|minute/i;

const noteIs = (text: string) =>
  waitFor(() => expect(screen.getByTestId("chip-row-note").textContent).toBe(text));
const noteNow = () => screen.getByTestId("chip-row-note").textContent ?? "";

describe("the Graphics chip note for a chip that passed, by choice", () => {
  it("says the same under Quality and under Fast, names no saving, and follows the choice both ways", async () => {
    const user = userEvent.setup();
    render(
      <ExportSettingsView
        workload={workload}
        onCancel={() => undefined}
        onStart={() => undefined}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Advanced settings" }));
    await noteIs(NOTE);
    expect(noteNow()).not.toMatch(CLAIMS_A_SAVING);

    await user.click(screen.getByRole("radio", { name: "Fast" }));
    await noteIs(NOTE);
    expect(noteNow()).not.toMatch(CLAIMS_A_SAVING);

    await user.click(screen.getByRole("radio", { name: "Quality" }));
    await noteIs(NOTE);
    expect(noteNow()).not.toMatch(CLAIMS_A_SAVING);
  });

  it("says the same where the dialog has no choice row", async () => {
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
    await noteIs(NOTE);
    expect(noteNow()).not.toMatch(CLAIMS_A_SAVING);
    expect(screen.queryByRole("radio", { name: "Fast" })).toBeNull();
  });
});

// Both Export dialogs speak for the same chip, and the chip is used whenever it passed: the 0.28.0-style dialog (the one this build draws) and the Quality / Fast view must say the same of it.
describe("both Export dialogs say the same about a chip that passed", () => {
  it("is 'used on this PC' and no saving, in the 0.28.0-style dialog and in the Quality / Fast view under Quality and under Fast", async () => {
    const user = userEvent.setup();
    const live = render(
      <ExportDialog
        open
        onCancel={() => undefined}
        onStart={() => undefined}
        workload={workload}
      />,
    );
    await waitFor(() => expect(noteNow()).toMatch(/^Auto: used on this PC\./));
    const inTheLiveDialog = noteNow();
    live.unmount();

    render(
      <ExportSettingsView
        workload={workload}
        onCancel={() => undefined}
        onStart={() => undefined}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Advanced settings" }));
    await noteIs(NOTE);
    const underQuality = noteNow();
    await user.click(screen.getByRole("radio", { name: "Fast" }));
    await noteIs(NOTE);
    const underFast = noteNow();

    for (const note of [inTheLiveDialog, underQuality, underFast]) {
      expect(note).toMatch(/used on this PC/);
      expect(note).not.toMatch(CLAIMS_A_SAVING);
    }
    // One truth: the Quality / Fast view leaves out the sentence about the test, which only the 0.28.0-style dialog says.
    expect(inTheLiveDialog).toBe(`${underQuality} It passed ArtDaddy's test on this PC.`);
    expect(underFast).toBe(underQuality);
  });
});
