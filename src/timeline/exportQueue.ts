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
import { useExportJob, liveFeedOf } from "../store/exportJob";
import { beginSessionActivity } from "../observability/crashWatch";
import { recordStaging, releaseStaging } from "./exportStaging";
import { exportOwnerNow } from "../api/exportOwner";
import { setExportsBusy } from "../tools/workGate";
import { projectKeyOfDir } from "../tools/dataRoot";
import { resolveExportResources, type ExportResources } from "../platform/host";
import { confirmExport } from "../lib/confirm";
import { markChipSuspect } from "./chipTest";
import type { ChoiceFacts } from "./exportChoice";
import { CHIP_MAKERS, type ChipMaker, type ModeReason, type SizeClass } from "./exportEncoder";
import { askQuestion, hostMounted, type QuestionOutcome } from "../store/exportQuestionHost";
import {
  assessExport,
  estimateExport,
  peakSamples,
  type ExportAssessment,
  type ExportCalibration,
} from "./exportOptions";
import {
  RUNG_NAMES,
  cleanLadder,
  denseLadder,
  planRung,
  retryRung,
  rungOf,
  type Ladder,
  type Plan,
  type Rung,
} from "./exportPlan";
import { exportFlag, refreshExportFlags } from "../api/exportFlags";
import {
  bandOf,
  driveOf,
  planQuestions,
  questionAsText,
  type ExportQuestion,
  type ExportQuestionKind,
  type PreflightPicture,
} from "./exportQuestions";
import type { RenderWorkload } from "./renderPlan";
import { runProjectMutation } from "../tools/coordinator";
import type {
  ExportEncoderKind,
  ExportEngine,
  ExportLimit,
  ExportStarter,
  ExportTraceValue,
} from "../api/exportVocabulary";
import { ExportStory, RunWatch, STAGE_CODES } from "./exportTrace";
import {
  QUIET_SECONDS,
  describeChipFailure,
  failureOf,
  quietSeconds,
  timeLeftSeconds,
} from "./exportWords";
import { limitThatFired, mibBand, parseNativeDiagnostics } from "./nativeDiagnostics";

/** Who stopped an export (a value of the report's trace vocabulary). */
export type ExportCanceller = Extract<
  ExportTraceValue,
  "person_dialog" | "person_card" | "person_queue" | "assistant" | "app"
>;

/** Destinations with an export queued or running, so a second one is refused rather than raced. */
const reserved = new Set<string>();

/** The story of each export in flight, by job id: what happened to it so far (see exportTrace.ts). */
const stories = new Map<string, ExportStory>();

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
      if (value.state !== "prepared" || value.source?.kind !== "render")
        throw new Error("render staging intent is no longer eligible");
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
          await store.writeBytes(
            joinPath(cwd, "fonts", font),
            await store.readBytes(joinPath(fontRoot, font)),
          );
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
      if (cwd) {
        await store.remove(cwd);
        scratch.delete(id);
      }
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
  /** The project the export belongs to, so a card shows only its own project's exports. */
  projectDir: string;
  state: ExportState;
  error?: string;
  /** Process diagnostics kept separate from the user-facing summary. */
  stderrTail?: string;
  warnings?: string[];
  /** Library ref for the delivered file, so it can be inspected like any other asset. */
  mediaRef?: string;
  /** A cancel has been asked and the export has not stopped yet (it may still be waiting its turn to
   *  notice). Said at once, so nobody is left looking at a row that ignored the button. */
  cancelling?: boolean;
  /** The setting the export runs at when it is below the normal one (exportPlan.ts), so the card can say so. */
  rung?: 1 | 2;
  /** The gentlest rung this export's command really has, when the plan said (render.ts `gentlestRung`): what Try
   *  again may ask for. Absent: what the engine has. */
  maxRung?: Rung;
  /** The rungs this export really has (exportPlan.ts `Ladder`): Try again steps to the next one on it. Absent: the
   *  rungs with no gaps up to `maxRung`. */
  ladder?: readonly Rung[];
  /** How the encoder was chosen (exportChoice.ts), kept when it is not the processor's normal setting so the card can
   *  say what the export runs on. */
  encoder?: ExportEncoderKind;
  reason?: ModeReason;
  /** The export failed in a way a chip can cause, and it ran on one: Try again runs it on the processor. */
  chipFailed?: true;
  /** A way to start this export again is offered (see {@link offerExportRetry}): the card shows Try again on it
   *  once it has failed. */
  canRetry?: true;
  /** Try again was pressed and the new export is being started. */
  retrying?: true;
  /** What the card says when starting again did not work (the new export was refused). */
  note?: string;
  startedAt: number;
  /** When the export's turn came (it began running), so "took" does not count the wait in line. */
  ranAt?: number;
  endedAt?: number;
}

/** Bounded like the persisted ledger's terminal set: this is a session view, not an archive. */
const KEEP_TERMINAL = 50;
/** How often a running export is checked for standing still (log only, see RunWatch). */
const WATCH_TICK_MS = 5_000;
const records: ExportRecord[] = [];
const listeners = new Set<() => void>();
// A snapshot rebuilt on every change, because `records` is mutated in place: a subscriber that
// compared the array's identity would never see an update.
let snapshot: readonly ExportRecord[] = [];

