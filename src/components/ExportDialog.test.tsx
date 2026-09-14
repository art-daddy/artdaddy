// The export job the dialog watches. The invariants here are about a bar that must not lie:
// late progress cannot resurrect a finished render, and a job that never reported a position must
// say so rather than claiming 0%.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ExportDialog from "./ExportDialog";
import { exportRunning, useExportJob } from "../store/exportJob";

beforeEach(() => useExportJob.getState().reset());

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

describe("ExportDialog", () => {
  const open = () => render(<ExportDialog open onCancel={() => {}} onStart={() => {}} />);

  it("shows the settings before a render starts", () => {
    open();
    expect(screen.getByLabelText("resolution")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeInTheDocument();
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
