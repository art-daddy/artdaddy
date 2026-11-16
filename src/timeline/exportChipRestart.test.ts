// The graphics chip's safety net: when the chip fails an export, the app starts it again ONCE on the processor by itself, through the one
// restart door, so the export finishes. These drive the real export tool and the real queue against FakeJobs, which plays the app
// process; the chip's own lookup is the test's to answer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __setExportFlag, type ExportFlagName } from "../api/exportFlags";
import { __setExportConfirmationForTests } from "../lib/confirm";
import { useAuth } from "../store/auth";
import { useExportJob } from "../store/exportJob";
import {
  DEST_LONG,
  DRIVER_ERROR,
  GIB,
  MEMORY_SHORT,
  amdChip,
  codecOf,
  encoderOf,
  failTheCheckOf,
  flush,
  holdTheRestart,
  longProject as measuredProject,
  progressBlock,
  rungOf,
  story,
  type Any,
  type ExportRig,
} from "../test/chipExportKit";
import { resetTestDocuments } from "../test/timelineKit";
import { __resetProjectJobs } from "../tools/genJobs";
import { __resetJobSupervisor } from "../tools/jobSupervisor";
import { findChip, markChipSuspect } from "./chipTest";
import { attempts } from "./exportAttempts";
import { formatActivityMark } from "./exportActivity";
import {
  __resetExportQueue,
  cancelExport,
  isDestinationReserved,
  listExportRecords,
  listExports,
  manageExportsTool,
  restartDecisions,
  retryExport,
  restartWords,
  whenExportEnds,
  whenExportTelemetrySettles,
  whenExportsSettle,
} from "./exportQueue";
import { addClipsTool } from "./placement";

const reported = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("../api/exportEvents", () => ({
  reportExport: async (event: Record<string, unknown>) => {
    reported.push(event);
  },
}));
vi.mock("./chipTest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chipTest")>()),
  findChip: vi.fn(async () => ({ chip: null, events: [] })),
  markChipSuspect: vi.fn(),
}));
// What the PC says about itself, as the pre-start check and the decision to start again read it. The longest an export may run is what the pre-start
// check needs before it judges an export "long" or "slow" (a heads-up): nothing says it unless a test does.
const pc = vi.hoisted(() => ({
  available: null as number | null,
  executionSeconds: null as number | null,
}));
// What the restarted export's report says of the restart is held until the owner approves the privacy text.
const held = vi.hoisted(() => ({ send: false }));
vi.mock("./exportRestart", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./exportRestart")>()),
  get SEND_RESTART_FACTS() {
    return held.send;
  },
}));
vi.mock("../platform/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform/host")>()),
  resolveExportResources: vi.fn(async () => ({
    total_memory_bytes: null,
    available_memory_bytes: pc.available,
    scratch_free_bytes: null,
    destination_free_bytes: null,
    budgets: { memoryBytes: null, temporaryBytes: null, executionSeconds: pc.executionSeconds },
    adapters: [],
  })),
}));

const RESTART_FLAGS: readonly ExportFlagName[] = [
  "auto_restart",
  "memory_restart",
  "plan_rung",
  "restart_streamed",
  "chip_restart",
];
// The processor's faster setting is another quiet route and is not what these journeys are about.
const longProject = async (...args: Parameters<typeof measuredProject>): Promise<ExportRig> => {
  const t = await measuredProject(...args);
  reported.length = 0;
  vi.mocked(markChipSuspect).mockClear();
  return t;
};
beforeEach(() => {
  reported.length = 0;
  useAuth.setState({ profile: null });
  pc.available = 8 * GIB;
  pc.executionSeconds = null;
  held.send = false;
  __setExportFlag("faster_x264", false);
  vi.mocked(findChip).mockReset();
  vi.mocked(findChip).mockResolvedValue({ chip: null, events: [] });
  vi.mocked(markChipSuspect).mockReset();
});
afterEach(async () => {
  vi.useRealTimers();
  __setExportConfirmationForTests(null);
  await resetTestDocuments();
  // A test that failed half way leaves exports running: they are cancelled, and the wait is bounded.
  for (const open of listExports()) cancelExport(open.job_id, "app");
  await Promise.race([whenExportsSettle(), new Promise((resolve) => setTimeout(resolve, 4_000))]);
  __resetExportQueue();
  __resetProjectJobs();
  __resetJobSupervisor();
  useExportJob.setState({ calibrations: [] });
  useExportJob.getState().setEngine("file-sequence-v1");
  for (const flag of [...RESTART_FLAGS, "faster_x264" as const]) __setExportFlag(flag, true);
});

