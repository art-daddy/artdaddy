// The seam between the speed check's stored answer and the estimator's idea of this PC's pace: what a finished check gives, what a check that could not finish gives (a weak PC on a rough guess),
// and what everything else gives (no pace at all). The class cut-offs are an argument (the server's pair in force now), never read from a copy of this module's own.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { estimate, type EstimateRequest } from "./estimator";
import { paceOfCheck } from "./pcPace";
import { classOf, type PcCheckRecord } from "./pcClass";
import { summarizeCostShape } from "./costShape";
import { emptyTimeline, type Clip, type Timeline } from "./model";
import { summarizeRenderWorkload } from "./renderPlan";

const COMPILED = { okOver: 1, weakOver: 4 };

const done = (over: Partial<PcCheckRecord> = {}): PcCheckRecord => ({
  revision: 1,
  build: "artdaddy@test",
  atMs: 1_700_000_000_000,
  cores: 8,
  outcome: "done",
  aFps: 120,
  bFps: 12,
  cFps: 40,
  rHat: 2.5,
  cls: "ok",
  ...over,
});
const unfinished: PcCheckRecord = {
  revision: 1,
  build: "artdaddy@test",
  atMs: 1_700_000_000_000,
  cores: 8,
  outcome: "unfinished",
  aFps: null,
  bFps: null,
  cFps: null,
  rHat: null,
  cls: "unfinished",
};

describe("paceOfCheck", () => {
  it("is this PC's measured pace for a finished check, in the speeds the estimator reads", () => {
    expect(paceOfCheck(done(), COMPILED, 8)).toEqual({
      rHat: 2.5,
      aFps: 120,
      bFps: 12,
      cFps: 40,
      cores: 8,
      cls: "ok",
    });
  });

  it("takes the class from the cut-offs it is handed: the same measurement is OK under 1 and 4 and weak under a pair the server moved", () => {
    expect(paceOfCheck(done({ rHat: 2.5 }), COMPILED, 8)?.cls).toBe("ok");
    expect(paceOfCheck(done({ rHat: 2.5 }), { okOver: 0.5, weakOver: 2 }, 8)?.cls).toBe("weak");
    expect(paceOfCheck(done({ rHat: 0.8 }), { okOver: 0.5, weakOver: 2 }, 8)?.cls).toBe("ok");
    // the class that was stored with the record is the class it had when it was measured: the pair in force now decides
    expect(paceOfCheck(done({ rHat: 2.5, cls: "fast" }), COMPILED, 8)?.cls).toBe("ok");
  });

  it("is not told a pair outside the server's band: the compiled one stands", () => {
    expect(paceOfCheck(done({ rHat: 2.5 }), { okOver: 0.1, weakOver: 99 }, 8)?.cls).toBe("ok");
    expect(paceOfCheck(done({ rHat: 2.5 }), undefined, 8)?.cls).toBe("ok");
    expect(paceOfCheck(done({ rHat: 2.5 }), null as unknown as undefined, 8)?.cls).toBe("ok");
  });

  it("prices a check that could not finish as a slow PC, but never as a measurement", () => {
    const pace = paceOfCheck(unfinished, COMPILED, 8);
    expect(pace).not.toBeNull();
    expect(pace?.cls).toBe("unfinished");
    expect(pace?.cores).toBe(8);
    expect(pace?.bFps).toBeNull();
    // weak means more than 4 times the video's length for the reference export
    expect(pace!.rHat).toBeGreaterThan(COMPILED.weakOver);
    expect(classOf(pace!.rHat, COMPILED)).toBe("weak");
  });

  it("says nothing for no result, a damaged one, or one that cannot be a pace", () => {
    expect(paceOfCheck(null, COMPILED, 8)).toBeNull();
    expect(paceOfCheck(undefined, COMPILED, 8)).toBeNull();
    for (const damaged of [
      done({ rHat: null }),
      done({ rHat: Number.NaN }),
      done({ rHat: -1 }),
      done({ rHat: 0 }),
      done({ bFps: null }),
      done({ bFps: 0 }),
      "nonsense",
      42,
      [],
      { outcome: "done" },
      { ...done(), outcome: "pending" },
    ])
      expect(
        paceOfCheck(damaged as unknown as PcCheckRecord, COMPILED, 8),
        String(damaged),
      ).toBeNull();
  });

  it("uses the machine's core count when it is a count, else the one the record was made with", () => {
    expect(paceOfCheck(done({ cores: 4 }), COMPILED, 16)?.cores).toBe(16);
    expect(paceOfCheck(done({ cores: 4 }), COMPILED, 0)?.cores).toBe(4);
    expect(paceOfCheck(done({ cores: 4 }), COMPILED, Number.NaN)?.cores).toBe(4);
    expect(paceOfCheck(unfinished, COMPILED, 0)?.cores).toBe(8);
  });

  it("never throws and never gives a pace the estimator could not use", () => {
    fc.assert(
      fc.property(
        fc.anything(),
        fc.anything(),
        fc.oneof(fc.double({ noNaN: false }), fc.anything()),
        (result, cutoffs, cores) => {
          const pace = paceOfCheck(result as never, cutoffs as never, cores as never);
          if (pace === null) return;
          expect(Number.isFinite(pace.rHat) && pace.rHat > 0).toBe(true);
          expect(Number.isFinite(pace.cores) && pace.cores >= 1).toBe(true);
          expect(["fast", "ok", "weak", "unfinished"]).toContain(pace.cls);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("what the estimator does with a pace from here", () => {
  const clip = (id: string, from: number, to: number): Clip => ({
    id,
    kind: "video",
    media_ref: `${id}.mp4`,
    source_in: 0,
    source_out: to - from,
    timeline_in: from,
    timeline_out: to,
  });
  const timeline: Timeline = (() => {
    const raw = emptyTimeline(1920, 1080, 30);
    raw.tracks = [{ id: "v1", kind: "video", z: 0, clips: [clip("a", 0, 3600)] }];
    return raw;
  })();
  const request = (pace: EstimateRequest["pace"]): EstimateRequest => {
    const workload = summarizeRenderWorkload(timeline);
    return {
      workload,
      shape: summarizeCostShape(timeline, { facts: null }),
      output: { width: 1920, height: 1080, fps: 30, quality: "medium" },
      route: { family: "processor", faster: false, chipMaker: null, quick: false },
      pace,
      correction: null,
      history: [],
      flags: { estimate_v2: true, pc_check: true },
    };
  };

  it("a finished check is a PC-check estimate; one that could not finish is a rough guess that is slower than a PC that was never checked", () => {
    const checked = estimate(request(paceOfCheck(done({ rHat: 0.5 }), COMPILED, 8)))!;
    const never = estimate(request(paceOfCheck(null, COMPILED, 8)))!;
    const stuck = estimate(request(paceOfCheck(unfinished, COMPILED, 8)))!;
    expect(checked.basis).toBe("pc_check");
    expect(never.basis).toBe("guess");
    expect(stuck.basis).toBe("guess");
    expect(stuck.seconds).toBeGreaterThan(never.seconds);
    expect(stuck.high).toBeGreaterThan(never.high);
  });
});