function changed(): void {
  // A way to start an export again goes with its row, however the row went.
  for (const id of retries.keys()) if (!records.some((r) => r.job_id === id)) retries.delete(id);
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

/** How to start an export again, given by whoever started it: told the gentlest rung to start at, it queues a
 *  new export of the same project with the same settings. `processor` says the graphics chip failed it: the new export
 *  runs on the processor's own encoder, whatever the app would have chosen. */
export type ExportRetry = (
  minRung: Rung,
  failedRung: Rung,
  options: { store?: ProjectStoreAccess; processor?: true },
) => Promise<{ ok: boolean; error?: string; declined?: boolean }>;
const retries = new Map<string, ExportRetry>();

/** Offer a way to start this export again if it fails (the card's Try again). Only an export started in this
 *  session has one: a page that adopts an export has none of its settings to start again from. */
export function offerExportRetry(jobId: string, retry: ExportRetry): void {
  if (!records.some((r) => r.job_id === jobId)) return;
  retries.set(jobId, retry);
  patch(jobId, { canRetry: true });
}

/** The rungs Try again may step through on this export: the ones its command really has, and only the normal one
 *  while the switch for rungs is off (nothing gentler is then offered, and nothing is promised). */
export function ladderOfRecord(record: Pick<ExportRecord, "maxRung" | "ladder">): Ladder {
  if (!exportFlag("plan_rung")) return [0];
  return record.ladder ? cleanLadder(record.ladder) : denseLadder(record.maxRung);
}

/** The gentlest rung Try again may ask for on this export: the last of its ladder. */
export function gentlestRungOf(record: Pick<ExportRecord, "maxRung" | "ladder">): Rung {
  const ladder = ladderOfRecord(record);
  return ladder[ladder.length - 1];
}

/** Start a failed export again, one click: a new export (new job, same settings), one rung gentler after a
 *  failure for lack of memory or time, decided afresh by the plan after any other. The failed row goes once the
 *  new export is queued; when it is refused the row stays and says why, and the button may be pressed again.
 *  `store` is the project as it is open now: it replaces the one the export was asked on when that session has
 *  since ended (the project was closed and opened again). Nothing here retries by itself: the person asked. */
export async function retryExport(jobId: string, store?: ProjectStoreAccess): Promise<void> {
  const record = records.find((r) => r.job_id === jobId);
  const retry = retries.get(jobId);
  if (!record || !retry || record.state !== "failed" || record.retrying) return;
  patch(jobId, { retrying: true, note: undefined });
  const failedRung = rungOf(record.rung);
  // A failure only the chip can explain is tried again on the processor, from its normal rung: the processor has rungs
  // of its own. Any other failure steps down the rungs, as before.
  const processor = record.chipFailed === true;
  let result: Awaited<ReturnType<ExportRetry>>;
  try {
    result = await retry(
      processor ? 0 : retryRung(failedRung, failureOf(record.error).code, ladderOfRecord(record)),
      failedRung,
      { store, ...(processor ? { processor: true as const } : {}) },
    );
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (result.ok) {
    dismissExport(jobId);
    return;
  }
  // A question the person turned down is their own choice, not something that went wrong.
  patch(jobId, {
    retrying: undefined,
    note: result.declined ? undefined : `Could not start again: ${result.error ?? "unknown error"}`,
  });
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
  const now = Date.now();
  const feeds = useExportJob.getState();
  const waiting = records.filter((r) => r.state === "queued" && !r.cancelling);
  return records.map((r) => {
    // Each running export has its own feed: one that is still being checked or saved keeps saying so
    // while the next one renders.
    const running = r.state === "running" ? liveFeedOf(feeds, r.job_id) : null;
    const rendering = running !== null && running.stage === "rendering";
    const quiet = running ? quietSeconds(running, now) : 0;
    const left = running ? timeLeftSeconds(running, now) : null;
    const failure = r.state === "failed" ? failureOf(r.error) : null;
    return {
      job_id: r.job_id,
      filename: r.filename,
      state: r.state,
      ...(r.mediaRef ? { media_ref: r.mediaRef } : {}),
      ...(r.error ? { error: r.error } : {}),
      ...(r.warnings?.length ? { warnings: r.warnings } : {}),
      // How long the export itself took: from when its turn came, not from when it was asked for.
      ...(r.endedAt
        ? { duration_s: Math.round((r.endedAt - (r.ranAt ?? r.startedAt)) / 100) / 10 }
        : {}),
      // How long an unfinished export has been at it (or waiting), so an agent can judge it.
      ...(isOpen(r) ? { elapsed_s: Math.max(0, Math.round((now - r.startedAt) / 1000)) } : {}),
      // A cancel was asked and the export has not stopped yet.
      ...(r.cancelling && isOpen(r) ? { cancelling: true } : {}),
      // The setting it runs at, when it is below the normal one: why it may be slower.
      ...(r.rung ? { setting: RUNG_NAMES[r.rung] } : {}),
      // What it runs on, when that is not the processor's normal setting.
      ...(r.encoder && r.encoder !== "x264"
        ? { encoder: r.encoder === "x264_fast" ? "faster_setting" : "graphics_chip" }
        : {}),
      // Where the run is, for an export that is running: the stage, how far a render is and how long it
      // thinks is left, and for how long it has made no progress. The same facts the chat card shows.
      ...(running ? { stage: running.stage } : {}),
      ...(rendering && running.fraction !== null && Number.isFinite(running.fraction)
        ? { progress_percent: Math.round(Math.min(1, Math.max(0, running.fraction)) * 100) }
        : {}),
      ...(left !== null ? { time_left_s: Math.round(left) } : {}),
      ...(quiet >= QUIET_SECONDS ? { stalled_for_s: quiet } : {}),
      // A waiting export: its place in line (1 is next).
      ...(r.state === "queued" && !r.cancelling ? { queue_position: waiting.indexOf(r) + 1 } : {}),
      // A failed export: the reason as a code, and in plain words the person can act on.
      ...(failure
        ? {
            failure_code: failure.code,
            failure: r.chipFailed ? describeChipFailure("assistant") : failure.plain,
            ...(r.chipFailed ? { chip_failed: true } : {}),
          }
        : {}),
    };
  });
}

/** Where a tool-run export request came from, for its story: the in-app chat (the turn that asked is
 *  known), an outside assistant over MCP, or the Export menu (which runs the same tool with neither). */
export function exportVia(
  ctx: Pick<ClientToolContext, "origin" | "surface"> | null | undefined,
): "menu" | "chat" | "mcp" {
  if (ctx?.origin) return "chat";
  return ctx?.surface === "mcp" ? "mcp" : "menu";
}

/** A chip's maker as the trace says it: 1 AMD, 2 NVIDIA, 3 Intel, and 10 more for the 4K size class. */
const MAKER_CODES: Record<ChipMaker, number> = { amd: 1, nvidia: 2, intel: 3 };
export function makerCode(maker: ChipMaker, sizeClass?: SizeClass): number {
  return MAKER_CODES[maker] + (sizeClass === "uhd" ? 10 : 0);
}

const isChipEncoder = (encoder: string): encoder is ChipMaker =>
  (CHIP_MAKERS as readonly string[]).includes(encoder);

/** The graphics chip's part of an export's story (exportChoice.ts): its tests, the Mode row the person was shown, and the
 *  mode the export ran in. A PC with no chip has nothing to tell. */
function recordChoice(story: ExportStory, choice: ChoiceFacts): void {
  for (const test of choice.tests)
    story.trace.record("chip_test", test.result, makerCode(test.maker, test.sizeClass), test.ms);
  if (choice.shown)
    story.trace.record(
      "mode_shown",
      choice.shown,
      Math.round(choice.fullSeconds ?? 0),
      Math.round(choice.fastSeconds ?? 0),
    );
  if (choice.chip || choice.shown || choice.reason !== "none") {
    const onChip = isChipEncoder(choice.encoder);
    story.trace.record(
      "mode_selected",
      onChip ? "fast" : "full",
      Math.round((onChip ? choice.fastSeconds : choice.fullSeconds) ?? 0),
    );
  }
}

/** The words a hardware encoder's own errors use: its ffmpeg encoder name, its API, or the library it loads. */
const HARDWARE_ENCODER_WORDS = /\bh264_(?:amf|nvenc|qsv)\b|\b(?:amf|nvenc|qsv|mfx|nvcuda|cuda)\b/i;

/** The maker of the chip an export ran on, when how it failed is something a chip can cause and not the disk's, the
 *  sources', the PC's memory or the person's. A failure that is only "the render failed" is the chip's only when it names
 *  the chip's encoder: a broken source file or a filter that cannot be made fails the same way on any encoder. A file that
 *  did not pass its check, or a hang, cannot be told apart from the chip's fault and is taken as one: the processor is the
 *  encode that is known to work. */
export function chipFailureOf(choice: ChoiceFacts | undefined, error: string): ChipMaker | null {
  if (!choice || !isChipEncoder(choice.encoder)) return null;
  const code = failureOf(error).code;
  if (code === "verification_failed" || code === "time_limit") return choice.encoder;
  if ((code === "render_failed" || code === "unknown") && HARDWARE_ENCODER_WORDS.test(error))
    return choice.encoder;
  return null;
}

/** Say at once that a cancel was asked for this export, whether or not it has stopped yet. */
function markCancelling(jobId: string): void {
  const record = records.find((r) => r.job_id === jobId);
  if (record && isOpen(record) && !record.cancelling) patch(jobId, { cancelling: true });
}

/** What a cancel will say in the export's story: who, and where the export was at the moment it was asked
 *  (queued, or which stage and how far). Taken now, said later: the story must only tell a cancel that
 *  was accepted, and once, however many times the button is pressed. */
function captureCancel(jobId: string, by: ExportCanceller): (() => void) | null {
  const story = stories.get(jobId);
  if (!story || story.cancelNoted || story.stalledOut) return null;
  const queued = records.find((r) => r.job_id === jobId)?.state === "queued";
  const stage = STAGE_CODES[queued ? "queued" : story.stage];
  const percent = story.watch?.percentReached() ?? 0;
  return () => {
    if (story.cancelNoted || story.stalledOut) return;
    story.cancelNoted = true;
    story.trace.record("cancelled", by, stage, percent);
  };
}

/** Say in the export's story who stopped it and where it was, for a cancel already accepted. */
function noteCancelled(jobId: string, by: ExportCanceller): void {
  captureCancel(jobId, by)?.();
}

/** Stop an export. Returns false when it already finished — a settled job cannot be recalled.
 *  `by` says who stopped it, for the report's story: the person (in the export dialog, on the card,
 *  in the queue), the assistant, or the app itself (quitting). */
export function cancelExport(jobId: string, by: ExportCanceller = "app"): boolean {
  const c = controllers.get(jobId);
  if (!c) return false;
  const note = captureCancel(jobId, by);
  const port = deliveryPorts.get(jobId);
  if (port)
    // The cancel is said (in the row and in the story) once it was accepted: a refused one (the file was
    // already being saved) or one that never arrived must not leave a row that claims it is stopping while
    // it carries on, nor a story that says it was cancelled and then that it finished.
    void port
      .cancel(jobId)
      .then((cancelled) => {
        if (!cancelled) return;
        note?.();
        markCancelling(jobId);
        c.abort();
      })
      .catch(() => undefined);
  else {
    note?.();
    markCancelling(jobId);
    c.abort();
  }
  return true;
}

/** Stop an export whose render has stood still, through the delivery owner like every cancel: it ends the
 *  process and discards the staged file. A stop it refuses (the file is already being saved) leaves the export
 *  alone. One that cannot be asked at all still ends the export: nobody is helped by waiting on it. The stop
 *  that is accepted first tells the story: a person's cancel accepted earlier keeps it a cancel. */
function stopStalledExport(
  jobId: string,
  story: ExportStory,
  stall: NonNullable<ExportStory["stalledOut"]>,
): void {
  const c = controllers.get(jobId);
  if (!c) return;
  const stop = () => {
    if (!story.cancelNoted) story.stalledOut = stall;
    c.abort();
  };
  const port = deliveryPorts.get(jobId);
  if (!port) return stop();
  void port.cancel(jobId).then((cancelled) => {
    if (cancelled) stop();
  }, stop);
}

/** What the app says about an export it stopped for standing still (the words the failure is read from, see
 *  exportReason.ts: a time limit). */
function stalledMessage(kind: "frozen" | "slow_start", seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return kind === "frozen"
    ? `export stopped: it made no progress for ${minutes} min (stalled)`
    : `export stopped: it had not started making progress after ${minutes} min (stalled)`;
}

/** Why a cancel found nothing to stop, by how the export had already ended. */
const NOTHING_TO_CANCEL: Partial<Record<ExportState, string>> = {
  done: "that export had already finished; nothing to cancel",
  failed: "that export had already failed; nothing to cancel",
  cancelled: "that export was already cancelled",
};

/** Longest one `manage_exports` call waits for exports to end. */
export const MAX_EXPORT_WAIT_S = 60;

/** The wait a caller asked for, in ms: 0 (no wait, today's answer) unless it is a finite number
 *  above zero, never above {@link MAX_EXPORT_WAIT_S}. Anything else is not an error, just no wait
 *  (the same reading `inspect_media` gives its own `wait_seconds`). */
export function exportWaitMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.round(Math.min(raw, MAX_EXPORT_WAIT_S) * 1000);
}

const isOpen = (r: ExportRecord): boolean => r.state === "running" || r.state === "queued";

/** Resolve when no export (or, given `jobId`, that one) is running or queued, after at most `ms`,
 *  or when `signal` aborts (Stop). Always resolves: what it found is read afterwards. */
export function waitForExports(
  jobId: string | null,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  const open = (): boolean =>
    records.some((r) => (jobId === null || r.job_id === jobId) && isOpen(r));
  if (ms <= 0 || signal?.aborted || !open()) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      stop();
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const stop = subscribeExports(() => {
      if (!open()) finish();
    });
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/** What manage_exports adds to a list that still holds unfinished exports: the model is told not
 *  to poll, because a polling agent asked 237 times in one session. */
function unfinishedHint(open: number, waitedMs: number): Record<string, unknown> {
  const what = open === 1 ? "1 export is" : `${open} exports are`;
  return {
    retry_after_s: waitedMs > 0 ? MAX_EXPORT_WAIT_S : 15,
    note:
      waitedMs > 0
        ? `${what} still unfinished after waiting ${Math.round(waitedMs / 1000)} s. Do other work, or call manage_exports again with wait_seconds: it answers the moment they end.`
        : `${what} unfinished. Do not call this in a loop: pass wait_seconds (up to ${MAX_EXPORT_WAIT_S}) and it answers the moment they end.`,
  };
}

/** manage_exports: the only route to cancellation. Without it an async export could be started
 *  and never stopped, which is a capability the synchronous version had. `signal` is the turn's
 *  Stop: a wait ends the moment it fires. */
export async function manageExportsTool(
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const action = String(args.action ?? "list").trim() || "list";
  if (action === "list") {
    const only = String(args.job_id ?? "").trim() || null;
    if (only && !records.some((r) => r.job_id === only))
      return {
        ok: false,
        error: `no export with job_id '${only}' in this session; manage_exports action='list' shows them`,
      };
    const waitedMs = exportWaitMs(args.wait_seconds);
    await waitForExports(only, waitedMs, signal);
    const rows = listExportOutcomes().filter((r) => only === null || r.job_id === only);
    const open = rows.filter((r) => r.state === "running" || r.state === "queued").length;
    return { ok: true, exports: rows, ...(open > 0 ? unfinishedHint(open, waitedMs) : {}) };
  }
  if (action !== "cancel")
    return { ok: false, error: `unknown action '${action}'; use 'list' or 'cancel'` };

  const jobId = String(args.job_id ?? "").trim();
  if (!jobId) return { ok: false, error: "job_id is required to cancel an export" };
  const port = deliveryPorts.get(jobId);
  if (port && controllers.has(jobId)) {
    try {
      const cancelled = await port.cancel(jobId);
      if (cancelled) {
        noteCancelled(jobId, "assistant");
        markCancelling(jobId);
        controllers.get(jobId)?.abort();
      }
      return {
        ok: true,
        cancelled,
        ...(cancelled ? {} : { state: "done", note: "the verified export was already published" }),
      };
    } catch (error) {
      return { ok: false, error: `export cancellation could not be committed: ${String(error)}` };
    }
  }
  if (cancelExport(jobId, "assistant")) return { ok: true, cancelled: true };
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
  result?: Record<string, unknown>;
  constructor(
    message: string,
    readonly submitted: readonly ExportSubmission[],
    readonly status: "blocked" | "declined" | "cancelled" = "blocked",
    readonly workload?: RenderWorkload,
    /** What happened to the request before it was refused, for the refusal's report. */
    readonly story?: ExportStory,
  ) {
    super(message);
    this.name = "ExportRequestError";
  }
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
    readiness?: "ready" | "not_ready" | "unknown";
    /** The account that asked for this export, stamped when it is admitted so it travels with the
     *  job (and its native record) to the report, whoever is signed in when the export ends. */
    owner?: string;
    calibration?: Pick<
      ExportCalibration,
      "workload" | "output" | "quality" | "engine" | "encoder" | "revision" | "rung"
    >;
    /** What the plan decided when the command was captured (exportPlan.ts): the rung the export runs at and the
     *  numbers it was decided on. Absent for an export nothing planned (a copy, an adopted one). */
    plan?: {
      rung: 0 | 1 | 2;
      /** The gentlest rung this export's command really has, for Try again (render.ts `gentlestRung`). */
      max_rung?: 0 | 1 | 2;
      /** The rungs it really has (render.ts `ladderOf`), gentlest last: Try again steps to the next one on it. */
      ladder?: readonly (0 | 1 | 2)[];
      basis?: Plan["basis"];
      predicted_bytes?: number | null;
      free_bytes?: number | null;
      fits?: boolean;
      needed_free_bytes?: number | null;
    };
    /** How the encoder was chosen (exportChoice.ts): the story's chip test and mode events, the report's encoder, chip and
     *  reason, and the chip's device to set aside if it fails the export. */
    choice?: ChoiceFacts;
  };
  /** The app process's job supervisor, when the encode runs as one of its jobs (3h part 7). It
   *  keeps the order then, so this queue does not hold a job back, and a job's state comes from it. */
  supervisor?: JobSupervisor;
  /** A library file delivered as it is: no encode, and the delivered row names
   *  this library ref rather than cataloguing the same bytes a second time. */
  copyOf?: string;
  /** The account that asked for this export, captured as the request is submitted (before the
   *  confirmation, the native admission or any other wait, in any of which the signed-in account can
   *  change). It is what the export is reported under. A render also carries it in its telemetry meta
   *  so the native job record keeps it through a restart; a copy has no such record to put it in. */
  owner?: string;
  /** The export call this job is one file of (see {@link sealExportBatch}). */
  batch?: string;
  /** Where the request came from, for the report's story: the Export menu, the in-app chat or an
   *  outside assistant over MCP. */
  via?: "menu" | "chat" | "mcp";
  /** Set when this export is a Try again of one that failed: the rung that one ran at and the rung this one was
   *  asked to start at, so the story says so (the `retry` event). */
  retry?: { from: number; to: number };
  /** What happened to this export so far (see exportTrace.ts). Set by the queue when the request
   *  arrives; a caller leaves it out. */
  story?: ExportStory;
  /** Runs the encode. Rejects with a message on failure. `jobId` names the job everywhere: the
   *  ledger, this queue and the supervisor. */
  run: (
    signal: AbortSignal,
    jobId: string,
    meta: ExportSpec["meta"],
  ) => Promise<{ warnings?: string[] }>;
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
  spec: Pick<ExportSpec, "store" | "destPath" | "meta" | "supervisor" | "copyOf" | "owner"> & {
    jobId?: string;
    /** What happened to this export (see exportTrace.ts). Absent for one a later launch finished. */
    story?: ExportStory;
    startedBy?: ExportStarter;
  },
  outcome: {
    status: "done" | "failed" | "cancelled";
    elapsedMs: number;
    warnings: number;
    error: string;
    finalSizeBytes?: number;
    /** A later launch of the app finished this export (see `finishAdopted`). */
    recovered?: boolean;
  },
): Promise<void> {
  try {
    // Read first and for every outcome: the app process still holds the job here, and the span it
    // measured is the only run time that excludes the time the app was not running.
    const native =
      spec.supervisor && spec.jobId
        ? (await spec.supervisor.list()).find((view) => view.id === spec.jobId)
        : null;
    const activeMs =
      native && native.started_at !== null && native.ended_at !== null
        ? Math.max(0, native.ended_at - native.started_at)
        : 0;
    // What the app process printed at the end of the run: the memory it used and the limits it ran
    // under. One reading serves the estimate below and the report.
    const stderr = native ? jobStderr(native) : "";
    const facts = parseNativeDiagnostics(stderr);
    // Only a delivered file has a size; a failed encode leaves nothing to measure.
    const size =
      outcome.status === "done"
        ? (outcome.finalSizeBytes ?? (await spec.store.byteSize(spec.destPath)) ?? 0)
        : 0;
    // A recovered export's elapsed time spans however long the app was closed. The estimator keeps
    // the MAXIMUM of the matching samples, so one such run would make every later estimate for
    // that kind of project read as days.
    if (
      outcome.status === "done" &&
      !spec.copyOf &&
      !outcome.recovered &&
      spec.meta?.calibration &&
      size > 0
    ) {
      const queuedMs = native?.started_at ? Math.max(0, native.started_at - native.queued_at) : 0;
      useExportJob.getState().rememberCalibration({
        ...spec.meta.calibration,
        elapsedSeconds: Math.max(0, outcome.elapsedMs - queuedMs) / 1000,
        finalBytes: size,
        memoryBytes: facts.residentPeakBytes ?? null,
        temporaryBytes: facts.temporaryPeakBytes ?? null,
      });
    }
    // Which limit ended a failed export, and how it ended: the last lines of the story.
    const limit: ExportLimit | undefined =
      outcome.status === "failed"
        ? limitThatFired(`${outcome.error}\n${stderr}`, facts)
        : undefined;
    const story = spec.story;
    if (story) {
      if (limit && limit !== "other")
        story.trace.record(
          "guard_tripped",
          limit === "os" ? "os_refusal" : limit,
          mibBand(facts.residentPeakBytes) ?? 0,
          mibBand(facts.residentLimitBytes) ?? 0,
        );
      story.trace.record("outcome", outcome.status, Math.round(outcome.elapsedMs / 1000), 0);
    }
    const engine = spec.meta?.calibration?.engine;
    const choice = spec.meta?.choice;
    const { reportExport } = await import("../api/exportEvents");
    await reportExport({
      status: outcome.status,
      operation: spec.copyOf ? "copy" : "render",
      readiness: spec.meta?.readiness ?? "unknown",
      duration_s: spec.meta?.duration_s ?? 0,
      size_bytes: size,
      elapsed_ms: outcome.elapsedMs,
      active_ms: activeMs,
      recovered: outcome.recovered === true,
      width: spec.meta?.project_width ?? spec.meta?.width ?? 0,
      height: spec.meta?.project_height ?? spec.meta?.height ?? 0,
      fps: spec.meta?.fps ?? 0,
      quality: spec.meta?.quality ?? "",
      warnings: outcome.warnings,
      error: outcome.error,
      project_id: spec.meta?.project_id ?? "",
      visual_layers: spec.meta?.visual_layers,
      owner: spec.owner ?? spec.meta?.owner,
      ...(story ? { trace: story.trace.snapshot() } : {}),
      ...(engine
        ? { engine: (engine === "partition-pipes-v1" ? "streamed" : "one_pass") as ExportEngine }
        : {}),
      ...(limit ? { limit } : {}),
      ...(choice
        ? {
            encoder: choice.encoder,
            ...(choice.chip ? { chip: choice.chip } : {}),
            mode_reason: choice.reason,
          }
        : {}),
      ...(spec.startedBy ? { started_by: spec.startedBy } : {}),
      peak_resident_mib: mibBand(facts.residentPeakBytes),
      peak_commit_mib: mibBand(facts.commitPeakBytes),
      resident_limit_mib: mibBand(facts.residentLimitBytes),
      commit_limit_mib: mibBand(facts.commitLimitBytes),
      ram_total_gib: story?.ramTotalGib,
      ram_free_gib: story?.ramFreeGib,
      longest_gap_s: story?.longestGapS,
    });
  } catch {
    /* telemetry is never worth disturbing a finished export over */
  }
}

/** Tests only. */
export function __resetExportQueue(): void {
  stories.clear();
  retries.clear();
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

/** What the pre-start check found, measured now. */
interface Preflight {
  picture: PreflightPicture;
  /** Whether the room for the files is established (the readiness the export records). */
  storageReady: boolean;
}

/** The smallest of the numbers that are known, or null when none is. */
function least(values: ReadonlyArray<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? Math.min(...known) : null;
}

/** Measure the PC and the requested exports and say what the check found. Everything is read afresh,
 *  so closing programs or freeing space between two calls really counts. */
async function measurePreflight(
  specs: readonly ExportSpec[],
  refuse: (status: "cancelled" | "declined" | "blocked") => Promise<never>,
): Promise<Preflight> {
  const checks: ExportAssessment[] = [];
  const plans: Array<Plan | undefined> = [];
  const snapshots: ExportResources[] = [];
  for (const spec of specs) {
    if (spec.submissionSignal?.aborted || !spec.store.sessionLive()) return refuse("cancelled");
    const resources = await resolveExportResources(spec.destPath, spec.submissionSignal);
    snapshots.push(resources);
    spec.story?.noteMachine(resources);
    const workload = spec.workload ?? {
      width: spec.meta?.project_width ?? spec.meta?.width ?? 0,
      height: spec.meta?.project_height ?? spec.meta?.height ?? 0,
      fps: spec.meta?.fps ?? 0,
      durationSeconds: spec.meta?.duration_s ?? 0,
      visualClips: 0,
      captionClips: 0,
      audioClips: 0,
      peakVisualLayers: spec.meta?.visual_layers ?? 0,
      peakMediaLayers: 0,
    };
    const descriptor = spec.meta?.calibration;
    const estimates = descriptor
      ? estimateExport(
          workload,
          descriptor.output,
          descriptor.quality,
          descriptor.engine,
          useExportJob.getState().calibrations,
          descriptor.encoder,
        )
      : { memoryBytes: null, temporaryBytes: null, finalBytes: null, seconds: null };
    // The memory verdict is about the rung the command was CAPTURED at (it cannot change now): does that rung
    // fit what the PC has free right now? An export nothing planned keeps today's rule.
    const memoryPlan =
      descriptor && exportFlag("plan_rung")
        ? (() => {
            const captured = rungOf(spec.meta?.plan?.rung);
            return planRung({
              samples: peakSamples(
                workload,
                descriptor.output,
                descriptor.quality,
                descriptor.engine,
                useExportJob.getState().calibrations,
                descriptor.encoder,
              ),
              freeBytes: resources.available_memory_bytes,
              minRung: captured,
              maxRung: captured,
            });
          })()
        : undefined;
    plans.push(memoryPlan);
    checks.push(assessExport(workload, resources, estimates, resources.budgets, memoryPlan));
  }
  if (specs.some((spec) => spec.submissionSignal?.aborted || !spec.store.sessionLive()))
    return refuse("cancelled");
  const reasons = new Set(
    // A copy renders nothing: it has no size, rate or length to be outside what ArtDaddy was tested with
    // (its zero workload is "unknown", not "huge"), so that finding is not raised for it.
    checks.flatMap((check, index) =>
      specs[index].copyOf
        ? check.reasons.filter((reason) => reason !== "outside_promise")
        : check.reasons,
    ),
  );
  let spaceNeeded: number | null = null;
  let destinationShort = false;
  let scratchShort = false;
  if (
    checks.every(
      (check) => check.estimates.temporaryBytes !== null && check.estimates.finalBytes !== null,
    )
  ) {
    const temporary = checks.reduce((total, check) => total + check.estimates.temporaryBytes!, 0);
    const final = checks.reduce((total, check) => total + check.estimates.finalBytes!, 0);
    spaceNeeded = temporary + final;
    destinationShort = snapshots.some(
      (snapshot) =>
        snapshot.destination_free_bytes !== null && spaceNeeded! > snapshot.destination_free_bytes,
    );
    scratchShort = snapshots.some(
      (snapshot) =>
        snapshot.scratch_free_bytes !== null && spaceNeeded! > snapshot.scratch_free_bytes,
    );
    if (destinationShort || scratchShort) reasons.add("disk_shortage");
    if (
      snapshots.some(
        (snapshot) =>
          snapshot.budgets.temporaryBytes !== null &&
          spaceNeeded! > snapshot.budgets.temporaryBytes,
      )
    )
      reasons.add("temporary_limit");
  }
  const storageReady = !["disk_unknown", "disk_shortage", "temporary_limit"].some((reason) =>
    reasons.has(reason as (typeof checks)[number]["reasons"][number]),
  );
  // The export that is furthest over what it may use now: what it needs and what there is.
  let memoryNeeded: number | null = null;
  let memoryUsable: number | null = null;
  checks.forEach((check, index) => {
    const plan = plans[index];
    if (plan) {
      // Under a plan the need is the free memory the captured rung asks for (its peak over the share of
      // free memory an export may use), so "needed" is above "available" exactly when the verdict is short.
      const free = snapshots[index].available_memory_bytes;
      if (plan.fits || plan.neededFreeBytes === null || free === null) return;
      if (memoryNeeded === null || plan.neededFreeBytes - free > memoryNeeded - memoryUsable!) {
        memoryNeeded = plan.neededFreeBytes;
        memoryUsable = free;
      }
      return;
    }
    const needed = check.estimates.memoryBytes;
    const free = snapshots[index].available_memory_bytes;
    const limit = snapshots[index].budgets.memoryBytes;
    if (needed === null || free === null || limit === null) return;
    const usable = Math.min(free, limit);
    if (
      needed > usable &&
      (memoryNeeded === null || needed - usable > memoryNeeded - memoryUsable!)
    ) {
      memoryNeeded = needed;
      memoryUsable = usable;
    }
  });
  const shortDestination = snapshots.findIndex(
    (snapshot) =>
      spaceNeeded !== null &&
      snapshot.destination_free_bytes !== null &&
      spaceNeeded > snapshot.destination_free_bytes,
  );
  const seconds = checks.every((check) => check.estimates.seconds !== null)
    ? checks.reduce((total, check) => total + check.estimates.seconds!, 0)
    : null;
  return {
    storageReady,
    picture: {
      via: specs[0].via ?? (specs[0].origin ? "chat" : "other"),
      count: specs.length,
      reasons,
      memoryNeededBytes: memoryNeeded,
      memoryUsableBytes: memoryUsable,
      spaceNeededBytes: spaceNeeded,
      destinationFreeBytes: least(snapshots.map((snapshot) => snapshot.destination_free_bytes)),
      scratchFreeBytes: least(snapshots.map((snapshot) => snapshot.scratch_free_bytes)),
      destinationShort,
      scratchShort,
      drive: driveOf(specs[Math.max(0, shortDestination)].destPath),
      seconds,
      secondsGuessed: checks.some((check) => check.estimates.secondsGuessed === true),
      executionLimitSeconds: least(snapshots.map((snapshot) => snapshot.budgets.executionSeconds)),
    },
  };
}
/** How many times one request may be asked before it is refused. A person can press Continue as often
 *  as they like; a program answering for them must not loop for ever. */
const MAX_QUESTION_ROUNDS = 100;

/** Who answered, as the number a trace event carries. */
const ANSWERER_CODE = { dialog: 1, card: 2, assistant: 3, app: 4 } as const;

/** One signal for a request of several exports: it aborts when any of theirs does. */
function requestSignal(specs: readonly ExportSpec[]): AbortSignal | undefined {
  const signals = specs
    .map((spec) => spec.submissionSignal)
    .filter((signal): signal is AbortSignal => signal !== undefined);
  if (signals.length <= 1) return signals[0];
  const joined = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) joined.abort();
    else signal.addEventListener("abort", () => joined.abort(), { once: true });
  }
  return joined.signal;
}