const outcomes = async (jobId?: string): Promise<Any[]> =>
  ((await manageExportsTool({ action: "list", ...(jobId ? { job_id: jobId } : {}) })) as Any)
    .exports as Any[];
const until = (check: () => void) => vi.waitFor(check, { timeout: 5_000, interval: 20 });

const ENGINES = ["file-sequence-v1", "partition-pipes-v1"] as const;
const FAULTS = ["after some frames", "at the check of the finished file"] as const;

/** A long project on the chip, started, and failed the way the chip fails: some frames in, or at the check of the file it made. */
async function chipFails(
  when: (typeof FAULTS)[number],
  engine: (typeof ENGINES)[number] = "file-sequence-v1",
  error = DRIVER_ERROR,
) {
  const t = await longProject(amdChip());
  useExportJob.getState().setEngine(engine);
  const started = await t.exportNow("long");
  await flush();
  const first = t.jobs.submitted.at(-1)!;
  expect(started.ok, JSON.stringify(started)).toBe(true);
  expect(encoderOf(first), "the first attempt runs on the chip").toBe("amd");
  const jobsBefore = t.jobs.submitted.length;
  if (when === "after some frames") {
    t.jobs.stdout(started.job_id, progressBlock(30, 1000));
    await flush(5);
    t.jobs.exit(started.job_id, -1, error);
  } else {
    failTheCheckOf(t, started.job_id);
    t.jobs.exit(started.job_id, 0);
  }
  return { t, firstId: started.job_id as string, jobsBefore };
}

