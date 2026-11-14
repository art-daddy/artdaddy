// The honest estimate of every way an export could run, as the Export dialog, the route decision and the admission door get it. Logic only: every input comes in as a dependency, so each test
// says what a PC, a project, a history or a failing part is and reads what the person would be told.
import { readFileSync } from "node:fs";

import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as estimator from "./estimator";
import {
  EXPORT_SPEED_REVISION,
  estimateExport,
  type ExportCalibration,
  type ExportEngine,
  type ExportMode,
  type ExportQuality,
  type ExportResolution,
} from "./exportOptions";
import type { ExportEncoder } from "./exportEncoder";
import type { RouteEstimatesRequest } from "./exportTypes3c";
import { emptyTimeline, type Clip, type Timeline } from "./model";
import { PACE_LOG_KEY, recordPace } from "./paceLog";
import type { PcCheckRecord, StorageLike } from "./pcClass";
import { summarizeRenderWorkload, type RenderWorkload } from "./renderPlan";
import {
  __resetRouteEstimatesMemo,
  admissionEstimate,
  estimatesForRoutes,
  type RouteEstimatesDeps,
} from "./routeEstimates";

const NOW = 1_800_000_000_000;

const clip = (id: string, from: number, to: number, extra: Partial<Clip> = {}): Clip => ({
  id,
  kind: "video",
  media_ref: `${id}.mp4`,
  source_in: 0,
  source_out: to - from,
  timeline_in: from,
  timeline_out: to,
  ...extra,
});

/** A project with one clip of `seconds` at the canvas size: what a plain talk looks like to the exporter. */
function project(seconds: number, canvas: [number, number, number] = [1920, 1080, 30]): Timeline {
  const raw = emptyTimeline(canvas[0], canvas[1], canvas[2]);
  raw.tracks = [{ id: "v1", kind: "video", z: 0, clips: [clip("a", 0, seconds * canvas[2])] }];
  return raw;
}

/** Two clips on top of each other for the whole length: another shape (two layers) from the same size and length. */
function layered(seconds: number): Timeline {
  const raw = project(seconds);
  raw.tracks = [
    raw.tracks[0],
    { id: "v2", kind: "video", z: 1, clips: [clip("b", 0, seconds * 30)] },
  ];
  return raw;
}

const memoryStore = () => {
  const map = new Map<string, string>();
  const store: StorageLike = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
  return { map, store };
};

const checked = (over: Partial<PcCheckRecord> = {}): PcCheckRecord => ({
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
  ...over,
});
const stuck: PcCheckRecord = {
  revision: 1,
  build: "artdaddy@test",
  atMs: NOW - 60_000,
  cores: 8,
  outcome: "unfinished",
  aFps: null,
  bFps: null,
  cFps: null,
  rHat: null,
  cls: "unfinished",
};

function world(timeline: Timeline | null = project(120), over: Partial<RouteEstimatesDeps> = {}) {
  const log = memoryStore();
  const deps: RouteEstimatesDeps = {
    flags: () => ({ estimate_v2: true, pc_check: true }),
    openTimeline: () => timeline,
    facts: null,
    recipeOf: undefined,
    speedCheck: () => null,
    cutoffs: () => undefined,
    cores: () => 8,
    history: () => [],
    storage: () => log.store,
    build: "artdaddy@test",
    speedRevision: EXPORT_SPEED_REVISION,
    now: () => NOW,
    ...over,
  };
  const request = (over: Partial<RouteEstimatesRequest> = {}): RouteEstimatesRequest => ({
    workload: summarizeRenderWorkload(timeline ?? project(120)),
    settings: { resolution: "source", quality: "medium", fps: null },
    explicit: { size: false, fps: false },
    chipMaker: null,
    ...over,
  });
  return { deps, request, log };
}

afterEach(() => {
  vi.restoreAllMocks();
  __resetRouteEstimatesMemo();
});

