import { describe, expect, it } from "vitest";

import {
  clearModelDownload,
  megabytes,
  modelDownloadMessage,
  percent,
  reportModelDownload,
  useModelDownload,
} from "./modelDownload";
import { WHISPER_MODELS } from "../tools/transcribe";

const TOTAL = WHISPER_MODELS.small.bytes;

describe("modelDownloadMessage", () => {
  // Anchored to the PINNED model, not to a hand-typed 465: a revision bump moves the number
  // instead of leaving the UI quoting a size the download no longer has.
  it("reads exactly as the user is told, for the model we actually ship", () => {
    expect(modelDownloadMessage(Math.round(TOTAL * 0.4), TOTAL)).toBe(
      "downloading speech model - this only happens the first time post install, 465 MB, 40%",
    );
  });

  it("sizes in MiB, which is the unit the model is measured in", () => {
    // 487,601,967 bytes is 465 MiB. Dividing by 1e6 would announce a 488 MB download.
    expect(megabytes(TOTAL)).toBe(465);
  });

  it("never rounds an unfinished download up to 100%", () => {
    expect(percent(TOTAL - 1, TOTAL)).toBe(99);
    expect(percent(TOTAL, TOTAL)).toBe(100);
  });

  it("stays in range when the total is unknown or the count overshoots", () => {
    expect(percent(10, 0)).toBe(0);
    expect(percent(-5, 100)).toBe(0);
    expect(percent(200, 100)).toBe(100);
  });
});

describe("useModelDownload", () => {
  it("reports progress and clears back to nothing in flight", () => {
    reportModelDownload(120, 400);
    expect(useModelDownload.getState()).toMatchObject({ received: 120, total: 400 });
    clearModelDownload();
    // total 0 is what the UI reads as "no download", so it must not linger at 100%.
    expect(useModelDownload.getState()).toMatchObject({ received: 0, total: 0 });
  });
});
