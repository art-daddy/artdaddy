// 3b, stage 1: when the PC itself ran short of memory early in an export, the app starts the export again by itself, once,
// one rung gentler (exportRestart.ts decides; exportQueue.ts runs it; exportAttempts.ts keeps it one export for the person
// and the assistant). These drive the real export tool and the real queue against FakeJobs, which plays the app process.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createHash } from "node:crypto";
import { createElement } from "react";
import { __setExportFlag } from "../api/exportFlags";
import ExportCard from "../components/ExportCard";
import { useAuth } from "../store/auth";
import { useEditor } from "../store/editor";
import { liveFeedOf, useExportJob } from "../store/exportJob";
import { FakeJobs } from "../test/fakeJobs";
import { MemFs, registerTestDocument, resetTestDocuments } from "../test/timelineKit";
import { agentToolContext } from "../tools/agentStore";
import type { CommandResult, CommandRunner } from "../tools/command";
import type { ClientToolContext } from "../tools/context";
import { __resetProjectJobs } from "../tools/genJobs";
import { __resetJobSupervisor, __setJobSupervisor } from "../tools/jobSupervisor";
import { joinPath, ProjectStoreAccess } from "../tools/store";
import { ensureTimeline } from "./engine";
import { attempts, ID_ENTRY_POINTS } from "./exportAttempts";
import {
  __resetExportQueue,
  cancelExport,
  dismissExport,
  isDestinationReserved,
  listExportRecords,
  listExports,
  localDeliveryPort,
  manageExportsTool,
  restartDecisions,
  retryExport,
  waitForExports,
  whenExportEnds,
  whenExportTelemetrySettles,
  whenExportsSettle,
} from "./exportQueue";
import { addClipsTool } from "./placement";
import { exportTimelineTool } from "./render";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const reported = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("../api/exportEvents", () => ({
  reportExport: async (event: Record<string, unknown>) => {
    reported.push(event);
  },
}));
vi.mock("./chipTest", async (importOriginal) => {
  const real = await importOriginal<typeof import("./chipTest")>();
  return {
    ...real,
    findChip: vi.fn(async () => ({ chip: null, events: [] })),
    markChipSuspect: vi.fn(),
  };
});

// What the PC says about itself, as the pre-start check and the decision to start again read it.
const GIB = 1024 ** 3;
const pc = vi.hoisted(() => ({
  available: null as number | null,
  destinationFree: null as number | null,
  // Holds ONE call to the PC's resources: the n-th since `calls` was last reset (0: none). The decision to start again
  // reads them once and the new export's pre-start check reads them again, so holding the second one holds the restart
  // before it asks for its destination.
  calls: 0,
  holdCall: 0,
  hold: null as Promise<void> | null,
}));
// The client send of the restart facts is a constant that is false until the owner approves the privacy text (rule
// E3b-18); the tests that pin what the report will say once it is true switch it here.
const held = vi.hoisted(() => ({ send: false }));
vi.mock("./exportRestart", async (importOriginal) => {
  const real = await importOriginal<typeof import("./exportRestart")>();
  return {
    ...real,
    get SEND_RESTART_FACTS() {
      return held.send;
    },
  };
});
vi.mock("../platform/host", async (importOriginal) => {
  const real = await importOriginal<typeof import("../platform/host")>();
  return {
    ...real,
    resolveExportResources: vi.fn(async () => {
      pc.calls++;
      if (pc.holdCall > 0 && pc.calls === pc.holdCall && pc.hold) await pc.hold;
      return {
        total_memory_bytes: null,
        available_memory_bytes: pc.available,
        scratch_free_bytes: null,
        destination_free_bytes: pc.destinationFree,
        budgets: { memoryBytes: null, temporaryBytes: null, executionSeconds: null },
        adapters: [],
      };
    }),
  };
});

beforeEach(() => {
  reported.length = 0;
  useAuth.setState({ profile: null });
  pc.available = 8 * GIB;
  pc.destinationFree = null;
  pc.calls = 0;
  pc.holdCall = 0;
  pc.hold = null;
  held.send = false;
});

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

