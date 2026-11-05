// The queue's job is to protect the DESTINATION FILE. Every test here is about what is sitting
// on disk at the path the user chose, not about what the tool returned.
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { createHash } from "node:crypto";

import {
  __resetExportQueue,
  cancelExport,
  exportWaitMs,
  isDestinationReserved,
  localDeliveryPort,
  listExportRecords,
  listExports,
  manageExportsTool,
  MAX_EXPORT_WAIT_S,
  offerExportRetry,
  retryExport,
  submitExport as submitWithDependencies,
  submitExports,
  whenExportEnds,
  whenExportsSettle,
  whenExportTelemetrySettles,
  ExportRunError,
  ExportRequestError,
} from "./exportQueue";
import { __resetJobNotes, pendingJobNotes } from "../store/jobNotes";
import { __resetProjectJobs } from "../tools/genJobs";
import { joinPath, ProjectStoreAccess, type DirEntry, type FsLike } from "../tools/store";
import { backgroundTurn } from "../tools/workGate";
import { resetTestDocuments } from "../test/timelineKit";
import { __setExportConfirmationForTests, type ExportConfirmation } from "../lib/confirm";
import { toolDefinition } from "../contract";
import { endProjectSession } from "../tools/coordinator";
import { useExportJob } from "../store/exportJob";
import { useAuth } from "../store/auth";
import { EXPORT_SPEED_REVISION, type ExportCalibration } from "./exportOptions";
import { FakeJobs } from "../test/fakeJobs";
import * as exportFlags from "../api/exportFlags";
import { __setExportFlag } from "../api/exportFlags";
import * as host from "../platform/host";
import { limitThatFired } from "./nativeDiagnostics";
import {
  __resetExportQuestions,
  answerQuestion,
  hostMounted,
  mountQuestionHost,
  useExportQuestions,
} from "../store/exportQuestionHost";