describe("the four ways, priced for what the person has chosen", () => {
  it("prices the processor's normal setting, its faster setting, the chip that passed and Quick, each as what it is", () => {
    const w = world(project(120), { speedCheck: () => checked() });
    const got = estimatesForRoutes(w.request({ chipMaker: "amd" }), w.deps);
    expect(got.pcClass).toBe("fast");
    expect(got.standard).toMatchObject({ basis: "pc_check", family: "processor" });
    expect(got.faster).toMatchObject({ basis: "pc_check", family: "processor" });
    expect(got.chip).toMatchObject({ basis: "pc_check", family: "chip" });
    expect(got.quick).not.toBeNull();
    // a plain project saves time on both quiet routes, and never costs more
    expect(got.faster!.seconds).toBeLessThan(got.standard!.seconds);
    expect(got.chip!.seconds).toBeLessThan(got.standard!.seconds);
    // at the picture's own size and rate, Quick with a chip to use is that chip's export
    expect(got.quick!.seconds).toBe(got.chip!.seconds);
    expect(got.quick!.family).toBe("chip");
  });

  it("has no chip estimate where no chip passed, and then Quick is the processor's faster setting", () => {
    const w = world(project(120), { speedCheck: () => checked() });
    const got = estimatesForRoutes(w.request(), w.deps);
    expect(got.chip).toBeNull();
    expect(got.quick!.seconds).toBe(got.faster!.seconds);
    expect(got.quick!.family).toBe("processor");
  });

  it("prices Quick's own, smaller picture and lower rate where they were not set, and leaves a size and a rate that were set alone", () => {
    const big = project(120, [3840, 2160, 60]);
    const w = world(big, { speedCheck: () => checked({ rHat: 1.5, cls: "ok" }) });
    const open = estimatesForRoutes(w.request(), w.deps);
    const set = estimatesForRoutes(w.request({ explicit: { size: true, fps: true } }), w.deps);
    // 4K at 60 frames a second against 1080p at 30: less to encode, but the reading and drawing of a 4K project is not made smaller by a smaller delivery,
    // so Quick is cheaper than the faster setting and nowhere near half of it
    expect(open.quick!.seconds).toBeLessThan(open.faster!.seconds);
    expect(open.quick!.seconds).toBeGreaterThan(open.faster!.seconds * 0.5);
    // with both set, Quick is only the faster setting: the same figure the faster setting has
    expect(set.quick!.seconds).toBe(set.faster!.seconds);
    // Quick is a label, so it never moves what the other ways cost
    expect(set.standard).toEqual(open.standard);
    expect(set.faster).toEqual(open.faster);
  });

  it("follows the person's own settings: a smaller delivered picture costs less, a higher quality tier more", () => {
    const w = world(project(120, [3840, 2160, 30]), { speedCheck: () => checked() });
    const source = estimatesForRoutes(w.request(), w.deps).standard!.seconds;
    const small = estimatesForRoutes(
      w.request({ settings: { resolution: "720p", quality: "medium", fps: null } }),
      w.deps,
    ).standard!.seconds;
    const high = estimatesForRoutes(
      w.request({ settings: { resolution: "source", quality: "high", fps: null } }),
      w.deps,
    ).standard!.seconds;
    expect(small).toBeLessThan(source);
    expect(high).toBeGreaterThanOrEqual(source);
  });

  it("says low <= seconds <= high in whole seconds, for every way", () => {
    const w = world(project(300), { speedCheck: () => checked() });
    const got = estimatesForRoutes(w.request({ chipMaker: "nvidia" }), w.deps);
    for (const estimate of [got.standard, got.faster, got.chip, got.quick]) {
      expect(estimate).not.toBeNull();
      expect(Number.isInteger(estimate!.seconds)).toBe(true);
      expect(estimate!.low).toBeLessThanOrEqual(estimate!.seconds);
      expect(estimate!.seconds).toBeLessThanOrEqual(estimate!.high);
    }
  });
});