const DIR = "C:/proj";
const DEST = "C:/Users/test/Downloads/proj.mp4";
const settleTick = () => new Promise((r) => setTimeout(r, 0));
async function flush(n = 20) {
  for (let i = 0; i < n; i++) await settleTick();
}

async function setup() {
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
  const exportNow = async (name?: string) =>
    (await exportTimelineTool(
      name ? { name } : {},
      agentToolContext(base, new AbortController().signal),
    )) as Any;
  const nextPage = () => ({ store: new ProjectStoreAccess(DIR, fs), runner });
  return { fs, store, jobs, exportNow, nextPage };
}

afterEach(async () => {
  cleanup();
  await resetTestDocuments();
  // A test that failed half way leaves exports running: they are cancelled, and the wait is bounded, so one failure does
  // not stall every test after it.
  for (const open of listExports()) cancelExport(open.job_id, "app");
  await Promise.race([whenExportsSettle(), new Promise((resolve) => setTimeout(resolve, 4_000))]);
  __resetExportQueue();
  __resetProjectJobs();
  __resetJobSupervisor();
  // What the PC has learned from the exports of one test must not decide the next one's pre-start check.
  useExportJob.setState({ calibrations: [] });
  useEditor.setState({ projectId: null, store: null });
  for (const flag of ["auto_restart", "memory_restart", "plan_rung", "restart_streamed"] as const)
    __setExportFlag(flag, true);
});

/** What the app process prints when the PC ran short of memory with the export at `peak` bytes. */
const resident = (peak: number): string =>
  `native render resident: ${JSON.stringify({ limit: 3.5 * GIB, sampled_peak: peak, workers_at_peak: [] })}\n`;
const FLOOR =
  "native render failed: render memory floor crossed: the PC has 410 MiB left and keeps 768 MiB for itself\n";
const SHORT = resident(1.2 * GIB) + FLOOR;

const rungOf = (spec: { meta: Record<string, unknown> }): number =>
  ((spec.meta.telemetry as Any).plan?.rung ?? 0) as number;
const story = (report: Any): string[] =>
  (report.trace as Any[]).map((e) => (e.v ? `${e.e}:${e.v}` : e.e));
const outcomes = async (jobId?: string): Promise<Any[]> =>
  ((await manageExportsTool({ action: "list", ...(jobId ? { job_id: jobId } : {}) })) as Any)
    .exports as Any[];

/** Holds the new export's start at the moment its delivery intent is prepared, which comes only after the app has decided to
 *  start the export again and put it through the pre-start check: the gap in which the first attempt's row says it is
 *  starting again. `arm()` just before the first attempt fails; `release()` lets the start go on. */
function holdTheRestart(t: { jobs: FakeJobs }) {
  let armed = false;
  let held = false;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const delivery = t.jobs.delivery!;
  const prepare = delivery.prepare.bind(delivery);
  delivery.prepare = async (...args) => {
    if (armed && !held) {
      held = true;
      await gate;
    }
    return prepare(...args);
  };
  return { arm: () => (armed = true), release: () => open() };
}

/** An export that failed for lack of memory and was started again by the app, now running as its second attempt. */
async function restarted() {
  const t = await setup();
  const first = await t.exportNow();
  await flush();
  t.jobs.exit(first.job_id, -1, SHORT);
  await flush(40);
  expect(t.jobs.submitted).toHaveLength(2);
  return { t, first: first.job_id as string, second: t.jobs.submitted[1].id };
}

