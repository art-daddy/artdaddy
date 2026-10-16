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
import { joinPath, type ProjectStoreAccess } from "../tools/store";
import type { ClientToolContext } from "../tools/context";
import {
  EXPORT_PROTOCOL_VERSION,
  jobResult,
  jobSupervisor,
  jobStderr,
  whenJobEnds,
  type JobSupervisor,
  type JobView,
  type ExportDeliveryPort,
  type ExportDelivery,
} from "../tools/jobSupervisor";
import type { MutationOrigin } from "../project/MutationGate";
import { notifyJobSettled, type SettledJob } from "../store/jobNotes";
import { useExportJob } from "../store/exportJob";
import { beginSessionActivity } from "../observability/crashWatch";
import { recordStaging, releaseStaging } from "./exportStaging";
import { setExportsBusy } from "../tools/workGate";
import { projectKeyOfDir } from "../tools/dataRoot";
import { resolveExportResources, type ExportResources } from "../platform/host";
import { confirmExport } from "../lib/confirm";
import { assessExport, estimateExportFromHistory, type ExportAssessment, type ExportCalibration } from "./exportOptions";
import type { RenderWorkload } from "./renderPlan";
import { runProjectMutation } from "../tools/coordinator";

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
const inflight = new Map<string, { task: Promise<unknown>; retry?: () => Promise<unknown> }>();

/** Per-job cancellation. Making the export outlive its turn removed the only way to stop one —
 *  the turn's own abort — so the queue owns that now. */
const controllers = new Map<string, AbortController>();
const deliveryPorts = new Map<string, ExportDeliveryPort>();

export function localDeliveryPort(store: ProjectStoreAccess): ExportDeliveryPort {
  const entries = new Map<string, ExportDelivery>();
  const scratch = new Map<string, string>();
  const entry = (id: string) => {
    const value = entries.get(id);
    if (!value) throw new Error("unknown export intent");
    return value;
  };
  const identity = async (file: string) => {
    const probe = await store.probeMedia(file, 0);
    if (!probe || probe.size <= 0) throw new Error("streaming artifact identity is unavailable");
    return { sha256: probe.sha256, size: probe.size };
  };
  return {
    protocol: async () => EXPORT_PROTOCOL_VERSION,
    stageScratch: async (id, files, fonts) => {
      const value = entry(id);
      if (value.state !== "prepared" || value.source?.kind !== "render") throw new Error("render staging intent is no longer eligible");
      if (scratch.has(id)) throw new Error("render scratch is already staged");
      const first = await store.prepareWork(`renderer/export-${id}/.reserved`);
      const cwd = first.slice(0, first.lastIndexOf("/"));
      scratch.set(id, cwd);
      for (const file of files) {
        if (entry(id).state !== "prepared") throw new Error("render staging was cancelled");
        await store.writeText(joinPath(cwd, file.name), file.content);
      }
      if (fonts.length) {
        const fontRoot = await (await import("../tools/assScratch")).bundledFontDir();
        if (!fontRoot) throw new Error("bundled render font root is unavailable");
        for (const font of fonts) {
          if (entry(id).state !== "prepared") throw new Error("render font staging was cancelled");
          await store.writeBytes(joinPath(cwd, "fonts", font), await store.readBytes(joinPath(fontRoot, font)));
        }
      }
      return cwd;
    },
    prepare: async (id, projectDir, stagePath, destPath, source) => {
      if (!store.canRename || stagePath === destPath)
        throw new Error("export needs a distinct atomic staging path");
      const value: ExportDelivery = {
        version: 1,
        id,
        project_dir: projectDir,
        stage_path: stagePath,
        dest_path: destPath,
        state: "prepared",
        identity: null,
        created_at: Date.now(),
        followups_done: false,
        source,
      };
      entries.set(id, value);
      return { ...value };
    },
    verify: async (id) => {
      const value = entry(id);
      if (value.state !== "prepared" && value.state !== "verified")
        throw new Error("export intent cannot be verified");
      const proof = await identity(value.stage_path);
      const currentState = entry(id).state;
      if (currentState === "cancelled" || currentState === "failed")
        throw new Error("export intent was cancelled or failed");
      value.identity = proof;
      value.state = "verified";
      return { ...value };
    },
    publish: async (id) => {
      const value = entry(id);
      if (value.state !== "verified" && value.state !== "publishing" && value.state !== "published")
        throw new Error("export intent is not verified");
      const staged = await store.exists(value.stage_path).catch(() => true);
      const actual = await identity(staged ? value.stage_path : value.dest_path);
      if (
        !value.identity ||
        actual.sha256 !== value.identity.sha256 ||
        actual.size !== value.identity.size
      )
        throw new Error("export artifact identity changed");
      const currentState = entry(id).state;
      if (currentState === "cancelled" || currentState === "failed")
        throw new Error("export intent was cancelled or failed");
      if (staged) await store.rename(value.stage_path, value.dest_path);
      value.state = "published";
      return { ...value };
    },
    cancel: async (id) => {
      const value = entry(id);
      if (value.state === "published" || value.state === "cancelled") return false;
      value.state = "cancelled";
      return true;
    },
    fail: async (id) => {
      const value = entry(id);
      if (value.state === "published" || value.state === "cancelled") return false;
      value.state = "failed";
      return true;
    },
    list: async () => [...entries.values()].map((value) => ({ ...value })),
    complete: async (id) => {
      const cwd = scratch.get(id);
      if (cwd) { await store.remove(cwd); scratch.delete(id); }
      entry(id).followups_done = true;
      return true;
    },
    copy: async (id) => {
      const value = entry(id);
      if (value.state !== "prepared" || value.source?.kind !== "copy")
        throw new Error("copy intent is unavailable");
      await store.copyFile(value.source.path, value.stage_path);
    },
  };
}

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
  const port = deliveryPorts.get(jobId);
  if (port)
    void port
      .cancel(jobId)
      .then((cancelled) => {
        if (cancelled) c.abort();
      })
      .catch(() => undefined);
  else c.abort();
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
  const port = deliveryPorts.get(jobId);
  if (port && controllers.has(jobId)) {
    try {
      const cancelled = await port.cancel(jobId);
      if (cancelled) controllers.get(jobId)?.abort();
      return {
        ok: true,
        cancelled,
        ...(cancelled ? {} : { state: "done", note: "the verified export was already published" }),
      };
    } catch (error) {
      return { ok: false, error: `export cancellation could not be committed: ${String(error)}` };
    }
  }
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

