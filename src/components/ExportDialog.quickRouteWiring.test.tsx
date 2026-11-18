// The Export dialog's side of handing the settings over to the new view (design D2): what it gives the view, what it draws and runs around it, and when it takes the view away. The view is a stand-in here (the
// real one is held in ExportDialog.quickRoute.test.tsx), so that these cases hold the dialog to its own part: the stand-in draws no queue pane, no footer and asks the app nothing, and it counts how many
// times it was mounted. What a person sees is read from the screen; the settings the stand-in sends are one object the test made, so "unchanged" means the same object.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { exportFlag } from "../api/exportFlags";
import { useExportJob } from "../store/exportJob";
import { decideExportEncoder, type ExportEncoderDecision } from "../timeline/exportChoice";
import type { RenderWorkload } from "../timeline/renderPlan";
import ExportDialog, { type ExportSettings } from "./ExportDialog";

const stand = vi.hoisted(() => ({
  mounted: 0,
  sent: { resolution: "480p", quality: "low", fps: 24, mode: null } as ExportSettings,
}));

vi.mock("./ExportSettingsView", () => ({
  default: (props: {
    workload: RenderWorkload | null;
    onCancel: () => void;
    onStart: (settings: ExportSettings) => void;
  }) => {
    const [instance] = useState(() => ++stand.mounted);
    return (
      <div data-testid="stand-in" data-instance={String(instance)}>
        <span>
          {props.workload
            ? `stand-in sees ${props.workload.width} x ${props.workload.height}, ${props.workload.durationSeconds} s`
            : "stand-in sees no project"}
        </span>
        <button type="button" onClick={props.onCancel}>
          stand-in cancel
        </button>
        <button type="button" onClick={() => props.onStart(stand.sent)}>
          stand-in start
        </button>
      </div>
    );
  },
}));
vi.mock("./ExportQueuePane", () => ({ default: () => <div data-testid="legacy-queue-pane" /> }));
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
  stand.mounted = 0;
  stand.sent = { resolution: "480p", quality: "low", fps: 24, mode: null };
  useExportJob.getState().reset();
  useExportJob.setState({ calibrations: [] });
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
const standIn = () => screen.queryByTestId("stand-in");