describe("the app starts an export again by itself when the PC ran short of memory", () => {
  it("replays the journey: the PC ran short early, the same export starts one rung gentler, and it is one export to everyone", async () => {
    const t = await setup();
    const first = await t.exportNow();
    await flush();
    t.jobs.exit(first.job_id, -1, SHORT);
    await flush(40);

    // The failed attempt is gone from the card and the queue, and a new one runs a rung gentler.
    expect(t.jobs.submitted).toHaveLength(2);
    const [before, after] = t.jobs.submitted;
    expect(after.id).not.toBe(before.id);
    expect([rungOf(before), rungOf(after)]).toEqual([0, 1]);
    expect(listExportRecords().map((r) => r.job_id)).toEqual([after.id]);
    expect(listExportRecords()[0]).toMatchObject({
      state: "running",
      rung: 1,
      attempt: 2,
      restarted: "gentler_setting",
      restartReason: "memory_short",
    });
    expect(listExportRecords()[0].restarting).toBeUndefined();
    expect(restartDecisions().map((d) => d.record)).toEqual(["eligible"]);

    // The assistant holds the first id and sees one export, running, on its second attempt: not a failure and not two.
    const rows = await outcomes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      job_id: first.job_id,
      state: "running",
      attempt: 2,
      restarted: "gentler_setting",
    });
    expect(rows[0].note).toMatch(/same job_id/);
    expect(rows[0]).not.toHaveProperty("failure_code");
    expect(await outcomes(after.id)).toHaveLength(1);
    expect(listExports().map((e) => e.job_id)).toEqual([after.id]);

    t.jobs.exit(after.id, 0);
    // Waiting on the id the assistant holds ends with the second attempt.
    expect(await whenExportEnds(first.job_id)).toMatchObject({ job_id: after.id, state: "done" });
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    expect(await t.fs.exists(DEST)).toBe(true);
    expect(isDestinationReserved(DEST)).toBe(false);
    const done = await outcomes();
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ job_id: first.job_id, state: "done", attempt: 2 });

    // Each attempt told the truth about itself; neither carries the restart (the client send is held).
    expect(reported.map((r) => r.status)).toEqual(["failed", "done"]);
    expect(reported[0]).toMatchObject({ limit: "pc_floor" });
    expect(story(reported[0])).toContain("guard_tripped:pc_floor");
    for (const report of reported) {
      expect(story(report)).not.toContain("retry:app");
      expect(story(report)).not.toContain("retry:try_again");
    }
    // Nothing left behind: the one file, no staging leftovers.
    const names = [...t.fs.files.keys()].filter((key) =>
      key.startsWith("C:/Users/test/Downloads/"),
    );
    expect(names).toEqual([DEST]);
  });

  it("does not start again when the person had already asked it to stop", async () => {
    const t = await setup();
    const first = await t.exportNow();
    await flush();
    expect(cancelExport(first.job_id, "person_card")).toBe(true);
    await flush(40);
    expect(await whenExportEnds(first.job_id)).toMatchObject({ state: "cancelled" });
    expect(t.jobs.submitted).toHaveLength(1);
    expect(restartDecisions()).toEqual([]);
  });

  it("goes only once: a second failure of the new attempt is final, and the person's Try again is one click from there", async () => {
    const { t, first, second } = await restarted();
    t.jobs.exit(second, -1, SHORT);
    await flush(40);
    expect(t.jobs.submitted).toHaveLength(2); // no third attempt by itself
    expect(restartDecisions().map((d) => d.record)).toEqual(["eligible", "second"]);
    const [row] = listExportRecords();
    expect(row).toMatchObject({ job_id: second, state: "failed", attempt: 2, canRetry: true });
    const listed = await outcomes();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      job_id: first,
      state: "failed",
      failure_code: "memory_limit",
      attempt: 2,
    });

    // Try again, from the id the assistant holds or the one the card holds: a new export one rung gentler again.
    await retryExport(first);
    await flush(40);
    expect(t.jobs.submitted).toHaveLength(3);
    expect(rungOf(t.jobs.submitted[2])).toBe(2);
    expect(listExportRecords().map((r) => r.job_id)).toEqual([t.jobs.submitted[2].id]);
    expect(listExportRecords()[0].attempt).toBeUndefined(); // a new request, a new export
    t.jobs.exit(t.jobs.submitted[2].id, 0);
    await whenExportsSettle();
  });

  describe("a Cancel", () => {
    it.each([
      ["from the card", (id: string) => cancelExport(id, "person_card")],
      [
        "from the assistant",
        async (id: string) =>
          ((await manageExportsTool({ action: "cancel", job_id: id })) as Any).cancelled,
      ],
    ] as const)("in the gap before it starts stops it for good, %s", async (_who, cancel) => {
      const t = await setup();
      const gate = holdTheRestart(t);
      const first = await t.exportNow();
      await flush();
      gate.arm();
      t.jobs.exit(first.job_id, -1, SHORT);
      await flush(40);

      // The row is working on it: still the same export, not a failure, and still listed for a quit to cancel.
      expect(listExportRecords()).toHaveLength(1);
      expect(listExportRecords()[0]).toMatchObject({
        job_id: first.job_id,
        state: "running",
        restarting: "Starting again on a gentler setting…",
      });
      expect(listExports()).toEqual([
        { job_id: first.job_id, filename: "proj.mp4", state: "running" },
      ]);
      expect((await outcomes())[0]).toMatchObject({ state: "running", restarting: true });
      expect((await outcomes())[0]).not.toHaveProperty("failure_code");

      expect(await cancel(first.job_id)).toBeTruthy();
      gate.release();
      expect(await whenExportEnds(first.job_id)).toMatchObject({ state: "cancelled" });
      await whenExportsSettle();
      expect(t.jobs.submitted).toHaveLength(1); // the restart never started
      expect(await t.fs.exists(DEST)).toBe(false);
      expect(isDestinationReserved(DEST)).toBe(false);
      expect(listExports()).toEqual([]);
      expect((await outcomes())[0]).toMatchObject({ job_id: first.job_id, state: "cancelled" });
    });

    it("in the gap, by the quit: the window's close cancels every open export, and the one that is starting again is among them", async () => {
      const t = await setup();
      const gate = holdTheRestart(t);
      const first = await t.exportNow();
      await flush();
      gate.arm();
      t.jobs.exit(first.job_id, -1, SHORT);
      await flush(40);
      expect(listExports()).toHaveLength(1);
      // What App.tsx does when the window is closed: no canceller named, so the app's own.
      for (const open of listExports()) cancelExport(open.job_id);
      gate.release();
      expect(await whenExportEnds(first.job_id)).toMatchObject({ state: "cancelled" });
      await whenExportsSettle();
      expect(t.jobs.submitted).toHaveLength(1); // nothing was started after the quit
      expect(listExports()).toEqual([]);
      expect(isDestinationReserved(DEST)).toBe(false);
      expect(
        [...t.fs.files.keys()].filter((key) => key.startsWith("C:/Users/test/Downloads/")),
      ).toEqual([]);
    });

    it("in the last moment before the new attempt exists, after every other look at the request, still stops it for good", async () => {
      const t = await setup();
      const first = await t.exportNow();
      await flush();
      // The Cancel lands where nothing but the registry can still refuse the new attempt: after its last look at the
      // person's request, in the same turn as the moment it would become the export's next attempt.
      const link = attempts.link.bind(attempts);
      const landing = vi.spyOn(attempts, "link").mockImplementation((prev, next, kind, meta) => {
        cancelExport(first.job_id, "person_card");
        return link(prev, next, kind, meta);
      });
      try {
        t.jobs.exit(first.job_id, -1, SHORT);
        await flush(40);
        expect(landing).toHaveBeenCalledTimes(1);
        expect(await whenExportEnds(first.job_id)).toMatchObject({ state: "cancelled" });
        await whenExportsSettle();
      } finally {
        landing.mockRestore();
      }
      expect(t.jobs.submitted).toHaveLength(1); // the new attempt never ran
      expect(await t.fs.exists(DEST)).toBe(false);
      expect(isDestinationReserved(DEST)).toBe(false);
      expect(listExports()).toEqual([]);
      expect(
        [...t.fs.files.keys()].filter((key) => key.startsWith("C:/Users/test/Downloads/")),
      ).toEqual([]);
      expect((await outcomes())[0]).toMatchObject({ job_id: first.job_id, state: "cancelled" });
      expect((await outcomes())[0]).not.toHaveProperty("failure_code");
    });

    it.each(["first", "second"] as const)(
      "after it started reaches the new attempt, by the id %s attempt holds",
      async (holder) => {
        const { t, first, second } = await restarted();
        expect(cancelExport(holder === "first" ? first : second, "person_card")).toBe(true);
        expect(await whenExportEnds(first)).toMatchObject({ job_id: second, state: "cancelled" });
        await whenExportsSettle();
        expect(t.jobs.killed).toEqual([second]);
        expect(t.jobs.submitted).toHaveLength(2);
        expect(await t.fs.exists(DEST)).toBe(false);
      },
    );
  });

  describe("does nothing new when it is not the case", () => {
    const failsWith = async (
      arrange: () => void,
      stderr: string,
      record: string | null,
      options: { code?: string; during?: () => void } = {},
    ) => {
      const t = await setup();
      arrange();
      const first = await t.exportNow();
      await flush();
      options.during?.();
      t.jobs.exit(first.job_id, -1, stderr);
      await flush(40);
      // Exactly what happens today: the failure shows, nothing else was started, Try again is there.
      expect(t.jobs.submitted).toHaveLength(1);
      expect(listExportRecords().map((r) => r.job_id)).toEqual([first.job_id]);
      expect(listExportRecords()[0]).toMatchObject({ state: "failed", canRetry: true });
      expect(listExportRecords()[0].restarting).toBeUndefined();
      expect((await outcomes())[0]).toMatchObject({
        job_id: first.job_id,
        state: "failed",
        failure_code: options.code ?? "memory_limit",
      });
      expect(restartDecisions().map((d) => d.record)).toEqual(record === null ? [] : [record]);
      await whenExportEnds(first.job_id);
      await whenExportsSettle();
      await whenExportTelemetrySettles();
      expect(reported.map((r) => r.status)).toEqual(["failed"]); // no refusal report for a restart nobody asked for
    };

    it("when a quarter of the project was already made: too late to be worth it", async () => {
      await failsWith(() => undefined, SHORT, "late", {
        during: () => useExportJob.getState().update({ fraction: 0.5 }),
      });
    });

    it.each(["auto_restart", "memory_restart"] as const)(
      "when the app's switch for it is off (%s)",
      async (flag) => {
        await failsWith(() => __setExportFlag(flag, false), SHORT, "flag_off");
      },
    );

    it("when the export reached its own ceiling, not the PC's (no table of measured routes yet)", async () => {
      await failsWith(
        () => undefined,
        `${resident(3.6 * GIB)}native render failed: render resident memory budget exceeded: sampled=3865470566, limit=3758096384\n`,
        "no_route",
      );
    });

    it("when the PC cannot say how much memory it has: there is nothing to bet on", async () => {
      await failsWith(() => void (pc.available = null), SHORT, "pc_short");
    });

    it("when the gentler setting would not fit what the PC has now", async () => {
      await failsWith(() => undefined, SHORT, "pc_short", {
        during: () => void (pc.available = 0.3 * GIB),
      });
    });

    it("when the export has no gentler setting to go to (the switch for settings is off)", async () => {
      await failsWith(() => __setExportFlag("plan_rung", false), SHORT, "no_route");
    });

    it("when it did not fail for lack of memory", async () => {
      await failsWith(() => undefined, "native render failed: ffmpeg exited with code 1\n", null, {
        code: "render_failed",
      });
    });
  });

  it("does not ask the person anything: a question the pre-start check would put is a refusal, and the failure stands", async () => {
    const t = await setup();
    const first = await t.exportNow();
    await flush();
    // What this PC has learned since: the export needs more memory than the PC has free for the gentler setting, which the
    // pre-start check of the new export would ask the person about.
    const descriptor = (t.jobs.submitted[0].meta.telemetry as Any).calibration;
    useExportJob.getState().rememberCalibration({
      ...descriptor,
      elapsedSeconds: 60,
      finalBytes: 10_000_000,
      memoryBytes: 6 * GIB,
      temporaryBytes: 1_000_000,
    });
    pc.available = 3 * GIB;
    t.jobs.exit(first.job_id, -1, SHORT);
    await flush(40);
    expect(t.jobs.submitted).toHaveLength(1);
    expect(listExportRecords()[0]).toMatchObject({ job_id: first.job_id, state: "failed" });
    expect(restartDecisions().map((d) => d.record)).toEqual(["eligible", "refused_at_door"]);
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    expect(reported.map((r) => r.status)).toEqual(["failed"]);
  });

  it("does not take a file another request took in the gap: the restart is refused at the door and the failure stands", async () => {
    const t = await setup();
    const first = await t.exportNow();
    await flush();
    // The destination is released with the failed attempt; the restart asks for it again a moment later, after its own
    // pre-start check. Another request reserves it in between.
    let letGo!: () => void;
    pc.hold = new Promise<void>((resolve) => (letGo = resolve));
    pc.calls = 0;
    pc.holdCall = 2; // 1: the decision reads the PC; 2: the new export's pre-start check
    t.jobs.exit(first.job_id, -1, SHORT);
    await flush(40);
    expect(listExportRecords()[0]).toMatchObject({
      job_id: first.job_id,
      restarting: expect.any(String),
    });
    expect(isDestinationReserved(DEST)).toBe(false);
    const other = await t.exportNow();
    await flush();
    expect(isDestinationReserved(DEST)).toBe(true);
    letGo();
    await flush(40);
    expect(restartDecisions().map((d) => d.record)).toEqual(["eligible", "refused_at_door"]);
    // The failure shows as it would have, the other request is the one that runs, and nothing was started for the restart.
    expect(listExportRecords().find((r) => r.job_id === first.job_id)).toMatchObject({
      state: "failed",
      canRetry: true,
    });
    expect(listExportRecords().find((r) => r.job_id === first.job_id)?.restarting).toBeUndefined();
    expect(t.jobs.submitted.map((s) => s.id)).toEqual([first.job_id, other.job_id]);
    t.jobs.exit(other.job_id, 0);
    expect((await whenExportEnds(other.job_id))?.state).toBe("done");
    await whenExportsSettle();
    expect(await t.fs.exists(DEST)).toBe(true);
    expect(isDestinationReserved(DEST)).toBe(false);
  });

  it("does not put a newer project into an export it started again: an edit during the minutes of the first attempt refuses the restart", async () => {
    const t = await setup();
    const first = await t.exportNow();
    await flush();
    // The person edits while the first attempt runs; it then runs short of memory.
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 60, timeline_out: 120 }] },
      t.nextPage(),
    );
    t.jobs.exit(first.job_id, -1, SHORT);
    await flush(40);
    expect(t.jobs.submitted).toHaveLength(1);
    expect(listExportRecords()[0]).toMatchObject({ job_id: first.job_id, state: "failed" });
    expect(restartDecisions().map((d) => d.record)).toEqual(["eligible", "edited"]);
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    expect(reported.map((r) => r.status)).toEqual(["failed"]);
  });

  it.each([
    ["export stopped: it made no new picture for 15 min although the PC stayed busy (stalled)", 0],
    ["export stopped: it made no progress for 3 min (stalled)", 1],
  ] as const)(
    "Try again after the app stopped an export (%s) starts at rung %i",
    async (message, expected) => {
      const t = await setup();
      const first = await t.exportNow();
      await flush();
      t.jobs.exit(first.job_id, -1, `native render failed: ${message}\n`);
      await whenExportEnds(first.job_id);
      await retryExport(first.job_id);
      await flush(30);
      expect(t.jobs.submitted).toHaveLength(2);
      expect(rungOf(t.jobs.submitted[1])).toBe(expected);
      t.jobs.exit(t.jobs.submitted[1].id, 0);
      await whenExportsSettle();
    },
  );
});

