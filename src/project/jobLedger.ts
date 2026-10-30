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
import { ArtDaddyError } from "../lib/errors";
import { INTERNAL_DIR, joinPath, type ProjectStoreAccess } from "../tools/store";

export type JobKind = "generation" | "export";
export type JobStatus = "running" | "done" | "failed" | "cancelled" | "interrupted";

/** The project's record of running work could not be written, so the work was not started. Nothing has been paid for: the paid call
 *  goes out only after its record is on disk, because a call whose record was lost cannot be found again if the app closes. */
export class JobRecordError extends ArtDaddyError {
  readonly code = "job_record_failed";
  constructor(readonly reason = "") {
    super(
      "This was not started, because the project could not save its record of running work (without it, a result could not be found " +
        "again if the app closed). Nothing was charged. Please try again, and use Report a problem if it keeps happening.",
    );
    this.name = "JobRecordError";
  }
}

/** The project's record of running work is there but cannot be read right now. Writing a fresh one over it would destroy the record
 *  of work that may already be paid for, so nothing new is started until it can be read. */
export class JobLedgerUnreadableError extends ArtDaddyError {
  readonly code = "job_record_unreadable";
  constructor(readonly reason = "") {
    super(
      "This was not started, because the project's record of running work cannot be read right now and starting something new could " +
        "overwrite it. Nothing was charged. Close and reopen the project, and use Report a problem if it keeps happening.",
    );
    this.name = "JobLedgerUnreadableError";
  }
}

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
  /** The order number of a generation the server may hold for us (the server's order desk). While the server has the order the job
   *  is never given up on, even when the launch that started it is gone: the next launch asks the server and collects the result. */
  order_id?: string;
  /** Whose generation it is, and the server it was sent to. An order belongs to the account that sent it, on that server: someone
   *  else (another sign-in, another server) who asks about it is told it does not exist, which says nothing about the order. */
  owner?: string;
  api?: string;
  /** Who asked: only "chat" wakes the conversation when the job lands, and that has to survive a restart. */
  started_by?: "chat" | "elsewhere";
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

/** True for a record that claimed to be running but whose app launch is gone. `alive` holds the
 *  sessions that can still own work: this page, and (in the app) the app process's run, which
 *  outlives a page reload and owns the exports (3h part 7). */
function isOrphaned(r: JobRecord, alive: ReadonlySet<string>): boolean {
  return r.status === "running" && !alive.has(r.session);
}

function isTerminal(r: JobRecord): boolean {
  return r.status !== "running";
}

/** What the ledger file holds, or why it cannot be read right now. A file that is missing is an empty ledger, and a corrupt one is set
 *  aside (its bytes kept) and read as empty, as every project file is; but one that cannot be read at all is NOT empty: whatever it
 *  holds may be the only record of paid work, so it must never be written over. */
async function readLedgerFile(
  store: ProjectStoreAccess,
): Promise<{ file: LedgerFile } | { unreadable: string }> {
  const path = jobsPath(store.projectDir);
  try {
    if (await store.exists(path)) await store.readText(path);
  } catch (e) {
    return { unreadable: e instanceof Error ? e.message : String(e) };
  }
  return { file: await store.readJson<LedgerFile>(path, emptyFile()) };
}

/** The per-project ledger. Load it once when the project opens; every mutation persists. */
export class JobLedger {
  private records: JobRecord[] = [];
  /** Order jobs of an earlier launch that this open() took over rather than gave up on. */
  private taken: JobRecord[] = [];
  /** Serializes writes so two jobs settling together cannot interleave read-modify-write. */
  private tail: Promise<unknown> = Promise.resolve();
  /** Why the file could not be read, while it is there and cannot be: nothing is written until it can be. */
  private unreadableBecause: string | null = null;

  private constructor(private readonly store: ProjectStoreAccess) {}

  /** Read the project's ledger and settle anything a previous launch left running. Returns the
   *  ledger; `interrupted()` reports what this reconciliation just closed out, and `adopted()` the
   *  generations it did NOT give up on because the server holds them as orders. */
  static async open(store: ProjectStoreAccess): Promise<JobLedger> {
    const ledger = new JobLedger(store);
    await ledger.load();
    return ledger;
  }

  private get unreadable(): boolean {
    return this.unreadableBecause !== null;
  }

