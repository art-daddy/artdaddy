import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import ImportProgress from "./ImportProgress";
import { clearModelDownload, reportModelDownload } from "../store/modelDownload";
import { WHISPER_MODELS } from "../tools/transcribe";

const TOTAL = WHISPER_MODELS.small.bytes;

afterEach(() => clearModelDownload());

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
      "downloading speech model - this only happens the first time post install, 465 MB, 40%",
    );
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
});
