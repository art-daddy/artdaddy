// Who hears how an export ends when the app starts it again by itself (a graphics-chip failure restarts once on the processor, a stop for lack
// of memory restarts once on a gentler setting). The in-app assistant is woken, once, for an export the CHAT started; the Export menu and an
// outside assistant never wake it. The restart is part of the same export: the assistant knows it by its first attempt's id, is told how the
// LAST attempt ended, and is told nothing of the failure that was held back. These drive the real export tool and the real queue against
// FakeJobs, which plays the app process, with a real job sink standing for the chat.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __setExportFlag, type ExportFlagName } from "../api/exportFlags";
import { __setExportConfirmationForTests } from "../lib/confirm";
import type { MutationOrigin } from "../project/MutationGate";
import { useAuth } from "../store/auth";
import { useExportJob } from "../store/exportJob";
import {
  __resetJobNotes,
  pendingJobNotes,
  registerJobSink,
  SETTLE_WINDOW_MS,
  type SettledJob,
} from "../store/jobNotes";
import {
  DEST,
  DEST_LONG,
  DIR,
  DRIVER_ERROR,
  GIB,
  MEMORY_SHORT,
  amdChip,
  encoderOf,
  failTheCheckOf,
  flush,
  holdTheRestart,
  longProject as measuredProject,
  progressBlock,
  setupExport,
  type Any,
  type ExportRig,
} from "../test/chipExportKit";
import { resetTestDocuments } from "../test/timelineKit";
import { agentToolContext } from "../tools/agentStore";
import { __resetProjectJobs } from "../tools/genJobs";
import { __resetJobSupervisor } from "../tools/jobSupervisor";
import { findChip, markChipSuspect } from "./chipTest";
import { attempts } from "./exportAttempts";
import {
  __resetExportQueue,
  adoptExports,
  cancelExport,
  clearFinishedExports,
  dismissExport,
  listExportRecords,
  listExports,
  restartDecisions,
  retryExport,
  whenExportEnds,
  whenExportTelemetrySettles,
  whenExportsSettle,
} from "./exportQueue";
import { addClipsTool } from "./placement";
import { exportTimelineTool } from "./render";

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
// What the PC says about itself, as the decision to start again reads it.
const pc = vi.hoisted(() => ({ available: null as number | null }));
vi.mock("../platform/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform/host")>()),
  resolveExportResources: vi.fn(async () => ({
    total_memory_bytes: null,
    available_memory_bytes: pc.available,
    scratch_free_bytes: null,
    destination_free_bytes: null,
    budgets: { memoryBytes: null, temporaryBytes: null, executionSeconds: null },
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

// The long project measures like the chip's own journeys do; the rig starts with no chat attached and nothing reported.
const longProject = async (...args: Parameters<typeof measuredProject>): Promise<ExportRig> => {
  const t = await measuredProject(...args);
  reported.length = 0;
  vi.mocked(markChipSuspect).mockClear();
  __resetJobNotes();
  return t;
};

beforeEach(() => {
  reported.length = 0;
  useAuth.setState({ profile: null });
  pc.available = 8 * GIB;
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
  __resetJobNotes();
  useExportJob.setState({ calibrations: [] });
  useExportJob.getState().setEngine("file-sequence-v1");
  for (const flag of [...RESTART_FLAGS, "faster_x264" as const]) __setExportFlag(flag, true);
});

const until = (check: () => void) => vi.waitFor(check, { timeout: 5_000, interval: 20 });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// -----------------------------------------------------------------------------------------------------------------------------------------
// Who starts the export: the three doors that run the one export tool
// -----------------------------------------------------------------------------------------------------------------------------------------

type Starter = "chat" | "menu" | "mcp";
const STARTERS: readonly Starter[] = ["chat", "menu", "mcp"];
/** What the native job and the report call the door. Only the in-app chat's own exports are "chat". */
const LABEL: Record<Starter, "chat" | "elsewhere"> = {
  chat: "chat",
  menu: "elsewhere",
  mcp: "elsewhere",
};

const ORIGIN: MutationOrigin = { chatSessionId: "c", branchId: 0, executionId: 1 };
/** The same request from the in-app chat: the turn that asked is known (its origin), as the tool host gives it. */
const exportFromChat = async (t: ExportRig, name?: string): Promise<Any> =>
  exportTimelineTool(
    name ? { name } : {},
    agentToolContext(
      { store: t.store, runner: t.nextPage().runner, surface: "app" },
      new AbortController().signal,
      ORIGIN,
    ),
  );
const start = (t: ExportRig, who: Starter, name?: string): Promise<Any> =>
  who === "chat"
    ? exportFromChat(t, name)
    : who === "mcp"
      ? t.exportFromAssistant(name)
      : t.exportNow(name);

/** The chat of this project, idle, so that a wake is delivered as soon as its settling window closes. */
function chat() {
  const wakes: SettledJob[][] = [];
  registerJobSink(DIR, { isIdle: () => true, deliver: (jobs) => void wakes.push([...jobs]) });
  return {
    wakes,
    /** Waits out the settling window after the last export ended, and answers every wake the chat has had. */
    heard: async (): Promise<SettledJob[][]> => {
      await whenExportsSettle();
      await whenExportTelemetrySettles();
      await sleep(SETTLE_WINDOW_MS + 250);
      return wakes;
    },
  };
}
/** What waits in the chat's queue once everything has settled. Work another door started never gets there, so this is also the proof that the
 *  chat can not hear of it, without waiting out the settling window. */
async function queuedForChat(): Promise<SettledJob[]> {
  await whenExportsSettle();
  await whenExportTelemetrySettles();
  return pendingJobNotes(DIR).map((job) => ({ ...job }));
}

// -----------------------------------------------------------------------------------------------------------------------------------------
// The failures the app starts again by itself
// -----------------------------------------------------------------------------------------------------------------------------------------

const FFMPEG_FAILED = "native render failed: ffmpeg exited with code 1\n";
interface Kind {
  name: string;
  /** What the assistant is told about the restart. */
  phrase: string;
  /** A word of the first attempt's own error, which must not be the wake's after the restart failed. */
  firstErrorHas: string;
  /** Where the first attempt stops. */
  fault: "after some frames" | "at the check of the finished file" | "short of memory";
}
const KINDS: readonly Kind[] = [
  {
    name: "the graphics chip stops it after some frames",
    phrase: "on the processor",
    firstErrorHas: "h264_amf",
    fault: "after some frames",
  },
  {
    name: "the graphics chip fails the check of the finished file",
    phrase: "on the processor",
    firstErrorHas: "failed verification",
    fault: "at the check of the finished file",
  },
  {
    name: "the PC runs short of memory",
    phrase: "on a gentler setting",
    firstErrorHas: "memory floor",
    fault: "short of memory",
  },
];

interface Started {
  t: ExportRig;
  /** The id the assistant holds: the first attempt's. */
  firstId: string;
  filename: string;
  dest: string;
  jobsBefore: number;
}

/** An export started by `who` and failed the way `kind` says, before the restart has begun. */
async function failsFirst(kind: Kind, who: Starter): Promise<Started> {
  if (kind.fault === "short of memory") {
    const t = await setupExport();
    const started = await start(t, who);
    await flush();
    expect(started.ok, JSON.stringify(started)).toBe(true);
    const jobsBefore = t.jobs.submitted.length;
    t.jobs.exit(started.job_id, -1, MEMORY_SHORT);
    return { t, firstId: started.job_id, filename: "proj.mp4", dest: DEST, jobsBefore };
  }
  const t = await longProject(amdChip());
  const started = await start(t, who, "long");
  await flush();
  expect(started.ok, JSON.stringify(started)).toBe(true);
  expect(encoderOf(t.jobs.submitted.at(-1)!), "the first attempt runs on the chip").toBe("amd");
  const jobsBefore = t.jobs.submitted.length;
  if (kind.fault === "after some frames") {
    t.jobs.stdout(started.job_id, progressBlock(30, 1000));
    await flush(5);
    t.jobs.exit(started.job_id, -1, DRIVER_ERROR);
  } else {
    failTheCheckOf(t, started.job_id);
    t.jobs.exit(started.job_id, 0);
  }
  return { t, firstId: started.job_id, filename: "long.mp4", dest: DEST_LONG, jobsBefore };
}

/** Waits for the app's second attempt to be handed to the app process, and answers it. */
async function secondOf(run: Started) {
  await until(() => expect(run.t.jobs.submitted.length).toBe(run.jobsBefore + 1));
  await flush(20);
  expect(run.t.jobs.submitted.length, "one successor, not two").toBe(run.jobsBefore + 1);
  const second = run.t.jobs.submitted.at(-1)!;
  expect(second.id).not.toBe(run.firstId);
  expect(attempts.chainOf(run.firstId), "the same export").toEqual([run.firstId, second.id]);
  return second;
}

// -----------------------------------------------------------------------------------------------------------------------------------------
// The tests
// -----------------------------------------------------------------------------------------------------------------------------------------

describe("an export the app starts again by itself, and who hears how it ended", () => {
  describe.each(KINDS)("when $name", (kind) => {
    it("wakes the chat that started it ONCE when the restart finishes: for the first attempt's id, done, with the restart said", async () => {
      const run = await failsFirst(kind, "chat");
      const { t, firstId } = run;
      const heard = chat();
      const second = await secondOf(run);
      t.jobs.exit(second.id, 0);
      expect(await whenExportEnds(firstId)).toMatchObject({ job_id: second.id, state: "done" });

      const wakes = await heard.heard();
      // The failure of the first attempt was held back for the restart, so the chat hears of this export exactly once.
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toHaveLength(1);
      expect(wakes[0][0]).toMatchObject({
        id: firstId,
        tool: "export",
        label: `the export ${run.filename}`,
        status: "done",
        startedBy: "chat",
        detail: expect.stringContaining(`restarted once ${kind.phrase}`),
      });
      expect(wakes[0][0].error).toBeUndefined();
      // The export itself is what the wake says: the file is there, once.
      expect(await t.fs.exists(run.dest)).toBe(true);
      // Each attempt reported who started it, and it was the chat both times.
      expect(reported.map((r) => r.started_by)).toEqual(["chat", "chat"]);
    });

    it("tells the chat the SECOND attempt's error, once, when the restart fails too", async () => {
      const run = await failsFirst(kind, "chat");
      const { t, firstId } = run;
      const heard = chat();
      const second = await secondOf(run);
      t.jobs.exit(second.id, -1, FFMPEG_FAILED);
      expect(await whenExportEnds(firstId)).toMatchObject({ job_id: second.id, state: "failed" });
      expect(t.jobs.submitted, "no third attempt by itself").toHaveLength(run.jobsBefore + 1);

      const wakes = await heard.heard();
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toHaveLength(1);
      expect(wakes[0][0]).toMatchObject({
        id: firstId,
        tool: "export",
        status: "failed",
        startedBy: "chat",
      });
      expect(wakes[0][0].error).toContain("ffmpeg exited with code 1");
      expect(wakes[0][0].error, "not the first attempt's error").not.toContain(kind.firstErrorHas);
      expect(wakes[0][0].detail).toBeUndefined();
      // What the card shows is the same failure.
      expect(listExportRecords().map((r) => r.state)).toEqual(["failed"]);
      expect(reported.map((r) => r.started_by)).toEqual(["chat", "chat"]);
    });

    it.each(["menu", "mcp"] as const)(
      "wakes nobody for the same export started from the %s: it finishes, and the chat is not told",
      async (who) => {
        const run = await failsFirst(kind, who);
        const { t, firstId } = run;
        const heard = chat();
        const second = await secondOf(run);
        t.jobs.exit(second.id, 0);
        expect(await whenExportEnds(firstId)).toMatchObject({ job_id: second.id, state: "done" });
        expect(await queuedForChat(), "nothing is queued for the chat").toEqual([]);

        expect(await heard.heard(), "and the chat is handed nothing").toEqual([]);
        expect(await t.fs.exists(run.dest), "the export itself finished").toBe(true);
        expect(reported.map((r) => r.started_by)).toEqual(["elsewhere", "elsewhere"]);
      },
    );

    it.each(["menu", "mcp"] as const)(
      "wakes nobody when the restart of an export started from the %s fails too",
      async (who) => {
        const run = await failsFirst(kind, who);
        const { t, firstId } = run;
        const second = await secondOf(run);
        t.jobs.exit(second.id, -1, FFMPEG_FAILED);
        expect(await whenExportEnds(firstId)).toMatchObject({ state: "failed" });
        expect(await queuedForChat()).toEqual([]);
        expect(reported.map((r) => r.started_by)).toEqual(["elsewhere", "elsewhere"]);
      },
    );
  });

  describe("the native job each attempt is filed as, which a page that reloads reads back", () => {
    it.each(STARTERS)(
      "files the first and the second attempt of an export started from the %s under the same starter",
      async (who) => {
        const run = await failsFirst(KINDS[0], who);
        const second = await secondOf(run);
        const first = run.t.jobs.submitted[run.jobsBefore - 1];
        expect(first.id).toBe(run.firstId);
        expect(first.meta.startedBy).toBe(LABEL[who]);
        expect(second.meta.startedBy).toBe(LABEL[who]);
        run.t.jobs.exit(second.id, 0);
        await whenExportsSettle();
      },
    );

    it.each(STARTERS)(
      "wakes (or not) the chat that reloads while the second attempt runs, by who started the export: %s",
      async (who) => {
        const run = await failsFirst(KINDS[0], who);
        const { t } = run;
        const heard = chat();
        const second = await secondOf(run);
        // The page goes: its queue, its caches and its listeners are gone; the app process, its jobs and the disk are not.
        t.jobs.pageDied();
        __resetExportQueue();
        __resetProjectJobs();
        t.jobs.exit(second.id, 0);
        expect(await adoptExports({ contextFor: t.nextPage })).toBe(1);

        const wakes = await heard.heard();
        expect(await t.fs.exists(run.dest), "the next page delivered it").toBe(true);
        if (who === "chat") {
          expect(wakes).toHaveLength(1);
          expect(wakes[0]).toHaveLength(1);
          expect(wakes[0][0]).toMatchObject({ status: "done", startedBy: "chat" });
        } else {
          expect(wakes).toEqual([]);
        }
      },
    );
  });

  /** The person edits the project while the first attempt runs (the chip then stops it): the restart does not put a newer project into the export. */
  async function editedThenFails(who: Starter) {
    const t = await longProject(amdChip());
    const heard = chat();
    const started = await start(t, who, "long");
    await flush();
    const jobsBefore = t.jobs.submitted.length;
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 60, timeline_out: 120 }] },
      t.nextPage(),
    );
    t.jobs.exit(started.job_id, -1, DRIVER_ERROR);
    await flush(60);
    expect(t.jobs.submitted, "nothing was started again").toHaveLength(jobsBefore);
    expect(restartDecisions().map((d) => d.record)).toEqual(["eligible", "edited"]);
    return { t, heard, firstId: started.job_id as string };
  }

  /** The PC has learned since that the gentler setting would not fit what it has free either: the check before the start would ask the
   *  person a question, and nobody is there to answer it, so the restart is refused. */
  async function questionThenFails(who: Starter) {
    const t = await setupExport();
    const heard = chat();
    const started = await start(t, who);
    await flush();
    const jobsBefore = t.jobs.submitted.length;
    const descriptor = (t.jobs.submitted[0].meta.telemetry as Any).calibration;
    useExportJob.getState().rememberCalibration({
      ...descriptor,
      elapsedSeconds: 60,
      finalBytes: 10_000_000,
      memoryBytes: 6 * GIB,
      temporaryBytes: 1_000_000,
    });
    pc.available = 3 * GIB;
    t.jobs.exit(started.job_id, -1, MEMORY_SHORT);
    await flush(60);
    expect(t.jobs.submitted, "nothing was started again").toHaveLength(jobsBefore);
    expect(restartDecisions().map((d) => d.record)).toEqual(["eligible", "refused_at_door"]);
    return { t, heard, firstId: started.job_id as string };
  }

  describe.each([
    {
      why: "the project was edited since the first attempt began",
      refused: editedThenFails,
      firstErrorHas: "h264_amf",
    },
    {
      why: "the check before the start would ask the person a question",
      refused: questionThenFails,
      firstErrorHas: "memory floor",
    },
  ])("when the restart is refused at the door because $why", ({ refused, firstErrorHas }) => {
    it("tells the chat the FIRST attempt's failure, once (as it always has)", async () => {
      const { heard, firstId } = await refused("chat");
      const wakes = await heard.heard();
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toHaveLength(1);
      expect(wakes[0][0]).toMatchObject({
        id: firstId,
        tool: "export",
        status: "failed",
        startedBy: "chat",
      });
      expect(wakes[0][0].error).toContain(firstErrorHas);
      expect(wakes[0][0].detail).toBeUndefined();
      expect(listExportRecords()[0]).toMatchObject({ job_id: firstId, state: "failed" });
    });

    it.each(["menu", "mcp"] as const)(
      "tells nobody when it was started from the %s",
      async (who) => {
        await refused(who);
        expect(await queuedForChat()).toEqual([]);
      },
    );
  });

  describe("a row dismissed or cleared while its export is in the app's hands", () => {
    it("is refused in the gap before the restart and while the second attempt runs: one wake at the end, for the first attempt's id", async () => {
      const t = await longProject(amdChip());
      const heard = chat();
      const gate = holdTheRestart(t);
      const started = await exportFromChat(t, "long");
      await flush();
      gate.arm();
      const jobsBefore = t.jobs.submitted.length;
      t.jobs.exit(started.job_id, -1, DRIVER_ERROR);
      await flush(60);
      expect(listExportRecords()[0]).toMatchObject({
        state: "running",
        restarting: expect.any(String),
      });
      expect(dismissExport(started.job_id), "a row in the gap cannot be dismissed").toBe(false);
      clearFinishedExports();
      expect(listExportRecords()).toHaveLength(1);

      gate.release();
      await until(() => expect(t.jobs.submitted.length).toBe(jobsBefore + 1));
      await flush(20);
      const second = t.jobs.submitted.at(-1)!;
      expect(dismissExport(second.id), "nor can the second attempt's while it runs").toBe(false);
      clearFinishedExports();
      expect(attempts.chainOf(started.job_id)).toEqual([started.job_id, second.id]);
      t.jobs.exit(second.id, 0);

      const wakes = await heard.heard();
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toHaveLength(1);
      expect(wakes[0][0]).toMatchObject({ id: started.job_id, status: "done", startedBy: "chat" });
    });

    it("changes nothing of the wake when the finished second attempt's row is dismissed while its settle is still in flight: one wake, the first attempt's id, and that it was started again", async () => {
      const run = await failsFirst(KINDS[0], "chat");
      const { t, firstId } = run;
      const heard = chat();
      const second = await secondOf(run);
      // The app process is slow to answer at the very end of the second attempt: its row is already finished, and the person dismisses it.
      const delivery = t.jobs.delivery!;
      const complete = delivery.complete.bind(delivery);
      let reached!: () => void;
      const atComplete = new Promise<void>((resolve) => (reached = resolve));
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      delivery.complete = async (id: string) => {
        if (id === second.id) {
          reached();
          await gate;
        }
        return complete(id);
      };
      t.jobs.exit(second.id, 0);
      await atComplete;
      expect(dismissExport(second.id), "the finished row can be dismissed").toBe(true);
      expect(attempts.chainOf(second.id), "and the chain goes with it").toEqual([second.id]);
      open();

      const wakes = await heard.heard();
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toHaveLength(1);
      expect(wakes[0][0]).toMatchObject({
        id: firstId,
        status: "done",
        startedBy: "chat",
        detail: expect.stringContaining("restarted once on the processor"),
      });
      expect(reported.map((r) => r.started_by)).toEqual(["chat", "chat"]);
    });
  });

  describe("a Cancel", () => {
    it.each([
      ["from the card", (id: string) => cancelExport(id, "person_card")],
      ["by the quit", (id: string) => cancelExport(id)],
    ] as const)("in the gap before the restart starts wakes nobody, %s", async (_who, cancel) => {
      const t = await longProject(amdChip());
      const heard = chat();
      const gate = holdTheRestart(t);
      const started = await exportFromChat(t, "long");
      await flush();
      gate.arm();
      const jobsBefore = t.jobs.submitted.length;
      t.jobs.exit(started.job_id, -1, DRIVER_ERROR);
      await flush(60);
      expect(listExportRecords()[0]).toMatchObject({
        state: "running",
        restarting: expect.any(String),
      });

      expect(cancel(started.job_id)).toBe(true);
      gate.release();
      expect(await whenExportEnds(started.job_id)).toMatchObject({ state: "cancelled" });
      expect(t.jobs.submitted, "the restart never started").toHaveLength(jobsBefore);
      expect(await queuedForChat()).toEqual([]);
      expect(await heard.heard()).toEqual([]);
    });

    it.each(["first", "second"] as const)(
      "of the restarted export, by the id the %s attempt holds, wakes nobody",
      async (holder) => {
        const run = await failsFirst(KINDS[0], "chat");
        const { t, firstId } = run;
        const heard = chat();
        const second = await secondOf(run);
        expect(cancelExport(holder === "first" ? firstId : second.id, "person_card")).toBe(true);
        expect(await whenExportEnds(firstId)).toMatchObject({
          job_id: second.id,
          state: "cancelled",
        });
        expect(t.jobs.killed).toEqual([second.id]);
        expect(await queuedForChat()).toEqual([]);
        expect(await heard.heard()).toEqual([]);
      },
    );
  });

  describe("a person's own Try again of a failed export", () => {
    it("starts a new export that does not wake the chat, as before: the chat heard of the failure, and hears nothing of what the person did next", async () => {
      const t = await longProject(null);
      const heard = chat();
      const started = await exportFromChat(t, "long");
      await flush();
      const jobsBefore = t.jobs.submitted.length;
      // A failure no restart is made for: the plain failure stands, a click away.
      t.jobs.exit(
        started.job_id,
        -1,
        "native render failed: ffmpeg: Invalid data found when processing input\n",
      );
      expect(await whenExportEnds(started.job_id)).toMatchObject({
        state: "failed",
        canRetry: true,
      });
      expect(restartDecisions()).toEqual([]);
      const firstWakes = [...(await heard.heard())];
      expect(firstWakes).toHaveLength(1);
      expect(firstWakes[0][0]).toMatchObject({
        id: started.job_id,
        status: "failed",
        startedBy: "chat",
      });

      await retryExport(started.job_id);
      await flush(60);
      expect(t.jobs.submitted).toHaveLength(jobsBefore + 1);
      const again = t.jobs.submitted.at(-1)!;
      expect(again.meta.startedBy, "the person started it: a new export of its own").toBe(
        "elsewhere",
      );
      expect(attempts.chainOf(again.id)).toEqual([again.id]);
      t.jobs.exit(again.id, 0);
      await whenExportsSettle();
      expect(await t.fs.exists(DEST_LONG)).toBe(true);
      expect(await queuedForChat(), "the chat is not told of it").toEqual([]);
      expect(await heard.heard(), "and has had no wake but the first").toHaveLength(1);
    });

    it("of an export the app started again that failed twice is a new export of its own, not a third attempt of the chat's: no wake", async () => {
      const run = await failsFirst(KINDS[0], "chat");
      const { t, firstId } = run;
      const heard = chat();
      const second = await secondOf(run);
      t.jobs.exit(
        second.id,
        -1,
        "native render failed: ffmpeg: Invalid data found when processing input\n",
      );
      expect(await whenExportEnds(firstId)).toMatchObject({ state: "failed", canRetry: true });
      // The one wake of the chain, for the failure of its last attempt.
      expect(await heard.heard()).toHaveLength(1);

      await retryExport(firstId);
      await flush(60);
      const again = t.jobs.submitted.at(-1)!;
      expect(again.id).not.toBe(second.id);
      expect(again.meta.startedBy, "the person started it: it does not take the chain's").toBe(
        "elsewhere",
      );
      expect(attempts.chainOf(again.id), "and it is not a third attempt").toEqual([again.id]);
      t.jobs.exit(again.id, 0);
      await whenExportsSettle();
      expect(await queuedForChat()).toEqual([]);
      expect(await heard.heard(), "no wake for what the person did next").toHaveLength(1);
      expect(reported.map((r) => r.started_by)).toEqual(["chat", "chat", "elsewhere"]);
    });
  });
});
