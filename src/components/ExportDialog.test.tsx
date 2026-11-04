// The export job the dialog watches. The invariants here are about a bar that must not lie:
// late progress cannot resurrect a finished render, and a job that never reported a position must
// say so rather than claiming 0%.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ExportDialog from "./ExportDialog";
import { exportRunning, useExportJob } from "../store/exportJob";
import { EXPORT_SPEED_REVISION } from "../timeline/exportOptions";
import { resolveLocalFastEncoder } from "../platform/host";

vi.mock("../platform/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform/host")>()),
  resolveLocalFastEncoder: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  useExportJob.getState().reset();
  useExportJob.getState().setEngine("auto");
  useExportJob.getState().setMode("quality");
  useExportJob.setState({ calibrations: [] });
  vi.mocked(resolveLocalFastEncoder).mockResolvedValue(false);
});

describe("export job", () => {
  it("is not running until it begins, and not after it finishes", () => {
    expect(exportRunning()).toBe(false);
    useExportJob.getState().begin(null);
    expect(exportRunning()).toBe(true);
    useExportJob.getState().finish({ phase: "done" });
    expect(exportRunning()).toBe(false);
  });

  it("ignores progress that arrives AFTER the render finished", () => {
    // ffmpeg's last blocks can land after the process exits. A bar that jumped back to 90%
    // after saying "Done" reads as a bug in the export, not in the meter.
    useExportJob.getState().begin(null);
    useExportJob.getState().update({ phase: "rendering", fraction: 0.9 });
    useExportJob.getState().finish({ phase: "done", fraction: 1 });
    useExportJob.getState().update({ phase: "rendering", fraction: 0.9 });
    expect(useExportJob.getState().phase).toBe("done");
    expect(useExportJob.getState().fraction).toBe(1);
  });

  it("clears the abort handle when it finishes, so Cancel cannot fire at a dead process", () => {
    const abort = vi.fn();
    useExportJob.getState().begin(abort);
    expect(useExportJob.getState().abort).toBe(abort);
    useExportJob.getState().finish({ phase: "done" });
    expect(useExportJob.getState().abort).toBeNull();
  });

  it("starts each render from a clean slate rather than the last one's numbers", () => {
    useExportJob.getState().begin(null);
    useExportJob.getState().update({ fraction: 0.8, speed: 3, frame: 900 });
    useExportJob.getState().finish({ phase: "done", savedTo: "old.mp4" });
    useExportJob.getState().begin(null);
    const s = useExportJob.getState();
    expect(s.fraction).toBeNull();
    expect(s.savedTo).toBeNull();
    expect(s.frame).toBe(0);
  });
});

