// The export job the dialog watches. The invariants here are about a bar that must not lie:
// late progress cannot resurrect a finished render, and a job that never reported a position must
// say so rather than claiming 0%.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ExportDialog from "./ExportDialog";
import { exportRunning, useExportJob } from "../store/exportJob";
import { decideExportEncoder, type ExportEncoderDecision } from "../timeline/exportChoice";
import { EXPORT_SPEED_REVISION } from "../timeline/exportOptions";

vi.mock("../timeline/exportChoice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../timeline/exportChoice")>()),
  decideExportEncoder: vi.fn(),
}));

/** What the app decided about the encoder, as the dialog is told: no chip, so no Mode row, unless a test says otherwise. */
const decision = (over: Partial<ExportEncoderDecision> = {}): ExportEncoderDecision => ({
  mode: "quality",
  reason: "none",
  showRow: false,
  defaultMode: "quality",
  fullSeconds: 40,
  fastSeconds: null,
  fullGuessed: true,
  tests: [],
  facts: { encoder: "x264", reason: "none", tests: [] },
  ...over,
});
/** A chip that has proven itself, so the Mode row is shown. */
const withRow = (over: Partial<ExportEncoderDecision> = {}): ExportEncoderDecision =>
  decision({
    showRow: true,
    fastSeconds: 15,
    facts: { encoder: "x264", chip: "amd", reason: "none", tests: [] },
    ...over,
  });