describe("what the speed check says, and what it does not", () => {
  const classOf = (record: PcCheckRecord | null, over: Partial<RouteEstimatesDeps> = {}) => {
    const w = world(project(120), { speedCheck: () => record, ...over });
    return estimatesForRoutes(w.request(), w.deps);
  };

  it("reports this PC's class, and prices a PC that has not been checked on a rough guess", () => {
    expect(classOf(checked({ rHat: 0.5 })).pcClass).toBe("fast");
    expect(classOf(checked({ rHat: 2.5 })).pcClass).toBe("ok");
    expect(classOf(checked({ rHat: 6 })).pcClass).toBe("weak");
    expect(classOf(stuck).pcClass).toBe("unfinished");
    const unchecked = classOf(null);
    expect(unchecked.pcClass).toBe("unknown");
    expect(unchecked.standard!.basis).toBe("guess");
    expect(classOf(stuck).standard!.basis).toBe("guess");
    expect(classOf(checked()).standard!.basis).toBe("pc_check");
  });

  it("is told the cut-offs in force now: the same measurement is OK under the compiled pair and weak under a pair the server moved", () => {
    const record = checked({ rHat: 2.5 });
    expect(classOf(record).pcClass).toBe("ok");
    expect(classOf(record, { cutoffs: () => ({ okOver: 0.5, weakOver: 2 }) }).pcClass).toBe("weak");
    // outside the band: the compiled pair stands
    expect(classOf(record, { cutoffs: () => ({ okOver: 0.1, weakOver: 99 }) }).pcClass).toBe("ok");
  });

  it("with the switch off there is no class and no pace, whatever is stored", () => {
    const off = classOf(checked(), { flags: () => ({ estimate_v2: true, pc_check: false }) });
    expect(off.pcClass).toBe("unknown");
    expect(off.standard!.basis).toBe("guess");
  });

  it("a PC that could not finish is slower than one nobody checked, and both are a guess with a very wide range", () => {
    const unchecked = classOf(null).standard!;
    const slow = classOf(stuck).standard!;
    expect(slow.seconds).toBeGreaterThan(unchecked.seconds);
    expect(slow.high / slow.low).toBeGreaterThan(3);
  });

  it("a faster PC is told a smaller time than a slower one", () => {
    const fast = classOf(checked({ rHat: 0.4 })).standard!.seconds;
    const slow = classOf(checked({ rHat: 4, cls: "ok" })).standard!.seconds;
    expect(fast).toBeLessThan(slow);
  });
});

describe("history speaks first, and only for a project like it", () => {
  const sampleFor = (timeline: Timeline, seconds: number): ExportCalibration => {
    const workload = summarizeRenderWorkload(timeline);
    return {
      workload,
      output: { width: workload.width, height: workload.height, fps: workload.fps },
      quality: "medium",
      engine: "file-sequence-v1",
      encoder: "x264-crf",
      revision: EXPORT_SPEED_REVISION,
      elapsedSeconds: seconds,
      finalBytes: 52_000_000,
      memoryBytes: 900_000_000,
      temporaryBytes: 80_000_000,
    };
  };

  it("an earlier export of this shape is the estimate, from earlier exports, whatever the speed check says", () => {
    const earlier = sampleFor(project(120), 400);
    const w = world(project(120), { speedCheck: () => checked(), history: () => [earlier] });
    const got = estimatesForRoutes(w.request(), w.deps).standard!;
    expect(got.basis).toBe("history");
    expect(got.seconds).toBe(400);
    expect(got.bytes).toBe(52_000_000);
  });

  it("a project of another shape is not matched: it falls back to the speed check and is not thrown off by the other's time", () => {
    const earlier = sampleFor(project(120), 400);
    const w = world(layered(120), { speedCheck: () => checked(), history: () => [earlier] });
    const got = estimatesForRoutes(w.request(), w.deps).standard!;
    expect(got.basis).toBe("pc_check");
    const alone = world(layered(120), { speedCheck: () => checked() });
    expect(got).toEqual(estimatesForRoutes(alone.request(), alone.deps).standard);
  });

  it("an export from before the exporter changed speed is not matched either", () => {
    const old: ExportCalibration = {
      ...sampleFor(project(120), 400),
      revision: EXPORT_SPEED_REVISION - 1,
    };
    const w = world(project(120), { speedCheck: () => checked(), history: () => [old] });
    expect(estimatesForRoutes(w.request(), w.deps).standard!.basis).toBe("pc_check");
  });
});

