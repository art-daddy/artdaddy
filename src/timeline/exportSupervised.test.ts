// 3h part 7: in the app an export's ffmpeg runs as a job of the app process, so it outlives a crash
// of the page, and the next page commits it exactly as the first would have. These drive the real
// export tool and the real queue against FakeJobs, which keeps the supervisor's rules (its Rust
// twin is tested in src-tauri/src/jobs.rs) and lets a test play the ffmpeg process.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JobLedger } from "../project/jobLedger";
import { FakeJobs } from "../test/fakeJobs";
import { MemFs, registerTestDocument, resetTestDocuments } from "../test/timelineKit";
import { agentToolContext } from "../tools/agentStore";
import type { CommandResult, CommandRunner } from "../tools/command";
import type { ClientToolContext } from "../tools/context";
import { __resetProjectJobs } from "../tools/genJobs";
import { ffmpegPolicy } from "../tools/ffmpegPolicy";
import { __resetJobSupervisor, __setJobSupervisor, supervisedRunner } from "../tools/jobSupervisor";
import { joinPath, ProjectStoreAccess } from "../tools/store";
import { ensureTimeline } from "./engine";
import {
  __resetExportQueue,
  adoptExports,
  cancelExport,
  listExportRecords,
  whenExportEnds,
  whenExportsSettle,
} from "./exportQueue";
import { addClipsTool } from "./placement";
import { exportTimelineTool } from "./render";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

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
  const runner: CommandRunner = {
    run: async (program): Promise<CommandResult> => {
      ran.push(program);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  await addClipsTool(
    { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
    { store, runner },
  );
  const jobs = new FakeJobs();
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
    expect((await whenExportEnds(a.job_id))?.state).toBe("done");
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

  it("one the dead page had already committed is not committed twice", async () => {
    const t = await setup();
    const a = await t.exportNow();
    await flush();
    pageCrashes(t.jobs);
    // The page renamed the file and told the app process, then died before letting go.
    t.jobs.exit(a.job_id, 0);
    const stage = t.jobs.submitted[0].args.at(-1)!;
    await t.fs.rename(stage, DEST);
    await t.jobs.commit(a.job_id);
    expect(await adoptExports({ contextFor: t.nextPage })).toBe(0);
    expect(listExportRecords()).toEqual([]);
    expect(t.jobs.forgotten).toEqual([a.job_id]);
    expect(await t.fs.readTextFile(DEST)).toBe("a whole video");
  });

  it("one the dead page renamed but never reported is still a delivered export", async () => {
    const t = await setup();
    const a = await t.exportNow();
    await flush();
    pageCrashes(t.jobs);
    // Renamed into place, and the page died before telling the app process.
    t.jobs.exit(a.job_id, 0);
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

  it("applies the app's ffmpeg rules, as the page's runner does", async () => {
    const r = supervisedRunner(base(), jobs, { id: "j1", lane: "export", meta: {} });
    const args = ["-i", "a.wav", "-c:a", "aac", "-ar", "16000", "out.partial"];
    const done = r.run("ffmpeg", args);
    await flush();
    expect(jobs.submitted[0].args).toEqual(ffmpegPolicy("ffmpeg", args));
    expect(jobs.submitted[0].args).not.toContain("16000"); // AAC is always encoded at 48 kHz
    jobs.exit("j1", 0);
    expect((await done).code).toBe(0);
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