beforeEach(() => {
  useExportJob.getState().reset();
  useExportJob.getState().setEngine("auto");
  useExportJob.setState({ calibrations: [] });
  vi.mocked(decideExportEncoder).mockReset();
  vi.mocked(decideExportEncoder).mockResolvedValue(decision());
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

// The project the dialog is opened on: its size and layers, for the estimate and for the encoder choice.
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

/** One run this PC has measured for the project above: what the history holds after a background export. */
const CALIBRATION = {
  workload: PROJECT,
  output: { width: 1920, height: 1080, fps: 30 },
  quality: "medium",
  engine: "file-sequence-v1" as const,
  encoder: "x264-crf" as const,
  revision: EXPORT_SPEED_REVISION,
  elapsedSeconds: 150,
  finalBytes: 48_000_000,
  memoryBytes: null,
  temporaryBytes: null,
};
// The line under the settings: roughly how long this will take and how big the file will be, for the
// settings chosen. Information only: it never blocks, delays or alters the export.
describe("ExportDialog estimate", () => {
  const project = PROJECT;
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

  it("never gets in the way of the export it describes", async () => {
    const start = vi.fn();
    useExportJob.setState({ calibrations: [measured({ elapsedSeconds: 90_000 })] });
    show(project, start);
    expect(screen.getByLabelText("export estimate")).toHaveTextContent("about 25 h");
    await waitFor(() => expect(decideExportEncoder).toHaveBeenCalled());
    await act(async () => undefined); // the app's answer for these settings is in
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenCalledWith({
      resolution: "source",
      quality: "medium",
      fps: null,
      mode: null,
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

  it("shows no Mode row, and lets the app decide, when no chip has proven itself", async () => {
    const start = vi.fn();
    render(<ExportDialog open onCancel={() => {}} onStart={start} workload={PROJECT} />);
    await waitFor(() => expect(decideExportEncoder).toHaveBeenCalled());
    await act(async () => undefined); // the app's answer for these settings is in
    expect(screen.queryByRole("radio", { name: "Fast" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Full quality" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("export engine")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenCalledWith({
      resolution: "source",
      quality: "medium",
      fps: null,
      mode: null,
    });
  });

  it("asks the app as it opens and as the settings change, as a look that takes nothing for a report", async () => {
    render(<ExportDialog open onCancel={() => {}} onStart={() => {}} workload={PROJECT} />);
    await waitFor(() => expect(decideExportEncoder).toHaveBeenCalledTimes(1));
    expect(vi.mocked(decideExportEncoder).mock.calls[0][0]).toMatchObject({
      request: "auto",
      preview: true,
      workload: PROJECT,
      settings: { resolution: "source", quality: "medium", fps: null },
    });
    fireEvent.change(screen.getByLabelText("resolution"), { target: { value: "720p" } });
    await waitFor(() => expect(decideExportEncoder).toHaveBeenCalledTimes(2));
    expect(vi.mocked(decideExportEncoder).mock.calls[1][0].settings).toMatchObject({
      resolution: "720p",
    });
  });

  it("shows the Mode row once a chip has proven itself: Full quality for a short export, what Fast would save, and Fast when picked", async () => {
    vi.mocked(decideExportEncoder).mockResolvedValue(withRow());
    const start = vi.fn();
    render(<ExportDialog open onCancel={() => {}} onStart={start} workload={PROJECT} />);
    const fast = await screen.findByRole("radio", { name: "Fast" });
    expect(fast).toBeEnabled();
    expect(screen.getByRole("radio", { name: "Full quality" })).toBeChecked();
    expect(
      screen.getByText(
        "Fast uses your graphics chip: usually quicker, and the file is usually larger.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Fast would take under a minute.")).toBeVisible();
    expect(screen.queryByText(/is selected because/)).toBeNull();
    // Untouched, the app decides: nothing is sent as the person's choice.
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ mode: null }));
    fireEvent.click(fast);
    expect(fast).toBeChecked();
    expect(
      screen.getByText(/The file will be larger and the picture can differ slightly/),
    ).toBeVisible();
    expect(screen.getByText("Full quality would take under a minute.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenLastCalledWith({
      resolution: "source",
      quality: "medium",
      fps: null,
      mode: "fast",
    });
  });

  it("selects Fast for the person when the export is over a minute and says why; picking Full quality is sent as their choice", async () => {
    vi.mocked(decideExportEncoder).mockResolvedValue(
      withRow({ defaultMode: "fast", reason: "over_minute", fullSeconds: 720, fastSeconds: 240 }),
    );
    const start = vi.fn();
    render(<ExportDialog open onCancel={() => {}} onStart={start} workload={PROJECT} />);
    expect(await screen.findByRole("radio", { name: "Fast" })).toBeChecked();
    expect(
      screen.getByText(
        "Fast is selected because this export would take over a minute on this PC (about 12 min). The file will be larger and the picture can differ slightly. Choose Full quality for the smallest file.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Full quality would take about 12 min.")).toBeVisible();
    // The quality is still the person's to choose: Fast runs at the same High, Medium or Low.
    expect(screen.getByLabelText("quality")).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ mode: null })); // left as the app chose
    fireEvent.click(screen.getByRole("radio", { name: "Full quality" }));
    expect(screen.queryByText(/is selected because/)).toBeNull();
    expect(screen.getByText("Fast would take about 4 min.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "quality" }));
  });

  it("says where the faster setting will be used when there is no Mode row", async () => {
    vi.mocked(decideExportEncoder).mockResolvedValue(
      decision({ faster: true, reason: "promise_line", fullSeconds: 900 }),
    );
    render(<ExportDialog open onCancel={() => {}} onStart={() => {}} workload={PROJECT} />);
    expect(
      await screen.findByText(
        "To save time, ArtDaddy will use a faster setting; the picture may be slightly softer.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("radio", { name: "Fast" })).not.toBeInTheDocument();
  });

  it("estimates the way that is selected: Fast from what this PC measured of its chip", async () => {
    vi.mocked(decideExportEncoder).mockResolvedValue(
      withRow({ defaultMode: "fast", reason: "over_minute", fullSeconds: 150, fastSeconds: 60 }),
    );
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
    render(<ExportDialog open onCancel={() => {}} onStart={() => {}} workload={PROJECT} />);
    await screen.findByRole("radio", { name: "Fast" });
    expect(screen.getByLabelText("export estimate")).toHaveTextContent(
      "Expected: about 1 min, a file of about 70 MB, from earlier exports on this PC.",
    );
    fireEvent.click(screen.getByRole("radio", { name: "Full quality" }));
    expect(screen.getByLabelText("export estimate")).toHaveTextContent("A rough guess");
  });

  it("ignores an answer to a question the person has already changed", async () => {
    let answerFirst: (d: ExportEncoderDecision) => void = () => undefined;
    vi.mocked(decideExportEncoder)
      .mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValue(decision());
    render(<ExportDialog open onCancel={() => {}} onStart={() => {}} workload={PROJECT} />);
    await waitFor(() => expect(decideExportEncoder).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("resolution"), { target: { value: "720p" } });
    await waitFor(() => expect(decideExportEncoder).toHaveBeenCalledTimes(2));
    await act(async () => answerFirst(withRow())); // the old question's answer arrives late
    expect(screen.queryByRole("radio", { name: "Fast" })).not.toBeInTheDocument();
  });

  // Found by the second review: the dialog never showed a Mode row for a preview that failed, yet sent "no choice", and the
  // export then chose Fast for the person. What the person did not see offered is never chosen for them.
  it("goes on working when the app cannot say: no row, and Export still starts, as Full quality", async () => {
    vi.mocked(decideExportEncoder).mockRejectedValue(new Error("the supervisor is gone"));
    const start = vi.fn();
    render(<ExportDialog open onCancel={() => {}} onStart={start} workload={PROJECT} />);
    await waitFor(() => expect(decideExportEncoder).toHaveBeenCalled());
    await act(async () => undefined); // the failure has been seen
    expect(screen.queryByRole("radio", { name: "Fast" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ mode: "quality" }));
  });

  it("sends Full quality, not the app's choice, when the history the answer was made from has changed and the new answer has not come", async () => {
    vi.mocked(decideExportEncoder)
      .mockResolvedValueOnce(
        withRow({ defaultMode: "fast", reason: "over_minute", fullSeconds: 720, fastSeconds: 240 }),
      )
      .mockReturnValue(new Promise(() => undefined)); // the next look has not come back
    const start = vi.fn();
    render(<ExportDialog open onCancel={() => {}} onStart={start} workload={PROJECT} />);
    expect(await screen.findByRole("radio", { name: "Fast" })).toBeChecked();
    // A background export finishes and the PC's history changes: the answer on screen was made from the old one.
    await act(async () => {
      useExportJob.setState({ calibrations: [{ ...CALIBRATION, elapsedSeconds: 30 }] });
    });
    await waitFor(() => expect(decideExportEncoder).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "quality" }));
    // A pick the person made is still theirs.
    fireEvent.click(screen.getByRole("radio", { name: "Full quality" }));
    fireEvent.click(screen.getByRole("radio", { name: "Fast" }));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "fast" }));
  });

  // Found by review: an Export pressed before the app had answered for the settings on screen was sent as "no choice", and the
  // app then chose for the person; so was a Full the person had picked, once the settings changed under it.
  it("sends Full quality, not the app's choice, when Export is pressed before the app has answered", async () => {
    vi.mocked(decideExportEncoder).mockReturnValue(new Promise(() => undefined)); // the chip's test is still running
    const start = vi.fn();
    render(<ExportDialog open onCancel={() => {}} onStart={start} workload={PROJECT} />);
    await waitFor(() => expect(decideExportEncoder).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ mode: "quality" }));
  });

  it("keeps a Full the person picked when the settings change away and back and the app has not answered for the last ones", async () => {
    vi.mocked(decideExportEncoder)
      .mockResolvedValueOnce(
        withRow({ defaultMode: "fast", reason: "over_minute", fullSeconds: 720, fastSeconds: 240 }),
      )
      .mockResolvedValueOnce(decision()) // at 720p no chip would save a quarter: no row
      .mockReturnValue(new Promise(() => undefined));
    const start = vi.fn();
    render(<ExportDialog open onCancel={() => {}} onStart={start} workload={PROJECT} />);
    fireEvent.click(await screen.findByRole("radio", { name: "Full quality" }));
    fireEvent.change(screen.getByLabelText("resolution"), { target: { value: "720p" } });
    await waitFor(() => expect(screen.queryByRole("radio", { name: "Fast" })).toBeNull());
    fireEvent.change(screen.getByLabelText("resolution"), { target: { value: "source" } });
    await waitFor(() => expect(decideExportEncoder).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "quality" }));
  });

  it("sends nothing as the person's choice once the app has answered for the settings on screen, and no row was shown", async () => {
    const start = vi.fn();
    render(<ExportDialog open onCancel={() => {}} onStart={start} workload={PROJECT} />);
    await waitFor(() => expect(decideExportEncoder).toHaveBeenCalled());
    await act(async () => undefined); // the answer has landed
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ mode: null }));
  });

  it("forgets the person's pick when it is opened again", async () => {
    vi.mocked(decideExportEncoder).mockResolvedValue(withRow());
    const first = render(
      <ExportDialog open onCancel={() => {}} onStart={() => {}} workload={PROJECT} />,
    );
    fireEvent.click(await screen.findByRole("radio", { name: "Fast" }));
    first.unmount();
    render(<ExportDialog open onCancel={() => {}} onStart={() => {}} workload={PROJECT} />);
    expect(await screen.findByRole("radio", { name: "Full quality" })).toBeChecked();
  });

  // Found by the second review: with no workload the dialog cannot ask the app anything, shows no Mode row and no estimate,
  // and sent "no choice", so the export chose for the person once the project could be read after all.
  it("keeps automatic routing separate from the person's delivery settings, and gives Full quality where it could not ask", () => {
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
