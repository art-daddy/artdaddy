// 3h part 7: in the app an export's ffmpeg runs as a job of the app process, so it outlives a crash
// of the page, and the next page commits it exactly as the first would have. These drive the real
// export tool and the real queue against FakeJobs, which keeps the supervisor's rules (its Rust
// twin is tested in src-tauri/src/jobs.rs) and lets a test play the ffmpeg process.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import { JobLedger } from "../project/jobLedger";
import { FakeJobs } from "../test/fakeJobs";
import { MemFs, registerTestDocument, resetTestDocuments } from "../test/timelineKit";
import { agentToolContext } from "../tools/agentStore";
import type { CommandResult, CommandRunner } from "../tools/command";
import type { ClientToolContext } from "../tools/context";
import { __resetProjectJobs } from "../tools/genJobs";
import { __resetJobSupervisor, __setJobSupervisor, supervisedRunner } from "../tools/jobSupervisor";
import { joinPath, ProjectStoreAccess } from "../tools/store";
import { ensureTimeline } from "./engine";
import {
  __resetExportQueue,
  adoptExports,
  cancelExport,
  listExportRecords,
  localDeliveryPort,
  whenExportEnds,
  whenExportsSettle,
} from "./exportQueue";
import { addClipsTool } from "./placement";
import { exportTimelineTool } from "./render";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

vi.mock("../api/exportEvents", () => ({ reportExport: async () => undefined }));

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
  async readBytes(p: string): Promise<Uint8Array> {
    const v = this.files.get(joinPath(p));
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return new TextEncoder().encode(String(v));
  }
  async probeMedia(p: string, headBytes: number) {
    const bytes = await this.readBytes(p);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return { id12: sha256.slice(0, 12), sha256, size: bytes.length, head: bytes.slice(0, headBytes) };
  }
}

const DIR = "C:/proj";
const DEST = "C:/Users/test/Downloads/proj.mp4";
const DEST_B = "C:/Users/test/Downloads/b.mp4";
const settle = () => new Promise((r) => setTimeout(r, 0));
async function flush(n = 20) {
  for (let i = 0; i < n; i++) await settle();
}