const exportBeacon = vi.hoisted(() => vi.fn(async (_event: unknown) => undefined));
vi.mock("../api/exportEvents", () => ({ reportExport: exportBeacon }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const DIR = "C:/proj";
const DEST = "C:/out/final.mp4";

/** A chat execution identity, i.e. THIS CHAT asked for the export. Its absence is what the queue
 *  reads as "the Export menu or an external MCP agent asked", and only the former may resume the
 *  conversation. */
const AGENT = { chatSessionId: "t1", branchId: 0, executionId: 1 };

class Fs implements FsLike {
  files = new Map<string, string>();
  bytes = new Map<string, Uint8Array>();
  renames: [string, string][] = [];
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
    // Text too: the ledger commits jobs.json with an atomic write, which is a text rename.
    if (this.bytes.has(f)) {
      this.bytes.set(t, this.bytes.get(f)!);
      this.bytes.delete(f);
    } else if (this.files.has(f)) {
      this.files.set(t, this.files.get(f)!);
      this.files.delete(f);
    } else {
      throw new Error("ENOENT");
    }
    this.renames.push([f, t]);
  }
}

function make(): { fs: Fs; store: ProjectStoreAccess } {
  const fs = new Fs();
  return { fs, store: new ProjectStoreAccess(DIR, fs) };
}

/** Renames of the deliverable only ΓÇö the ledger commits jobs.json by rename as well. */
const commits = (fs: Fs): [string, string][] =>
  fs.renames.filter(([, to]) => !to.includes("internals/"));

const STAGE = `${DEST}.part-x`;
const submitExport = (
  request: Omit<Parameters<typeof submitWithDependencies>[0], "dependencies">,
) => submitWithDependencies({ ...request, dependencies: [] });

afterEach(async () => {
  // Reset BEFORE draining: a test that leaves an encode gated would otherwise hang cleanup and
  // poison every test after it.
  __resetExportQueue();
  __resetExportQuestions();
  __resetJobNotes();
  __resetProjectJobs();
  await resetTestDocuments();
  vi.restoreAllMocks();
  useExportJob.setState({ calibrations: [] });
  useAuth.setState({ profile: null });
});

describe("required export preflight", () => {
  const calibration: Pick<
    ExportCalibration,
    "workload" | "output" | "quality" | "engine" | "revision"
  > = {
    workload: {
      width: 1920,
      height: 1080,
      fps: 30,
      durationSeconds: 10,
      visualClips: 14,
      captionClips: 2,
      audioClips: 1,
      peakVisualLayers: 8,
      peakMediaLayers: 7,
    },
    output: { width: 1920, height: 1080, fps: 30 },
    quality: "medium",
    engine: "partition-pipes-v1",
    revision: EXPORT_SPEED_REVISION,
  };

  it.each(["slow", "batch-space"] as const)(
    "shows the correct measured %s decision rather than a generic pass",
    async (scenario) => {
      const { store } = make();
      vi.spyOn(host, "resolveExportResources").mockResolvedValue({
        total_memory_bytes: 1000,
        available_memory_bytes: 500,
        local_fast_candidate: false,
        scratch_free_bytes: scenario === "slow" ? 1000 : 150,
        destination_free_bytes: scenario === "slow" ? 1000 : 150,
        budgets: { memoryBytes: 500, temporaryBytes: 500, executionSeconds: 28800 },
      });
      useExportJob.setState({
        calibrations: [
          {
            ...calibration,
            elapsedSeconds: scenario === "slow" ? 30 : 10,
            finalBytes: 100,
            memoryBytes: 100,
            temporaryBytes: 10,
          },
        ],
      });
      let shown: { message: string; warning: boolean } | undefined;
      __setExportConfirmationForTests(async (message, warning) => {
        shown = { message, warning };
        return "cancel";
      });
      const requests = (scenario === "slow" ? [DEST] : [DEST, "C:/out/second.mp4"]).map(
        (destPath) => ({
          store,
          dependencies: [],
          destPath,
          stagePath: `${destPath}.part`,
          filename: "movie.mp4",
          workload: calibration.workload,
          meta: {
            duration_s: 10,
            width: 1920,
            height: 1080,
            fps: 30,
            quality: "medium",
            project_id: "",
            calibration,
          },
          run: async () => ({}),
        }),
      );
      await expect(submitExports(requests)).rejects.toThrow("cancelled before submission");
      expect(shown?.warning).toBe(scenario === "batch-space");
      expect(shown?.message).toContain(
        scenario === "slow"
          ? "more than twice"
          : "the exported videos and their temporary files together",
      );
      expect(shown?.message).not.toContain("Estimated time: unknown");
      expect(listExportRecords()).toHaveLength(0);
    },
  );

  // A PC with 4 GB free. The memory numbers are real sizes because a first export with nothing measured needs
  // the 2 GB reserve free (XR-21), which a few hundred bytes would never meet.
  const roomy = {
    total_memory_bytes: 8e9,
    available_memory_bytes: 4e9,
    local_fast_candidate: false,
    scratch_free_bytes: 1000,
    destination_free_bytes: 1000,
    budgets: { memoryBytes: 4e9, temporaryBytes: 500, executionSeconds: 28800 },
  };

  /** Submit one in-scope export and report what the user was asked, and whether it then started. */
  async function submitAsked(opts: {
    fps?: number;
    history?: Partial<ExportCalibration>;
    scratch?: number;
    duration?: number;
    size?: { width: number; height: number };
    layers?: number;
  }) {
    const { fs, store } = make();
    vi.spyOn(host, "resolveExportResources").mockResolvedValue({
      ...roomy,
      scratch_free_bytes: opts.scratch ?? roomy.scratch_free_bytes,
    });
    useExportJob.setState({
      calibrations: opts.history
        ? [
            {
              ...calibration,
              elapsedSeconds: 10,
              finalBytes: 100,
              memoryBytes: 100,
              temporaryBytes: 10,
              ...opts.history,
            },
          ]
        : [],
    });
    let shown: { message: string; warning: boolean } | undefined;
    __setExportConfirmationForTests(async (message, warning) => {
      shown = { message, warning };
      return "cancel";
    });
    let readiness: string | undefined;
    const workload = {
      ...calibration.workload,
      fps: opts.fps ?? calibration.workload.fps,
      durationSeconds: opts.duration ?? calibration.workload.durationSeconds,
      ...opts.size,
      ...(opts.layers === undefined ? {} : { peakVisualLayers: opts.layers }),
    };
    const descriptor = opts.size
      ? { ...calibration, output: { ...opts.size, fps: workload.fps } }
      : calibration;
    const result = await submitExports([
      {
        store,
        dependencies: [],
        destPath: DEST,
        stagePath: `${DEST}.part`,
        filename: "movie.mp4",
        workload,
        meta: {
          duration_s: workload.durationSeconds,
          width: workload.width,
          height: workload.height,
          fps: workload.fps,
          quality: "medium",
          project_id: "",
          calibration: descriptor,
        },
        run: async (_, _id, meta) => {
          readiness = meta?.readiness;
          await fs.writeBytes(`${DEST}.part`, new Uint8Array([1, 2, 3]));
          return {};
        },
      },
    ]).then(
      () => "started",
      (error: Error) => error.message,
    );
    await whenExportsSettle();
    return { shown, result, readiness };
  }

  it("starts an in-scope export without asking when only measurements are missing", async () => {
    const { shown, result, readiness } = await submitAsked({});
    expect(shown).toBeUndefined();
    expect(result).toBe("started");
    // Starting silently must not claim storage was checked.
    expect(readiness).toBe("unknown");
  });

  it.each([
    ["outside the promise", { fps: 120 }],
    ["memory", { history: { memoryBytes: 6e9 } }],
    ["storage", { history: { temporaryBytes: 400 }, scratch: 300 }],
    ["time limit", { history: { elapsedSeconds: 40_000 } }],
  ] as const)(
    "asks, with the warning wording, about a known problem: %s",
    async (_problem, opts) => {
      const { shown, result } = await submitAsked(opts);
      expect(result).toContain("cancelled before submission");
      expect(shown?.warning).toBe(true);
      expect(shown?.message).toContain("Continue anyway?");
    },
  );

  describe("with no history to go by, the size of the export decides", () => {
    it("asks a plain Continue, and says it is a guess, when the export looks long", async () => {
      const { shown, result } = await submitAsked({ duration: 3600 }); // an hour of HD, 8 layers
      expect(result).toContain("cancelled before submission");
      expect(shown?.warning).toBe(false);
      expect(shown?.message).toContain("Continue?");
      expect(shown?.message).not.toContain("Continue anyway?");
      expect(shown?.message).toContain("rough guess");
      expect(shown?.message).toContain("about 1 h 42 min");
      expect(shown?.message).toContain("expected to take a long time");
      // Not a measurement, so it must not read as one, nor as "unknown".
      expect(shown?.message).not.toContain("from earlier exports");
      expect(shown?.message).not.toContain("Estimated time: unknown");
    });

    it("starts without asking when the export is big but short", async () => {
      const { shown, result } = await submitAsked({
        duration: 30,
        size: { width: 3840, height: 2160 },
        layers: 3,
      });
      expect(shown).toBeUndefined();
      expect(result).toBe("started");
    });

    it("asks with the warning wording when even the guess passes the time limit", async () => {
      const { shown } = await submitAsked({ duration: 20_000 });
      expect(shown?.warning).toBe(true);
      expect(shown?.message).toContain("longer than the longest an export may run");
      expect(shown?.message).toContain("rough guess");
    });

    it("lets a measurement beat the guess, in both directions", async () => {
      // A small output, so storage is not what is being asked about.
      // 10 s of video took 10 s: an hour of it is an hour, so it asks, as a measurement.
      const slow = await submitAsked({
        duration: 3600,
        history: { elapsedSeconds: 10, finalBytes: 1 },
      });
      expect(slow.shown?.warning).toBe(false);
      expect(slow.shown?.message).toContain("Estimated time: about 1 h (from earlier exports");
      expect(slow.shown?.message).not.toContain("rough guess");
      // 10 s of video took 1 s: the same hour is six minutes, and the guess no longer asks.
      const quick = await submitAsked({
        duration: 3600,
        history: { elapsedSeconds: 1, finalBytes: 1 },
      });
      expect(quick.shown).toBeUndefined();
      expect(quick.result).toBe("started");
    });
  });

  it("does not warn from a measurement made under another speed revision", async () => {
    const { shown, result } = await submitAsked({
      history: { revision: EXPORT_SPEED_REVISION - 1, elapsedSeconds: 40_000 },
    });
    expect(shown).toBeUndefined();
    expect(result).toBe("started");
  });

  it.each([true, false])(
    "records comparable calibration only after published success=%s",
    async (succeeds) => {
      const { fs, store } = make();
      useExportJob.setState({ calibrations: [] });
      vi.useFakeTimers({ now: 5000 });
      try {
        const submitted = await submitExport({
          store,
          destPath: DEST,
          stagePath: STAGE,
          filename: "final.mp4",
          workload: calibration.workload,
          meta: {
            duration_s: 10,
            width: 1920,
            height: 1080,
            fps: 30,
            quality: "medium",
            project_id: "",
            calibration,
          },
          run: async () => {
            vi.setSystemTime(21000);
            if (!succeeds) throw new Error("render failed");
            await fs.writeBytes(STAGE, new Uint8Array([1, 2, 3]));
            return {};
          },
        });
        await whenExportsSettle();
        await whenExportTelemetrySettles();
        expect((await whenExportEnds(submitted.job_id))?.state).toBe(succeeds ? "done" : "failed");
        const history = useExportJob.getState().calibrations;
        expect(history).toHaveLength(Number(succeeds));
        if (succeeds) {
          expect(await fs.readBytes(DEST)).toEqual(new Uint8Array([1, 2, 3]));
          expect(history[0]).toMatchObject({
            elapsedSeconds: 16,
            finalBytes: 3,
            memoryBytes: null,
            temporaryBytes: null,
          });
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { known: true, succeeds: true },
    { known: true, succeeds: false },
    { known: false, succeeds: true },
    { known: false, succeeds: false },
  ])(
    "uses the same checked readiness for known=$known success=$succeeds",
    async ({ known, succeeds }) => {
      const { fs, store } = make();
      await whenExportTelemetrySettles();
      exportBeacon.mockClear();
      if (known) {
        vi.spyOn(host, "resolveExportResources").mockResolvedValue({
          total_memory_bytes: 16e9,
          available_memory_bytes: 8e9,
          scratch_free_bytes: 100e9,
          destination_free_bytes: 100e9,
          local_fast_candidate: false,
          budgets: { memoryBytes: 3.5e9, temporaryBytes: 18e9, executionSeconds: 28800 },
        });
        useExportJob.setState({
          calibrations: [
            {
              ...calibration,
              elapsedSeconds: 16,
              finalBytes: 100,
              memoryBytes: 1024,
              temporaryBytes: 4096,
            },
          ],
        });
      }
      let captured: string | undefined;
      const submitted = await submitExport({
        store,
        destPath: DEST,
        stagePath: STAGE,
        filename: "final.mp4",
        workload: calibration.workload,
        meta: {
          duration_s: 10,
          width: 1920,
          height: 1080,
          fps: 30,
          quality: "medium",
          project_id: "",
          calibration,
          readiness: known ? "not_ready" : "ready",
        },
        run: async (_, _id, meta) => {
          captured = meta?.readiness;
          if (!succeeds) throw new Error("encoder failed after source admission");
          await fs.writeBytes(STAGE, new Uint8Array([1, 2, 3]));
          return {};
        },
      });
      await whenExportsSettle();
      await whenExportTelemetrySettles();
      expect((await whenExportEnds(submitted.job_id))?.state).toBe(succeeds ? "done" : "failed");
      expect(captured).toBe(known ? "ready" : "unknown");
      expect(exportBeacon).toHaveBeenCalledTimes(1);
      expect(exportBeacon.mock.calls[0][0]).toMatchObject({
        status: succeeds ? "done" : "failed",
        readiness: captured,
      });
      expect(await fs.exists(DEST)).toBe(succeeds);
    },
  );

  it.each([0, 4096, null, -1, "4096"])(
    "keeps only valid native temporary-payload observations: %s",
    async (peak) => {
      const { fs, store } = make();
      const jobs = new FakeJobs();
      vi.useFakeTimers({ now: 5000 });
      try {
        const submitted = await submitExport({
          store,
          supervisor: jobs,
          destPath: DEST,
          stagePath: STAGE,
          filename: "final.mp4",
          workload: calibration.workload,
          meta: {
            duration_s: 10,
            width: 1920,
            height: 1080,
            fps: 30,
            quality: "medium",
            project_id: "",
            calibration,
          },
          run: async (_, id) => {
            await jobs.submit({ id, lane: "measurement", program: "ffmpeg", args: [], meta: {} });
            vi.setSystemTime(21000);
            jobs.exit(
              id,
              0,
              `native render resident: {"sampled_peak":1024}\nnative render temporary: ${JSON.stringify({ accounted_peak_payload_bytes: peak })}\n`,
            );
            await fs.writeBytes(STAGE, new Uint8Array([1, 2, 3]));
            return {};
          },
        });
        await whenExportsSettle();
        await whenExportTelemetrySettles();
        expect((await whenExportEnds(submitted.job_id))?.state).toBe("done");
        expect(await fs.readBytes(DEST)).toEqual(new Uint8Array([1, 2, 3]));
        expect(useExportJob.getState().calibrations[0]).toMatchObject({
          elapsedSeconds: 16,
          memoryBytes: 1024,
          temporaryBytes: typeof peak === "number" && peak >= 0 ? peak : null,
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("waits for one batch decision before reserving or writing anything", async () => {
    const { fs, store } = make();
    let decide!: (choice: ExportConfirmation) => void;
    let requests = 0;
    __setExportConfirmationForTests(async () => {
      requests++;
      return new Promise<ExportConfirmation>((resolve) => {
        decide = resolve;
      });
    });
    const paths = [DEST, "C:/out/second.mp4"];
    const pending = submitExports(
      paths.map((destPath) => ({
        store,
        dependencies: [],
        destPath,
        stagePath: `${destPath}.part`,
        filename: "movie.mp4",
        run: async () => {
          await fs.writeBytes(`${destPath}.part`, new Uint8Array([1, 2, 3]));
          return {};
        },
      })),
    );
    await vi.waitFor(() => expect(requests).toBe(1));
    expect(listExportRecords()).toHaveLength(0);
    expect(paths.some(isDestinationReserved)).toBe(false);
    expect(fs.files.size + fs.bytes.size).toBe(0);
    decide("continue");
    expect(await pending).toHaveLength(2);
    await whenExportsSettle();
    expect(requests).toBe(1);
    for (const path of paths) expect(await fs.readBytes(path)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it.each(["cancel", "unavailable"] as const)(
    "admits no job or output after %s, for a request whose project details are unavailable",
    async (choice) => {
      const { fs, store } = make();
      const run = vi.fn(async () => ({}));
      __setExportConfirmationForTests(async () => choice);
      await expect(
        submitExport({
          store,
          destPath: DEST,
          stagePath: STAGE,
          filename: "final.mp4",
          run,
        }),
      ).rejects.toThrow(
        choice === "cancel" ? "cancelled before submission" : "could not be confirmed",
      );
      expect(run).not.toHaveBeenCalled();
      expect(listExportRecords()).toHaveLength(0);
      expect(isDestinationReserved(DEST)).toBe(false);
      expect(fs.files.size + fs.bytes.size).toBe(0);
    },
  );

  it("does not admit a request aborted while its confirmation was open", async () => {
    const { fs, store } = make();
    const controller = new AbortController();
    let decide!: (choice: ExportConfirmation) => void;
    __setExportConfirmationForTests(
      () =>
        new Promise<ExportConfirmation>((resolve) => {
          decide = resolve;
        }),
    );
    const run = vi.fn(async () => ({}));
    const pending = submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      submissionSignal: controller.signal,
      run,
    });
    await vi.waitFor(() => expect(decide).toBeTypeOf("function"));
    controller.abort();
    decide("continue");
    await expect(pending).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    expect(listExportRecords()).toHaveLength(0);
    expect(fs.files.size + fs.bytes.size).toBe(0);
  });

  it("does not admit an old-session request after the project closes during confirmation", async () => {
    const { fs, store } = make();
    let decide!: (choice: ExportConfirmation) => void;
    __setExportConfirmationForTests(
      () =>
        new Promise<ExportConfirmation>((resolve) => {
          decide = resolve;
        }),
    );
    const run = vi.fn(async () => ({}));
    const pending = submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run,
    });
    await vi.waitFor(() => expect(decide).toBeTypeOf("function"));
    endProjectSession(DIR);
    decide("continue");
    await expect(pending).rejects.toThrow("cancelled before submission");
    expect(run).not.toHaveBeenCalled();
    expect(listExportRecords()).toHaveLength(0);
    expect(fs.files.size + fs.bytes.size).toBe(0);
  });

  it("cancels native intent when preparation returns after cancellation was ignored", async () => {
    const { fs, store } = make();
    const controller = new AbortController();
    const delivery = localDeliveryPort(store);
    const prepare = delivery.prepare;
    delivery.prepare = async (...args) => {
      const result = await prepare(...args);
      controller.abort();
      return result;
    };
    const jobs = new FakeJobs();
    jobs.delivery = delivery;
    const run = vi.fn(async () => ({}));
    await expect(
      submitExport({
        store,
        destPath: DEST,
        stagePath: STAGE,
        filename: "final.mp4",
        supervisor: jobs,
        submissionSignal: controller.signal,
        run,
      }),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    const intents = await delivery.list();
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ state: "cancelled", followups_done: true });
    expect(isDestinationReserved(DEST)).toBe(false);
    expect(await fs.exists(DEST)).toBe(false);
  });

  it("retains earlier accepted job identities when a later native admission fails", async () => {
    const { fs, store } = make();
    const delivery = localDeliveryPort(store);
    const prepare = delivery.prepare;
    let preparations = 0;
    delivery.prepare = async (...args) => {
      if (++preparations === 2) throw new Error("second native admission refused");
      return prepare(...args);
    };
    const jobs = new FakeJobs();
    jobs.delivery = delivery;
    const paths = [DEST, "C:/out/second.mp4"];
    const failure = await submitExports(
      paths.map((destPath) => ({
        store,
        supervisor: jobs,
        dependencies: [],
        destPath,
        stagePath: `${destPath}.part`,
        filename: "movie.mp4",
        run: async () => {
          await fs.writeBytes(`${destPath}.part`, new Uint8Array([1, 2, 3]));
          return {};
        },
      })),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ExportRequestError);
    expect((failure as ExportRequestError).submitted).toHaveLength(1);
    const first = (failure as ExportRequestError).submitted[0];
    await whenExportsSettle();
    expect((await whenExportEnds(first.job_id))?.state).toBe("done");
    expect(await fs.readBytes(DEST)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await fs.exists(paths[1])).toBe(false);
  });
});

describe("export queue", () => {
  describe("whenExportEnds", () => {
    // submitExport answers as soon as the render is QUEUED. A caller that reads that as the
    // outcome shows 100% while ffmpeg is still encoding, so this is how a caller waits for the
    // real end without polling.
    it("stays pending while the render is running, then reports how it ended", async () => {
      const { fs, store } = make();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const sub = await submitExport({
        store,
        destPath: DEST,
        stagePath: STAGE,
        filename: "final.mp4",
        run: async () => {
          await gate;
          await fs.writeBytes(STAGE, new Uint8Array([1]));
          return {};
        },
      });

      let ended: unknown = "pending";
      void whenExportEnds(sub.job_id).then((r) => (ended = r));
      await Promise.resolve();
      expect(ended, "resolved before the encode finished").toBe("pending");

      release();
      await whenExportsSettle();
      await Promise.resolve();
      expect((ended as { state?: string })?.state).toBe("done");
    });

    it("reports a render that failed, so a caller cannot call it delivered", async () => {
      const { store } = make();
      const sub = await submitExport({
        store,
        destPath: DEST,
        stagePath: STAGE,
        filename: "final.mp4",
        run: async () => {
          throw new Error("no such encoder");
        },
      });
      await whenExportsSettle();
      const ended = await whenExportEnds(sub.job_id);
      expect(ended?.state).toBe("failed");
      expect(ended?.error).toMatch(/no such encoder/);
    });

    it("answers immediately for a job that already ended", async () => {
      const { fs, store } = make();
      const sub = await submitExport({
        store,
        destPath: DEST,
        stagePath: STAGE,
        filename: "final.mp4",
        run: async () => {
          await fs.writeBytes(STAGE, new Uint8Array([1]));
          return {};
        },
      });
      await whenExportsSettle();
      expect((await whenExportEnds(sub.job_id))?.state).toBe("done");
    });

    it("answers null for a job it does not have, rather than hanging forever", async () => {
      expect(await whenExportEnds("no-such-job")).toBeNull();
    });
  });

  it("returns before the encode has run", async () => {
    const { fs, store } = make();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const sub = await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => {
        await gate;
        await fs.writeBytes(STAGE, new Uint8Array([1, 2, 3]));
        return {};
      },
    });

    expect(sub.job_id).toBeTruthy();
    expect(await fs.exists(DEST)).toBe(false); // nothing written yet ΓÇö the turn is free
    release();
    await whenExportsSettle();
    expect(await fs.exists(DEST)).toBe(true);
  });

  // The whole reason for staging: a failed export must not replace a good file with a broken one.
  it("leaves a previous export untouched when the encode fails", async () => {
    const { fs, store } = make();
    await fs.writeBytes(DEST, new Uint8Array([9, 9, 9]));
    let ran = false;

    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => {
        ran = true;
        await fs.writeBytes(STAGE, new Uint8Array([1])); // a partial encode
        throw new Error("ffmpeg died");
      },
    });
    await whenExportsSettle();

    expect(ran).toBe(true); // or the rest of this test proves nothing
    expect([...(await fs.readBytes(DEST))]).toEqual([9, 9, 9]); // the OLD file, intact
    expect(await fs.exists(STAGE)).toBe(false); // and no litter left behind
  });

  it("never leaves the half-written file at the destination", async () => {
    const { fs, store } = make();
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => {
        await fs.writeBytes(STAGE, new Uint8Array([1]));
        throw new Error("ffmpeg died");
      },
    });
    await whenExportsSettle();

    expect(await fs.exists(DEST)).toBe(false);
  });

  it("refuses a second export to a destination already queued", async () => {
    const { store } = make();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Awaited: the reservation is taken after the ledger write, not synchronously on call.
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => {
        await gate;
        return {};
      },
    });

    expect(isDestinationReserved(DEST)).toBe(true);
    expect(isDestinationReserved("c:\\out\\final.mp4")).toBe(true); // same file, other spelling
    expect(isDestinationReserved("C:/out/other.mp4")).toBe(false);

    release();
    await whenExportsSettle();
    expect(isDestinationReserved(DEST)).toBe(false); // and released once it settles
  });

  // The failure ordering the other tests skip: the encode SUCCEEDS and the COMMIT fails. On
  // Windows that is an ordinary Tuesday ΓÇö the user still has the previous export open in a
  // player, so the destination cannot be replaced. Failing here must not destroy the file they
  // are watching, and must not leave a .part in their Downloads folder.
  it("a destination locked by another program fails the job and leaves the old file alone", async () => {
    const { fs, store } = make();
    await fs.writeBytes(DEST, new Uint8Array([9, 9, 9])); // the export they have open
    const realRename = fs.rename.bind(fs);
    fs.rename = async (from: string, to: string) => {
      if (joinPath(to) === joinPath(DEST))
        throw new Error(
          "The process cannot access the file because it is being used by another process. (os error 32)",
        );
      return realRename(from, to);
    };
    let encoded = false;

    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      origin: AGENT,
      run: async () => {
        encoded = true;
        await fs.writeBytes(STAGE, new Uint8Array([1, 2, 3])); // a COMPLETE encode
        return {};
      },
    });
    await whenExportsSettle();

    expect(encoded).toBe(true); // the commit is what failed, not the render
    expect([...(await fs.readBytes(DEST))]).toEqual([9, 9, 9]); // still the file they are watching
    expect(await fs.exists(STAGE)).toBe(false); // no .part litter next to it
    const note = pendingJobNotes(DIR).at(-1) as Any;
    expect(note.status).toBe("failed"); // and it is not reported as a success
    expect(note.error).toContain("another process");
  });

  it("lets the user retry to the same destination after a failed commit", async () => {
    // The reservation is released in a `finally`, so a failure must not permanently burn the
    // filename. Without this the obvious fix ΓÇö close the player, export again ΓÇö would be
    // refused as "already queued" until the app restarted.
    const { fs, store } = make();
    let failNext = true;
    const realRename = fs.rename.bind(fs);
    fs.rename = async (from: string, to: string) => {
      if (failNext && joinPath(to) === joinPath(DEST)) throw new Error("os error 32");
      return realRename(from, to);
    };

    const spec = () => ({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      origin: AGENT,
      run: async () => {
        await fs.writeBytes(STAGE, new Uint8Array([7]));
        return {};
      },
    });
    await submitExport(spec());
    await whenExportsSettle();
    expect(await fs.exists(DEST)).toBe(false);
    expect(isDestinationReserved(DEST)).toBe(false); // released, not burned

    failNext = false; // they closed the player
    await submitExport(spec());
    await whenExportsSettle();
    expect([...(await fs.readBytes(DEST))]).toEqual([7]);
    expect((pendingJobNotes(DIR).at(-1) as Any).status).toBe("done");
  });

  it("runs one encode at a time", async () => {
    const { store } = make();
    let live = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const spec = (i: number) => ({
      store,
      destPath: `C:/out/f${i}.mp4`,
      stagePath: `C:/out/f${i}.mp4.part`,
      filename: `f${i}.mp4`,
      run: async () => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise<void>((r) => releases.push(r));
        live -= 1;
        return {};
      },
    });
    await submitExport(spec(1));
    await submitExport(spec(2));
    await submitExport(spec(3));
    await new Promise((r) => setTimeout(r, 0));

    expect(releases).toHaveLength(1); // the other two are waiting, not encoding
    while (releases.length) {
      releases.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
    await whenExportsSettle();
    expect(peak).toBe(1);
  });

  // 4i: the indexer yields to exports, including between two queued ones.
  it("keeps the indexer's next job waiting while any export is queued or running", async () => {
    const { store } = make();
    const releases: (() => void)[] = [];
    const spec = (i: number) => ({
      store,
      destPath: `C:/out/g${i}.mp4`,
      stagePath: `C:/out/g${i}.mp4.part`,
      filename: `g${i}.mp4`,
      run: async () => {
        await new Promise<void>((r) => releases.push(r));
        return {};
      },
    });
    await submitExport(spec(1));
    await submitExport(spec(2));
    let turn: unknown = "waiting";
    void backgroundTurn("whisper").then((r) => (turn = r));
    await new Promise((r) => setTimeout(r, 0));
    expect(releases).toHaveLength(1);
    releases.shift()!(); // the first ends; the queued one starts
    await new Promise((r) => setTimeout(r, 0));
    expect(releases).toHaveLength(1);
    expect(turn).toBe("waiting");
    releases.shift()!();
    await whenExportsSettle();
    await new Promise((r) => setTimeout(r, 0));
    expect(typeof turn).toBe("function");
  });

  it("tells the chat where the file went, and why it failed", async () => {
    const { fs, store } = make();
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      origin: AGENT,
      run: async () => {
        await fs.writeBytes(STAGE, new Uint8Array([1]));
        return { warnings: ["a font was missing"] };
      },
    });
    await whenExportsSettle();
    const ok = pendingJobNotes(DIR).at(-1) as Any;
    expect(ok.status).toBe("done");
    expect(ok.detail).toContain("final.mp4");
    expect(ok.detail).toContain("a font was missing");

    __resetJobNotes();
    await submitExport({
      store,
      destPath: "C:/out/two.mp4",
      stagePath: "C:/out/two.mp4.part",
      filename: "two.mp4",
      origin: AGENT,
      run: async () => {
        throw new Error("ffmpeg died");
      },
    });
    await whenExportsSettle();
    const bad = pendingJobNotes(DIR).at(-1) as Any;
    expect(bad.status).toBe("failed");
    expect(bad.error).toContain("ffmpeg died");
  });

  // The Export menu and an external MCP agent run this very tool, so before the queue carried an
  // origin their exports resumed the chat with "background work YOU started ... continue what you
  // were doing" ΓÇö and the woken model then edited a timeline the other driver was editing.
  it("does not resume the chat for an export it did not start", async () => {
    const { fs, store } = make();
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4", // no origin: the Export menu, or an MCP client
      run: async () => {
        await fs.writeBytes(STAGE, new Uint8Array([1]));
        return {};
      },
    });
    await whenExportsSettle();

    expect(await fs.exists(DEST)).toBe(true); // the export itself is unaffected
    expect(listExportRecords().at(-1)).toMatchObject({ state: "done" }); // and the UI still sees it
    expect(pendingJobNotes(DIR)).toHaveLength(0); // only the conversation is left alone
  });

  it("does not resume the chat when someone else's export fails either", async () => {
    const { store } = make();
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => {
        throw new Error("ffmpeg died");
      },
    });
    await whenExportsSettle();

    expect(listExportRecords().at(-1)).toMatchObject({ state: "failed" });
    expect(pendingJobNotes(DIR)).toHaveLength(0);
  });

  it("records the job before the encode, and settles it after", async () => {
    const { fs, store } = make();
    const jobs = async () =>
      JSON.parse(await fs.readTextFile(joinPath(DIR, "internals/jobs.json"))).jobs as Any[];

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sub = await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => {
        await gate;
        await fs.writeBytes(STAGE, new Uint8Array([1]));
        return {};
      },
    });

    // On disk while it is still encoding, so a crash leaves evidence the export was attempted.
    expect((await jobs()).find((j) => j.id === sub.job_id)).toMatchObject({
      kind: "export",
      status: "running",
    });
    release();
    await whenExportsSettle();
    expect((await jobs()).find((j) => j.id === sub.job_id)?.status).toBe("done");
  });

  it("commits by rename rather than rewriting the destination", async () => {
    const { fs, store } = make();
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => {
        await fs.writeBytes(STAGE, new Uint8Array([7]));
        return {};
      },
    });
    await whenExportsSettle();
    expect(commits(fs)).toEqual([[joinPath(STAGE), joinPath(DEST)]]);
  });

  it("refuses direct-to-destination output without touching the old file", async () => {
    const { fs, store } = make();
    await fs.writeBytes(DEST, new Uint8Array([9]));
    await expect(
      submitExport({
        store,
        destPath: DEST,
        stagePath: DEST, // no rename support upstream
        filename: "final.mp4",
        run: async () => {
          await fs.writeBytes(DEST, new Uint8Array([7]));
          return {};
        },
      }),
    ).rejects.toThrow("direct-output fallback is not supported");
    await whenExportsSettle();
    expect(commits(fs)).toEqual([]);
    expect(await fs.exists(DEST)).toBe(true);
    expect(await fs.readBytes(DEST)).toEqual(new Uint8Array([9]));
  });

  // Making the export outlive its turn removed the only way to stop one. These prove the
  // replacement actually stops it, rather than just returning a cheerful boolean.
  it("stops a running encode and leaves no file behind", async () => {
    const { fs, store } = make();
    let sawAbort = false;
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));

    const sub = await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      origin: AGENT,
      run: async (signal) => {
        await fs.writeBytes(STAGE, new Uint8Array([1])); // a partial encode on disk
        started();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        sawAbort = true;
        throw new Error("ffmpeg killed");
      },
    });
    await running;

    expect(cancelExport(sub.job_id)).toBe(true);
    await whenExportsSettle();

    expect(sawAbort).toBe(true); // the signal really reached the encoder
    expect(await fs.exists(DEST)).toBe(false);
    expect(await fs.exists(STAGE)).toBe(false); // and the partial file is cleaned up
    // A cancel the user asked for is not a failure, so no "export failed" note is posted at all —
    // the ledger still records what happened, under its own state.
    expect(pendingJobNotes(DIR).at(-1)).toBeUndefined();
    const row = (((await manageExportsTool({ action: "list" })) as Any).exports as Any[]).find(
      (r) => r.job_id === sub.job_id,
    );
    expect(row?.state).toBe("cancelled");
  });

  it("never starts an encode that was cancelled while queued", async () => {
    const { store } = make();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "first.mp4",
      run: async () => {
        await gate;
        return {};
      },
    });
    let secondRan = false;
    const second = await submitExport({
      store,
      destPath: "C:/out/second.mp4",
      stagePath: "C:/out/second.mp4.part",
      filename: "second.mp4",
      run: async () => {
        secondRan = true;
        return {};
      },
    });

    expect(cancelExport(second.job_id)).toBe(true);
    release();
    await whenExportsSettle();

    expect(secondRan).toBe(false); // cancelled before its turn came up
  });

  it("reports nothing to cancel once the export has finished", async () => {
    const { store } = make();
    const sub = await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => ({}),
    });
    await whenExportsSettle();
    expect(cancelExport(sub.job_id)).toBe(false);
    expect(listExports()).toEqual([]);
  });

  it("keeps the queue moving after a failure", async () => {
    const { store } = make();
    let second = false;
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => {
        throw new Error("boom");
      },
    });
    await submitExport({
      store,
      destPath: "C:/out/second.mp4",
      stagePath: "C:/out/second.mp4.part",
      filename: "second.mp4",
      run: async () => {
        second = true;
        return {};
      },
    });
    await whenExportsSettle();
    expect(second).toBe(true);
  });
});