export class ExportRequestError extends Error {
  constructor(message: string, readonly submitted: readonly ExportSubmission[]) { super(message); this.name = "ExportRequestError"; }
}

export interface ExportSpec {
  store: ProjectStoreAccess;
  dependencies: readonly string[];
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
  submissionSignal?: AbortSignal;
  workload?: RenderWorkload;
  outputDirectory?: string;
  /** What is being delivered, for the export metric. Describes the PLANNED artifact, so it is
   *  still reportable when the encode fails and no file exists to measure. */
  meta?: {
    duration_s: number;
    width: number;
    height: number;
    fps: number;
    quality: string;
    project_id: string;
    visual_layers?: number;
    project_width?: number;
    project_height?: number;
    calibration?: Pick<ExportCalibration, "workload" | "output" | "quality" | "engine" | "encoder">;
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
  spec: Pick<ExportSpec, "destPath" | "filename"> & { jobId: string },
  identity: ExportDelivery["identity"],
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
      { kind: "export", job_id: spec.jobId, identity },
      spec.destPath,
    );
    return entry.id;
  } catch {
    return null;
  }
}

/** Resolve once every export started in this process has settled (tests and a deliberate drain). */ export async function whenExportsSettle(): Promise<void> {
  while (inflight.size)
    await Promise.allSettled([...inflight.values()].map((activity) => activity.task));
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
  spec: Pick<ExportSpec, "store" | "destPath" | "meta" | "supervisor"> & { jobId?: string },
  outcome: {
    status: "done" | "failed" | "cancelled";
    elapsedMs: number;
    warnings: number;
    error: string;
    finalSizeBytes?: number;
  },
): Promise<void> {
  try {
    const native = outcome.status === "done" && spec.supervisor && spec.jobId
      ? (await spec.supervisor.list()).find((view) => view.id === spec.jobId) : null;
    // Only a delivered file has a size; a failed encode leaves nothing to measure.
    const size = outcome.status === "done" ? (outcome.finalSizeBytes ?? (await spec.store.byteSize(spec.destPath)) ?? 0) : 0;
    if (outcome.status === "done" && spec.meta?.calibration && size > 0) {
      let memoryBytes: number | null = null;
      let temporaryBytes: number | null = null;
      const diagnostics = native ? jobStderr(native).split(/\r?\n/).reverse() : [];
      const summary = diagnostics.find((line) => line.startsWith("native render resident: "));
      if (summary) {
        try {
          const parsed: unknown = JSON.parse(summary.slice("native render resident: ".length));
          const peak = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).sampled_peak : null;
          if (typeof peak === "number" && Number.isSafeInteger(peak) && peak > 0) memoryBytes = peak;
        } catch {}
      }
      const temporary = diagnostics.find((line) => line.startsWith("native render temporary: "));
      if (temporary) {
        try {
          const parsed: unknown = JSON.parse(temporary.slice("native render temporary: ".length));
          const peak = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).accounted_peak_payload_bytes : null;
          if (typeof peak === "number" && Number.isSafeInteger(peak) && peak >= 0) temporaryBytes = peak;
        } catch {}
      }
      const queuedMs = native?.started_at ? Math.max(0, native.started_at - native.queued_at) : 0;
      useExportJob.getState().rememberCalibration({ ...spec.meta.calibration,
        elapsedSeconds: Math.max(0, outcome.elapsedMs - queuedMs) / 1000, finalBytes: size,
        memoryBytes, temporaryBytes });
    }
    const { reportExport } = await import("../api/exportEvents");
    await reportExport({
      status: outcome.status,
      duration_s: spec.meta?.duration_s ?? 0,
      size_bytes: size,
      elapsed_ms: outcome.elapsedMs,
      width: spec.meta?.project_width ?? spec.meta?.width ?? 0,
      height: spec.meta?.project_height ?? spec.meta?.height ?? 0,
      fps: spec.meta?.fps ?? 0,
      quality: spec.meta?.quality ?? "",
      warnings: outcome.warnings,
      error: outcome.error,
      project_id: spec.meta?.project_id ?? "",
      visual_layers: spec.meta?.visual_layers,
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
  deliveryPorts.clear();
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
  return (await submitExports([spec]))[0];
}

async function confirmExportRequest(specs: readonly ExportSpec[]): Promise<void> {
  const started = Date.now();
  const refuse = async (status: "cancelled" | "declined" | "blocked"): Promise<never> => {
    try {
      const { reportExport } = await import("../api/exportEvents");
      for (const spec of specs) {
        const beacon = reportExport({ status, reason_code: status === "blocked" ? "unknown" : status, readiness: "unknown",
          elapsed_ms: Date.now() - started, width: spec.workload?.width, height: spec.workload?.height,
          visual_layers: spec.workload?.peakVisualLayers }).catch(() => undefined);
        beacons.add(beacon);
        void beacon.finally(() => beacons.delete(beacon));
      }
    } catch {}
    throw new Error(status === "blocked" ? "export could not be confirmed; no job was submitted" : "export cancelled before submission");
  };
  const checks: ExportAssessment[] = [];
  const snapshots: ExportResources[] = [];
  for (const spec of specs) {
    if (spec.submissionSignal?.aborted || !spec.store.sessionLive()) return refuse("cancelled");
    const resources = await resolveExportResources(spec.destPath, spec.submissionSignal);
    snapshots.push(resources);
    const workload = spec.workload ?? { width: spec.meta?.project_width ?? spec.meta?.width ?? 0,
      height: spec.meta?.project_height ?? spec.meta?.height ?? 0, fps: spec.meta?.fps ?? 0,
      durationSeconds: spec.meta?.duration_s ?? 0, visualClips: 0, captionClips: 0, audioClips: 0,
      peakVisualLayers: spec.meta?.visual_layers ?? 0, peakMediaLayers: 0 };
    const descriptor = spec.meta?.calibration;
    const estimates = descriptor ? estimateExportFromHistory(workload, descriptor.output, descriptor.quality, descriptor.engine,
      useExportJob.getState().calibrations, descriptor.encoder) : { memoryBytes: null, temporaryBytes: null, finalBytes: null, seconds: null };
    checks.push(assessExport(workload, resources, estimates, resources.budgets));
  }
  if (specs.some((spec) => spec.submissionSignal?.aborted || !spec.store.sessionLive())) return refuse("cancelled");
  const reasons = new Set(checks.flatMap((check) => check.reasons));
  if (checks.every((check) => check.estimates.temporaryBytes !== null && check.estimates.finalBytes !== null)) {
    const temporary = checks.reduce((total, check) => total + check.estimates.temporaryBytes!, 0);
    const final = checks.reduce((total, check) => total + check.estimates.finalBytes!, 0);
    if (snapshots.some((snapshot) => snapshot.scratch_free_bytes !== null && temporary + final > snapshot.scratch_free_bytes ||
      snapshot.destination_free_bytes !== null && temporary + final > snapshot.destination_free_bytes)) reasons.add("disk_shortage");
    if (snapshots.some((snapshot) => snapshot.budgets.temporaryBytes !== null && temporary > snapshot.budgets.temporaryBytes)) reasons.add("temporary_limit");
  }
  const warning = [...reasons].some((reason) => reason !== "slow");
  if (!warning && checks.every((check) => check.severity === "none")) return;
  const outside = checks.some((check) => check.promiseLine === "outside");
  const explanations = {
    outside_promise: "The project exceeds an individual promised size, frame-rate, clip-count or on-screen limit, or those details are unavailable.",
    memory_unknown: "Memory fit cannot be estimated yet because a comparable observation or native measurement is missing.",
    memory_shortage: "The estimated worker memory exceeds currently available memory or the existing worker cutoff.",
    disk_unknown: "Temporary-file or final-file space cannot be estimated yet.",
    disk_shortage: "There may not be enough free space for the temporary files and all finished outputs together.",
    temporary_limit: "Estimated temporary files exceed the remaining export workspace allowance.",
    time_unknown: "A comparable successful local run is not available to estimate time.",
    execution_limit: "The estimated active time exceeds the existing export execution limit.",
    slow: "This export is estimated to take more than twice the video length.",
  };
  const time = checks.every((check) => check.estimates.seconds !== null)
    ? `Estimated encoding and saving time: about ${Math.max(1, Math.ceil(checks.reduce((total, check) => total + check.estimates.seconds!, 0) / 60))} minute(s), based on comparable successful exports on this device. This is a rough estimate; different media and effects can take longer. Preparation and queue wait are extra.`
    : "Estimated time: unknown (no comparable local measurement yet).";
  const message = [
    `Check ${specs.length === 1 ? "this export" : `these ${specs.length} exports`} before starting.`,
    outside ? "This request is outside the measured project promise, or its project details are unavailable."
      : warning ? "This project is within the declared size limits; resource fit has not yet been established."
      : "This project is within the declared size limits.",
    [...reasons].map((reason) => explanations[reason]).join("\n"),
    ...(specs.some((spec) => spec.meta?.calibration?.encoder === "amf-cqp18")
      ? ["Fast uses the locally measured AMD profile. Files can be much larger, and the picture can differ from Full quality."] : []),
    time,
    checks.every((check) => check.estimates.memoryBytes !== null)
      ? `Estimated worker memory: about ${(Math.max(...checks.map((check) => check.estimates.memoryBytes!)) / 1024 ** 3).toFixed(1)} GiB, from observed worker samples; this is not a guaranteed peak.`
      : "Estimated memory: unknown. Native resource limits still apply.",
    checks.every((check) => check.estimates.temporaryBytes !== null)
      ? `Estimated temporary payload: about ${(checks.reduce((total, check) => total + check.estimates.temporaryBytes!, 0) / 1e9).toFixed(1)} GB, from conservative accounted scratch observations. Filesystem metadata and allocation overhead are extra within the existing headroom; this is not an exact disk peak.`
      : "Estimated temporary disk: unknown. Safe-file and temporary-space limits still apply.",
    "You can lower the export resolution or export a smaller section. Cancel to change settings.",
    warning ? "Continue anyway?" : "Continue?",
  ].join("\n\n");
  const decision = await confirmExport(message, warning);
  if (specs.some((spec) => spec.submissionSignal?.aborted || !spec.store.sessionLive())) return refuse("cancelled");
  if (decision === "continue") return;
  return refuse(decision === "cancel" ? "declined" : "blocked");
}

export async function submitExports(request: readonly ExportSpec[]): Promise<ExportSubmission[]> {
  if (!request.length || request.length > 50) throw new Error("one export request must contain between 1 and 50 files");
  const specs = request.map((spec) => ({ ...spec, dependencies: [...spec.dependencies],
    ...(spec.meta ? { meta: structuredClone(spec.meta) } : {}),
    ...(spec.workload ? { workload: structuredClone(spec.workload) } : {}) }));
  const destinations = new Set<string>();
  const projectDir = specs[0].store.projectDir;
  for (const spec of specs) {
    if (spec.store.projectDir !== projectDir) throw new Error("one export request belongs to one project");
    if (spec.stagePath === spec.destPath || !spec.store.canRename)
      throw new Error("export requires atomic destination-volume staging; direct-output fallback is not supported");
    const key = normalizeDest(spec.destPath);
    if (reserved.has(key) || destinations.has(key)) throw new Error("export destination is already reserved");
    destinations.add(key);
  }
  await confirmExportRequest(specs);
  const submitted: ExportSubmission[] = [];
  const admissionStarted = Date.now();
  try {
    for (const spec of specs) submitted.push(await admitExport(spec));
  } catch (error) {
    const failed = specs[submitted.length];
    try {
      const { reportExport } = await import("../api/exportEvents");
      const beacon = reportExport({ status: failed.submissionSignal?.aborted || !failed.store.sessionLive() ? "cancelled" : "blocked",
        elapsed_ms: Date.now() - admissionStarted, error: error instanceof Error ? error.message : String(error),
        width: failed.workload?.width, height: failed.workload?.height, visual_layers: failed.workload?.peakVisualLayers }).catch(() => undefined);
      beacons.add(beacon);
      void beacon.finally(() => beacons.delete(beacon));
    } catch {}
    throw new ExportRequestError(error instanceof Error ? error.message : String(error), [...submitted]);
  }
  return submitted;
}

async function admitExport(spec: ExportSpec): Promise<ExportSubmission> {
  spec = {
    ...spec,
    dependencies: [...spec.dependencies],
    ...(spec.meta ? { meta: { ...spec.meta } } : {}),
  };
  if (spec.stagePath === spec.destPath || !spec.store.canRename)
    throw new Error(
      "export requires atomic destination-volume staging; direct-output fallback is not supported",
    );
  const key = normalizeDest(spec.destPath);
  if (reserved.has(key)) throw new Error("export destination is already reserved");
  reserved.add(key);
  let supervisor: JobSupervisor | null;
  try {
    supervisor = spec.supervisor ?? (await jobSupervisor());
  } catch (error) {
    reserved.delete(key);
    throw error;
  }
  if (
    typeof window !== "undefined" &&
    (window.__TAURI_INTERNALS__ ?? window.__TAURI__) &&
    !supervisor?.delivery
  ) {
    reserved.delete(key);
    throw new Error("desktop export requires the verified native delivery protocol");
  }
  if (supervisor) spec = { ...spec, supervisor };
  const port = supervisor?.delivery ?? localDeliveryPort(spec.store);
  let ledger: Ledger;
  try {
    ledger = await openProjectJobs(spec.store);
  } catch (error) {
    reserved.delete(key);
    throw error;
  }
  // A supervised export lives as long as the app does, not the page: its record says so, or the
  // next page's ledger would call it interrupted while it is still running (jobLedger.ts).
  const session = spec.supervisor
    ? await spec.supervisor.launchId().catch(() => undefined)
    : undefined;
  let jobId = "";
  try {
    await runProjectMutation(spec.store.projectDir, "admit confirmed export", async (_document, lease) => {
      if (!spec.store.sessionLive() || spec.submissionSignal?.aborted) throw new Error("export belongs to a closed or cancelled request");
      lease?.assertCanCommit();
      if (spec.outputDirectory) {
        if (normalizeDest(spec.outputDirectory) !== normalizeDest(spec.destPath.replace(/[\\/][^\\/]+$/, "")))
          throw new Error("export output folder differs from its captured destination");
        try { await spec.store.ensureDir(spec.outputDirectory); }
        catch (error) { throw new Error(`could not make the folder ${spec.outputDirectory}: ${String(error)}`); }
        lease?.assertCanCommit();
      }
      jobId = await ledger.begin({ kind: "export", tool: "export", label: `the export ${spec.filename}`,
        ...(session ? { session } : {}) });
      const copyPath = spec.copyOf ? await spec.store.resolveMediaRef(spec.copyOf) : null;
      if (spec.copyOf && !copyPath) throw new Error("copy export source is unavailable");
      lease?.assertCanCommit();
      await port.prepare(jobId, spec.store.projectDir, spec.stagePath, spec.destPath,
        spec.copyOf ? { kind: "copy", path: copyPath!, media_ref: spec.copyOf } : { kind: "render", paths: [...spec.dependencies] });
      lease?.assertCanCommit();
      if (!spec.store.sessionLive() || spec.submissionSignal?.aborted) throw new Error("export cancelled during native preparation");
      lease?.markCommitted();
    }, { origin: spec.origin, signal: spec.submissionSignal });
  } catch (error) {
    reserved.delete(key);
    if (jobId) {
      const retired = await port.cancel(jobId).catch(() => false);
      if (retired) await port.complete(jobId).catch(() => false);
      await ledger.settle(jobId, { status: spec.submissionSignal?.aborted || !spec.store.sessionLive() ? "cancelled" : "failed", error: String(error) });
    }
    throw error;
  }
  deliveryPorts.set(jobId, port);
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
  const task = spec.copyOf
    ? (copyTail = copyTail.then(() => encode(spec, ledger, jobId, key)))
    : spec.supervisor
      ? encode(spec, ledger, jobId, key)
      : (queueTail = queueTail.then(() => encode(spec, ledger, jobId, key)));
  track(jobId, task);
  return { job_id: jobId, queue_position: queuePosition };
}

function track(jobId: string, task: Promise<unknown>): void {
  const activity: { task: Promise<unknown>; retry?: () => Promise<unknown> } = { task };
  const release = async () => {
    if (inflight.get(jobId) !== activity) return;
    inflight.delete(jobId);
    await activity.retry?.().catch(() => undefined);
  };
  activity.task = task.then(release, release);
  inflight.set(jobId, activity);
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
    if (signal.aborted) throw new Error("export cancelled");
    if (spec.copyOf) {
      const port = deliveryPorts.get(jobId);
      if (!port) throw new Error("copy delivery owner is missing");
      await port.copy(jobId);
    } else {
      run.warnings = (await spec.run(signal, jobId)).warnings ?? [];
    }
    if (signal.aborted) throw new Error("export cancelled");
    const port = deliveryPorts.get(jobId);
    if (!port) throw new Error("export delivery owner is missing");
    await port.verify(jobId);
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
  const delivery = deliveryPorts.get(x.jobId);
  // Committing by rename keeps the destination either untouched or complete. When the fs cannot
  // rename, the caller already pointed the encode at the destination and there is nothing to move.
  const staged = x.stagePath !== x.destPath;
  let { error } = x.run;
  let publishedIdentity: ExportDelivery["identity"] = null;
  let publicationPending = false;
  const { cancelled, stderrTail, warnings } = x.run;
  if (!error && staged) {
    try {
      const port = deliveryPorts.get(x.jobId);
      if (!port) throw new Error("export delivery owner is missing");
      publicationPending = true;
      let published: ExportDelivery;
      try {
        published = await port.publish(x.jobId);
      } catch (error) {
        const receipt = (await port.list()).find((intent) => intent.id === x.jobId);
        if (!receipt?.identity || (receipt.state !== "publishing" && receipt.state !== "published"))
          throw error;
        published = await port.publish(x.jobId);
      }
      publishedIdentity = published.identity;
      publicationPending = false;
      await releaseStaging(x.stagePath);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  // Never leave a partial file where a finished export belongs. One that cannot be removed now
  // stays listed, for the next launch to remove.
  if (error && staged) {
    const failed = await delivery?.fail(x.jobId).catch(() => false);
    if (publicationPending) {
      const receipt = failed
        ? undefined
        : (await delivery?.list().catch(() => []))?.find((intent) => intent.id === x.jobId);
      publicationPending =
        !failed && (!receipt || (receipt.state !== "failed" && receipt.state !== "cancelled"));
    }
    if (!publicationPending) {
      await x.store.remove(x.stagePath).then(
        () => releaseStaging(x.stagePath),
        () => undefined,
      );
    }
  }
  // From here a page that takes over must not touch the file again.
  if (!publicationPending) await x.supervisor?.commit(x.jobId).catch(() => false);
  controllers.delete(x.jobId);
  deliveryPorts.delete(x.jobId);
  patch(x.jobId, {
    state: error ? (cancelled ? "cancelled" : "failed") : "done",
    endedAt: Date.now(),
    error: error && !cancelled ? error : undefined,
    ...(stderrTail ? { stderrTail } : {}),
    ...(warnings.length ? { warnings } : {}),
  });

  // The delivered file enters the library like any other asset, so the ONE thing an agent could
  // not do was look at what it had actually shipped: `inspect_timeline` inspects the timeline, and
  // the export was reachable only by a filesystem path, which is not an address this product has.
  // Linked, never copied — the destination is often outside the project and can be hundreds of MB.
  // A cancelled run sets `error`, so nothing half-written is ever catalogued. A copy of a library
  // file is that file's bytes, so it is that file's ref.
  const mediaRef = error
    ? null
    : (x.copyOf ?? (await registerExportInLibrary(x.store, x, publishedIdentity)));
  if (mediaRef) patch(x.jobId, { mediaRef });
  if (!publicationPending) reserved.delete(x.key);

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
      finalSizeBytes: publishedIdentity?.size,
      elapsedMs: Date.now() - x.startedAt,
      warnings: warnings.length,
      error: error && !cancelled ? error : "",
    });
    beacons.add(beacon);
    void beacon.finally(() => beacons.delete(beacon));
  }
  if (!publicationPending && (error || mediaRef || x.copyOf)) {
    if (await delivery?.complete(x.jobId).catch(() => false))
      await x.supervisor?.forget(x.jobId).catch(() => false);
  }
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
  kind: "export" | "export_copy";
  projectDir: string;
  destPath: string;
  stagePath: string;
  filename: string;
  startedBy: "chat" | "elsewhere";
  submittedAt: number;
  plan?: import("./render").ExportJobPlan;
  copyOf?: string;
  telemetry?: ExportSpec["meta"];
  scratch?: string | null;
}

