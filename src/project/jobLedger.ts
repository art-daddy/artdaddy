// Durable record of work that outlives the turn that started it.
//
// ProjectJobScope tracks a job only while it is RUNNING in this process; nothing survives a
// switch, a quit, or a crash. Generation is paid for before it finishes, so a job the app forgot
// about is money spent with nothing to show and no way to tell the user what happened. This
// ledger gives every such job exactly one visible terminal state.
//
// The session stamp is the load-bearing part. "Reopen the project -> mark running jobs
// interrupted" is WRONG on its own: a project switch deliberately leaves generation running, so
// coming back would kill live work and report a false failure. A `running` record can only still
// be alive if it belongs to THIS app launch; one from any other launch cannot be, because its
// in-flight fetch died with that process.
import { INTERNAL_DIR, joinPath, type ProjectStoreAccess } from "../tools/store";

export type JobKind = "generation" | "export";
export type JobStatus = "running" | "done" | "failed" | "cancelled" | "interrupted";

export interface JobRecord {
  id: string;
  kind: JobKind;
  /** The contract tool that started it, e.g. "generate_video". */
  tool: string;
  /** Short human summary for the completion note ("a 5s video"). */
  label: string;
  status: JobStatus;
  /** Placeholder media ids this job resolves when it lands. */
  media_refs?: string[];
  error?: string;
  /** Bounded process output for diagnosing background failures after the originating turn ended. */
  stderr_tail?: string;
  started_at: number;
  ended_at?: number;
  session: string;
}

interface LedgerFile {
  version: 1;
  jobs: JobRecord[];
}

/** Identifies THIS app launch. Regenerated per process, so it can never match a record written
 *  by a previous one. */
export const APP_SESSION: string = newId();

/** Terminal records kept per project, newest first. Bounds the file; running jobs are never cut. */
const KEEP_TERMINAL = 50;

/** Built fresh per read: `readJson` hands the fallback back BY REFERENCE, so a shared constant
 *  would be mutated by the first `begin()` and leak into every later ledger. */
const emptyFile = (): LedgerFile => ({ version: 1, jobs: [] });

function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function jobsPath(projectDir: string): string {
  return joinPath(projectDir, INTERNAL_DIR, "jobs.json");
}

/** True for a record that claimed to be running but whose app launch is gone. */
function isOrphaned(r: JobRecord): boolean {
  return r.status === "running" && r.session !== APP_SESSION;
}

function isTerminal(r: JobRecord): boolean {
  return r.status !== "running";
}

/** The per-project ledger. Load it once when the project opens; every mutation persists. */
export class JobLedger {
  private records: JobRecord[] = [];
  /** Serializes writes so two jobs settling together cannot interleave read-modify-write. */
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(private readonly store: ProjectStoreAccess) {}

  /** Read the project's ledger and settle anything a previous launch left running. Returns the
   *  ledger; `interrupted()` reports what this reconciliation just closed out. */
  static async open(store: ProjectStoreAccess): Promise<JobLedger> {
    const ledger = new JobLedger(store);
    const file = await store.readJson<LedgerFile>(jobsPath(store.projectDir), emptyFile());
    const jobs = Array.isArray(file?.jobs) ? [...file.jobs] : [];
    let changed = false;
    for (const r of jobs) {
      if (!isOrphaned(r)) continue;
      r.status = "interrupted";
      r.ended_at = Date.now();
      r.error ??= "the app closed before this finished; it may still have been charged";
      changed = true;
    }
    ledger.records = jobs;
    if (changed) await ledger.persist();
    return ledger;
  }

  list(): readonly JobRecord[] {
    return this.records;
  }

  /** Records this open() just settled — what the user should be told about on reopen. */
  interrupted(): readonly JobRecord[] {
    return this.records.filter((r) => r.status === "interrupted");
  }

  running(): readonly JobRecord[] {
    return this.records.filter((r) => r.status === "running");
  }

  /** Register a job as running BEFORE the paid call goes out, so a crash mid-call still leaves a
   *  trace. Returns the record's id. */
  async begin(spec: {
    kind: JobKind;
    tool: string;
    label: string;
    media_refs?: string[];
  }): Promise<string> {
    const rec: JobRecord = {
      id: newId(),
      kind: spec.kind,
      tool: spec.tool,
      label: spec.label,
      status: "running",
      media_refs: spec.media_refs,
      started_at: Date.now(),
      session: APP_SESSION,
    };
    this.records.push(rec);
    await this.persist();
    return rec.id;
  }

  /** Settle a job. A record already terminal is left alone: a late completion must never
   *  reopen a job the reconciliation (or a Stop) already closed. */
  async settle(
    id: string,
    patch: {
      status: Exclude<JobStatus, "running">;
      error?: string;
      stderr_tail?: string;
      media_refs?: string[];
    },
  ): Promise<boolean> {
    const rec = this.records.find((r) => r.id === id);
    if (!rec || isTerminal(rec)) return false;
    rec.status = patch.status;
    rec.ended_at = Date.now();
    if (patch.error !== undefined) rec.error = patch.error;
    if (patch.stderr_tail !== undefined) rec.stderr_tail = patch.stderr_tail;
    if (patch.media_refs !== undefined) rec.media_refs = patch.media_refs;
    await this.persist();
    return true;
  }

  private persist(): Promise<unknown> {
    this.tail = this.tail.then(() => this.write()).catch(() => undefined);
    return this.tail;
  }

  private async write(): Promise<void> {
    const running = this.records.filter((r) => !isTerminal(r));
    const terminal = this.records
      .filter(isTerminal)
      .sort((a, b) => (b.ended_at ?? b.started_at) - (a.ended_at ?? a.started_at))
      .slice(0, KEEP_TERMINAL);
    this.records = [...running, ...terminal];
    const file: LedgerFile = { version: 1, jobs: this.records };
    await this.store.writeTextAtomic(
      jobsPath(this.store.projectDir),
      JSON.stringify(file, null, 2),
    );
  }
}
