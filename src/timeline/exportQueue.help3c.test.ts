// The slow banner and the failure advice as the real queue plays them: the supervised export, the watch's own five-second rhythm on a fake clock, the activity marks the app process prints, and the
// assistant's export list. Nothing here imports the help module itself: what is looked at is what the queue answers (the list, the local record, the click) and, in the component tests, what the person sees.
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { __setExportConfirmationForTests } from "../lib/confirm";
import * as host from "../platform/host";
import { useAuth } from "../store/auth";
import { useExportJob } from "../store/exportJob";
import { __resetExportQuestions } from "../store/exportQuestionHost";
import { __resetJobNotes } from "../store/jobNotes";
import { FakeJobs } from "../test/fakeJobs";
import { resetTestDocuments } from "../test/timelineKit";
import { __resetProjectJobs } from "../tools/genJobs";
import { joinPath, ProjectStoreAccess, type DirEntry, type FsLike } from "../tools/store";
import { formatActivityMark } from "./exportActivity";
import { __resetFacts3c, factsForReport, factsOf3c } from "./exportFacts3c";
import { EXPORT_SPEED_REVISION, type ExportCalibration } from "./exportOptions";
import {
  __resetExportQueue,
  listExportOutcomes,
  listExportRecords,
  localDeliveryPort,
  submitExport,
  whenExportTelemetrySettles,
  whenExportsSettle,
  type ExportSpec,
} from "./exportQueue";
import { keepExportGoing } from "./exportKeepGoing";
import { setPcCheckService } from "./pcCheckHandle";
import type { RenderWorkload } from "./renderPlan";
import { setOpenTimelineReader } from "./estimateDeps";
import { __resetRouteEstimatesMemo } from "./routeEstimates";