// The client send of what the app did (rule E3b-18) is held until the owner approves the one privacy text. What a report
// says is what leaves the computer, so both states are pinned from the reports themselves.
describe("what the reports say of an export the app started again", () => {
  const block = (frame: number, outMs: number) =>
    `frame=${frame}\nfps=30\nout_time_us=${outMs * 1000}\nspeed=1.0x\nprogress=continue\n`;
  const eventsOf = (report: Any, name: string): Any[] =>
    (report.trace as Any[]).filter((e) => e.e === name);

  /** The export runs short of memory a tenth of the way in and is started again; the second attempt ends well. */
  async function aTenthInThenRestarted() {
    const t = await setup();
    const first = await t.exportNow();
    await flush();
    t.jobs.stdout(first.job_id, block(6, 200)); // 200 ms of the project's 2 s
    await flush();
    const percent = Math.round((useExportJob.getState().live?.fraction ?? 0) * 100);
    t.jobs.exit(first.job_id, -1, SHORT);
    await flush(40);
    expect(t.jobs.submitted).toHaveLength(2);
    t.jobs.exit(t.jobs.submitted[1].id, 0);
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    expect(reported.map((r) => r.status)).toEqual(["failed", "done"]);
    return { failed: reported[0], restarted: reported[1], percent };
  }

  it("says nothing of the restart while the send is held: no retry event, no percent in the outcome", async () => {
    const { failed, restarted, percent } = await aTenthInThenRestarted();
    expect(percent).toBeGreaterThan(0); // the run really was part-way, so a percent that is not sent is a held one
    expect(eventsOf(failed, "retry")).toEqual([]);
    expect(eventsOf(restarted, "retry")).toEqual([]);
    expect(eventsOf(failed, "outcome")[0]).toMatchObject({ v: "failed" });
    expect(eventsOf(failed, "outcome")[0].m ?? 0).toBe(0);
    expect(eventsOf(restarted, "outcome")[0].m ?? 0).toBe(0);
  });

  it("says, once the send is approved, that the app started the export again, from which setting to which, and how far along it was", async () => {
    held.send = true;
    const { failed, restarted, percent } = await aTenthInThenRestarted();
    // The restarted export's report carries the restart; the failed attempt's report does not: it ended before the
    // decision, and it is not the one that was started by the app.
    expect(eventsOf(failed, "retry")).toEqual([]);
    expect(eventsOf(restarted, "retry")).toEqual([
      expect.objectContaining({ v: "app", n: 0, m: 1 }),
    ]);
    // How far along the export was, on every report that says how it ended.
    expect(eventsOf(failed, "outcome")[0]).toMatchObject({ v: "failed", m: percent });
    expect(eventsOf(restarted, "outcome")[0]).toMatchObject({ v: "done", m: 100 });
  });
});

