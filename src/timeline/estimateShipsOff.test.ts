// What this build ships of the honest estimate and the PC's speed check: both held off by the build (api/exportFlags.ts, OFF_IN_THIS_BUILD), whatever the server says. The inputs here are the worst case for the hold:
// every switch the server could send is on, and a finished speed check is on file that would make the new estimate name a class and a range. They go through the real switch reader into the real estimate and admission
// code, so a seam that reads the server's word around the hold shows here; and the same inputs with the hold lifted give the new estimate, so the test cannot pass because there was nothing to hold back.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetExportFlags, __setExportFlag, __setHeldOffByBuild } from "../api/exportFlags";
import { NOT_ADMITTED_3C, withHonestTime } from "./estimateAdmission";
import { estimateDepsNow } from "./estimateDeps";
import { EXPORT_SPEED_REVISION, type ExportEstimates } from "./exportOptions";
import type { RouteEstimatesRequest } from "./exportTypes3c";
import { flags3cNow } from "./flags3c";
import { emptyTimeline, type Clip, type Timeline } from "./model";
import type { PcCheckRecord } from "./pcClass";
import { summarizeRenderWorkload } from "./renderPlan";
import {
  __resetRouteEstimatesMemo,
  estimatesForRoutes,
  type AdmissionInput,
} from "./routeEstimates";

const NOW = 1_800_000_000_000;

const clip = (id: string, from: number, to: number): Clip => ({
  id,
  kind: "video",
  media_ref: `${id}.mp4`,
  source_in: 0,
  source_out: to - from,
  timeline_in: from,
  timeline_out: to,
});
/** A two-minute talk at 1080p30. */
const talk: Timeline = (() => {
  const raw = emptyTimeline(1920, 1080, 30);
  raw.tracks = [{ id: "v1", kind: "video", z: 0, clips: [clip("a", 0, 3600)] }];
  return raw;
})();
const workload = summarizeRenderWorkload(talk);

const checked: PcCheckRecord = {
  revision: 1,
  build: "artdaddy@test",
  atMs: NOW - 60_000,
  cores: 8,
  outcome: "done",
  aFps: 90,
  bFps: 36,
  cFps: 70,
  rHat: 0.5,
  cls: "fast",
};
const request: RouteEstimatesRequest = {
  workload,
  settings: { resolution: "source", quality: "medium", fps: null },
  explicit: { size: false, fps: false },
  chipMaker: null,
};
// the real reader for the switches; everything else is the test's, so the estimate has a project, a finished check and a clock to price on
const deps = () =>
  estimateDepsNow({
    openTimeline: () => talk,
    speedCheck: () => checked,
    cutoffs: () => undefined,
    cores: () => 8,
    history: () => [],
    storage: () => null,
    build: "artdaddy@test",
    speedRevision: EXPORT_SPEED_REVISION,
    now: () => NOW,
  });

beforeEach(() => {
  __resetExportFlags();
  __resetRouteEstimatesMemo();
  __setExportFlag("estimate_v2", true);
  __setExportFlag("pc_check", true);
  __setHeldOffByBuild(true);
});
afterEach(() => {
  __setHeldOffByBuild(false);
  __resetExportFlags();
  __resetRouteEstimatesMemo();
});

describe("the build ships the honest estimate and the speed check off", () => {
  it("the Export dialog is priced as 0.27.0 priced it: a figure with no range, no PC class from the check on file and no Quick", () => {
    expect(flags3cNow()).toMatchObject({ estimate_v2: false, pc_check: false });
    const held = estimatesForRoutes(request, deps());
    expect(held.pcClass).toBe("unknown");
    expect(held.quick).toBeNull();
    expect(held.standard).not.toBeNull();
    expect(held.standard!.basis).not.toBe("pc_check");
    expect(held.standard!.high).toBe(held.standard!.low);

    // the same inputs once the hold is lifted: the new estimate, which is what there was to hold back
    __setHeldOffByBuild(false);
    __resetRouteEstimatesMemo();
    const open = estimatesForRoutes(request, deps());
    expect(open.pcClass).toBe("fast");
    expect(open.standard!.basis).toBe("pc_check");
    expect(open.standard!.high).toBeGreaterThan(open.standard!.low);
    expect(open.quick).not.toBeNull();
  });

  it("the admission door hands back 0.27.0's estimate untouched and admits nothing as 'new', so nothing is taught to the pace log either", () => {
    const legacy: ExportEstimates = {
      memoryBytes: 1e9,
      temporaryBytes: 2e9,
      finalBytes: 3e7,
      seconds: 100,
    };
    const input: AdmissionInput = {
      workload,
      output: { width: 1920, height: 1080, fps: 30 },
      quality: "medium",
      engine: "file-sequence-v1",
      encoder: undefined,
    };
    const held = withHonestTime(legacy, input);
    expect(held.estimates).toBe(legacy);
    expect(held.read).toBe(NOT_ADMITTED_3C);

    __setHeldOffByBuild(false);
    const open = withHonestTime(legacy, input);
    expect(open.read.v2).toBe(true);
    expect(open.estimates).not.toBe(legacy);
  });
});
