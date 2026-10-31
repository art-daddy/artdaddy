// Submitting long-running generation, and owning what happens after the turn ends.
//
// The tool returns a placeholder the moment the request is away, so the agent can keep working
// (or place the clip) instead of blocking for tens of seconds. What is left is a continuation
// nobody is awaiting, which needs an owner for three reasons: an unowned promise can be collected
// mid-flight, an unhandled rejection is a crash, and tests need something to await.
//
// The continuation deliberately runs WITHOUT the turn's AbortSignal. Stop and project-close both
// abort that signal, and cancelling the fetch would throw away media the vendor has already been
// paid for -- the money is committed at submit, so abandoning the result is pure loss. This is
// also why generation must not stay a `cancelOnClose` job.
import { JobLedger, JobLedgerUnreadableError, type JobRecord } from "../project/jobLedger";
import { ProjectClosingError, type MutationOrigin } from "../project/MutationGate";
import type { AiProxyResult } from "../api/ai";
import { reportAppError } from "../api/appEvents";
import { apiBase } from "../api/config";
import { signedInUser } from "../api/exportOwner";
import { CreditLimitError, getUsage, refreshUsage } from "../api/usage";
import {
  ackOrder,
  acknowledgeAcceptedOrder,
  downloadOrderResult,
  isOrderVerdict,
  newOrderId,
  OrderNotFoundError,
  orderPolling,
  OrderWaitSuspended,
  waitForOrder,
} from "../api/orders";
import { notifyJobSettled } from "../store/jobNotes";
import {
  decodeGenerated,
  GeneratedResultError,
  isResultTool,
  type GeneratedOutput,
  type ResultTool,
} from "./generationResults";
import {
  failPendingClip,
  failUnownedPendingClips,
  finalizePendingClip,
  newPendingMediaId,
  pendingMediaState,
  reconcilePendingMedia,
  registerPendingClip,
} from "./import";
import type { ProjectStoreAccess } from "./store";

export type { GeneratedOutput } from "./generationResults";

/** One ledger per project dir for the life of the process. A second instance would race the
 *  first on writes, and reopening a project whose jobs are still running must see the SAME
 *  records rather than re-read a stale file. */
const ledgers = new Map<string, Promise<JobLedger>>();

/** In-flight continuations. Held so the runtime cannot collect one mid-flight. */
const inflight = new Set<Promise<unknown>>();

/** Provider calls are the scarce resource: one account, one network, and a server that
 *  rate-limits within a SINGLE replica. Firing a batch of ten at once earns 429s, not ten
 *  videos. Queueing costs the model nothing — the placeholder and the ledger row already
 *  exist by then, so a queued job is indistinguishable from a slow one. */
const MAX_CONCURRENT_GENERATIONS = 3;

/** ...and per MODEL. The quota that actually bites is per model id: firing six at one model
 *  earned 429s on twelve of sixteen calls, while the same six spread across four models all
 *  succeeded. A single global cap cannot express that, so a batch aimed at one model still
 *  overran it — and the guidance tells the agent to fire independent generations together. */
const MAX_CONCURRENT_PER_MODEL = 2;

/** How long a provider call may stay unresolved before the job is failed.
 *
 *  A generation with no ceiling can sit in `generating` forever: one shot did, for 15+ minutes,
 *  while its siblings finished in ~50s. It held no quota slot, so it was an orphaned record
 *  rather than live work — but nothing could tell "slow" from "dead", and anything waiting on
 *  the ref waited for good. Generous on purpose: this is a backstop against a lost job, not a
 *  latency budget. It cannot cancel the provider call, only stop the JOB being unresolvable. */
const GENERATION_DEADLINE_MS = 20 * 60_000;

let slotsUsed = 0;
const slotWaiters: (() => void)[] = [];
const perModelUsed = new Map<string, number>();
const perModelWaiters = new Map<string, (() => void)[]>();

function acquireSlot(): Promise<void> {
  if (slotsUsed < MAX_CONCURRENT_GENERATIONS) {
    slotsUsed += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => slotWaiters.push(resolve));
}

function releaseSlot(): void {
  // Hand the slot straight to the next waiter rather than freeing it: dropping to N-1 first
  // would let a job submitted later overtake the queue.
  const next = slotWaiters.shift();
  if (next) next();
  else slotsUsed -= 1;
}

