// The real inputs of the honest estimate: the switches, the speed check the app ran (through the one handle), the server's cut-offs, this PC's earlier exports and the open timeline. Each test
// changes ONE of the real stores and reads what the person would be told, so a dependency that is wired to the wrong place, or not wired, shows as a number that does not move.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetExportFlags, __setExportFlag, refreshExportFlags } from "../api/exportFlags";
import { createPcCheckService, type PcCheckService } from "../platform/pcCheck";
import { EXPORT_SPEED_PROBE_ID, exportSpeedProbe } from "../platform/pcCheckProbe";
import { useExportJob } from "../store/exportJob";
import {
  admissionEstimateHere,
  estimateDepsNow,
  routeEstimatesHere,
  setOpenTimelineReader,
} from "./estimateDeps";
import { EXPORT_SPEED_REVISION, type ExportCalibration } from "./exportOptions";
import { emptyTimeline, type Clip, type Timeline } from "./model";
import { setPcCheckService } from "./pcCheckHandle";
import { writePcCheck, type PcCheckRecord, type StorageLike } from "./pcClass";
import { summarizeRenderWorkload } from "./renderPlan";
import { __resetRouteEstimatesMemo } from "./routeEstimates";

const DAY = 86_400_000;
const NOW = Date.now();
const BUILD = "artdaddy@test";

const clip = (id: string, from: number, to: number): Clip => ({
  id,
  kind: "video",
  media_ref: `${id}.mp4`,
  source_in: 0,
  source_out: to - from,
  timeline_in: from,
  timeline_out: to,
});
const talk: Timeline = (() => {
  const raw = emptyTimeline(1920, 1080, 30);
  raw.tracks = [{ id: "v1", kind: "video", z: 0, clips: [clip("a", 0, 3600)] }];
  return raw;
})();
const workload = summarizeRenderWorkload(talk);
const request = {
  workload,
  settings: { resolution: "source" as const, quality: "medium" as const, fps: null },
  explicit: { size: false, fps: false },
  chipMaker: null,
};

const record = (over: Partial<PcCheckRecord> = {}): PcCheckRecord => ({
  revision: 1,
  build: BUILD,
  atMs: NOW - DAY,
  cores: 8,
  outcome: "done",
  aFps: 90,
  bFps: 12,
  cFps: 40,
  rHat: 2.5,
  cls: "ok",
  ...over,
});

function checkService(stored: PcCheckRecord | null) {
  const map = new Map<string, string>();
  const storage: StorageLike = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
  const service: PcCheckService = createPcCheckService({
    now: () => NOW,
    storage,
    build: BUILD,
    cores: 8,
    setTimer: () => 0,
    clearTimer: () => undefined,
    probe: async () => ({ kind: "busy" }),
    files: {
      dir: async () => "C:/cache/pc-check",
      mkdir: async () => undefined,
      remove: async () => undefined,
      rename: async () => undefined,
      size: async () => null,
    },
  });
  service.registerProbe(exportSpeedProbe());
  if (stored) writePcCheck(storage, EXPORT_SPEED_PROBE_ID, stored);
  return service;
}

const wire = (timeline: Timeline | null = talk) => setOpenTimelineReader(() => timeline);

beforeEach(() => {
  wire();
  useExportJob.setState({ calibrations: [] });
  __resetRouteEstimatesMemo();
});
afterEach(() => {
  setPcCheckService(null);
  setOpenTimelineReader(null);
  __resetExportFlags();
  useExportJob.setState({ calibrations: [] });
  __resetRouteEstimatesMemo();
});