// The tool is the ONLY route to cancellation ΓÇö without it an async export can be started and
// never stopped, which the synchronous version could do.
describe("manage_exports", () => {
  it("lists what is still rendering, and keeps the row once it lands", async () => {
    const { store } = make();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sub = await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => {
        await gate;
        return {};
      },
    });

    const listed = (await manageExportsTool({})) as Any;
    expect(listed.ok).toBe(true);
    expect(listed.exports).toEqual([
      {
        job_id: sub.job_id,
        filename: "final.mp4",
        state: "running",
        elapsed_s: expect.any(Number),
        // Added in Phase 3 (S2): where the run is. Nothing else is said about a run that has not
        // made progress yet.
        stage: "preparing",
      },
    ]);

    release();
    await whenExportsSettle();
    // A settled export STAYS listed, with its outcome. This used to assert `[]` ΓÇö which pinned the
    // defect: over MCP nothing wakes a finished turn, so `list` is the only way an agent can learn
    // what happened, and an empty list is indistinguishable from success. A render that died read
    // as a clean run for the whole of one benchmark.
    const after = ((await manageExportsTool({ action: "list" })) as Any).exports as Any[];
    expect(after).toHaveLength(1);
    expect(after[0].job_id).toBe(sub.job_id);
    expect(["done", "failed"]).toContain(after[0].state);
  });

  it("reports a FAILED export's reason through the tool, not just its absence", async () => {
    const { store } = make();
    const sub = await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "boom.mp4",
      run: async () => {
        throw new Error("ffmpeg render failed (code=-28): No space left on device");
      },
    });
    await whenExportsSettle();
    const row = (((await manageExportsTool({ action: "list" })) as Any).exports as Any[]).find(
      (r) => r.job_id === sub.job_id,
    );
    expect(row?.state).toBe("failed");
    expect(String(row?.error)).toContain("code=-28");
  });

  it("cancels a running export through the tool", async () => {
    const { fs, store } = make();
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const sub = await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async (signal) => {
        started();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        throw new Error("ffmpeg killed");
      },
    });
    await running;

    const r = (await manageExportsTool({ action: "cancel", job_id: sub.job_id })) as Any;
    expect(r.ok).toBe(true);
    expect(r.cancelled).toBe(true);
    await whenExportsSettle();
    expect(await fs.exists(DEST)).toBe(false); // it really stopped, not just reported so
  });

  // A finished export is not a failure to report ΓÇö the file is on disk.
  it("says plainly that a finished export cannot be cancelled", async () => {
    const { fs, store } = make();
    // The run must really deliver: an encode that writes nothing FAILS at commit, and this test
    // passed on such a run for as long as every late cancel was answered "already finished".
    const sub = await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => {
        await fs.writeBytes(STAGE, new Uint8Array([1]));
        return {};
      },
    });
    await whenExportsSettle();
    expect(await fs.exists(DEST)).toBe(true);
    const r = (await manageExportsTool({ action: "cancel", job_id: sub.job_id })) as Any;
    expect(r.ok).toBe(true);
    expect(r.cancelled).toBe(false);
    expect(r.state).toBe("done");
    expect(String(r.note)).toContain("already finished");
  });

  it("refuses a cancel with no job_id, and an unknown action", async () => {
    expect(((await manageExportsTool({ action: "cancel" })) as Any).ok).toBe(false);
    expect(((await manageExportsTool({ action: "pause" })) as Any).ok).toBe(false);
  });

  it("cancelling an id that never existed is refused, not silently claimed", async () => {
    const r = (await manageExportsTool({ action: "cancel", job_id: "nope" })) as Any;
    expect(r.ok).toBe(false);
    expect(r.cancelled).not.toBe(true);
    expect(String(r.error)).toMatch(/no export/i);
    expect(JSON.stringify(r)).not.toMatch(/finished/);
  });

  // QA 2026-10-07: a second cancel of an export the first had stopped answered "that export had
  // already finished" — telling the agent a file was delivered when none was. Every settled state
  // must be named as what it is.
  it("says a cancelled export was cancelled, and a failed one failed — never that it finished", async () => {
    const { store } = make();
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const stopped = await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async (signal) => {
        started();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        throw new Error("ffmpeg killed");
      },
    });
    await running;
    expect(
      ((await manageExportsTool({ action: "cancel", job_id: stopped.job_id })) as Any).cancelled,
    ).toBe(true);
    await whenExportsSettle();
    const again = (await manageExportsTool({ action: "cancel", job_id: stopped.job_id })) as Any;
    expect(again).toMatchObject({ ok: true, cancelled: false, state: "cancelled" });
    expect(String(again.note)).toMatch(/already cancelled/);
    expect(String(again.note)).not.toMatch(/finished/);

    const failed = await submitExport({
      store,
      destPath: "C:/out/boom.mp4",
      stagePath: "C:/out/boom.mp4.part",
      filename: "boom.mp4",
      run: async () => {
        throw new Error("ffmpeg render failed (code=-28): No space left on device");
      },
    });
    await whenExportsSettle();
    const late = (await manageExportsTool({ action: "cancel", job_id: failed.job_id })) as Any;
    expect(late).toMatchObject({ ok: true, cancelled: false, state: "failed" });
    expect(String(late.note)).toMatch(/already failed/);
    expect(String(late.note)).not.toMatch(/finished/);
  });

  it("persists ffmpeg diagnostics when validation refuses the staged artifact", async () => {
    const { fs, store } = make();
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => {
        await fs.writeBytes(STAGE, new Uint8Array([1]));
        throw new ExportRunError(
          "rendered audio failed validation",
          "Non-monotonic DTS; previous: 9223372036854775498",
        );
      },
    });
    await whenExportsSettle();

    expect(await fs.exists(DEST)).toBe(false);
    expect(await fs.exists(STAGE)).toBe(false);
    expect(listExportRecords().at(-1)).toMatchObject({
      state: "failed",
      error: "rendered audio failed validation",
      stderrTail: expect.stringContaining("Non-monotonic DTS"),
    });
    const jobs = JSON.parse(await fs.readTextFile(joinPath(DIR, "internals/jobs.json")))
      .jobs as Any[];
    expect(jobs.at(-1)).toMatchObject({
      status: "failed",
      stderr_tail: expect.stringContaining("Non-monotonic DTS"),
    });
  });

  it("does not let cancellation during cleanup hide an established render failure", async () => {
    const { fs, store } = make();
    let cleanupStarted!: () => void;
    let finishCleanup!: () => void;
    const cleaning = new Promise<void>((resolve) => (cleanupStarted = resolve));
    const cleanupGate = new Promise<void>((resolve) => (finishCleanup = resolve));
    const realRemove = fs.remove.bind(fs);
    fs.remove = async (path: string) => {
      if (joinPath(path) === joinPath(STAGE)) {
        cleanupStarted();
        await cleanupGate;
      }
      await realRemove(path);
    };

    const sub = await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => {
        await fs.writeBytes(STAGE, new Uint8Array([1]));
        throw new ExportRunError("render validation failed", "Non-monotonic DTS");
      },
    });
    await cleaning;
    expect(cancelExport(sub.job_id)).toBe(true);
    finishCleanup();
    await whenExportsSettle();

    expect(listExportRecords().at(-1)).toMatchObject({
      state: "failed",
      error: "render validation failed",
      stderrTail: "Non-monotonic DTS",
    });
    const jobs = JSON.parse(await fs.readTextFile(joinPath(DIR, "internals/jobs.json")))
      .jobs as Any[];
    expect(jobs.find((j) => j.id === sub.job_id)).toMatchObject({
      status: "failed",
      error: "render validation failed",
      stderr_tail: "Non-monotonic DTS",
    });
  });
});

describe("whose export it is reported as", () => {
  const person = (id: string) => ({
    user_id: id,
    email: "",
    display_name: "",
    image_url: "",
    metered: true,
  });
  const meta = {
    duration_s: 10,
    width: 1920,
    height: 1080,
    fps: 30,
    quality: "medium",
    project_id: "",
  };

  it("is the account that asked for it, even when a different one is signed in as it ends", async () => {
    const { fs, store } = make();
    await whenExportTelemetrySettles();
    exportBeacon.mockClear();
    useAuth.setState({ profile: person("user_alice") });
    let release!: () => void;
    const rendering = new Promise<void>((resolve) => (release = resolve));
    let stamped: string | undefined;
    const submitted = await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      meta,
      run: async (_, _id, runMeta) => {
        stamped = runMeta?.owner;
        await rendering;
        await fs.writeBytes(STAGE, new Uint8Array([1, 2, 3]));
        return {};
      },
    });
    useAuth.setState({ profile: person("user_bob") }); // while it renders, somebody else signs in
    release();
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    expect((await whenExportEnds(submitted.job_id))?.state).toBe("done");
    expect(stamped).toBe("user_alice"); // carried in the job's own record, so a restart keeps it too
    expect(exportBeacon.mock.calls[0][0]).toMatchObject({ status: "done", owner: "user_alice" });
  });

  it("names nobody when nobody is known, rather than guessing", async () => {
    const { fs, store } = make();
    await whenExportTelemetrySettles();
    exportBeacon.mockClear();
    let stamped: unknown = "unset";
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      meta,
      run: async (_, _id, runMeta) => {
        stamped = runMeta?.owner;
        await fs.writeBytes(STAGE, new Uint8Array([1]));
        return {};
      },
    });
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    expect(stamped).toBeUndefined();
    expect(exportBeacon.mock.calls[0][0]).not.toHaveProperty("owner", expect.anything());
  });
});