function acquireModelSlot(model: string | undefined): Promise<void> {
  if (!model) return Promise.resolve();
  const used = perModelUsed.get(model) ?? 0;
  if (used < MAX_CONCURRENT_PER_MODEL) {
    perModelUsed.set(model, used + 1);
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const q = perModelWaiters.get(model) ?? [];
    q.push(resolve);
    perModelWaiters.set(model, q);
  });
}

function releaseModelSlot(model: string | undefined): void {
  if (!model) return;
  const next = (perModelWaiters.get(model) ?? []).shift();
  if (next) next();
  else perModelUsed.set(model, Math.max(0, (perModelUsed.get(model) ?? 1) - 1));
}

/** Open (or reuse) a project's job state, settling anything a previous launch left running and
 *  finishing placeholders whose bytes landed while the project was closed. A generation the server
 *  holds as an order is NOT given up on: it is taken over, and its result is collected.
 *
 *  ``reconciled``: the caller has JUST finished placeholders whose bytes had landed (the project-open
 *  recovery does), so the first open does not do it a second time. */
export function openProjectJobs(
  store: ProjectStoreAccess,
  opts: { reconciled?: boolean } = {},
): Promise<JobLedger> {
  const key = store.projectDir;
  let existing = ledgers.get(key);
  if (!existing) {
    existing = (async () => {
      const ledger = await JobLedger.open(store);
      if (!opts.reconciled) await reconcilePendingMedia(store).catch(() => []);
      await failOrphanedPlaceholders(store, ledger).catch(() => []);
      for (const rec of ledger.adopted())
        track(resumeOrderJob(store, ledger, rec).finally(refreshUsage));
      return ledger;
    })();
    ledgers.set(key, existing);
  }
  return existing;
}

const NO_RECORD =
  "this generation did not finish, and the app has no record of it still running. It may still have been charged";
const LANDED_NOWHERE = "the finished file could not be found in the project";

/** Fail the placeholders no running job is making any more, with the reason the job's own record gives. A generation that failed
 *  while its project was closed could not say so in the catalog (the gate refuses a write from a session that ended), so its clip
 *  would otherwise spin for ever. Nothing is concluded when the ledger could not be read: what it does not list is then unknown. */
async function failOrphanedPlaceholders(
  store: ProjectStoreAccess,
  ledger: JobLedger,
): Promise<string[]> {
  if (!ledger.readable) return [];
  const owned = new Set(ledger.running().flatMap((r) => r.media_refs ?? []));
  const said = new Map<string, string>();
  for (const r of ledger.list()) {
    if (r.status === "running") continue;
    for (const id of r.media_refs ?? [])
      said.set(id, r.error ?? (r.status === "done" ? LANDED_NOWHERE : NO_RECORD));
  }
  return failUnownedPendingClips(
    store,
    (id) => owned.has(id),
    (id) => said.get(id) ?? NO_RECORD,
  );
}

/** What a project's opening does about generations: take over the ones the server holds (once per launch), and fail the placeholders
 *  that nothing is making any more. Every time the project is opened, not only the first, because a job can fail after its project
 *  closed within the same launch. A job record that cannot be read is reported (it throws): the project still opens, but nothing new
 *  is started in it until the record can be read. */
export async function reconcileGenerations(store: ProjectStoreAccess): Promise<void> {
  const ledger = await openProjectJobs(store, { reconciled: true });
  if (!ledger.readable) throw new JobLedgerUnreadableError(ledger.unreadableReason);
  await failOrphanedPlaceholders(store, ledger);
}

/** Keep a detached job alive until it is done, and never let it become an unhandled rejection. */
function track(task: Promise<unknown>): void {
  const held = task.catch(() => undefined);
  inflight.add(held);
  void held.finally(() => inflight.delete(held));
}

/** Resolve once every generation started in this process has settled. For tests and for a
 *  deliberate drain; normal code never waits on this. */
export async function whenGenerationsSettle(): Promise<void> {
  while (inflight.size) await Promise.allSettled([...inflight]);
}

/** Forget cached ledgers (tests only — a real process keeps one per project). */
export function __resetProjectJobs(): void {
  ledgers.clear();
  inflight.clear();
  // Release anything queued, or a test that resets mid-queue would wait on it forever.
  for (const resume of slotWaiters.splice(0)) resume();
  slotsUsed = 0;
}