const exportBeacon = vi.hoisted(() => vi.fn(async (_event: unknown) => undefined));
vi.mock("../api/exportEvents", () => ({ reportExport: exportBeacon }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const DIR = "C:/proj";
const DEST = "C:/out/final.mp4";
const AGENT = { chatSessionId: "t1", branchId: 0, executionId: 1 };
const GB = 1e9;
const START = 1_700_000_000_000;
const TICK = 5;

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
const earlier = (seconds: number): ExportCalibration => ({
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

async function fresh() {
  const fs = new Fs();
  const store = new ProjectStoreAccess(DIR, fs);
  await whenExportTelemetrySettles();
  exportBeacon.mockClear();
  resources();
  __setExportConfirmationForTests(async () => "continue");
  useExportJob.setState({ calibrations: [], live: null, finishing: {} });
  setOpenTimelineReader(null);
  __resetRouteEstimatesMemo();
  return { fs, store, jobs: new FakeJobs() };
}

const described = (store: ProjectStoreAccess, over: Record<string, unknown> = {}) =>
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
  useExportJob.setState({ calibrations: [] });
  useAuth.setState({ profile: null });
});

interface Run {
  id: string;
  jobs: FakeJobs;
  /** Seconds into the run so far. */
  at: () => number;
  /** Play the run on to `until` seconds in the watch's own five-second steps. The render reports the pace that projects `projection(t)` seconds in all (or says nothing, for
   *  null: it has stopped moving); the app process prints its activity marks either way. */
  to: (
    until: number,
    projection: (t: number) => number | null,
    activity?: "busy" | "idle" | "none",
  ) => Promise<void>;
  end: (how: "finish" | "fail") => Promise<void>;
  /** Hold the file check, so the export sits in the stage after its render. */
  holdTheCheck: () => () => void;
}

/** A supervised export that is running, with its history giving the estimate shown at admission (null: nothing is known, a rough guess). */
async function startRun(
  over: {
    history?: number | null;
    dest?: string;
    delivery?: (d: ReturnType<typeof localDeliveryPort>) => void;
  } = {},
): Promise<Run> {
  const { fs, store, jobs } = await fresh();
  if (over.history) useExportJob.setState({ calibrations: [earlier(over.history)] });
  const delivery = localDeliveryPort(store);
  over.delivery?.(delivery);
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
    at: () => clock,
    to: async (until, projection, activity = "busy") => {
      for (let t = clock + TICK; t <= until; t += TICK) {
        const total = projection(t);
        if (total !== null) {
          const fraction = Math.min(1, t / total);
          const frame = Math.max(1, Math.round(fraction * 7200));
          jobs.stdout(sub.job_id, block(frame, Math.round(fraction * 240_000)));
          useExportJob
            .getState()
            .update({ fraction, frame, speed: 1, etaSec: Math.max(0, total - t) });
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

const rowOf = (id: string): Any => listExportOutcomes().find((r) => r.job_id === id);
const NOTE_SLOW =
  "This export is running slower than expected. Tell the person how long is left. Do not cancel it and start another.";

describe("the assistant's list, while a render is much slower than its estimate (B1)", () => {
  it("says it is slower than expected, with the projected total and what to do about it, from the first tick that is 90 s in, 2 % done and over three times its estimate", async () => {
    const run = await startRun({ history: 100 });
    // a real-shaped log: 400 s of render against 100 s said, reported every few seconds from the first picture
    await run.to(85, () => 400);
    expect(rowOf(run.id)).not.toHaveProperty("slower_than_expected");
    expect(rowOf(run.id)).not.toHaveProperty("projected_total_s");
    await run.to(90, () => 400);
    expect(rowOf(run.id)).toMatchObject({
      state: "running",
      expected_s: 100,
      slower_than_expected: true,
      projected_total_s: 400,
      note: NOTE_SLOW,
    });
    // the existing facts of the row are as they were; the time left is the one the card says, on the rounding grid: a render that projects 400 s in all has 400 - 90 = 310 s left
    // 90 s in, and under ten minutes the grid is whole minutes, so the nearest is 5 min = 300 s (the banner above keeps the raw 400 and the raw pace)
    expect(rowOf(run.id)).toMatchObject({
      stage: "rendering",
      progress_percent: 23,
      time_left_s: 300,
    });
    expect(factsOf3c(run.id)?.help_shown).toEqual(["slow"]);
    expect(factsForReport(run.id)).toBeUndefined();
    await run.end("finish");
    expect(rowOf(run.id)).toMatchObject({ state: "done" });
    expect(rowOf(run.id)).not.toHaveProperty("slower_than_expected");
    expect(rowOf(run.id)).not.toHaveProperty("projected_total_s");
  });

  it("says nothing on a healthy export: a render that finishes within twice its estimate shows nothing at any tick", async () => {
    const run = await startRun({ history: 100 });
    for (let t = TICK; t <= 185; t += TICK) {
      await run.to(t, () => 190);
      expect(rowOf(run.id), `at ${t} s`).not.toHaveProperty("slower_than_expected");
    }
    await run.end("finish");
    expect(rowOf(run.id)).toMatchObject({ state: "done" });
    expect(factsOf3c(run.id)?.help_shown).toBeUndefined();
  });

  it("replays a recorded run that finished at 1.9 times its estimate (131 s against 70 s) without a banner, and one far over (992 s against 153 s) with one, within 180 s of the projection passing three times", async () => {
    const healthy = await startRun({ history: 70 });
    for (let t = TICK; t <= 125; t += TICK) {
      await healthy.to(t, () => 131);
      expect(rowOf(healthy.id), `healthy at ${t} s`).not.toHaveProperty("slower_than_expected");
    }
    await healthy.end("finish");
    __resetExportQueue();

    const far = await startRun({ history: 153, dest: "C:/out/far.mp4" });
    let first: number | null = null;
    for (let t = TICK; t <= 400 && first === null; t += TICK) {
      await far.to(t, () => 992);
      if (rowOf(far.id)?.slower_than_expected === true) first = t;
    }
    // over three times 153 s from the first picture; the banner waited for 90 s and then came at the next tick
    expect(first).toBe(90);
    expect(rowOf(far.id)).toMatchObject({ projected_total_s: 992 });
    await far.end("finish");
  });
});

describe("the click as the export ends (B5)", () => {
  it("takes Keep going while the render runs, and is refused with a line once the export has finished: never a second state", async () => {
    const run = await startRun({ history: 100 });
    await run.to(90, () => 400);
    expect(keepExportGoing(run.id, "slow")).toEqual({ ok: true });
    await run.end("finish");
    expect(listExportRecords()).toHaveLength(1);
    const late = keepExportGoing(run.id, "slow");
    expect(late.ok).toBe(false);
    expect(late).toEqual({ ok: false, line: expect.stringMatching(/\S/) });
    // nothing was made of the late click: one row, still done, and no word of help beyond the first banner
    expect(listExportRecords()).toHaveLength(1);
    expect(listExportRecords()[0].state).toBe("done");
    expect(factsOf3c(run.id)?.help_shown).toEqual(["slow"]);
    expect(rowOf(run.id)).not.toHaveProperty("slower_than_expected");
  });

  it("is refused while the file is being checked, when the render is over and the export has not settled", async () => {
    const run = await startRun({ history: 100 });
    await run.to(90, () => 400);
    const release = run.holdTheCheck();
    const finished = run.end("finish");
    // the render has ended and the check is held: the export is still running, in its stage after the render
    await vi.waitFor(() => expect(useExportJob.getState().live?.stage).toBe("checking"));
    expect(listExportRecords()[0].state).toBe("running");
    expect(keepExportGoing(run.id, "slow").ok).toBe(false);
    expect(rowOf(run.id)).not.toHaveProperty("slower_than_expected");
    release();
    await finished;
    expect(listExportRecords()[0].state).toBe("done");
    expect(factsOf3c(run.id)?.help_shown).toEqual(["slow"]);
  });

  it("is refused for an export that is not there at all", () => {
    expect(keepExportGoing("no-such-export", "slow").ok).toBe(false);
    expect(keepExportGoing("", "quiet").ok).toBe(false);
  });
});

describe("with the verdict of the stall rule (B6)", () => {
  it("a quiet render whose processors are busy is working, and the help adds no stopped-moving word of its own", async () => {
    // the ring needs three minutes of readings before it can call a quiet export busy; an estimate of 400 s keeps the pace healthy
    const run = await startRun({ history: 400 });
    await run.to(200, () => 400, "busy");
    await run.to(280, () => null, "busy");
    expect(rowOf(run.id)).toMatchObject({ working: true });
    expect(rowOf(run.id).quiet_for_s).toBeGreaterThanOrEqual(60);
    expect(factsOf3c(run.id)?.help_shown).toBeUndefined();
    await run.end("fail");
  });

  it("a quiet render whose processors are idle has stopped moving, and the help says so", async () => {
    // the app's own stop is held off, so that the minute and more of silence can be looked at
    __setExportFlag("stall_stop", false);
    const run = await startRun({ history: 400 });
    await run.to(100, () => 400, "idle");
    await run.to(200, () => null, "idle");
    expect(rowOf(run.id)).toMatchObject({ stalled_for_s: expect.any(Number) });
    expect(rowOf(run.id)).not.toHaveProperty("working");
    expect(factsOf3c(run.id)?.help_shown).toEqual(["quiet"]);
    await run.end("fail");
  });

  it("a quiet render whose activity cannot be read has stopped moving too", async () => {
    __setExportFlag("stall_stop", false);
    const run = await startRun({ history: 400 });
    await run.to(100, () => 400, "none");
    await run.to(200, () => null, "none");
    expect(rowOf(run.id)).toMatchObject({ stalled_for_s: expect.any(Number) });
    expect(factsOf3c(run.id)?.help_shown).toEqual(["quiet"]);
    await run.end("fail");
  });
});

describe("the switch for the help (S2)", () => {
  it("with the switch off the list is 0.27.0's: no new field, no note, nothing noted, for the whole run", async () => {
    __setExportFlag("export_help", false);
    const run = await startRun({ history: 100 });
    await run.to(200, () => 400);
    const row = rowOf(run.id);
    expect(row).not.toHaveProperty("slower_than_expected");
    expect(row).not.toHaveProperty("projected_total_s");
    expect(row).not.toHaveProperty("note");
    expect(Object.keys(row).sort()).toEqual(
      [
        "elapsed_s",
        "expected_s",
        "job_id",
        "filename",
        "progress_percent",
        "stage",
        "state",
        "time_left_s",
      ].sort(),
    );
    expect(factsOf3c(run.id)?.help_shown).toBeUndefined();
    await run.end("finish");
  });

  it("takes a flip in the middle of a run at once: the fields go with the switch, and come back with it", async () => {
    const run = await startRun({ history: 100 });
    await run.to(100, () => 400);
    expect(rowOf(run.id)).toMatchObject({ slower_than_expected: true });
    __setExportFlag("export_help", false);
    expect(rowOf(run.id)).not.toHaveProperty("slower_than_expected");
    expect(rowOf(run.id)).not.toHaveProperty("note");
    await run.to(110, () => 400);
    expect(rowOf(run.id)).not.toHaveProperty("slower_than_expected");
    __setExportFlag("export_help", true);
    expect(rowOf(run.id)).toMatchObject({ slower_than_expected: true, projected_total_s: 400 });
    await run.end("finish");
  });
});

describe("what a failed export tells the assistant (A2)", () => {
  const MEMORY = "Error while filtering: Cannot allocate memory";
  const PLAIN: Record<string, string> = {
    memory_limit: "Your PC ran short of memory. Close other programs and try again.",
    time_limit: "The export took longer than ArtDaddy allows, or stopped making progress.",
    storage_full: "A drive ran out of space. Free up some space and try again.",
    source_unavailable:
      "Some clips couldn't be read. They may have been moved or renamed, or are on a drive that is disconnected.",
    storage_unavailable:
      "ArtDaddy couldn't save to that folder. It may be read-only, the file may be open in another program, or the drive may be disconnected.",
    verification_failed:
      "The finished video didn't pass ArtDaddy's check, so it wasn't saved. Your project was not changed.",
    render_failed: "Something went wrong while exporting. Your project was not changed.",
    interrupted: "ArtDaddy closed while exporting. The unfinished file was removed.",
    unknown: "Something went wrong while exporting. Your project was not changed.",
  };
  const CASES: Array<[string, string, string]> = [
    [
      "memory_limit",
      MEMORY,
      " To use less memory, lower the picture size or frame rate, or export a shorter section.",
    ],
    [
      "time_limit",
      "export deadline exceeded",
      " On this PC a lower picture size or frame rate, or a shorter section, is faster.",
    ],
    ["storage_full", "ENOSPC: no space left on device", ""],
    ["source_unavailable", "ENOENT: no such file or directory", ""],
    ["storage_unavailable", "Permission denied: destination unavailable", ""],
    ["verification_failed", "verification failed: frame count mismatch", ""],
    ["render_failed", "ffmpeg render failed (code=1)", ""],
    ["interrupted", "interrupted by a restart", ""],
    ["unknown", "something odd", ""],
  ];

  async function failWith(error: string, n: number, over: Record<string, unknown> = {}) {
    const { fs, store } = await fresh();
    const dest = `C:/out/case-${n}.mp4`;
    const sub = await submitExport({
      ...described(store, {
        destPath: dest,
        stagePath: `${dest}.part-x`,
        filename: `case-${n}.mp4`,
        ...over,
      }),
      run: async () => {
        void fs;
        throw new Error(error);
      },
    } as ExportSpec);
    await whenExportsSettle();
    return rowOf(sub.job_id);
  }

  it.each(CASES.map((c, i) => [...c, i] as const))(
    "says what %s was in 0.27.0's words, with the one sentence of advice only where there is something true to say",
    async (code, error, advice, n) => {
      const row = await failWith(error, n);
      expect(row.failure_code).toBe(code);
      expect(row.failure).toBe(PLAIN[code] + advice);
    },
  );

  it("does not add a field for it", async () => {
    const row = await failWith(MEMORY, 20);
    expect(Object.keys(row).filter((key) => /lower|advice|hint/i.test(key))).toEqual([]);
  });

  it("says the chip's advice after the chip's own sentence when the graphics chip stopped it and nothing started it again", async () => {
    __setExportFlag("chip_restart", false);
    const row = await failWith(
      "native render failed: [h264_amf @ 0000028f] Error submitting video frame to the encoder",
      21,
      {
        meta: metaOf({
          choice: {
            encoder: "amd",
            reason: "over_minute",
            tests: [],
            adapter: { maker: "amd", device: "15bf", driver: "32.0.1" },
          },
        }),
      },
    );
    expect(row.chip_failed).toBe(true);
    expect(row.failure).toBe(
      "The graphics chip stopped this export before it finished. It is set aside for a day: export again and the processor is used, which takes longer. To make that shorter, lower the picture size or frame rate.",
    );
  });

  it("says 0.27.0's words, and only those, with the switch off", async () => {
    __setExportFlag("export_help", false);
    for (const [i, [code, error]] of CASES.entries()) {
      const row = await failWith(error, 30 + i);
      expect(row.failure, code).toBe(PLAIN[code]);
    }
  });
});