describe("what the project asks of the exporter", () => {
  it("prices the project's own shape when the open timeline is the project being priced, and widens the range where it is not", () => {
    const timeline = project(120);
    const w = world(timeline, { speedCheck: () => checked() });
    const own = estimatesForRoutes(w.request(), w.deps).standard!;
    // the same figures for a request that does not describe the open timeline (a clip's own export, a section): no shape to price
    const other = estimatesForRoutes(
      w.request({ workload: { ...summarizeRenderWorkload(timeline), durationSeconds: 60 } }),
      w.deps,
    ).standard!;
    expect(own.muchLonger).toBe(false);
    expect(other.muchLonger).toBe(true);
    expect(other.high / other.seconds).toBeGreaterThan(own.high / own.seconds);
  });

  it("reads a timeline once for as long as it is the same one, and again when it changes", () => {
    let read = 0;
    let current = project(120);
    const w = world(current, {
      speedCheck: () => checked(),
      openTimeline: () => {
        read++;
        return current;
      },
    });
    const request = w.request();
    estimatesForRoutes(request, w.deps);
    const afterFirst = read;
    const first = estimatesForRoutes(request, w.deps);
    expect(read).toBe(afterFirst + 1);
    // the second call reused the first's reading: the answers agree
    expect(first.standard).toEqual(estimatesForRoutes(request, w.deps).standard);
    current = layered(120);
    const changed = estimatesForRoutes(w.request(), w.deps).standard!;
    expect(changed.seconds).toBeGreaterThan(first.standard!.seconds);
  });

  it("a project with no timeline open is priced without a shape, and says it could take much longer", () => {
    const w = world(null, { speedCheck: () => checked() });
    const got = estimatesForRoutes(
      w.request({ workload: summarizeRenderWorkload(project(120)) }),
      w.deps,
    );
    expect(got.standard!.muchLonger).toBe(true);
  });
});

describe("what this PC has learned", () => {
  const teach = (store: StorageLike, family: "processor" | "chip", ratio: number) => {
    for (let i = 0; i < 4; i++)
      recordPace(store, {
        family,
        runSeconds: 600,
        producedFraction: 0.5,
        predictedTotalSeconds: 1200 / ratio,
        outcome: "cancelled",
        speedRevision: EXPORT_SPEED_REVISION,
        build: "artdaddy@test",
        atMs: NOW - 1000 * (i + 1),
      });
  };

  it("moves the processor's estimate and never the chip's: a ratio learned on one encoder does not correct the other", () => {
    const w = world(project(120), { speedCheck: () => checked() });
    const before = estimatesForRoutes(w.request({ chipMaker: "amd" }), w.deps);
    teach(w.log.store, "processor", 1.4);
    const after = estimatesForRoutes(w.request({ chipMaker: "amd" }), w.deps);
    expect(after.standard!.seconds).toBeGreaterThan(before.standard!.seconds);
    expect(after.chip).toEqual(before.chip);
    // the range is the model's, not the log's
    expect(after.standard!.low).toBe(before.standard!.low);
    expect(after.standard!.high).toBe(before.standard!.high);
  });

  it("learns nothing when the estimate is 0.27.0's: with the new estimate off the log is not read", () => {
    const off = world(project(120), { flags: () => ({ estimate_v2: false, pc_check: true }) });
    const before = estimatesForRoutes(off.request(), off.deps).standard;
    teach(off.log.store, "processor", 3);
    expect(estimatesForRoutes(off.request(), off.deps).standard).toEqual(before);
  });

  it("a damaged log is no log", () => {
    const w = world(project(120), { speedCheck: () => checked() });
    const before = estimatesForRoutes(w.request(), w.deps).standard;
    w.log.map.set(PACE_LOG_KEY, "{not json");
    expect(estimatesForRoutes(w.request(), w.deps).standard).toEqual(before);
    w.deps.storage = () => {
      throw new Error("storage is off");
    };
    expect(estimatesForRoutes(w.request(), w.deps).standard).toEqual(before);
  });
});