// The questions an export asks before it starts (Phase 3, S2): not enough free memory, not enough room
// on a drive, a heads-up about a very long export. Each test plays what the person does with the dialog
// (the real question store and the real answer function, as the dialog and the card use them) and checks
// what happened to the EXPORT: whether it started, what was measured, what was left behind, what the
// report says.
describe("the questions an export asks before it starts", () => {
  const GB = 1e9;
  const calibration: Pick<
    ExportCalibration,
    "workload" | "output" | "quality" | "engine" | "revision"
  > = {
    workload: {
      width: 1920,
      height: 1080,
      fps: 30,
      durationSeconds: 10,
      visualClips: 14,
      captionClips: 2,
      audioClips: 1,
      peakVisualLayers: 8,
      peakMediaLayers: 7,
    },
    output: { width: 1920, height: 1080, fps: 30 },
    quality: "medium",
    engine: "partition-pipes-v1",
    revision: EXPORT_SPEED_REVISION,
  };
  const roomy = {
    total_memory_bytes: 16 * GB,
    available_memory_bytes: 12 * GB,
    local_fast_candidate: false,
    scratch_free_bytes: 500 * GB,
    destination_free_bytes: 500 * GB,
    budgets: { memoryBytes: 8 * GB, temporaryBytes: 18 * GB, executionSeconds: 28_800 },
  };
  let pc: host.ExportResources = roomy;
  let measured = 0;
  let unmountHost: () => void = () => undefined;
  const shown = () => useExportQuestions.getState().open?.question;
  const answer = (
    choice: "continue" | "start_anyway" | "cancel",
    by: "dialog" | "card" = "dialog",
  ) => answerQuestion(useExportQuestions.getState().open!.id, choice, by);
  const lastReport = (): Any => exportBeacon.mock.calls.at(-1)![0];
  const story = (report: Any): string[] =>
    report.trace.map((e: Any) => (e.v ? `${e.e}:${e.v}` : e.e));

  async function scene(opts: {
    pc?: Partial<host.ExportResources>;
    history?: Partial<ExportCalibration>;
    /** Replace the history entirely (a PC that has never exported this shape). */
    calibrations?: ExportCalibration[];
    /** What the command was captured at: the rung the plan chose when the export was prepared. */
    plan?: { rung: 0 | 1 | 2 };
    via?: "menu" | "chat" | "mcp";
    duration?: number;
    signal?: AbortSignal;
    count?: number;
  }) {
    const { fs, store } = make();
    await whenExportTelemetrySettles();
    exportBeacon.mockClear();
    pc = { ...roomy, ...opts.pc };
    measured = 0;
    vi.spyOn(host, "resolveExportResources").mockImplementation(async () => {
      measured++;
      return pc;
    });
    useExportJob.setState({
      calibrations: opts.calibrations ?? [
        {
          ...calibration,
          elapsedSeconds: 10,
          finalBytes: 1 * GB,
          memoryBytes: 1 * GB,
          temporaryBytes: 1 * GB,
          ...opts.history,
        },
      ],
    });
    useExportQuestions.setState({ open: null });
    if (!hostMounted()) unmountHost = mountQuestionHost();
    let ran = 0;
    const workload = { ...calibration.workload, durationSeconds: opts.duration ?? 10 };
    const specs = Array.from({ length: opts.count ?? 1 }, (_, index) => {
      const destPath = index === 0 ? DEST : `C:/out/second-${index}.mp4`;
      return {
        store,
        dependencies: [],
        destPath,
        stagePath: `${destPath}.part`,
        filename: "movie.mp4",
        workload,
        via: opts.via ?? ("chat" as const),
        ...(opts.signal ? { submissionSignal: opts.signal } : {}),
        meta: {
          duration_s: workload.durationSeconds,
          width: 1920,
          height: 1080,
          fps: 30,
          quality: "medium",
          project_id: "",
          calibration,
          ...(opts.plan ? { plan: opts.plan } : {}),
        },
        run: async () => {
          ran++;
          await fs.writeBytes(`${destPath}.part`, new Uint8Array([1, 2, 3]));
          return {};
        },
      };
    });
    const pending = submitExports(specs).then(
      () => "started" as const,
      (error: unknown) => error as ExportRequestError,
    );
    return { fs, store, pending, ran: () => ran };
  }

  /** Nothing is left behind by a request that never started. */
  const leftNothing = (): void => {
    expect(listExportRecords()).toHaveLength(0);
    expect(isDestinationReserved(DEST)).toBe(false);
  };

  it("asks about memory in the dialog, with what is needed and what is there, and starts nothing while it waits", async () => {
    // Captured at the gentlest rung (nothing fitted 1.9 GB free): the need is that rung's peak, 3.2 GB
    // measured at the normal rung times 0.5, over the 75% of free memory an export may use.
    const run = await scene({
      pc: { available_memory_bytes: 1.9 * GB },
      history: { memoryBytes: 3.2 * GB },
      plan: { rung: 2 },
    });
    await vi.waitFor(() => expect(shown()?.kind).toBe("memory"));
    expect(shown()?.facts).toEqual([
      { label: "Needed", value: "about 2.2 GB" },
      { label: "Available now", value: "about 1.9 GB" },
    ]);
    expect(run.ran()).toBe(0);
    expect(listExportRecords()).toHaveLength(0);
    answer("cancel");
    const refusal = (await run.pending) as ExportRequestError;
    expect(refusal).toBeInstanceOf(ExportRequestError);
    expect(refusal.status).toBe("declined");
    expect(run.ran()).toBe(0);
    leftNothing();
  });

  it("measures the PC again after Continue, and starts once the memory is there", async () => {
    const run = await scene({
      pc: { available_memory_bytes: 1.9 * GB },
      history: { memoryBytes: 3.2 * GB },
    });
    await vi.waitFor(() => expect(shown()?.kind).toBe("memory"));
    expect(measured).toBe(1);
    pc = { ...pc, available_memory_bytes: 6 * GB }; // the person closed their browser
    answer("continue");
    expect(await run.pending).toBe("started");
    await whenExportsSettle();
    expect(measured).toBe(2);
    expect(run.ran()).toBe(1);
    expect(shown()).toBeUndefined();
  });

  it("asks the SAME question again, with the new numbers, when Continue did not make room", async () => {
    const run = await scene({
      pc: { available_memory_bytes: 1.9 * GB },
      history: { memoryBytes: 3.2 * GB },
    });
    await vi.waitFor(() => expect(shown()?.kind).toBe("memory"));
    pc = { ...pc, available_memory_bytes: 2.4 * GB }; // some memory freed, not enough
    answer("continue");
    await vi.waitFor(() => expect(measured).toBe(2));
    await vi.waitFor(() => expect(shown()?.facts[1].value).toBe("about 2.4 GB"));
    expect(shown()?.kind).toBe("memory");
    expect(run.ran()).toBe(0);
    answer("cancel");
    expect(((await run.pending) as ExportRequestError).status).toBe("declined");
    leftNothing();
  });

  describe("the memory question follows the plan (the rung the command was captured at)", () => {
    // History: this shape peaked at 3.2 GB at the normal rung.
    const normalPeak = { memoryBytes: 3.2 * GB };

    it("is not asked when the rung the export was captured at fits, though the normal rung would not", async () => {
      // 2.5 GB free is a 1.875 GB ceiling: the normal rung (3.2) does not fit, the gentlest (about 1.6) does.
      const run = await scene({
        pc: { available_memory_bytes: 2.5 * GB },
        history: normalPeak,
        plan: { rung: 2 },
      });
      expect(await run.pending).toBe("started");
      await whenExportsSettle();
      expect(shown()).toBeUndefined();
      expect(run.ran()).toBe(1);
    });

    it("is asked when the rung it was captured at does not fit now, with a 'Needed' above what is free", async () => {
      const run = await scene({
        pc: { available_memory_bytes: 2.5 * GB },
        history: normalPeak,
        plan: { rung: 0 }, // captured at the normal rung: that is what will run
      });
      await vi.waitFor(() => expect(shown()?.kind).toBe("memory"));
      expect(shown()?.facts).toEqual([
        { label: "Needed", value: "about 4.3 GB" }, // 3.2 GB peak, 75% of free memory may be used
        { label: "Available now", value: "about 2.5 GB" },
      ]);
      answer("cancel");
      expect(((await run.pending) as ExportRequestError).status).toBe("declined");
      leftNothing();
    });

    it("asks a first export on a PC that has never made this shape only when less than the reserve is free", async () => {
      const first = await scene({ pc: { available_memory_bytes: 1.5 * GB }, calibrations: [] });
      await vi.waitFor(() => expect(shown()?.kind).toBe("memory"));
      expect(shown()?.facts).toEqual([
        { label: "Needed", value: "about 2.0 GB" },
        { label: "Available now", value: "about 1.5 GB" },
      ]);
      answer("cancel");
      await first.pending;
      leftNothing();
      const second = await scene({ pc: { available_memory_bytes: 2.5 * GB }, calibrations: [] });
      expect(await second.pending).toBe("started");
      await whenExportsSettle();
      expect(shown()).toBeUndefined();
    });

    it("never contradicts itself: whenever it is asked, what is needed is more than what is available", async () => {
      for (const free of [0.3, 1, 1.9, 2.4]) {
        const run = await scene({
          pc: { available_memory_bytes: free * GB },
          history: { memoryBytes: 6 * GB },
          plan: { rung: 2 },
        });
        await vi.waitFor(() => expect(shown()?.kind).toBe("memory"));
        const [needed, available] = shown()!.facts.map((fact) => {
          const [, amount, unit] = /([\d.]+) (MB|GB)/.exec(fact.value)!;
          return Number(amount) * (unit === "GB" ? 1e9 : 1e6);
        });
        expect(needed).toBeGreaterThan(available);
        answer("cancel");
        await run.pending;
      }
    });

    it("is today's question exactly when the switch is off", async () => {
      __setExportFlag("plan_rung", false);
      try {
        // Today: asked only when the measured peak (3.2) is above the free memory (2.5), whatever the rung.
        const run = await scene({
          pc: { available_memory_bytes: 2.5 * GB },
          history: normalPeak,
          plan: { rung: 2 },
        });
        await vi.waitFor(() => expect(shown()?.kind).toBe("memory"));
        expect(shown()?.facts[0].value).toBe("about 3.2 GB");
        answer("cancel");
        await run.pending;
      } finally {
        __setExportFlag("plan_rung", true);
      }
    });

    it("tells the story which rung it ran at, and on what", async () => {
      const run = await scene({ pc: { available_memory_bytes: 12 * GB }, plan: { rung: 1 } });
      expect(await run.pending).toBe("started");
      await whenExportsSettle();
      await whenExportTelemetrySettles();
      const events = (lastReport().trace as Any[]).filter((e) => e.e === "plan_chosen");
      expect(events).toHaveLength(1);
      expect(events[0].v).toBe("gentle");
    });
  });

  it("gives up, instead of looping for ever, on a program that answers Continue to a shortage that never clears", async () => {
    const run = await scene({
      pc: { available_memory_bytes: 1.9 * GB },
      history: { memoryBytes: 3.2 * GB },
    });
    let answers = 0;
    const answerContinue = (id: number) =>
      queueMicrotask(() => {
        if (answerQuestion(id, "continue", "assistant") === "accepted") answers++;
      });
    const stop = useExportQuestions.subscribe((state) => {
      if (state.open) answerContinue(state.open.id);
    });
    const already = useExportQuestions.getState().open;
    if (already) answerContinue(already.id);
    let refusal: ExportRequestError;
    try {
      refusal = (await run.pending) as ExportRequestError;
    } finally {
      stop();
    }
    expect(refusal).toBeInstanceOf(ExportRequestError);
    expect(refusal.status).toBe("blocked");
    // However many times it was asked, that is bounded, and nothing started or was left behind.
    expect(answers).toBeGreaterThan(1);
    expect(answers).toBeLessThanOrEqual(100);
    expect(measured).toBeLessThanOrEqual(101);
    expect(run.ran()).toBe(0);
    leftNothing();
  });

  it("starts anyway when the person says so, and does not ask about memory again", async () => {
    const run = await scene({
      pc: { available_memory_bytes: 1.9 * GB },
      history: { memoryBytes: 3.2 * GB },
    });
    await vi.waitFor(() => expect(shown()?.kind).toBe("memory"));
    answer("start_anyway");
    expect(await run.pending).toBe("started");
    await whenExportsSettle();
    expect(run.ran()).toBe(1);
    expect(measured).toBe(2); // measured once more, to see whether anything else needs asking
  });

  it("asks about the space for the exported file, naming the drive, and about working space separately", async () => {
    const out = await scene({
      pc: { destination_free_bytes: 1.2 * GB },
      history: { finalBytes: 3.4 * GB, temporaryBytes: 0 },
    });
    await vi.waitFor(() => expect(shown()?.kind).toBe("output_space"));
    expect(shown()?.title).toBe("Not enough space for the exported file");
    expect(shown()?.facts).toEqual([
      { label: "Needed", value: "about 3.4 GB" },
      { label: "Free on C:", value: "about 1.2 GB" },
    ]);
    answer("cancel");
    await out.pending;
    __resetExportQueue();
    const work = await scene({
      pc: { scratch_free_bytes: 2 * GB },
      history: { finalBytes: 1 * GB, temporaryBytes: 5 * GB },
    });
    await vi.waitFor(() => expect(shown()?.kind).toBe("working_space"));
    expect(shown()?.title).toBe("Not enough working space");
    answer("cancel");
    await work.pending;
  });

  it("asks memory first, then space, and a Start anyway on memory does not skip the space question", async () => {
    const run = await scene({
      pc: { available_memory_bytes: 1.9 * GB, destination_free_bytes: 1.2 * GB },
      history: { memoryBytes: 3.2 * GB, finalBytes: 3.4 * GB, temporaryBytes: 0 },
    });
    await vi.waitFor(() => expect(shown()?.kind).toBe("memory"));
    answer("start_anyway");
    await vi.waitFor(() => expect(shown()?.kind).toBe("output_space"));
    expect(run.ran()).toBe(0);
    pc = { ...pc, destination_free_bytes: 50 * GB }; // the person freed some space
    answer("continue");
    expect(await run.pending).toBe("started");
    await whenExportsSettle();
    expect(run.ran()).toBe(1);
  });

  it("asks an assistant's long export about the time, and the same export from the Export menu not at all", async () => {
    const chat = await scene({
      via: "chat",
      duration: 3600,
      history: { elapsedSeconds: 10, finalBytes: 1 },
    });
    await vi.waitFor(() => expect(shown()?.kind).toBe("notice"));
    expect(shown()?.title).toBe("This export will take a long time");
    expect(shown()?.warning).toBe(false);
    answer("continue");
    expect(await chat.pending).toBe("started");
    await whenExportsSettle();
    __resetExportQueue();
    const menu = await scene({
      via: "menu",
      duration: 3600,
      history: { elapsedSeconds: 10, finalBytes: 1 },
    });
    expect(await menu.pending).toBe("started");
    expect(shown()).toBeUndefined();
    await whenExportsSettle();
    expect(menu.ran()).toBe(1);
  });

  it("still asks the Export menu about a known problem, in a notice", async () => {
    const run = await scene({ via: "menu", history: { elapsedSeconds: 40_000 } }); // longer than any export may run
    await vi.waitFor(() => expect(shown()?.kind).toBe("notice"));
    expect(shown()?.warning).toBe(true);
    expect(shown()?.lines.join(" ")).toContain("about 8 h");
    answer("cancel");
    expect(((await run.pending) as ExportRequestError).status).toBe("declined");
    leftNothing();
  });

  it("closes the question and ends the request as cancelled when the request is stopped", async () => {
    const stop = new AbortController();
    const run = await scene({
      pc: { available_memory_bytes: 1.9 * GB },
      history: { memoryBytes: 3.2 * GB },
      signal: stop.signal,
    });
    await vi.waitFor(() => expect(shown()?.kind).toBe("memory"));
    stop.abort();
    const refusal = (await run.pending) as ExportRequestError;
    expect(refusal.status).toBe("cancelled");
    expect(shown()).toBeUndefined();
    expect(run.ran()).toBe(0);
    leftNothing();
  });

  it("refuses the export, instead of hanging, when the dialog goes away with a question open", async () => {
    const run = await scene({
      pc: { available_memory_bytes: 1.9 * GB },
      history: { memoryBytes: 3.2 * GB },
    });
    await vi.waitFor(() => expect(shown()?.kind).toBe("memory"));
    unmountHost(); // the dialog is gone: nobody can answer now
    const refusal = (await Promise.race([
      run.pending,
      new Promise((resolve) => setTimeout(() => resolve("hung"), 1500)),
    ])) as ExportRequestError | "hung";
    expect(refusal).not.toBe("hung");
    expect((refusal as ExportRequestError).status).toBe("blocked");
    leftNothing();
  });

  it("with no dialog mounted, the native box asks the same question once, and Continue starts without looping", async () => {
    const run = await scene({
      pc: { available_memory_bytes: 1.9 * GB },
      history: { memoryBytes: 3.2 * GB },
    });
    await vi.waitFor(() => expect(shown()?.kind).toBe("memory"));
    answer("cancel");
    await run.pending;
    __resetExportQueue();
    __resetExportQuestions(); // no dialog mounted from here on
    let message = "";
    __setExportConfirmationForTests(async (text) => {
      message = text;
      return "continue";
    });
    pc = { ...roomy, available_memory_bytes: 1.9 * GB };
    const { fs, store } = make();
    let ran = 0;
    const result = await submitExports([
      {
        store,
        dependencies: [],
        destPath: DEST,
        stagePath: `${DEST}.part`,
        filename: "movie.mp4",
        workload: calibration.workload,
        meta: {
          duration_s: 10,
          width: 1920,
          height: 1080,
          fps: 30,
          quality: "medium",
          project_id: "",
          calibration,
        },
        run: async () => {
          ran++;
          await fs.writeBytes(`${DEST}.part`, new Uint8Array([1]));
          return {};
        },
      },
    ]).then(
      () => "started",
      (error: Error) => error.message,
    );
    await whenExportsSettle();
    expect(result).toBe("started");
    expect(ran).toBe(1);
    expect(message).toContain("Not enough free memory");
    expect(message).toContain("Needed: about 4.3 GB"); // no rung was captured: the normal rung's 3.2 GB over 75%
    expect(message.endsWith("Continue anyway?")).toBe(true);
  });

  it("tells the report what was asked and what was answered: which screen, how big, who answered, how long", async () => {
    vi.useFakeTimers({ now: 2_000_000, toFake: ["Date"] });
    try {
      const run = await scene({
        pc: { available_memory_bytes: 1.9 * GB },
        history: { memoryBytes: 3.2 * GB },
      });
      await vi.waitFor(() => expect(shown()?.kind).toBe("memory"));
      vi.setSystemTime(2_004_000);
      pc = { ...pc, available_memory_bytes: 2.4 * GB };
      answer("continue", "dialog");
      await vi.waitFor(() => expect(shown()?.facts[1].value).toBe("about 2.4 GB"));
      vi.setSystemTime(2_011_000);
      answer("start_anyway", "card");
      expect(await run.pending).toBe("started");
    } finally {
      vi.useRealTimers();
    }
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    const report = lastReport();
    expect(story(report)).toEqual([
      "requested:chat",
      "dialog_shown:b1",
      "dialog_choice:continue",
      "dialog_shown:b1",
      "dialog_choice:start_anyway",
      "stage:preparing",
      "stage:checking",
      "stage:saving",
      "outcome:done",
    ]);
    const bands = (gib: number) => Math.floor((gib * GB) / (128 * 1024 ** 2));
    // No rung was captured, so the question is about the normal rung: its 3.2 GB peak over the 75% of free
    // memory an export may use is what has to be free.
    expect(report.trace[1]).toMatchObject({ n: bands(3.2 / 0.75), m: bands(1.9) });
    expect(report.trace[2]).toMatchObject({ n: 4, m: 1 }); // 4 s on screen, answered in the dialog
    expect(report.trace[3]).toMatchObject({ n: bands(3.2 / 0.75), m: bands(2.4) });
    expect(report.trace[4]).toMatchObject({ n: 7, m: 2 }); // 7 s on screen, answered on the card
  });

  it("records an answer that lost the race, and who won", async () => {
    const run = await scene({
      pc: { available_memory_bytes: 1.9 * GB },
      history: { memoryBytes: 3.2 * GB },
    });
    await vi.waitFor(() => expect(shown()?.kind).toBe("memory"));
    const id = useExportQuestions.getState().open!.id;
    answerQuestion(id, "start_anyway", "dialog");
    answerQuestion(id, "cancel", "card"); // the card, a moment later: too late
    expect(await run.pending).toBe("started");
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    const report = lastReport();
    expect(story(report)).toContain("answer_ignored:cancel");
    expect(report.trace.find((e: Any) => e.e === "answer_ignored")).toMatchObject({ n: 2, m: 1 });
    expect(run.ran()).toBe(1); // the late cancel changed nothing
  });

  it("asks once for a batch, with every file's need added together", async () => {
    const run = await scene({
      count: 3,
      pc: { destination_free_bytes: 5 * GB },
      history: { finalBytes: 2 * GB, temporaryBytes: 0 },
    });
    await vi.waitFor(() => expect(shown()?.kind).toBe("output_space"));
    expect(shown()?.lines.join(" ")).toContain("together");
    expect(shown()?.facts[0].value).toBe("about 6.0 GB");
    answer("cancel");
    await run.pending;
    leftNothing();
  });

  it("never asks about a measurement that is missing", async () => {
    const run = await scene({
      pc: {
        total_memory_bytes: null,
        available_memory_bytes: null,
        scratch_free_bytes: null,
        destination_free_bytes: null,
      },
    });
    expect(await run.pending).toBe("started");
    expect(shown()).toBeUndefined();
    await whenExportsSettle();
  });
});

