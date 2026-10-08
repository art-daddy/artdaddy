// Exports run in the background, one at a time.
//
// An export is minutes of ffmpeg, and blocking the turn on it froze the whole conversation —
// there is no other way to export, so the user could not even ask a question while waiting.
// other NLEs' ExportQueue is the reference: enqueue, return a job id, notify on completion.
//
// Three rules, and none of them is about the timeline. The render already snapshots that
// (prepareRender loads timeline.json once, before any encoding), so a later edit cannot reach
// a running export:
//
//   single file  - ffmpeg writes to a staging sibling and the finished file is RENAMED into
//                  place. A crash, a quit or a failure therefore never leaves a half-encoded
//                  video where the user expects a finished one, and never destroys the previous
//                  export at that path.
//   single flight- one encode at a time. Two concurrent ffmpegs fight for the same cores and
//                  both take longer than running them in sequence.
//   one owner    - a destination already queued is REFUSED rather than raced, so two exports
//                  cannot interleave writes to one path.
import { openProjectJobs } from "../tools/genJobs";
import type { ProjectStoreAccess } from "../tools/store";
import type { ClientToolContext } from "../tools/context";
import { jobResult, jobSupervisor, type JobSupervisor, type JobView } from "../tools/jobSupervisor";
import type { MutationOrigin } from "../project/MutationGate";
import { notifyJobSettled, type SettledJob } from "../store/jobNotes";
import { useExportJob } from "../store/exportJob";
import { beginSessionActivity } from "../observability/crashWatch";
import { createProgressReader, etaSeconds, progressFraction } from "./ffmpegProgress";
import { recordStaging, releaseStaging } from "./exportStaging";
import { setExportsBusy } from "../tools/workGate";

/** Destinations with an export queued or running, so a second one is refused rather than raced. */
const reserved = new Set<string>();

/** Serializes encodes across every project in the process. */
let queueTail: Promise<unknown> = Promise.resolve();

/** Serializes copies. Their own lane: a copy is disk work, and must not wait behind an encode. */
let copyTail: Promise<unknown> = Promise.resolve();

/** Export calls that deliver several files: the agent is woken once, after the last one settles. */
const batches = new Map<
  string,
  { open: number; sealed: boolean; notes: Array<[string, SettledJob]> }
>();

function batchOf(id: string) {
  let b = batches.get(id);
  if (!b) {
    b = { open: 0, sealed: false, notes: [] };
    batches.set(id, b);
  }
  return b;
}

/** Every file of the call is queued: its one wake may go once the last of them settles. */
export function sealExportBatch(id: string): void {
  batchOf(id).sealed = true;
  flushBatch(id);
}

function flushBatch(id: string): void {
  const b = batches.get(id);
  if (!b || !b.sealed || b.open > 0) return;
  batches.delete(id);
  for (const [dir, job] of b.notes) notifyJobSettled(dir, job);
}

/** In-flight exports, awaited by {@link whenExportsSettle}. */
const inflight = new Set<Promise<unknown>>();

/** Per-job cancellation. Making the export outlive its turn removed the only way to stop one —
 *  the turn's own abort — so the queue owns that now. */
const controllers = new Map<string, AbortController>();

export interface QueuedExport {
  job_id: string;
  filename: string;
  state: "running" | "queued";
}

export type ExportState = "queued" | "running" | "done" | "failed" | "cancelled";

/** One row of the export list. Kept AFTER the job settles, which the queue itself did not do:
 *  `controllers` is cleared on settle, so a finished or failed export vanished the instant it
 *  ended and the only record left was a toast. A user who looked away learned nothing. */
export interface ExportRecord {
  job_id: string;
  filename: string;
  /** Final destination, so a finished row can be revealed on disk. */
  destPath: string;
  state: ExportState;
  error?: string;
  /** Process diagnostics kept separate from the user-facing summary. */
  stderrTail?: string;
  warnings?: string[];
  /** Library ref for the delivered file, so it can be inspected like any other asset. */
  mediaRef?: string;
  startedAt: number;
  endedAt?: number;
}

/** Bounded like the persisted ledger's terminal set: this is a session view, not an archive. */
const KEEP_TERMINAL = 50;
const records: ExportRecord[] = [];
const listeners = new Set<() => void>();
// A snapshot rebuilt on every change, because `records` is mutated in place: a subscriber that
// compared the array's identity would never see an update.
let snapshot: readonly ExportRecord[] = [];