describe("with the new estimate off it says what 0.27.0 said", () => {
  interface GoldenCase {
    id: string;
    call: "dialog" | "export";
    workload: string;
    settings: { resolution: ExportResolution; quality: ExportQuality; fps: number | null };
    route: { mode: ExportMode; chip: "amd" | "nvidia" | "intel" | null; faster: boolean };
    engine: ExportEngine;
    output: [number, number, number];
    encoder: ExportEncoder;
    history: number[];
    expected: { seconds: number | null; guessed: boolean; finalBytes: number | null };
  }
  interface GoldenSample {
    workload: string | RenderWorkload;
    output: [number, number, number];
    quality: string;
    engine: ExportEngine;
    encoder?: ExportEncoder;
    revisionRel: "current" | "older" | "newer" | "absent";
    elapsedSeconds: number;
    finalBytes: number;
    memoryBytes: number | null;
    temporaryBytes: number | null;
  }
  const golden = JSON.parse(
    readFileSync("src/timeline/__fixtures__/estimateLegacy.golden.json", "utf8"),
  ) as { workloads: Record<string, RenderWorkload>; samples: GoldenSample[]; cases: GoldenCase[] };

  const calibrationOf = (sample: GoldenSample): ExportCalibration => {
    const revision = {
      current: EXPORT_SPEED_REVISION,
      older: EXPORT_SPEED_REVISION - 1,
      newer: EXPORT_SPEED_REVISION + 1,
      absent: undefined,
    }[sample.revisionRel];
    return {
      workload:
        typeof sample.workload === "string" ? golden.workloads[sample.workload] : sample.workload,
      output: { width: sample.output[0], height: sample.output[1], fps: sample.output[2] },
      quality: sample.quality,
      engine: sample.engine,
      ...(sample.encoder === undefined ? {} : { encoder: sample.encoder }),
      ...(revision === undefined ? {} : { revision }),
      elapsedSeconds: sample.elapsedSeconds,
      finalBytes: sample.finalBytes,
      memoryBytes: sample.memoryBytes,
      temporaryBytes: sample.temporaryBytes,
    };
  };

  const off = { estimate_v2: false, pc_check: true };

  it("gives 0.27.0's seconds, size and basis for every dialog case of the golden, for the way the dialog would show, and nothing for Quick", () => {
    const dialog = golden.cases.filter((entry) => entry.call === "dialog");
    expect(dialog.length).toBeGreaterThan(100);
    const wrong: string[] = [];
    for (const entry of dialog) {
      const history = entry.history.map((index) => calibrationOf(golden.samples[index]));
      // what 0.27.0's dialog showed: the chip's figure when Fast was chosen and a chip named, else the faster setting's or the normal one's
      const chipUsed = entry.route.mode === "fast" ? entry.route.chip : null;
      const way = chipUsed ? "chip" : entry.route.faster ? "faster" : "standard";
      const w = world(null, {
        flags: () => off,
        history: () => history,
        // everything the new model reads is present and must not move a number
        speedCheck: () => checked({ rHat: 7, cls: "weak" }),
      });
      const got = estimatesForRoutes(
        {
          workload: golden.workloads[entry.workload],
          settings: entry.settings,
          explicit: { size: false, fps: false },
          chipMaker: entry.route.chip,
        },
        w.deps,
      );
      const said = got[way];
      const wanted = entry.expected;
      const ok =
        wanted.seconds === null
          ? said === null
          : said !== null &&
            said.seconds === Math.max(1, wanted.seconds) &&
            said.low === said.seconds &&
            said.high === said.seconds &&
            (said.basis === "guess") === wanted.guessed &&
            said.bytes === wanted.finalBytes;
      if (!ok || got.quick !== null) wrong.push(entry.id);
    }
    expect(wrong).toEqual([]);
  });

  it("the admission door gives the number estimateExport gives for every export case of the golden", () => {
    const wrong: string[] = [];
    const cases = golden.cases.filter((entry) => entry.call === "export");
    expect(cases.length).toBeGreaterThan(30);
    for (const entry of cases) {
      const history = entry.history.map((index) => calibrationOf(golden.samples[index]));
      const w = world(null, { flags: () => off, history: () => history });
      const workload = golden.workloads[entry.workload];
      const got = admissionEstimate(
        {
          workload,
          output: { width: entry.output[0], height: entry.output[1], fps: entry.output[2] },
          quality: entry.settings.quality,
          engine: entry.engine,
          encoder: entry.encoder,
        },
        w.deps,
      );
      const legacy = estimateExport(
        workload,
        { width: entry.output[0], height: entry.output[1], fps: entry.output[2] },
        entry.settings.quality,
        entry.engine,
        history,
        entry.encoder,
      );
      const same =
        legacy.seconds === null
          ? got === null
          : got !== null && got.estimate.seconds === Math.max(1, legacy.seconds);
      if (!same) wrong.push(entry.id);
    }
    expect(wrong).toEqual([]);
  });
});

