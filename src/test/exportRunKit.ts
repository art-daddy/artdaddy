// A supervised export on a fake clock, for the tests that look at what the app says about a running export: the assistant's export list, the chat card and
// the Export dialog read one store, fed by the same progress reports the render makes. The test decides what each report says and when it arrives; the
// kit plays the app process (its stdout and its exit) and the queue admits, follows and settles the export as it does for a person.
//
// A test file that uses it keeps `vi.mock("../api/exportEvents", ...)` itself (the mock is hoisted per file) and calls `useKit()` once at the top.
import { createHash } from "node:crypto";

import { afterEach, beforeEach, expect, vi } from "vitest";

import { __resetExportFlags } from "../api/exportFlags";
import { __setExportConfirmationForTests } from "../lib/confirm";
import * as host from "../platform/host";
import { useAuth } from "../store/auth";
import { useExportJob } from "../store/exportJob";
import { __resetExportQuestions } from "../store/exportQuestionHost";
import { __resetJobNotes } from "../store/jobNotes";
import { setOpenTimelineReader } from "../timeline/estimateDeps";
import { formatActivityMark } from "../timeline/exportActivity";
import { __resetFacts3c } from "../timeline/exportFacts3c";
import { EXPORT_SPEED_REVISION, type ExportCalibration } from "../timeline/exportOptions";
import {
  __resetExportQueue,
  localDeliveryPort,
  submitExport,
  whenExportTelemetrySettles,
  whenExportsSettle,
  type ExportSpec,
} from "../timeline/exportQueue";
import { setPcCheckService } from "../timeline/pcCheckHandle";
import type { RenderWorkload } from "../timeline/renderPlan";
import { __resetRouteEstimatesMemo } from "../timeline/routeEstimates";
import { __resetProjectJobs } from "../tools/genJobs";
import { joinPath, ProjectStoreAccess, type DirEntry, type FsLike } from "../tools/store";
import { FakeJobs } from "./fakeJobs";
import { resetTestDocuments } from "./timelineKit";

export const DIR = "C:/proj";
export const DEST = "C:/out/final.mp4";
export const AGENT = { chatSessionId: "t1", branchId: 0, executionId: 1 };
export const GB = 1e9;
export const START = 1_700_000_000_000;
/** The seconds between two steps of a run (the watch's own rhythm). */
export const TICK = 5;