describe("the Export dialog hands the settings over to the new view", () => {
  it("gives the view the open project, and what the view starts or cancels reaches the dialog's own callbacks untouched", () => {
    const onStart = vi.fn();
    const onCancel = vi.fn();
    render(dialog({ onStart, onCancel }));
    expect(screen.getByRole("heading", { name: "Export video" })).toBeInTheDocument();
    expect(screen.getByText("stand-in sees 1920 x 1080, 120 s")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "stand-in start" }));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart.mock.calls[0][0]).toBe(stand.sent); // the very object the view made: nothing added, nothing dropped
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "stand-in cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("tells the view there is no project when the dialog has none", () => {
    render(dialog({ workload: null }));
    expect(screen.getByText("stand-in sees no project")).toBeInTheDocument();
  });

  it("hands the host a Fast object the view made untouched: the very object, route and every flag in it, nothing added to it and nothing dropped", () => {
    const fast: ExportSettings = {
      resolution: "720p",
      quality: "medium",
      fps: null,
      mode: null,
      route: { route: "quick", explicit: { size: true, fps: false, quality: true } },
    };
    stand.sent = fast;
    const onStart = vi.fn();
    render(dialog({ onStart }));
    fireEvent.click(screen.getByRole("button", { name: "stand-in start" }));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart.mock.calls[0][0]).toBe(fast);
    expect(onStart.mock.calls[0][0]).toStrictEqual({
      resolution: "720p",
      quality: "medium",
      fps: null,
      mode: null,
      route: { route: "quick", explicit: { size: true, fps: false, quality: true } },
    });
  });

  it("draws no 0.28.0 settings, no queue pane and no footer around the view; without quickRoute it draws all three and no view, though the switch is on", () => {
    // The unit suite lifts every behaviour the build holds off: the dialog must not read the switch itself, or every dialog test would be on the new view.
    expect(exportFlag("quick_route")).toBe(true);
    const quick = render(dialog());
    expect(standIn()).not.toBeNull();
    expect(screen.queryByRole("combobox", { name: "resolution" })).toBeNull();
    expect(screen.queryByRole("option", { name: /Near-lossless, large file/ })).toBeNull();
    expect(screen.queryByTestId("legacy-queue-pane")).toBeNull();
    expect(screen.queryByRole("button", { name: "Export" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    quick.unmount();

    render(dialog({ quickRoute: undefined }));
    expect(standIn()).toBeNull();
    expect(screen.getByRole("combobox", { name: "resolution" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Near-lossless, large file/ })).toBeInTheDocument();
    expect(screen.getAllByTestId("legacy-queue-pane")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Export" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
  });

  it("does not ask the app about the encoder behind the view, as the 0.28.0 view does", async () => {
    const quick = render(dialog());
    await settle();
    expect(decideExportEncoder).not.toHaveBeenCalled();
    quick.unmount();

    render(dialog({ quickRoute: false }));
    await settle();
    expect(decideExportEncoder).toHaveBeenCalledTimes(1);
  });

  it("asks nothing either when the prop turns on under an open dialog, and takes the 0.28.0 look back when it turns off", async () => {
    const view = render(dialog({ quickRoute: false }));
    await settle();
    expect(decideExportEncoder).toHaveBeenCalledTimes(1);

    view.rerender(dialog());
    await settle();
    expect(standIn()).not.toBeNull();
    expect(screen.queryByRole("combobox", { name: "resolution" })).toBeNull();
    expect(decideExportEncoder).toHaveBeenCalledTimes(1); // nothing more behind the view

    view.rerender(dialog({ quickRoute: false }));
    await settle();
    expect(standIn()).toBeNull();
    expect(screen.getByRole("combobox", { name: "resolution" })).toBeInTheDocument();
    expect(decideExportEncoder).toHaveBeenCalledTimes(2);
  });
});

describe("the Export dialog and a render, with the new view", () => {
  it("takes the view away while a render runs and draws the progress, the queue pane and Hide / Cancel render as ever; a finished render leaves Close, and the view then comes back as a new one", () => {
    const abort = vi.fn();
    const onCancel = vi.fn();
    render(dialog({ onCancel }));
    expect(standIn()).toHaveAttribute("data-instance", "1");

    act(() => useExportJob.getState().begin(abort));
    act(() => useExportJob.getState().update({ phase: "rendering", fraction: 0.4 }));
    expect(standIn()).toBeNull();
    expect(screen.getByRole("progressbar", { name: "export progress" })).toBeInTheDocument();
    expect(screen.getAllByTestId("legacy-queue-pane")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel render" }));
    expect(abort).toHaveBeenCalledTimes(1);

    act(() => useExportJob.getState().finish({ phase: "done", fraction: 1, savedTo: "film.mp4" }));
    expect(standIn()).toBeNull();
    expect(screen.getByText(/film\.mp4/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(useExportJob.getState().phase).toBe("idle");
    expect(screen.getByTestId("stand-in")).toHaveAttribute("data-instance", "2");
  });

  it("draws the progress, not the view, for a render that is already going when the dialog opens", () => {
    useExportJob.getState().begin(null);
    useExportJob.getState().update({ phase: "rendering", fraction: 0.1 });
    render(dialog());
    expect(standIn()).toBeNull();
    expect(stand.mounted).toBe(0);
    expect(screen.getByRole("progressbar", { name: "export progress" })).toBeInTheDocument();
  });

  it("offers the view again, not last time's failure, when opened after a render that failed", () => {
    useExportJob.getState().begin(null);
    useExportJob.getState().finish({ phase: "failed", error: "no clips to render" });
    render(dialog());
    // opening after a result offers the settings again (the dialog's own reset), as in 0.28.0
    expect(standIn()).toHaveAttribute("data-instance", "1");
    expect(screen.queryByText(/no clips to render/)).toBeNull();
  });

  it("gives a reopened dialog a new view, not the one it had", () => {
    const view = render(dialog());
    expect(standIn()).toHaveAttribute("data-instance", "1");
    view.rerender(dialog({ open: false }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(standIn()).toBeNull();
    view.rerender(dialog());
    expect(standIn()).toHaveAttribute("data-instance", "2");
  });
});

describe("Escape, with the new view", () => {
  it("hides the dialog and does nothing else", () => {
    const onCancel = vi.fn();
    const onStart = vi.fn();
    render(dialog({ onCancel, onStart }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("hides a running render's dialog and never aborts the render", () => {
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
});
