// The Graphics chip row as the Export dialog mounts it: where the app finds a chip, only with the server's switch for Quick export on, and
// the dialog asks the app about the encoder again when the person changes the switch.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __setExportFlag } from "../api/exportFlags";
import { resolveExportResources, runCapabilityProbe, processorName } from "../platform/host";
import { useExportJob } from "../store/exportJob";
import { amd, harness } from "../test/chipHarness";
import type { ClientToolContext } from "../tools/context";
import { CHIP_PREF_KEY } from "../timeline/chipPref";
import { __resetChipTests } from "../timeline/chipTest";
import { decideExportEncoder, type ExportEncoderDecision } from "../timeline/exportChoice";
import { EXPORT_SPEED_REVISION } from "../timeline/exportOptions";
import { emptyTimeline } from "../timeline/model";
import { encoderOptions } from "../timeline/render";
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
  useExportJob.setState({ calibrations: [], modeRowOnScreen: null });
  vi.mocked(decideExportEncoder).mockReset();
  vi.mocked(decideExportEncoder).mockImplementation(async () => decision());
});
afterEach(() => {
  cleanup();
  __setExportFlag("quick_export", true);
});

/** The app's answer when a chip has proven itself and the export is long: it wants the old Mode row, on Fast, with its hint, its amber note and its "would take" line. */
const wantsRow = (): ExportEncoderDecision => ({
  ...decision(),
  showRow: true,
  defaultMode: "fast",
  reason: "over_minute",
  fullSeconds: 720,
  fastSeconds: 240,
  facts: { encoder: "x264", chip: "amd", reason: "none", tests: [] },
});
/** The app's answer when a chip has passed for the picture's size, as the rule words it now: the chip is chosen for the person (`chip_default`) whatever the length, so it wants the old Mode row, on Fast, with a note that says only what Fast costs. */
const chipChosen = (): ExportEncoderDecision => ({
  ...decision(),
  mode: "fast",
  chip: "amd",
  showRow: true,
  defaultMode: "fast",
  reason: "chip_default",
  fullSeconds: 40,
  fastSeconds: 15,
  facts: { encoder: "amd", chip: "amd", reason: "chip_default", tests: [] },
});
/** The app's answer when a chip has passed but the app is not choosing it for the person (the server's switch for that is off): the row is on offer and starts on Full quality. */
const chipOffered = (): ExportEncoderDecision => ({
  ...decision(),
  showRow: true,
  defaultMode: "quality",
  fullSeconds: 720,
  fastSeconds: 240,
  facts: { encoder: "x264", chip: "amd", reason: "none", tests: [] },
});
/** Nothing of the old Mode row is on screen: not the row, not what it says under it, not its amber note and not its "would take" line. */
const noModeRow = () => {
  expect(screen.queryByRole("radiogroup", { name: "export mode" })).toBeNull();
  expect(screen.queryByRole("radio", { name: "Fast" })).toBeNull();
  expect(screen.queryByRole("radio", { name: "Full quality" })).toBeNull();
  for (const words of [
    /Fast uses your graphics chip/,
    /Fast is selected because/,
    /Full quality would take/,
  ])
    expect(screen.queryByText(words)).toBeNull();
};
const settleAll = () =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));
type Resources = Awaited<ReturnType<typeof resolveExportResources>>;
const resourcesWith = (adapters: (typeof amd)[]): Resources => ({
  total_memory_bytes: null,
  available_memory_bytes: null,
  scratch_free_bytes: null,
  destination_free_bytes: null,
  budgets: { memoryBytes: null, temporaryBytes: null, executionSeconds: null },
  adapters,
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

// The Graphics chip row and the old Mode row (Full quality / Fast) speak for the same chip: where the chip row is drawn the dialog leaves the Mode row out, with what it says under it; where the chip row is not
// drawn the dialog is the one it was.
describe("the Export dialog draws the Graphics chip row or the old Mode row, never both", () => {
  const show = (onStart = vi.fn(), workload = PROJECT) => {
    render(<ExportDialog open onCancel={() => undefined} onStart={onStart} workload={workload} />);
    return onStart;
  };

  it("draws the chip row and not the Mode row where a chip has proven itself, and the app decides", async () => {
    pcWith([amd]);
    vi.mocked(decideExportEncoder).mockImplementation(async () => wantsRow());
    const start = show();
    expect(await screen.findByRole("radiogroup", { name: "Graphics chip" })).toBeVisible();
    await waitFor(() => expect(decideExportEncoder).toHaveBeenCalled());
    await settleAll(); // the app's answer, which wants the Mode row, is in
    noModeRow();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    // nothing is the person's pick (the chip row's Auto is what they were offered), and the export does not report a row nobody saw
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ mode: null }));
    expect(useExportJob.getState().modeRowOnScreen).toBe(false);
  });

  it("tells the person before the start what the chip costs, now that the Mode row that said so is not drawn", async () => {
    pcWith([amd]);
    vi.mocked(decideExportEncoder).mockImplementation(async () => wantsRow());
    show();
    await waitFor(() =>
      expect(screen.getByTestId("chip-row-note")).toHaveTextContent(
        "The file is usually larger and the picture can differ slightly",
      ),
    );
    expect(screen.getByTestId("chip-row-note")).toHaveTextContent(
      "It passed ArtDaddy's test on this PC.",
    );
  });

  // What the row says and what the export will do must be one thing: the two artifacts compared are the note on screen and the app's own answer (its real rule, not a scripted one) for the same PC and a short project.
  it("says the chip is used on this PC, and the app's own answer for this PC and a short project is the chip", async () => {
    pcWith([amd]);
    const real = await vi.importActual<typeof import("../timeline/exportChoice")>(
      "../timeline/exportChoice",
    );
    const answers: ExportEncoderDecision[] = [];
    vi.mocked(decideExportEncoder).mockImplementation(async (input) => {
      const answer = await real.decideExportEncoder(input);
      answers.push(answer);
      return answer;
    });
    const start = show(vi.fn(), { ...PROJECT, durationSeconds: 20 });
    await waitFor(() =>
      expect(screen.getByTestId("chip-row-note")).toHaveTextContent(/^Auto: used on this PC\./),
    );
    await waitFor(() => expect(answers.length).toBeGreaterThan(0));
    await settleAll();
    const answer = answers[answers.length - 1];
    expect({ mode: answer.mode, chip: answer.chip, reason: answer.reason }).toEqual({
      mode: "fast",
      chip: "amd",
      reason: "chip_default",
    });
    noModeRow();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ mode: null }));
  });

  it("draws the Mode row, started on Fast, for a chip chosen for the person where the chip row is not drawn: it says what Fast costs and not that the export is long, and a pick of Full quality is sent as the person's choice", async () => {
    pcWith([amd]);
    __setExportFlag("quick_export", false); // the server's switch for the chip row: the dialog is the old one
    vi.mocked(decideExportEncoder).mockImplementation(async () => chipChosen());
    const start = show();
    expect(await screen.findByRole("radio", { name: "Fast" })).toBeChecked();
    expect(screen.queryByTestId("chip-row")).toBeNull();
    expect(
      screen.getByText(
        "The file will be larger and the picture can differ slightly from Full quality.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/is selected because|over a minute/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ mode: null })); // left as the app chose
    expect(useExportJob.getState().modeRowOnScreen).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Full quality" }));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "quality" }));
  });

  it("starts the Mode row on Full quality, offering Fast, where the app is not choosing the chip for the person (the server's switch for that is off), and a pick of Fast is sent", async () => {
    pcWith([amd]);
    __setExportFlag("quick_export", false);
    vi.mocked(decideExportEncoder).mockImplementation(async () => chipOffered());
    const start = show();
    expect(await screen.findByRole("radio", { name: "Full quality" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Fast" })).not.toBeChecked();
    expect(
      screen.queryByText(/is selected because|over a minute|The file will be larger/),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ mode: null }));
    fireEvent.click(screen.getByRole("radio", { name: "Fast" }));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "fast" }));
  });

  it("draws no Mode row while the chip row has not answered, and then draws it exactly as it was where the chip row is not drawn", async () => {
    pcWith([amd]);
    __setExportFlag("quick_export", false); // the server's switch for the chip row: the dialog is the old one
    let answer!: (resources: Resources) => void;
    const gate = new Promise<Resources>((resolve) => (answer = resolve));
    vi.mocked(resolveExportResources).mockImplementation(() => gate);
    vi.mocked(decideExportEncoder).mockImplementation(async () => wantsRow());
    const start = show();
    await waitFor(() => expect(decideExportEncoder).toHaveBeenCalled());
    await settleAll(); // the app has answered and the chip row has not: neither row is drawn for the chip
    noModeRow();
    expect(screen.queryByTestId("chip-row")).toBeNull();
    // Export pressed here is not the app's choice for a row nobody saw: Full quality, as for an answer that has not come
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "quality" }));

    await act(async () => answer(resourcesWith([amd])));
    expect(await screen.findByRole("radio", { name: "Fast" })).toBeChecked();
    expect(
      screen.getByText(
        "Fast uses your graphics chip: usually quicker, and the file is usually larger.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(/Fast is selected because this export would take over a minute/),
    ).toBeVisible();
    expect(screen.getByText("Full quality would take about 12 min.")).toBeVisible();
    expect(screen.queryByTestId("chip-row")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ mode: null })); // left as the app chose
    expect(useExportJob.getState().modeRowOnScreen).toBe(true);
  });

  // Passes on 0.27.0 too, on purpose: it holds the new code to drawing the old row when the chip row never appears (a Mode row that waits for a look that failed would be a row lost).
  it("draws the Mode row as it was when the chip row's look fails: a PC that cannot be asked has no chip row", async () => {
    pcWith([amd]);
    vi.mocked(resolveExportResources).mockRejectedValue(new Error("the PC cannot say"));
    vi.mocked(decideExportEncoder).mockImplementation(async () => wantsRow());
    show();
    expect(await screen.findByRole("radio", { name: "Fast" })).toBeChecked();
    expect(screen.queryByTestId("chip-row")).toBeNull();
  });

  it("shows what the person chose when Off is stored: the Off row and no Mode row, even for an answer that wants one", async () => {
    pcWith([amd]);
    localStorage.setItem(CHIP_PREF_KEY, "off");
    vi.mocked(decideExportEncoder).mockImplementation(async () => wantsRow());
    const start = show();
    expect(await screen.findByTestId("chip-row-note")).toHaveTextContent(
      "Off: the graphics chip is not tested, offered or used on this PC. Everything runs on the processor.",
    );
    expect(screen.getByRole("radio", { name: "Off" })).toBeChecked();
    await waitFor(() => expect(decideExportEncoder).toHaveBeenCalled());
    await settleAll();
    noModeRow();
    // the app's answer was in (nothing is sent as the person's pick), so the absence above is not for want of an answer
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ mode: null }));
  });

  it("does not turn an answer made while the chip row was drawn into a Mode row when the picture changes to a size the chip does not serve", async () => {
    pcWith([amd]);
    vi.mocked(decideExportEncoder)
      .mockImplementationOnce(async () => wantsRow())
      .mockReturnValue(new Promise(() => undefined)); // the answer for the new picture has not come
    show(vi.fn(), { ...PROJECT, width: 3840, height: 2160 });
    expect(await screen.findByRole("radiogroup", { name: "Graphics chip" })).toBeVisible();
    await waitFor(() => expect(decideExportEncoder).toHaveBeenCalledTimes(1));
    await settleAll();
    noModeRow();
    // 4K at 60 frames a second: no chip row, and no chip
    fireEvent.change(screen.getByLabelText("frame rate"), { target: { value: "60" } });
    await waitFor(() => expect(screen.queryByTestId("chip-row")).toBeNull());
    await waitFor(() => expect(decideExportEncoder).toHaveBeenCalledTimes(2));
    await settleAll();
    noModeRow(); // the old answer is not drawn as a row now that the chip row has gone
  });

  it("draws the Mode row for an answer made after the chip row has gone, which is the old dialog", async () => {
    pcWith([amd]);
    vi.mocked(decideExportEncoder)
      .mockImplementationOnce(async () => decision())
      .mockImplementation(async () => wantsRow());
    show(vi.fn(), { ...PROJECT, width: 3840, height: 2160 });
    await screen.findByRole("radiogroup", { name: "Graphics chip" });
    fireEvent.change(screen.getByLabelText("frame rate"), { target: { value: "60" } });
    expect(await screen.findByRole("radio", { name: "Fast" })).toBeChecked();
    expect(screen.queryByTestId("chip-row")).toBeNull();
  });

  it("starts over each time the settings are shown: the last opening's row is not drawn while the chip row's first look is out", async () => {
    pcWith([]);
    vi.mocked(decideExportEncoder).mockImplementation(async () => wantsRow());
    const dialog = (isOpen: boolean) => (
      <ExportDialog
        open={isOpen}
        onCancel={() => undefined}
        onStart={() => undefined}
        workload={PROJECT}
      />
    );
    const view = render(dialog(true));
    expect(await screen.findByRole("radio", { name: "Fast" })).toBeChecked(); // no chip: the old dialog
    view.rerender(dialog(false));
    let answer!: (resources: Resources) => void;
    const gate = new Promise<Resources>((resolve) => (answer = resolve));
    vi.mocked(resolveExportResources).mockImplementation(() => gate);
    view.rerender(dialog(true));
    await waitFor(() => expect(decideExportEncoder).toHaveBeenCalledTimes(2));
    await settleAll(); // the app has answered again, the chip row has not
    noModeRow();
    await act(async () => answer(resourcesWith([])));
    expect(await screen.findByRole("radio", { name: "Fast" })).toBeChecked();
  });

  it("prices the estimate for what Export will do: Full in the gap, then the app's own pick, the chip's measured time, where the chip row is drawn and the Mode row is not", async () => {
    pcWith([amd]);
    useExportJob.setState({
      calibrations: [
        {
          workload: PROJECT,
          output: { width: 1920, height: 1080, fps: 30 },
          quality: "medium",
          engine: "file-sequence-v1",
          encoder: "chip-amd",
          revision: EXPORT_SPEED_REVISION,
          elapsedSeconds: 60,
          finalBytes: 70_000_000,
          memoryBytes: null,
          temporaryBytes: null,
        },
      ],
    });
    let answer!: (resources: Resources) => void;
    const gate = new Promise<Resources>((resolve) => (answer = resolve));
    vi.mocked(resolveExportResources).mockImplementation(() => gate);
    vi.mocked(decideExportEncoder).mockImplementation(async () => wantsRow());
    show();
    await waitFor(() => expect(decideExportEncoder).toHaveBeenCalled());
    await settleAll(); // the app has answered and the chip row has not: Export would send Full quality
    expect(screen.getByLabelText("export estimate")).toHaveTextContent("A rough guess");
    await act(async () => answer(resourcesWith([amd])));
    await waitFor(() =>
      expect(screen.getByLabelText("export estimate")).toHaveTextContent(
        "Expected: about 1 min, a file of about 70 MB, from earlier exports on this PC.",
      ),
    );
    noModeRow();
  });

  it("what an export says it showed is what the dialog drew when Export was pressed", async () => {
    const menu = { surface: "app" } as unknown as ClientToolContext;
    const seconds = emptyTimeline(1920, 1080, 30);
    seconds.tracks = [
      {
        id: "v1",
        kind: "video",
        z: 0,
        clips: [
          {
            id: "a",
            kind: "video",
            media_ref: "a.mp4",
            source_in: 0,
            source_out: 3600,
            timeline_in: 0,
            timeline_out: 3600,
          },
        ],
      },
    ];
    const shown = async () =>
      (
        await encoderOptions(
          menu,
          { seconds, request: "auto" },
          { resolution: "source", quality: "medium" },
        )
      ).choice?.shown;
    vi.mocked(decideExportEncoder).mockImplementation(async () => wantsRow());

    pcWith([amd]);
    const withChipRow = render(
      <ExportDialog open onCancel={() => undefined} onStart={() => undefined} workload={PROJECT} />,
    );
    await screen.findByRole("radiogroup", { name: "Graphics chip" });
    await settleAll();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(await shown()).toBeUndefined(); // the chip row was drawn: no Mode row was shown
    withChipRow.unmount();

    pcWith([]);
    render(
      <ExportDialog open onCancel={() => undefined} onStart={() => undefined} workload={PROJECT} />,
    );
    await screen.findByRole("radio", { name: "Fast" });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(await shown()).toBe("fast"); // the old dialog drew the row, started on Fast
  });
});
