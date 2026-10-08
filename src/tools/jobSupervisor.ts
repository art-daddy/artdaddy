// The app process's job supervisor (src-tauri/src/jobs.rs), as the page sees it (3h part 7).
//
// An export's ffmpeg runs there, not under the page, so a crash of the page neither kills the
// render nor loses its result: the next page lists the jobs and commits what ended while no page
// was there. The page still does all the thinking (the plan, the checks, the rename, the project's
// records); the supervisor only runs the process, in order, and remembers how it ended.
import type { CommandResult, CommandRunner } from "./command";

export type JobState = "queued" | "running" | "exited";

/** The programs the app process will run as a job: the logical names of `SIDECARS` in
 *  src-tauri/src/jobs.rs, its twin (a test holds the two together). */
export const JOB_PROGRAMS = ["ffmpeg", "whisper-cli"] as const;
export type JobProgram = (typeof JOB_PROGRAMS)[number];

export interface JobView {
  id: string;
  lane: string;
  state: JobState;
  code: number | null;
  /** Ended by Cancel (or by the app exiting), whatever its exit code says. */
  killed: boolean;
  /** A page has committed its file; only the project follow-ups may still be outstanding. */
  committed: boolean;
  meta: Record<string, unknown>;
  stdout_tail: string;
  stderr_head: string;
  stderr_elided: number;
  stderr_tail: string;
  queued_at: number;
  started_at: number | null;
  ended_at: number | null;
}

export interface JobSpec {
  id: string;
  lane: string;
  program: JobProgram;
  args: string[];
  cwd?: string | null;
  meta: Record<string, unknown>;
}

export interface JobSupervisor {
  /** Queue the job on its lane; resolves with how many jobs are ahead of it. */
  submit(spec: JobSpec): Promise<number>;
  /** Cancel: a queued job never starts, a running one is killed. False once it has ended. */
  kill(id: string): Promise<boolean>;
  list(): Promise<JobView[]>;
  /** Record that the job's file was committed, before the project follow-ups. */
  commit(id: string): Promise<boolean>;
  /** Drop an ended job once the page is done with it. */
  forget(id: string): Promise<boolean>;
  /** This run of the app: the same across page reloads, new after a restart. */
  launchId(): Promise<string>;
  /** Every change of every job, and every chunk a running job prints. Returns the unsubscribe. */
  subscribe(
    onChange: (job: JobView) => void,
    onStdout?: (id: string, chunk: string) => void,
  ): () => void;
}

/** A job's stderr as one string: both ends, with what was dropped between them marked. */
export function jobStderr(
  job: Pick<JobView, "stderr_head" | "stderr_elided" | "stderr_tail">,
): string {
  if (!job.stderr_elided) return job.stderr_head + job.stderr_tail;
  return `${job.stderr_head}\n…[${job.stderr_elided} bytes elided]…\n${job.stderr_tail}`;
}

/** What a run of `job` returns to its caller, the way a CommandRunner reports a process. */
export function jobResult(job: JobView): CommandResult {
  if (job.killed) return { code: -1, stdout: job.stdout_tail, stderr: "cancelled" };
  return { code: job.code ?? -1, stdout: job.stdout_tail, stderr: jobStderr(job) };
}

class TauriJobSupervisor implements JobSupervisor {
  private readonly changeFns = new Set<(job: JobView) => void>();
  private readonly stdoutFns = new Set<(id: string, chunk: string) => void>();
  private listening: Promise<void> | null = null;

  private async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }
  private listen(): Promise<void> {
    this.listening ??= (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      await listen<JobView>("jobs:changed", (e) => {
        for (const fn of this.changeFns) fn(e.payload);
      });
      await listen<{ id: string; chunk: string }>("jobs:stdout", (e) => {
        for (const fn of this.stdoutFns) fn(e.payload.id, e.payload.chunk);
      });
    })();
    return this.listening;
  }
  async submit(spec: JobSpec): Promise<number> {
    await this.listen(); // before the job exists, so its first change cannot be missed
    // Started by the app's rules for the program, as the page's own runner starts it: ffmpeg's, and
    // whisper-cli's DLL folder as its working directory, without which it never loads on Windows.
    const { launchSpec } = await import("./tauri");
    const launch = await launchSpec(spec.program, spec.args, spec.cwd);
    return this.invoke<number>("jobs_submit", { spec: { ...spec, ...launch } });
  }
  kill(id: string): Promise<boolean> {
    return this.invoke<boolean>("jobs_kill", { id });
  }
  async list(): Promise<JobView[]> {
    await this.listen();
    return this.invoke<JobView[]>("jobs_list");
  }
  commit(id: string): Promise<boolean> {
    return this.invoke<boolean>("jobs_commit", { id });
  }
  forget(id: string): Promise<boolean> {
    return this.invoke<boolean>("jobs_forget", { id });
  }
  launchId(): Promise<string> {
    return this.invoke<string>("jobs_launch_id");
  }
  subscribe(
    onChange: (job: JobView) => void,
    onStdout?: (id: string, chunk: string) => void,
  ): () => void {
    void this.listen();
    this.changeFns.add(onChange);
    if (onStdout) this.stdoutFns.add(onStdout);
    return () => {
      this.changeFns.delete(onChange);
      if (onStdout) this.stdoutFns.delete(onStdout);
    };
  }
}

