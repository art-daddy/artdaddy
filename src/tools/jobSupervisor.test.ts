// The page's side of a job of the app process (3h part 7, 4i): `runAsJob` resolves the way a
// CommandRunner reports a process, and `whenJobEnds` follows a job some other page started. Both
// are shared now (an export's ffmpeg, every whisper), so their edges are pinned here, against
// FakeJobs, which keeps the Rust supervisor's rules.
import { describe, expect, it } from "vitest";

import { FakeJobs } from "../test/fakeJobs";
import {
  type JobProgram,
  type JobSpec,
  type JobSupervisor,
  type JobView,
  runAsJob,
  whenJobEnds,
} from "./jobSupervisor";

const spec = (id: string, program: JobProgram = "whisper-cli"): JobSpec => ({
  id,
  lane: id,
  program,
  args: [],
  meta: {},
});

/** Whether `p` settled within a few turns of the event loop, and with what. */
async function soon<T>(p: Promise<T>): Promise<{ settled: boolean; value?: T }> {
  let out: { settled: boolean; value?: T } = { settled: false };
  void p.then((value) => (out = { settled: true, value }));
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  return out;
}

/** The supervisor as a page that hears none of its changes until `hear()`: one that missed them. */
function deaf(jobs: FakeJobs): { sup: JobSupervisor; hear: () => void } {
  let hearing = false;
  const sup: JobSupervisor = {
    submit: (s) => jobs.submit(s),
    kill: (id) => jobs.kill(id),
    list: () => jobs.list(),
    commit: (id) => jobs.commit(id),
    forget: (id) => jobs.forget(id),
    launchId: () => jobs.launchId(),
    subscribe: (onChange, onStdout) =>
      jobs.subscribe((v: JobView) => {
        if (hearing) onChange(v);
      }, onStdout),
  };
  return { sup, hear: () => (hearing = true) };
}

describe("runAsJob", () => {
  it("answers as its process ended: the code and what it wrote", async () => {
    const jobs = new FakeJobs();
    jobs.onStart = (s) => {
      jobs.stdout(s.id, "out");
      jobs.exit(s.id, 3, "boom");
    };
    expect(await runAsJob(jobs, spec("a"))).toEqual({ code: 3, stdout: "out", stderr: "boom" });
  });

  it("starts nothing when Stop came first, and answers cancelled", async () => {
    const jobs = new FakeJobs();
    const stop = new AbortController();
    stop.abort();
    expect(await runAsJob(jobs, spec("a"), stop.signal)).toEqual({
      code: -1,
      stdout: "",
      stderr: "cancelled",
    });
    expect(jobs.submitted).toEqual([]);
  });

  it("kills a job Stop reached while it was being handed over", async () => {
    const jobs = new FakeJobs();
    jobs.slowSubmit = true; // the kill reaches the supervisor before the job does
    const stop = new AbortController();
    const run = runAsJob(jobs, spec("a"), stop.signal);
    stop.abort();
    expect((await soon(run)).value).toEqual({ code: -1, stdout: "", stderr: "cancelled" });
    expect(jobs.killed).toEqual(["a"]);
  });

  it("answers a job the app process would not start as a failed run that names the program", async () => {
    const jobs = new FakeJobs();
    const run = runAsJob(jobs, spec("a", "yt-dlp" as unknown as JobProgram));
    expect((await soon(run)).value).toEqual({
      code: -1,
      stdout: "",
      stderr: expect.stringMatching(/^could not start yt-dlp: .*cannot be run as a job/),
    });
  });

  it("answers a job that ended before this page heard of it, from the app's own record", async () => {
    const jobs = new FakeJobs();
    await jobs.submit(spec("other"));
    jobs.exit("other", 7, "not this one");
    const { sup } = deaf(jobs);
    jobs.onStart = (s) => jobs.exit(s.id, 0, "done");
    expect((await soon(runAsJob(sup, spec("a")))).value).toEqual({
      code: 0,
      stdout: "",
      stderr: "done",
    });
  });

  it("hands its caller what its own process prints, and a caller that throws stops nothing", async () => {
    const jobs = new FakeJobs();
    await jobs.submit(spec("other"));
    const heard: string[] = [];
    const run = runAsJob(jobs, spec("a"), undefined, (chunk) => {
      heard.push(chunk);
      throw new Error("a progress bar that broke");
    });
    await soon(Promise.resolve());
    jobs.stdout("other", "not mine");
    jobs.stdout("a", "frame=1");
    jobs.exit("a", 0);
    expect((await soon(run)).value).toMatchObject({ code: 0 });
    expect(heard).toEqual(["frame=1"]);
  });
});

describe("whenJobEnds", () => {
  it("resolves with the job once it has ended, and not before", async () => {
    const jobs = new FakeJobs();
    await jobs.submit({ ...spec("ahead"), lane: "x" });
    await jobs.submit({ ...spec("a"), lane: "x" }); // queued behind `ahead`
    await jobs.submit(spec("b"));
    const ended = whenJobEnds(jobs, "a");
    jobs.exit("b", 0); // another job's end
    jobs.exit("ahead", 0); // `a` starts: a change, not an end
    expect((await soon(ended)).settled).toBe(false);
    jobs.exit("a", 5);
    expect((await soon(ended)).value).toMatchObject({ id: "a", state: "exited", code: 5 });
  });

  it("resolves at once with a job that already ended", async () => {
    const jobs = new FakeJobs();
    await jobs.submit(spec("b"));
    await jobs.submit(spec("a"));
    jobs.exit("a", 0);
    expect((await soon(whenJobEnds(jobs, "a"))).value).toMatchObject({ id: "a", code: 0 });
  });

  it("resolves null for a job the app process does not have, or cannot list", async () => {
    const jobs = new FakeJobs();
    await jobs.submit(spec("b")); // running, and not the one asked for
    expect(await soon(whenJobEnds(jobs, "a"))).toEqual({ settled: true, value: null });
    const broken: JobSupervisor = {
      ...deaf(jobs).sup,
      list: () => Promise.reject(new Error("ipc")),
    };
    expect(await soon(whenJobEnds(broken, "b"))).toEqual({ settled: true, value: null });
  });
});
