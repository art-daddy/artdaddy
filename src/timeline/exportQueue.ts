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
import type { MutationOrigin } from "../project/MutationGate";
import { notifyJobSettled } from "../store/jobNotes";
import { beginSessionActivity } from "../observability/crashWatch";

/** Destinations with an export queued or running, so a second one is refused rather than raced. */
const reserved = new Set<string>();

/** Serializes encodes across every project in the process. */
let queueTail: Promise<unknown> = Promise.resolve();

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
  const cancelled = cancelExport(jobId);
  return {
    ok: true,
    cancelled,
    // Not an error: the export finished before the request arrived, and saying so plainly
    // stops the model reporting a failure for a file that is sitting on disk.
    ...(cancelled ? {} : { note: "that export had already finished; nothing to cancel" }),
  };
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
  /** Runs the encode. Rejects with a message on failure. */
  run: (signal: AbortSignal) => Promise<{ warnings?: string[] }>;
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
 *  on disk and the user has it, so a catalog failure must not turn a good export into a failed one. */
async function registerExportInLibrary(
  store: ProjectStoreAccess,
  spec: ExportSpec,
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
      { origin: spec.origin },
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
  spec: ExportSpec,
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
  listeners.clear();
  queueTail = Promise.resolve();
}

/** Record the job, queue the encode, and return immediately. */
export async function submitExport(spec: ExportSpec): Promise<ExportSubmission> {
  const key = normalizeDest(spec.destPath);
  const ledger = await openProjectJobs(spec.store);
  const jobId = await ledger.begin({
    kind: "export",
    tool: "export",
    label: `the export ${spec.filename}`,
  });
  reserved.add(key);
  controllers.set(jobId, new AbortController());
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

  const task = (queueTail = queueTail.then(() => encode(spec, ledger, jobId, key)));
  inflight.add(task);
  void task.finally(() => inflight.delete(task));
  return { job_id: jobId, queue_position: queuePosition };
}

async function encode(
  spec: ExportSpec,
  ledger: Awaited<ReturnType<typeof openProjectJobs>>,
  jobId: string,
  key: string,
): Promise<void> {
  const { store } = spec;
  const startedAt = Date.now();
  // Committing by rename keeps the destination either untouched or complete. When the fs cannot
  // rename, the caller already pointed the encode at the destination and there is nothing to move.
  const staged = spec.stagePath !== spec.destPath;
  const signal = controllers.get(jobId)?.signal ?? new AbortController().signal;

  let error: string | null = null;
  let cancelled = false;
  let stderrTail: string | undefined;
  let warnings: string[] = [];
  let finishActivity: (() => void) | null = null;
  try {
    // Cancelled while still queued: never start an encode nobody is waiting for.
    if (signal.aborted) throw new Error("export cancelled");
    patch(jobId, { state: "running" });
    // An encode is the heaviest thing the app does and the likeliest moment to be killed for
    // memory; if the process dies here the crash marker will say so.
    finishActivity = beginSessionActivity("export");
    warnings = (await spec.run(signal)).warnings ?? [];
    if (signal.aborted) throw new Error("export cancelled");
    if (staged) await store.rename(spec.stagePath, spec.destPath);
  } catch (e) {
    // A killed ffmpeg reports its own confusing error; the reason the user needs is the cancel.
    cancelled = signal.aborted;
    error = cancelled ? "export cancelled" : e instanceof Error ? e.message : String(e);
    if (!cancelled && e instanceof ExportRunError) stderrTail = e.stderrTail;
    // Never leave a partial file where a finished export belongs.
    if (staged) await store.remove(spec.stagePath).catch(() => undefined);
  } finally {
    finishActivity?.();
    reserved.delete(key);
    controllers.delete(jobId);
    patch(jobId, {
      state: error ? (cancelled ? "cancelled" : "failed") : "done",
      endedAt: Date.now(),
      ...(error && !cancelled ? { error } : {}),
      ...(stderrTail ? { stderrTail } : {}),
      ...(warnings.length ? { warnings } : {}),
    });
  }

  // The delivered file enters the library like any other asset, so the ONE thing an agent could
  // not do was look at what it had actually shipped: `inspect_timeline` inspects the timeline, and
  // the export was reachable only by a filesystem path, which is not an address this product has.
  // Linked, never copied — the destination is often outside the project and can be hundreds of MB.
  // A cancelled run sets `error`, so nothing half-written is ever catalogued.
  const mediaRef = error ? null : await registerExportInLibrary(store, spec);
  if (mediaRef) patch(jobId, { mediaRef });

  await ledger.settle(
    jobId,
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
  const beacon = reportSettledExport(spec, {
    status: error ? (cancelled ? "cancelled" : "failed") : "done",
    elapsedMs: Date.now() - startedAt,
    warnings: warnings.length,
    error: error && !cancelled ? error : "",
  });
  beacons.add(beacon);
  void beacon.finally(() => beacons.delete(beacon));
  if (cancelled) return;
  const note = warnings.length
    ? `saved as ${spec.filename} (${warnings.length} warning${warnings.length > 1 ? "s" : ""}: ${warnings.join("; ")})`
    : `saved as ${spec.filename}`;
  notifyJobSettled(store.projectDir, {
    id: jobId,
    tool: "export",
    label: `the export ${spec.filename}`,
    status: error ? "failed" : "done",
    startedBy: spec.origin ? "chat" : "elsewhere",
    ...(error ? { error } : { detail: note }),
  });
}