describe("the speed check the app ran", () => {
  it("is read through the one handle: with a service that holds a check this PC is checked, without one it is not", () => {
    expect(routeEstimatesHere(request).pcClass).toBe("unknown");
    expect(routeEstimatesHere(request).standard!.basis).toBe("guess");
    setPcCheckService(checkService(record()));
    const checked = routeEstimatesHere(request);
    expect(checked.pcClass).toBe("ok");
    expect(checked.standard!.basis).toBe("pc_check");
    setPcCheckService(null);
    expect(routeEstimatesHere(request).pcClass).toBe("unknown");
  });

  it("does not believe a check made by another build, another exporter revision, another number of processors or longer ago than 30 days (P5)", () => {
    const foreign: [string, PcCheckRecord][] = [
      ["another build", record({ build: "artdaddy@older" })],
      ["another revision of the check", record({ revision: 2 })],
      ["another number of processors", record({ cores: 16 })],
      ["31 days ago", record({ atMs: NOW - 31 * DAY })],
    ];
    for (const [what, stale] of foreign) {
      setPcCheckService(checkService(stale));
      const got = routeEstimatesHere(request);
      expect(got.pcClass, what).toBe("unknown");
      expect(got.standard!.basis, what).toBe("guess");
    }
    setPcCheckService(checkService(record({ atMs: NOW - 29 * DAY })));
    expect(routeEstimatesHere(request).pcClass).toBe("ok");
  });

  it("is a check that could not finish: a weak PC on a rough guess", () => {
    setPcCheckService(
      checkService({
        revision: 1,
        build: BUILD,
        atMs: NOW - 60_000,
        cores: 8,
        outcome: "unfinished",
        aFps: null,
        bFps: null,
        cFps: null,
        rHat: null,
        cls: "unfinished",
      }),
    );
    const got = routeEstimatesHere(request);
    expect(got.pcClass).toBe("unfinished");
    expect(got.standard!.basis).toBe("guess");
  });

  it("a damaged store is no check, and the switch removes the class altogether", () => {
    const service = checkService(null);
    setPcCheckService(service);
    expect(routeEstimatesHere(request).pcClass).toBe("unknown");
    setPcCheckService(checkService(record()));
    __setExportFlag("pc_check", false);
    expect(routeEstimatesHere(request).pcClass).toBe("unknown");
    expect(routeEstimatesHere(request).standard!.basis).toBe("guess");
  });
});

describe("the class cut-offs are the server's, inside their band, and nowhere else (P7)", () => {
  const told = async (body: unknown) => {
    await refreshExportFlags({
      force: true,
      signedIn: async () => true,
      fetcher: async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
  };

  it("a pair inside the band moves the same measurement from OK to weak; a pair outside it, or none, leaves the compiled one", async () => {
    setPcCheckService(checkService(record({ rHat: 2.5 })));
    expect(routeEstimatesHere(request).pcClass).toBe("ok");
    await told({ v: 1, flags: {}, pc_class: { ok_over: 0.5, weak_over: 2 } });
    expect(routeEstimatesHere(request).pcClass).toBe("weak");
    // Each pair below is outside its band, and would put this measurement in another class than the compiled pair does, so a band that is not checked shows.
    for (const outside of [
      { ok_over: 0.1, weak_over: 1.5 }, // weak_over under its 2
      { ok_over: 0.4, weak_over: 2.2 }, // ok_over under its 0.5
      { ok_over: 2.5, weak_over: 3 }, // ok_over over its 2 (and would call 2.5 OK)
    ]) {
      await told({ v: 1, flags: {}, pc_class: outside });
      expect(routeEstimatesHere(request).pcClass, JSON.stringify(outside)).toBe("ok");
    }
    setPcCheckService(checkService(record({ rHat: 5 })));
    await told({ v: 1, flags: {}, pc_class: { ok_over: 0.5, weak_over: 9 } }); // weak_over over its 8: would call 5 OK
    expect(routeEstimatesHere(request).pcClass).toBe("weak");
    // an unordered pair is not used either
    setPcCheckService(checkService(record({ rHat: 2.5 })));
    await told({ v: 1, flags: {}, pc_class: { ok_over: 2, weak_over: 2 } });
    expect(routeEstimatesHere(request).pcClass).toBe("ok");
    await told({ v: 1, flags: {}, pc_class: { ok_over: 0.5, weak_over: 2 } });
    expect(routeEstimatesHere(request).pcClass).toBe("weak");
    // an answer without a pair puts the compiled one back
    await told({ v: 1, flags: {} });
    expect(routeEstimatesHere(request).pcClass).toBe("ok");
  });

  it("is not kept in a storage of this app's own: the pair is lane L2's, held in memory only", async () => {
    setPcCheckService(checkService(record({ rHat: 2.5 })));
    await told({ v: 1, flags: {}, pc_class: { ok_over: 0.5, weak_over: 2 } });
    const keys: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i) ?? "");
    } catch {
      /* no storage in this environment */
    }
    expect(keys.filter((key) => key.includes("pcClass"))).toEqual([]);
    expect(estimateDepsNow().cutoffs()).toEqual({ okOver: 0.5, weakOver: 2 });
  });
});