  private async load(): Promise<void> {
    const read = await readLedgerFile(this.store);
    if ("unreadable" in read) {
      this.unreadableBecause = read.unreadable;
      return;
    }
    this.unreadableBecause = null;
    const file = read.file;
    const jobs = Array.isArray(file?.jobs) ? [...file.jobs] : [];
    const alive = new Set([APP_SESSION]);
    try {
      const { jobSupervisor } = await import("../tools/jobSupervisor");
      const sup = await jobSupervisor();
      if (sup) alive.add(await sup.launchId());
    } catch {
      /* no app process to ask: only this page's own records are alive */
    }
    let changed = false;
    for (const r of jobs) {
      if (!isOrphaned(r, alive)) continue;
      if (r.order_id) {
        // The in-flight fetch died with that launch, but the ORDER did not: the server has it (or its result). Take the job over
        // as this launch's own and let the caller ask the server; closing it out as "interrupted" would throw away a result
        // that has been paid for.
        r.session = APP_SESSION;
        this.taken.push(r);
        changed = true;
        continue;
      }
      r.status = "interrupted";
      r.ended_at = Date.now();
      r.error ??= "the app closed before this finished; it may still have been charged";
      changed = true;
    }
    this.records = jobs;
    if (changed) await this.persist();
  }

  list(): readonly JobRecord[] {
    return this.records;
  }

  /** Records this open() just settled — what the user should be told about on reopen. */
  interrupted(): readonly JobRecord[] {
    return this.records.filter((r) => r.status === "interrupted");
  }

  /** Order jobs this open() took over from an earlier launch: still running, and waiting for someone to ask the server. */
  adopted(): readonly JobRecord[] {
    return this.taken;
  }

  running(): readonly JobRecord[] {
    return this.records.filter((r) => r.status === "running");
  }

  /** False while the ledger file is there and cannot be read: nothing is known about what is running, so nothing may be concluded
   *  from what this ledger does not list. */
  get readable(): boolean {
    return !this.unreadable;
  }

  /** Why the file cannot be read, when it cannot. */
  get unreadableReason(): string {
    return this.unreadableBecause ?? "";
  }

  /** Register a job as running BEFORE the paid call goes out, so a crash mid-call still leaves a
   *  trace. Returns the record's id. The record is on disk when this returns, or this throws and the call must not go out: a call
   *  whose record was lost cannot be found again if the app closes (a ``JobRecordError``; ``JobLedgerUnreadableError`` when the
   *  file that holds the other jobs cannot be read, and must not be written over). */
  async begin(spec: {
    kind: JobKind;
    tool: string;
    label: string;
    media_refs?: string[];
    /** The session that owns the work, when it is not this page (an export the app process runs). */
    session?: string;
    /** The order number the generation is sent under, so a later launch can ask the server for it. */
    order_id?: string;
    /** Who sent it, and to which server (see JobRecord). */
    owner?: string;
    api?: string;
    started_by?: "chat" | "elsewhere";
  }): Promise<string> {
    if (this.unreadable) await this.load(); // a lock that has cleared needs no restart
    if (this.unreadable) throw new JobLedgerUnreadableError(this.unreadableReason);
    const rec: JobRecord = {
      id: newId(),
      kind: spec.kind,
      tool: spec.tool,
      label: spec.label,
      status: "running",
      media_refs: spec.media_refs,
      ...(spec.order_id ? { order_id: spec.order_id } : {}),
      ...(spec.owner ? { owner: spec.owner } : {}),
      ...(spec.api ? { api: spec.api } : {}),
      ...(spec.started_by ? { started_by: spec.started_by } : {}),
      started_at: Date.now(),
      session: spec.session ?? APP_SESSION,
    };
    this.records.push(rec);
    try {
      await this.persist(true);
    } catch (e) {
      this.records = this.records.filter((r) => r !== rec);
      throw new JobRecordError(e instanceof Error ? e.message : String(e));
    }
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

  /** Write the whole ledger, after the writes already queued. A failure is the caller's to see only when it asks (``strict``): the end
   *  of a job is best effort (the next write carries it), the start of one is not (see ``begin``). */
  private persist(strict = false): Promise<void> {
    const run = this.tail.then(() => this.write());
    this.tail = run.catch(() => undefined);
    return strict ? run : this.tail.then(() => undefined);
  }

  private async write(): Promise<void> {
    if (this.unreadable) throw new JobLedgerUnreadableError(this.unreadableReason);
    const running = this.records.filter((r) => !isTerminal(r));
    const terminal = this.records
      .filter(isTerminal)
      .sort((a, b) => (b.ended_at ?? b.started_at) - (a.ended_at ?? a.started_at))
      .slice(0, KEEP_TERMINAL);
    this.records = [...running, ...terminal];
    const file: LedgerFile = { version: 1, jobs: this.records };
    const saved = await this.store.writeTextAtomic(
      jobsPath(this.store.projectDir),
      JSON.stringify(file, null, 2),
    );
    if (!saved)
      throw new Error("the project closed before its record of running work could be written");
  }
}