/** What a generation's paid call is handed: the number that makes it an order, and how to say the server took it. */
export interface GenerationRunContext {
  /** The generation's order number. Sent with the paid call: the same number again is the same order, never a second charge. */
  orderId: string;
  /** Call this once the server has taken the call as an order. From then on the SERVER owns the wait, so the deadline (a guard
   *  against a call that never answers) stops applying: an order is never given up on by the app's own clock. */
  orderAccepted: () => void;
}

export interface SubmitSpec {
  store: ProjectStoreAccess;
  /** Contract tool name, for the ledger row. */
  tool: string;
  /** Short human summary used in the completion note. */
  label: string;
  /** Library kind of the outputs: image | video | audio. */
  mediaKind: string;
  /** How many assets this job will produce. */
  count: number;
  /** Display name for output `i`. */
  filename: (i: number) => string;
  durationS?: number;
  source?: Record<string, unknown>;
  /** The turn's origin, applied to the SUBMIT-time rows only. */
  origin?: MutationOrigin;
  /** Provider model id, so concurrency is capped PER MODEL as well as overall. */
  model?: string;
  /** Makes the paid call. Runs detached; must not take the turn's signal. */
  run: (ctx: GenerationRunContext) => Promise<GeneratedOutput[]>;
}

export interface SubmitResult {
  media_refs: string[];
  job_id: string;
}

/** Stop before spending when the balance is already gone.
 *
 *  The limit used to appear only as a mid-run JOB failure, one per submission, after a placeholder
 *  and a ledger row had been written and the agent had moved on: a shot list produced a run of
 *  identical 402s (`2175.46 / 2000` — already over) with nothing to show. Checked HERE because it
 *  is the one door every paid generation goes through.
 *
 *  The cached balance is re-fetched before refusing, so a top-up that this client has not seen yet
 *  cannot lock it out — the fail-safe direction is to let the call through, not to block it. */
async function refuseIfOutOfCredit(): Promise<void> {
  if (!getUsage().over) return;
  await refreshUsage().catch(() => undefined);
  const u = getUsage();
  if (!u.over) return;
  throw new CreditLimitError(
    { used: u.used, limit: u.limit, ...(u.globalPaused ? { scope: "global" } : {}) },
    u.globalPaused
      ? "the shared AI budget is paused, so this was not submitted and nothing was charged"
      : `no credit left (${u.used.toFixed(0)} of ${u.limit.toFixed(0)} used), so this was not submitted ` +
          `and nothing was charged`,
  );
}

/** Publish placeholders, record the job, fire the paid call, and return immediately. */
export async function submitGeneration(spec: SubmitSpec): Promise<SubmitResult> {
  const { store } = spec;
  await refuseIfOutOfCredit();
  const ledger = await openProjectJobs(store);
  const ids = Array.from({ length: Math.max(1, spec.count) }, () => newPendingMediaId());

  for (let i = 0; i < ids.length; i += 1) {
    await registerPendingClip(
      store,
      {
        id: ids[i],
        filename: spec.filename(i),
        kind: spec.mediaKind,
        duration_s: spec.durationS,
        source: spec.source,
      },
      { origin: spec.origin },
    );
  }

  // Recorded BEFORE the paid call, so a crash mid-call still leaves a trace of money spent. The order number goes in with it: it is
  // what lets a later launch ask the server for the result, and what makes sending the call again the same order, never a second one.
  // Only THIS chat's tool calls carry an origin (host.run passes the chat execution); the menu and an external MCP agent do not, and
  // neither is part of the conversation to resume.
  const orderId = newOrderId();
  const sentAs = { ...(signedInUser() ? { owner: signedInUser() } : {}), api: apiBase() };
  let jobId: string;
  try {
    jobId = await ledger.begin({
      kind: "generation",
      tool: spec.tool,
      label: spec.label,
      media_refs: ids,
      order_id: orderId,
      ...sentAs,
      started_by: spec.origin ? "chat" : "elsewhere",
    });
  } catch (e) {
    // Not recorded, so not started: nothing has been paid for and nothing will be. The placeholders made for it are failed, so
    // nothing is left spinning, and the person is told why.
    const why = e instanceof Error ? e.message : String(e);
    await Promise.allSettled(ids.map((id) => failPendingClip(store, id, why)));
    throw e;
  }

  const task = settleLater(spec, ledger, jobId, ids, orderId, sentAs).finally(refreshUsage);
  inflight.add(task);
  void task.finally(() => inflight.delete(task));
  return { media_refs: ids, job_id: jobId };
}