describe("the estimate of an export as the plan fixed it", () => {
  const talk = project(240);
  const base = (over: Partial<Parameters<typeof admissionEstimate>[0]> = {}) => ({
    workload: summarizeRenderWorkload(talk),
    output: { width: 1920, height: 1080, fps: 30 },
    quality: "medium",
    engine: "file-sequence-v1" as const,
    encoder: "x264-crf" as const,
    ...over,
  });
  const here = () => world(talk, { speedCheck: () => checked({ rHat: 1.5, cls: "ok" }) });

  it("is slower at a gentler rung and on the streamed engine, faster on the chip and the faster setting", () => {
    const w = here();
    const normal = admissionEstimate(base(), w.deps)!;
    const gentle = admissionEstimate(base({ rung: 2 }), w.deps)!;
    const streamed = admissionEstimate(base({ engine: "partition-pipes-v1" }), w.deps)!;
    const faster = admissionEstimate(base({ encoder: "x264-fast" }), w.deps)!;
    const chip = admissionEstimate(base({ encoder: "chip-amd" }), w.deps)!;
    expect(gentle.estimate.seconds).toBeGreaterThan(normal.estimate.seconds);
    expect(streamed.estimate.seconds).toBeGreaterThan(normal.estimate.seconds);
    expect(faster.estimate.seconds).toBeLessThan(normal.estimate.seconds);
    expect(chip.estimate.seconds).toBeLessThan(normal.estimate.seconds);
    expect(normal.family).toBe("processor");
    expect(chip.family).toBe("chip");
    expect(normal.pcClass).toBe("ok");
  });

  it("keeps the model's own figure beside the one it shows, so what is learned is learned against the model and not against itself", () => {
    const w = here();
    const none = admissionEstimate(base(), w.deps)!;
    expect(none.uncorrected).toEqual(none.estimate);
    for (let i = 0; i < 4; i++)
      recordPace(w.log.store, {
        family: "processor",
        runSeconds: 900,
        producedFraction: 0.5,
        predictedTotalSeconds: 600,
        outcome: "failed",
        speedRevision: EXPORT_SPEED_REVISION,
        build: "artdaddy@test",
        atMs: NOW - 1000 * (i + 1),
      });
    const taught = admissionEstimate(base(), w.deps)!;
    expect(taught.estimate.seconds).toBeGreaterThan(none.estimate.seconds);
    expect(taught.uncorrected).toEqual(none.estimate);
  });

  it("is no estimate for what cannot be priced, and never throws", () => {
    const w = here();
    expect(
      admissionEstimate(base({ workload: { ...base().workload, width: 0 } }), w.deps),
    ).toBeNull();
    expect(
      admissionEstimate(
        base({ workload: { ...base().workload, durationSeconds: Number.NaN } }),
        w.deps,
      ),
    ).toBeNull();
    expect(admissionEstimate(null as never, w.deps)).toBeNull();
    expect(admissionEstimate({} as never, w.deps)).toBeNull();
  });
});

