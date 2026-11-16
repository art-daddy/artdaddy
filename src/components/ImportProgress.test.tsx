import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ImportProgress from "./ImportProgress";
import { useImportJobs } from "../store/importJobs";
import {
  clearModelDownload,
  reportModelDownload,
  setModelDownloadCancel,
  setModelDownloadFailure,
  setModelNextAttemptAt,
  useModelDownload,
} from "../store/modelDownload";
import { WHISPER_MODELS } from "../tools/transcribe";

const TOTAL = WHISPER_MODELS.small.bytes;

afterEach(() => {
  vi.useRealTimers();
  clearModelDownload();
  setModelDownloadFailure(null);
  setModelNextAttemptAt(null);
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

  // A second model file (another one is already on this PC): "the first time you start the app" is untrue of it.
  it("calls a second model file another speech model, and does not say it happens when the app is first started", () => {
    reportModelDownload(Math.round(TOTAL * 0.4), TOTAL, true);
    render(<ImportProgress />);
    const text = screen.getByTestId("model-download").textContent ?? "";
    expect(text).toContain("Downloading another speech model (about 465 MB) - 40%");
    expect(text).toContain("This only happens once.");
    expect(text).not.toMatch(/first time|one time/i);
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

describe("ImportProgress — a speech model download that failed", () => {
  it("says what happened and that speech waits for the model, with a Retry, when nothing is scheduled", () => {
    setModelDownloadFailure("server_busy");
    render(<ImportProgress />);
    const card = screen.getByTestId("model-failure");
    expect(card.textContent).toContain("Could not download the speech model.");
    expect(card.textContent).toContain("The download site is busy.");
    expect(card.textContent).toContain("Speech features wait until the model is downloaded.");
    expect(card.textContent).not.toContain("try again by itself");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("says the app tries again by itself while a round is waiting for its turn", () => {
    setModelDownloadFailure("network");
    setModelNextAttemptAt(Date.now() + 60_000);
    render(<ImportProgress />);
    const card = screen.getByTestId("model-failure");
    expect(card.textContent).toContain("The app will try again by itself.");
    expect(card.textContent).not.toContain("Speech features wait");
  });

  it("goes when the person dismisses it, and comes back for the next failure", () => {
    setModelDownloadFailure("network");
    const view = render(<ImportProgress />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    view.rerender(<ImportProgress />);
    expect(screen.queryByTestId("model-failure")).toBeNull();
    expect(view.container.textContent).toBe(""); // nothing left on screen
    setModelDownloadFailure("disk_write");
    view.rerender(<ImportProgress />);
    expect(screen.getByTestId("model-failure").textContent).toContain("free space");
  });

  it("is never shown together with the download it is about, whatever the store holds", () => {
    useModelDownload.setState({ failure: "network", received: 100, total: TOTAL });
    render(<ImportProgress />);
    expect(screen.getByTestId("model-download")).toBeTruthy();
    expect(screen.queryByTestId("model-failure")).toBeNull();
  });

  it("sits beside the import progress without replacing it", () => {
    useImportJobs.getState().begin("C:/clips/a.mp4", "a.mp4");
    try {
      setModelDownloadFailure("incomplete");
      render(<ImportProgress />);
      expect(screen.getByTestId("model-failure")).toBeTruthy();
      expect(screen.getByTestId("import-pct")).toBeTruthy();
    } finally {
      useImportJobs.getState().finish("C:/clips/a.mp4");
    }
  });
});
