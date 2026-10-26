// The queue's job is to protect the DESTINATION FILE. Every test here is about what is sitting
// on disk at the path the user chose, not about what the tool returned.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import {
  __resetExportQueue,
  cancelExport,
  isDestinationReserved,
  localDeliveryPort,
  listExportRecords,
  listExports,
  manageExportsTool,
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
import { endProjectSession } from "../tools/coordinator";
import { useExportJob } from "../store/exportJob";
import { useAuth } from "../store/auth";
import { EXPORT_SPEED_REVISION, type ExportCalibration } from "./exportOptions";
import { FakeJobs } from "../test/fakeJobs";
import * as host from "../platform/host";

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
        scenario === "slow" ? "more than twice" : "all finished outputs together",
      );
      expect(shown?.message).not.toContain("Estimated time: unknown");
      expect(listExportRecords()).toHaveLength(0);
    },
  );

  const roomy = {
    total_memory_bytes: 1000,
    available_memory_bytes: 500,
    local_fast_candidate: false,
    scratch_free_bytes: 1000,
    destination_free_bytes: 1000,
    budgets: { memoryBytes: 500, temporaryBytes: 500, executionSeconds: 28800 },
  };

  /** Submit one in-scope export and report what the user was asked, and whether it then started. */
  async function submitAsked(opts: {
    fps?: number;
    history?: Partial<ExportCalibration>;
    scratch?: number;
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
    const workload = { ...calibration.workload, fps: opts.fps ?? calibration.workload.fps };
    const result = await submitExports([
      {
        store,
        dependencies: [],
        destPath: DEST,
        stagePath: `${DEST}.part`,
        filename: "movie.mp4",
        workload,
        meta: {
          duration_s: 10,
          width: 1920,
          height: 1080,
          fps: workload.fps,
          quality: "medium",
          project_id: "",
          calibration,
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
    ["memory", { history: { memoryBytes: 600 } }],
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
    "admits no job or output after %s, including a copy request",
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
          copyOf: "media_copy",
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

  // 4i: the indexer yields to exports, as Palmier's does, including between two queued ones.
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
      { job_id: sub.job_id, filename: "final.mp4", state: "running" },
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