describe("a chip that fails an export ends in a finished export on the processor, and says so", () => {
  describe.each(ENGINES)("on the %s engine", (engine) => {
    it.each(FAULTS)(
      "fails %s: the same export starts again by itself on the processor and finishes",
      async (when) => {
        const { t, firstId, jobsBefore } = await chipFails(when, engine);
        await until(() => expect(t.jobs.submitted.length).toBe(jobsBefore + 1));
        await flush(40);
        expect(t.jobs.submitted.length, "one successor, not two").toBe(jobsBefore + 1);
        const second = t.jobs.submitted.at(-1)!;
        expect(second.id).not.toBe(firstId);
        expect(encoderOf(second), "on the processor").toBe("x264");
        if (engine === "file-sequence-v1") expect(codecOf(second)).toBe("libx264");
        expect(rungOf(second), "from the normal setting").toBe(0);

        // One export to the person: the failed attempt is gone from the card and the queue, the new one is its second attempt.
        expect(listExportRecords().map((r) => r.job_id)).toEqual([second.id]);
        expect(listExportRecords()[0]).toMatchObject({
          state: "running",
          attempt: 2,
          restarted: "processor",
          restartReason: "chip_failed",
        });
        expect(listExportRecords()[0].restarting).toBeUndefined();
        expect(listExportRecords()[0].chipFailed).toBeUndefined();
        expect(restartDecisions().map((d) => d.record)).toEqual(["eligible"]);
        // The chip is set aside for a day, as it is when nobody restarts anything.
        expect(markChipSuspect).toHaveBeenCalledTimes(1);
        expect(vi.mocked(markChipSuspect).mock.calls[0][0]).toEqual(amdChip().adapter);

        // The assistant holds the first id and sees one export, running, on its second attempt: not a failure and not two.
        const rows = await outcomes();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          job_id: firstId,
          state: "running",
          attempt: 2,
          restarted: "processor",
        });
        expect(rows[0].note).toMatch(
          /restarted this export once by itself because the graphics chip stopped it/,
        );
        expect(rows[0].note).toMatch(/same export \(same job_id\): do not start another/);
        expect(rows[0]).not.toHaveProperty("failure_code");
        expect(rows[0]).not.toHaveProperty("chip_failed");

        // It finishes: waiting on the id the assistant holds ends with the second attempt, and the file is there, once.
        t.jobs.exit(second.id, 0);
        expect(await whenExportEnds(firstId)).toMatchObject({ job_id: second.id, state: "done" });
        await whenExportsSettle();
        await whenExportTelemetrySettles();
        expect(await t.fs.exists(DEST_LONG)).toBe(true);
        expect(isDestinationReserved(DEST_LONG)).toBe(false);
        expect(
          [...t.fs.files.keys()].filter((key) => key.startsWith("C:/Users/test/Downloads/long")),
        ).toEqual([DEST_LONG]);
        const done = await outcomes();
        expect(done).toHaveLength(1);
        expect(done[0]).toMatchObject({
          job_id: firstId,
          state: "done",
          attempt: 2,
          restarted: "processor",
        });
        expect(attempts.chainOf(firstId)).toHaveLength(2);

        // Each attempt told the truth about itself: the first says the chip failed, the second ran on the processor.
        expect(reported.map((r) => r.status)).toEqual(["failed", "done"]);
        expect(reported[0]).toMatchObject({ encoder: "amd", chip: "amd" });
        expect(story(reported[0])).toContain("chip_failed:chip");
        expect(reported[1]).toMatchObject({ encoder: "x264" });
        expect(story(reported[1])).not.toContain("chip_failed:chip");
        // The first attempt's report claims nothing of a restart, and neither does the second while the send is held.
        for (const report of reported) expect(story(report)).not.toContain("retry:app");
      },
    );
  });

  it("says in the restarted export's report, once the send is approved, that the app started it again: retry `app`, from rung 0 to the processor's normal setting, on x264", async () => {
    held.send = true;
    const { t, jobsBefore } = await chipFails("at the check of the finished file");
    await until(() => expect(t.jobs.submitted.length).toBe(jobsBefore + 1));
    t.jobs.exit(t.jobs.submitted.at(-1)!.id, 0);
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    expect(reported.map((r) => r.status)).toEqual(["failed", "done"]);
    const retry = (report: Any) => (report.trace as Any[]).filter((e) => e.e === "retry");
    expect(retry(reported[0]), "the first attempt's report claims no restart").toEqual([]);
    expect(retry(reported[1])).toEqual([expect.objectContaining({ v: "app", n: 0, m: 0 })]);
    expect(reported[1]).toMatchObject({ encoder: "x264" });
  });

  it("shows the person the gap and the second try in the words of the copy pack, never a failure", async () => {
    const { t } = await chipFails("after some frames");
    await until(() => expect(t.jobs.submitted.length).toBeGreaterThan(1));
    await flush(20);
    expect(listExportRecords()[0].restartReason).toBe("chip_failed");
    expect(restartWords("chip_failed")).toEqual({
      after:
        "Started again on the processor because the graphics chip stopped the first try. It will take longer. Your export settings are kept.",
      failedAgain: expect.any(String),
    });
  });
});

