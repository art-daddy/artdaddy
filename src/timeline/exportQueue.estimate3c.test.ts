// What the queue does with the honest estimate: the number the export is admitted with (kept on its record for the card and the assistant, with the range and where it came from), the hard warning that reads the low end,
// what is noted locally about the export, and what the estimate learns when the run ends (finished, failed or cancelled; never from a hang). Each journey plays the real queue with the job double.
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { __setExportConfirmationForTests } from "../lib/confirm";
import * as host from "../platform/host";
import { createPcCheckService } from "../platform/pcCheck";
import { useAuth } from "../store/auth";
import { useExportJob } from "../store/exportJob";
import { __resetJobNotes } from "../store/jobNotes";
import { __resetExportQuestions } from "../store/exportQuestionHost";
import { FakeJobs } from "../test/fakeJobs";
import { resetTestDocuments } from "../test/timelineKit";
import { __resetProjectJobs } from "../tools/genJobs";
import { joinPath, ProjectStoreAccess, type DirEntry, type FsLike } from "../tools/store";
import { admissionEstimateHere, setOpenTimelineReader } from "./estimateDeps";
import * as estimator from "./estimator";
import { attempts } from "./exportAttempts";
import {
  __resetExportQueue,
  cancelExport,
  clearFinishedExports,
  dismissExport,
  listExportRecords,
  localDeliveryPort,
  submitExport as submitWithDependencies,
  whenExportTelemetrySettles,
  whenExportsSettle,
  type ExportSpec,
} from "./exportQueue";
import {
  EXPORT_SPEED_REVISION,
  LONG_EXPORT_SECONDS,
  estimateExport,
  expectationOf,
  type ExportCalibration,
} from "./exportOptions";
import { __resetFacts3c, factsForReport, factsOf3c } from "./exportFacts3c";
import { formatActivityMark } from "./exportActivity";
import { PACE_LOG_KEY } from "./paceLog";
import { setPcCheckService } from "./pcCheckHandle";
import { writePcCheck, type PcCheckRecord, type StorageLike } from "./pcClass";
import { describeEstimateLine } from "./estimateWords";
import type { RenderWorkload } from "./renderPlan";
import { __resetRouteEstimatesMemo, type AdmissionInput } from "./routeEstimates";

