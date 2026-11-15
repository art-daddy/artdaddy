// The app starts an export again by itself, once, a rung gentler, when the PC ran short of memory (exportRestart.ts decides, exportQueue.ts runs it). The honest estimate prices that gentler setting, which 0.27.0's guess did
// not, so the new attempt can come out as a long export while the first was not. A restart asks nobody anything (no one may be there: an assistant started it), and a question is a refusal for it, so the time of the new attempt must
// never be one. These drive the real export tool and the real queue against FakeJobs, which plays the app process, the way the Export menu, the in-app chat and an assistant over MCP start an export.
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { __setExportConfirmationForTests } from "../lib/confirm";
import * as host from "../platform/host";
import { createPcCheckService } from "../platform/pcCheck";
import { useAuth } from "../store/auth";
import { useExportJob } from "../store/exportJob";
import { FakeJobs } from "../test/fakeJobs";
import { MemFs, registerTestDocument, resetTestDocuments } from "../test/timelineKit";
import { agentToolContext } from "../tools/agentStore";
import type { CommandResult, CommandRunner } from "../tools/command";
import type { ClientToolContext } from "../tools/context";
import { __resetProjectJobs } from "../tools/genJobs";
import { __resetJobSupervisor, __setJobSupervisor } from "../tools/jobSupervisor";
import { joinPath, ProjectStoreAccess } from "../tools/store";
import { ensureTimeline } from "./engine";
import { admissionEstimateHere } from "./estimateDeps";
import {
  __resetExportQueue,
  cancelExport,
  listExportRecords,
  listExports,
  localDeliveryPort,
  restartDecisions,
  whenExportEnds,
  whenExportTelemetrySettles,
  whenExportsSettle,
} from "./exportQueue";
import { LONG_EXPORT_SECONDS, estimateExport } from "./exportOptions";
import { setPcCheckService } from "./pcCheckHandle";
import { writePcCheck, type PcCheckRecord, type StorageLike } from "./pcClass";
import { addClipsTool } from "./placement";
import { exportTimelineTool } from "./render";
import { __resetRouteEstimatesMemo } from "./routeEstimates";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

vi.mock("../api/exportEvents", () => ({ reportExport: async () => undefined }));
vi.mock("./chipTest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chipTest")>()),
  findChip: vi.fn(async () => ({ chip: null, events: [] })),
  markChipSuspect: vi.fn(),
}));

const GIB = 1024 ** 3;
const DIR = "C:/proj";
const DEST = "C:/Users/test/Downloads/proj.mp4";
const ORIGIN = { chatSessionId: "t1", branchId: 0, executionId: 1 };