describe("one automatic restart, shared with the memory restart", () => {
  it("does not restart a chip that fails again after a memory restart that kept it: the plain failure and Try again stand", async () => {
    const t = await longProject();
    const started = await t.exportNow("long");
    await flush();
    expect(encoderOf(t.jobs.submitted.at(-1)!)).toBe("amd");
    const jobsBefore = t.jobs.submitted.length;
    // The PC runs short of memory early: the memory restart goes one rung gentler and keeps the chip.
    t.jobs.exit(started.job_id, -1, MEMORY_SHORT);
    await until(() => expect(t.jobs.submitted).toHaveLength(jobsBefore + 1));
    const second = t.jobs.submitted.at(-1)!;
    expect(encoderOf(second), "a memory restart keeps the chip").toBe("amd");
    expect(listExportRecords()[0]).toMatchObject({ attempt: 2, restarted: "gentler_setting" });
    // The chip then fails on that attempt: the one automatic restart is spent.
    t.jobs.exit(second.id, -1, DRIVER_ERROR);
    await flush(60);
    expect(t.jobs.submitted, "no third attempt by itself").toHaveLength(jobsBefore + 1);
    expect(restartDecisions().map((d) => d.record)).toEqual(["eligible", "second"]);
    expect(listExportRecords()).toHaveLength(1);
    expect(listExportRecords()[0]).toMatchObject({
      job_id: second.id,
      state: "failed",
      attempt: 2,
      canRetry: true,
      chipFailed: true,
    });
    expect(attempts.chainOf(started.job_id)).toHaveLength(2);
    const [row] = await outcomes();
    expect(row).toMatchObject({
      job_id: started.job_id,
      state: "failed",
      attempt: 2,
      chip_failed: true,
    });
    expect(row.failure).toMatch(/graphics chip stopped this export/);

    // Try again is the person's own click, and runs on the processor (a click is not an automatic restart).
    await retryExport(started.job_id);
    await flush(60);
    expect(t.jobs.submitted).toHaveLength(jobsBefore + 2);
    expect(encoderOf(t.jobs.submitted.at(-1)!)).toBe("x264");
    t.jobs.exit(t.jobs.submitted.at(-1)!.id, 0);
    await whenExportsSettle();
    expect(await t.fs.exists(DEST_LONG)).toBe(true);
  });

  it("does not restart a memory stop of the processor successor after a chip restart: the same count, the other order", async () => {
    const { t, firstId, jobsBefore } = await chipFails("after some frames");
    await until(() => expect(t.jobs.submitted.length).toBe(jobsBefore + 1));
    const second = t.jobs.submitted.at(-1)!;
    expect(encoderOf(second)).toBe("x264");
    t.jobs.exit(second.id, -1, MEMORY_SHORT);
    await flush(60);
    expect(t.jobs.submitted, "no third attempt by itself").toHaveLength(jobsBefore + 1);
    expect(restartDecisions().map((d) => d.record)).toEqual(["eligible", "second"]);
    expect(listExportRecords()[0]).toMatchObject({
      job_id: second.id,
      state: "failed",
      attempt: 2,
      canRetry: true,
    });
    const [row] = await outcomes();
    expect(row).toMatchObject({
      job_id: firstId,
      state: "failed",
      failure_code: "memory_limit",
      attempt: 2,
    });
    expect(attempts.chainOf(firstId)).toHaveLength(2);
    // Try again goes one rung gentler on the processor, in one click: the chip is set aside for the day, as the real lookup knows.
    vi.mocked(findChip).mockImplementation(async () => ({ chip: null, events: [] }));
    await retryExport(firstId);
    await flush(60);
    expect(t.jobs.submitted).toHaveLength(jobsBefore + 2);
    expect(encoderOf(t.jobs.submitted.at(-1)!)).toBe("x264");
    expect(rungOf(t.jobs.submitted.at(-1)!)).toBeGreaterThan(0);
    t.jobs.exit(t.jobs.submitted.at(-1)!.id, 0);
    await whenExportsSettle();
  });

  it.each([
    ["the chip fails again", DRIVER_ERROR],
    ["the PC runs short of memory", MEMORY_SHORT],
    ["the render fails for another reason", "native render failed: ffmpeg exited with code 1\n"],
  ])(
    "never lets a chain get longer than two attempts by itself: after the first restart %s",
    async (_what, second) => {
      const { t, jobsBefore } = await chipFails("after some frames");
      await until(() => expect(t.jobs.submitted.length).toBe(jobsBefore + 1));
      t.jobs.exit(t.jobs.submitted.at(-1)!.id, -1, second);
      await flush(60);
      expect(t.jobs.submitted).toHaveLength(jobsBefore + 1);
      expect(listExportRecords()).toHaveLength(1);
      expect(listExportRecords()[0]).toMatchObject({ state: "failed", attempt: 2, canRetry: true });
      expect(attempts.chainOf(listExportRecords()[0].job_id)).toHaveLength(2);
    },
  );
});