/** The time allowed for a call to answer has run out. Not a verdict on the generation: with an order number the server may well
 *  hold it (and have charged it), so the job is handed to the code that takes an order over after a restart, which asks the server
 *  and only gives up when the server says it never had the call. */
class GenerationOverdue extends Error {
  constructor(label: string) {
    super(
      `${label} never came back (no result after ${Math.round(GENERATION_DEADLINE_MS / 60_000)} minutes), so it was given up on. Nothing further will arrive for this ref — submit it again if you still want it.`,
    );
    this.name = "GenerationOverdue";
  }
}

/** Stop waiting on a call that never resolves, so its ref stops being unanswerable. The clock stops the moment the server takes the
 *  call as an order (`start` is handed the way to say so): from then on the server owns the wait, and an order is never given up
 *  on by the app's own clock, only by the server's verdict. If it runs out first the call is `GenerationOverdue`. */
async function withDeadline(
  start: (orderAccepted: () => void) => Promise<GeneratedOutput[]>,
  label: string,
): Promise<GeneratedOutput[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disarm = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GenerationOverdue(label)), GENERATION_DEADLINE_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([start(disarm), expiry]);
  } finally {
    disarm();
  }
}

/** One generation, as the functions below see it: where it is, which placeholders it fills, and who asked. */
interface JobInfo {
  store: ProjectStoreAccess;
  ledger: JobLedger;
  jobId: string;
  ids: string[];
  tool: string;
  label: string;
  startedBy: "chat" | "elsewhere";
  /** The account that sent it and the server it went to (absent on a record from before they were kept). */
  owner?: string;
  api?: string;
}

/** Whether whoever is asking about this generation now is not who it was sent as: another sign-in, or another server. The server's
 *  "no such order" is then only about the asker, not a verdict on the order, which is paid for and still there for its owner. */
function askedAsSomeoneElse(job: JobInfo): boolean {
  const now = signedInUser();
  if (job.owner && now && job.owner !== now) return true;
  return !!job.api && job.api !== apiBase();
}

async function settleLater(
  spec: SubmitSpec,
  ledger: JobLedger,
  jobId: string,
  ids: string[],
  orderId: string,
  sentAs: { owner?: string; api?: string },
): Promise<void> {
  const job: JobInfo = {
    store: spec.store,
    ledger,
    jobId,
    ids,
    tool: spec.tool,
    label: spec.label,
    startedBy: spec.origin ? "chat" : "elsewhere",
    ...sentAs,
  };
  let outputs: GeneratedOutput[];
  let overdue: GenerationOverdue | null = null;
  // Set once the server has taken the call as an order. From then on the result is charged for and the server holds it, so nothing
  // the APP trips over ends the job: only the server's own verdict does (see `isOrderVerdict`).
  let accepted = false;
  await acquireSlot();
  await acquireModelSlot(spec.model);
  try {
    outputs = await withDeadline(
      (disarm) =>
        spec.run({
          orderId,
          orderAccepted: () => {
            accepted = true;
            disarm();
          },
        }),
      spec.label,
    );
  } catch (e) {
    // The order is fine and this build is only barred from asking about it: leave the job running, the placeholders as they are and
    // nobody told anything. The next run that may ask collects it.
    if (e instanceof OrderWaitSuspended) return;
    // "No such order" asked as someone else is no verdict on an order that is paid for: it is left for the account it belongs to.
    if (e instanceof OrderNotFoundError && askedAsSomeoneElse(job)) {
      keepRunning(job, e);
      return;
    }
    if (accepted && !endsTheJob(e)) {
      keepRunning(job, e);
      return;
    }
    if (!(e instanceof GenerationOverdue)) {
      await failJob(job, e instanceof Error ? e.message : String(e));
      return;
    }
    overdue = e;
    outputs = [];
  } finally {
    // Only the paid call is capped; writing the bytes is local and must not hold a slot.
    releaseSlot();
    releaseModelSlot(spec.model);
  }

  if (overdue) {
    // A tool whose results cannot be brought back has no order to ask about: it is simply given up on, as it always was.
    if (!isResultTool(job.tool)) await failJob(job, overdue.message);
    else
      await takeOverOrder(job, orderId, {
        notFound: { message: overdue.message, status: "failed" },
      });
    return;
  }

  // The server keeps the finished file until the app says it has it, so say so only once it is on disk and the job is settled.
  const landed = await landOutputs(job, outputs);
  if (landed.ok > 0 && landed.deferred === 0) await acknowledgeAcceptedOrder(orderId);
}