let current: Promise<JobSupervisor | null> | null = null;

/** The app's supervisor, or null outside the desktop app (unit tests, the e2e harness, the web
 *  build), where the page runs its processes itself as before. */
export function jobSupervisor(): Promise<JobSupervisor | null> {
  current ??= (async () => {
    if (typeof window === "undefined" || !(window.__TAURI_INTERNALS__ ?? window.__TAURI__))
      return null;
    try {
      const sup = new TauriJobSupervisor();
      await sup.launchId(); // an app without the supervisor (an older shell) runs jobs in the page
      return sup;
    } catch {
      return null;
    }
  })();
  return current;
}

/** Tests only. */
export function __setJobSupervisor(sup: JobSupervisor | null): void {
  current = Promise.resolve(sup);
}

/** Tests only: back to detecting the app. */
export function __resetJobSupervisor(): void {
  current = null;
}

/** A runner whose first ffmpeg run becomes job `id` in the supervisor, so the process outlives
 *  the page; anything else (the ffprobe that checks the result) runs on `base` as usual. Resolves
 *  like the runner it replaces: when the process ends, with its code and output, or "cancelled"
 *  once `signal` aborts. If the page dies first, the next page finds the job by its id. */
export function supervisedRunner(
  base: CommandRunner,
  sup: JobSupervisor,
  job: { id: string; lane: string; meta: Record<string, unknown> },
): CommandRunner {
  let used = false;
  return {
    run(program, args, signal, cwd, onStdout) {
      if (program !== "ffmpeg" || used) return base.run(program, args, signal, cwd, onStdout);
      used = true;
      return runAsJob(
        sup,
        {
          id: job.id,
          lane: job.lane,
          program: "ffmpeg",
          args,
          cwd: cwd ?? null,
          // The scratch dir goes with the job: a page that commits it later has to remove it.
          meta: { ...job.meta, scratch: cwd ?? null },
        },
        signal,
        onStdout,
      );
    },
  };
}

/** Run `spec` as a job of the app process and resolve the way a CommandRunner reports a process:
 *  when it ends, with its code and output, or "cancelled" once `signal` aborts (the job is killed).
 *  If the page dies first, the job runs on, and the next page finds it by its id. */
export function runAsJob(
  sup: JobSupervisor,
  spec: JobSpec,
  signal?: AbortSignal,
  onStdout?: (chunk: string) => void,
): Promise<CommandResult> {
  if (signal?.aborted) return Promise.resolve({ code: -1, stdout: "", stderr: "cancelled" });
  return new Promise<CommandResult>((resolve) => {
    let done = false;
    const finish = (r: CommandResult) => {
      if (done) return;
      done = true;
      stop();
      signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const stop = sup.subscribe(
      (v) => {
        if (v.id === spec.id && v.state === "exited") finish(jobResult(v));
      },
      (id, chunk) => {
        if (id !== spec.id || !onStdout) return;
        try {
          onStdout(chunk);
        } catch {
          /* a progress consumer must never fail the job */
        }
      },
    );
    const onAbort = () => void sup.kill(spec.id).catch(() => undefined);
    signal?.addEventListener("abort", onAbort, { once: true });
    sup
      .submit(spec)
      .then(async () => {
        // Cancelled while the job was being handed over: the kill may have reached the
        // supervisor before the job did, so send it again now that the job exists.
        if (signal?.aborted) await sup.kill(spec.id).catch(() => false);
        // It may have ended before this page was listening for it.
        const now = (await sup.list()).find((v) => v.id === spec.id);
        if (now?.state === "exited") finish(jobResult(now));
      })
      .catch((e) =>
        finish({ code: -1, stdout: "", stderr: `could not start ${spec.program}: ${String(e)}` }),
      );
  });
}

/** Resolve with job `id` once it has ended (at once if it already has), or null when the app
 *  process does not have it. Shared by every page that follows a job it did not start. */
export function whenJobEnds(sup: JobSupervisor, id: string): Promise<JobView | null> {
  return new Promise((resolve) => {
    let done = false;
    const end = (v: JobView | null) => {
      if (done) return;
      done = true;
      stop();
      resolve(v);
    };
    const stop = sup.subscribe((v) => {
      if (v.id === id && v.state === "exited") end(v);
    });
    // It may have ended before this page was listening.
    void sup.list().then(
      (all) => {
        const now = all.find((v) => v.id === id);
        if (!now) end(null);
        else if (now.state === "exited") end(now);
      },
      () => end(null),
    );
  });
}