// The line under the settings: roughly how long this will take and how big the file will be, for the
// settings chosen. Information only: it never blocks, delays or alters the export.
describe("ExportDialog estimate", () => {
  const project = {
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
  const measured = (over: Record<string, unknown> = {}) => ({
    workload: project,
    output: { width: 1920, height: 1080, fps: 30 },
    quality: "medium",
    engine: "file-sequence-v1" as const,
    encoder: "x264-crf" as const,
    revision: EXPORT_SPEED_REVISION,
    elapsedSeconds: 150,
    finalBytes: 48_000_000,
    memoryBytes: null,
    temporaryBytes: null,
    ...over,
  });
  const show = (workload: typeof project | null, onStart = vi.fn()) =>
    render(<ExportDialog open onCancel={() => {}} onStart={onStart} workload={workload} />);

  it("says nothing when it has no project to go on", () => {
    show(null);
    expect(screen.queryByLabelText("export estimate")).not.toBeInTheDocument();
    show({ ...project, durationSeconds: 0 });
    expect(screen.queryByLabelText("export estimate")).not.toBeInTheDocument();
  });

  it("says how long and how big, from what this PC has measured", () => {
    useExportJob.setState({ calibrations: [measured()] });
    show(project);
    expect(screen.getByLabelText("export estimate")).toHaveTextContent(
      "Expected: about 3 min, a file of about 48 MB, from earlier exports on this PC.",
    );
  });

  it("is honest that it is a guess when nothing like this has been exported here", () => {
    useExportJob.setState({ calibrations: [] });
    show(project);
    const line = screen.getByLabelText("export estimate");
    expect(line).toHaveTextContent(/^Expected: (under a minute|about \d+ min)\. A rough guess/);
    expect(line).not.toHaveTextContent("a file of");
  });

  it("follows the settings the person changes", () => {
    useExportJob.setState({
      calibrations: [
        measured(),
        measured({
          output: { width: 1280, height: 720, fps: 30 },
          elapsedSeconds: 70,
          finalBytes: 20_000_000,
        }),
      ],
    });
    show(project);
    expect(screen.getByLabelText("export estimate")).toHaveTextContent("about 3 min");
    fireEvent.change(screen.getByLabelText("resolution"), { target: { value: "720p" } });
    expect(screen.getByLabelText("export estimate")).toHaveTextContent(
      "Expected: about 1 min, a file of about 20 MB",
    );
    // A setting nothing was measured for falls back to the guess instead of a wrong measurement.
    fireEvent.change(screen.getByLabelText("quality"), { target: { value: "high" } });
    expect(screen.getByLabelText("export estimate")).toHaveTextContent("A rough guess");
  });

  it("never gets in the way of the export it describes", () => {
    const start = vi.fn();
    useExportJob.setState({ calibrations: [measured({ elapsedSeconds: 90_000 })] });
    show(project, start);
    expect(screen.getByLabelText("export estimate")).toHaveTextContent("about 25 h");
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenCalledWith({
      resolution: "source",
      quality: "medium",
      fps: null,
      mode: "quality",
    });
  });

  it("leaves the dialog working when the project cannot be read", () => {
    const start = vi.fn();
    show({ ...project, width: Number.NaN, height: 0, fps: Number.NaN }, start);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe("ExportDialog", () => {
  const open = () => render(<ExportDialog open onCancel={() => {}} onStart={() => {}} />);

  it("shows the settings before a render starts", () => {
    open();
    expect(screen.getByLabelText("resolution")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeInTheDocument();
  });

  it("defaults to full quality and does not enable unmeasured Fast mode", () => {
    const dialog = open();
    expect(screen.getByRole("radio", { name: "Full quality" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Fast" })).toBeDisabled();
    expect(screen.queryByLabelText("export engine")).not.toBeInTheDocument();
    act(() => useExportJob.getState().reset());
    dialog.unmount();
    open();
    expect(screen.getByRole("radio", { name: "Full quality" })).toBeChecked();
  });

  it("keeps automatic routing separate from requested full-quality delivery settings", () => {
    const start = vi.fn();
    render(<ExportDialog open onCancel={() => {}} onStart={start} />);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(useExportJob.getState().engine).toBe("auto");
    expect(start).toHaveBeenCalledWith({
      resolution: "source",
      quality: "medium",
      fps: null,
      mode: "quality",
    });
  });

  it("offers Fast only after eligibility succeeds and makes the larger-file tradeoff visible", async () => {
    vi.mocked(resolveLocalFastEncoder).mockResolvedValue(true);
    const start = vi.fn();
    const dialog = render(<ExportDialog open onCancel={() => {}} onStart={start} />);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Fast" })).toBeEnabled());
    expect(screen.getByRole("radio", { name: "Full quality" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Fast" }));
    expect(screen.getByText(/Files can be much larger\. The picture/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenCalledWith({
      resolution: "source",
      quality: "medium",
      fps: null,
      mode: "fast",
    });
    dialog.unmount();
    open();
    expect(screen.getByRole("radio", { name: "Full quality" })).toBeChecked();
  });

  it("reports an UNKNOWN position as unknown, not as zero", () => {
    // aria-valuenow=0 asserts "nothing has happened yet"; absent means "not known yet". A
    // screen reader user should not be told the render is stuck at 0%.
    useExportJob.getState().begin(null);
    open();
    const bar = screen.getByRole("progressbar", { name: "export progress" });
    expect(bar).not.toHaveAttribute("aria-valuenow");
  });

  it("shows the percentage once ffmpeg reports a position", () => {
    useExportJob.getState().begin(null);
    useExportJob.getState().update({ phase: "rendering", fraction: 0.42, etaSec: 90, speed: 2 });
    open();
    expect(screen.getByRole("progressbar", { name: "export progress" })).toHaveAttribute(
      "aria-valuenow",
      "42",
    );
    expect(screen.getByTestId("export-status")).toHaveTextContent("42%");
    expect(screen.getByText(/1m 30s left/)).toBeInTheDocument();
  });

  it("offers Cancel while running and calls the job's abort", () => {
    const abort = vi.fn();
    useExportJob.getState().begin(abort);
    useExportJob.getState().update({ phase: "rendering", fraction: 0.1 });
    open();
    fireEvent.click(screen.getByRole("button", { name: "Cancel render" }));
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("says where the file went when it succeeds", async () => {
    useExportJob.getState().begin(null);
    open(); // the dialog is watching when the render lands
    await act(async () => {
      useExportJob.getState().finish({ phase: "done", fraction: 1, savedTo: "my film.mp4" });
    });
    expect(screen.getByText(/my film\.mp4/)).toBeInTheDocument();
  });

  it("shows the reason it failed rather than a bare 'failed'", async () => {
    useExportJob.getState().begin(null);
    open();
    await act(async () => {
      useExportJob.getState().finish({ phase: "failed", error: "no clips to render" });
    });
    expect(screen.getByText(/no clips to render/)).toBeInTheDocument();
  });

  it("offers the settings again when re-opened after a finished render", () => {
    useExportJob.getState().begin(null);
    useExportJob.getState().finish({ phase: "done", savedTo: "a.mp4" });
    open();
    expect(screen.getByLabelText("resolution")).toBeInTheDocument();
  });

  it("renders nothing at all when closed", () => {
    render(<ExportDialog open={false} onCancel={() => {}} onStart={() => {}} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