const exportBeacon = vi.hoisted(() => vi.fn(async (_event: unknown) => undefined));
vi.mock("../api/exportEvents", () => ({ reportExport: exportBeacon }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const DIR = "C:/proj";
const DEST = "C:/out/final.mp4";
const STAGE = `${DEST}.part-x`;
const AGENT = { chatSessionId: "t1", branchId: 0, executionId: 1 };
const GB = 1e9;

class Fs implements FsLike {
  files = new Map<string, string>();
  bytes = new Map<string, Uint8Array>();
  async exists(p: string): Promise<boolean> {
    const n = joinPath(p);
    return this.files.has(n) || this.bytes.has(n);
  }
  async readTextFile(p: string): Promise<string> {
    const v = this.files.get(joinPath(p));
    if (v === undefined) throw new Error("ENOENT");
    return v;
  }
  async writeTextFile(p: string, c: string): Promise<void> {
    this.files.set(joinPath(p), c);
  }
  async readBytes(p: string): Promise<Uint8Array> {
    const v = this.bytes.get(joinPath(p));
    if (!v) throw new Error("ENOENT");
    return v;
  }
  async writeBytes(p: string, b: Uint8Array): Promise<void> {
    this.bytes.set(joinPath(p), b);
  }
  async probeMedia(p: string, headBytes: number) {
    const bytes = await this.readBytes(p);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return {
      id12: sha256.slice(0, 12),
      sha256,
      size: bytes.length,
      head: bytes.slice(0, headBytes),
    };
  }
  async readDir(): Promise<DirEntry[]> {
    return [];
  }
  async mkdir(): Promise<void> {}
  async remove(p: string): Promise<void> {
    const n = joinPath(p);
    this.files.delete(n);
    this.bytes.delete(n);
  }
  async rename(from: string, to: string): Promise<void> {
    const f = joinPath(from);
    const t = joinPath(to);
    if (this.bytes.has(f)) {
      this.bytes.set(t, this.bytes.get(f)!);
      this.bytes.delete(f);
    } else if (this.files.has(f)) {
      this.files.set(t, this.files.get(f)!);
      this.files.delete(f);
    } else throw new Error("ENOENT");
  }
}

const WORKLOAD: RenderWorkload = {
  width: 1920,
  height: 1080,
  fps: 30,
  durationSeconds: 240,
  visualClips: 6,
  captionClips: 1,
  audioClips: 1,
  peakVisualLayers: 2,
  peakMediaLayers: 2,
};
const descriptorOf = (over: Record<string, unknown> = {}) => ({
  workload: WORKLOAD,
  output: { width: 1920, height: 1080, fps: 30 },
  quality: "medium",
  engine: "file-sequence-v1" as const,
  encoder: "x264-crf" as const,
  revision: EXPORT_SPEED_REVISION,
  ...over,
});
const metaOf = (over: Record<string, unknown> = {}) => ({
  duration_s: 240,
  width: 1920,
  height: 1080,
  fps: 30,
  quality: "medium",
  project_id: "",
  calibration: descriptorOf(),
  ...over,
});
const block = (frame: number, outMs: number) =>
  `frame=${frame}\nfps=30\nout_time_us=${outMs * 1000}\nspeed=1.0x\nprogress=continue\n`;

const checkRecord = (over: Partial<PcCheckRecord> = {}): PcCheckRecord => ({
  revision: 1,
  build: "artdaddy@test",
  atMs: Date.now(),
  cores: 8,
  outcome: "done",
  aFps: 90,
  bFps: 12,
  cFps: 40,
  rHat: 2.5,
  cls: "ok",
  ...over,
});
/** The real PC check service holding a stored check: what the app has after the check has run. */
function checked(record: PcCheckRecord) {
  const map = new Map<string, string>();
  const storage: StorageLike = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
  const service = createPcCheckService({
    now: () => Date.now(),
    storage,
    build: "artdaddy@test",
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
  service.registerProbe({
    id: "export-speed",
    revision: 1,
    ttlMs: 30 * 86_400_000,
    budgetMs: 20_000,
    definesClass: true,
    run: () => new Promise(() => undefined),
  });
  writePcCheck(storage, "export-speed", record);
  setPcCheckService(service);
}

let executionSeconds = 28_800;
function resources() {
  vi.spyOn(host, "resolveExportResources").mockResolvedValue({
    total_memory_bytes: 16 * GB,
    available_memory_bytes: 12 * GB,
    scratch_free_bytes: 500 * GB,
    destination_free_bytes: 500 * GB,
    local_fast_candidate: false,
    budgets: { memoryBytes: 8 * GB, temporaryBytes: 18 * GB, executionSeconds },
  });
}

async function fresh() {
  const fs = new Fs();
  const store = new ProjectStoreAccess(DIR, fs);
  await whenExportTelemetrySettles();
  exportBeacon.mockClear();
  executionSeconds = 28_800;
  resources();
  __setExportConfirmationForTests(async () => "continue");
  useExportJob.setState({ calibrations: [], live: null, finishing: {} });
  setOpenTimelineReader(null);
  __resetRouteEstimatesMemo();
  return { fs, store, jobs: new FakeJobs() };
}

const paceEntries = (): Any[] => {
  try {
    return JSON.parse(localStorage.getItem(PACE_LOG_KEY) ?? "[]");
  } catch {
    return [];
  }
};

beforeEach(() => {
  try {
    localStorage.removeItem(PACE_LOG_KEY);
  } catch {
    /* none */
  }
  __resetFacts3c();
});
afterEach(async () => {
  vi.useRealTimers();
  __resetExportQueue();
  __resetExportQuestions();
  __resetJobNotes();
  __resetProjectJobs();
  await resetTestDocuments();
  vi.restoreAllMocks();
  setPcCheckService(null);
  setOpenTimelineReader(null);
  __resetExportFlags();
  __resetFacts3c();
  __resetRouteEstimatesMemo();
  useExportJob.setState({ calibrations: [] });
  useAuth.setState({ profile: null });
  try {
    localStorage.removeItem(PACE_LOG_KEY);
  } catch {
    /* none */
  }
});

const described = (store: ProjectStoreAccess, over: Record<string, unknown> = {}) =>
  ({
    store,
    dependencies: [],
    destPath: DEST,
    stagePath: STAGE,
    filename: "film.mp4",
    workload: WORKLOAD,
    meta: metaOf(),
    run: async () => ({}),
    ...over,
  }) as ExportSpec;
const quickRun = (fs: Fs) => async () => {
  await fs.writeBytes(STAGE, new Uint8Array([1]));
  return {};
};

const earlier = (over: Partial<ExportCalibration> = {}): ExportCalibration => ({
  ...descriptorOf(),
  elapsedSeconds: 400,
  finalBytes: 90_000_000,
  memoryBytes: 1 * GB,
  temporaryBytes: 100_000_000,
  ...over,
});

describe("the estimate an export is admitted with", () => {
  it("is kept on its record with its range and where it came from, and the central number is the one every reader of `expected` sees", async () => {
    const { fs, store } = await fresh();
    const sub = await submitWithDependencies(described(store, { run: quickRun(fs) }));
    const record = listExportRecords().find((r) => r.job_id === sub.job_id) as Any;
    expect(record.estimate).toBeDefined();
    expect(record.estimate.basis).toBe("guess");
    expect(record.estimate.low).toBeLessThanOrEqual(record.estimate.seconds);
    expect(record.estimate.seconds).toBeLessThanOrEqual(record.estimate.high);
    expect(record.expected.seconds).toBe(record.estimate.seconds);
    expect(sub.expected?.seconds).toBe(record.estimate.seconds);
    // nothing earlier measured it, so the old readers say it is a guess
    expect(record.expected.guessed).toBe(true);
    expect(record.expected.finalBytes).toBeNull();
    await whenExportsSettle();
  });

  it("from a PC that was checked: said as a check, not as earlier exports, and the class goes with it", async () => {
    const { fs, store } = await fresh();
    checked(checkRecord({ rHat: 6, cls: "weak" }));
    const sub = await submitWithDependencies(described(store, { run: quickRun(fs) }));
    const record = listExportRecords().find((r) => r.job_id === sub.job_id) as Any;
    expect(record.estimate.basis).toBe("pc_check");
    expect(record.estimateClass).toBe("weak");
    expect(describeEstimateLine(record.estimate, record.estimateClass)).toMatch(
      /from a quick check of this PC's speed\.$/,
    );
    // an old reader must not be told it came from earlier exports
    expect(record.expected.guessed).toBe(true);
    await whenExportsSettle();
  });

  it("from earlier exports: a measurement, with the size, as 0.27.0 gave it", async () => {
    const { fs, store } = await fresh();
    useExportJob.setState({ calibrations: [earlier()] });
    const sub = await submitWithDependencies(described(store, { run: quickRun(fs) }));
    const record = listExportRecords().find((r) => r.job_id === sub.job_id) as Any;
    expect(record.estimate.basis).toBe("history");
    expect(record.expected).toEqual({ seconds: 400, guessed: false, finalBytes: 90_000_000 });
    await whenExportsSettle();
  });

  it("is the same estimate the Export dialog showed before the click: one number, from one place", async () => {
    const { fs, store } = await fresh();
    checked(checkRecord({ rHat: 1.5 }));
    const door = admissionEstimateHere({
      workload: WORKLOAD,
      output: { width: 1920, height: 1080, fps: 30 },
      quality: "medium",
      engine: "file-sequence-v1",
      encoder: "x264-crf",
    })!;
    const sub = await submitWithDependencies(described(store, { run: quickRun(fs) }));
    const record = listExportRecords().find((r) => r.job_id === sub.job_id) as Any;
    expect(record.estimate).toEqual(door.estimate);
    await whenExportsSettle();
  });

  it("is 0.27.0's own number, and nothing richer, with the new estimate off", async () => {
    __setExportFlag("estimate_v2", false);
    const { fs, store } = await fresh();
    const calibrations = [earlier({ elapsedSeconds: 333 })];
    useExportJob.setState({ calibrations });
    const history = await submitWithDependencies(described(store, { run: quickRun(fs) }));
    await whenExportsSettle();
    const historical = listExportRecords().find((r) => r.job_id === history.job_id) as Any;
    expect(historical).not.toHaveProperty("estimate");
    expect(historical.expected).toEqual(
      expectationOf(
        estimateExport(
          WORKLOAD,
          descriptorOf().output,
          "medium",
          "file-sequence-v1",
          calibrations,
          "x264-crf",
        ),
      ),
    );
    useExportJob.setState({ calibrations: [] });
    const second = `${DEST}.2.mp4`;
    const guessed = await submitWithDependencies(
      described(store, {
        destPath: second,
        stagePath: `${second}.part`,
        filename: "two.mp4",
        run: async () => ({}),
      }),
    );
    await whenExportsSettle();
    const guess = listExportRecords().find((r) => r.job_id === guessed.job_id) as Any;
    expect(guess).not.toHaveProperty("estimate");
    expect(guess.expected).toEqual(
      expectationOf(
        estimateExport(
          WORKLOAD,
          descriptorOf().output,
          "medium",
          "file-sequence-v1",
          [],
          "x264-crf",
        ),
      ),
    );
  });

  it("is no estimate, and the export still starts and ends done, for a project the estimate cannot read", async () => {
    const { fs, store } = await fresh();
    const broken = { ...WORKLOAD, durationSeconds: Number.NaN };
    const sub = await submitWithDependencies(
      described(store, {
        workload: broken,
        meta: metaOf({ calibration: descriptorOf({ workload: broken }) }),
        run: quickRun(fs),
      }),
    );
    expect(sub).not.toHaveProperty("expected");
    await whenExportsSettle();
    const record = listExportRecords().find((r) => r.job_id === sub.job_id) as Any;
    expect(record.state).toBe("done");
    expect(record).not.toHaveProperty("expected");
    expect(record).not.toHaveProperty("estimate");
  });

  it("never stops the export it describes when the estimator throws: no number, and the export ends done", async () => {
    const { fs, store } = await fresh();
    vi.spyOn(estimator, "estimate").mockImplementation(() => {
      throw new Error("the model broke");
    });
    const sub = await submitWithDependencies(described(store, { run: quickRun(fs) }));
    await whenExportsSettle();
    const record = listExportRecords().find((r) => r.job_id === sub.job_id) as Any;
    expect(record.state).toBe("done");
    expect(record).not.toHaveProperty("estimate");
    expect(record).not.toHaveProperty("expected");
  });
});

describe("a pessimistic estimate does not stop an export that 0.27.0 let through", () => {
  /** An execution limit that sits between the estimate's low end and its central value: the central value alone would block the export. */
  function limitBetween() {
    const door = admissionEstimateHere({
      workload: WORKLOAD,
      output: { width: 1920, height: 1080, fps: 30 },
      quality: "medium",
      engine: "file-sequence-v1",
      encoder: "x264-crf",
    })!;
    return { door, limit: Math.floor((door.estimate.low + door.estimate.seconds) / 2) };
  }

  it("starts without a question when only the central time is over the execution limit", async () => {
    const { fs, store } = await fresh();
    const { door, limit } = limitBetween();
    expect(door.estimate.low).toBeLessThan(limit);
    expect(limit).toBeLessThan(door.estimate.seconds);
    executionSeconds = limit;
    resources();
    const asked = vi.fn(async () => "cancel" as const);
    __setExportConfirmationForTests(asked);
    const sub = await submitWithDependencies(described(store, { run: quickRun(fs) }));
    await whenExportsSettle();
    expect(asked).not.toHaveBeenCalled();
    expect((listExportRecords().find((r) => r.job_id === sub.job_id) as Any).state).toBe("done");
  });

  it("asks before the start when even the low end is over the limit, as a known problem", async () => {
    const { store } = await fresh();
    const { door } = limitBetween();
    executionSeconds = door.estimate.low - 1;
    resources();
    const asked = vi.fn(async () => "cancel" as const);
    __setExportConfirmationForTests(asked);
    await expect(submitWithDependencies(described(store))).rejects.toThrow(
      /cancelled before submission/,
    );
    expect(asked).toHaveBeenCalledTimes(1);
    expect(listExportRecords()).toHaveLength(0);
  });

  it("with the new estimate off the limit is read as 0.27.0 read it: from the one number", async () => {
    __setExportFlag("estimate_v2", false);
    const { store } = await fresh();
    const legacy = estimateExport(
      WORKLOAD,
      descriptorOf().output,
      "medium",
      "file-sequence-v1",
      [],
      "x264-crf",
    ).seconds!;
    executionSeconds = legacy - 1;
    resources();
    const asked = vi.fn(async () => "cancel" as const);
    __setExportConfirmationForTests(asked);
    await expect(submitWithDependencies(described(store))).rejects.toThrow(
      /cancelled before submission/,
    );
    expect(asked).toHaveBeenCalledTimes(1);
  });
});

describe("an export the app starts again by itself is never asked about its time", () => {
  const OUTPUT = { width: 1920, height: 1080, fps: 30 };
  const inputAt = (rung: 0 | 1): AdmissionInput => ({
    workload: WORKLOAD,
    output: OUTPUT,
    quality: "medium",
    engine: "file-sequence-v1",
    encoder: "x264-crf",
    ...(rung ? { rung } : {}),
  });
  const pricedAt = (rHat: number, rung: 0 | 1): number =>
    admissionEstimateHere(inputAt(rung), {
      speedCheck: () => checkRecord({ rHat }),
      cores: () => 8,
    })!.estimate.seconds;
  /** The speed of a PC (its `rHat`) at which the honest estimate of the export, at this rung, is `target` seconds. */
  function rHatFor(rung: 0 | 1, target: number): number {
    let low = 0.05;
    let high = 900;
    for (let step = 0; step < 60; step++) {
      const middle = (low + high) / 2;
      if (pricedAt(middle, rung) < target) low = middle;
      else high = middle;
    }
    return high;
  }
  /** A PC on which the export at its normal setting is not a long one and, a rung gentler, is: the honest estimate prices the gentler setting, 0.27.0's guess priced both alike. */
  function slowerAfterARung(): number {
    const rHat = rHatFor(1, 1.25 * LONG_EXPORT_SECONDS);
    expect(pricedAt(rHat, 0), "the export itself is not a long one").toBeLessThan(
      LONG_EXPORT_SECONDS,
    );
    expect(pricedAt(rHat, 1), "the gentler setting is").toBeGreaterThanOrEqual(LONG_EXPORT_SECONDS);
    const guess = estimateExport(WORKLOAD, OUTPUT, "medium", "file-sequence-v1", [], "x264-crf");
    expect(guess.seconds, "0.27.0 priced both attempts alike, under the line").toBeLessThan(
      LONG_EXPORT_SECONDS,
    );
    return rHat;
  }
  const RESTARTS = {
    memory: {
      calibration: () => descriptorOf({ rung: 1 }),
      meta: { reason: "memory_short", restarted: "gentler_setting", failedRung: 0 },
    },
    // the chip failed and the export goes on the processor: the same rung, a slower encoder
    chip: {
      calibration: () => descriptorOf(),
      meta: { reason: "chip_failed", restarted: "processor", failedRung: 0 },
    },
  } as const;
  const VIAS = ["menu", "chat", "mcp", "other"] as const;
  /** The request an automatic restart makes: the attempt it continues is a failed one the chain has already registered as waiting. */
  const restarting = (
    store: ProjectStoreAccess,
    kind: keyof typeof RESTARTS,
    via: (typeof VIAS)[number],
    over: Record<string, unknown> = {},
  ) => {
    attempts.begin("first-attempt");
    expect(attempts.registerPending("first-attempt", "auto")).toBe(true);
    return described(store, {
      ...(via === "other" ? {} : { via }),
      meta: metaOf({ calibration: RESTARTS[kind].calibration() }),
      restart: { kind: "auto", from: "first-attempt", meta: RESTARTS[kind].meta },
      ...over,
    });
  };

  describe.each(Object.keys(RESTARTS) as (keyof typeof RESTARTS)[])(
    "the restart after a %s failure",
    (kind) => {
      it.each(VIAS)(
        "via %s: starts, and finishes, though the honest estimate of the new attempt is a long one",
        async (via) => {
          const { fs, store } = await fresh();
          checked(
            checkRecord({
              rHat: kind === "memory" ? slowerAfterARung() : rHatFor(0, 1.25 * LONG_EXPORT_SECONDS),
            }),
          );
          const asked = vi.fn(async (_message: string, _warning: boolean) => "cancel" as const);
          __setExportConfirmationForTests(asked);
          const submitted = submitWithDependencies(
            restarting(store, kind, via, { run: quickRun(fs) }),
          );
          await expect(
            submitted,
            "an export the app starts again is not refused",
          ).resolves.toMatchObject({ job_id: expect.any(String) });
          const sub = await submitted;
          await whenExportsSettle();
          expect(asked, "nobody is asked").not.toHaveBeenCalled();
          const record = listExportRecords().find((r) => r.job_id === sub.job_id) as Any;
          expect(record).toMatchObject({
            state: "done",
            attempt: 2,
            restarted: RESTARTS[kind].meta.restarted,
          });
          // the card and the assistant still say what this attempt costs, honestly, though nobody was asked about it
          expect(record.estimate.seconds).toBeGreaterThanOrEqual(LONG_EXPORT_SECONDS);
          expect(record.expected.seconds).toBe(record.estimate.seconds);
        },
      );
    },
  );

  describe("the others are asked, as they were", () => {
    /** The first attempt asks for a long export, and so does a person's Try again or Switch: the honest estimate speaks to a person who can answer. */
    const CASES = {
      "a first attempt": () => ({ rung: 0 as const, over: {} }),
      "a person's Try again": () => ({
        rung: 1 as const,
        over: { retry: { from: 0, to: 1 } },
      }),
      "a person's Switch": () => {
        attempts.begin("first-attempt");
        return {
          rung: 1 as const,
          over: {
            restart: { kind: "switch", from: "first-attempt", meta: { restarted: "quick" } },
          },
        };
      },
    };
    it.each(Object.keys(CASES) as (keyof typeof CASES)[])(
      "%s, over mcp: the question about a long export is put",
      async (name) => {
        const { fs, store } = await fresh();
        const { rung, over } = CASES[name]();
        checked(checkRecord({ rHat: rHatFor(rung, 1.25 * LONG_EXPORT_SECONDS) }));
        const asked = vi.fn(async (_message: string, _warning: boolean) => "continue" as const);
        __setExportConfirmationForTests(asked);
        await submitWithDependencies(
          described(store, {
            via: "mcp",
            meta: metaOf({ calibration: descriptorOf(rung ? { rung } : {}) }),
            run: quickRun(fs),
            ...over,
          }),
        );
        await whenExportsSettle();
        expect(asked).toHaveBeenCalledTimes(1);
        expect(asked.mock.calls[0][0]).toMatch(/long time/);
      },
    );
  });
});

describe("what is noted about the export, locally", () => {
  it("notes the estimate shown, where it came from and the PC's class: three of the six new facts, and nothing reaches a report", async () => {
    const { fs, store } = await fresh();
    checked(checkRecord({ rHat: 2.5 }));
    const sub = await submitWithDependencies(described(store, { run: quickRun(fs) }));
    const record = listExportRecords().find((r) => r.job_id === sub.job_id) as Any;
    expect(factsOf3c(sub.job_id)).toEqual({
      estimate_s: record.estimate.seconds,
      estimate_basis: "pc_check",
      speed_class: "ok",
    });
    expect(factsForReport(sub.job_id)).toBeUndefined();
    await whenExportsSettle();
  });

  it("says unknown where there is no class, and nothing where there was no estimate", async () => {
    const { fs, store } = await fresh();
    const sub = await submitWithDependencies(described(store, { run: quickRun(fs) }));
    expect(factsOf3c(sub.job_id)).toMatchObject({
      estimate_basis: "guess",
      speed_class: "unknown",
    });
    await whenExportsSettle();
    const broken = { ...WORKLOAD, durationSeconds: Number.NaN };
    const second = `${DEST}.2.mp4`;
    const none = await submitWithDependencies(
      described(store, {
        destPath: second,
        stagePath: `${second}.part`,
        filename: "two.mp4",
        workload: broken,
        meta: metaOf({ calibration: descriptorOf({ workload: broken }) }),
        run: async () => ({}),
      }),
    );
    expect(factsOf3c(none.job_id)).toEqual({
      estimate_s: null,
      estimate_basis: null,
      speed_class: "unknown",
    });
    await whenExportsSettle();
  });

  it("notes nothing with the new estimate off: an app without it says nothing", async () => {
    __setExportFlag("estimate_v2", false);
    const { fs, store } = await fresh();
    const sub = await submitWithDependencies(described(store, { run: quickRun(fs) }));
    expect(factsOf3c(sub.job_id)).toBeUndefined();
    await whenExportsSettle();
  });

  it("is forgotten with the export's row: dismissed, or cleared", async () => {
    const { fs, store } = await fresh();
    const first = await submitWithDependencies(described(store, { run: quickRun(fs) }));
    await whenExportsSettle();
    expect(factsOf3c(first.job_id)).toBeDefined();
    expect(dismissExport(first.job_id)).toBe(true);
    expect(factsOf3c(first.job_id)).toBeUndefined();
    const second = `${DEST}.2.mp4`;
    const next = await submitWithDependencies(
      described(store, {
        destPath: second,
        stagePath: `${second}.part`,
        filename: "two.mp4",
        run: async () => {
          await fs.writeBytes(`${second}.part`, new Uint8Array([1]));
          return {};
        },
      }),
    );
    await whenExportsSettle();
    expect(factsOf3c(next.job_id)).toBeDefined();
    clearFinishedExports();
    expect(factsOf3c(next.job_id)).toBeUndefined();
  });
});

describe("what the estimate learns when a run ends", () => {
  const START = 1_700_000_000_000;

  /** A supervised export that runs for `seconds` of the clock, having made `fraction` of its project (its card's bar), and then ends as `end` says. The processors are busy (a heavy export, not a hung one) unless told. */
  async function run(over: {
    seconds: number;
    fraction: number;
    end: "cancel" | "finish" | "fail";
    activity?: "idle" | "busy";
    descriptor?: Record<string, unknown>;
    jump?: number;
    calibrations?: ExportCalibration[];
    destPath?: string;
    /** The PC sits this long (the clock jumps) after the render has ended and before its file has been checked: the stages that have no watch. */
    gapAfterRender?: number;
  }) {
    const { fs, store, jobs } = await fresh();
    if (over.calibrations) useExportJob.setState({ calibrations: over.calibrations });
    const delivery = localDeliveryPort(store);
    if (over.gapAfterRender) {
      const verify = delivery.verify.bind(delivery);
      delivery.verify = async (id) => {
        vi.setSystemTime(Date.now() + over.gapAfterRender!);
        return verify(id);
      };
    }
    jobs.delivery = delivery;
    const dest = over.destPath ?? DEST;
    const stage = `${dest}.part-x`;
    let proceed!: () => void;
    const gate = new Promise<void>((resolve) => (proceed = resolve));
    const sub = await submitWithDependencies({
      ...described(store, {
        destPath: dest,
        stagePath: stage,
        meta: metaOf({ calibration: descriptorOf(over.descriptor ?? {}) }),
      }),
      supervisor: jobs,
      via: "chat",
      origin: AGENT,
      run: async (signal, id) => {
        await jobs.submit({ id, lane: "measurement", program: "ffmpeg", args: [], meta: {} });
        jobs.stdout(
          id,
          block(Math.max(1, Math.round(over.fraction * 7200)), Math.round(over.fraction * 240_000)),
        );
        useExportJob.getState().update({
          fraction: over.fraction,
          frame: Math.max(1, Math.round(over.fraction * 7200)),
          speed: 1,
          etaSec: 100,
        });
        let cpuMs = 0;
        const mark = () => jobs.stdout(id, formatActivityMark({ cpuMs, readBytes: 0 }));
        mark();
        const marks = setInterval(() => {
          cpuMs += over.activity === "idle" ? 5 : 7_500;
          mark();
        }, 5_000);
        const ended = new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve()),
        );
        await Promise.race([gate, ended]);
        clearInterval(marks);
        if (signal.aborted) {
          jobs.exit(id, 255, "");
          await fs.remove(stage).catch(() => undefined);
          throw new Error("ffmpeg render failed (code=255)");
        }
        if (over.end === "fail") {
          jobs.exit(id, 1, "");
          throw new Error("ffmpeg render failed (code=1)");
        }
        jobs.exit(id, 0, "");
        await fs.writeBytes(stage, new Uint8Array([1, 2, 3]));
        return {};
      },
    } as ExportSpec);
    await vi.waitFor(() => expect(jobs.started).toContain(sub.job_id));
    if (over.jump) {
      vi.setSystemTime(Date.now() + over.jump);
    }
    await vi.advanceTimersByTimeAsync(over.seconds * 1000);
    if (over.end === "cancel") cancelExport(sub.job_id, "person_card");
    else proceed();
    await whenExportsSettle();
    return { sub, record: listExportRecords().find((r) => r.job_id === sub.job_id) as Any };
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: START });
  });

  it("learns from a run the person cancelled: the next estimate moves toward the pace the run showed, and is nearer the truth than before", async () => {
    // 25 % of the project in 5 minutes is a 20 minute export; the estimate on a PC nobody checked said about 10
    const before = admissionEstimateHere({
      workload: WORKLOAD,
      output: { width: 1920, height: 1080, fps: 30 },
      quality: "medium",
      engine: "file-sequence-v1",
      encoder: "x264-crf",
    })!;
    const { record } = await run({ seconds: 300, fraction: 0.25, end: "cancel" });
    expect(record.state).toBe("cancelled");
    const entries = paceEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ family: "processor", speedRevision: EXPORT_SPEED_REVISION });
    const truth = 1200;
    const after = admissionEstimateHere({
      workload: WORKLOAD,
      output: { width: 1920, height: 1080, fps: 30 },
      quality: "medium",
      engine: "file-sequence-v1",
      encoder: "x264-crf",
    })!;
    expect(Math.abs(after.estimate.seconds - truth)).toBeLessThan(
      Math.abs(before.estimate.seconds - truth),
    );
    expect(after.estimate.seconds / truth).toBeLessThan(2);
    expect(truth / after.estimate.seconds).toBeLessThan(2);
  });

  it("learns from a run that failed, and from one that finished, but never from a run that earlier exports already measured", async () => {
    await run({ seconds: 240, fraction: 0.5, end: "fail" });
    expect(paceEntries()).toHaveLength(1);
    __resetExportQueue();
    await run({ seconds: 600, fraction: 1, end: "finish", destPath: "C:/out/second.mp4" });
    expect(paceEntries()).toHaveLength(2);
    // the basis was earlier exports: a ratio to a measurement would count the PC twice
    __resetExportQueue();
    await run({
      seconds: 600,
      fraction: 1,
      end: "finish",
      destPath: "C:/out/third.mp4",
      calibrations: [earlier()],
    });
    expect(paceEntries()).toHaveLength(2);
  });

  it("learns nothing from a run the app stopped as hung: no processor work, no new picture, however far it had got", async () => {
    const { record } = await run({ seconds: 300, fraction: 0.5, end: "cancel", activity: "idle" });
    // the app stopped it for standing still, so it ended failed rather than cancelled
    expect(record.state).toBe("failed");
    expect(paceEntries()).toEqual([]);
  });

  it("learns nothing from a run that was too short, or made too little of its project, or that a sleep crossed", async () => {
    await run({ seconds: 60, fraction: 0.5, end: "cancel" });
    expect(paceEntries()).toEqual([]);
    __resetExportQueue();
    await run({ seconds: 300, fraction: 0.01, end: "cancel", destPath: "C:/out/b.mp4" });
    expect(paceEntries()).toEqual([]);
    __resetExportQueue();
    // the PC slept for an hour in the middle of it: the time is not the export's
    await run({
      seconds: 300,
      fraction: 0.5,
      end: "cancel",
      jump: 3_600_000,
      destPath: "C:/out/c.mp4",
    });
    expect(paceEntries()).toEqual([]);
  });

  it("a chip's export teaches the chip's log and never the processor's", async () => {
    await run({ seconds: 300, fraction: 0.25, end: "cancel", descriptor: { encoder: "chip-amd" } });
    expect(paceEntries().map((entry: Any) => entry.family)).toEqual(["chip"]);
  });

  it("is taught the time the render took: the file's check and its saving, which no watch sees, are not part of the lesson", async () => {
    const door = admissionEstimateHere({
      workload: WORKLOAD,
      output: { width: 1920, height: 1080, fps: 30 },
      quality: "medium",
      engine: "file-sequence-v1",
      encoder: "x264-crf",
    })!;
    // the render ends at 10 minutes; the lid is closed at "Checking" and the PC wakes two hours later
    const { record } = await run({
      seconds: 600,
      fraction: 1,
      end: "finish",
      gapAfterRender: 2 * 3_600_000,
    });
    expect(record.state).toBe("done");
    const entries = paceEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].ratio).toBeCloseTo(600 / door.uncorrected!.seconds, 2);
  });

  it("is told against the model's own figure, so a correction it has learned is not learned again on top of itself", async () => {
    await run({ seconds: 300, fraction: 0.25, end: "cancel" });
    __resetExportQueue();
    await run({ seconds: 300, fraction: 0.25, end: "cancel", destPath: "C:/out/two.mp4" });
    const [first, second] = paceEntries();
    expect(second.ratio).toBeCloseTo(first.ratio, 6);
  });

  it("learns nothing with the new estimate off, and the switch is read once, when the export was admitted: a flip mid-run changes nothing", async () => {
    __setExportFlag("estimate_v2", false);
    await run({ seconds: 300, fraction: 0.25, end: "cancel" });
    expect(paceEntries()).toEqual([]);
    __resetExportQueue();
    __setExportFlag("estimate_v2", true);
    // admitted with the switch on, switched off while it runs: the decision at admission stands
    const { fs, store, jobs } = await fresh();
    const delivery = localDeliveryPort(store);
    jobs.delivery = delivery;
    let flip!: () => void;
    const flipped = new Promise<void>((resolve) => (flip = resolve));
    const sub = await submitWithDependencies({
      ...described(store, { destPath: "C:/out/flip.mp4", stagePath: "C:/out/flip.mp4.part-x" }),
      supervisor: jobs,
      via: "chat",
      origin: AGENT,
      run: async (signal, id) => {
        await jobs.submit({ id, lane: "measurement", program: "ffmpeg", args: [], meta: {} });
        useExportJob.getState().update({ fraction: 0.25, frame: 1800, speed: 1 });
        jobs.stdout(id, block(1800, 60_000));
        let cpuMs = 0;
        const marks = setInterval(
          () => jobs.stdout(id, formatActivityMark({ cpuMs: (cpuMs += 7_500), readBytes: 0 })),
          5_000,
        );
        await Promise.race([
          flipped,
          new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())),
        ]);
        clearInterval(marks);
        jobs.exit(id, 255, "");
        await fs.remove("C:/out/flip.mp4.part-x").catch(() => undefined);
        throw new Error("ffmpeg render failed (code=255)");
      },
    } as ExportSpec);
    await vi.waitFor(() => expect(jobs.started).toContain(sub.job_id));
    await vi.advanceTimersByTimeAsync(300_000);
    __setExportFlag("estimate_v2", false);
    cancelExport(sub.job_id, "person_card");
    flip();
    await whenExportsSettle();
    expect(paceEntries()).toHaveLength(1);
  });

  it("fails soft: a store that cannot be read or written leaves the export ending as it would have", async () => {
    const setItem = localStorage.setItem.bind(localStorage);
    const getItem = localStorage.getItem.bind(localStorage);
    vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      if (key === PACE_LOG_KEY) throw new Error("storage is full");
      setItem(key, value);
    });
    const written = await run({ seconds: 300, fraction: 0.25, end: "cancel" });
    expect(written.record.state).toBe("cancelled");
    vi.restoreAllMocks();
    expect(paceEntries()).toEqual([]);
    __resetExportQueue();
    vi.spyOn(localStorage, "getItem").mockImplementation((key) => {
      if (key === PACE_LOG_KEY) throw new Error("storage is unreadable");
      return getItem(key);
    });
    const read = await run({
      seconds: 300,
      fraction: 0.25,
      end: "cancel",
      destPath: "C:/out/unreadable.mp4",
    });
    expect(read.record.state).toBe("cancelled");
  });
});