/** Something went wrong after the server took the order, and it was not the server's verdict: the result is charged for and still
 *  there, so the job is left as it is (its ledger row running, its placeholders as they were) and the next run, which adopts it,
 *  collects it. Not told to the chat: nothing has failed that the person could act on. */
function keepRunning(job: JobInfo, e: unknown): void {
  const why = e instanceof Error ? e.message : String(e);
  reportAppError(`generation_left_running: ${job.tool}: ${why}`.slice(0, 300));
}

/** What ends a job once the server has taken its order: the server's verdict, or a result that holds no usable file. */
function endsTheJob(e: unknown): boolean {
  return isOrderVerdict(e) || e instanceof GeneratedResultError;
}

/** Fail a job: its placeholders still being made are failed (one that already landed is not undone by a job that failed for the
 *  rest), the ledger row is closed and the chat is told. */
async function failJob(
  job: JobInfo,
  error: string,
  status: "failed" | "interrupted" = "failed",
): Promise<void> {
  const { store, ledger, jobId } = job;
  await Promise.allSettled(
    job.ids.map(async (id) => {
      if ((await pendingMediaState(store, id)) === "generating")
        await failPendingClip(store, id, error);
    }),
  );
  await ledger.settle(jobId, { status, error });
  notifyJobSettled(store.projectDir, {
    id: jobId,
    tool: job.tool,
    label: job.label,
    status: "failed",
    startedBy: job.startedBy,
    error,
  });
}

/** What a person is told when a finished result could not be written to the project: it is not lost, and not confirmed to the
 *  server, which therefore keeps it. */
function notSavedText(why: string): string {
  return (
    `could not be saved on this computer (${why}). The finished file is kept for 7 days, so free some space and try again, ` +
    "or use Report a problem if it does not come back"
  );
}

/** Write one output into its placeholder, trying again a couple of times: a file another program holds for a moment, or a disk
 *  that is briefly busy, should not cost a result that has been paid for. A project that closed is not retried. */
async function finalizeWithRetries(
  store: ProjectStoreAccess,
  id: string,
  out: GeneratedOutput,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await finalizePendingClip(store, id, out.bytes, { meta: out.meta });
      return;
    } catch (e) {
      if (e instanceof ProjectClosingError || attempt >= 2) throw e;
      await orderPolling.sleep(2000 * (attempt + 1));
    }
  }
}

/** How a landing went: how many outputs are in place (the job is done when at least one is), and how many of those are only in
 *  place on disk because the project closed before their rows could be finished. */
interface Landing {
  ok: number;
  deferred: number;
}

/** Put the outputs where the placeholders are, settle the job and tell the chat. ``alreadyLanded`` are the placeholders whose
 *  bytes are already there. */
async function landOutputs(
  job: JobInfo,
  outputs: GeneratedOutput[],
  alreadyLanded: ReadonlySet<number> = new Set(),
): Promise<Landing> {
  const { store, ledger, jobId, ids } = job;
  const landed: string[] = [];
  const deferred: string[] = [];
  const failures: string[] = [];
  // A provider that returns FEWER assets than asked for has almost always filtered them; saying
  // "the model returned no output" reads like a transport fault and sent the agent into a retry
  // loop against the same prompt.
  const missing =
    "the provider returned nothing for this one — usually a content filter. Change the prompt " +
    "(or the reference image, which is filtered separately) rather than retrying it unchanged";
  for (let i = 0; i < ids.length; i += 1) {
    if (alreadyLanded.has(i)) {
      landed.push(ids[i]);
      continue;
    }
    const out = outputs[i];
    if (!out) {
      failures.push(`${ids[i]}: ${missing}`);
      await failPendingClip(store, ids[i], missing).catch(() => undefined);
      continue;
    }
    try {
      await finalizeWithRetries(store, ids[i], out);
      landed.push(ids[i]);
    } catch (e) {
      // The project closed before the row could be flipped. The BYTES are already on disk, so
      // this is deferred, not lost -- the next open reconciles it. Leave the row `generating`.
      if (e instanceof ProjectClosingError) {
        deferred.push(ids[i]);
        continue;
      }
      const msg = notSavedText(e instanceof Error ? e.message : String(e));
      failures.push(`${ids[i]}: ${msg}`);
      await failPendingClip(store, ids[i], msg).catch(() => undefined);
    }
  }

  const ok = [...landed, ...deferred];
  await ledger.settle(jobId, {
    status: ok.length ? "done" : "failed",
    media_refs: ok.length ? ok : ids,
    ...(failures.length ? { error: failures.join("; ") } : {}),
  });
  notifyJobSettled(store.projectDir, {
    id: jobId,
    tool: job.tool,
    label: job.label,
    status: ok.length ? "done" : "failed",
    startedBy: job.startedBy,
    ...(ok.length ? { media_refs: ok } : {}),
    ...(failures.length ? { error: failures.join("; ") } : {}),
  });
  return { ok: ok.length, deferred: deferred.length };
}