function exportMeta(v: JobView): ExportJobMeta | null {
  const m = v.meta as Partial<ExportJobMeta> | undefined;
  const failed = v.state === "exited" && (v.killed || v.code !== 0);
  if (v.lane !== "export" || (m?.kind !== "export" && m?.kind !== "export_copy")) return null;
  if (
    !m.projectDir ||
    !m.destPath ||
    !m.stagePath ||
    !m.filename ||
    (m.kind === "export" ? !m.plan && !failed : !m.copyOf)
  )
    return null;
  return m as ExportJobMeta;
}

/** Follow a running export's progress into the export dialog's job, the way the page that started
 *  it did. */
async function followProgress(
  sup: JobSupervisor,
  v: JobView,
  plan: import("./render").ExportJobPlan,
): Promise<() => void> {
  const { exportProgressReporter } = await import("./render");
  const read = exportProgressReporter(plan);
  if (plan.stepDurations) read(`artdaddy_step=${v.step ?? 0}\n`);
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
  opts: { contextFor?: (projectDir: string) => ClientToolContext; projectId?: string } = {},
): Promise<number> {
  const sup = await jobSupervisor();
  if (!sup) return 0;
  const port = sup.delivery;
  if (!port) throw new Error("page adoption requires verified native delivery state");
  const intents = await port.list();
  const contextFor = opts.contextFor ?? (await import("../tools/tauri")).makeTauriContext;
  let adopted = 0;
  for (const v of await sup.list()) {
    const m = exportMeta(v);
    if (!m) continue;
    if (opts.projectId && projectKeyOfDir(m.projectDir) !== opts.projectId) continue;
    const active = inflight.get(v.id);
    if (active) {
      active.retry = () => adoptExports({ ...opts });
      continue;
    }
    const intent = intents.find((intent) => intent.id === v.id);
    if (!intent) continue;
    if (intent.followups_done) {
      await sup.forget(v.id).catch(() => false);
      continue;
    }
    adopted++;
    const key = normalizeDest(m.destPath);
    reserved.add(key);
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => void sup.kill(v.id).catch(() => false));
    controllers.set(v.id, controller);
    deliveryPorts.set(v.id, port);
    const current = records.find((record) => record.job_id === v.id);
    if (!current) {
      records.push({
        job_id: v.id,
        filename: m.filename,
        destPath: m.destPath,
        state: v.state === "queued" ? "queued" : "running",
        startedAt: m.submittedAt || v.queued_at,
      });
    } else {
      Object.assign(current, {
        state: v.state === "queued" ? "queued" : "running",
        error: undefined,
        endedAt: undefined,
      });
    }
    changed();
    track(v.id, finishAdopted(sup, v, m, key, contextFor));
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
  let copyError: string | null = null;
  if (!ended) {
    unfollowState = sup.subscribe((c) => {
      if (c.id === v.id && c.state === "running") patch(v.id, { state: "running" });
    });
    if (v.state === "running" && m.plan) {
      useExportJob.getState().begin(() => cancelExport(v.id));
      unfollowProgress = await followProgress(sup, v, m.plan);
    }
    if (m.copyOf && v.state === "queued") {
      try {
        const port = deliveryPorts.get(v.id);
        if (!port) throw new Error("copy delivery owner is missing");
        await port.copy(v.id);
      } catch (error) {
        copyError = error instanceof Error ? error.message : String(error);
      }
    }
    ended = copyError
      ? ((await sup.list()).find((job) => job.id === v.id) ?? null)
      : await whenJobEnds(sup, v.id);
    unfollowState?.();
    unfollowProgress?.();
  }
  const ctx = contextFor(m.projectDir);
  const ledger = await openProjectJobs(ctx.store);
  const run: RunOutcome = { error: null, cancelled: false, warnings: m.plan?.warnings ?? [] };
  if (copyError && !ended?.killed) {
    run.error = copyError;
  } else if (!ended || ended.killed) {
    run.cancelled = true;
    run.error = "export cancelled";
    if (m.scratch) await ctx.store.remove(m.scratch).catch(() => undefined);
  } else if ((m.copyOf || !m.plan) && ended.code !== 0) {
    run.stderrTail = jobResult(ended).stderr;
    run.error =
      run.stderrTail ||
      `${m.copyOf ? "native library copy" : "native export"} failed (code=${ended.code ?? "unknown"})`;
  } else if (!m.copyOf && (!m.plan || (await import("./render")).renderContractError(m.plan))) {
    run.error = m.plan
      ? (await import("./render")).renderContractError(m.plan)
      : "unsupported render contract; export again with the current client";
  } else {
    const port = deliveryPorts.get(v.id);
    const delivery = port ? (await port.list()).find((intent) => intent.id === v.id) : undefined;
    if (
      ended.code === 0 &&
      delivery?.identity &&
      ["verified", "publishing", "published"].includes(delivery.state) &&
      !(await ctx.store.exists(m.stagePath))
    ) {
      if (m.scratch) await ctx.store.remove(m.scratch).catch(() => undefined);
    } else {
      const { finishRenderJob } = await import("./render");
      const res = (
        m.copyOf
          ? { ok: true }
          : await finishRenderJob(ctx, { ...m, plan: m.plan! }, jobResult(ended))
      ) as {
        ok?: boolean;
        error?: string;
        stderr_tail?: string;
        warnings?: string[];
      };
      if (!res.ok) {
        run.error = String(res.error ?? "render failed");
        if (typeof res.stderr_tail === "string") run.stderrTail = res.stderr_tail;
      } else {
        try {
          if (!port) throw new Error("export delivery owner is missing");
          await port.verify(v.id);
        } catch (error) {
          run.error = String(error);
        }
      }
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
    copyOf: m.copyOf,
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
