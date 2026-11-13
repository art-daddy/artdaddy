// The rows of the preview copies being built (UJ-091): what the stage's pill and the library tile read.
import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";

import { jobFor, percentWords, pillJob, timeLeftWords, useProxyJobs } from "./proxyJobs";

const jobs = () => useProxyJobs.getState().jobs;
beforeEach(() => useProxyJobs.setState({ jobs: [] }));

describe("useProxyJobs", () => {
  it("lists a copy from the moment it begins and drops it when it finishes, whatever the spelling of its path", () => {
    useProxyJobs.getState().begin("library/media_a.mp4", "drone.mov", ["media_a"], 1_000);
    expect(jobs()).toHaveLength(1);
    // the same file asked by an absolute spelling is the same row, never a second one
    useProxyJobs.getState().begin("C:/proj/library/media_a.mp4", "drone.mov", ["media_a"], 1_000);
    expect(jobs()).toHaveLength(1);
    expect(jobFor(jobs(), "C:/proj/library/media_a.mp4")?.name).toBe("drone.mov");
    useProxyJobs.getState().finish("library/media_a.mp4");
    expect(jobs()).toEqual([]);
  });

  it("ignores progress for a copy it was never told about, and finish for one that is gone", () => {
    useProxyJobs.getState().progress("library/ghost.mp4", { outMs: 1, totalMs: 2, speed: 1 });
    useProxyJobs.getState().finish("library/ghost.mp4");
    expect(jobs()).toEqual([]);
  });

  describe("the percent and the time left", () => {
    const begin = () => useProxyJobs.getState().begin("library/a.mp4", "a.mov", [], 0);
    const progress = (outMs: number, totalMs: number, speed: number, now: number) =>
      useProxyJobs.getState().progress("library/a.mp4", { outMs, totalMs, speed }, now);

    it("says nothing about time at 2% after 1 s, and says it at 5%", () => {
      begin();
      progress(2_000, 100_000, 2, 1_000);
      expect(jobs()[0].fraction).toBeCloseTo(0.02);
      expect(jobs()[0].etaSeconds).toBeNull();
      progress(5_000, 100_000, 2, 2_000);
      expect(jobs()[0].etaSeconds).toBe(47.5); // 95 s of the source left at twice real time
    });

    it("says it after 3 s with a reading even below 5%", () => {
      begin();
      progress(1_000, 100_000, 0.5, 3_000);
      expect(jobs()[0].etaSeconds).toBe(198); // 99 s left at half speed
    });

    it("with no length for the source there is no percent and no time, and the row stays", () => {
      begin();
      progress(4_000, 0, 2, 10_000);
      expect(jobs()).toHaveLength(1);
      expect(jobs()[0].fraction).toBeNull();
      expect(jobs()[0].etaSeconds).toBeNull();
    });

    it("never goes backwards, and never past 100%", () => {
      begin();
      progress(60_000, 100_000, 2, 5_000);
      progress(30_000, 100_000, 2, 6_000); // a late block
      expect(jobs()[0].fraction).toBe(0.6);
      progress(150_000, 100_000, 2, 7_000); // ffmpeg overshoots the nominal length
      expect(jobs()[0].fraction).toBe(1);
    });
  });
});

describe("timeLeftWords", () => {
  it("is empty while unknown", () => {
    for (const v of [null, NaN, Infinity, -1]) expect(timeLeftWords(v as number | null)).toBe("");
  });

  it("rounds up to 5 s under a minute and a half, never says 0, then goes to minutes", () => {
    expect(timeLeftWords(0)).toBe("about 5 s left");
    expect(timeLeftWords(0.2)).toBe("about 5 s left");
    expect(timeLeftWords(5.1)).toBe("about 10 s left");
    expect(timeLeftWords(47.5)).toBe("about 50 s left");
    expect(timeLeftWords(89.9)).toBe("about 90 s left");
    expect(timeLeftWords(90)).toBe("about 2 min left");
    expect(timeLeftWords(3600)).toBe("about 60 min left");
  });

  it("property: never promises less time than is left under a minute and a half, and never an unreadable string", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 100_000, noNaN: true }), (s) => {
        const words = timeLeftWords(s);
        expect(words).toMatch(/^about \d+ (s|min) left$/);
        const n = Number(/\d+/.exec(words)![0]);
        if (s < 90) expect(n).toBeGreaterThanOrEqual(Math.min(s, 90) - 0.0001);
      }),
    );
  });
});

describe("percentWords", () => {
  it("is empty before the first report and a whole number after", () => {
    expect(percentWords(null)).toBe("");
    expect(percentWords(0)).toBe("0%");
    expect(percentWords(0.424)).toBe("42%");
    expect(percentWords(1.7)).toBe("100%");
  });
});

describe("pillJob: which copy the stage names", () => {
  const row = (key: string, refs: string[]) => ({
    key,
    name: key,
    refs,
    startedAt: 0,
    fraction: null,
    etaSeconds: null,
  });

  it("names the copy of the clip under the playhead, else the one that began first, and counts them", () => {
    const rows = [row("a", ["media_a"]), row("b", ["media_b"])];
    expect(pillJob(rows, ["media_b"])).toMatchObject({ job: { key: "b" }, count: 2 });
    expect(pillJob(rows, ["media_zzz"])).toMatchObject({ job: { key: "a" }, count: 2 });
    expect(pillJob(rows, [])).toMatchObject({ job: { key: "a" }, count: 2 });
    expect(pillJob([], ["media_a"])).toBeNull();
  });
});
