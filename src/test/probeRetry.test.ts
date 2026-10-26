import { describe, expect, it, vi } from "vitest";

import { ProbeStalled, retryStalledProbe } from "./probeRetry";

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