describe("Cancel, and an edited project, while the app starts the export again", () => {
  it.each([
    ["from the card", (id: string) => cancelExport(id, "person_card")],
    [
      "from the assistant",
      async (id: string) =>
        ((await manageExportsTool({ action: "cancel", job_id: id })) as Any).cancelled,
    ],
  ] as const)(
    "in the gap before it starts stops it for good, %s: nothing is started, nothing is left",
    async (_who, cancel) => {
      const t = await longProject();
      const gate = holdTheRestart(t);
      const started = await t.exportNow("long");
      await flush();
      gate.arm();
      const jobsBefore = t.jobs.submitted.length;
      t.jobs.exit(started.job_id, -1, DRIVER_ERROR);
      await flush(60);

      // The row is working on it: still the same export, not a failure, and still listed for a quit to cancel.
      expect(listExportRecords()).toHaveLength(1);
      expect(listExportRecords()[0]).toMatchObject({
        job_id: started.job_id,
        state: "running",
        restarting: "The graphics chip stopped this export. Starting again on the processor…",
      });
      expect(listExports()).toEqual([
        { job_id: started.job_id, filename: "long.mp4", state: "running" },
      ]);
      expect((await outcomes())[0]).toMatchObject({ state: "running", restarting: true });
      expect((await outcomes())[0]).not.toHaveProperty("failure_code");

      expect(await cancel(started.job_id)).toBeTruthy();
      gate.release();
      expect(await whenExportEnds(started.job_id)).toMatchObject({ state: "cancelled" });
      await whenExportsSettle();
      expect(t.jobs.submitted, "the restart never started").toHaveLength(jobsBefore);
      expect(await t.fs.exists(DEST_LONG)).toBe(false);
      expect(isDestinationReserved(DEST_LONG)).toBe(false);
      expect(listExports()).toEqual([]);
      expect(
        [...t.fs.files.keys()].filter((key) => key.startsWith("C:/Users/test/Downloads/long")),
      ).toEqual([]);
      const [row] = await outcomes();
      expect(row).toMatchObject({ job_id: started.job_id, state: "cancelled" });
      expect(row).not.toHaveProperty("failure_code");
    },
  );

  it.each(["first", "second"] as const)(
    "after the new attempt exists, a Cancel by the id the %s attempt holds reaches it, and the export ends cancelled",
    async (holder) => {
      const { t, firstId, jobsBefore } = await chipFails("after some frames");
      await until(() => expect(t.jobs.submitted.length).toBe(jobsBefore + 1));
      const second = t.jobs.submitted.at(-1)!;
      expect(cancelExport(holder === "first" ? firstId : second.id, "person_card")).toBe(true);
      expect(await whenExportEnds(firstId)).toMatchObject({
        job_id: second.id,
        state: "cancelled",
      });
      await whenExportsSettle();
      expect(t.jobs.killed).toEqual([second.id]);
      expect(t.jobs.submitted).toHaveLength(jobsBefore + 1);
      expect(await t.fs.exists(DEST_LONG)).toBe(false);
      expect(isDestinationReserved(DEST_LONG)).toBe(false);
    },
  );

  it("does not put a newer project into an export it started again: an edit during the minutes of the first attempt refuses the restart", async () => {
    const t = await longProject();
    const started = await t.exportNow("long");
    await flush();
    const jobsBefore = t.jobs.submitted.length;
    // The person edits while the first attempt runs; the chip then fails it.
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 60, timeline_out: 120 }] },
      t.nextPage(),
    );
    t.jobs.exit(started.job_id, -1, DRIVER_ERROR);
    await flush(60);
    expect(t.jobs.submitted).toHaveLength(jobsBefore);
    expect(listExportRecords()[0]).toMatchObject({
      job_id: started.job_id,
      state: "failed",
      canRetry: true,
      chipFailed: true,
    });
    expect(restartDecisions().map((d) => d.record)).toEqual(["eligible", "edited"]);
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    expect(reported.map((r) => r.status)).toEqual(["failed"]);
    // The failure the person always saw is what stands, with the chip set aside, and Try again uses the processor.
    expect((await outcomes())[0]).toMatchObject({ state: "failed", chip_failed: true });
    expect(markChipSuspect).toHaveBeenCalledTimes(1);
  });
});

describe("with the safety net switched off, a chip failure ends as it did in 0.27.0: failed, a click away, nothing started", () => {
  it.each(["chip_restart", "auto_restart"] as const)("%s off", async (flag) => {
    __setExportFlag(flag, false);
    const t = await longProject();
    const started = await t.exportNow("long");
    await flush();
    const jobsBefore = t.jobs.submitted.length;
    t.jobs.exit(started.job_id, -1, DRIVER_ERROR);
    expect(await whenExportEnds(started.job_id)).toMatchObject({
      state: "failed",
      canRetry: true,
      chipFailed: true,
    });
    await flush(60);
    expect(t.jobs.submitted, "nothing started by itself").toHaveLength(jobsBefore);
    expect(listExportRecords().map((r) => r.job_id)).toEqual([started.job_id]);
    expect(listExportRecords()[0].attempt).toBeUndefined();
    expect(restartDecisions().map((d) => d.record)).toEqual(["flag_off"]);
    expect(markChipSuspect).toHaveBeenCalledTimes(1);
    const [row] = await outcomes();
    expect(row).toMatchObject({ job_id: started.job_id, state: "failed", chip_failed: true });
    expect(row).not.toHaveProperty("attempt");
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    expect(reported.map((r) => r.status)).toEqual(["failed"]);
    expect(story(reported[0])).toContain("chip_failed:chip");

    // The person's own click still runs it on the processor.
    await retryExport(started.job_id);
    await flush(60);
    expect(encoderOf(t.jobs.submitted.at(-1)!)).toBe("x264");
    t.jobs.exit(t.jobs.submitted.at(-1)!.id, 0);
    await whenExportsSettle();
    expect(await t.fs.exists(DEST_LONG)).toBe(true);
  });
});

