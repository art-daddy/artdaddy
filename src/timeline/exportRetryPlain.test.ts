// The person's Try again after an export that ran a lean render path builds 0.27.0's recipe (Phase 3a: DESIGN-3a section 7, rollback layer 2): the one
// click that makes sure a lean path cannot fail the same project twice. The plumbing has four links, and each test below fails if its link is missing:
//   1. the queue remembers, on the export's record, that its plan ran a lean path (`ExportRecord.lean`, from `meta.plan.lean.ran`),
//   2. `retryExport` hands `plain` to the retry function when the failed record has it,
//   3. the export tool (`retryOf` -> `exportTool` -> `exportTimelineTool` -> `prepareRender`) builds the plan with `lean: { plain: true }`, and
//   4. the export the tool starts as a plain retry offers its own Try again as plain too (`retryOf`'s `staysPlain`): a plain export ran no lean path, so its
//      record says nothing, and without this the second Try again of a chain would build the lean recipe again.
// Part 1 drives the real queue with a fake retry function (what the card's button calls). Part 2 drives the real tool, plan and queue against a fake
// supervisor and reads what was handed to ffmpeg. The oracle for "0.27.0's recipe" is not the code under test: it is the SAME tool run with every lean
// switch off, which the builder's own tests and the frozen corpus pin to 0.27.0 byte for byte. Nothing here runs ffmpeg or reaches a vendor.
import { createHash } from "node:crypto";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { EXPORT_REASON_CODES } from "../api/exportReason";
import { __setExportConfirmationForTests } from "../lib/confirm";
import * as host from "../platform/host";
import { useAuth } from "../store/auth";
import { useExportJob } from "../store/exportJob";
import { __resetJobNotes } from "../store/jobNotes";
import { FakeJobs } from "../test/fakeJobs";
import { findClipById, MemFs, registerTestDocument, resetTestDocuments } from "../test/timelineKit";
import { agentToolContext } from "../tools/agentStore";
import type { CommandResult, CommandRunner } from "../tools/command";
import type { ClientToolContext } from "../tools/context";
import { __resetProjectJobs } from "../tools/genJobs";
import { __resetJobSupervisor, __setJobSupervisor, type JobSpec } from "../tools/jobSupervisor";
import { joinPath, ProjectStoreAccess } from "../tools/store";
import { findChip, markChipSuspect, type ChipVerdict } from "./chipTest";
import { ctxApplyOp, ensureTimeline, loadTimeline } from "./engine";
import {
  __resetExportQueue,
  listExportRecords,
  localDeliveryPort,
  offerExportRetry,
  retryExport,
  submitExport as submitWithDependencies,
  whenExportEnds,
  whenExportsSettle,
  whenExportTelemetrySettles,
  type ExportRecord,
  type ExportRetry,
} from "./exportQueue";
import type { Rung } from "./exportPlan";
import { failureOf } from "./exportWords";
import { LEAN_FLAG_NAMES } from "./leanOptions";
import { LEAN_FIXES, LEAN_KEPT_REASONS, type LeanRecord } from "./leanRecord";
import { addClipsTool } from "./placement";
import { buildRenderCommand, exportTimelineTool } from "./render";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// What each settled export reports is recorded: a Try again that is plain must still tell its story as any Try again does.
const reported = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("../api/exportEvents", () => ({
  reportExport: async (event: Record<string, unknown>) => {
    reported.push(event);
  },
}));
// No graphics chip unless a test says so: the chip's own lookup has its own suites.
vi.mock("./chipTest", async (importOriginal) => {
  const real = await importOriginal<typeof import("./chipTest")>();
  return {
    ...real,
    findChip: vi.fn(async () => ({ chip: null, events: [] })),
    markChipSuspect: vi.fn(),
  };
});

beforeEach(() => {
  reported.length = 0;
  useAuth.setState({ profile: null });
  vi.mocked(findChip).mockReset();
  vi.mocked(findChip).mockResolvedValue({ chip: null, events: [] });
  vi.mocked(markChipSuspect).mockReset();
});