describe("the other real inputs", () => {
  const earlier: ExportCalibration = {
    workload,
    output: { width: 1920, height: 1080, fps: 30 },
    quality: "medium",
    engine: "file-sequence-v1",
    encoder: "x264-crf",
    revision: EXPORT_SPEED_REVISION,
    elapsedSeconds: 333,
    finalBytes: 40_000_000,
    memoryBytes: 800_000_000,
    temporaryBytes: 50_000_000,
  };

  it("reads this PC's earlier exports from the export store, and with the switch off still says what 0.27.0 said", () => {
    useExportJob.setState({ calibrations: [earlier] });
    const on = routeEstimatesHere(request).standard!;
    expect(on).toMatchObject({ basis: "history", seconds: 333 });
    __setExportFlag("estimate_v2", false);
    const off = routeEstimatesHere(request).standard!;
    expect(off).toMatchObject({ basis: "history", seconds: 333, low: 333, high: 333 });
    expect(routeEstimatesHere(request).quick).toBeNull();
  });

  it("prices the open timeline's own shape once the app has said how to read it, and without one says it could take much longer", () => {
    setOpenTimelineReader(null);
    expect(routeEstimatesHere(request).standard!.muchLonger).toBe(true);
    wire();
    __resetRouteEstimatesMemo();
    expect(routeEstimatesHere(request).standard!.muchLonger).toBe(false);
    setOpenTimelineReader(() => {
      throw new Error("the editor is gone");
    });
    __resetRouteEstimatesMemo();
    expect(() => routeEstimatesHere(request)).not.toThrow();
    expect(routeEstimatesHere(request).standard!.muchLonger).toBe(true);
  });

  it("gives the admission door the same inputs: the plan's engine and encoder, this PC's check and history", () => {
    setPcCheckService(checkService(record({ rHat: 1.5 })));
    const input = {
      workload,
      output: { width: 1920, height: 1080, fps: 30 },
      quality: "medium",
      engine: "file-sequence-v1" as const,
      encoder: "x264-crf" as const,
    };
    const door = admissionEstimateHere(input)!;
    expect(door.pcClass).toBe("ok");
    // the dialog and the door are one estimate: what the person was told before the click is what the export is admitted with
    expect(door.estimate).toEqual(routeEstimatesHere(request).standard);
    useExportJob.setState({ calibrations: [earlier] });
    expect(admissionEstimateHere(input)!.estimate.basis).toBe("history");
  });

  it("is the compiled switches before the server has said anything: every part of the new estimate is on", () => {
    const deps = estimateDepsNow();
    expect(deps.flags()).toMatchObject({ estimate_v2: true, pc_check: true });
    expect(deps.facts).toBeNull();
    expect(deps.recipeOf).toBeUndefined();
    expect(deps.speedRevision).toBe(EXPORT_SPEED_REVISION);
    expect(deps.build).toBe(__ARTDADDY_RELEASE__);
  });
});