// What the person reads on the card while all of that happens: it is one export, never a failure and a new export side by side.
describe("what the person sees on the card of an export the app started again", () => {
  const status = () => screen.getByTestId("export-card-status").textContent;
  const settle = () =>
    act(async () => {
      await flush(40);
    });
  const open = async () => {
    const t = await setup();
    useEditor.setState({ projectId: "p", store: t.store });
    return t;
  };

  it("says it is starting again, then which attempt it is and why, and what to do when that one runs short again", async () => {
    const t = await open();
    const gate = holdTheRestart(t);
    const first = await t.exportNow();
    await flush();
    const { container } = render(createElement(ExportCard));
    expect(screen.getByText("Exporting “proj.mp4”")).toBeVisible();

    gate.arm();
    t.jobs.exit(first.job_id, -1, SHORT);
    await settle();
    // The gap: still the one export, not a failure, and it can still be cancelled.
    expect(status()).toBe("Starting again on a gentler setting…");
    expect(screen.queryByText("Export stopped")).toBeNull();
    expect(screen.getByRole("button", { name: "cancel proj.mp4" })).toBeVisible();

    gate.release();
    await settle();
    // The new attempt is the same export, said to be the second, and why.
    expect(screen.getByText("Exporting “proj.mp4” · attempt 2")).toBeVisible();
    expect(screen.getByTestId("export-card-restarted").textContent).toMatch(
      /^Started again on a gentler setting because your PC ran short of memory\./,
    );
    expect(screen.queryByText("Export stopped")).toBeNull();

    // It ran short again: said in words for that, with Try again, and nothing starts a third time by itself.
    t.jobs.exit(t.jobs.submitted[1].id, -1, SHORT);
    await settle();
    expect(screen.getByText("Export stopped")).toBeVisible();
    expect(screen.getByText(/even on a lighter setting/)).toBeVisible();
    expect(screen.getByRole("button", { name: "try again proj.mp4" })).toBeVisible();
    expect(t.jobs.submitted).toHaveLength(2);
    // Nothing on the card promises a speed or a picture.
    expect(container.textContent).not.toMatch(/faster|identical|same quality|pixel|lossless/i);
  });

  it("is stopped for good by the card's own Cancel while it is starting again", async () => {
    const t = await open();
    const gate = holdTheRestart(t);
    const first = await t.exportNow();
    await flush();
    render(createElement(ExportCard));
    gate.arm();
    t.jobs.exit(first.job_id, -1, SHORT);
    await settle();
    expect(status()).toBe("Starting again on a gentler setting…");

    fireEvent.click(screen.getByRole("button", { name: "cancel proj.mp4" }));
    gate.release();
    await settle();
    expect(screen.getByText("Export cancelled")).toBeVisible();
    expect(screen.queryByText(/attempt 2/)).toBeNull();
    expect(t.jobs.submitted).toHaveLength(1);
  });
});

