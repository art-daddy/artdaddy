// The Export dialog with the new settings view (design D2): the real view, the real stores, the dialog the menu bar hands `quickRoute` to. The 0.28.0 dialog (rendered without the prop) is the oracle for what is
// sent. The dialog's own part of the hand-over (what it draws around the view, when it takes the view away) is also held with a stand-in view in ExportDialog.quickRouteWiring.test.tsx; here the view is the whole screen.
// The words are written out here, never read from the words file.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetExportFlags, exportFlag } from "../api/exportFlags";
import { useExportJob } from "../store/exportJob";
import { decideExportEncoder, type ExportEncoderDecision } from "../timeline/exportChoice";
import type { RenderWorkload } from "../timeline/renderPlan";
import ExportDialog from "./ExportDialog";

vi.mock("../timeline/exportChoice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../timeline/exportChoice")>()),
  decideExportEncoder: vi.fn(),
}));

const PROJECT: RenderWorkload = {
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

/** What the app decided about the encoder, as the dialog is told: no chip, so no Mode row. */
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
  __resetExportFlags();
  useExportJob.getState().reset();
  useExportJob.getState().setEngine("auto");
  useExportJob.setState({ calibrations: [], modeRowOnScreen: null });
  vi.mocked(decideExportEncoder).mockReset();
  vi.mocked(decideExportEncoder).mockResolvedValue(decision());
});
afterEach(() => {
  cleanup();
  useExportJob.getState().reset();
});

type Props = Partial<ComponentProps<typeof ExportDialog>>;
const noop = () => undefined;
const dialog = (props: Props = {}) => (
  <ExportDialog open onCancel={noop} onStart={noop} workload={PROJECT} quickRoute {...props} />
);
const settle = () =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));

const resolutionBox = () => screen.getByRole("combobox", { name: "resolution" });
const door = () => screen.getByRole("button", { name: "Advanced settings" });
/** The region behind the door is mounted and hidden while the door is closed: read it by label, which does not look at what is hidden. */
const qualityBox = () => screen.getByLabelText("quality");
const rateBox = () => screen.getByLabelText("frame rate");

/** Everything a person can change, put to something else, with the door opened: what a fresh opening must not remember. */
async function changeEverything(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(resolutionBox(), "720p");
  await user.click(door());
  await user.selectOptions(qualityBox(), "High");
  await user.selectOptions(rateBox(), "24 fps");
  // Else the cases below say nothing about forgetting: the picks and the open door are on screen first.
  expect(resolutionBox()).toHaveDisplayValue("720p");
  expect(qualityBox()).toHaveDisplayValue("High");
  expect(rateBox()).toHaveDisplayValue("24 fps");
  expect(door()).toHaveAttribute("aria-expanded", "true");
}

/** What an opening starts from: the project's own size and rate, Medium quality, the door closed. */
function expectFreshOpening() {
  expect(resolutionBox()).toHaveDisplayValue("Same as project (1920 x 1080)");
  expect(rateBox()).toHaveDisplayValue("Same as project (30 fps)");
  expect(qualityBox()).toHaveDisplayValue("Medium");
  expect(door()).toHaveAttribute("aria-expanded", "false");
}

