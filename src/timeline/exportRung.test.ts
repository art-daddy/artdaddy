import { afterEach, describe, expect, it, vi } from "vitest";

import { decideRung } from "./exportRung";
import { EXPORT_SPEED_REVISION, type ExportCalibration } from "./exportOptions";
import { GIB } from "./exportPlan";
import type { RenderWorkload } from "./renderPlan";

const workload: RenderWorkload = {
  width: 4320,
  height: 7680,
  fps: 30,
  durationSeconds: 6,
  visualClips: 1,
  captionClips: 0,
  audioClips: 1,
  peakVisualLayers: 1,
  peakMediaLayers: 1,
};
const output = { width: 1080, height: 1920, fps: 30 };
const history = (rung: 0 | 1 | 2, bytes: number): ExportCalibration => ({
  workload,
  output,
  quality: "medium",
  engine: "file-sequence-v1",
  encoder: "x264-crf",
  revision: EXPORT_SPEED_REVISION,
  elapsedSeconds: 22,
  finalBytes: 12e6,
  memoryBytes: bytes,
  temporaryBytes: 0,
  rung,
});
const pc = (freeGiB: number | null) => async () =>
  freeGiB === null
    ? null
    : {
        total_memory_bytes: 16 * GIB,
        available_memory_bytes: freeGiB * GIB,
        scratch_free_bytes: 100 * GIB,
        destination_free_bytes: 100 * GIB,
        local_fast_candidate: false,
        budgets: { memoryBytes: 8 * GIB, temporaryBytes: 18 * GIB, executionSeconds: 28_800 },
      };

const decide = (over: Partial<Parameters<typeof decideRung>[0]> = {}) =>
  decideRung({
    workload,
    output,
    quality: "medium",
    engine: "file-sequence-v1",
    encoder: "x264-crf",
    history: [history(0, 3.52 * GIB)],
    destPath: "/out/final.mp4",
    enabled: true,
    resolve: pc(4),
    ...over,
  });

afterEach(() => vi.restoreAllMocks());

describe("deciding the rung for an export", () => {
  it("runs the gentle rung when this PC's own history says the normal one will not fit its free memory", async () => {
    const decision = await decide();
    expect(decision.rung).toBe(1);
    expect(decision.plan).toMatchObject({ fits: true, basis: "derived" });
    expect(decision.freeBytes).toBe(4 * GIB);
  });

  it("runs the normal rung when there is room, and when nothing is known about the shape", async () => {
    expect((await decide({ resolve: pc(40) })).rung).toBe(0);
    expect((await decide({ history: [] })).rung).toBe(0); // a first export is never slowed down on a guess
  });

  // XR-28: a person who has less than the reserve free is asked before the export starts, and Continue and Start
  // anyway both run what was captured. With nothing measured that must be the rung that needs least.
  it("runs the gentlest rung the engine has when nothing is known and the PC has less than the reserve free", async () => {
    const first = await decide({ history: [], resolve: pc(1) });
    expect(first).toMatchObject({ rung: 2, maxRung: 2 });
    expect(first.plan).toMatchObject({ fits: false, basis: "unmeasured" });
    expect((await decide({ history: [], resolve: pc(1), maxRung: 1 })).rung).toBe(1);
    // ...but the streamed engine has one rung, the switch off means no rungs at all, and an unmeasurable PC asks nothing.
    expect((await decide({ history: [], resolve: pc(1), engine: "partition-pipes-v1" })).rung).toBe(
      0,
    );
    expect((await decide({ history: [], resolve: pc(1), enabled: false })).rung).toBe(0);
    expect((await decide({ history: [], resolve: pc(null) })).rung).toBe(0);
  });

  it("leaves everything as it was when the switch is off: always the normal rung, and the PC is not even asked", async () => {
    const resolve = vi.fn(pc(1));
    const decision = await decide({ enabled: false, resolve });
    expect(decision.rung).toBe(0);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("goes on with the rung it was given when the PC cannot be measured, and never fails the export", async () => {
    expect((await decide({ resolve: pc(null) })).rung).toBe(0);
    expect((await decide({ resolve: pc(null), minRung: 1 })).rung).toBe(1);
    const broken = async () => {
      throw new Error("the app process is gone");
    };
    expect((await decide({ resolve: broken })).rung).toBe(0);
  });

  it("starts no gentler than it was asked to (a second try), and no gentler than the engine can be", async () => {
    expect((await decide({ resolve: pc(40), minRung: 1 })).rung).toBe(1);
    expect((await decide({ resolve: pc(40), minRung: 2 })).rung).toBe(2);
    // The streamed engine already runs at its gentlest thread counts: its only rung is the normal one.
    const streamed = await decide({
      engine: "partition-pipes-v1",
      history: [{ ...history(0, 3.52 * GIB), engine: "partition-pipes-v1" }],
      minRung: 2,
    });
    expect(streamed.rung).toBe(0);
  });

  it("learns: a measurement made at the gentle rung is used, so the next export does not ask again", async () => {
    // 2 GiB free: the first export (only the normal rung is known) is cautious; after a run at the
    // gentlest rung left its peak behind, the gentle rung is predicted from it and fits.
    const first = await decide({ resolve: pc(2) });
    expect(first.plan.fits).toBe(false);
    const second = await decide({
      resolve: pc(2),
      history: [history(0, 3.52 * GIB), history(2, 0.76 * GIB)],
    });
    expect(second).toMatchObject({ rung: 1 });
    expect(second.plan.fits).toBe(true);
  });

  // Found by review: with thirteen or more video clips the two gentler rungs are the same command, and the plan
  // counted on a saving from the second that is not there.
  it("never counts on a rung the export does not have, and says how many it has", async () => {
    // 0.5 x the normal peak fits at rung 2 (0.5 is below 0.6) but a rung 2 that is rung 1 saves nothing: 4 GiB free
    // gives a 3 GiB ceiling, and 5.5 GiB x 0.5 = 2.75 would fit if rung 2 were counted on.
    const history5 = [history(0, 5.5 * GIB)];
    const counted = await decide({ resolve: pc(4), history: history5 });
    expect(counted.rung).toBe(2);
    const honest = await decide({ resolve: pc(4), history: history5, maxRung: 1 });
    expect(honest.rung).toBe(1);
    expect(honest.plan.fits).toBe(false); // it will not fit, and says so instead of promising a saving
    expect(honest.maxRung).toBe(1);
    expect((await decide({ resolve: pc(40), minRung: 2, maxRung: 1 })).rung).toBe(1);
    // The engine's own bound still holds, whatever is asked.
    const streamed = await decide({ engine: "partition-pipes-v1", maxRung: 2 });
    expect(streamed.maxRung).toBe(0);
    // With the switch off the export runs the normal rung, but its record keeps what its command has: the switch
    // is read again when Try again is offered, and a failure must not say "lightest" about a ladder that was only off.
    expect((await decide({ enabled: false })).rung).toBe(0);
    expect((await decide({ enabled: false })).maxRung).toBe(2);
    expect((await decide({ enabled: false, maxRung: 1 })).maxRung).toBe(1);
    expect((await decide({ enabled: false, engine: "partition-pipes-v1" })).maxRung).toBe(0);
  });
});
