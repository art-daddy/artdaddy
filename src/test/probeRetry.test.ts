import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { ProbeStalled, type SeekReport, retryStalledProbe, seekStall } from "./probeRetry";

const stall = (stage = "html-video:present") => new ProbeStalled(`stalled at ${stage}`, stage);

describe("retryStalledProbe", () => {
  it("asks once and does not touch the page when the first try finishes", async () => {
    const attempt = vi.fn(async () => "shots");
    const onStall = vi.fn(async () => undefined);

    await expect(retryStalledProbe(attempt, onStall)).resolves.toBe("shots");

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("tries again after a stall and returns what the second try produced", async () => {
    const attempt = vi
      .fn<(tryNumber: number) => Promise<string>>()
      .mockRejectedValueOnce(stall("native-h264-calibration"))
      .mockResolvedValueOnce("second try");
    const onStall = vi.fn<(stalled: ProbeStalled, tryNumber: number) => Promise<void>>(
      async () => undefined,
    );

    await expect(retryStalledProbe(attempt, onStall)).resolves.toBe("second try");

    expect(attempt.mock.calls.map(([tryNumber]) => tryNumber)).toEqual([1, 2]);
    expect(onStall).toHaveBeenCalledOnce();
    expect(onStall.mock.calls[0][0].stage).toBe("native-h264-calibration");
    expect(onStall.mock.calls[0][1]).toBe(1);
  });

  it("still fails when the probe stalls on every try, with the LAST stall", async () => {
    const first = stall("first");
    const last = stall("last");
    const attempt = vi
      .fn<(tryNumber: number) => Promise<string>>()
      .mockRejectedValueOnce(first)
      .mockRejectedValueOnce(last);
    const onStall = vi.fn(async () => undefined);

    await expect(retryStalledProbe(attempt, onStall)).rejects.toBe(last);

    expect(attempt).toHaveBeenCalledTimes(2);
    expect(onStall, "no replacement page is opened after the final failure").toHaveBeenCalledOnce();
  });

  it("never retries a verdict, even one that mentions a stall", async () => {
    const verdict = new Error("Rotation probe did not finish; stage=html-video:present");
    const attempt = vi.fn(async () => {
      throw verdict;
    });
    const onStall = vi.fn(async () => undefined);

    await expect(retryStalledProbe(attempt, onStall)).rejects.toBe(verdict);

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("finishes replacing the page before the next try starts", async () => {
    const events: string[] = [];
    let page = "stalled page";
    const attempt = vi.fn(async (tryNumber: number) => {
      events.push(`try ${tryNumber} on ${page}`);
      if (tryNumber === 1) throw stall();
      return page;
    });
    const onStall = async () => {
      events.push("replacing");
      await new Promise((resolve) => setTimeout(resolve, 5));
      page = "fresh page";
      events.push("replaced");
    };

    await expect(retryStalledProbe(attempt, onStall)).resolves.toBe("fresh page");

    expect(events).toEqual([
      "try 1 on stalled page",
      "replacing",
      "replaced",
      "try 2 on fresh page",
    ]);
  });

  it("does not hide a failure to replace the page", async () => {
    const attempt = vi.fn(async () => {
      throw stall();
    });
    const noPage = new Error("browser has been closed");

    await expect(
      retryStalledProbe(attempt, async () => {
        throw noPage;
      }),
    ).rejects.toBe(noPage);

    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("allows as many tries as it is given, and no more", async () => {
    const attempt = vi
      .fn<(tryNumber: number) => Promise<string>>()
      .mockRejectedValueOnce(stall("a"))
      .mockRejectedValueOnce(stall("b"))
      .mockResolvedValueOnce("third try");

    await expect(retryStalledProbe(attempt, async () => undefined, 3)).resolves.toBe("third try");

    const alwaysStalls = vi.fn(async () => {
      throw stall();
    });
    await expect(retryStalledProbe(alwaysStalls, async () => undefined, 3)).rejects.toBeInstanceOf(
      ProbeStalled,
    );
    expect(alwaysStalls).toHaveBeenCalledTimes(3);
  });
});

// What CI really captured (e2e/ui/stream.spec.ts, macos-14, chromium). The runs of 2026-10-20 and
// 2026-10-27 were recorded before `waitedMs` existed; 8000 is what the probe now records for a
// shot that never matched.
const RED = [220, 32, 31, 255];
const GREEN = [26, 203, 50, 255];
const SEEKS = [0.4, 2, 0.4, 2.9, 0.4];
const shot = (index: number, pixel: ReadonlyArray<number>, matched: boolean) => ({
  time: SEEKS[index],
  pixel,
  matched,
  waitedMs: matched ? 40 : 8000,
});
const report = (pixels: Array<number[] | "match">, errors: string[] = []): SeekReport => ({
  shots: pixels.map((pixel, index) =>
    pixel === "match"
      ? shot(index, index === 1 || index === 3 ? GREEN : RED, true)
      : shot(index, pixel, false),
  ),
  errors,
});

describe("seekStall", () => {
  it("calls a worker that went black after the seek to 2.9 s a stall (CI, 2026-10-20, twice)", () => {
    const seen = report(["match", "match", "match", [0, 0, 0, 255], []]);
    expect(seekStall(seen)).toEqual({ time: 2.9, waitedMs: 8000 });
  });

  it("calls a page that showed nothing from the seek to 2 s on a stall (CI, 2026-10-20)", () => {
    expect(seekStall(report(["match", [], [], [], []]))).toEqual({ time: 2, waitedMs: 8000 });
  });

  it("calls the same blank picture on the main thread a stall (CI main, 2026-10-27)", () => {
    expect(seekStall(report(["match", "match", "match", [0, 0, 0, 255], []]))?.time).toBe(2.9);
  });

  it("does not call a picture that came, on every seek, a stall", () => {
    expect(seekStall(report(["match", "match", "match", "match", "match"]))).toBeNull();
  });

  it("leaves a preview that REPORTED an error to the test (ubuntu webkit, 10 runs)", () => {
    const failed = report(
      [[], [], [], [], []],
      ["Error: WebGL2 is not available in this environment"],
    );
    expect(seekStall(failed)).toBeNull();
  });

  it("leaves a WRONG picture to the test: the stale frame a backward seek used to leave", () => {
    // Red where green was asked for, at the seek to 2 s.
    expect(seekStall(report(["match", RED, "match", "match", "match"]))).toBeNull();
  });

  it("does not let a blank shot excuse a wrong one in the same run", () => {
    expect(seekStall(report(["match", RED, "match", [0, 0, 0, 255], []]))).toBeNull();
  });

  it("is a stall only when every missed shot drew nothing, whatever the pixels and errors", () => {
    const byte = fc.integer({ min: 0, max: 255 });
    const shotArb = fc.oneof(
      fc.constant({ kind: "matched" as const, pixel: RED }),
      fc
        .constantFrom([], [0, 0, 0, 255], [0, 0, 0, 0])
        .map((pixel) => ({ kind: "blank" as const, pixel })),
      // Any colour with a trace of something in it: a picture, just not the right one.
      fc
        .tuple(byte, byte, byte)
        .filter(([r, g, b]) => r + g + b > 0)
        .map(([r, g, b]) => ({ kind: "wrong" as const, pixel: [r, g, b, 255] })),
    );
    fc.assert(
      fc.property(
        fc.array(shotArb, { minLength: 5, maxLength: 5 }),
        fc.array(fc.string({ minLength: 1 }), { maxLength: 2 }),
        (made, errors) => {
          const shots = made.map(({ kind, pixel }, index) =>
            shot(index, pixel, kind === "matched"),
          );
          const missed = made.flatMap((m, index) =>
            m.kind === "matched" ? [] : [{ ...m, index }],
          );
          const blankOnly = missed.length > 0 && missed.every((m) => m.kind === "blank");

          const stall = seekStall({ shots, errors });

          if (errors.length === 0 && blankOnly) expect(stall?.time).toBe(SEEKS[missed[0].index]);
          else expect(stall).toBeNull();
        },
      ),
      { numRuns: 500 },
    );
  });
});