// Every function that takes a job id passes it through the registry (exportAttempts.ts, ID_ENTRY_POINTS): the assistant holds
// the first attempt's id for the whole export while the card holds the live attempt's. One two-attempt case for each.
describe("every entry point that takes a job id works with either attempt's id of a restarted export", () => {
  const cases: Record<
    (typeof ID_ENTRY_POINTS)[number],
    (c: Awaited<ReturnType<typeof restarted>>) => Promise<void>
  > = {
    cancelExport: async ({ t, first, second }) => {
      expect(cancelExport(first, "assistant")).toBe(true);
      expect(await whenExportEnds(second)).toMatchObject({ state: "cancelled" });
      expect(t.jobs.killed).toEqual([second]);
    },
    whenExportEnds: async ({ t, first, second }) => {
      let ended: Any = null;
      void whenExportEnds(first).then((record) => (ended = record));
      await flush(10);
      expect(ended).toBeNull(); // the first attempt's end is not the export's
      t.jobs.exit(second, 0);
      await flush(40);
      expect(ended).toMatchObject({ job_id: second, state: "done" });
    },
    waitForExports: async ({ t, first, second }) => {
      let waited = false;
      void waitForExports(first, 5_000).then(() => (waited = true));
      await flush(10);
      expect(waited).toBe(false);
      t.jobs.exit(second, 0);
      await flush(40);
      expect(waited).toBe(true);
    },
    dismissExport: async ({ t, first, second }) => {
      t.jobs.exit(second, -1, SHORT);
      await whenExportEnds(first);
      expect(dismissExport(first)).toBe(true);
      expect(listExportRecords()).toEqual([]);
      expect(dismissExport(second)).toBe(false);
    },
    retryExport: async ({ t, first, second }) => {
      t.jobs.exit(second, -1, SHORT);
      await whenExportEnds(first);
      await retryExport(second); // the card's id; the assistant's id works the same (see the journey above)
      await flush(40);
      expect(t.jobs.submitted).toHaveLength(3);
      t.jobs.exit(t.jobs.submitted[2].id, 0);
      await whenExportsSettle();
    },
    manageExportsTool: async ({ t, first, second }) => {
      expect(await outcomes(first)).toHaveLength(1);
      expect(await outcomes(second)).toHaveLength(1);
      expect(
        ((await manageExportsTool({ action: "cancel", job_id: first })) as Any).cancelled,
      ).toBe(true);
      expect(await whenExportEnds(first)).toMatchObject({ state: "cancelled" });
      expect(t.jobs.killed).toEqual([second]);
    },
    listExportOutcomes: async ({ first }) => {
      const rows = await outcomes();
      expect(rows.map((r) => r.job_id)).toEqual([first]); // one row, under the id the assistant holds
    },
    listExportRecords: async ({ second }) => {
      expect(listExportRecords().map((r) => r.job_id)).toEqual([second]); // the card never shows the superseded attempt
    },
    "useExportJob.attach": async ({ first, second }) => {
      // The Export dialog holds the first id: its feed is the live attempt's.
      expect(liveFeedOf(useExportJob.getState(), first)?.jobId).toBe(second);
    },
  };

  it("has a case for every entry point of the table, and none for a name that is not on it", () => {
    expect(Object.keys(cases).sort()).toEqual([...ID_ENTRY_POINTS].sort());
  });

  it.each([...ID_ENTRY_POINTS])("%s", async (entry) => {
    await cases[entry](await restarted());
  });
});