// What a running export publishes for the chat card (Phase 3, S2). The card belongs to the queue's own
// view of the run, not to the Export dialog's job (only the menu begins that one), so an export an
// assistant started shows its stage and progress too, and the assistant's own export list says more.
describe("what a running export publishes for the chat card", () => {
  const GB = 1e9;
  const meta = {
    duration_s: 60,
    width: 1080,
    height: 1920,
    fps: 30,
    quality: "medium",
    project_id: "",
  };
  const block = (frame: number, outMs: number) =>
    `frame=${frame}\nfps=30\nout_time_us=${outMs * 1000}\nspeed=1.0x\nprogress=continue\n`;
  const live = () => useExportJob.getState().live;

  async function fresh() {
    const made = make();
    await whenExportTelemetrySettles();
    exportBeacon.mockClear();
    __setExportConfirmationForTests(async () => "continue");
    vi.spyOn(host, "resolveExportResources").mockResolvedValue({
      total_memory_bytes: 16 * GB,
      available_memory_bytes: 12 * GB,
      scratch_free_bytes: 500 * GB,
      destination_free_bytes: 500 * GB,
      local_fast_candidate: false,
      budgets: { memoryBytes: 8 * GB, temporaryBytes: 18 * GB, executionSeconds: 28_800 },
    });
    useExportJob.setState({ calibrations: [], live: null, finishing: {} });
    return { ...made, jobs: new FakeJobs() };
  }

  it("keeps saying where an export is while the next one renders (its file is still being checked)", async () => {
    const { fs, store, jobs } = await fresh();
    let finishCheck!: () => void;
    const checking = new Promise<void>((resolve) => (finishCheck = resolve));
    let finishSecond!: () => void;
    const secondRuns = new Promise<void>((resolve) => (finishSecond = resolve));
    let secondQueued!: () => void;
    const queued = new Promise<void>((resolve) => (secondQueued = resolve));
    const SECOND = "C:/out/second.mp4";
    const first = await submitExport({
      store,
      supervisor: jobs,
      origin: AGENT,
      destPath: DEST,
      stagePath: STAGE,
      filename: "first.mp4",
      meta,
      run: async (_, id) => {
        await jobs.submit({ id, lane: "measurement", program: "ffmpeg", args: [], meta: {} });
        jobs.stdout(id, block(1800, 60_000));
        useExportJob.getState().update({ fraction: 1, etaSec: 0, frame: 1800, speed: 1 });
        await queued; // the second is waiting behind it in the supervisor's line
        jobs.exit(id, 0, ""); // the render is over: the second one starts while this file is checked
        await checking;
        await fs.writeBytes(STAGE, new Uint8Array([1]));
        return {};
      },
    });
    const second = await submitExport({
      store,
      supervisor: jobs,
      origin: AGENT,
      destPath: SECOND,
      stagePath: `${SECOND}.part`,
      filename: "second.mp4",
      meta,
      run: async (_, id) => {
        await jobs.submit({ id, lane: "measurement", program: "ffmpeg", args: [], meta: {} });
        secondQueued();
        await vi.waitFor(() => expect(jobs.started).toContain(id));
        jobs.stdout(id, block(180, 6_000));
        useExportJob.getState().update({ fraction: 0.1, etaSec: 90, frame: 180, speed: 1 });
        await secondRuns;
        jobs.exit(id, 0, "");
        await fs.writeBytes(`${SECOND}.part`, new Uint8Array([2]));
        return {};
      },
    });
    await vi.waitFor(() => expect(live()?.jobId).toBe(second.job_id));
    await vi.waitFor(() => expect(live()?.fraction).toBe(0.1));

    const rows = (((await manageExportsTool({ action: "list" })) as Any).exports ?? []) as Any[];
    expect(rows.map((r) => [r.job_id, r.state, r.stage])).toEqual([
      [first.job_id, "running", "checking"], // not "no news": it is still being checked
      [second.job_id, "running", "rendering"],
    ]);
    expect(rows[1]).toMatchObject({ progress_percent: 10, time_left_s: 90 });
    expect(rows[0]).not.toHaveProperty("time_left_s"); // the render is over: nothing left to time

    finishCheck();
    await vi.waitFor(() => expect(listExportRecords()[0].state).toBe("done"));
    expect(live()?.jobId).toBe(second.job_id); // the first one settling does not end the second one's feed
    finishSecond();
    await whenExportsSettle();
    expect(live()).toBeNull();
    expect(useExportJob.getState().finishing).toEqual({}); // nothing is left behind
  });

  it("begins when the export's turn comes, follows its stage, and ends when it settles (no menu involved)", async () => {
    const { fs, store, jobs } = await fresh();
    const seen: Any[] = [];
    const submitted = await submitExport({
      store,
      supervisor: jobs,
      origin: AGENT, // the chat asked: the Export dialog's own job was never begun
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      meta,
      run: async (_, id) => {
        await jobs.submit({ id, lane: "measurement", program: "ffmpeg", args: [], meta: {} });
        seen.push(live()); // the supervisor started it: its turn has come
        jobs.stdout(id, block(100, 3300));
        useExportJob.getState().update({ fraction: 0.05, etaSec: 50, frame: 100, speed: 1 });
        seen.push(live());
        jobs.exit(id, 0, "");
        seen.push(live());
        await fs.writeBytes(STAGE, new Uint8Array([1, 2, 3]));
        return {};
      },
    });
    await whenExportsSettle();
    expect(useExportJob.getState().phase).toBe("idle");
    expect(seen[0]).toMatchObject({ jobId: submitted.job_id, stage: "preparing" });
    expect(seen[1]).toMatchObject({ stage: "rendering", fraction: 0.05, etaSec: 50 });
    expect(seen[2]).toMatchObject({ stage: "checking" });
    expect(live()).toBeNull();
  });

  it("belongs to one export at a time: the next export's feed begins when its turn comes", async () => {
    const { fs, store } = await fresh();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const SECOND = "C:/out/second.mp4";
    let secondSaw: string | undefined;
    const first = await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "first.mp4",
      meta,
      run: async () => {
        await gate;
        await fs.writeBytes(STAGE, new Uint8Array([1]));
        return {};
      },
    });
    const second = await submitExport({
      store,
      destPath: SECOND,
      stagePath: `${SECOND}.part`,
      filename: "second.mp4",
      meta,
      run: async () => {
        secondSaw = live()?.jobId;
        await fs.writeBytes(`${SECOND}.part`, new Uint8Array([2]));
        return {};
      },
    });
    await vi.waitFor(() => expect(live()?.jobId).toBe(first.job_id)); // the second waits its turn
    release();
    await whenExportsSettle();
    expect(secondSaw).toBe(second.job_id);
    expect(live()).toBeNull();
  });

  it("is never left behind: a failed export ends it, and one cancelled while it waited never began it", async () => {
    const { fs, store } = await fresh();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const SECOND = "C:/out/second.mp4";
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "first.mp4",
      meta,
      run: async () => {
        await gate;
        throw new Error("ffmpeg render failed (code=-22)");
      },
    });
    const second = await submitExport({
      store,
      destPath: SECOND,
      stagePath: `${SECOND}.part`,
      filename: "second.mp4",
      meta,
      run: async () => {
        await fs.writeBytes(`${SECOND}.part`, new Uint8Array([2]));
        return {};
      },
    });
    cancelExport(second.job_id, "person_queue");
    release();
    await whenExportsSettle();
    expect(live()).toBeNull();
    expect(listExportRecords().map((r) => r.state)).toEqual(["failed", "cancelled"]);
  });

  it("remembers which project each export belongs to, so a card shows only its own project's", async () => {
    const { fs, store } = await fresh();
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      meta,
      run: async () => {
        await fs.writeBytes(STAGE, new Uint8Array([1]));
        return {};
      },
    });
    await whenExportsSettle();
    expect(listExportRecords()[0].projectDir).toBe(DIR);
  });

  describe("manage_exports", () => {
    const list = async (): Promise<Any[]> =>
      ((await manageExportsTool({ action: "list" })) as Any).exports as Any[];

    it("says an export is cancelling as soon as its cancel is accepted, and takes it out of the line", async () => {
      const { fs, store } = await fresh();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const spec = (destPath: string, wait: boolean) => ({
        store,
        destPath,
        stagePath: `${destPath}.part`,
        filename: destPath.split("/").pop()!,
        meta,
        run: async () => {
          if (wait) await gate;
          await fs.writeBytes(`${destPath}.part`, new Uint8Array([1]));
          return {};
        },
      });
      await submitExport(spec(DEST, true));
      const second = await submitExport(spec("C:/out/second.mp4", false));
      const third = await submitExport(spec("C:/out/third.mp4", false));
      // The person cancels the second; the assistant cancels the third.
      expect(cancelExport(second.job_id, "person_card")).toBe(true);
      expect(
        ((await manageExportsTool({ action: "cancel", job_id: third.job_id })) as Any).ok,
      ).toBe(true);
      await vi.waitFor(() =>
        expect(listExportRecords().map((r) => r.cancelling)).toEqual([undefined, true, true]),
      );
      const rows = await list();
      expect(rows.map((r) => [r.state, r.cancelling, r.queue_position])).toEqual([
        ["running", undefined, undefined],
        ["queued", true, undefined],
        ["queued", true, undefined],
      ]);
      release();
      await whenExportsSettle();
      const after = await list();
      expect(after.map((r) => r.state)).toEqual(["done", "cancelled", "cancelled"]);
      expect(after.every((r) => !("cancelling" in r))).toBe(true);
    });

    it.each(["refused", "failed"] as const)(
      "does not say an export is cancelling when its cancel was %s (it goes on, and does not pretend)",
      async (how) => {
        const { fs, store, jobs } = await fresh();
        const delivery = localDeliveryPort(store);
        delivery.cancel = async () => {
          if (how === "failed") throw new Error("the app process did not answer");
          return false; // the file was already being saved: too late to stop it
        };
        jobs.delivery = delivery;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const sub = await submitExport({
          store,
          supervisor: jobs,
          origin: AGENT,
          destPath: DEST,
          stagePath: STAGE,
          filename: "final.mp4",
          meta,
          run: async (_, id) => {
            await jobs.submit({ id, lane: "measurement", program: "ffmpeg", args: [], meta: {} });
            await gate;
            jobs.exit(id, 0, "");
            await fs.writeBytes(STAGE, new Uint8Array([1]));
            return {};
          },
        });
        expect(cancelExport(sub.job_id, "person_card")).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0)); // the cancel was asked, and answered
        expect(listExportRecords()[0].cancelling).toBeUndefined();
        expect(await list()).toMatchObject([{ state: "running" }]);
        expect((await list())[0]).not.toHaveProperty("cancelling");
        release();
        await whenExportsSettle();
        expect(listExportRecords()[0].state).toBe("done");
        // The report tells the truth too: a cancel that did not happen is not in the story, so the export
        // reads as it was, finished.
        await whenExportTelemetrySettles();
        const report = exportBeacon.mock.calls.at(-1)![0] as Any;
        expect(report.status).toBe("done");
        expect(report.trace.map((e: Any) => e.e)).not.toContain("cancelled");
      },
    );

    it("tells the story who cancelled it from the cancel that was accepted, not from one that was refused first", async () => {
      const { fs, store, jobs } = await fresh();
      const delivery = localDeliveryPort(store);
      const accept = delivery.cancel;
      let asked = 0;
      delivery.cancel = async (id) => (++asked === 1 ? false : accept(id)); // refused once, then accepted
      jobs.delivery = delivery;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const sub = await submitExport({
        store,
        supervisor: jobs,
        origin: AGENT,
        destPath: DEST,
        stagePath: STAGE,
        filename: "final.mp4",
        meta,
        run: async (_, id) => {
          await jobs.submit({ id, lane: "measurement", program: "ffmpeg", args: [], meta: {} });
          await gate;
          jobs.exit(id, 0, "");
          await fs.writeBytes(STAGE, new Uint8Array([1]));
          return {};
        },
      });
      expect(cancelExport(sub.job_id, "person_card")).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(listExportRecords()[0].cancelling).toBeUndefined(); // the first was refused
      expect(cancelExport(sub.job_id, "assistant")).toBe(true);
      await vi.waitFor(() => expect(listExportRecords()[0].cancelling).toBe(true));
      release();
      await whenExportsSettle();
      await whenExportTelemetrySettles();
      const report = exportBeacon.mock.calls.at(-1)![0] as Any;
      const cancels = report.trace.filter((e: Any) => e.e === "cancelled");
      expect(cancels).toHaveLength(1);
      expect(cancels[0].v).toBe("assistant");
    });

    it("says the stage, how far and how long is left for the running export", async () => {
      const { fs, store, jobs } = await fresh();
      let rows: Any[] = [];
      await submitExport({
        store,
        supervisor: jobs,
        destPath: DEST,
        stagePath: STAGE,
        filename: "final.mp4",
        meta,
        run: async (_, id) => {
          await jobs.submit({ id, lane: "measurement", program: "ffmpeg", args: [], meta: {} });
          jobs.stdout(id, block(100, 15_000));
          useExportJob.getState().update({ fraction: 0.25, etaSec: 92, frame: 100, speed: 1 });
          rows = await list();
          jobs.exit(id, 0, "");
          await fs.writeBytes(STAGE, new Uint8Array([1]));
          return {};
        },
      });
      await whenExportsSettle();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        state: "running",
        stage: "rendering",
        progress_percent: 25,
        time_left_s: 92,
      });
      expect(rows[0]).not.toHaveProperty("queue_position");
      expect(rows[0]).not.toHaveProperty("stalled_for_s");
      expect(rows[0]).not.toHaveProperty("setting"); // the normal setting needs no mention
    });

    it("says which setting an export runs at when it is not the normal one, so an assistant can explain a slower export", async () => {
      const { fs, store } = await fresh();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const spec = (destPath: string, rung: 1 | 2) => ({
        store,
        destPath,
        stagePath: `${destPath}.part`,
        filename: destPath.split("/").pop()!,
        meta: { ...meta, plan: { rung } },
        run: async () => {
          await gate;
          await fs.writeBytes(`${destPath}.part`, new Uint8Array([1]));
          return {};
        },
      });
      await submitExport(spec(DEST, 1));
      await submitExport(spec("C:/out/second.mp4", 2));
      const rows = await list();
      expect(rows.map((r) => r.setting)).toEqual(["gentle", "gentlest"]);
      release();
      await whenExportsSettle();
    });

    it("says where a waiting export is in line, and nothing about progress it has not made", async () => {
      const { fs, store } = await fresh();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const SECOND = "C:/out/second.mp4";
      const THIRD = "C:/out/third.mp4";
      const spec = (destPath: string, wait: boolean) => ({
        store,
        destPath,
        stagePath: `${destPath}.part`,
        filename: destPath.split("/").pop()!,
        meta,
        run: async () => {
          if (wait) await gate;
          await fs.writeBytes(`${destPath}.part`, new Uint8Array([1]));
          return {};
        },
      });
      await submitExport(spec(DEST, true));
      await submitExport(spec(SECOND, false));
      await submitExport(spec(THIRD, false));
      await vi.waitFor(() => expect(live()).not.toBeNull());
      const rows = await list();
      expect(rows.map((r) => [r.state, r.queue_position])).toEqual([
        ["running", undefined],
        ["queued", 1],
        ["queued", 2],
      ]);
      expect(rows[1]).not.toHaveProperty("progress_percent");
      expect(rows[1]).not.toHaveProperty("stage", "rendering");
      release();
      await whenExportsSettle();
    });

    it("says when the running export has stopped making progress, and for how long, and then does not promise a time left", async () => {
      const { fs, store, jobs } = await fresh();
      vi.useFakeTimers({ now: 1_000_000 });
      try {
        let rows: Any[] = [];
        let before: Any[] = [];
        await submitExport({
          store,
          supervisor: jobs,
          destPath: DEST,
          stagePath: STAGE,
          filename: "final.mp4",
          meta,
          run: async (_, id) => {
            await jobs.submit({ id, lane: "measurement", program: "ffmpeg", args: [], meta: {} });
            jobs.stdout(id, block(100, 3300));
            useExportJob.getState().update({ fraction: 0.05, etaSec: 100, frame: 100 });
            before = await list(); // it just moved: the time left is something to say
            vi.setSystemTime(1_000_000 + 75_000); // the same block, again and again, for 75 s
            useExportJob.getState().update({ fraction: 0.05, etaSec: 100, frame: 100 });
            rows = await list();
            jobs.exit(id, 0, "");
            await fs.writeBytes(STAGE, new Uint8Array([1]));
            return {};
          },
        });
        await whenExportsSettle();
        expect(before[0]).toMatchObject({ time_left_s: 100 });
        expect(rows[0]).toMatchObject({ state: "running", stalled_for_s: 75 });
        // The card says "no progress" and no time left (a render that is not moving has no ETA worth
        // reading), and the list says the same.
        expect(rows[0]).not.toHaveProperty("time_left_s");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not give a time left that cannot be one (more than two days, not a number)", async () => {
      const { fs, store, jobs } = await fresh();
      const seen: Any[] = [];
      await submitExport({
        store,
        supervisor: jobs,
        destPath: DEST,
        stagePath: STAGE,
        filename: "final.mp4",
        meta,
        run: async (_, id) => {
          await jobs.submit({ id, lane: "measurement", program: "ffmpeg", args: [], meta: {} });
          jobs.stdout(id, block(100, 3300));
          for (const etaSec of [49 * 3600, Number.POSITIVE_INFINITY, Number.NaN, -3, 90]) {
            useExportJob.getState().update({ fraction: 0.05, etaSec, frame: 100 });
            seen.push((await list())[0]);
          }
          jobs.exit(id, 0, "");
          await fs.writeBytes(STAGE, new Uint8Array([1]));
          return {};
        },
      });
      await whenExportsSettle();
      expect(seen.map((row) => row.time_left_s)).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
        90,
      ]);
    });

    it("says how long an export itself took in duration_s, not how long it waited in line behind another", async () => {
      const { fs, store } = await fresh();
      vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
      try {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const SECOND = "C:/out/second.mp4";
        await submitExport({
          store,
          destPath: DEST,
          stagePath: STAGE,
          filename: "first.mp4",
          meta,
          run: async () => {
            await gate;
            await fs.writeBytes(STAGE, new Uint8Array([1]));
            return {};
          },
        });
        await submitExport({
          store,
          destPath: SECOND,
          stagePath: `${SECOND}.part`,
          filename: "second.mp4",
          meta,
          run: async () => {
            vi.setSystemTime(1_000_000 + 100_000 + 5_000); // five seconds of its own
            await fs.writeBytes(`${SECOND}.part`, new Uint8Array([2]));
            return {};
          },
        });
        vi.setSystemTime(1_000_000 + 100_000); // it waited 100 s behind the first
        release();
        await whenExportsSettle();
        const rows = await list();
        expect(rows.map((r) => r.state)).toEqual(["done", "done"]);
        expect(rows[1].duration_s).toBe(5);
        expect(rows[0].duration_s).toBe(100); // the first one ran from the start of the 100 s
      } finally {
        vi.useRealTimers();
      }
    });

    it("says why a failed export stopped, in a code and in plain words", async () => {
      const { store } = await fresh();
      await submitExport({
        store,
        destPath: DEST,
        stagePath: STAGE,
        filename: "final.mp4",
        meta,
        run: async () => {
          throw new Error("Error while filtering: Cannot allocate memory");
        },
      });
      await whenExportsSettle();
      const [row] = await list();
      expect(row).toMatchObject({
        state: "failed",
        failure_code: "memory_limit",
        failure: "Your PC ran short of memory. Close other programs and try again.",
      });
      expect(row).not.toHaveProperty("stage");
    });

    it("leaves a finished export's row as it was", async () => {
      const { fs, store } = await fresh();
      await submitExport({
        store,
        destPath: DEST,
        stagePath: STAGE,
        filename: "final.mp4",
        meta,
        run: async () => {
          await fs.writeBytes(STAGE, new Uint8Array([1]));
          return {};
        },
      });
      await whenExportsSettle();
      const [row] = await list();
      expect(Object.keys(row).sort()).toEqual(
        ["duration_s", "filename", "job_id", "media_ref", "state"].sort(),
      );
    });
  });
});