describe("a failure the chip does not explain is not restarted", () => {
  it.each([
    ["a full disk", "native render failed: No space left on device\n", "storage_full"],
    [
      "a missing source",
      "native render failed: C:/media/a.mp4: No such file or directory\n",
      "source_unavailable",
    ],
    [
      "a folder that refuses the file",
      "native render failed: Permission denied\n",
      "storage_unavailable",
    ],
    [
      "a broken source file",
      "native render failed: ffmpeg: Invalid data found when processing input\n",
      "render_failed",
    ],
  ])("%s", async (_name, error, code) => {
    const t = await longProject();
    const started = await t.exportNow("long");
    await flush();
    const jobsBefore = t.jobs.submitted.length;
    t.jobs.exit(started.job_id, -1, error);
    await flush(60);
    expect(t.jobs.submitted).toHaveLength(jobsBefore);
    expect(listExportRecords()[0]).toMatchObject({
      job_id: started.job_id,
      state: "failed",
      canRetry: true,
    });
    expect(listExportRecords()[0].chipFailed).toBeUndefined();
    expect(restartDecisions()).toEqual([]);
    expect(markChipSuspect).not.toHaveBeenCalled();
    expect((await outcomes())[0]).toMatchObject({ state: "failed", failure_code: code });
  });

  it("is not restarted either when the failure belongs to an export that never ran on a chip: a failed check of a processor export is not a chip failure", async () => {
    const t = await longProject(null);
    const started = await t.exportNow("long");
    await flush();
    expect(encoderOf(t.jobs.submitted.at(-1)!)).toBe("x264");
    const jobsBefore = t.jobs.submitted.length;
    t.jobs.exit(started.job_id, -1, "native render failed: artifact verification failed\n");
    await flush(60);
    expect(t.jobs.submitted).toHaveLength(jobsBefore);
    expect(restartDecisions()).toEqual([]);
    expect(listExportRecords()[0]).toMatchObject({ state: "failed", canRetry: true });
  });
});

// A chip that hangs is stopped by the no-progress rule. An IDLE stop (the processors and the disk quiet: a driver that hangs uses no
// processor) is the chip's to answer for and is started again; a stop at the BUSY ceiling is not (the chip was working, and a restart would
// repeat most of that work on a slower encoder). Only the clock and the interval are faked: everything else runs as in the other journeys.
describe("an export stopped by the no-progress rule", () => {
  const FAKE = {
    toFake: ["setInterval", "clearInterval", "Date"] as (
      "setInterval" | "clearInterval" | "Date"
    )[],
  };

  /** The chip's export prints some progress and then goes quiet, while the app process reports `activity` every five seconds. */
  async function hangs(activity: "idle" | "busy", seconds: number) {
    const t = await longProject();
    vi.useFakeTimers({ now: 1_000_000, ...FAKE });
    const started = await t.exportNow("long");
    await flush();
    expect(encoderOf(t.jobs.submitted.at(-1)!)).toBe("amd");
    const jobsBefore = t.jobs.submitted.length;
    let cpuMs = 0;
    t.jobs.stdout(started.job_id, progressBlock(30, 1000));
    for (let elapsed = 0; elapsed <= seconds; elapsed += 5) {
      // The app ends the export itself when the rule says so: from then on there is no process left to print anything.
      if (t.jobs.view(started.job_id)?.state !== "running") break;
      t.jobs.stdout(started.job_id, formatActivityMark({ cpuMs, readBytes: 0 }));
      cpuMs += activity === "busy" ? 7_500 : 5;
      await vi.advanceTimersByTimeAsync(5_000);
    }
    vi.useRealTimers();
    await flush(60);
    return { t, started, jobsBefore };
  }

  it("is started again on the processor after an idle stop: a hung driver uses no processor", async () => {
    const { t, started, jobsBefore } = await hangs("idle", 200);
    await until(() => expect(t.jobs.submitted.length).toBe(jobsBefore + 1));
    expect(encoderOf(t.jobs.submitted.at(-1)!)).toBe("x264");
    expect(listExportRecords()[0]).toMatchObject({
      attempt: 2,
      restarted: "processor",
      restartReason: "chip_failed",
    });
    expect(restartDecisions().map((d) => d.record)).toEqual(["eligible"]);
    expect(markChipSuspect).toHaveBeenCalledTimes(1);
    t.jobs.exit(t.jobs.submitted.at(-1)!.id, 0);
    expect(await whenExportEnds(started.job_id)).toMatchObject({ state: "done" });
    await whenExportsSettle();
  });

  it("is not started again after a stop at the busy ceiling: the chip was working, so the plain failure and Try again stand", async () => {
    const { t, started, jobsBefore } = await hangs("busy", 910);
    await flush(60);
    expect(t.jobs.submitted).toHaveLength(jobsBefore);
    expect(listExportRecords()[0]).toMatchObject({
      job_id: started.job_id,
      state: "failed",
      canRetry: true,
      chipFailed: true,
    });
    expect(listExportRecords()[0].error).toMatch(/although the PC stayed busy \(stalled\)/);
    expect(restartDecisions().map((d) => d.record)).toEqual(["no_route"]);
    // As in 0.27.0: the chip is set aside and the person's own click runs it on the processor.
    expect(markChipSuspect).toHaveBeenCalledTimes(1);
    const [row] = await outcomes();
    expect(row).toMatchObject({ state: "failed", failure_code: "time_limit", chip_failed: true });
  });
});

