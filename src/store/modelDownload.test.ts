import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearModelDownload,
  downloadEtaSeconds,
  formatEta,
  megabytes,
  MODEL_DOWNLOAD_NOTE,
  MODEL_DOWNLOAD_NOTE_AGAIN,
  modelDownloadMessage,
  modelDownloadNote,
  percent,
  reportModelDownload,
  setModelDownloadAgain,
  setModelDownloadCancel,
  setModelDownloadFailure,
  setModelNextAttemptAt,
  useModelDownload,
} from "./modelDownload";
import { WHISPER_MODELS } from "../tools/transcribe";

const TOTAL = WHISPER_MODELS.small.bytes;
const MiB = 1024 * 1024;

describe("modelDownloadMessage", () => {
  // Anchored to the PINNED model, not to a hand-typed 465: a revision bump moves the number
  // instead of leaving the UI quoting a size the download no longer has.
  it("reads exactly as the user is told, for the model we actually ship", () => {
    expect(modelDownloadMessage(Math.round(TOTAL * 0.4), TOTAL)).toBe(
      "Downloading the speech model (one time, about 465 MB) - 40%",
    );
  });

  it("adds how long is left once that can be told", () => {
    expect(modelDownloadMessage(Math.round(TOTAL * 0.4), TOTAL, 130)).toBe(
      "Downloading the speech model (one time, about 465 MB) - 40%, about 3 min left",
    );
  });

  // The owner's wording (2026-11-01): a 465 MB download that appears on its own has to say that it
  // is not a thing that happens every time.
  it("says it only happens when the app is started for the first time", () => {
    expect(MODEL_DOWNLOAD_NOTE).toBe(
      "This only happens when you start the app for the first time.",
    );
  });

  // A second model file (another one is already on this PC) is not "the first time you start the app": the owner's
  // words would be untrue of it, so it says it is another model and that it only happens once.
  it("says another model, and nothing about the first start, for a second file", () => {
    expect(modelDownloadMessage(Math.round(TOTAL * 0.4), TOTAL, null, true)).toBe(
      "Downloading another speech model (about 465 MB) - 40%",
    );
    expect(modelDownloadMessage(Math.round(TOTAL * 0.4), TOTAL, 130, true)).toBe(
      "Downloading another speech model (about 465 MB) - 40%, about 3 min left",
    );
    expect(modelDownloadNote(true)).toBe(MODEL_DOWNLOAD_NOTE_AGAIN);
    expect(modelDownloadNote(false)).toBe(MODEL_DOWNLOAD_NOTE);
    expect(modelDownloadNote()).toBe(MODEL_DOWNLOAD_NOTE);
    // The rule that survives a rewrite of the words: no claim about the first start or about "one time".
    for (const said of [modelDownloadMessage(1, TOTAL, null, true), MODEL_DOWNLOAD_NOTE_AGAIN])
      expect(said).not.toMatch(/first time|one time|for the first/i);
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

describe("formatEta", () => {
  it("says it in the unit a person would", () => {
    expect(formatEta(0)).toBe("about 1 s");
    expect(formatEta(40)).toBe("about 40 s");
    expect(formatEta(89)).toBe("about 89 s");
    expect(formatEta(90)).toBe("about 2 min");
    expect(formatEta(130)).toBe("about 3 min");
    expect(formatEta(5000)).toBe("about 84 min");
    expect(formatEta(6000)).toBe("about 2 h");
  });

  it("is never shorter than the wait it describes, and never more than one unit longer", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 200_000, noNaN: true }), (seconds) => {
        const m = /^about (\d+) (s|min|h)$/.exec(formatEta(seconds));
        expect(m).not.toBeNull();
        const unit = { s: 1, min: 60, h: 3600 }[m![2] as "s" | "min" | "h"];
        const said = Number(m![1]) * unit;
        expect(said).toBeGreaterThanOrEqual(seconds);
        expect(said - Math.max(1, seconds)).toBeLessThan(unit);
      }),
    );
  });
});