class Fs extends MemFs {
  async rename(from: string, to: string): Promise<void> {
    const v = this.files.get(joinPath(from));
    if (v === undefined) throw new Error(`ENOENT ${from}`);
    this.files.delete(joinPath(from));
    this.files.set(joinPath(to), v);
  }
  async remove(p: string): Promise<void> {
    this.files.delete(joinPath(p));
  }
  async copyFile(from: string, to: string): Promise<void> {
    const value = this.files.get(joinPath(from));
    if (value === undefined) throw new Error(`ENOENT ${from}`);
    this.files.set(joinPath(to), value);
  }
  async readBytes(p: string): Promise<Uint8Array> {
    const v = this.files.get(joinPath(p));
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return new TextEncoder().encode(String(v));
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
}

const settleTick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function flush(turns = 20) {
  for (let turn = 0; turn < turns; turn++) await settleTick();
}

/** What the app process prints when the PC ran short of memory with the export at 1.2 GiB. */
const MEMORY_SHORT =
  `native render resident: ${JSON.stringify({ limit: 3.5 * GIB, sampled_peak: 1.2 * GIB, workers_at_peak: [] })}\n` +
  "native render failed: render memory floor crossed: the PC has 410 MiB left and keeps 768 MiB for itself\n";

const checkRecord = (rHat: number): PcCheckRecord => ({
  revision: 1,
  build: "artdaddy@test",
  atMs: Date.now(),
  cores: 8,
  outcome: "done",
  aFps: 90,
  bFps: 12,
  cFps: 40,
  rHat,
  cls: "ok",
});

/** The real PC check service holding a stored check: what the app has after the speed check has run. */
function checked(rHat: number) {
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
  writePcCheck(storage, "export-speed", checkRecord(rHat));
  setPcCheckService(service);
}

/** What the person's PC says: plenty of memory for the gentler setting, and an execution limit far above any of these exports. */
function resources() {
  vi.spyOn(host, "resolveExportResources").mockResolvedValue({
    total_memory_bytes: null,
    available_memory_bytes: 8 * GIB,
    scratch_free_bytes: null,
    destination_free_bytes: null,
    budgets: { memoryBytes: null, temporaryBytes: null, executionSeconds: 28_800 },
    adapters: [],
  });
}

type Via = "menu" | "chat" | "mcp";

async function setup() {
  resources();
  const fs = new Fs();
  const store = new ProjectStoreAccess(DIR, fs);
  registerTestDocument(DIR);
  await ensureTimeline(store);
  let jobs: FakeJobs | undefined;
  const runner: CommandRunner = {
    run: async (program, args): Promise<CommandResult> => {
      if (program === "ffprobe") {
        const spec = jobs?.submitted.find((submitted) => submitted.meta.stagePath === args.at(-1));
        const plan = spec?.meta.plan as
          | {
              duration: number;
              audioExpected: boolean;
              output: { width: number; height: number; fps: number };
            }
          | undefined;
        const output = plan?.output ?? { width: 1920, height: 1080, fps: 30 };
        const duration = plan?.duration ?? 2;
        return {
          code: 0,
          stdout: JSON.stringify({
            streams: [
              {
                codec_type: "video",
                width: output.width,
                height: output.height,
                avg_frame_rate: `${output.fps}/1`,
                nb_read_frames: String(Math.ceil(duration * output.fps)),
                duration: String(duration),
              },
              ...(plan?.audioExpected ? [{ codec_type: "audio", duration: String(duration) }] : []),
            ],
            format: { duration: String(duration) },
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  await addClipsTool(
    { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
    { store, runner },
  );
  jobs = new FakeJobs();
  jobs.delivery = localDeliveryPort(store);
  jobs.onStart = (spec) => fs.writeTextFile(spec.args[spec.args.length - 1], "a whole video");
  __setJobSupervisor(jobs);
  const base: ClientToolContext = { store, runner };
  /** The export tool as an assistant over MCP, the in-app chat or the Export menu calls it. */
  const exportAs = async (via: Via) =>
    (await exportTimelineTool(
      {},
      agentToolContext(
        via === "mcp" ? { ...base, surface: "mcp" } : base,
        new AbortController().signal,
        via === "chat" ? ORIGIN : undefined,
      ),
    )) as Any;
  return { fs, store, jobs, exportAs };
}

beforeEach(() => {
  useAuth.setState({ profile: null });
  useExportJob.setState({ calibrations: [] });
  __setExportFlag("faster_x264", false);
  __resetRouteEstimatesMemo();
});
afterEach(async () => {
  await resetTestDocuments();
  // A test that failed half way leaves exports running: they are cancelled, and the wait is bounded.
  for (const open of listExports()) cancelExport(open.job_id, "app");
  await Promise.race([whenExportsSettle(), new Promise((resolve) => setTimeout(resolve, 4_000))]);
  __resetExportQueue();
  __resetProjectJobs();
  __resetJobSupervisor();
  __setExportConfirmationForTests(null);
  setPcCheckService(null);
  vi.restoreAllMocks();
  __resetExportFlags();
  __resetRouteEstimatesMemo();
  useExportJob.setState({ calibrations: [] });
});

describe("the app starts the export again by itself when the honest estimate of the gentler setting is a long one", () => {
  it.each(["mcp", "chat", "menu"] as const)(
    "over %s: the memory stop is followed by a restart that nobody is asked about, and the export finishes",
    async (via) => {
      const t = await setup();
      const asked = vi.fn(async (_message: string, _warning: boolean) => "cancel" as const);
      __setExportConfirmationForTests(asked);
      // a fast PC at the start: the export is not a long one
      checked(0.5);
      const first = await t.exportAs(via);
      await flush();
      expect(first.ok, JSON.stringify(first)).toBe(true);
      expect(t.jobs.submitted).toHaveLength(1);
      expect(asked, "the first attempt asked nobody").not.toHaveBeenCalled();

      // The speed check finishes while the export runs and says this PC is slower than the first guess: priced a rung gentler, the export is long.
      const d = (t.jobs.submitted[0].meta.telemetry as Any).calibration;
      const input = {
        workload: d.workload,
        output: d.output,
        quality: d.quality,
        engine: d.engine,
        encoder: d.encoder,
        rung: 1 as const,
      };
      const pricedAt = (rHat: number, rung: 0 | 1) =>
        admissionEstimateHere(
          { ...input, rung },
          { speedCheck: () => checkRecord(rHat), cores: () => 8 },
        )!.estimate.seconds;
      let low = 0.05;
      let high = 900;
      for (let step = 0; step < 60; step++) {
        const middle = (low + high) / 2;
        if (pricedAt(middle, 1) < 1.25 * LONG_EXPORT_SECONDS) low = middle;
        else high = middle;
      }
      expect(pricedAt(high, 0), "the export itself is not a long one").toBeLessThan(
        LONG_EXPORT_SECONDS,
      );
      expect(pricedAt(high, 1), "the gentler setting is").toBeGreaterThanOrEqual(
        LONG_EXPORT_SECONDS,
      );
      expect(
        estimateExport(d.workload, d.output, d.quality, d.engine, [], d.encoder).seconds,
        "0.27.0 priced both attempts alike, under the line",
      ).toBeLessThan(LONG_EXPORT_SECONDS);
      checked(high);

      t.jobs.exit(first.job_id, -1, MEMORY_SHORT);
      await flush(40);
      expect(restartDecisions().map((decision) => decision.record)).toEqual(["eligible"]);
      expect(t.jobs.submitted, "the export that stopped for memory was started again").toHaveLength(
        2,
      );
      expect(asked, "and nobody was asked about it").not.toHaveBeenCalled();
      const [before, after] = t.jobs.submitted;
      expect([
        (before.meta.telemetry as Any).plan.rung,
        (after.meta.telemetry as Any).plan.rung,
      ]).toEqual([0, 1]);
      expect(listExportRecords()).toHaveLength(1);
      expect(listExportRecords()[0]).toMatchObject({
        job_id: after.id,
        state: "running",
        attempt: 2,
        restarted: "gentler_setting",
        restartReason: "memory_short",
      });
      // the card and the assistant are still told, honestly, what the gentler setting costs
      expect((listExportRecords()[0] as Any).estimate.seconds).toBeGreaterThanOrEqual(
        LONG_EXPORT_SECONDS,
      );

      t.jobs.exit(after.id, 0);
      expect(await whenExportEnds(first.job_id)).toMatchObject({ job_id: after.id, state: "done" });
      await whenExportsSettle();
      await whenExportTelemetrySettles();
      expect(await t.fs.exists(DEST)).toBe(true);
    },
  );
});