/** The ffmpeg a result brought back after a restart may need (a music bed is re-muxed), or null where there is none. */
async function ffmpegOrNull() {
  try {
    const { previewRunner } = await import("../preview/conformAudio");
    return await previewRunner();
  } catch {
    return null;
  }
}

/** What to say, and how to close the job, when the server answers that it has no such order. After a restart the call may simply
 *  never have left the app; once the time allowed ran out it is the same story as always: it never came back. */
interface NotFound {
  message: string;
  status: "failed" | "interrupted";
}

const CLOSED_BEFORE_IT_FINISHED: NotFound = {
  message: "the app closed before this finished; it may still have been charged",
  status: "interrupted",
};

/** A generation the app was closed on: ask the server for it and finish what the closed app could not. */
async function resumeOrderJob(
  store: ProjectStoreAccess,
  ledger: JobLedger,
  rec: JobRecord,
): Promise<void> {
  const job: JobInfo = {
    store,
    ledger,
    jobId: rec.id,
    ids: rec.media_refs ?? [],
    tool: rec.tool,
    label: rec.label,
    startedBy: rec.started_by ?? "elsewhere",
    ...(rec.owner ? { owner: rec.owner } : {}),
    ...(rec.api ? { api: rec.api } : {}),
  };
  if (!isResultTool(rec.tool)) {
    await failJob(job, `${rec.label} cannot be brought back by this version of the app.`);
    return;
  }
  await takeOverOrder(job, rec.order_id as string, { notFound: CLOSED_BEFORE_IT_FINISHED });
}

/** Take a generation over from whoever started it (an app that was closed, or a call that never answered in time): ask the server
 *  for the order and finish the job from its answer. It never gives up on the order itself (see waitForOrder); only the server's
 *  verdict, or a result that holds nothing usable, ends it. Any other trouble leaves the job running for the next run. */
async function takeOverOrder(
  job: JobInfo,
  orderId: string,
  opts: { notFound: NotFound },
): Promise<void> {
  const { store, ids } = job;
  try {
    const states = await Promise.all(ids.map((id) => pendingMediaState(store, id)));
    const alreadyLanded = new Set(states.flatMap((s, i) => (s === "ready" ? [i] : [])));
    if (ids.length > 0 && alreadyLanded.size === ids.length) {
      // The app stopped after the files landed and before it said so: only the bookkeeping is left.
      await landOutputs(job, [], alreadyLanded);
      await ackOrder(orderId);
      return;
    }
    const ready = await waitForOrder(orderId);
    // Waiting costs nothing, but fetching, decoding and writing a result do, in memory: a project that comes back to many finished
    // generations must not do all of them at once, any more than live ones do.
    await acquireSlot();
    try {
      const dto = (await downloadOrderResult(ready)) as AiProxyResult<unknown>;
      const outputs = await decodeGenerated(job.tool as ResultTool, dto, {
        store,
        runner: await ffmpegOrNull(),
        orderId,
      });
      const landed = await landOutputs(job, outputs, alreadyLanded);
      if (landed.ok > 0 && landed.deferred === 0) await ackOrder(orderId);
    } finally {
      releaseSlot();
    }
  } catch (e) {
    if (e instanceof OrderWaitSuspended) return;
    if (e instanceof OrderNotFoundError) {
      // Asked as someone else (another sign-in, another server), "no such order" says nothing about the order: it is left for its owner.
      if (askedAsSomeoneElse(job)) {
        keepRunning(job, e);
        return;
      }
      await failJob(job, opts.notFound.message, opts.notFound.status);
      return;
    }
    if (!endsTheJob(e)) {
      keepRunning(job, e);
      return;
    }
    await failJob(job, e instanceof Error ? e.message : String(e));
  }
}