describe("it fails soft: a part that cannot be read leaves it saying less, never refusing", () => {
  const broken = (what: keyof RouteEstimatesDeps): Partial<RouteEstimatesDeps> => ({
    [what]: () => {
      throw new Error(`${what} broke`);
    },
  });

  it("survives every dependency throwing, one at a time and all at once", () => {
    const parts = [
      "flags",
      "openTimeline",
      "speedCheck",
      "cutoffs",
      "cores",
      "history",
      "storage",
      "now",
    ] as const;
    for (const part of parts) {
      const w = world(project(120), { speedCheck: () => checked(), ...broken(part) });
      let got!: ReturnType<typeof estimatesForRoutes>;
      expect(
        () => (got = estimatesForRoutes(w.request({ chipMaker: "amd" }), w.deps)),
        part,
      ).not.toThrow();
      expect(got, part).toBeDefined();
    }
    const all = Object.fromEntries(
      parts.map((part) => [part, broken(part)[part]]),
    ) as Partial<RouteEstimatesDeps>;
    const w = world(project(120), all);
    expect(() => estimatesForRoutes(w.request(), w.deps)).not.toThrow();
  });

  it("a flags reader that fails is the new estimate off: 0.27.0's numbers", () => {
    const w = world(project(120), broken("flags"));
    const got = estimatesForRoutes(w.request(), w.deps);
    expect(got.standard).not.toBeNull();
    expect(got.quick).toBeNull();
    expect(got.standard!.low).toBe(got.standard!.high);
  });

  it("a source facts reader that fails prices the sources as unknown and widens the range upward, never down", () => {
    const timeline = project(120);
    const known = world(timeline, { speedCheck: () => checked() });
    const failing = world(timeline, {
      speedCheck: () => checked(),
      facts: () => {
        throw new Error("the probe failed");
      },
    });
    const a = estimatesForRoutes(known.request(), known.deps).standard!;
    const b = estimatesForRoutes(failing.request(), failing.deps).standard!;
    expect(b.high).toBeGreaterThanOrEqual(a.high);
    expect(b.low).toBeLessThanOrEqual(a.seconds);
  });

  it("an estimator that throws is no estimate for that way, not a failure", () => {
    const w = world(project(120), { speedCheck: () => checked() });
    vi.spyOn(estimator, "estimate").mockImplementation(() => {
      throw new Error("the model broke");
    });
    const got = estimatesForRoutes(w.request({ chipMaker: "amd" }), w.deps);
    expect(got.standard).toBeNull();
    expect(got.quick).toBeNull();
    expect(got.chip).toBeNull();
    expect(got.faster).toBeNull();
    expect(
      admissionEstimate(
        {
          workload: w.request().workload,
          output: { width: 1920, height: 1080, fps: 30 },
          quality: "medium",
          engine: "file-sequence-v1",
          encoder: "x264-crf",
        },
        w.deps,
      ),
    ).toBeNull();
  });

  it("gives no estimate for a workload that is not one, in either direction", () => {
    const w = world(project(120), { speedCheck: () => checked() });
    const real = w.request().workload;
    for (const workload of [
      { ...real, width: Number.NaN },
      { ...real, height: -1080 },
      { ...real, fps: 0 },
      { ...real, durationSeconds: Number.POSITIVE_INFINITY },
      { ...real, durationSeconds: 0 },
      {} as RenderWorkload,
    ]) {
      const got = estimatesForRoutes(w.request({ workload }), w.deps);
      expect(got.standard, JSON.stringify(workload)).toBeNull();
      expect(got.quick).toBeNull();
    }
    for (const request of [
      null,
      undefined,
      7,
      "x",
      [],
      {},
      { workload: null },
      { workload: {}, settings: null },
    ])
      expect(estimatesForRoutes(request as never, w.deps)).toEqual({
        pcClass: "unknown",
        standard: null,
        quick: null,
        chip: null,
        faster: null,
      });
  });

  it("whatever it is asked it answers with whole, ordered, non-negative seconds or nothing (property)", () => {
    const w = world(project(90), { speedCheck: () => checked() });
    const number = fc.oneof(
      fc.integer({ min: -5, max: 5000 }),
      fc.double({ noNaN: false }),
      fc.constant(Number.NaN),
      fc.constant(Number.POSITIVE_INFINITY),
    );
    fc.assert(
      fc.property(
        number,
        number,
        number,
        number,
        fc.constantFrom("source", "2160p", "1080p", "720p", "480p", "nonsense"),
        fc.constantFrom("high", "medium", "low", "nonsense"),
        fc.oneof(number, fc.constant(null)),
        (width, height, fps, durationSeconds, resolution, quality, rate) => {
          const real = w.request().workload;
          const got = estimatesForRoutes(
            {
              workload: { ...real, width, height, fps, durationSeconds },
              settings: {
                resolution: resolution as never,
                quality: quality as never,
                fps: rate as never,
              },
              explicit: { size: false, fps: false },
              chipMaker: "amd",
            },
            w.deps,
          );
          for (const estimate of [got.standard, got.faster, got.chip, got.quick]) {
            if (estimate === null) continue;
            expect(Number.isInteger(estimate.seconds) && estimate.seconds >= 1).toBe(true);
            expect(estimate.low).toBeLessThanOrEqual(estimate.seconds);
            expect(estimate.seconds).toBeLessThanOrEqual(estimate.high);
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