// What an export's report says HAPPENED to it (Phase 3, S1): the screen it met, the stage it reached,
// who stopped it and where, which limit ended it and how much memory it had used. Each test plays the
// real journeys: an export that hit the working-set limit, one that ran into the commit cap, one that
// stood still, one cancelled while it waited, and one that simply worked.
describe("what happened to an export, as its report tells it", () => {
  const GIB = 1024 ** 3;
  const meta = {
    duration_s: 60,
    width: 1080,
    height: 1920,
    fps: 30,
    quality: "medium",
    project_id: "",
  };
  const calibrationFor = (engine: "partition-pipes-v1" | "file-sequence-v1") => ({
    workload: {
      width: 1080,
      height: 1920,
      fps: 30,
      durationSeconds: 60,
      visualClips: 6,
      captionClips: 1,
      audioClips: 1,
      peakVisualLayers: 5,
      peakMediaLayers: 3,
    },
    output: { width: 1080, height: 1920, fps: 30 },
    quality: "medium",
    engine,
    revision: EXPORT_SPEED_REVISION,
  });
  // What the app process prints at the end of a run, formatted as src-tauri/src/jobs/stream.rs does.
  const resident = (peak: number, limit: number) =>
    `native render resident: ${JSON.stringify({ limit, sampled_peak: peak, workers_at_peak: [] })}\n`;
  const budget = (limit: number, peak: number) =>
    `native render budget: configured_commit=${limit}, reported_peak=${peak}; peak is accounting, not an exact physical ceiling\n`;
  const block = (frame: number, outMs: number) =>
    `frame=${frame}\nfps=30\nout_time_us=${outMs * 1000}\nspeed=1.0x\nprogress=continue\n`;
  const lastReport = (): Any => exportBeacon.mock.calls.at(-1)![0];
  const story = (report: Any): string[] =>
    report.trace.map((e: Any) => (e.v ? `${e.e}:${e.v}` : e.e));

  async function fresh() {
    const made = make();
    await whenExportTelemetrySettles();
    exportBeacon.mockClear();
    __setExportConfirmationForTests(async () => "continue");
    vi.spyOn(host, "resolveExportResources").mockResolvedValue({
      total_memory_bytes: 16 * GIB,
      available_memory_bytes: 6 * GIB + 1,
      scratch_free_bytes: 100e9,
      destination_free_bytes: 100e9,
      local_fast_candidate: false,
      budgets: { memoryBytes: 3.5 * GIB, temporaryBytes: 18e9, executionSeconds: 28800 },
    });
    useExportJob.setState({ calibrations: [] });
    return { ...made, jobs: new FakeJobs() };
  }

  it("tells a failed export's whole story: who asked, the screen it met, how far it got, the limit that stopped it", async () => {
    const { store, jobs } = await fresh();
    const calibration = calibrationFor("partition-pipes-v1");
    // A comparable export took twice as long as the video: the pre-start screen warns ("slow").
    useExportJob.setState({
      calibrations: [
        {
          ...calibration,
          elapsedSeconds: 130,
          finalBytes: 100,
          memoryBytes: 100,
          temporaryBytes: 10,
        },
      ],
    });
    const stderr =
      "native render failed: render resident memory budget exceeded: sampled=3800350720, limit=3758096384\n" +
      resident(3_800_350_720, 3.5 * GIB) +
      budget(4 * GIB, 3_900_000_000);
    const submitted = await submitExport({
      store,
      supervisor: jobs,
      via: "mcp",
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      workload: calibration.workload,
      meta: { ...meta, calibration },
      run: async (_, id) => {
        await jobs.submit({ id, lane: "measurement", program: "ffmpeg", args: [], meta: {} });
        jobs.stdout(id, block(100, 3300));
        jobs.exit(id, -1, stderr);
        throw new ExportRunError("ffmpeg render failed (code=-1)", stderr);
      },
    });
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    expect((await whenExportEnds(submitted.job_id))?.state).toBe("failed");
    const report = lastReport();
    expect(story(report)).toEqual([
      "requested:mcp",
      "dialog_shown:confirm",
      "dialog_choice:continue",
      "stage:preparing",
      "stage:rendering",
      "guard_tripped:resident",
      "outcome:failed",
    ]);
    // The screen: one reason (bit 256 is "slow"). The guard: peak and limit in MiB. The outcome: seconds.
    expect(report.trace[1]).toMatchObject({ n: 1, m: 256 });
    expect(report.trace[5]).toMatchObject({ n: 3584, m: 3584 });
    expect(report).toMatchObject({
      status: "failed",
      limit: "resident",
      engine: "streamed",
      started_by: "elsewhere",
      peak_resident_mib: 3584,
      resident_limit_mib: 3584,
      peak_commit_mib: 3712,
      commit_limit_mib: 4096,
      ram_total_gib: 16,
      ram_free_gib: 6,
    });
  });

  it("names the commit cap when an export ran into it (the 1.7-second 'Cannot allocate memory' failures)", async () => {
    const { store, jobs } = await fresh();
    const calibration = calibrationFor("file-sequence-v1");
    const stderr =
      "[fc#0 @ 000002052b65d140] Error while filtering: Cannot allocate memory\n" +
      resident(1_300_000_000, 3.5 * GIB) +
      budget(4 * GIB, 4 * GIB - 1000);
    await submitExport({
      store,
      supervisor: jobs,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      workload: calibration.workload,
      meta: { ...meta, calibration },
      run: async (_, id) => {
        await jobs.submit({ id, lane: "measurement", program: "ffmpeg", args: [], meta: {} });
        jobs.exit(id, -1, stderr);
        throw new ExportRunError("ffmpeg render failed (code=-1): Cannot allocate memory", stderr);
      },
    });
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    const report = lastReport();
    expect(report).toMatchObject({ status: "failed", limit: "commit", engine: "one_pass" });
    expect(story(report)).toEqual(
      expect.arrayContaining(["guard_tripped:commit", "outcome:failed"]),
    );
    expect(report.peak_commit_mib).toBe(4096);
  });

  it("names the PC's floor when the app stopped an export to keep the PC usable, as a memory limit in plain words", async () => {
    const { store, jobs } = await fresh();
    const stderr =
      "native render failed: render memory floor crossed: the PC has 410 MiB left and keeps 768 MiB for itself\n" +
      resident(2_900_000_000, 3.5 * GIB);
    await submitExport({
      store,
      supervisor: jobs,
      via: "chat",
      origin: AGENT,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      meta,
      run: async (_, id) => {
        await jobs.submit({ id, lane: "measurement", program: "ffmpeg", args: [], meta: {} });
        jobs.exit(id, -1, stderr);
        throw new ExportRunError(`ffmpeg render failed (code=-1): ${stderr}`, stderr);
      },
    });
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    const report = lastReport();
    expect(report).toMatchObject({ status: "failed", limit: "pc_floor" });
    expect(story(report)).toEqual(
      expect.arrayContaining(["guard_tripped:pc_floor", "outcome:failed"]),
    );
    const row = ((await manageExportsTool({ action: "list" })) as Any).exports[0];
    expect(row).toMatchObject({ state: "failed", failure_code: "memory_limit" });
  });

  it("does not blame a limit for a failure that had nothing to do with one", async () => {
    const { store, jobs } = await fresh();
    const stderr =
      "ffmpeg: No such file or directory\n" +
      resident(900_000_000, 3.5 * GIB) +
      budget(4 * GIB, 1 * GIB);
    await submitExport({
      store,
      supervisor: jobs,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      meta,
      run: async (_, id) => {
        await jobs.submit({ id, lane: "measurement", program: "ffmpeg", args: [], meta: {} });
        jobs.exit(id, -2, stderr);
        throw new ExportRunError(
          "ffmpeg render failed (code=-2): No such file or directory",
          stderr,
        );
      },
    });
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    const report = lastReport();
    expect(report).not.toHaveProperty("limit");
    expect(story(report)).not.toContain("guard_tripped:resident");
    expect(story(report).some((s) => s.startsWith("guard_tripped"))).toBe(false);
  });

  it("logs a run that stood still, and how long, without stopping it", async () => {
    const { fs, store, jobs } = await fresh();
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const submitted = await submitExport({
        store,
        supervisor: jobs,
        destPath: DEST,
        stagePath: STAGE,
        filename: "final.mp4",
        meta,
        run: async (_, id) => {
          await jobs.submit({ id, lane: "measurement", program: "ffmpeg", args: [], meta: {} });
          jobs.stdout(id, block(100, 3300));
          // ffmpeg prints the same block every half second while it is stuck: that is not movement.
          for (let second = 0; second < 75; second++) {
            await vi.advanceTimersByTimeAsync(1000);
            jobs.stdout(id, block(100, 3300));
          }
          jobs.stdout(id, block(200, 6600)); // it moved again
          jobs.exit(id, 0, resident(2 * GIB, 3.5 * GIB));
          await fs.writeBytes(STAGE, new Uint8Array([1, 2, 3]));
          return {};
        },
      });
      await whenExportsSettle();
      await whenExportTelemetrySettles();
      // Nothing was stopped: the export finished.
      expect((await whenExportEnds(submitted.job_id))?.state).toBe("done");
      const report = lastReport();
      const stalls = report.trace.filter((e: Any) => e.e === "stall_detected");
      expect(stalls).toHaveLength(1);
      expect(stalls[0]).toMatchObject({ v: "", n: 60, m: 6 });
      expect(report.longest_gap_s).toBe(75);
      expect(story(report)).toEqual(expect.arrayContaining(["heartbeat_gap", "outcome:done"]));
      expect(report.trace.find((e: Any) => e.e === "heartbeat_gap")).toMatchObject({ n: 75 });
    } finally {
      vi.useRealTimers();
    }
  });

  describe("an export that makes no progress (the stall stop)", () => {
    /** A supervised export whose process prints some progress and then goes quiet: it only ends when it is
     *  aborted, as a killed ffmpeg would. `cancel` wraps the delivery owner's cancel, to hold, refuse or
     *  break the app's own stop. */
    async function frozenExport(
      over: {
        progress?: boolean;
        cancel?: (
          real: (id: string) => Promise<boolean>,
          calls: string[],
        ) => (id: string) => Promise<boolean>;
      } = {},
    ) {
      const { fs, store, jobs } = await fresh();
      const delivery = localDeliveryPort(store);
      const cancelCalls: string[] = [];
      const real = delivery.cancel.bind(delivery);
      const wrapped = over.cancel ? over.cancel(real, cancelCalls) : real;
      delivery.cancel = async (id) => {
        cancelCalls.push(id);
        return wrapped(id);
      };
      jobs.delivery = delivery;
      const submitted = await submitExport({
        store,
        supervisor: jobs,
        via: "chat",
        origin: AGENT,
        destPath: DEST,
        stagePath: STAGE,
        filename: "final.mp4",
        meta,
        run: async (signal, id) => {
          await jobs.submit({ id, lane: "measurement", program: "ffmpeg", args: [], meta: {} });
          if (over.progress !== false) jobs.stdout(id, block(900, 30_000));
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
          jobs.exit(id, 255, "");
          await fs.remove(STAGE).catch(() => undefined);
          throw new Error("ffmpeg render failed (code=255)");
        },
      });
      return { submitted, jobs, fs, cancelCalls, real };
    }

    it("stops it after three minutes without progress, and says so as a time limit in plain words", async () => {
      vi.useFakeTimers({ now: 1_000_000 });
      try {
        const { fs } = await frozenExport();
        await vi.advanceTimersByTimeAsync(170_000);
        expect(listExportRecords()[0].state).toBe("running"); // not yet
        await vi.advanceTimersByTimeAsync(15_000);
        await whenExportsSettle();
        await whenExportTelemetrySettles();
        const record = listExportRecords()[0];
        expect(record.state).toBe("failed");
        expect(record.error).toMatch(/no progress for 3 min \(stalled\)/);
        expect(await fs.exists(DEST)).toBe(false); // nothing was delivered
        expect(await fs.exists(STAGE)).toBe(false); // and nothing half-made is left
        const row = ((await manageExportsTool({ action: "list" })) as Any).exports[0];
        expect(row).toMatchObject({
          state: "failed",
          failure_code: "time_limit",
          failure: "The export took longer than ArtDaddy allows, or stopped making progress.",
        });
        const report = lastReport();
        expect(report).toMatchObject({ status: "failed", started_by: "chat" });
        expect(story(report)).toEqual(
          expect.arrayContaining(["stall_detected", "stall_detected:frozen", "outcome:failed"]),
        );
        expect(story(report)).not.toContain("cancelled:app"); // it is a failure, not someone's cancel
        const stop = report.trace.find((e: Any) => e.v === "frozen");
        expect(stop).toMatchObject({ n: 180, m: 50 }); // three minutes, halfway through the render
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops an export that never made its first progress, after the longer allowance", async () => {
      vi.useFakeTimers({ now: 1_000_000 });
      try {
        await frozenExport({ progress: false });
        await vi.advanceTimersByTimeAsync(290_000);
        expect(listExportRecords()[0].state).toBe("running");
        await vi.advanceTimersByTimeAsync(15_000);
        await whenExportsSettle();
        expect(listExportRecords()[0]).toMatchObject({ state: "failed" });
        expect(listExportRecords()[0].error).toMatch(
          /not started making progress after 5 min \(stalled\)/,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not stop an export whose sources are still being checked: the app process's beats are life, and the stop comes after they end", async () => {
      vi.useFakeTimers({ now: 1_000_000 });
      try {
        const { submitted, jobs } = await frozenExport({ progress: false });
        // Eleven minutes of checking a big project on a slow drive: no frame yet, a beat every five seconds.
        for (let i = 1; i <= 132; i++) {
          jobs.stdout(submitted.job_id, `artdaddy_verify=${i}\n`);
          await vi.advanceTimersByTimeAsync(5_000);
        }
        expect(listExportRecords()[0].state).toBe("running");
        // The beats end and nothing follows: the longer allowance counts from the last one.
        await vi.advanceTimersByTimeAsync(290_000);
        expect(listExportRecords()[0].state).toBe("running");
        await vi.advanceTimersByTimeAsync(15_000);
        await whenExportsSettle();
        expect(listExportRecords()[0]).toMatchObject({ state: "failed" });
        expect(listExportRecords()[0].error).toMatch(/\(stalled\)/);
      } finally {
        vi.useRealTimers();
      }
    });

    it("only logs it, as before, when the switch is off", async () => {
      vi.useFakeTimers({ now: 1_000_000 });
      __setExportFlag("stall_stop", false);
      try {
        const { submitted, jobs } = await frozenExport();
        await vi.advanceTimersByTimeAsync(600_000);
        expect(listExportRecords()[0].state).toBe("running"); // ten minutes of silence, and it is left alone
        expect(jobs.killed).toEqual([]);
        expect(cancelExport(submitted.job_id, "person_card")).toBe(true); // the person ends it
        await whenExportsSettle();
        await whenExportTelemetrySettles();
        const report = lastReport();
        expect(story(report)).toContain("stall_detected"); // logged
        expect(story(report)).not.toContain("stall_detected:frozen"); // never stopped
        expect(report.status).toBe("cancelled");
      } finally {
        __setExportFlag("stall_stop", true);
        vi.useRealTimers();
      }
    });

    it("tells the story of whichever stop is accepted first: the person's cancel, when it gets there before the app's", async () => {
      vi.useFakeTimers({ now: 1_000_000 });
      try {
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const { submitted, cancelCalls } = await frozenExport({
          cancel: (real, calls) => async (id) => {
            if (calls.length > 1) return real(id); // the person's cancel is answered at once
            await held; // the app's own stop is answered a moment later, and says yes as well
            await real(id);
            return true;
          },
        });
        await vi.advanceTimersByTimeAsync(185_000);
        expect(cancelCalls).toHaveLength(1);
        expect(cancelExport(submitted.job_id, "person_card")).toBe(true);
        release();
        await whenExportsSettle();
        await whenExportTelemetrySettles();
        expect(listExportRecords()[0].state).toBe("cancelled");
        expect(lastReport().status).toBe("cancelled");
        expect(story(lastReport())).toContain("cancelled:person_card");
        expect(story(lastReport())).not.toContain("outcome:failed");
      } finally {
        vi.useRealTimers();
      }
    });

    it("tells the story of whichever stop is accepted first: the app's, when the person's cancel gets there after", async () => {
      vi.useFakeTimers({ now: 1_000_000 });
      try {
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const { submitted } = await frozenExport({
          cancel: (real) => async (id) => {
            await held; // both stops are on their way, the app's first, and both are told yes
            await real(id);
            return true;
          },
        });
        await vi.advanceTimersByTimeAsync(185_000);
        expect(cancelExport(submitted.job_id, "person_card")).toBe(true);
        release();
        await whenExportsSettle();
        await whenExportTelemetrySettles();
        expect(listExportRecords()[0].state).toBe("failed");
        const report = lastReport();
        expect(report.status).toBe("failed");
        expect(story(report)).toContain("stall_detected:frozen");
        expect(story(report)).not.toContain("cancelled:person_card"); // one ending, told once
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves the export alone when its owner refuses the stop (the file is already being saved), and asks once", async () => {
      vi.useFakeTimers({ now: 1_000_000 });
      try {
        const { submitted, jobs, cancelCalls, real } = await frozenExport({
          cancel: () => async () => false,
        });
        await vi.advanceTimersByTimeAsync(600_000);
        expect(cancelCalls).toHaveLength(1); // not once every few seconds
        expect(listExportRecords()[0].state).toBe("running");
        jobs.delivery!.cancel = real; // now let the person end it, so the test ends
        expect(cancelExport(submitted.job_id, "person_card")).toBe(true);
        await whenExportsSettle();
        expect(listExportRecords()[0].state).toBe("cancelled");
      } finally {
        vi.useRealTimers();
      }
    });

    it("still ends a stalled export when the stop itself cannot be asked for", async () => {
      vi.useFakeTimers({ now: 1_000_000 });
      try {
        await frozenExport({
          cancel: () => async () => {
            throw new Error("the app process did not answer");
          },
        });
        await vi.advanceTimersByTimeAsync(185_000);
        await whenExportsSettle();
        expect(listExportRecords()[0]).toMatchObject({ state: "failed" });
        expect(listExportRecords()[0].error).toMatch(/\(stalled\)/);
      } finally {
        vi.useRealTimers();
      }
    });
    it("never stops an export it gets no progress feed for: one that runs in the page alone is only watched", async () => {
      vi.useFakeTimers({ now: 1_000_000 });
      try {
        const { fs, store } = await fresh();
        await submitExport({
          store,
          destPath: DEST,
          stagePath: STAGE,
          filename: "final.mp4",
          meta,
          run: async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 20 * 60_000)); // twenty silent minutes
            await fs.writeBytes(STAGE, new Uint8Array([1, 2, 3]));
            return {};
          },
        });
        await vi.advanceTimersByTimeAsync(20 * 60_000 + 1000);
        await whenExportsSettle();
        expect(listExportRecords()[0].state).toBe("done");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("asks the server which safety behaviours are on beside each export request, and never waits for the answer", async () => {
    const { fs, store } = await fresh();
    const ask = vi
      .spyOn(exportFlags, "refreshExportFlags")
      .mockImplementation(() => new Promise<void>(() => undefined)); // a server that never answers
    try {
      await submitExport({
        store,
        destPath: DEST,
        stagePath: STAGE,
        filename: "final.mp4",
        meta,
        run: async () => {
          await fs.writeBytes(STAGE, new Uint8Array([1, 2, 3]));
          return {};
        },
      });
      await whenExportsSettle();
      expect(ask).toHaveBeenCalledTimes(1);
      expect(listExportRecords()[0].state).toBe("done");
    } finally {
      ask.mockRestore();
    }
  });

  describe("Try again, one click on a failed export", () => {
    const DEST_B = "C:/out/other.mp4";
    /** An export that fails with `error`, with a retry offered that records the rung it is asked for. */
    async function failedExport(
      error: string,
      over: {
        rung?: 1 | 2;
        maxRung?: 0 | 1 | 2;
        ladder?: (0 | 1 | 2)[];
        answer?: () => Promise<{ ok: boolean; error?: string; declined?: boolean }>;
      } = {},
    ) {
      const { store } = await fresh();
      const asked: number[] = [];
      const submitted = await submitExport({
        store,
        destPath: DEST,
        stagePath: STAGE,
        filename: "final.mp4",
        meta: {
          ...meta,
          ...(over.rung || over.maxRung !== undefined || over.ladder
            ? {
                plan: {
                  rung: over.rung ?? 0,
                  ...(over.maxRung !== undefined ? { max_rung: over.maxRung } : {}),
                  ...(over.ladder ? { ladder: over.ladder } : {}),
                },
              }
            : {}),
        },
        run: async () => {
          throw new Error(error);
        },
      });
      await whenExportsSettle();
      offerExportRetry(submitted.job_id, async (rung) => {
        asked.push(rung);
        return over.answer ? over.answer() : { ok: true };
      });
      return { jobId: submitted.job_id, asked };
    }

    it("is offered on a failed export, and not on one that was never given a way to start again", async () => {
      const { jobId } = await failedExport("render failed");
      expect(listExportRecords().find((r) => r.job_id === jobId)).toMatchObject({
        state: "failed",
        canRetry: true,
      });
      const { store } = await fresh();
      const adopted = await submitExport({
        store,
        destPath: DEST_B,
        stagePath: `${DEST_B}.part`,
        filename: "other.mp4",
        meta,
        run: async () => {
          throw new Error("render failed");
        },
      });
      await whenExportsSettle();
      expect(
        listExportRecords().find((r) => r.job_id === adopted.job_id)?.canRetry,
      ).toBeUndefined();
      await retryExport(adopted.job_id); // nothing to start: asks nothing, changes nothing
      expect(listExportRecords().some((r) => r.job_id === adopted.job_id)).toBe(true);
    });

    it("asks one rung gentler after running short of memory, and the failed row goes once the new export is queued", async () => {
      const { jobId, asked } = await failedExport(
        "native render failed: render resident memory budget exceeded: sampled=1, limit=0",
        { rung: 1 },
      );
      await retryExport(jobId);
      expect(asked).toEqual([2]);
      expect(listExportRecords().some((r) => r.job_id === jobId)).toBe(false);
    });

    it("asks the plan to decide afresh after a failure that is not about memory or time", async () => {
      const { jobId, asked } = await failedExport("ENOSPC: no space left on device", { rung: 2 });
      await retryExport(jobId);
      expect(asked).toEqual([0]);
    });

    // Found by review: an export with no gentler rung (the streamed engine, thirteen or more video clips where the
    // two gentler rungs are one command, or the switch for rungs off) must not be promised one, and must not be
    // asked at a rung it does not have.
    it("asks for no rung the export does not have, and none at all while the switch for rungs is off", async () => {
      const bounded = await failedExport("Cannot allocate memory", { rung: 1, maxRung: 1 });
      await retryExport(bounded.jobId);
      expect(bounded.asked).toEqual([1]); // the same rung: there is nothing gentler

      const streamed = await failedExport("Cannot allocate memory", { maxRung: 0 });
      await retryExport(streamed.jobId);
      expect(streamed.asked).toEqual([0]);

      __setExportFlag("plan_rung", false);
      try {
        const off = await failedExport("Cannot allocate memory", { rung: 1 });
        await retryExport(off.jobId);
        expect(off.asked).toEqual([0]); // as before rungs existed
      } finally {
        __setExportFlag("plan_rung", true);
      }
    });

    // The second pass of S3's review, built in S4: the ladder is not always a run from the first rung. A graphics
    // encoder with nine to twelve clips has rung 0 and rung 2 only; Try again goes to the one that exists.
    it("steps to the next rung on the export's ladder, and says nothing is gentler only when nothing is", async () => {
      const chip = await failedExport("Cannot allocate memory", { ladder: [0, 2], maxRung: 2 });
      await retryExport(chip.jobId);
      expect(chip.asked).toEqual([2]); // rung 1 is the same command as rung 0 here
      const again = await failedExport("Cannot allocate memory", {
        rung: 2,
        ladder: [0, 2],
        maxRung: 2,
      });
      await retryExport(again.jobId);
      expect(again.asked).toEqual([2]); // already at the gentlest it has
      __setExportFlag("plan_rung", false);
      try {
        const off = await failedExport("Cannot allocate memory", { ladder: [0, 2], maxRung: 2 });
        await retryExport(off.jobId);
        expect(off.asked).toEqual([0]); // the switch is read when Try again is offered, not when the export was captured
      } finally {
        __setExportFlag("plan_rung", true);
      }
    });

    it("keeps the failed row, with the reason, when the new export is refused", async () => {
      const { jobId, asked } = await failedExport("Cannot allocate memory", {
        answer: async () => ({
          ok: false,
          error: "an export to proj.mp4 is already queued or running",
        }),
      });
      await retryExport(jobId);
      expect(asked).toEqual([1]);
      const row = listExportRecords().find((r) => r.job_id === jobId)!;
      expect(row).toMatchObject({ state: "failed", canRetry: true });
      expect(row.retrying).toBeUndefined();
      expect(row.note).toMatch(/Could not start again/);
      expect(row.note).toMatch(/already queued or running/);
    });

    it("keeps the failed row quietly when the person turned the new export down at one of its questions", async () => {
      const { jobId, asked } = await failedExport("Cannot allocate memory", {
        answer: async () => ({ ok: false, declined: true }),
      });
      await retryExport(jobId);
      expect(asked).toEqual([1]);
      const row = listExportRecords().find((r) => r.job_id === jobId)!;
      expect(row).toMatchObject({ state: "failed", canRetry: true });
      expect(row.retrying).toBeUndefined();
      expect(row.note).toBeUndefined(); // their own choice is not something that went wrong
    });

    it("keeps the failed row when starting again throws, and lets the person press the button again", async () => {
      let attempt = 0;
      const { jobId, asked } = await failedExport("Cannot allocate memory", {
        answer: async () => {
          if (++attempt === 1) throw new Error("the project was closed");
          return { ok: true };
        },
      });
      await retryExport(jobId);
      const row = listExportRecords().find((r) => r.job_id === jobId)!;
      expect(row.note).toMatch(/the project was closed/);
      expect(row.retrying).toBeUndefined();
      await retryExport(jobId);
      expect(asked).toEqual([1, 1]);
      expect(listExportRecords().some((r) => r.job_id === jobId)).toBe(false);
    });

    it("starts one new export however many times the button is pressed", async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const { jobId, asked } = await failedExport("Cannot allocate memory", {
        answer: async () => {
          await held;
          return { ok: true };
        },
      });
      const first = retryExport(jobId);
      expect(listExportRecords().find((r) => r.job_id === jobId)?.retrying).toBe(true);
      const second = retryExport(jobId);
      release();
      await Promise.all([first, second]);
      expect(asked).toHaveLength(1);
    });

    it("does nothing for an export that did not fail", async () => {
      const { store, fs } = await fresh();
      const asked: number[] = [];
      const submitted = await submitExport({
        store,
        destPath: DEST,
        stagePath: STAGE,
        filename: "final.mp4",
        meta,
        run: async () => {
          await fs.writeBytes(STAGE, new Uint8Array([1, 2, 3]));
          return {};
        },
      });
      offerExportRetry(submitted.job_id, async (rung) => {
        asked.push(rung);
        return { ok: true };
      });
      await retryExport(submitted.job_id); // still running: never a retry of a good export
      await whenExportsSettle();
      expect(listExportRecords().find((r) => r.job_id === submitted.job_id)?.state).toBe("done");
      await retryExport(submitted.job_id);
      expect(asked).toEqual([]);
    });
  });

  it("does not count the file check that follows the render as the render standing still", async () => {
    const { fs, store, jobs } = await fresh();
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const submitted = await submitExport({
        store,
        supervisor: jobs,
        destPath: DEST,
        stagePath: STAGE,
        filename: "final.mp4",
        meta,
        run: async (_, id) => {
          await jobs.submit({ id, lane: "measurement", program: "ffmpeg", args: [], meta: {} });
          for (let second = 1; second <= 20; second++) {
            await vi.advanceTimersByTimeAsync(1000);
            jobs.stdout(id, block(second * 30, second * 3000));
          }
          jobs.exit(id, 0, resident(2 * GIB, 3.5 * GIB)); // ffmpeg is over
          // The file check decodes every frame in a process the supervisor does not follow, so it
          // prints no progress: ninety quiet seconds on a long 4K export, and nothing is wrong.
          await vi.advanceTimersByTimeAsync(90_000);
          await fs.writeBytes(STAGE, new Uint8Array([1, 2, 3]));
          return {};
        },
      });
      await whenExportsSettle();
      await whenExportTelemetrySettles();
      expect((await whenExportEnds(submitted.job_id))?.state).toBe("done");
      const report = lastReport();
      expect(story(report)).toEqual([
        "requested:other",
        "stage:preparing",
        "stage:rendering",
        "stage:checking",
        "stage:saving",
        "outcome:done",
      ]);
      expect(report.longest_gap_s ?? 0).toBeLessThan(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says a cancel during the file check happened while checking, not while rendering", async () => {
    const { store, jobs } = await fresh();
    const submitted = await submitExport({
      store,
      supervisor: jobs,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      meta,
      run: async (signal, id) => {
        await jobs.submit({ id, lane: "measurement", program: "ffmpeg", args: [], meta: {} });
        jobs.stdout(id, block(1800, 60_000));
        jobs.exit(id, 0, resident(2 * GIB, 3.5 * GIB));
        return new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("export cancelled"))),
        );
      },
    });
    await vi.waitFor(() => expect(jobs.started.length).toBeGreaterThan(0));
    expect(cancelExport(submitted.job_id, "person_card")).toBe(true);
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    const report = lastReport();
    expect(story(report)).toEqual([
      "requested:other",
      "stage:preparing",
      "stage:rendering",
      "stage:checking",
      "cancelled:person_card",
      "outcome:cancelled",
    ]);
    expect(report.trace[4]).toMatchObject({ n: 3, m: 100 }); // where: checking, the render was whole
  });

  it("does not call a failed render's end a check", async () => {
    const { store, jobs } = await fresh();
    await submitExport({
      store,
      supervisor: jobs,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      meta,
      run: async (_, id) => {
        await jobs.submit({ id, lane: "measurement", program: "ffmpeg", args: [], meta: {} });
        jobs.stdout(id, block(300, 10_000));
        jobs.exit(id, -2, "ffmpeg: No such file or directory\n");
        throw new ExportRunError("ffmpeg render failed (code=-2)", "No such file or directory");
      },
    });
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    expect(story(lastReport())).toEqual([
      "requested:other",
      "stage:preparing",
      "stage:rendering",
      "outcome:failed",
    ]);
  });

  it("says who cancelled a queued export and that it never started", async () => {
    const { fs, store } = await fresh();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "first.mp4",
      meta,
      run: async () => {
        await gate;
        await fs.writeBytes(STAGE, new Uint8Array([1]));
        return {};
      },
    });
    const SECOND = "C:/out/second.mp4";
    const second = await submitExport({
      store,
      destPath: SECOND,
      stagePath: `${SECOND}.part`,
      filename: "second.mp4",
      meta,
      run: async () => {
        throw new Error("a cancelled export must never start");
      },
    });
    expect(second.queue_position).toBe(1);
    expect(cancelExport(second.job_id, "person_queue")).toBe(true);
    expect(cancelExport(second.job_id, "person_queue")).toBe(true); // a second press adds nothing
    release();
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    const cancelled = exportBeacon.mock.calls
      .map((c) => c[0] as Any)
      .find((r) => r.status === "cancelled");
    expect(story(cancelled)).toEqual([
      "requested:other",
      "queued",
      "cancelled:person_queue",
      "outcome:cancelled",
    ]);
    expect(cancelled.trace[1]).toMatchObject({ n: 1 }); // queue position
    expect(cancelled.trace[2]).toMatchObject({ n: 0, m: 0 }); // where: queued, nothing done
    expect(await fs.exists(SECOND)).toBe(false);
  });

  it("says where a running export was, and how far, when the assistant stopped it", async () => {
    const { store, jobs } = await fresh();
    const submitted = await submitExport({
      store,
      supervisor: jobs,
      via: "chat",
      origin: AGENT,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      meta,
      run: async (signal, id) => {
        await jobs.submit({ id, lane: "measurement", program: "ffmpeg", args: [], meta: {} });
        jobs.stdout(id, block(900, 30_000)); // halfway through 60 s
        return new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("export cancelled"))),
        );
      },
    });
    await vi.waitFor(() => expect(jobs.started.length).toBeGreaterThan(0));
    expect(cancelExport(submitted.job_id, "assistant")).toBe(true);
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    const report = lastReport();
    expect(report).toMatchObject({ status: "cancelled", started_by: "chat" });
    expect(story(report)).toEqual([
      "requested:chat",
      "stage:preparing",
      "stage:rendering",
      "cancelled:assistant",
      "outcome:cancelled",
    ]);
    expect(report.trace[3]).toMatchObject({ n: 2, m: 50 }); // where: rendering, at 50%
  });

  it("carries its story into the refusal when native admission says no (the field's 'allocation budget' block)", async () => {
    const { store } = await fresh();
    const jobs = new FakeJobs();
    jobs.delivery = {
      ...localDeliveryPort(store),
      prepare: async () => {
        throw new Error("export workspace allocation budget exceeded before write");
      },
    };
    const error = await submitExport({
      store,
      supervisor: jobs,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      meta,
      run: async () => ({}),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExportRequestError);
    const refusal = error as ExportRequestError;
    expect(refusal.status).toBe("blocked");
    expect(refusal.story?.trace.snapshot().map((e) => e.e)).toEqual(["requested"]);
    // The words the person was shown name the limit that refused it.
    expect(limitThatFired(refusal.message, {})).toBe("scratch");
    expect(isDestinationReserved(DEST)).toBe(false); // nothing is left reserved by the refusal
  });

  it("tells a clean export's story too: each stage once, in order", async () => {
    const { fs, store } = await fresh();
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      meta,
      run: async () => {
        await fs.writeBytes(STAGE, new Uint8Array([1, 2, 3]));
        return {};
      },
    });
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    const report = lastReport();
    expect(story(report)).toEqual([
      "requested:other",
      "stage:preparing",
      "stage:checking",
      "stage:saving",
      "outcome:done",
    ]);
    expect(
      report.trace.every((e: Any, i: number, all: Any[]) => i === 0 || e.t >= all[i - 1].t),
    ).toBe(true);
    expect(report).not.toHaveProperty("limit");
  });
});

