import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

const invoke = vi.hoisted(() => vi.fn());
const shell = vi.hoisted(() => ({ name: "tauri" }));
const supervisor = vi.hoisted(() => vi.fn());
vi.mock("./index", () => ({ platform: shell }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../tools/jobSupervisor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools/jobSupervisor")>()),
  jobSupervisor: () => supervisor(),
}));

import { resolveExportResources, cleanAdapters, runCapabilityProbe } from "./host";
import { FakeJobs } from "../test/fakeJobs";
import promiseLibrary from "../../scripts/qa/exporterPromiseCases.json";

const UNKNOWN = {
  total_memory_bytes: null,
  available_memory_bytes: null,
  scratch_free_bytes: null,
  destination_free_bytes: null,
  budgets: { memoryBytes: null, temporaryBytes: null, executionSeconds: null },
  adapters: [],
};

beforeEach(() => {
  invoke.mockReset();
  supervisor.mockReset();
  shell.name = "tauri";
});
afterEach(() => vi.useRealTimers());

describe("local export resource snapshots", () => {
  it("preserves the complete schema-defined native temporary budget and a measured zero allowance", async () => {
    const snapshot = {
      ...UNKNOWN,
      scratch_free_bytes: 0,
      destination_free_bytes: 0,
      budgets: { ...UNKNOWN.budgets, temporaryBytes: 0 },
      temporary_space: promiseLibrary.temporarySpace,
    };
    invoke.mockResolvedValue(snapshot);
    expect(await resolveExportResources("")).toEqual(snapshot);
  });

  it("preserves valid smaller native workspace limits without inventing available capacity", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 18_000_000_000 }),
        fc.integer({ min: 0, max: 2_000_000_000 }),
        async (payloadBytes, infrastructureBytes) => {
          const temporary_space = {
            ...promiseLibrary.temporarySpace,
            payloadBytes,
            infrastructureBytes,
            totalBytes: payloadBytes + infrastructureBytes,
          };
          invoke.mockResolvedValue({ ...UNKNOWN, temporary_space });
          expect(await resolveExportResources("")).toEqual({ ...UNKNOWN, temporary_space });
        },
      ),
      { numRuns: 40 },
    );
  });

  it("makes malformed or incomplete temporary-space contracts explicitly unavailable", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const declared = promiseLibrary.temporarySpace;
      const invalid: unknown[] = [
        null,
        [],
        { ...declared, totalBytes: declared.totalBytes + 1 },
        { ...declared, entryLimit: 0 },
      ];
      for (const [key, original] of Object.entries(declared)) {
        const values =
          typeof original === "string"
            ? [undefined, null, "", 1]
            : [
                undefined,
                null,
                -1,
                String(original),
                1.5,
                NaN,
                Infinity,
                Number.MAX_SAFE_INTEGER + 1,
              ];
        for (const value of values) {
          invalid.push({ ...declared, [key]: value });
        }
      }
      for (const temporary_space of invalid) {
        invoke.mockResolvedValue({ ...UNKNOWN, temporary_space });
        expect(await resolveExportResources("")).toEqual(UNKNOWN);
      }
      expect(warning).toHaveBeenCalledTimes(invalid.length);
    } finally {
      warning.mockRestore();
    }
  });

  it("preserves complete native cgroup evidence instead of losing it at the resource adapter", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
        fc.integer({ min: 1, max: 65536 }),
        async (memory, pid) => {
          const memory_cgroup = {
            version: 2,
            path: "/system.slice/native-qa.service",
            identity: "29:712",
            process_id: pid,
            memory_max_bytes: memory,
            swap_max_bytes: 0,
          };
          invoke.mockResolvedValue({ memory_cgroup });
          expect((await resolveExportResources("")).memory_cgroup).toEqual(memory_cgroup);
        },
      ),
      { numRuns: 40 },
    );
  });

  it("keeps malformed cgroup evidence explicitly unavailable, never a valid profile label", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const group = {
        version: 2,
        path: "/system.slice/native-qa.service",
        identity: "29:712",
        process_id: 123,
        memory_max_bytes: 8 * 1024 ** 3,
        swap_max_bytes: 0,
      };
      for (const patch of [
        { path: "/../peer" },
        { identity: "not-an-inode" },
        { process_id: 0 },
        { memory_max_bytes: Number.MAX_SAFE_INTEGER + 1 },
        { swap_max_bytes: "0" },
        { version: 1 },
      ]) {
        invoke.mockResolvedValue({ memory_cgroup: { ...group, ...patch } });
        expect(await resolveExportResources("")).toEqual(UNKNOWN);
      }
      expect(warning).toHaveBeenCalledTimes(6);
    } finally {
      warning.mockRestore();
    }
  });

  it("preserves measured zero free space and sends the destination only to native IPC", async () => {
    const snapshot = {
      total_memory_bytes: 16 * 1024 ** 3,
      available_memory_bytes: 4 * 1024 ** 3,
      scratch_free_bytes: 0,
      destination_free_bytes: 100 * 1024 ** 3,
      adapters: [],
      budgets: { memoryBytes: 3 * 1024 ** 3, temporaryBytes: 0, executionSeconds: 28800 },
    };
    invoke.mockResolvedValue(snapshot);
    expect(await resolveExportResources("C:/qa/movie.mp4")).toEqual(snapshot);
    expect(invoke).toHaveBeenCalledWith("jobs_export_resources", {
      destination: "C:/qa/movie.mp4",
    });
  });

  it("keeps unavailable or malformed measurements unknown instead of claiming zero", async () => {
    invoke.mockRejectedValueOnce(new Error("native command unavailable"));
    expect(await resolveExportResources("C:/qa/movie.mp4")).toEqual(UNKNOWN);
    invoke.mockResolvedValueOnce({
      total_memory_bytes: "16GB",
      available_memory_bytes: 50,
      scratch_free_bytes: -1,
      destination_free_bytes: Infinity,
    });
    expect(await resolveExportResources("C:/qa/movie.mp4")).toEqual(UNKNOWN);
    invoke.mockResolvedValueOnce({
      total_memory_bytes: 100,
      available_memory_bytes: 101,
      scratch_free_bytes: NaN,
      destination_free_bytes: Number.MAX_SAFE_INTEGER + 1,
    });
    expect(await resolveExportResources("C:/qa/movie.mp4")).toEqual({
      ...UNKNOWN,
      total_memory_bytes: 100,
    });
  });

  it("does not query native resources for web or already-aborted requests", async () => {
    shell.name = "web";
    expect(await resolveExportResources("C:/qa/movie.mp4")).toEqual(UNKNOWN);
    shell.name = "tauri";
    const controller = new AbortController();
    controller.abort();
    expect(await resolveExportResources("C:/qa/movie.mp4", controller.signal)).toEqual(UNKNOWN);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("bounds a stalled query and does not adopt its late answer", async () => {
    vi.useFakeTimers();
    let complete!: (value: unknown) => void;
    invoke.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const pending = resolveExportResources("C:/qa/movie.mp4");
    await vi.advanceTimersByTimeAsync(2000);
    const snapshot = await pending;
    expect(snapshot).toEqual(UNKNOWN);
    complete({
      total_memory_bytes: 16 * 1024 ** 3,
      available_memory_bytes: 8 * 1024 ** 3,
      scratch_free_bytes: 100,
      destination_free_bytes: 100,
    });
    await Promise.resolve();
    expect(snapshot).toEqual(UNKNOWN);
  });
});

