import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import ExportDialog from "./ExportDialog";
import { useExportJob } from "../store/exportJob";

describe("ExportDialog dismissal", () => {
  it("Escape dismisses the dialog", () => {
    const onCancel = vi.fn();
    render(<ExportDialog open onCancel={onCancel} onStart={() => {}} />);
    expect(screen.getByLabelText("export video")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Escape during a render HIDES it and never aborts — the failure direction", () => {
    const abort = vi.fn();
    useExportJob.getState().reset();
    useExportJob.getState().begin(abort);
    useExportJob.getState().update({ phase: "rendering", fraction: 0.4 });
    const onCancel = vi.fn();
    render(<ExportDialog open onCancel={onCancel} onStart={() => {}} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(abort, "Escape killed a running render").not.toHaveBeenCalled();
    expect(useExportJob.getState().phase).toBe("rendering");
    useExportJob.getState().reset();
  });

  it("does nothing while closed", () => {
    const onCancel = vi.fn();
    render(<ExportDialog open={false} onCancel={onCancel} onStart={() => {}} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("ignores other keys", () => {
    const onCancel = vi.fn();
    render(<ExportDialog open onCancel={onCancel} onStart={() => {}} />);
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "a" });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