// An agent that polled `list` every few seconds asked 237 times in one session. `wait_seconds`
// turns that loop into one call that answers when the export ends. These tests check what comes
// back and what is left behind (a timer, a listener), not how the wait is built.
describe("manage_exports: one call that waits, instead of a polling loop", () => {
  const SECOND = "C:/out/second.mp4";

  /** An export held open until released, so a test decides when it ends. */
  async function held(store: ProjectStoreAccess, dest: string, filename: string) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sub = await submitExport({
      store,
      destPath: dest,
      stagePath: `${dest}.part`,
      filename,
      run: async () => {
        await gate;
        return {};
      },
    });
    return { job_id: sub.job_id, release };
  }

  /** The wait's own timer is the only one faked: the queue's real work must still run. */
  const fakeWaitTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

  it("answers the moment the export ends, not at the bound, and leaves no timer behind", async () => {
    const { store } = make();
    const a = await held(store, DEST, "final.mp4");
    fakeWaitTimers();
    try {
      const answer = manageExportsTool({ wait_seconds: 30 });
      let over = false;
      void answer.then(() => (over = true));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(over).toBe(false); // the export is still running: the call is still waiting

      a.release();
      await vi.advanceTimersByTimeAsync(2_000); // far short of the 30 s bound
      const r = (await answer) as Any;
      expect(r.exports).toHaveLength(1);
      expect(["done", "failed"]).toContain(r.exports[0].state);
      expect(r).not.toHaveProperty("note");
      expect(r).not.toHaveProperty("retry_after_s");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("at the bound it names what is still unfinished and says not to loop", async () => {
    const { store } = make();
    const a = await held(store, DEST, "final.mp4");
    fakeWaitTimers();
    try {
      const answer = manageExportsTool({ wait_seconds: 60 });
      await vi.advanceTimersByTimeAsync(60_000);
      const r = (await answer) as Any;
      expect(r.exports).toMatchObject([{ job_id: a.job_id, state: "running" }]);
      expect(r.retry_after_s).toBe(MAX_EXPORT_WAIT_S);
      expect(String(r.note)).toMatch(/wait_seconds/);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    a.release();
  });

  it("ends the wait at once when the turn is stopped, with the export still reported as running", async () => {
    const { store } = make();
    await held(store, DEST, "final.mp4");
    fakeWaitTimers();
    try {
      const stop = new AbortController();
      const answer = manageExportsTool({ wait_seconds: 60 }, stop.signal);
      stop.abort();
      const r = (await answer) as Any; // no timer was advanced: Stop alone ended it
      expect(r.exports[0].state).toBe("running");
      expect(vi.getTimerCount()).toBe(0);

      const already = new AbortController();
      already.abort();
      const again = (await manageExportsTool({ wait_seconds: 60 }, already.signal)) as Any;
      expect(again.exports[0].state).toBe("running");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits only for the export it is asked about, while another sits queued behind it", async () => {
    const { store } = make();
    const a = await held(store, DEST, "final.mp4");
    const b = await held(store, SECOND, "second.mp4");
    fakeWaitTimers();
    try {
      const answer = manageExportsTool({ job_id: a.job_id, wait_seconds: 30 });
      a.release();
      await vi.advanceTimersByTimeAsync(2_000);
      const r = (await answer) as Any;
      expect(r.exports.map((e: Any) => e.job_id)).toEqual([a.job_id]);
      // The one asked about is over: the other's state is not this answer's business.
      expect(r).not.toHaveProperty("note");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    b.release();
  });

  it("refuses a job_id this session never started, without waiting", async () => {
    const { store } = make();
    await held(store, DEST, "final.mp4");
    fakeWaitTimers();
    try {
      const r = (await manageExportsTool({ job_id: "nope", wait_seconds: 60 })) as Any;
      expect(r.ok).toBe(false);
      expect(String(r.error)).toContain("nope");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("without a wait it answers at once, still telling the caller not to loop", async () => {
    const { store } = make();
    const a = await held(store, DEST, "final.mp4");
    const r = (await manageExportsTool({ action: "list" })) as Any;
    expect(r.exports[0].elapsed_s).toBeGreaterThanOrEqual(0);
    expect(r.retry_after_s).toBe(15);
    expect(String(r.note)).toMatch(/wait_seconds/);

    a.release();
    await whenExportsSettle();
    const done = (await manageExportsTool({ action: "list" })) as Any;
    expect(done).not.toHaveProperty("note");
    expect(done).not.toHaveProperty("retry_after_s");
    expect(done.exports[0]).not.toHaveProperty("elapsed_s");
  });

  it.each([[-3], [0], ["soon"], ["30"], [null], [{}], [Number.NaN]])(
    "wait_seconds %j is no wait: the answer is immediate and nothing is scheduled",
    async (bad) => {
      const { store } = make();
      await held(store, DEST, "final.mp4");
      fakeWaitTimers();
      try {
        const r = (await manageExportsTool({ wait_seconds: bad })) as Any;
        expect(r.exports[0].state).toBe("running");
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("reads wait_seconds as a whole number of ms in [0, the limit] for ANYTHING, never shrinking as the ask grows", () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const ms = exportWaitMs(raw);
        expect(Number.isInteger(ms)).toBe(true);
        expect(ms).toBeGreaterThanOrEqual(0);
        expect(ms).toBeLessThanOrEqual(MAX_EXPORT_WAIT_S * 1000);
      }),
    );
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1e6, noNaN: true }),
        fc.double({ min: 0, max: 1e6, noNaN: true }),
        (x, y) => {
          const [lo, hi] = x <= y ? [x, y] : [y, x];
          expect(exportWaitMs(lo)).toBeLessThanOrEqual(exportWaitMs(hi));
        },
      ),
    );
    expect(exportWaitMs(1e9)).toBe(MAX_EXPORT_WAIT_S * 1000);
  });

  it("the contract tells the model the limit the code enforces, and what the reply carries", () => {
    type Props = Record<string, { type?: string; description?: string }>;
    const tool = toolDefinition("manage_exports")!;
    const props = tool.parameters!.properties as Props;
    expect(props.wait_seconds?.type).toBe("number");
    expect(props.wait_seconds?.description).toContain(`0 to ${MAX_EXPORT_WAIT_S}`);
    expect(tool.description).toContain(`0 to ${MAX_EXPORT_WAIT_S}`);
    expect(tool.description).toMatch(/`retry_after_s`/);
    expect(tool.description).toMatch(/`elapsed_s`/);
  });
});