describe("the graphics chips a PC reports", () => {
  const amd = { maker: "amd", device: "15bf", driver: "32.0.22024.4008" };

  it("passes on the chips of the makers the exporter knows, in the order they came", () => {
    const nvidia = { maker: "nvidia", device: "2504", driver: "551.23" };
    const intel = { maker: "intel", device: "9a49", driver: "31.0.101.4502" };
    expect(cleanAdapters([nvidia, amd, intel])).toEqual([nvidia, amd, intel]);
    invoke.mockResolvedValue({ ...UNKNOWN, adapters: [amd] });
    return resolveExportResources("").then((resources) =>
      expect(resources.adapters).toEqual([amd]),
    );
  });

  it("drops anything that is not the shape the app process sends, and a chip listed twice", () => {
    expect(
      cleanAdapters([
        amd,
        amd,
        { ...amd, maker: "matrox" },
        { ...amd, device: "ZZZZ" },
        { ...amd, device: "" },
        { ...amd, driver: "v1; rm -rf /" },
        { ...amd, driver: 5 },
        { maker: "amd" },
        null,
        "amd",
        7,
        [],
      ]),
    ).toEqual([amd]);
    for (const notAList of [undefined, null, "amd", 3, {}, { maker: "amd" }])
      expect(cleanAdapters(notAList)).toEqual([]);
  });

  it("never returns more than a handful, however many a response lists", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ...amd, device: i.toString(16) }));
    expect(cleanAdapters(many).length).toBeLessThanOrEqual(8);
  });

  it("is an empty list, not an error, when the app process says nothing about chips", async () => {
    invoke.mockResolvedValue({ ...UNKNOWN, total_memory_bytes: 100 });
    const resources = await resolveExportResources("");
    expect(resources.adapters).toEqual([]);
  });
});