describe("the Export dialog is the 0.28.0 one unless the menu bar hands it quickRoute", () => {
  it("draws the 0.28.0 settings without the prop, though the unit suite has the switch on: the dialog never reads the switch", () => {
    expect(exportFlag("quick_route")).toBe(true); // else this case could not tell a dialog that reads it from one that does not
    render(dialog({ quickRoute: undefined }));
    expect(screen.getByRole("combobox", { name: "frame rate" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "quality" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Near-lossless, large file/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Advanced settings" })).toBeNull();
  });

  it("draws the new view with quickRoute: the dialog's title and box around a Resolution row, one door, one Cancel and one Export, and nothing of the 0.28.0 settings", () => {
    render(dialog());
    expect(screen.getByRole("dialog", { name: "export video" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Export video" })).toHaveLength(1);
    expect(door()).toBeInTheDocument();
    expect(resolutionBox()).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Export" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(1);

    expect(screen.queryByText(/Never upscales/)).toBeNull();
    expect(screen.queryByLabelText("export estimate")).toBeNull();
    for (const hint of [
      /Near-lossless/,
      /The usual delivery trade-off/,
      /Small file, visible compression/,
    ])
      expect(screen.queryByText(hint)).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "export mode" })).toBeNull();
  });

  it("asks the app about the encoder once for an opening: the view's own look, not that and the dialog's", async () => {
    render(dialog());
    await waitFor(() => expect(decideExportEncoder).toHaveBeenCalled());
    await settle();
    expect(decideExportEncoder).toHaveBeenCalledTimes(1);
    expect(vi.mocked(decideExportEncoder).mock.calls[0][0]).toMatchObject({
      request: "auto",
      preview: true,
      waitMs: Infinity,
      workload: PROJECT,
      settings: { resolution: "source", quality: "medium", fps: null },
    });
  });

  it("asks the app what the 0.28.0 dialog asks, and waits for a graphics chip's first test to end: the same request in both views, with an unlimited wait", async () => {
    // A finite wait would make the look give up before a chip's first test has ended, and what Quality sends would then differ from 0.28.0 in real use only: the stub answers at once whatever the wait.
    const wanted = {
      request: "auto",
      workload: PROJECT,
      settings: { resolution: "source", quality: "medium", fps: null },
      history: [],
      preview: true,
      waitMs: Infinity,
    };
    const legacy = render(dialog({ quickRoute: false }));
    await settle();
    expect(decideExportEncoder).toHaveBeenCalledTimes(1);
    expect(vi.mocked(decideExportEncoder).mock.calls[0][0]).toEqual(wanted);
    legacy.unmount();

    vi.mocked(decideExportEncoder).mockClear();
    render(dialog());
    await settle();
    expect(decideExportEncoder).toHaveBeenCalledTimes(1);
    expect(vi.mocked(decideExportEncoder).mock.calls[0][0]).toEqual(wanted);
  });

  it("Cancel is the dialog's own door: it asks the host to hide the dialog and starts nothing", async () => {
    const onCancel = vi.fn();
    const onStart = vi.fn();
    render(dialog({ onCancel, onStart }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });
});

// The legacy dialog is the oracle: the same project, look and picks must hand the host the same settings, and no `route`.
describe("Export from the new view hands the host what the 0.28.0 dialog hands it", () => {
  /** Press Export in one view of the dialog, once the look has had its say, and return what the host was handed. */
  async function exported(props: Props) {
    const onStart = vi.fn();
    const view = render(dialog({ onStart, ...props }));
    await settle();
    await userEvent.setup().click(screen.getByRole("button", { name: "Export" }));
    expect(onStart).toHaveBeenCalledTimes(1);
    view.unmount();
    return onStart.mock.calls[0][0] as Record<string, unknown>;
  }

  it("untouched, with the app's answer in: its own size and rate, Medium, and the choice of encoder left to the app", async () => {
    const legacy = await exported({ quickRoute: false });
    expect(legacy).toEqual({ resolution: "source", quality: "medium", fps: null, mode: null });
    expect(useExportJob.getState().modeRowOnScreen).toBe(false);
    useExportJob.setState({ modeRowOnScreen: null });

    const quick = await exported({ quickRoute: true });
    expect(quick).toEqual({ resolution: "source", quality: "medium", fps: null, mode: null });
    expect(Object.keys(quick).sort()).toEqual(["fps", "mode", "quality", "resolution"]); // no route
    expect(useExportJob.getState().modeRowOnScreen).toBe(false); // the old Mode row was never on screen
  });

  it("before the app has answered, Full quality is what is asked for, as in 0.28.0", async () => {
    vi.mocked(decideExportEncoder).mockReturnValue(new Promise(() => undefined));
    expect(await exported({ quickRoute: false })).toEqual({
      resolution: "source",
      quality: "medium",
      fps: null,
      mode: "quality",
    });
    expect(await exported({ quickRoute: true })).toEqual({
      resolution: "source",
      quality: "medium",
      fps: null,
      mode: "quality",
    });
  });

  it("when the app cannot say, Export still starts, as Full quality, in both views", async () => {
    vi.mocked(decideExportEncoder).mockRejectedValue(new Error("the supervisor is gone"));
    const legacy = await exported({ quickRoute: false });
    const quick = await exported({ quickRoute: true });
    expect(legacy).toEqual({ resolution: "source", quality: "medium", fps: null, mode: "quality" });
    expect(quick).toEqual(legacy);
  });

  it("with no project to look at, Full quality, and no Resolution or Frame rate row to change", async () => {
    const legacy = await exported({ quickRoute: false, workload: null });
    const quick = await exported({ quickRoute: true, workload: null });
    expect(legacy).toEqual({ resolution: "source", quality: "medium", fps: null, mode: "quality" });
    expect(quick).toEqual(legacy);
    expect(decideExportEncoder).not.toHaveBeenCalled();
  });

  it("with the person's picks: the size, the quality and the rate they chose, the same object", async () => {
    const onStartLegacy = vi.fn();
    const legacyView = render(dialog({ quickRoute: false, onStart: onStartLegacy }));
    await settle();
    fireEvent.change(screen.getByLabelText("resolution"), { target: { value: "720p" } });
    fireEvent.change(screen.getByLabelText("quality"), { target: { value: "low" } });
    fireEvent.change(screen.getByLabelText("frame rate"), { target: { value: "24" } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    legacyView.unmount();

    const onStart = vi.fn();
    const user = userEvent.setup();
    render(dialog({ onStart }));
    await settle();
    await user.selectOptions(resolutionBox(), "720p");
    await user.click(door());
    await user.selectOptions(qualityBox(), "Low");
    await user.selectOptions(rateBox(), "24 fps");
    await settle();
    await user.click(screen.getByRole("button", { name: "Export" }));

    expect(onStartLegacy.mock.calls[0][0]).toEqual({
      resolution: "720p",
      quality: "low",
      fps: 24,
      mode: null,
    });
    expect(onStart.mock.calls[0][0]).toEqual(onStartLegacy.mock.calls[0][0]);
    expect(Object.keys(onStart.mock.calls[0][0]).sort()).toEqual([
      "fps",
      "mode",
      "quality",
      "resolution",
    ]);
  });
});

describe("a render, with the new view", () => {
  it("draws the progress and neither the view nor its Export while a render runs; Hide hides the dialog and Cancel render stops the render", () => {
    const abort = vi.fn();
    const onCancel = vi.fn();
    useExportJob.getState().begin(abort);
    useExportJob.getState().update({ phase: "rendering", fraction: 0.4 });
    render(dialog({ onCancel }));
    expect(screen.getByRole("progressbar", { name: "export progress" })).toHaveAttribute(
      "aria-valuenow",
      "40",
    );
    expect(screen.queryByRole("button", { name: "Advanced settings" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "resolution" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Export" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel render" }));
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("swaps the view for the progress when a render starts under an open dialog, and the view is back, new, when the render has been closed", async () => {
    const user = userEvent.setup();
    render(dialog());
    await changeEverything(user);

    act(() => useExportJob.getState().begin(null));
    act(() => useExportJob.getState().update({ phase: "rendering", fraction: 0.5 }));
    expect(screen.queryByRole("button", { name: "Advanced settings" })).toBeNull();
    expect(screen.getByRole("progressbar", { name: "export progress" })).toBeInTheDocument();

    act(() => useExportJob.getState().finish({ phase: "done", fraction: 1, savedTo: "film.mp4" }));
    expect(screen.queryByRole("button", { name: "Advanced settings" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expectFreshOpening();
  });
});

// Owner's decision OD-12: 0.28.0 kept the size, the quality and the frame rate until the app closed; the new view keeps nothing from one opening to the next.
describe("nothing is remembered from one opening to the next", () => {
  it("is a change from 0.28.0 on purpose: the 0.28.0 settings, drawn by the same dialog without the prop, keep the three picks from one opening to the next", () => {
    const view = render(dialog({ quickRoute: false }));
    fireEvent.change(screen.getByLabelText("resolution"), { target: { value: "720p" } });
    fireEvent.change(screen.getByLabelText("quality"), { target: { value: "low" } });
    fireEvent.change(screen.getByLabelText("frame rate"), { target: { value: "24" } });
    view.rerender(dialog({ quickRoute: false, open: false }));
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(dialog({ quickRoute: false }));
    expect(screen.getByLabelText("resolution")).toHaveValue("720p");
    expect(screen.getByLabelText("quality")).toHaveValue("low");
    expect(screen.getByLabelText("frame rate")).toHaveValue("24");
  });

  it("opens again on the project's own settings, with the door closed, after the dialog was closed", async () => {
    const user = userEvent.setup();
    const view = render(dialog());
    await changeEverything(user);
    view.rerender(dialog({ open: false }));
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(dialog());
    expectFreshOpening();
  });

  it("opens fresh after a render that finished and was closed from the dialog, and the next Export sends the project's own settings", async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    const onCancel = vi.fn();
    const view = render(dialog({ onStart, onCancel }));
    await changeEverything(user);

    act(() => useExportJob.getState().begin(null));
    act(() => useExportJob.getState().finish({ phase: "done", fraction: 1, savedTo: "film.mp4" }));
    await user.click(screen.getByRole("button", { name: "Close" })); // resets the job and asks the host to close the dialog
    expect(onCancel).toHaveBeenCalledTimes(1);
    view.rerender(dialog({ onStart, onCancel, open: false }));
    view.rerender(dialog({ onStart, onCancel }));
    expectFreshOpening();

    await settle();
    await user.click(screen.getByRole("button", { name: "Export" }));
    expect(onStart.mock.calls[0][0]).toEqual({
      resolution: "source",
      quality: "medium",
      fps: null,
      mode: null,
    });
  });

  it("opens fresh when the dialog is opened on a result that has not been closed: the 0.28.0 reset of a finished job, then the new view", async () => {
    const user = userEvent.setup();
    const view = render(dialog());
    await changeEverything(user);
    view.rerender(dialog({ open: false }));
    act(() => useExportJob.getState().begin(null));
    act(() => useExportJob.getState().finish({ phase: "failed", error: "no clips to render" }));
    view.rerender(dialog());
    expect(screen.queryByText(/no clips to render/)).toBeNull();
    expectFreshOpening();
  });
});

describe("Escape, with the new view", () => {
  it("hides the dialog from the page, from a focused list and with the door open: the host is asked once each time, and nothing is started", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onStart = vi.fn();
    render(dialog({ onCancel, onStart }));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);

    resolutionBox().focus();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(2);

    await user.click(door());
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("never aborts a running render: the dialog is hidden and the render goes on", () => {
    const abort = vi.fn();
    const onCancel = vi.fn();
    render(dialog({ onCancel }));
    act(() => useExportJob.getState().begin(abort));
    act(() => useExportJob.getState().update({ phase: "rendering", fraction: 0.4 }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(abort, "Escape killed a running render").not.toHaveBeenCalled();
    expect(useExportJob.getState().phase).toBe("rendering");
  });

  it("ignores every other key, and a closed dialog ignores Escape", () => {
    const onCancel = vi.fn();
    const view = render(dialog({ onCancel }));
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "a" });
    expect(onCancel).not.toHaveBeenCalled();
    view.rerender(dialog({ onCancel, open: false }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