/** Put a question to the person in the dialog and wait. The story of every export in the request
 *  says which screen it was, how big the problem was, who answered and how long it took. */
async function askInDialog(
  specs: readonly ExportSpec[],
  question: ExportQuestion,
): Promise<QuestionOutcome> {
  for (const spec of specs)
    spec.story?.trace.record("dialog_shown", question.code, question.bands.n, question.bands.m);
  const outcome = await askQuestion(question, {
    projectDir: specs[0].store.projectDir,
    signal: requestSignal(specs),
    onIgnored: (answer, by, winner) => {
      for (const spec of specs)
        spec.story?.trace.record(
          "answer_ignored",
          answer,
          ANSWERER_CODE[by],
          ANSWERER_CODE[winner],
        );
    },
  });
  for (const spec of specs)
    spec.story?.trace.record(
      "dialog_choice",
      outcome.answer === "aborted" || outcome.answer === "unavailable" ? "dismiss" : outcome.answer,
      Math.round(outcome.waitedMs / 1000),
      ANSWERER_CODE[outcome.by],
    );
  return outcome;
}

/** The same question as a native message box, for when no dialog is mounted to ask it. A native box
 *  has two buttons and cannot be closed from code, so it is asked once and never repeats. */
async function askNatively(
  specs: readonly ExportSpec[],
  question: ExportQuestion,
): Promise<"continue" | "cancel" | "unavailable"> {
  for (const spec of specs)
    spec.story?.trace.record("dialog_shown", question.code, question.bands.n, question.bands.m);
  const started = Date.now();
  const { message, warning } = questionAsText(question);
  const decision = await confirmExport(message, warning);
  for (const spec of specs)
    spec.story?.trace.record(
      "dialog_choice",
      decision === "continue" ? "continue" : decision === "cancel" ? "cancel" : "dismiss",
      Math.round((Date.now() - started) / 1000),
      ANSWERER_CODE.dialog,
    );
  return decision;
}