describe("the capability probe the graphics chip's test runs on", () => {
  it("runs the command as the supervisor's own job on the capability lane, and retires it", async () => {
    const jobs = new FakeJobs();
    supervisor.mockResolvedValue(jobs);
    jobs.onStart = (request) => {
      queueMicrotask(() => jobs.exit(request.id, 0, "SSIM All:0.93"));
    };
    const outcome = await runCapabilityProbe(["-version"], { timeoutMs: 5000, kind: "chip-test" });
    expect(outcome).toMatchObject({ kind: "ran", code: 0 });
    if (outcome.kind === "ran") expect(outcome.stderr).toContain("SSIM All:0.93");
    expect(jobs.submitted).toHaveLength(1);
    expect(jobs.submitted[0]).toMatchObject({
      lane: "fast-capability",
      program: "ffmpeg",
      args: ["-version"],
    });
    expect(jobs.committed).toContain(jobs.submitted[0].id);
    expect(jobs.forgotten).toContain(jobs.submitted[0].id);
  });

  it("reports a command that failed as a command that ran, with the code it ended on", async () => {
    const jobs = new FakeJobs();
    supervisor.mockResolvedValue(jobs);
    jobs.onStart = (request) => {
      queueMicrotask(() => jobs.exit(request.id, 1, "No capable devices found"));
    };
    const outcome = await runCapabilityProbe(["x"], { timeoutMs: 5000, kind: "chip-test" });
    expect(outcome).toMatchObject({ kind: "ran", code: 1 });
  });

  it("does not start while an export is running, and says it was busy", async () => {
    const jobs = new FakeJobs();
    supervisor.mockResolvedValue(jobs);
    await jobs.submit({ id: "export_1", lane: "export", program: "ffmpeg", args: [], meta: {} });
    jobs.submitted.length = 0;
    expect(await runCapabilityProbe(["x"], { timeoutMs: 5000, kind: "chip-test" })).toEqual({
      kind: "busy",
    });
    expect(jobs.submitted).toHaveLength(0);
  });

  it("says it was busy when there is no supervisor to ask", async () => {
    supervisor.mockResolvedValue(null);
    expect(await runCapabilityProbe(["x"], { timeoutMs: 5000, kind: "chip-test" })).toEqual({
      kind: "busy",
    });
    supervisor.mockRejectedValue(new Error("no bridge"));
    expect(await runCapabilityProbe(["x"], { timeoutMs: 5000, kind: "chip-test" })).toEqual({
      kind: "busy",
    });
  });

  it("kills and retires its job, and says it timed out, when the command does not finish in time", async () => {
    vi.useFakeTimers();
    const jobs = new FakeJobs();
    supervisor.mockResolvedValue(jobs);
    const pending = runCapabilityProbe(["x"], { timeoutMs: 3000, kind: "chip-test" });
    await vi.advanceTimersByTimeAsync(2500);
    await vi.advanceTimersByTimeAsync(3500);
    expect(await pending).toEqual({ kind: "timeout" });
    expect(jobs.killed).toContain(jobs.submitted[0].id);
    expect(jobs.forgotten).toContain(jobs.submitted[0].id);
  });

  it("kills and retires its job, and says it was stopped, if the caller aborts", async () => {
    const jobs = new FakeJobs();
    const controller = new AbortController();
    supervisor.mockResolvedValue(jobs);
    jobs.onStart = () => {
      controller.abort();
    };
    expect(
      await runCapabilityProbe(["x"], {
        timeoutMs: 5000,
        kind: "chip-test",
        signal: controller.signal,
      }),
    ).toEqual({ kind: "stopped" });
    expect(jobs.killed).toContain(jobs.submitted[0].id);
    expect(jobs.forgotten).toContain(jobs.submitted[0].id);
    const gone = new AbortController();
    gone.abort();
    expect(
      await runCapabilityProbe(["x"], { timeoutMs: 5000, kind: "chip-test", signal: gone.signal }),
    ).toEqual({ kind: "stopped" });
  });

  it("retires a job the supervisor accepted before a late submit reply failed", async () => {
    const jobs = new FakeJobs();
    supervisor.mockResolvedValue(jobs);
    const submit = jobs.submit.bind(jobs);
    vi.spyOn(jobs, "submit").mockImplementation(async (request) => {
      await submit(request);
      throw new Error("reply failed after native acceptance");
    });
    expect(await runCapabilityProbe(["x"], { timeoutMs: 5000, kind: "chip-test" })).toEqual({
      kind: "busy",
    });
    expect(jobs.killed).toContain(jobs.submitted[0].id);
    expect(jobs.forgotten).toContain(jobs.submitted[0].id);
  });
});
