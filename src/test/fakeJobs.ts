// An in-memory stand-in for the app process's job supervisor (src-tauri/src/jobs.rs), with the
// same rules its Rust tests pin: one job per lane at a time, in order; Cancel ends a queued job
// before it starts and kills a running one; commit and forget only after the job ended. A test
// plays the process: it decides what a started job writes, prints and exits with.
import {
  JOB_PROGRAMS,
  type JobSpec,
  type JobSupervisor,
  type JobView,
} from "../tools/jobSupervisor";

export class FakeJobs implements JobSupervisor {
  readonly submitted: JobSpec[] = [];
  /** Jobs whose process was started, in order. */
  readonly started: string[] = [];
  readonly killed: string[] = [];
  readonly committed: string[] = [];
  readonly forgotten: string[] = [];
  /** Called when a job starts, as the process would: write its output file here. */
  onStart: (spec: JobSpec) => void | Promise<void> = () => {};
  /** Take a moment to accept a job, as an IPC round trip does. */
  slowSubmit = false;
  private readonly jobs = new Map<string, JobView>();
  private readonly order: string[] = [];
  private readonly lanes = new Map<string, { running: string | null; queue: string[] }>();
  private readonly changeFns = new Set<(v: JobView) => void>();
  private readonly stdoutFns = new Set<(id: string, chunk: string) => void>();

  constructor(readonly launch = "launch-test") {}

  private emit(id: string): void {
    const v = this.jobs.get(id);
    if (!v) return;
    for (const fn of [...this.changeFns]) fn({ ...v });
  }

  private pump(lane: string): void {
    const l = this.lanes.get(lane);
    if (!l || l.running) return;
    const id = l.queue.shift();
    if (!id) return;
    l.running = id;
    this.started.push(id);
    const v = this.jobs.get(id)!;
    v.state = "running";
    v.started_at = Date.now();
    this.emit(id);
    void this.onStart(this.submitted.find((s) => s.id === id)!);
  }

  async submit(spec: JobSpec): Promise<number> {
    if (this.slowSubmit) await new Promise((r) => setTimeout(r, 0));
    if (!(JOB_PROGRAMS as readonly string[]).includes(spec.program))
      throw new Error(`'${spec.program}' cannot be run as a job`);
    if (this.jobs.has(spec.id)) throw new Error(`job ${spec.id} already exists`);
    this.submitted.push(spec);
    const l = this.lanes.get(spec.lane) ?? { running: null, queue: [] };
    this.lanes.set(spec.lane, l);
    const position = l.queue.length + (l.running ? 1 : 0);
    l.queue.push(spec.id);
    this.order.push(spec.id);
    this.jobs.set(spec.id, {
      id: spec.id,
      lane: spec.lane,
      state: "queued",
      code: null,
      killed: false,
      committed: false,
      meta: spec.meta,
      stdout_tail: "",
      stderr_head: "",
      stderr_elided: 0,
      stderr_tail: "",
      queued_at: Date.now(),
      started_at: null,
      ended_at: null,
    });
    this.emit(spec.id);
    this.pump(spec.lane);
    return position;
  }

  /** The process prints to stdout. */
  stdout(id: string, chunk: string): void {
    const v = this.jobs.get(id)!;
    v.stdout_tail += chunk;
    for (const fn of [...this.stdoutFns]) fn(id, chunk);
  }

  /** The process exits. */
  exit(id: string, code: number | null, stderr = ""): void {
    const v = this.jobs.get(id);
    if (!v || v.state === "exited") return;
    v.state = "exited";
    v.code = code;
    v.stderr_head = stderr;
    v.ended_at = Date.now();
    const l = this.lanes.get(v.lane);
    if (l?.running === id) l.running = null;
    this.emit(id);
    this.pump(v.lane);
  }

  async kill(id: string): Promise<boolean> {
    const v = this.jobs.get(id);
    if (!v || v.state === "exited") return false;
    this.killed.push(id);
    v.killed = true;
    if (v.state === "queued") {
      const l = this.lanes.get(v.lane);
      if (l) l.queue = l.queue.filter((q) => q !== id);
      v.state = "exited";
      v.ended_at = Date.now();
      this.emit(id);
    } else {
      // A killed process exits non-zero, a moment later.
      queueMicrotask(() => this.exit(id, 255));
    }
    return true;
  }

  async list(): Promise<JobView[]> {
    return this.order.flatMap((id) => {
      const v = this.jobs.get(id);
      return v ? [{ ...v }] : [];
    });
  }

  async commit(id: string): Promise<boolean> {
    const v = this.jobs.get(id);
    if (!v || v.state !== "exited") return false;
    v.committed = true;
    this.committed.push(id);
    this.emit(id);
    return true;
  }

  async forget(id: string): Promise<boolean> {
    const v = this.jobs.get(id);
    if (!v || v.state !== "exited") return false;
    this.jobs.delete(id);
    this.forgotten.push(id);
    return true;
  }

  async launchId(): Promise<string> {
    return this.launch;
  }

  subscribe(
    onChange: (v: JobView) => void,
    onStdout?: (id: string, chunk: string) => void,
  ): () => void {
    this.changeFns.add(onChange);
    if (onStdout) this.stdoutFns.add(onStdout);
    return () => {
      this.changeFns.delete(onChange);
      if (onStdout) this.stdoutFns.delete(onStdout);
    };
  }

  view(id: string): JobView | undefined {
    const v = this.jobs.get(id);
    return v ? { ...v } : undefined;
  }

  /** The page is gone: nothing it was listening with hears anything again. The jobs go on. */
  pageDied(): void {
    this.changeFns.clear();
    this.stdoutFns.clear();
  }
}