/** Check the request before anything is admitted, and ask the person about what they can fix: not
 *  enough free memory, not enough room on a drive, a heads-up. One question at a time, and after
 *  *Continue* on a memory or space question the PC is measured again, so closing programs or freeing
 *  space really counts and a repeat is the same question with the new numbers. Resolves with whether the
 *  room for the files is established; throws {@link ExportRequestError} when nothing may start. */
async function confirmExportRequest(specs: readonly ExportSpec[]): Promise<boolean> {
  const refuse = async (status: "cancelled" | "declined" | "blocked"): Promise<never> => {
    throw new ExportRequestError(
      status === "blocked"
        ? "export could not be confirmed; no job was submitted"
        : "export cancelled before submission",
      [],
      status,
      specs[0].workload,
      specs[0].story,
    );
  };
  const stopped = () =>
    specs.some((spec) => spec.submissionSignal?.aborted || !spec.store.sessionLive());
  // The plan's choice is part of every export's story, once, before anything is asked.
  for (const spec of specs) {
    const plan = spec.meta?.plan;
    if (plan && spec.story)
      spec.story.trace.record(
        "plan_chosen",
        RUNG_NAMES[rungOf(plan.rung)],
        bandOf(plan.predicted_bytes ?? null),
        bandOf(plan.free_bytes ?? null),
      );
    if (spec.meta?.choice && spec.story) recordChoice(spec.story, spec.meta.choice);
  }
  // What the person already waived with *Start anyway*: not asked again in this request.
  const waived = new Set<ExportQuestionKind>();
  for (let round = 0; round < MAX_QUESTION_ROUNDS; round++) {
    const { picture, storageReady } = await measurePreflight(specs, refuse);
    const questions = planQuestions(picture, waived);
    if (questions.length === 0) return storageReady;
    if (!hostMounted()) {
      for (const question of questions) {
        const decision = await askNatively(specs, question);
        if (stopped()) return refuse("cancelled");
        if (decision === "cancel") return refuse("declined");
        if (decision === "unavailable") return refuse("blocked");
      }
      return storageReady;
    }
    const question = questions[0];
    const outcome = await askInDialog(specs, question);
    if (stopped()) return refuse("cancelled");
    switch (outcome.answer) {
      case "cancel":
        return refuse("declined");
      case "aborted":
        return refuse("cancelled");
      case "unavailable":
        return refuse("blocked");
      case "start_anyway":
        waived.add(question.kind);
        break;
      case "continue":
        // A notice is a heads-up, not a shortage: nothing to measure again.
        if (question.kind === "notice") return storageReady;
        break;
    }
  }
  return refuse("blocked");
}