function changed(): void {
  snapshot = records.map((r) => ({ ...r }));
  // The indexer starts nothing while an export is queued or running (workGate.ts).
  setExportsBusy(records.some((r) => r.state === "running" || r.state === "queued"));
  for (const fn of listeners) fn();
}

function patch(jobId: string, next: Partial<ExportRecord>): void {
  const r = records.find((x) => x.job_id === jobId);
  if (!r) return;
  Object.assign(r, next);
  changed();
}

/** Every export this session, oldest first. Terminal rows stay until dismissed. */
export function listExportRecords(): readonly ExportRecord[] {
  return snapshot;
}

/** Notify on any queue change. Returns the unsubscribe. */
export function subscribeExports(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Resolve when this job stops running. `submitExport` returns the moment the render is QUEUED,
 *  so a caller that treats that answer as the finish reports 100% while ffmpeg is still going —
 *  and the progress the renderer pushes afterwards is dropped, because the job store ignores
 *  updates once the phase leaves `rendering`. Null means the job is not in the queue, which the
 *  caller must not read as success. */
export function whenExportEnds(jobId: string): Promise<ExportRecord | null> {
  const settled = (r: ExportRecord | undefined) =>
    r && r.state !== "queued" && r.state !== "running" ? r : null;
  const now = records.find((x) => x.job_id === jobId);
  if (!now) return Promise.resolve(null);
  const already = settled(now);
  if (already) return Promise.resolve({ ...already });

  return new Promise((resolve) => {
    const stop = subscribeExports(() => {
      const done = settled(records.find((x) => x.job_id === jobId));
      if (!done) return;
      stop();
      resolve({ ...done });
    });
  });
}

/** Drop a SETTLED row. A running one is left alone — cancel it first. */
export function dismissExport(jobId: string): boolean {
  const i = records.findIndex((x) => x.job_id === jobId);
  if (i < 0 || records[i].state === "running" || records[i].state === "queued") return false;
  records.splice(i, 1);
  changed();
  return true;
}

/** Drop every settled row. */
export function clearFinishedExports(): void {
  for (let i = records.length - 1; i >= 0; i--) {
    const s = records[i].state;
    if (s !== "running" && s !== "queued") records.splice(i, 1);
  }
  changed();
}

/** Exports not yet finished, oldest first. In-flight view only — see {@link listExportRecords}
 *  for the one that includes outcomes. */
export function listExports(): QueuedExport[] {
  const out: QueuedExport[] = [];
  for (const r of records) {
    if (r.state === "running" || r.state === "queued")
      out.push({ job_id: r.job_id, filename: r.filename, state: r.state });
  }
  return out;
}

/** What `manage_exports action='list'` answers with: every export this session, INCLUDING the
 *  settled ones and why a failed one failed.
 *
 *  The queue keeps terminal rows precisely so an outcome survives the job (see `ExportRecord`),
 *  but this tool — the only route an agent has to an async export's fate — was reading the
 *  in-flight view, so a FAILED export vanished the instant it ended and `list` answered `[]`.
 *  Indistinguishable from "it worked", which is the reading an agent takes. The path is omitted
 *  for the same reason `export` answers with `saved_to: <filename>`: it is the user's private
 *  directory, and media is never addressed by path here. */
export function listExportOutcomes(): Array<Record<string, unknown>> {
  return records.map((r) => ({
    job_id: r.job_id,
    filename: r.filename,
    state: r.state,
    ...(r.mediaRef ? { media_ref: r.mediaRef } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.warnings?.length ? { warnings: r.warnings } : {}),
    ...(r.endedAt ? { duration_s: Math.round((r.endedAt - r.startedAt) / 100) / 10 } : {}),
  }));
}

/** Stop an export. Returns false when it already finished — a settled job cannot be recalled. */
export function cancelExport(jobId: string): boolean {
  const c = controllers.get(jobId);
  if (!c) return false;
  c.abort();
  return true;
}

/** Why a cancel found nothing to stop, by how the export had already ended. */
const NOTHING_TO_CANCEL: Partial<Record<ExportState, string>> = {
  done: "that export had already finished; nothing to cancel",
  failed: "that export had already failed; nothing to cancel",
  cancelled: "that export was already cancelled",
};

/** manage_exports: the only route to cancellation. Without it an async export could be started
 *  and never stopped, which is a capability the synchronous version had. */
export async function manageExportsTool(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const action = String(args.action ?? "list").trim() || "list";
  if (action === "list") return { ok: true, exports: listExportOutcomes() };
  if (action !== "cancel")
    return { ok: false, error: `unknown action '${action}'; use 'list' or 'cancel'` };

  const jobId = String(args.job_id ?? "").trim();
  if (!jobId) return { ok: false, error: "job_id is required to cancel an export" };
  if (cancelExport(jobId)) return { ok: true, cancelled: true };
  const record = records.find((r) => r.job_id === jobId);
  if (!record)
    return {
      ok: false,
      error: `no export with job_id '${jobId}' in this session; manage_exports action='list' shows them`,
    };
  // Not an error: the export ended before the request arrived. Say HOW it ended — "finished" for
  // a run that was cancelled or failed told the agent a file was delivered when none was (QA
  // 2026-10-07), and "failed" for one sitting on disk would send it hunting for a fault.
  const note = NOTHING_TO_CANCEL[record.state];
  return { ok: true, cancelled: false, state: record.state, ...(note ? { note } : {}) };
}

export interface ExportSubmission {
  job_id: string;
  /** How many exports are ahead of this one. 0 means it starts immediately. */
  queue_position: number;
}

export interface ExportSpec {
  store: ProjectStoreAccess;
  /** Final destination. Reserved until the job settles. */
  destPath: string;
  /** Where the encode actually writes. Chosen by the caller, because the ffmpeg plan is built
   *  against it before the job is queued. Equal to destPath when the fs cannot rename. */
  stagePath: string;
  /** Filename shown to the user and the model; never the full path. */
  filename: string;
  /** The chat execution that asked for this export, when THIS CHAT asked. The Export menu and an
   *  external MCP agent run the SAME tool (deliberately — one renderer), so this is the only thing
   *  that tells them apart, and it decides whether finishing resumes the conversation. */
  origin?: MutationOrigin;
  /** What is being delivered, for the export metric. Describes the PLANNED artifact, so it is
   *  still reportable when the encode fails and no file exists to measure. */
  meta?: {
    duration_s: number;
    width: number;
    height: number;
    fps: number;
    quality: string;
    project_id: string;
  };
  /** The app process's job supervisor, when the encode runs as one of its jobs (3h part 7). It
   *  keeps the order then, so this queue does not hold a job back, and a job's state comes from it. */
  supervisor?: JobSupervisor;
  /** A library file delivered as it is: no encode, no export metric, and the delivered row names
   *  this library ref rather than cataloguing the same bytes a second time. */
  copyOf?: string;
  /** The export call this job is one file of (see {@link sealExportBatch}). */
  batch?: string;
  /** Runs the encode. Rejects with a message on failure. `jobId` names the job everywhere: the
   *  ledger, this queue and the supervisor. */
  run: (signal: AbortSignal, jobId: string) => Promise<{ warnings?: string[] }>;
}

/** A background encode failed after producing process diagnostics. Keeping this typed prevents
 *  the queue from flattening stderr into a generic message before it reaches the durable ledger. */
export class ExportRunError extends Error {
  constructor(
    message: string,
    readonly stderrTail?: string,
  ) {
    super(message);
    this.name = "ExportRunError";
  }
}

export function isDestinationReserved(destPath: string): boolean {
  return reserved.has(normalizeDest(destPath));
}

function normalizeDest(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Publish a delivered export into the library, LINKED in place. Never fatal: the file is already
 *  on disk and the user has it, so a catalog failure must not turn a good export into a failed one.
 *  Committed WITHOUT the asking turn's origin: the export belongs to the queue (UJ-022), so it is
 *  catalogued even when it finishes after that turn was stopped or retired by the next message,
 *  which the gate's origin fence would refuse. The close fence still applies. */
async function registerExportInLibrary(
  store: ProjectStoreAccess,
  spec: Pick<ExportSpec, "destPath" | "filename">,
): Promise<string | null> {
  try {
    const { registerLibraryClip, stageByPath } = await import("../tools/import");
    const src = store.canStreamImport
      ? await stageByPath(store, spec.destPath, false)
      : await store.readBytes(spec.destPath);
    const entry = await registerLibraryClip(
      store,
      src,
      spec.filename,
      "video",
      { kind: "export", job_id: spec.filename },
      spec.destPath,
    );
    return entry.id;
  } catch {
    return null;
  }
}

/** Resolve once every export started in this process has settled (tests and a deliberate drain). */ export async function whenExportsSettle(): Promise<void> {
  while (inflight.size) await Promise.allSettled([...inflight]);
}

/** In-flight export metrics. Separate from `inflight` on purpose — see the call site. */
const beacons = new Set<Promise<void>>();

/** Tests only. The metric is fire-and-forget in production, so this is the only way to observe
 *  it without making the assertion race the network. */
export async function whenExportTelemetrySettles(): Promise<void> {
  while (beacons.size) await Promise.allSettled([...beacons]);
}

/** Report one settled export to the server's analytics. Fire-and-forget by contract: the file is
 *  already delivered, so nothing here may fail, delay or alter the export. */
async function reportSettledExport(
  spec: Pick<ExportSpec, "store" | "destPath" | "meta">,
  outcome: {
    status: "done" | "failed" | "cancelled";
    elapsedMs: number;
    warnings: number;
    error: string;
  },
): Promise<void> {
  try {
    // Only a delivered file has a size; a failed encode leaves nothing to measure.
    const size = outcome.status === "done" ? ((await spec.store.byteSize(spec.destPath)) ?? 0) : 0;
    const { reportExport } = await import("../api/exportEvents");
    await reportExport({
      status: outcome.status,
      duration_s: spec.meta?.duration_s ?? 0,
      size_bytes: size,
      elapsed_ms: outcome.elapsedMs,
      width: spec.meta?.width ?? 0,
      height: spec.meta?.height ?? 0,
      fps: spec.meta?.fps ?? 0,
      quality: spec.meta?.quality ?? "",
      warnings: outcome.warnings,
      error: outcome.error,
      project_id: spec.meta?.project_id ?? "",
    });
  } catch {
    /* telemetry is never worth disturbing a finished export over */
  }
}

/** Tests only. */
export function __resetExportQueue(): void {
  reserved.clear();
  inflight.clear();
  beacons.clear();
  controllers.clear();
  records.length = 0;
  snapshot = [];
  setExportsBusy(false);
  listeners.clear();
  queueTail = Promise.resolve();
  copyTail = Promise.resolve();
  batches.clear();
}

/** Record the job, queue the encode, and return immediately. */
export async function submitExport(spec: ExportSpec): Promise<ExportSubmission> {
  const key = normalizeDest(spec.destPath);
  const ledger = await openProjectJobs(spec.store);
  // A supervised export lives as long as the app does, not the page: its record says so, or the
  // next page's ledger would call it interrupted while it is still running (jobLedger.ts).
  const session = spec.supervisor
    ? await spec.supervisor.launchId().catch(() => undefined)
    : undefined;
  const jobId = await ledger.begin({
    kind: "export",
    tool: "export",
    label: `the export ${spec.filename}`,
    ...(session ? { session } : {}),
  });
  reserved.add(key);
  controllers.set(jobId, new AbortController());
  if (spec.batch) batchOf(spec.batch).open++;
  const queuePosition = Math.max(0, reserved.size - 1);
  records.push({
    job_id: jobId,
    filename: spec.filename,
    destPath: spec.destPath,
    state: queuePosition === 0 ? "running" : "queued",
    startedAt: Date.now(),
  });
  // Terminal rows are trimmed on ADMISSION rather than on settle, so a long session cannot grow
  // the list without bound while still keeping every finished export the user can currently see.
  let terminal = records.filter((r) => r.state !== "running" && r.state !== "queued").length;
  for (let i = 0; i < records.length && terminal > KEEP_TERMINAL; i++) {
    const s = records[i].state;
    if (s !== "running" && s !== "queued") {
      records.splice(i--, 1);
      terminal--;
    }
  }
  changed();

  // The supervisor runs one export at a time itself, and keeps doing so with no page attached; in
  // the page alone, this queue does.
  const task = spec.supervisor
    ? encode(spec, ledger, jobId, key)
    : spec.copyOf
      ? (copyTail = copyTail.then(() => encode(spec, ledger, jobId, key)))
      : (queueTail = queueTail.then(() => encode(spec, ledger, jobId, key)));
  track(task);
  return { job_id: jobId, queue_position: queuePosition };
}

function track(task: Promise<unknown>): void {
  inflight.add(task);
  void task.finally(() => inflight.delete(task));
}

type Ledger = Awaited<ReturnType<typeof openProjectJobs>>;

/** How a run ended, before its file is committed. */
interface RunOutcome {
  error: string | null;
  cancelled: boolean;
  stderrTail?: string;
  warnings: string[];
}

async function encode(spec: ExportSpec, ledger: Ledger, jobId: string, key: string): Promise<void> {
  const startedAt = Date.now();
  const staged = spec.stagePath !== spec.destPath;
  const signal = controllers.get(jobId)?.signal ?? new AbortController().signal;

  const run: RunOutcome = { error: null, cancelled: false, warnings: [] };
  let finishActivity: (() => void) | null = null;
  let unfollow: (() => void) | undefined;
  try {
    // Cancelled while still queued: never start an encode nobody is waiting for.
    if (signal.aborted) throw new Error("export cancelled");
    if (spec.supervisor)
      unfollow = spec.supervisor.subscribe((v) => {
        if (v.id === jobId && v.state === "running") patch(jobId, { state: "running" });
      });
    else patch(jobId, { state: "running" });
    // An encode is the heaviest thing the app does and the likeliest moment to be killed for
    // memory; if the process dies here the crash marker will say so.
    finishActivity = beginSessionActivity("export");
    // Listed until it is renamed into place or removed, so a partial a crash or a quit leaves
    // behind is removed at the next launch (exportStaging.ts).
    if (staged) await recordStaging(spec.stagePath);
    run.warnings = (await spec.run(signal, jobId)).warnings ?? [];
    if (signal.aborted) throw new Error("export cancelled");
  } catch (e) {
    // A killed ffmpeg reports its own confusing error; the reason the user needs is the cancel.
    run.cancelled = signal.aborted;
    run.error = run.cancelled ? "export cancelled" : e instanceof Error ? e.message : String(e);
    if (!run.cancelled && e instanceof ExportRunError) run.stderrTail = e.stderrTail;
  } finally {
    unfollow?.();
    finishActivity?.();
  }
  await settle({
    jobId,
    key,
    store: spec.store,
    destPath: spec.destPath,
    stagePath: spec.stagePath,
    filename: spec.filename,
    meta: spec.meta,
    startedBy: spec.origin ? "chat" : "elsewhere",
    startedAt,
    ledger,
    supervisor: spec.supervisor,
    copyOf: spec.copyOf,
    batch: spec.batch,
    run,
  });
}

interface Settle {
  jobId: string;
  key: string;
  store: ProjectStoreAccess;
  destPath: string;
  stagePath: string;
  filename: string;
  meta?: ExportSpec["meta"];
  startedBy: "chat" | "elsewhere";
  startedAt: number;
  ledger: Ledger;
  supervisor?: JobSupervisor;
  copyOf?: string;
  batch?: string;
  run: RunOutcome;
}

/** Commit the file, then the project's records. The one path for an export this page ran and for
 *  one it adopted after a crash of the page, so both end exactly the same way. */
async function settle(x: Settle): Promise<void> {
  // Committing by rename keeps the destination either untouched or complete. When the fs cannot
  // rename, the caller already pointed the encode at the destination and there is nothing to move.
  const staged = x.stagePath !== x.destPath;
  let { error } = x.run;
  const { cancelled, stderrTail, warnings } = x.run;
  if (!error && staged) {
    try {
      // A page that renamed it and died before telling the supervisor left it already in place.
      const alreadyMoved =
        !(await x.store.exists(x.stagePath)) && (await x.store.exists(x.destPath));
      if (!alreadyMoved) await x.store.rename(x.stagePath, x.destPath);
      await releaseStaging(x.stagePath);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  // Never leave a partial file where a finished export belongs. One that cannot be removed now
  // stays listed, for the next launch to remove.
  if (error && staged) {
    await x.store.remove(x.stagePath).then(
      () => releaseStaging(x.stagePath),
      () => undefined,
    );
  }
  // From here a page that takes over must not touch the file again.
  await x.supervisor?.commit(x.jobId).catch(() => false);
  reserved.delete(x.key);
  controllers.delete(x.jobId);
  patch(x.jobId, {
    state: error ? (cancelled ? "cancelled" : "failed") : "done",
    endedAt: Date.now(),
    ...(error && !cancelled ? { error } : {}),
    ...(stderrTail ? { stderrTail } : {}),
    ...(warnings.length ? { warnings } : {}),
  });

  // The delivered file enters the library like any other asset, so the ONE thing an agent could
  // not do was look at what it had actually shipped: `inspect_timeline` inspects the timeline, and
  // the export was reachable only by a filesystem path, which is not an address this product has.
  // Linked, never copied — the destination is often outside the project and can be hundreds of MB.
  // A cancelled run sets `error`, so nothing half-written is ever catalogued. A copy of a library
  // file is that file's bytes, so it is that file's ref.
  const mediaRef = error ? null : (x.copyOf ?? (await registerExportInLibrary(x.store, x)));
  if (mediaRef) patch(x.jobId, { mediaRef });

  await x.ledger.settle(
    x.jobId,
    error
      ? {
          status: cancelled ? "cancelled" : "failed",
          error,
          ...(stderrTail ? { stderr_tail: stderrTail } : {}),
        }
      : { status: "done" },
  );
  // Reported from HERE rather than from the export tool: the tool returns as soon as the job is
  // QUEUED, so anything measured there would describe an encode that had not happened yet. This
  // is also the one place every door ends up — menu, agent and MCP all queue through submitExport.
  //
  // Deliberately NOT in `inflight`: that set is what a drain on quit waits for, and making
  // someone's app hang on a telemetry socket to save a metric row is the wrong trade.
  // A copy is not an encode: counting it would dilute the export failure rate it exists to show.
  if (!x.copyOf) {
    const beacon = reportSettledExport(x, {
      status: error ? (cancelled ? "cancelled" : "failed") : "done",
      elapsedMs: Date.now() - x.startedAt,
      warnings: warnings.length,
      error: error && !cancelled ? error : "",
    });
    beacons.add(beacon);
    void beacon.finally(() => beacons.delete(beacon));
  }
  await x.supervisor?.forget(x.jobId).catch(() => false);
  const note = warnings.length
    ? `saved as ${x.filename} (${warnings.length} warning${warnings.length > 1 ? "s" : ""}: ${warnings.join("; ")})`
    : `saved as ${x.filename}`;
  const settled: SettledJob | null = cancelled
    ? null
    : {
        id: x.jobId,
        tool: "export",
        label: `the export ${x.filename}`,
        status: error ? "failed" : "done",
        startedBy: x.startedBy,
        ...(error ? { error } : { detail: note }),
      };
  if (x.batch) {
    const b = batchOf(x.batch);
    b.open--;
    if (settled) b.notes.push([x.store.projectDir, settled]);
    flushBatch(x.batch);
  } else if (settled) notifyJobSettled(x.store.projectDir, settled);
}

/** What render.ts gives an export job, for a page that did not start it. */
interface ExportJobMeta {
  kind: "export";
  projectDir: string;
  destPath: string;
  stagePath: string;
  filename: string;
  startedBy: "chat" | "elsewhere";
  submittedAt: number;
  plan: import("./render").ExportJobPlan;
  telemetry?: ExportSpec["meta"];
  scratch?: string | null;
}

function exportMeta(v: JobView): ExportJobMeta | null {
  const m = v.meta as Partial<ExportJobMeta> | undefined;
  if (v.lane !== "export" || m?.kind !== "export") return null;
  if (!m.projectDir || !m.destPath || !m.stagePath || !m.filename || !m.plan) return null;
  return m as ExportJobMeta;
}

/** Resolve with the job once it has ended. */
function whenJobEnds(sup: JobSupervisor, id: string): Promise<JobView | null> {
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

/** Follow a running export's progress into the export dialog's job, the way the page that started
 *  it did. */
function followProgress(sup: JobSupervisor, v: JobView, durationSec: number): () => void {
  const totalMs = Math.max(0, durationSec * 1000);
  const read = createProgressReader((r) =>
    useExportJob.getState().update({
      phase: "rendering",
      fraction: progressFraction(r.outMs, totalMs),
      etaSec: etaSeconds(r.outMs, totalMs, r.speed),
      speed: r.speed,
      frame: r.frame,
    }),
  );
  read(v.stdout_tail);
  return sup.subscribe(
    () => {},
    (id, chunk) => {
      if (id === v.id) read(chunk);
    },
  );
}

/** After a reload or a crash of the page: take over the exports the app process still holds.
 *  One that ended while no page was there is checked and committed now; one still queued or
 *  running is followed, and committed when it ends. Its records, file and project follow-ups end
 *  exactly as if this page had started it (3h part 7). */
export async function adoptExports(
  opts: { contextFor?: (projectDir: string) => ClientToolContext } = {},
): Promise<number> {
  const sup = await jobSupervisor();
  if (!sup) return 0;
  const contextFor = opts.contextFor ?? (await import("../tools/tauri")).makeTauriContext;
  let adopted = 0;
  for (const v of await sup.list()) {
    const m = exportMeta(v);
    if (!m || records.some((r) => r.job_id === v.id)) continue;
    if (v.committed) {
      // The page that committed it died before it could let go; its records were written then.
      await sup.forget(v.id).catch(() => false);
      continue;
    }
    adopted++;
    const key = normalizeDest(m.destPath);
    reserved.add(key);
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => void sup.kill(v.id).catch(() => false));
    controllers.set(v.id, controller);
    records.push({
      job_id: v.id,
      filename: m.filename,
      destPath: m.destPath,
      state: v.state === "queued" ? "queued" : "running",
      startedAt: m.submittedAt || v.queued_at,
    });
    changed();
    track(finishAdopted(sup, v, m, key, contextFor));
  }
  return adopted;
}

async function finishAdopted(
  sup: JobSupervisor,
  v: JobView,
  m: ExportJobMeta,
  key: string,
  contextFor: (projectDir: string) => ClientToolContext,
): Promise<void> {
  let unfollowState: (() => void) | undefined;
  let unfollowProgress: (() => void) | undefined;
  let ended: JobView | null = v.state === "exited" ? v : null;
  if (!ended) {
    unfollowState = sup.subscribe((c) => {
      if (c.id === v.id && c.state === "running") patch(v.id, { state: "running" });
    });
    if (v.state === "running") {
      useExportJob.getState().begin(() => cancelExport(v.id));
      unfollowProgress = followProgress(sup, v, m.plan.duration);
    }
    ended = await whenJobEnds(sup, v.id);
    unfollowState?.();
    unfollowProgress?.();
  }
  const ctx = contextFor(m.projectDir);
  const ledger = await openProjectJobs(ctx.store);
  const run: RunOutcome = { error: null, cancelled: false, warnings: m.plan.warnings ?? [] };
  if (!ended || ended.killed) {
    run.cancelled = true;
    run.error = "export cancelled";
    if (m.scratch) await ctx.store.remove(m.scratch).catch(() => undefined);
  } else if (
    ended.code === 0 &&
    !(await ctx.store.exists(m.stagePath)) &&
    (await ctx.store.exists(m.destPath))
  ) {
    // The page that ran it renamed the file into place and died before saying so: it was checked
    // then, and checking the empty staging path now would call a delivered export a failure.
    if (m.scratch) await ctx.store.remove(m.scratch).catch(() => undefined);
  } else {
    const { finishRenderJob } = await import("./render");
    const res = (await finishRenderJob(ctx, m, jobResult(ended))) as {
      ok?: boolean;
      error?: string;
      stderr_tail?: string;
      warnings?: string[];
    };
    if (!res.ok) {
      run.error = String(res.error ?? "render failed");
      if (typeof res.stderr_tail === "string") run.stderrTail = res.stderr_tail;
    }
  }
  await settle({
    jobId: v.id,
    key,
    store: ctx.store,
    destPath: m.destPath,
    stagePath: m.stagePath,
    filename: m.filename,
    meta: m.telemetry,
    startedBy: m.startedBy,
    startedAt: m.submittedAt || v.queued_at,
    ledger,
    supervisor: sup,
    run,
  });
  const done = records.find((r) => r.job_id === v.id);
  if (done && useExportJob.getState().abort && done.state !== "running" && done.state !== "queued")
    useExportJob.getState().finish({
      phase: done.state === "done" ? "done" : done.state === "cancelled" ? "cancelled" : "failed",
      savedTo: done.state === "done" ? m.destPath : null,
      error: done.error ?? null,
    });
}