class Fs extends MemFs {
  async rename(from: string, to: string): Promise<void> {
    const value = this.files.get(joinPath(from));
    if (value === undefined) throw new Error(`ENOENT ${from}`);
    this.files.delete(joinPath(from));
    this.files.set(joinPath(to), value);
  }
  async remove(p: string): Promise<void> {
    this.files.delete(joinPath(p));
  }
  async readBytes(p: string): Promise<Uint8Array> {
    const value = this.files.get(joinPath(p));
    if (value === undefined) throw new Error(`ENOENT ${p}`);
    return new TextEncoder().encode(String(value));
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

const DIR = "C:/proj";
const MEMORY = "Cannot allocate memory";
const DISK = "ENOSPC: no space left on device";
const FLOOR =
  "native render failed: render memory floor crossed: the PC has 410 MiB left and keeps 768 MiB for itself\n";
const GRAPH_REFUSED = "native render failed: ffmpeg: Error initializing filters\n";
const DRIVER =
  "native render failed: [h264_amf @ 0000028f] Error submitting video frame to the encoder\n";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function flush(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await settle();
}

/** The fake supervisors of the test that is running: stopped when it ends, so nothing waits on a process that never exits. */
const liveJobs: FakeJobs[] = [];
afterEach(async () => {
  for (const jobs of liveJobs.splice(0))
    for (const spec of jobs.submitted) jobs.exit(spec.id, -1, "the test is over");
  await resetTestDocuments();
  await whenExportsSettle();
  __resetExportQueue();
  __resetProjectJobs();
  __resetJobSupervisor();
  __resetJobNotes();
  __resetExportFlags();
  useExportJob.getState().setEngine("file-sequence-v1");
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Part 1: the queue. A failed export is submitted for real; the retry function is a fake that writes down what it is asked.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

type Call = { rung: Rung; failedRung: Rung; options: Parameters<ExportRetry>[2] };
interface Failure {
  error: string;
  plan?: { rung: Rung; max_rung?: Rung; ladder?: Rung[] };
  lean?: LeanRecord;
  /** The export ran on a graphics chip (what makes a driver error the chip's fault). */
  chip?: true;
}

const META = {
  duration_s: 60,
  width: 1080,
  height: 1920,
  fps: 30,
  quality: "medium",
  project_id: "",
};

/** Submit an export that fails with `failure.error`, offer a fake way to start it again, press Try again, and report the one call that made. */
async function retriedAfter(
  failure: Failure,
  saveTo?: string,
): Promise<{ record: ExportRecord; call: Call }> {
  const GIB = 1024 ** 3;
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
  const store = new ProjectStoreAccess(DIR, new Fs());
  const calls: Call[] = [];
  const submitted = await submitWithDependencies({
    store,
    dependencies: [],
    destPath: "C:/out/final.mp4",
    stagePath: "C:/out/final.mp4.part-x",
    filename: "final.mp4",
    meta: {
      ...META,
      ...(failure.plan
        ? { plan: { ...failure.plan, ...(failure.lean ? { lean: failure.lean } : {}) } }
        : {}),
      ...(failure.chip
        ? { choice: { encoder: "amd" as const, reason: "over_minute" as const, tests: [] } }
        : {}),
    },
    run: async () => {
      throw new Error(failure.error);
    },
  });
  await whenExportsSettle();
  const record = listExportRecords().find((r) => r.job_id === submitted.job_id)!;
  expect(record.state).toBe("failed");
  offerExportRetry(submitted.job_id, async (rung, failedRung, options) => {
    calls.push({ rung, failedRung, options });
    return { ok: true };
  });
  await retryExport(submitted.job_id, undefined, saveTo ? { saveTo } : {});
  expect(calls).toHaveLength(1);
  return { record, call: calls[0] };
}

/** What a correct Try again does with a lean record, as a check that returns what it finds wrong: `plain` exactly when a fix ran, and nothing else about the
 *  call moved compared with the same failure of an export that had no lean record at all. */
function leanRetryFaults(ran: readonly string[], lean: Call, base: Call): string[] {
  const faults: string[] = [];
  const plain = "plain" in lean.options ? lean.options.plain : undefined;
  if (ran.length > 0 && plain !== true) faults.push("a lean path ran and Try again is not plain");
  if (ran.length === 0 && plain !== undefined)
    faults.push("no lean path ran and Try again is plain");
  if ("plain" in base.options) faults.push("an export with no lean record was retried plain");
  if (lean.rung !== base.rung || lean.failedRung !== base.failedRung) faults.push("the rung moved");
  const { plain: _plain, ...rest } = lean.options;
  if (JSON.stringify(rest) !== JSON.stringify(base.options)) faults.push("another option moved");
  return faults;
}

describe("the queue: Try again is plain exactly when the failed export ran a lean path", () => {
  it("an export whose plan ran the zoom fix keeps that on its record and is retried plain", async () => {
    const { record, call } = await retriedAfter({
      error: GRAPH_REFUSED,
      plan: { rung: 0 },
      lean: { ran: ["zoom"], kept: [] },
    });
    expect(record.lean).toBe(true);
    expect(call.options.plain).toBe(true);
  });

  it.each([
    [
      "no lean record at all (an export made before the lean paths, or one nothing planned)",
      undefined,
    ],
    ["an empty record (a plain build, or nothing was eligible)", { ran: [], kept: [] }],
    ["a record that only kept 0.27.0's recipe", { ran: [], kept: ["flag_off", "not_proven"] }],
  ] as [string, LeanRecord | undefined][])(
    "%s is retried as it always was: no plain, not even an empty key",
    async (_name, lean) => {
      const { record, call } = await retriedAfter({
        error: GRAPH_REFUSED,
        plan: { rung: 0 },
        ...(lean ? { lean } : {}),
      });
      expect(record.lean).toBeUndefined();
      expect(call.options).not.toHaveProperty("plain");
    },
  );

  it("an export with no plan at all (a copy, an adopted one) is retried as it always was", async () => {
    const { record, call } = await retriedAfter({ error: GRAPH_REFUSED });
    expect(record).not.toHaveProperty("lean");
    expect(call.options).not.toHaveProperty("plain");
  });

  // A table that drives behaviour is walked in full: one member working says nothing about the others.
  it.each(LEAN_FIXES)("a plan that ran only the %s fix is retried plain", async (fix) => {
    const { record, call } = await retriedAfter({
      error: GRAPH_REFUSED,
      plan: { rung: 0 },
      lean: { ran: [fix], kept: [] },
    });
    expect(record.lean).toBe(true);
    expect(call.options.plain).toBe(true);
  });

  it.each(LEAN_KEPT_REASONS)(
    "a plan that ran nothing and kept 0.27.0's recipe for %s is not retried plain",
    async (reason) => {
      const { call } = await retriedAfter({
        error: GRAPH_REFUSED,
        plan: { rung: 0 },
        lean: { ran: [], kept: [reason] },
      });
      expect(call.options).not.toHaveProperty("plain");
    },
  );

  it("a failure for lack of memory is still one rung gentler, and plain as well (the rung logic is untouched)", async () => {
    const { call } = await retriedAfter({
      error: MEMORY,
      plan: { rung: 0 },
      lean: { ran: ["zoom"], kept: [] },
    });
    expect(call.rung).toBe(1);
    expect(call.failedRung).toBe(0);
    expect(call.options.plain).toBe(true);
  });

  it("the graphics chip's failure is still a retry on the processor from the normal rung, and plain as well", async () => {
    const { record, call } = await retriedAfter({
      error: DRIVER,
      plan: { rung: 0 },
      lean: { ran: ["zoom"], kept: [] },
      chip: true,
    });
    expect(record.chipFailed).toBe(true);
    expect(call.rung).toBe(0);
    expect(call.options.processor).toBe(true);
    expect(call.options.plain).toBe(true);
  });

  it("the folder the person chose (Save somewhere else) is carried; after a full drive the retry keeps the lean recipe, after a failure of the recipe it is plain", async () => {
    const afterDisk = await retriedAfter(
      { error: DISK, plan: { rung: 0 }, lean: { ran: ["zoom"], kept: [] } },
      "E:\\Elsewhere",
    );
    expect(afterDisk.call.options.saveTo).toBe("E:\\Elsewhere");
    expect(afterDisk.call.options).not.toHaveProperty("plain");
    __resetExportQueue();
    const afterGraph = await retriedAfter(
      { error: GRAPH_REFUSED, plan: { rung: 0 }, lean: { ran: ["zoom"], kept: [] } },
      "E:\\Elsewhere",
    );
    expect(afterGraph.call.options.saveTo).toBe("E:\\Elsewhere");
    expect(afterGraph.call.options.plain).toBe(true);
  });

  // A failure no recipe can cause (the drive is full or cannot be written, a source file is gone) keeps the lean recipe: 0.27.0's would only be slower. Every other failure the
  // reason list has is plain after a lean export: a recipe could have caused it (a refused graph, a failed check, memory, time, an interruption of unknown cause).
  const ENVIRONMENT: Array<[string, string]> = [
    ["storage_full", DISK],
    ["storage_unavailable", "EACCES: permission denied, open 'E:/out/final.mp4.part'"],
    ["source_unavailable", "ENOENT: no such file or directory, open 'C:/media/a.mov'"],
  ];
  const RECIPE: Array<[string, string]> = [
    ["render_failed", GRAPH_REFUSED],
    ["memory_limit", MEMORY],
    ["time_limit", "execution deadline expired: the export stalled"],
    ["verification_failed", "artifact verification failed: frame count 59 of 60"],
    ["interrupted", "the app was interrupted: restart"],
    ["unknown", "something odd happened"],
  ];
  it.each(ENVIRONMENT)(
    "a lean export that failed for %s is retried as it was: no plain",
    async (_code, error) => {
      const { record, call } = await retriedAfter({
        error,
        plan: { rung: 0 },
        lean: { ran: ["zoom", "stills"], kept: [] },
      });
      expect(failureOf(error).code).toBe(_code);
      expect(record.lean).toBe(true);
      expect(call.options).not.toHaveProperty("plain");
    },
  );
  it.each(RECIPE)("a lean export that failed for %s is retried plain", async (_code, error) => {
    const { call } = await retriedAfter({
      error,
      plan: { rung: 0 },
      lean: { ran: ["zoom", "stills"], kept: [] },
    });
    expect(failureOf(error).code).toBe(_code);
    expect(call.options.plain).toBe(true);
  });
  it("the two lists above are the whole reason list: nothing is classified by accident", () => {
    const listed = new Set([...ENVIRONMENT, ...RECIPE].map(([code]) => code));
    const notAFailure = new Set(["none", "cancelled", "declined"]);
    for (const code of EXPORT_REASON_CODES)
      expect(listed.has(code) || notAFailure.has(code), code).toBe(true);
  });

  // The rule, over every failure the retry treats differently and every lean record: the lean record adds `plain` and changes nothing else about the call (after a failure no recipe can cause, not even that).
  const SHAPES: readonly Failure[] = [
    { error: MEMORY, plan: { rung: 0 } },
    { error: MEMORY, plan: { rung: 1 } },
    { error: MEMORY, plan: { rung: 1, max_rung: 1 } },
    { error: DISK, plan: { rung: 2 } },
    { error: DRIVER, plan: { rung: 0 }, chip: true },
    { error: DRIVER, plan: { rung: 1 }, chip: true },
  ];
  it("for any failure and any lean record, the call differs from the one without a record by `plain` alone, and only when a fix ran and the failure is one a recipe can cause", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...SHAPES),
        fc.subarray([...LEAN_FIXES]),
        fc.subarray([...LEAN_KEPT_REASONS]),
        fc.constantFrom(undefined, "E:\\Elsewhere"),
        async (shape, ran, kept, saveTo) => {
          __resetExportQueue();
          const withRecord = await retriedAfter({ ...shape, lean: { ran, kept } }, saveTo);
          __resetExportQueue();
          const without = await retriedAfter(shape, saveTo);
          const environment = [
            "source_unavailable",
            "storage_unavailable",
            "storage_full",
          ].includes(failureOf(shape.error).code);
          if (environment) expect(withRecord.call).toEqual(without.call);
          else expect(leanRetryFaults(ran, withRecord.call, without.call)).toEqual([]);
          expect(withRecord.record.lean).toBe(ran.length > 0 ? true : undefined);
          if (shape.chip) expect(without.call.options.processor).toBe(true);
        },
      ),
      { numRuns: 24 },
    );
  });

  describe("negative controls: the check above can fail", () => {
    const base: Call = { rung: 1, failedRung: 0, options: { store: undefined, saveTo: "E:\\x" } };
    const plain: Call = { ...base, options: { ...base.options, plain: true } };

    it("passes the call a correct Try again makes", () => {
      expect(leanRetryFaults(["zoom"], plain, base)).toEqual([]);
      expect(leanRetryFaults([], base, base)).toEqual([]);
    });

    it("rejects the options built the old way (before this change): a lean path ran and nothing says plain", () => {
      expect(leanRetryFaults(["zoom"], base, base)).toEqual([
        "a lean path ran and Try again is not plain",
      ]);
    });

    // The pre-change assembly in `retryExport`, copied as it was: what the record knows about a chip and the folder chosen, and nothing about a lean path.
    const oldWayOptions = (record: ExportRecord, saveTo?: string): Call["options"] => ({
      store: undefined,
      ...(record.chipFailed === true ? { processor: true as const } : {}),
      ...(saveTo ? { saveTo } : {}),
    });

    it("rejects the old way on a real record of an export that ran a lean path, so the check in the queue tests would have failed without the change", async () => {
      const shape: Failure = { error: DRIVER, plan: { rung: 0 }, chip: true };
      const ran = await retriedAfter({ ...shape, lean: { ran: ["zoom"], kept: [] } }, "E:\\x");
      const none = await retriedAfter(shape, "E:\\x");
      expect(leanRetryFaults(["zoom"], ran.call, none.call)).toEqual([]);
      const oldWay: Call = { ...ran.call, options: oldWayOptions(ran.record, "E:\\x") };
      expect(oldWay.options).toEqual(none.call.options);
      expect(leanRetryFaults(["zoom"], oldWay, none.call)).toEqual([
        "a lean path ran and Try again is not plain",
      ]);
    });

    it("rejects a Try again that is plain when no lean path ran", () => {
      expect(leanRetryFaults([], plain, base)).toEqual(["no lean path ran and Try again is plain"]);
    });

    it("rejects a retry that moved the rung, dropped the folder or dropped the processor", () => {
      expect(leanRetryFaults(["zoom"], { ...plain, rung: 0 }, base)).toEqual(["the rung moved"]);
      const { saveTo: _folder, ...noFolder } = plain.options;
      expect(leanRetryFaults(["zoom"], { ...plain, options: noFolder }, base)).toEqual([
        "another option moved",
      ]);
      const chip: Call = { ...base, options: { ...base.options, processor: true } };
      expect(leanRetryFaults(["zoom"], { ...chip, options: { ...plain.options } }, chip)).toEqual([
        "another option moved",
      ]);
    });

    it("rejects a baseline that was already plain (the two runs would not differ by `plain` alone)", () => {
      expect(leanRetryFaults(["zoom"], plain, plain)).toContain(
        "an export with no lean record was retried plain",
      );
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Part 2: the real tool. A project with one zooming clip, the real export tool, plan and queue, a fake supervisor, and a runner that answers the lean probe.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

const showinfo = (instance: number, size: string): string =>
  `[Parsed_showinfo_${instance} @ 000001ff1b7ae080] n:   0 pts:      0 pts_time:0       duration:    256 duration_time:0.0166667 fmt:yuv420p cl:left sar:1/1 s:${size} i:P iskey:1 type:I checksum:3D5BDD03 plane_checksum:[674E12E6 148E3791 D420928C] mean:[126 127 126] stdev:[55.9 79.5 83.8]`;
/** What ffmpeg says about the zooming picture: it arrives as 1920x1080 and is 2304x1296 after the graph's own pre-scale. */
const PROBE_ANSWER = [showinfo(1, "1920x1080"), showinfo(3, "2304x1296")].join("\n");

/** Every lean switch to one state. The switch names are lane L2's (`LEAN_FLAG_NAMES`); until they are known to the client a name is never on. */
function leanSwitches(on: boolean): void {
  for (const name of Object.values(LEAN_FLAG_NAMES)) __setExportFlag(name as never, on);
}

type Retrying = NonNullable<Parameters<typeof exportTimelineTool>[2]>;

async function world() {
  const fs = new Fs();
  const store = new ProjectStoreAccess(DIR, fs);
  registerTestDocument(DIR);
  await ensureTimeline(store);
  const probes: string[][] = [];
  let jobs: FakeJobs | undefined;
  const runner: CommandRunner = {
    run: async (program, args): Promise<CommandResult> => {
      // Under the page only the lean probe runs ffmpeg: the render itself is the supervisor's job.
      if (program === "ffmpeg") {
        probes.push(args);
        return { code: 0, stdout: "", stderr: PROBE_ANSWER };
      }
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
  const base: ClientToolContext = { store, runner };
  const added = (await addClipsTool(
    { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
    base,
  )) as Any;
  const clipId = String(added.created[0].clip_id);
  // A Ken-Burns push-in on a cover-fit clip: the shape fix 1 takes the mask for.
  const zoomed = (await ctxApplyOp(base, "give the clip a zoom", (timeline) => {
    const clip = findClipById(timeline, clipId);
    clip.fit = "cover";
    clip.transform = {
      position: { x: 0.5, y: 0.5 },
      scale: [
        { t: 0, v: 1 },
        { t: 60, v: 1.2 },
      ],
    };
    return {};
  })) as Any;
  expect(zoomed.ok, JSON.stringify(zoomed)).toBe(true);
  jobs = new FakeJobs();
  liveJobs.push(jobs);
  jobs.delivery = localDeliveryPort(store);
  // The process writes its output where it was told: the last argument.
  jobs.onStart = (spec) => fs.writeTextFile(spec.args[spec.args.length - 1], "a whole video");
  __setJobSupervisor(jobs);

  const exportNow = async (
    name: string,
    extra: Partial<ClientToolContext> = {},
    retrying?: Retrying,
  ) =>
    (await exportTimelineTool(
      { name },
      { ...agentToolContext(base, new AbortController().signal), ...extra },
      retrying,
    )) as Any;
  /** The filter graph of a submitted export: inline, or in the file the command reads it from. */
  const graphOf = async (spec: JobSpec): Promise<string> => {
    const inline = spec.args.indexOf("-filter_complex");
    if (inline >= 0) return spec.args[inline + 1];
    const staged = spec.args.indexOf("-/filter_complex");
    if (staged < 0 || !spec.cwd) throw new Error("no filter graph in this command");
    return fs.readTextFile(joinPath(spec.cwd, spec.args[staged + 1]));
  };
  /** A submitted export as the supervisor was given it, read while it runs (the staged graph goes when the job settles): the filter graph, the command but
   *  for the file it writes (the only thing that differs between two exports of one project), the encoder, and what the plan recorded. */
  const look = async (spec: JobSpec) => {
    const plan = (spec.meta.telemetry as { plan: { rung: number; lean?: LeanRecord } }).plan;
    return {
      id: spec.id,
      graph: await graphOf(spec),
      command: spec.args.slice(0, -1),
      codec: spec.args[spec.args.lastIndexOf("-c:v") + 1],
      rung: plan.rung,
      lean: plan.lean,
    };
  };
  /** The supervisor's process for `jobId` fails with `stderr`; resolves with the export's record once the queue has settled it. */
  const failWith = async (jobId: string, stderr: string) => {
    jobs!.exit(jobId, -1, stderr);
    return whenExportEnds(jobId);
  };
  /** The graph the unmodified builder makes for this project with no `lean` option at all (rung 0): an oracle that does not go through the export tool. */
  const todaysGraph = async (): Promise<string> =>
    buildRenderCommand(await loadTimeline(store), "/out.mp4").filterComplex;
  return { fs, store, jobs, probes, exportNow, look, failWith, todaysGraph };
}
type World = Awaited<ReturnType<typeof world>>;
type Look = Awaited<ReturnType<World["look"]>>;

/** 0.27.0's export of this project, at `minRung`: the same tool with every lean switch off and no retry about it, looked at while it runs. */
async function oldRecipe(t: World, minRung?: Rung): Promise<Look> {
  leanSwitches(false);
  const started = await t.exportNow(
    `old${minRung ?? 0}`,
    {},
    minRung ? { from: 0, minRung } : undefined,
  );
  expect(started.ok, JSON.stringify(started)).toBe(true);
  await flush();
  const seen = await t.look(t.jobs.submitted.at(-1)!);
  expect(seen.id).toBe(started.job_id);
  expect(seen.lean?.ran ?? []).toEqual([]);
  return seen;
}

describe("the export tool: the retry builds 0.27.0's command", () => {
  it("(b) the first try takes the mask; the person's click on its failure builds today's graph, asks ffmpeg nothing and counts nothing", async () => {
    const t = await world();
    leanSwitches(true);
    const first = await t.exportNow("a");
    expect(first.ok, JSON.stringify(first)).toBe(true);
    await flush();
    const tried = await t.look(t.jobs.submitted[0]);
    expect(tried.lean?.ran).toContain("zoom");
    expect(tried.graph).toContain("alphamerge");
    expect(tried.graph).not.toContain("gte(X,(W-");
    expect(t.probes).toHaveLength(1);

    expect(await t.failWith(first.job_id, GRAPH_REFUSED)).toMatchObject({
      state: "failed",
      canRetry: true,
      lean: true,
    });
    await retryExport(first.job_id);
    await flush();
    expect(listExportRecords().some((r) => r.job_id === first.job_id)).toBe(false);
    expect(t.jobs.submitted).toHaveLength(2);
    const retried = await t.look(t.jobs.submitted[1]);

    expect(retried.lean).toEqual({ ran: [], kept: [] });
    expect(t.probes).toHaveLength(1); // the plain build asked ffmpeg nothing, though every switch is on
    expect(retried.graph).toContain("gte(X,(W-");
    expect(retried.graph).not.toContain("alphamerge");

    // 0.27.0's own command for the project, from the same tool with the switches off: the retry is that, byte for byte
    const old = await oldRecipe(t);
    expect(retried.graph).toBe(old.graph);
    expect(retried.command).toEqual(old.command);
    expect(retried.graph).toBe(await t.todaysGraph());
    expect(retried.graph).not.toBe(tried.graph);
  });

  it("(b) the same call without `plain`, with the zoom switch on and the probe answering, builds the mask", async () => {
    const t = await world();
    leanSwitches(true);
    const plainCall = await t.exportNow("plain", {}, { from: 0, minRung: 0, plain: true });
    const leanCall = await t.exportNow("lean", {}, { from: 0, minRung: 0 });
    expect(plainCall.ok && leanCall.ok, JSON.stringify([plainCall, leanCall])).toBe(true);
    await flush();
    const plain = await t.look(t.jobs.submitted[0]);
    const lean = await t.look(t.jobs.submitted[1]);
    expect(plain.lean).toEqual({ ran: [], kept: [] });
    expect(plain.graph).not.toContain("alphamerge");
    expect(lean.lean?.ran).toContain("zoom");
    expect(lean.graph).toContain("alphamerge");
    expect(t.probes).toHaveLength(1); // only the call without `plain` asked
    const old = await oldRecipe(t);
    expect(plain.graph).toBe(old.graph);
    expect(plain.command).toEqual(old.command);
    expect(lean.graph).not.toBe(old.graph);
  });

  it("(c) a failure for lack of memory steps down a rung and is plain at that rung, with the same command as 0.27.0 at that rung", async () => {
    const t = await world();
    leanSwitches(true);
    const first = await t.exportNow("a");
    await flush();
    const tried = await t.look(t.jobs.submitted[0]);
    expect(tried.rung).toBe(0);
    expect(tried.lean?.ran).toContain("zoom");
    expect(await t.failWith(first.job_id, FLOOR)).toMatchObject({ state: "failed", lean: true });

    await retryExport(first.job_id);
    await flush();
    const retried = await t.look(t.jobs.submitted[1]);
    expect(retried.rung).toBe(1);
    expect(listExportRecords().at(-1)).toMatchObject({ state: "running", rung: 1 });
    expect(retried.lean).toEqual({ ran: [], kept: [] });
    expect(retried.graph).not.toContain("alphamerge");

    const old = await oldRecipe(t, 1);
    expect(old.rung).toBe(1);
    expect(retried.graph).toBe(old.graph);
    expect(retried.command).toEqual(old.command);
    expect(retried.graph).toBe(await t.todaysGraph());
  });

  it("(d) after a graphics chip failure the retry is on the processor and plain, with the command 0.27.0 gives the processor", async () => {
    const t = await world();
    leanSwitches(true);
    const chip: ChipVerdict = {
      maker: "amd",
      adapter: { maker: "amd", device: "15bf", driver: "32.0.1" },
      sizeClass: "hd",
      ok: true,
      result: "passed",
      ssimMilli: 870,
      ms: 1800,
    };
    vi.mocked(findChip).mockResolvedValue({ chip, events: [] });
    const first = await t.exportNow("a", { exportMode: "fast" });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    await flush();
    const tried = await t.look(t.jobs.submitted[0]);
    expect(tried.codec).toBe("h264_amf");
    expect(tried.lean?.ran).toContain("zoom");
    expect(await t.failWith(first.job_id, DRIVER)).toMatchObject({
      state: "failed",
      chipFailed: true,
      lean: true,
    });

    await retryExport(first.job_id);
    await flush();
    const retried = await t.look(t.jobs.submitted[1]);
    expect(retried.codec).toBe("libx264");
    expect(retried.rung).toBe(0);
    expect(retried.lean).toEqual({ ran: [], kept: [] });
    expect(retried.graph).not.toContain("alphamerge");

    const old = await oldRecipe(t);
    expect(old.codec).toBe("libx264");
    expect(retried.graph).toBe(old.graph);
    expect(retried.command).toEqual(old.command);
    expect(retried.graph).toBe(await t.todaysGraph());
  });

  it("an export that ran no lean path is retried exactly as before: the lean paths are built afresh, nothing is made plain", async () => {
    const t = await world();
    leanSwitches(false); // the server switched every fix off: the first try is 0.27.0's recipe
    const first = await t.exportNow("a");
    await flush();
    expect((await t.look(t.jobs.submitted[0])).lean?.ran).toEqual([]);
    expect(await t.failWith(first.job_id, GRAPH_REFUSED)).toMatchObject({ state: "failed" });
    expect(listExportRecords().find((r) => r.job_id === first.job_id)).not.toHaveProperty("lean");

    leanSwitches(true); // switched on again before the person pressed Try again
    await retryExport(first.job_id);
    await flush();
    const retried = await t.look(t.jobs.submitted[1]);
    expect(retried.lean?.ran).toContain("zoom"); // not plain: no lean path had failed it
    expect(retried.graph).toContain("alphamerge");
  });

  it("everything else about the retry stays: its story tells the Try again, the plain export finishes, and its file is delivered", async () => {
    const t = await world();
    leanSwitches(true);
    const first = await t.exportNow("a");
    await flush();
    await t.failWith(first.job_id, FLOOR);
    await retryExport(first.job_id);
    await flush();
    const second = listExportRecords().at(-1)!;
    expect(second).toMatchObject({ state: "running", rung: 1, canRetry: true });
    expect((await t.look(t.jobs.submitted[1])).lean).toEqual({ ran: [], kept: [] });

    t.jobs.exit(second.job_id, 0);
    expect((await whenExportEnds(second.job_id))?.state).toBe("done");
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    const report = reported.at(-1)!;
    const story = (report.trace as Any[]).map((e) => (e.v ? `${e.e}:${e.v}` : e.e));
    expect(report).toMatchObject({ status: "done" });
    expect(story).toEqual(expect.arrayContaining(["requested:menu", "retry:try_again"]));
    expect((report.trace as Any[]).find((e) => e.e === "retry")).toMatchObject({ n: 0, m: 1 });
    expect(await t.fs.exists("C:/Users/test/Downloads/a.mp4")).toBe(true);
  });
});

// The chain: the card keeps offering Try again on every export it starts, so a project that failed with a lean path may be tried again several times (down the
// rungs for lack of memory, then for another reason). The lean record lives on the export that RAN a lean path, and a plain export has none; so the rule that
// a lean path cannot fail the same project twice needs the plain recipe to be carried down the chain, the way the folder the person chose is.
describe("the Try again chain: once an export has been made plain, every Try again after it is plain", () => {
  it("down the whole ladder for lack of memory: lean at the normal rung, then plain at the gentle and at the gentlest rung", async () => {
    const t = await world();
    leanSwitches(true);
    let current = await t.exportNow("a");
    const runs: Look[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      await flush();
      runs.push(await t.look(t.jobs.submitted.at(-1)!));
      if (attempt === 2) break;
      await t.failWith(current.job_id, FLOOR);
      await retryExport(current.job_id);
      current = { job_id: listExportRecords().at(-1)!.job_id };
    }
    expect(runs.map((run) => run.rung)).toEqual([0, 1, 2]);
    expect(runs[0].lean?.ran).toContain("zoom");
    expect(runs[1].lean).toEqual({ ran: [], kept: [] });
    expect(runs[2].lean).toEqual({ ran: [], kept: [] });
    expect(runs[2].graph).toBe(runs[1].graph);
    expect(runs[2].graph).toBe(await t.todaysGraph());
    expect(runs[2].graph).not.toBe(runs[0].graph);
    expect(t.probes).toHaveLength(1); // only the first try ever asked ffmpeg anything
  });

  it("through every kind of retry: a try without a lean path, then one with, then plain, then plain again after a failure of another kind", async () => {
    const t = await world();
    leanSwitches(false); // the first try runs no lean path: 0.27.0's recipe
    const first = await t.exportNow("a");
    await flush();
    expect((await t.look(t.jobs.submitted[0])).lean?.ran).toEqual([]);
    await t.failWith(first.job_id, GRAPH_REFUSED);

    leanSwitches(true); // switched on before Try again: nothing had run lean, so this one is built with the lean paths
    await retryExport(first.job_id);
    await flush();
    const second = await t.look(t.jobs.submitted[1]);
    expect(second.lean?.ran).toContain("zoom");
    await t.failWith(listExportRecords().at(-1)!.job_id, GRAPH_REFUSED);

    await retryExport(listExportRecords().at(-1)!.job_id); // a lean path ran and failed: plain
    await flush();
    const third = await t.look(t.jobs.submitted[2]);
    expect(third.lean).toEqual({ ran: [], kept: [] });
    expect(listExportRecords().at(-1)).not.toHaveProperty("lean"); // a plain export has no lean path to remember
    await t.failWith(listExportRecords().at(-1)!.job_id, DISK);

    await retryExport(listExportRecords().at(-1)!.job_id); // the plain export failed for another reason: still plain
    await flush();
    const fourth = await t.look(t.jobs.submitted[3]);
    expect(fourth.lean).toEqual({ ran: [], kept: [] });
    expect(fourth.graph).toBe(third.graph);
    expect(fourth.graph).toBe(await t.todaysGraph());
    expect(t.probes).toHaveLength(1); // only the second try asked: the first had every switch off, and a plain one never asks
  });
});