export async function submitExports(request: readonly ExportSpec[]): Promise<ExportSubmission[]> {
  if (!request.length || request.length > 50)
    throw new Error("one export request must contain between 1 and 50 files");
  // Which of the exporter's safety behaviours the server has switched off: asked beside the export, never
  // waited for. What it says applies from the next decision (a stall stop reads it at every tick).
  void refreshExportFlags();
  // Decided now, before the first await: the confirmation, the native admission and the render all
  // take time, and the signed-in account can change in any of them.
  const owner = exportOwnerNow();
  const specs = request.map((spec) => ({
    ...spec,
    ...(spec.owner || owner ? { owner: spec.owner || owner } : {}),
    dependencies: [...spec.dependencies],
    ...(spec.meta ? { meta: structuredClone(spec.meta) } : {}),
    ...(spec.workload ? { workload: structuredClone(spec.workload) } : {}),
    story: spec.story ?? new ExportStory(),
  }));
  // The story starts with who asked, and whether this is a second try of one that failed.
  for (const spec of specs) {
    spec.story.trace.record("requested", spec.via ?? (spec.origin ? "chat" : "other"));
    if (spec.retry) spec.story.trace.record("retry", "try_again", spec.retry.from, spec.retry.to);
  }
  const destinations = new Set<string>();
  const projectDir = specs[0].store.projectDir;
  for (const spec of specs) {
    if (spec.store.projectDir !== projectDir)
      throw new Error("one export request belongs to one project");
    if (spec.stagePath === spec.destPath || !spec.store.canRename)
      throw new Error(
        "export requires atomic destination-volume staging; direct-output fallback is not supported",
      );
    const key = normalizeDest(spec.destPath);
    if (reserved.has(key) || destinations.has(key))
      throw new Error("export destination is already reserved");
    destinations.add(key);
  }
  const storageReady = await confirmExportRequest(specs);
  const submitted: ExportSubmission[] = [];
  try {
    for (const spec of specs) submitted.push(await admitExport(spec, storageReady));
  } catch (error) {
    const failed = specs[submitted.length];
    throw new ExportRequestError(
      error instanceof Error ? error.message : String(error),
      [...submitted],
      failed.submissionSignal?.aborted || !failed.store.sessionLive() ? "cancelled" : "blocked",
      failed.workload,
      failed.story,
    );
  }
  return submitted;
}