describe("the download's Cancel", () => {
  it("is there while a download is under way and gone when it is over", () => {
    const cancel = vi.fn();
    setModelDownloadCancel(cancel);
    expect(useModelDownload.getState().cancel).toBe(cancel);
    clearModelDownload();
    expect(useModelDownload.getState().cancel).toBeNull();
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

  afterEach(() => {
    vi.useRealTimers();
    clearModelDownload();
  });

  it("starts its clock at the first report of a download, keeps it through the rest, and starts afresh after", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    reportModelDownload(30 * MiB, TOTAL); // a part an earlier attempt left on disk
    vi.setSystemTime(1_010_000);
    reportModelDownload(40 * MiB, TOTAL);
    expect(useModelDownload.getState()).toMatchObject({
      startedAt: 1_000_000,
      startReceived: 30 * MiB,
      received: 40 * MiB,
    });
    clearModelDownload();
    vi.setSystemTime(2_000_000);
    reportModelDownload(0, TOTAL);
    expect(useModelDownload.getState()).toMatchObject({ startedAt: 2_000_000, startReceived: 0 });
  });
});

describe("the download that failed, and the round that is waiting", () => {
  afterEach(() => {
    setModelDownloadFailure(null);
    setModelNextAttemptAt(null);
    clearModelDownload();
  });

  it("stays through the end of the download it belongs to: that is exactly when it matters", () => {
    reportModelDownload(120, 400);
    setModelDownloadFailure("network");
    setModelNextAttemptAt(5_000);
    clearModelDownload();
    expect(useModelDownload.getState()).toMatchObject({
      total: 0,
      failure: "network",
      nextAttemptAt: 5_000,
    });
  });

  it("is over as soon as a new download begins: it is never held beside one under way", () => {
    setModelDownloadFailure("stalled");
    setModelNextAttemptAt(5_000);
    reportModelDownload(0, 400);
    expect(useModelDownload.getState()).toMatchObject({
      total: 400,
      failure: null,
      nextAttemptAt: null,
    });
  });

  it("goes when the person dismisses it, and says nothing else changed", () => {
    reportModelDownload(120, 400);
    setModelDownloadFailure("disk_write");
    setModelDownloadFailure(null);
    expect(useModelDownload.getState()).toMatchObject({ received: 120, total: 400, failure: null });
  });

  it("remembers which file it is about, for as long as it lasts and no longer: its Retry asks for that file", () => {
    setModelDownloadFailure("network", "small");
    expect(useModelDownload.getState()).toMatchObject({ failure: "network", failureKey: "small" });
    // The download ending leaves the card, so it leaves the file the card is about.
    clearModelDownload();
    expect(useModelDownload.getState().failureKey).toBe("small");
    // A new download begins: the card is over.
    reportModelDownload(0, 400);
    expect(useModelDownload.getState()).toMatchObject({ failure: null, failureKey: null });
    clearModelDownload();
    // A dismissed card has no file, and a failure said without one does not keep an old one.
    setModelDownloadFailure("disk_write", "small_q8_0");
    setModelDownloadFailure(null);
    expect(useModelDownload.getState().failureKey).toBeNull();
    setModelDownloadFailure("disk_write", "small_q8_0");
    setModelDownloadFailure("network");
    expect(useModelDownload.getState()).toMatchObject({ failure: "network", failureKey: null });
  });
});

describe("the download that is a second model file", () => {
  afterEach(() => clearModelDownload());

  it("is said by a report, left alone by one that does not say, and over with the download", () => {
    reportModelDownload(0, 400, true);
    expect(useModelDownload.getState().again).toBe(true);
    reportModelDownload(100, 400);
    expect(useModelDownload.getState().again).toBe(true);
    clearModelDownload();
    expect(useModelDownload.getState().again).toBe(false);
    reportModelDownload(0, 400);
    expect(useModelDownload.getState().again).toBe(false);
    // Learned from the disk while the download runs.
    setModelDownloadAgain(true);
    expect(useModelDownload.getState().again).toBe(true);
    reportModelDownload(100, 400, false);
    expect(useModelDownload.getState().again).toBe(false);
  });
});

describe("downloadEtaSeconds", () => {
  const at = (
    received: number,
    seconds: number,
    over: Partial<{ total: number; startReceived: number }> = {},
  ) =>
    downloadEtaSeconds(
      {
        received,
        total: over.total ?? 100 * MiB,
        startedAt: 0,
        startReceived: over.startReceived ?? 0,
      },
      seconds * 1000,
    );

  it("says nothing while there is nothing to measure", () => {
    expect(at(0, 10)).toBeNull(); // no byte yet
    expect(at(5 * MiB, 1.9)).toBeNull(); // too soon to trust a speed
    expect(at(5 * MiB, 10, { total: 0 })).toBeNull(); // not downloading
    expect(at(30 * MiB, 10, { startReceived: 30 * MiB })).toBeNull(); // only what was already there
  });

  it("is the rest of the bytes at the speed so far", () => {
    expect(at(10 * MiB, 10)).toBe(90); // 1 MiB/s, 90 MiB to go
    expect(at(50 * MiB, 10)).toBe(10); // 5 MiB/s, 50 MiB to go
  });

  it("measures what came in during this download, not what an earlier attempt left on disk", () => {
    // 50 MiB were there at the start; 10 MiB arrived in 10 s: 1 MiB/s, 40 MiB to go.
    expect(at(60 * MiB, 10, { startReceived: 50 * MiB })).toBe(40);
  });

  it("is never negative or NaN, and at a steady speed only ever falls", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 * MiB }),
        fc.integer({ min: 0, max: 200 * MiB }),
        fc.integer({ min: 2, max: 3600 }),
        fc.integer({ min: 0, max: 3600 }),
        (rate, startReceived, t1, gap) => {
          const total = 500 * MiB;
          const t2 = t1 + gap;
          const eta1 = at(startReceived + rate * t1, t1, { total, startReceived });
          const eta2 = at(startReceived + rate * t2, t2, { total, startReceived });
          for (const eta of [eta1, eta2]) {
            expect(Number.isNaN(eta)).toBe(false);
            expect(eta!).toBeGreaterThanOrEqual(0);
          }
          expect(eta2!).toBeLessThanOrEqual(eta1!);
        },
      ),
    );
  });
});