async function setup() {
  const fs = new Fs();
  const store = new ProjectStoreAccess(DIR, fs);
  registerTestDocument(DIR);
  await ensureTimeline(store);
  // Everything but ffmpeg runs under the page as before (the probes, the checks); an ffmpeg that
  // lands here ran under the page, which is what these tests forbid.
  const ran: string[] = [];
  let jobs: FakeJobs | undefined;
  const runner: CommandRunner = {
    run: async (program, args): Promise<CommandResult> => {
      ran.push(program);
      if (program === "ffprobe") {
        const spec = jobs?.submitted.find((submitted) => submitted.meta.stagePath === args.at(-1));
        const plan = spec?.meta.plan as { duration: number; audioExpected: boolean; output: { width: number; height: number; fps: number } } | undefined;
        const output = plan?.output ?? { width: 1920, height: 1080, fps: 30 };
        const duration = plan?.duration ?? 2;
        return { code: 0, stdout: JSON.stringify({ streams: [{ codec_type: "video", width: output.width, height: output.height,
          avg_frame_rate: `${output.fps}/1`, nb_read_frames: String(Math.ceil(duration * output.fps)), duration: String(duration) },
          ...(plan?.audioExpected ? [{ codec_type: "audio", duration: String(duration) }] : [])],
          format: { duration: String(duration) } }), stderr: "" };
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
  // The process writes its output where it was told: the last argument.
  jobs.onStart = (spec) => fs.writeTextFile(spec.args[spec.args.length - 1], "a whole video");
  __setJobSupervisor(jobs);
  const base: ClientToolContext = { store, runner };
  const exportNow = async (name?: string) =>
    (await exportTimelineTool(
      name ? { name } : {},
      agentToolContext(base, new AbortController().signal),
    )) as Any;
  // A new page: its own store over the same disk, and no memory of the last page.
  const nextPage = () => ({ store: new ProjectStoreAccess(DIR, fs), runner });
  return { fs, store, ran, jobs, exportNow, nextPage };
}

/** What a crash of the page does: its queue, its caches and its event listeners are gone; the app
 *  process, its jobs and the disk are not. */
function pageCrashes(jobs: FakeJobs) {
  jobs.pageDied();
  __resetExportQueue();
  __resetProjectJobs();
}

afterEach(async () => {
  await resetTestDocuments();
  await whenExportsSettle();
  __resetExportQueue();
  __resetProjectJobs();
  __resetJobSupervisor();
});

async function ledgerStatus(fs: Fs, id: string): Promise<string | undefined> {
  const file = JSON.parse(await fs.readTextFile(`${DIR}/internals/jobs.json`)) as {
    jobs: { id: string; status: string }[];
  };
  return file.jobs.find((j) => j.id === id)?.status;
}

describe("local delivery state after asynchronous identity checks", () => {
  it.each([
    { operation: "verify", action: "cancel", terminal: "cancelled" },
    { operation: "verify", action: "fail", terminal: "failed" },
    { operation: "publish", action: "cancel", terminal: "cancelled" },
    { operation: "publish", action: "fail", terminal: "failed" },
  ] as const)("$action during $operation preserves the destination and terminal state", async ({ operation, action, terminal }) => {
    const fs = new Fs();
    const store = new ProjectStoreAccess(DIR, fs);
    const port = localDeliveryPort(store);
    const stage = `${DEST}.partial`;
    const intent = `identity-race-${operation}-${action}`;
    await fs.writeTextFile(stage, "complete staged bytes");
    await fs.writeTextFile(DEST, "previous destination bytes");
    await port.prepare(intent, DIR, stage, DEST, { kind: "render", paths: [] });
    if (operation === "publish") await port.verify(intent);

    let entered!: () => void;
    let release!: () => void;
    const checking = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const probe = store.probeMedia.bind(store);
    vi.spyOn(store, "probeMedia").mockImplementationOnce(async (...args) => {
      const result = await probe(...args);
      entered();
      await gate;
      return result;
    });
    const pending = port[operation](intent);
    try {
      await checking;
      expect(await port[action](intent)).toBe(true);
    } finally {
      release();
    }
    await expect(pending).rejects.toThrow("export intent was cancelled or failed");
    expect((await port.list())[0].state).toBe(terminal);
    expect(await fs.readTextFile(DEST)).toBe("previous destination bytes");
    expect(await fs.readTextFile(stage)).toBe("complete staged bytes");
  });
});

describe("in the app, an export runs as a job of the app process", () => {
  it("runs ffmpeg there, one export at a time, and delivers each in turn", async () => {
    const t = await setup();
    const a = await t.exportNow();
    const b = await t.exportNow("b");
    await flush();
    expect(t.jobs.submitted.map((s) => s.id)).toEqual([a.job_id, b.job_id]);
    expect(t.ran).not.toContain("ffmpeg");
    expect(t.jobs.view(a.job_id)?.state).toBe("running");
    expect(t.jobs.view(b.job_id)?.state).toBe("queued");
    expect(listExportRecords().map((r) => r.state)).toEqual(["running", "queued"]);
    expect(t.jobs.submitted[0].meta).toMatchObject({
      kind: "export",
      projectDir: DIR,
      destPath: DEST,
      filename: "proj.mp4",
    });

    t.jobs.exit(a.job_id, 0);
    const completed = await whenExportEnds(a.job_id);
    expect(completed?.state, completed?.error).toBe("done");
    expect(await t.fs.readTextFile(DEST)).toBe("a whole video");
    await flush();
    expect(t.jobs.view(b.job_id)?.state).toBe("running");
    t.jobs.exit(b.job_id, 0);
    expect((await whenExportEnds(b.job_id))?.state).toBe("done");
    expect(await t.fs.exists(DEST_B)).toBe(true);
    await whenExportsSettle();
    expect(t.jobs.forgotten).toEqual([a.job_id, b.job_id]);
  });

  it("is stopped by Cancel through the app process, leaving nothing behind", async () => {
    const t = await setup();
    const a = await t.exportNow();
    const b = await t.exportNow("b");
    await flush();
    expect(cancelExport(b.job_id)).toBe(true); // queued: it must never start
    expect(cancelExport(a.job_id)).toBe(true); // running: its process is killed
    expect((await whenExportEnds(a.job_id))?.state).toBe("cancelled");
    expect((await whenExportEnds(b.job_id))?.state).toBe("cancelled");
    expect(t.jobs.killed.sort()).toEqual([a.job_id, b.job_id].sort());
    expect(t.jobs.started).toEqual([a.job_id]); // the queued one never started
    expect([...t.fs.files.keys()].some((k) => k.endsWith(".partial"))).toBe(false);
    expect(await t.fs.exists(DEST)).toBe(false);
  });
});

describe("an export outlives a crash of the page", () => {
  it("retains a retry requested while earlier registration is still active", async () => {
    const t = await setup();
    const submitted = await t.exportNow();
    await flush();
    let rejectRead!: (reason: Error) => void;
    const pendingRead = new Promise<Uint8Array>((_, reject) => { rejectRead = reject; });
    const read = vi.spyOn(t.store, "readBytes").mockReturnValue(pendingRead);
    t.jobs.exit(submitted.job_id, 0);
    try {
      await flush();
      expect(read).toHaveBeenCalled();
      expect(await adoptExports({ contextFor: t.nextPage })).toBe(0);
    } finally {
      read.mockRestore();
      rejectRead(new Error("old registration attempt failed after reopen"));
    }
    await whenExportsSettle();
    expect(await t.fs.readTextFile(DEST)).toBe("a whole video");
    expect(listExportRecords().find((record) => record.job_id === submitted.job_id)?.mediaRef).toMatch(/^media_/);
    expect((await t.store.listClips()).filter((clip) => clip.path === DEST)).toHaveLength(1);
  });

  it("adopts pending follow-ups once for the matching project under concurrent requests", async () => {
    const t = await setup();
    const submitted = await t.exportNow();
    await flush();
    pageCrashes(t.jobs);
    t.jobs.exit(submitted.job_id, 0);
    await t.jobs.delivery!.verify(submitted.job_id);
    await t.jobs.delivery!.publish(submitted.job_id);
    await t.jobs.commit(submitted.job_id);
    expect(await adoptExports({ projectId: "different-project", contextFor: t.nextPage })).toBe(0);
    const results = await Promise.all([
      adoptExports({ projectId: "proj", contextFor: t.nextPage }),
      adoptExports({ projectId: "proj", contextFor: t.nextPage }),
    ]);
    expect(results.reduce((total, count) => total + count, 0)).toBe(1);
    await whenExportsSettle();
    expect(await t.fs.readTextFile(DEST)).toBe("a whole video");
    expect((await t.store.listClips()).filter((clip) => clip.path === DEST)).toHaveLength(1);
    expect(listExportRecords().filter((record) => record.job_id === submitted.job_id)).toHaveLength(1);
  });

  it("retries unacknowledged registration while retaining the current page row", async () => {
    const t = await setup();
    const submitted = await t.exportNow();
    await flush();
    const read = vi.spyOn(t.store, "readBytes").mockRejectedValue(new Error("registration is unavailable"));
    t.jobs.exit(submitted.job_id, 0);
    await whenExportsSettle();
    read.mockRestore();
    const delivered = await t.fs.readTextFile(DEST);
    expect(listExportRecords().find((record) => record.job_id === submitted.job_id)?.mediaRef).toBeUndefined();
    expect(t.jobs.view(submitted.job_id)?.committed).toBe(true);
    expect(await adoptExports({ contextFor: t.nextPage })).toBe(1);
    await whenExportsSettle();
    expect(await t.fs.readTextFile(DEST)).toBe(delivered);
    expect(listExportRecords().filter((record) => record.job_id === submitted.job_id)).toHaveLength(1);
    expect(listExportRecords().find((record) => record.job_id === submitted.job_id)?.mediaRef).toMatch(/^media_/);
    expect(t.jobs.view(submitted.job_id)).toBeUndefined();
  });

  it("finishes library and ledger follow-ups after native file commit", async () => {
    const t = await setup();
    const submitted = await t.exportNow();
    await flush();
    pageCrashes(t.jobs);
    t.jobs.exit(submitted.job_id, 0);
    await t.jobs.delivery!.verify(submitted.job_id);
    await t.jobs.delivery!.publish(submitted.job_id);
    await t.jobs.commit(submitted.job_id);
    const delivered = await t.fs.readTextFile(DEST);
    expect(await adoptExports({ contextFor: t.nextPage })).toBe(1);
    await whenExportsSettle();
    expect(await t.fs.readTextFile(DEST)).toBe(delivered);
    expect(await ledgerStatus(t.fs, submitted.job_id)).toBe("done");
    expect(listExportRecords().find((record) => record.job_id === submitted.job_id)?.mediaRef).toMatch(/^media_/);
  });

  it("refuses an unsupported contract even when verified bytes were already moved", async () => {
    const t = await setup();
    const submitted = await t.exportNow();
    await flush();
    pageCrashes(t.jobs);
    t.jobs.exit(submitted.job_id, 0);
    await t.jobs.delivery!.verify(submitted.job_id);
    await t.fs.rename(t.jobs.submitted[0].args.at(-1)!, DEST);
    const plan = t.jobs.submitted[0].meta.plan as Record<string, unknown>;
    plan.contractVersion = -1;
    await adoptExports({ contextFor: t.nextPage });
    const outcome = await whenExportEnds(submitted.job_id);
    expect(outcome?.state).toBe("failed");
    expect(outcome?.error).toContain("unsupported render contract");
    expect(await t.fs.readTextFile(DEST)).toBe("a whole video");
  });
  it("refuses malformed output metadata even after native publication", async () => {
    const t = await setup();
    const submitted = await t.exportNow();
    await flush();
    pageCrashes(t.jobs);
    t.jobs.exit(submitted.job_id, 0);
    await t.jobs.delivery!.verify(submitted.job_id);
    await t.jobs.delivery!.publish(submitted.job_id);
    const plan = t.jobs.submitted[0].meta.plan as { output: { width: number } };
    plan.output.width = 0;
    await adoptExports({ contextFor: t.nextPage });
    await whenExportsSettle();
    const outcome = await whenExportEnds(submitted.job_id);
    expect(outcome?.state).toBe("failed");
    expect(outcome?.error).toContain("supported output contract");
    expect(await t.fs.readTextFile(DEST)).toBe("a whole video");
    expect((await t.store.listClips()).filter((clip) => clip.path === DEST)).toHaveLength(0);
  });

  it("one that finished while no page was there is committed by the next page", async () => {
    const t = await setup();
    const a = await t.exportNow();
    await flush();
    pageCrashes(t.jobs);
    t.jobs.exit(a.job_id, 0); // ffmpeg finishes with nobody watching

    expect(await adoptExports({ contextFor: t.nextPage })).toBe(1);
    expect((await whenExportEnds(a.job_id))?.state).toBe("done");
    await whenExportsSettle();
    expect(await t.fs.readTextFile(DEST)).toBe("a whole video");
    expect([...t.fs.files.keys()].some((k) => k.endsWith(".partial"))).toBe(false);
    expect(await ledgerStatus(t.fs, a.job_id)).toBe("done");
    expect(listExportRecords().find((r) => r.job_id === a.job_id)?.mediaRef).toMatch(/^media_/);
    expect(t.jobs.committed).toEqual([a.job_id]);
    expect(t.jobs.forgotten).toEqual([a.job_id]);
  });

  it("one still running is followed, and committed when it ends", async () => {
    const t = await setup();
    const a = await t.exportNow();
    await flush();
    pageCrashes(t.jobs);
    await adoptExports({ contextFor: t.nextPage });
    expect(listExportRecords().map((r) => [r.job_id, r.state])).toEqual([[a.job_id, "running"]]);
    t.jobs.exit(a.job_id, 0);
    expect((await whenExportEnds(a.job_id))?.state).toBe("done");
    expect(await t.fs.exists(DEST)).toBe(true);
  });

  it("one that failed while no page was there reads failed, and its partial goes", async () => {
    const t = await setup();
    const a = await t.exportNow();
    await flush();
    pageCrashes(t.jobs);
    t.jobs.exit(a.job_id, 1, "Invalid data found when processing input");
    await adoptExports({ contextFor: t.nextPage });
    const ended = await whenExportEnds(a.job_id);
    expect(ended?.state).toBe("failed");
    expect(ended?.error).toMatch(/ffmpeg render failed \(code=1\).*Invalid data/);
    await whenExportsSettle();
    expect(await t.fs.exists(DEST)).toBe(false);
    expect([...t.fs.files.keys()].some((k) => k.endsWith(".partial"))).toBe(false);
    expect(await ledgerStatus(t.fs, a.job_id)).toBe("failed");
  });

  it("one cancelled before the page died reads cancelled, not delivered", async () => {
    const t = await setup();
    const a = await t.exportNow();
    await flush();
    pageCrashes(t.jobs);
    await t.jobs.kill(a.job_id);
    await flush();
    await adoptExports({ contextFor: t.nextPage });
    expect((await whenExportEnds(a.job_id))?.state).toBe("cancelled");
    await whenExportsSettle();
    expect(await t.fs.exists(DEST)).toBe(false);
    expect(await ledgerStatus(t.fs, a.job_id)).toBe("cancelled");
  });

  it("can be cancelled from the page that adopted it", async () => {
    const t = await setup();
    const a = await t.exportNow();
    await flush();
    pageCrashes(t.jobs);
    await adoptExports({ contextFor: t.nextPage });
    expect(cancelExport(a.job_id)).toBe(true);
    expect((await whenExportEnds(a.job_id))?.state).toBe("cancelled");
    expect(t.jobs.killed).toEqual([a.job_id]);
  });

  it("does not repeat acknowledged follow-ups when forgetting the job was interrupted", async () => {
    const t = await setup();
    const a = await t.exportNow();
    await flush();
    vi.spyOn(t.jobs, "forget").mockResolvedValueOnce(false);
    t.jobs.exit(a.job_id, 0);
    await whenExportsSettle();
    expect(listExportRecords().find((record) => record.job_id === a.job_id)?.mediaRef).toMatch(/^media_/);
    expect(t.jobs.view(a.job_id)?.committed).toBe(true);
    pageCrashes(t.jobs);
    expect(await adoptExports({ contextFor: t.nextPage })).toBe(0);
    expect(listExportRecords()).toEqual([]);
    expect(t.jobs.forgotten).toEqual([a.job_id]);
    expect(await t.fs.readTextFile(DEST)).toBe("a whole video");
  });

  it("a verified file the dead page renamed is reconciled by its identity", async () => {
    const t = await setup();
    const a = await t.exportNow();
    await flush();
    pageCrashes(t.jobs);
    // Renamed into place, and the page died before telling the app process.
    t.jobs.exit(a.job_id, 0);
    await t.jobs.delivery!.verify(a.job_id);
    await t.fs.rename(t.jobs.submitted[0].args.at(-1)!, DEST);
    await adoptExports({ contextFor: t.nextPage });
    expect((await whenExportEnds(a.job_id))?.state).toBe("done");
    await whenExportsSettle();
    expect(await t.fs.readTextFile(DEST)).toBe("a whole video");
    expect(await ledgerStatus(t.fs, a.job_id)).toBe("done");
  });

  it("keeps its job record alive across the reload, so the ledger does not call it interrupted", async () => {
    const t = await setup();
    const a = await t.exportNow();
    await flush();
    pageCrashes(t.jobs);
    // The next page reopens the project's ledger while the export still runs.
    const ledger = await JobLedger.open(new ProjectStoreAccess(DIR, t.fs));
    expect(ledger.list().find((r) => r.id === a.job_id)?.status).toBe("running");
    // A different run of the app (a restart) could not have kept it running.
    __setJobSupervisor(new FakeJobs("launch-after-restart"));
    const after = await JobLedger.open(new ProjectStoreAccess(DIR, t.fs));
    expect(after.list().find((r) => r.id === a.job_id)?.status).toBe("interrupted");
  });
});

describe("the runner that hands ffmpeg to the app process", () => {
  const base = (): CommandRunner & { ran: string[] } => {
    const ran: string[] = [];
    return {
      ran,
      run: async (program) => {
        ran.push(program);
        return { code: 0, stdout: "probe", stderr: "" };
      },
    };
  };
  let jobs: FakeJobs;
  beforeEach(() => {
    jobs = new FakeJobs();
  });

  // The app's ffmpeg rules are applied where the job is started (tauri.ts launchSpec; its test walks
  // every program a job may run), so the export hands over its command as it built it.
  it("hands its first ffmpeg to the app as a job, and runs everything else itself", async () => {
    const b = base();
    const r = supervisedRunner(b, jobs, { id: "j1", lane: "export", meta: {} });
    const args = ["-i", "a.wav", "-c:a", "aac", "-ar", "16000", "out.partial"];
    const done = r.run("ffmpeg", args);
    await flush();
    expect(jobs.submitted.map((s) => [s.program, s.args])).toEqual([["ffmpeg", args]]);
    jobs.exit("j1", 0);
    expect((await done).code).toBe(0);
    await r.run("ffprobe", []);
    await r.run("ffmpeg", []);
    expect([jobs.submitted.length, b.ran]).toEqual([1, ["ffprobe", "ffmpeg"]]);
  });

  it("hands every render step to one native job without executing intermediate ffmpegs on the page", async () => {
    const b = base();
    const r = supervisedRunner(b, jobs, { id: "j1", lane: "export", meta: { kind: "export" } });
    const done = r.runSequence!([
      { args: ["first.nut"], duration: 2 },
      { args: ["second.nut"], duration: 3 },
      { args: ["final.partial"], duration: 5 },
    ], undefined, "C:/scratch/parts");
    await flush();
    expect(jobs.submitted).toHaveLength(1);
    expect(jobs.submitted[0]).toMatchObject({
      id: "j1", args: ["first.nut"], steps: [["second.nut"], ["final.partial"]],
      cwd: "C:/scratch/parts", meta: { scratch: "C:/scratch/parts" },
    });
    expect(b.ran).toEqual([]);
    jobs.exit("j1", 0);
    expect(await done).toMatchObject({ code: 0 });
  });

  it("forwards progress, carries its scratch dir with the job, and reports how it ended", async () => {
    const r = supervisedRunner(base(), jobs, {
      id: "j1",
      lane: "export",
      meta: { kind: "export" },
    });
    const seen: string[] = [];
    const done = r.run("ffmpeg", ["-i", "x", "o"], undefined, "C:/scratch/caps-1", (c) =>
      seen.push(c),
    );
    await flush();
    expect(jobs.submitted[0].cwd).toBe("C:/scratch/caps-1");
    expect(jobs.submitted[0].meta).toEqual({ kind: "export", scratch: "C:/scratch/caps-1" });
    jobs.stdout("j1", "out_time_ms=1000\n");
    jobs.exit("j1", 3, "No such filter");
    const res = await done;
    expect(seen).toEqual(["out_time_ms=1000\n"]);
    expect(res).toEqual({ code: 3, stdout: "out_time_ms=1000\n", stderr: "No such filter" });
  });

  it("is cancelled by its signal: the job is killed and the run reads cancelled", async () => {
    const r = supervisedRunner(base(), jobs, { id: "j1", lane: "export", meta: {} });
    const stop = new AbortController();
    const done = r.run("ffmpeg", ["-i", "x", "o"], stop.signal);
    await flush();
    stop.abort();
    expect(await done).toMatchObject({ code: -1, stderr: "cancelled" });
    expect(jobs.killed).toEqual(["j1"]);
  });

  it("still kills a job cancelled while it was being handed over", async () => {
    jobs.slowSubmit = true;
    const r = supervisedRunner(base(), jobs, { id: "j1", lane: "export", meta: {} });
    const stop = new AbortController();
    const done = r.run("ffmpeg", ["-i", "x", "o"], stop.signal);
    stop.abort(); // before the supervisor has the job
    expect(await done).toMatchObject({ code: -1, stderr: "cancelled" });
    expect(jobs.killed).toEqual(["j1"]);
  });

  it("leaves everything but the encode on the page's runner", async () => {
    const b = base();
    const r = supervisedRunner(b, jobs, { id: "j1", lane: "export", meta: {} });
    expect((await r.run("ffprobe", ["-i", "o"])).stdout).toBe("probe");
    const enc = r.run("ffmpeg", ["-i", "x", "o"]);
    await flush();
    jobs.exit("j1", 0);
    await enc;
    expect((await r.run("ffmpeg", ["-i", "o", "-f", "null", "-"])).stdout).toBe("probe");
    expect(b.ran).toEqual(["ffprobe", "ffmpeg"]);
    expect(jobs.submitted).toHaveLength(1);
  });
});