async function admitExport(spec: ExportSpec, storageReady: boolean): Promise<ExportSubmission> {
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
    await runProjectMutation(
      spec.store.projectDir,
      "admit confirmed export",
      async (_document, lease) => {
        if (!spec.store.sessionLive() || spec.submissionSignal?.aborted)
          throw new Error("export belongs to a closed or cancelled request");
        lease?.assertCanCommit();
        if (spec.outputDirectory) {
          if (
            normalizeDest(spec.outputDirectory) !==
            normalizeDest(spec.destPath.replace(/[\\/][^\\/]+$/, ""))
          )
            throw new Error("export output folder differs from its captured destination");
          try {
            await spec.store.ensureDir(spec.outputDirectory);
          } catch (error) {
            throw new Error(`could not make the folder ${spec.outputDirectory}: ${String(error)}`);
          }
          lease?.assertCanCommit();
        }
        jobId = await ledger.begin({
          kind: "export",
          tool: "export",
          label: `the export ${spec.filename}`,
          ...(session ? { session } : {}),
        });
        const copyPath = spec.copyOf ? await spec.store.resolveMediaRef(spec.copyOf) : null;
        if (spec.copyOf && !copyPath) throw new Error("copy export source is unavailable");
        lease?.assertCanCommit();
        await port.prepare(
          jobId,
          spec.store.projectDir,
          spec.stagePath,
          spec.destPath,
          spec.copyOf
            ? { kind: "copy", path: copyPath!, media_ref: spec.copyOf }
            : { kind: "render", paths: [...spec.dependencies] },
        );
        lease?.assertCanCommit();
        if (!spec.store.sessionLive() || spec.submissionSignal?.aborted)
          throw new Error("export cancelled during native preparation");
        if (spec.meta) {
          spec.meta = {
            ...spec.meta,
            readiness: storageReady ? "ready" : "unknown",
            ...(spec.owner ? { owner: spec.owner } : {}),
          };
        }
        lease?.markCommitted();
      },
      { origin: spec.origin, signal: spec.submissionSignal },
    );
  } catch (error) {
    reserved.delete(key);
    if (jobId) {
      const retired = await port.cancel(jobId).catch(() => false);
      if (retired) await port.complete(jobId).catch(() => false);
      await ledger.settle(jobId, {
        status:
          spec.submissionSignal?.aborted || !spec.store.sessionLive() ? "cancelled" : "failed",
        error: String(error),
      });
    }
    throw error;
  }
  deliveryPorts.set(jobId, port);
  controllers.set(jobId, new AbortController());
  if (spec.batch) batchOf(spec.batch).open++;
  const queuePosition = Math.max(0, reserved.size - 1);
  if (spec.story) {
    stories.set(jobId, spec.story);
    if (queuePosition > 0) spec.story.trace.record("queued", "", queuePosition);
  }
  records.push({
    job_id: jobId,
    filename: spec.filename,
    destPath: spec.destPath,
    projectDir: spec.store.projectDir,
    state: queuePosition === 0 ? "running" : "queued",
    ...(rungOf(spec.meta?.plan?.rung) > 0 ? { rung: rungOf(spec.meta?.plan?.rung) as 1 | 2 } : {}),
    ...(spec.meta?.plan?.max_rung !== undefined
      ? { maxRung: rungOf(spec.meta.plan.max_rung) }
      : {}),
    ...(spec.meta?.plan?.ladder ? { ladder: cleanLadder(spec.meta.plan.ladder) } : {}),
    ...(spec.meta?.choice && spec.meta.choice.encoder !== "x264"
      ? { encoder: spec.meta.choice.encoder, reason: spec.meta.choice.reason }
      : {}),
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
  const story = spec.story;

  const run: RunOutcome = { error: null, cancelled: false, warnings: [] };
  let finishActivity: (() => void) | null = null;
  let unfollow: (() => void) | undefined;
  let watchTimer: ReturnType<typeof setInterval> | undefined;
  let begun = false;
  // The export's turn has come (the supervisor started it, or it runs in the page): the story says
  // how long it waited, and a watch on its run starts. Once.
  const begin = (): void => {
    if (begun) return;
    begun = true;
    patch(jobId, { ranAt: Date.now() });
    if (!story) return;
    const waited = Math.round(
      (Date.now() - (records.find((r) => r.job_id === jobId)?.startedAt ?? startedAt)) / 1000,
    );
    if (waited >= 1 && !spec.copyOf) story.trace.record("dequeued", "", waited);
    story.enter("preparing");
    if (spec.copyOf) return;
    // The card follows this export from now on: its stage as the story moves through it, its progress
    // as the reporters publish it. Ended when the export settles.
    useExportJob.getState().beginLive(jobId);
    story.onEnter = (stage) => useExportJob.getState().setLiveStage(jobId, stage);
    // Only a run the supervisor follows has progress to watch; one that runs in the page alone is never
    // stopped for silence, because its silence is the page's not reporting, not the render standing still.
    const stallPolicy = spec.supervisor
      ? {
          enforce: () => exportFlag("stall_stop"),
          onStall: (kind: "frozen" | "slow_start", seconds: number) =>
            stopStalledExport(jobId, story, { kind, seconds }),
        }
      : undefined;
    story.watch = new RunWatch(
      story.trace,
      Math.max(0, (spec.meta?.duration_s ?? 0) * 1000),
      Date.now,
      () => story.enter("rendering"),
      stallPolicy,
    );
    watchTimer = setInterval(() => story.watch?.tick(), WATCH_TICK_MS);
  };
  // The render ended, however it ended: the watch's last word, before the checks that follow it
  // (which take their own time and are not the render standing still).
  const endWatch = (): void => {
    if (watchTimer !== undefined) clearInterval(watchTimer);
    watchTimer = undefined;
    if (story?.watch && story.longestGapS === undefined) story.longestGapS = story.watch.finish();
  };
  try {
    // Cancelled while still queued: never start an encode nobody is waiting for.
    if (signal.aborted) throw new Error("export cancelled");
    if (spec.supervisor)
      unfollow = spec.supervisor.subscribe(
        (v) => {
          if (v.id !== jobId) return;
          if (v.state === "running") {
            patch(jobId, { state: "running" });
            begin();
          } else if (v.state === "exited") {
            // The render process is over. What follows (the check that decodes the whole file, run
            // outside the supervisor and so silent, then the save) is not the render standing still,
            // and a cancel from here on happens while checking.
            endWatch();
            if (!v.killed && v.code === 0) story?.enter("checking");
          }
        },
        (id, chunk) => {
          if (id === jobId) story?.watch?.chunk(chunk);
        },
      );
    else {
      patch(jobId, { state: "running" });
      begin();
    }
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
      try {
        run.warnings = (await spec.run(signal, jobId, spec.meta)).warnings ?? [];
      } finally {
        endWatch();
      }
    }
    if (signal.aborted) throw new Error("export cancelled");
    const port = deliveryPorts.get(jobId);
    if (!port) throw new Error("export delivery owner is missing");
    story?.enter("checking");
    await port.verify(jobId);
    if (signal.aborted) throw new Error("export cancelled");
  } catch (e) {
    // A killed ffmpeg reports its own confusing error; the reason the user needs is the cancel. Unless the
    // app stopped it for standing still before anyone cancelled: that is a failure, and says so.
    run.cancelled = signal.aborted;
    const stalledOut = run.cancelled ? story?.stalledOut : undefined;
    if (stalledOut) run.cancelled = false;
    run.error = run.cancelled
      ? "export cancelled"
      : stalledOut
        ? stalledMessage(stalledOut.kind, stalledOut.seconds)
        : e instanceof Error
          ? e.message
          : String(e);
    if (!run.cancelled && e instanceof ExportRunError) run.stderrTail = e.stderrTail;
  } finally {
    unfollow?.();
    endWatch();
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
    owner: spec.owner,
    startedBy: spec.origin ? "chat" : "elsewhere",
    startedAt,
    ledger,
    supervisor: spec.supervisor,
    copyOf: spec.copyOf,
    batch: spec.batch,
    run,
    story,
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
  /** The account that asked for the export (an adopted render carries it in `meta`). */
  owner?: string;
  startedBy: "chat" | "elsewhere";
  startedAt: number;
  ledger: Ledger;
  supervisor?: JobSupervisor;
  copyOf?: string;
  batch?: string;
  run: RunOutcome;
  /** What happened to this export so far, to be finished and reported (absent for an adopted one). */
  story?: ExportStory;
  /** A later launch of the app is finishing this export; see `finishAdopted`. */
  recovered?: boolean;
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
      x.story?.enter("saving");
      // An adopted export has no story to move the card along.
      if (!x.story) useExportJob.getState().setLiveStage(x.jobId, "saving");
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
  stories.delete(x.jobId);
  // The run is over (after the stages of checking and saving): the card has no live export any more.
  useExportJob.getState().endLive(x.jobId);
  // A failure only a chip can explain sets that chip aside for a day and is told once, in the story, before its end.
  const chipFailure = error && !cancelled ? chipFailureOf(x.meta?.choice, error) : null;
  if (chipFailure) {
    if (x.meta?.choice?.adapter) markChipSuspect(x.meta.choice.adapter);
    x.story?.trace.record(
      "chip_failed",
      "chip",
      makerCode(chipFailure),
      Math.round((Date.now() - x.startedAt) / 1000),
    );
  }
  patch(x.jobId, {
    state: error ? (cancelled ? "cancelled" : "failed") : "done",
    endedAt: Date.now(),
    error: error && !cancelled ? error : undefined,
    ...(chipFailure ? { chipFailed: true as const } : {}),
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
  {
    const beacon = reportSettledExport(x, {
      status: error ? (cancelled ? "cancelled" : "failed") : "done",
      finalSizeBytes: publishedIdentity?.size,
      elapsedMs: Date.now() - x.startedAt,
      warnings: warnings.length,
      error: error && !cancelled ? error : "",
      recovered: x.recovered,
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
        projectDir: m.projectDir,
        state: v.state === "queued" ? "queued" : "running",
        startedAt: m.submittedAt || v.queued_at,
        ...(v.state !== "queued" && v.started_at ? { ranAt: v.started_at } : {}),
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
      if (c.id === v.id && c.state === "running")
        patch(v.id, { state: "running", ranAt: c.started_at ?? Date.now() });
    });
    if (v.state === "running" && m.plan) {
      useExportJob.getState().begin(() => cancelExport(v.id));
      // The card follows it too: this page took the export over, so it is running now.
      useExportJob.getState().beginLive(v.id);
      useExportJob.getState().setLiveStage(v.id, "rendering");
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
    // The process is over; the file is checked next. Without this the card would go on saying the render
    // has made no progress for as long as the check takes.
    useExportJob.getState().setLiveStage(v.id, "checking");
  }
  const ctx = contextFor(m.projectDir);
  const ledger = await openProjectJobs(ctx.store);
  // The ledger closes a job's record as `interrupted` when the app LAUNCH that owned it is gone, and
  // keeps it `running` when only the page died (the app process still holds the job). So an
  // interrupted record here means an earlier run of the app ended mid-export -- a crash, a
  // force-quit, a shutdown, a power cut -- and this launch is finishing what it left.
  const recovered = ledger
    .list()
    .some((record) => record.id === v.id && record.status === "interrupted");
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
    recovered,
  });
  const done = records.find((r) => r.job_id === v.id);
  if (done && useExportJob.getState().abort && done.state !== "running" && done.state !== "queued")
    useExportJob.getState().finish({
      phase: done.state === "done" ? "done" : done.state === "cancelled" ? "cancelled" : "failed",
      savedTo: done.state === "done" ? m.destPath : null,
      error: done.error ?? null,
    });
}