export class Fs implements FsLike {
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

export const WORKLOAD: RenderWorkload = {
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
export const metaOf = (over: Record<string, unknown> = {}) => ({
  duration_s: 240,
  width: 1920,
  height: 1080,
  fps: 30,
  quality: "medium",
  project_id: "",
  calibration: descriptorOf(),
  ...over,
});
/** One block of ffmpeg's `-progress` output. */
export const block = (frame: number, outMs: number) =>
  `frame=${frame}\nfps=30\nout_time_us=${outMs * 1000}\nspeed=1.0x\nprogress=continue\n`;
/** An earlier export of the same shape that took `seconds`: with it on the PC the next one is expected to take about as long. */
export const earlier = (seconds: number): ExportCalibration => ({
  ...descriptorOf(),
  elapsedSeconds: seconds,
  finalBytes: 90_000_000,
  memoryBytes: 1 * GB,
  temporaryBytes: 100_000_000,
});

function resources() {
  vi.spyOn(host, "resolveExportResources").mockResolvedValue({
    total_memory_bytes: 16 * GB,
    available_memory_bytes: 12 * GB,
    scratch_free_bytes: 500 * GB,
    destination_free_bytes: 500 * GB,
    local_fast_candidate: false,
    budgets: { memoryBytes: 8 * GB, temporaryBytes: 18 * GB, executionSeconds: 28_800 },
  });
}

/** A clean app: a project store on an in-memory disk, the host's resources, no earlier exports. */
export async function fresh() {
  const fs = new Fs();
  const store = new ProjectStoreAccess(DIR, fs);
  await whenExportTelemetrySettles();
  resources();
  __setExportConfirmationForTests(async () => "continue");
  useExportJob.setState({ calibrations: [], live: null, finishing: {} });
  setOpenTimelineReader(null);
  __resetRouteEstimatesMemo();
  return { fs, store, jobs: new FakeJobs() };
}

export const described = (store: ProjectStoreAccess, over: Record<string, unknown> = {}) =>
  ({
    store,
    dependencies: [],
    destPath: DEST,
    stagePath: `${DEST}.part-x`,
    filename: "film.mp4",
    workload: WORKLOAD,
    meta: metaOf(),
    run: async () => ({}),
    ...over,
  }) as ExportSpec;

/** The fake clock from START, and everything the queue left behind put away after each test. Call once at the top of a test file. */
export function useKit(): void {
  beforeEach(() => {
    __resetFacts3c();
    vi.useFakeTimers({ now: START });
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
    useExportJob.setState({ calibrations: [], live: null, finishing: {} });
    useAuth.setState({ profile: null });
  });
}

/** One progress report of the render, as the producer in render.ts publishes it. */
export interface Report {
  /** The share of the whole render made, 0 to 1. */
  readonly fraction: number;
  readonly step?: number | null;
  readonly steps?: number | null;
  /** The render's own raw guess (ffmpeg's speed, start-up counted), which the banner reads; default 0 s, a render that has nothing left. */
  readonly etaSec?: number | null;
  readonly speed?: number;
}

export interface Run {
  id: string;
  jobs: FakeJobs;
  store: ProjectStoreAccess;
  /** Seconds into the run so far. */
  at: () => number;
  /** Play the run on to `until` seconds in the watch's own five-second steps, the render reporting `report(t)` at each (null: it reports nothing, it has stopped moving);
   *  the app process prints its activity marks either way. */
  to: (
    until: number,
    report: (t: number) => Report | null,
    activity?: "busy" | "idle" | "none",
  ) => Promise<void>;
  /** The run ends: the process exits, or fails, and the export settles. */
  end: (how: "finish" | "fail") => Promise<void>;
  /** Hold the file check, so the export sits in the stage after its render. */
  holdTheCheck: () => () => void;
}

/** A supervised export that is running (rendering, no report yet), as a person's or an assistant's click makes one. With `history` the PC has an earlier export of
 *  that many seconds, so the export is admitted with an expectation from it; without it the expectation is a guess. */
export async function startRun(
  over: { history?: number | null; dest?: string; kit?: Awaited<ReturnType<typeof fresh>> } = {},
): Promise<Run> {
  const { fs, store, jobs } = over.kit ?? (await fresh());
  if (over.history) useExportJob.setState({ calibrations: [earlier(over.history)] });
  const delivery = localDeliveryPort(store);
  jobs.delivery = delivery;
  const dest = over.dest ?? DEST;
  const stage = `${dest}.part-x`;
  let finish: "finish" | "fail" = "finish";
  let wake!: () => void;
  const gate = new Promise<void>((resolve) => (wake = resolve));
  const sub = await submitExport({
    ...described(store, { destPath: dest, stagePath: stage }),
    supervisor: jobs,
    via: "chat",
    origin: AGENT,
    run: async (signal, id) => {
      await jobs.submit({ id, lane: "measurement", program: "ffmpeg", args: [], meta: {} });
      const aborted = new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve()),
      );
      await Promise.race([gate, aborted]);
      if (signal.aborted) {
        jobs.exit(id, 255, "");
        await fs.remove(stage).catch(() => undefined);
        throw new Error("ffmpeg render failed (code=255)");
      }
      if (finish === "fail") {
        jobs.exit(id, 1, "");
        throw new Error("ffmpeg render failed (code=1)");
      }
      jobs.exit(id, 0, "");
      await fs.writeBytes(stage, new Uint8Array([1, 2, 3]));
      return {};
    },
  } as ExportSpec);
  await vi.waitFor(() => expect(jobs.started).toContain(sub.job_id));
  let clock = 0;
  let cpuMs = 0;
  const run: Run = {
    id: sub.job_id,
    jobs,
    store,
    at: () => clock,
    to: async (until, report, activity = "busy") => {
      for (let t = clock + TICK; t <= until; t += TICK) {
        const said = report(t);
        if (said !== null) {
          const frame = Math.max(1, Math.round(said.fraction * 7200));
          jobs.stdout(sub.job_id, block(frame, Math.round(said.fraction * 240_000)));
          useExportJob.getState().update({
            fraction: said.fraction,
            frame,
            speed: said.speed ?? 1,
            etaSec: said.etaSec === undefined ? 0 : said.etaSec,
            ...(said.step !== undefined ? { step: said.step } : {}),
            ...(said.steps !== undefined ? { steps: said.steps } : {}),
          });
        }
        if (activity !== "none") {
          cpuMs += activity === "idle" ? 5 : 7_500;
          jobs.stdout(sub.job_id, formatActivityMark({ cpuMs, readBytes: 0 }));
        }
        await vi.advanceTimersByTimeAsync(TICK * 1000);
        clock = t;
      }
    },
    end: async (how) => {
      finish = how;
      wake();
      await whenExportsSettle();
    },
    holdTheCheck: () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const verify = delivery.verify;
      delivery.verify = async (id) => {
        await held;
        return verify(id);
      };
      return release;
    },
  };
  return run;
}

/** A render whose pace is steady: it finishes `total` seconds after it began, and its own raw guess is exact. */
export const steady =
  (total: number) =>
  (t: number): Report => ({ fraction: Math.min(1, t / total), etaSec: Math.max(0, total - t) });

/** A second export, admitted while `behind` renders: the app process holds it in its line until the first one's process is over. It waits there until it is cancelled. */
export async function waitBehind(behind: Run, dest = "C:/out/second.mp4"): Promise<string> {
  const sub = await submitExport({
    ...described(behind.store, { destPath: dest, stagePath: `${dest}.part-x` }),
    supervisor: behind.jobs,
    via: "chat",
    origin: AGENT,
    run: async (signal, id) => {
      await behind.jobs.submit({ id, lane: "measurement", program: "ffmpeg", args: [], meta: {} });
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      throw new Error("export cancelled");
    },
  } as ExportSpec);
  return sub.job_id;
}
