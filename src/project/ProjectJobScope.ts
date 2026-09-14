import { ProjectClosingError } from "./MutationGate";

/** How a running job reacts when the project closes:
 *  - cancelOnClose (default): aborted; close does not wait (downloads, model calls, probing,
 *    proxying, transcription, indexing).
 *  - finishBeforeClose: NOT aborted; close waits for it (a short final package commit already
 *    admitted — never unbounded network/render work).
 *  - resumable: aborted/detached after the caller persists a durable resume id; close does not
 *    wait; reopen may resume (cloud generation). */
export type ProjectJobPolicy = "cancelOnClose" | "finishBeforeClose" | "resumable";

export type ProjectJobState = "running" | "completed" | "failed" | "cancelled" | "resumable";

export interface ProjectJobSpec {
  /** A stable job kind, e.g. "media.import", "index.sweep". */
  readonly kind: string;
  /** Defaults to cancelOnClose. */
  readonly policy?: ProjectJobPolicy;
}

export interface ProjectJobStatus {
  readonly id: string;
  readonly kind: string;
  readonly policy: ProjectJobPolicy;
  readonly state: ProjectJobState;
}

interface Job {
  readonly id: string;
  readonly kind: string;
  readonly policy: ProjectJobPolicy;
  state: ProjectJobState;
  readonly controller: AbortController;
}

/** The owner of a document's long-running work. Every download/render/probe/index runs here with
 *  a policy + an AbortSignal + a terminal state, so `close` can SEE all of it and cancel/await it
 *  deterministically — clearing a queue is not enough; the job itself must stop. */
export class ProjectJobScope {
  private closing = false;
  private seq = 0;
  private closePromise: Promise<void> | null = null;
  private readonly jobs = new Map<string, Job>();
  private readonly idleWaiters: Array<() => void> = [];

  /** Run `work` as a tracked job. `work` receives an AbortSignal it MUST honor for cancellation
   *  to be real. Rejects immediately if the project is already closing. */
  async run<T>(spec: ProjectJobSpec, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closing)
      throw new ProjectClosingError(`cannot start ${spec.kind}: the project is closing`);
    const id = `job-${++this.seq}`;
    const policy = spec.policy ?? "cancelOnClose";
    const job: Job = {
      id,
      kind: spec.kind,
      policy,
      state: "running",
      controller: new AbortController(),
    };
    this.jobs.set(id, job);
    try {
      const result = await work(job.controller.signal);
      job.state = job.controller.signal.aborted ? terminalOnAbort(policy) : "completed";
      return result;
    } catch (e) {
      job.state = job.controller.signal.aborted ? terminalOnAbort(policy) : "failed";
      throw e;
    } finally {
      this.jobs.delete(id);
      this.notifyIdle();
    }
  }

  /** Abort a specific running job. */
  cancel(id: string): void {
    this.jobs.get(id)?.controller.abort();
  }

  /** Close admission, cancel/detach every job that must not block close (cancelOnClose +
   *  resumable), and resolve once the finishBeforeClose jobs have settled. Idempotent. */
  beginClose(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    for (const job of this.jobs.values()) {
      if (job.policy !== "finishBeforeClose") job.controller.abort();
    }
    this.closePromise = this.waitForIdle();
    return this.closePromise;
  }

  /** Resolve once no close-blocking (finishBeforeClose) job remains. */
  waitForIdle(): Promise<void> {
    if (!this.hasBlocking()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  list(): readonly ProjectJobStatus[] {
    return [...this.jobs.values()].map((j) => ({
      id: j.id,
      kind: j.kind,
      policy: j.policy,
      state: j.state,
    }));
  }

  private hasBlocking(): boolean {
    for (const job of this.jobs.values()) if (job.policy === "finishBeforeClose") return true;
    return false;
  }

  private notifyIdle(): void {
    if (this.hasBlocking()) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
}

function terminalOnAbort(policy: ProjectJobPolicy): ProjectJobState {
  return policy === "resumable" ? "resumable" : "cancelled";
}