// A request from an outside assistant is warned before a long or slow export, and a warning is a question, which refuses a restart nobody is there to answer. The first attempt is judged on the honest figure
// (a chip is priced quicker than the processor) and the restart on 0.27.0's, so a restart could be refused for a "long" its first attempt, told only that it would take a while, never heard. The time of a
// restart raises no heads-up of its own.
describe("a chip that fails an export an outside assistant started", () => {
  it("is started again on the processor, and finishes, though 0.27.0's time for the processor is a long one the first attempt was not told", async () => {
    pc.executionSeconds = 28_800;
    const told: string[] = [];
    __setExportConfirmationForTests(async (message) => {
      told.push(message);
      return "continue";
    });
    const t = await longProject(amdChip());
    // This PC measured the project at a little over twenty minutes on the processor; on the chip it is priced under that.
    useExportJob.setState({
      calibrations: useExportJob
        .getState()
        .calibrations.map((sample) => ({ ...sample, elapsedSeconds: 1250 })),
    });
    const started = await t.exportFromAssistant("long");
    await flush();
    expect(started.ok, JSON.stringify(started)).toBe(true);
    expect(encoderOf(t.jobs.submitted.at(-1)!), "the first attempt runs on the chip").toBe("amd");
    expect(told, "the first attempt was told it would take a while, and went on").toHaveLength(1);
    expect(told[0]).toMatch(/take a while/);
    expect(told[0]).not.toMatch(/long time/);
    const jobsBefore = t.jobs.submitted.length;
    t.jobs.stdout(started.job_id, progressBlock(30, 1000));
    await flush(5);
    t.jobs.exit(started.job_id, -1, DRIVER_ERROR);
    await until(() => expect(t.jobs.submitted.length).toBe(jobsBefore + 1));
    await flush(40);
    expect(t.jobs.submitted, "one successor, not two").toHaveLength(jobsBefore + 1);
    const second = t.jobs.submitted.at(-1)!;
    expect(encoderOf(second), "on the processor").toBe("x264");
    expect(told, "nobody was asked about the restart").toHaveLength(1);
    expect(restartDecisions().map((d) => d.record)).toEqual(["eligible"]);
    expect(listExportRecords()).toHaveLength(1);
    expect(listExportRecords()[0]).toMatchObject({
      job_id: second.id,
      state: "running",
      attempt: 2,
      restarted: "processor",
    });
    t.jobs.exit(second.id, 0);
    expect(await whenExportEnds(started.job_id)).toMatchObject({
      job_id: second.id,
      state: "done",
    });
    await whenExportsSettle();
    expect(await t.fs.exists(DEST_LONG)).toBe(true);
  });
});
