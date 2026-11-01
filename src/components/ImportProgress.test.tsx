import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ImportProgress from "./ImportProgress";
import {
  clearModelDownload,
  reportModelDownload,
  setModelDownloadCancel,
} from "../store/modelDownload";
import { WHISPER_MODELS } from "../tools/transcribe";

const TOTAL = WHISPER_MODELS.small.bytes;

afterEach(() => {
  vi.useRealTimers();
  clearModelDownload();
});

describe("ImportProgress — speech model", () => {
  it("shows nothing while no download is in flight", () => {
    render(<ImportProgress />);
    expect(screen.queryByTestId("model-download")).toBeNull();
  });

  // The whole defect: 2m21s of a 465 MiB download with NOTHING on screen, so the user
  // cancelled work that would have finished. The readout must say what and how far.
  it("names the download, its size and its progress", () => {
    reportModelDownload(Math.round(TOTAL * 0.4), TOTAL);
    render(<ImportProgress />);
    expect(screen.getByTestId("model-download").textContent).toContain(
      "Downloading the speech model (one time, about 465 MB) - 40%",
    );
  });

  // The owner's wording (2026-11-01): the app starts this download by itself.
  it("says that it only happens when the app is started for the first time", () => {
    reportModelDownload(Math.round(TOTAL * 0.4), TOTAL);
    render(<ImportProgress />);
    expect(screen.getByTestId("model-download").textContent).toContain(
      "This only happens when you start the app for the first time.",
    );
  });

  it("says how long is left once the speed is known", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    reportModelDownload(0, TOTAL);
    vi.setSystemTime(1_010_000);
    reportModelDownload(Math.round(TOTAL * 0.1), TOTAL); // 10% in 10 s: 90 s to go
    render(<ImportProgress />);
    expect(screen.getByTestId("model-download").textContent).toContain("about 2 min left");
  });

  it("moves as bytes land rather than showing one frozen number", () => {
    reportModelDownload(Math.round(TOTAL * 0.1), TOTAL);
    const view = render(<ImportProgress />);
    const first = screen.getByTestId("model-download").getAttribute("data-pct");
    reportModelDownload(Math.round(TOTAL * 0.9), TOTAL);
    view.rerender(<ImportProgress />);
    expect(screen.getByTestId("model-download").getAttribute("data-pct")).not.toBe(first);
  });

  it("disappears once the model has landed", () => {
    reportModelDownload(TOTAL, TOTAL);
    const view = render(<ImportProgress />);
    expect(screen.getByTestId("model-download")).toBeTruthy();
    clearModelDownload();
    view.rerender(<ImportProgress />);
    expect(screen.queryByTestId("model-download")).toBeNull();
  });

  it("can be cancelled by the person it is downloading for", () => {
    const cancel = vi.fn();
    reportModelDownload(Math.round(TOTAL * 0.4), TOTAL);
    setModelDownloadCancel(cancel);
    render(<ImportProgress />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("offers no Cancel when nothing can be cancelled", () => {
    reportModelDownload(Math.round(TOTAL * 0.4), TOTAL);
    render(<ImportProgress />);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});
