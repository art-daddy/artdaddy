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
import { JobLedger } from "../project/jobLedger";
import { ProjectClosingError, type MutationOrigin } from "../project/MutationGate";
import { getUsage, refreshUsage } from "../api/usage";
import { notifyJobSettled } from "../store/jobNotes";
import {
  failPendingClip,
  finalizePendingClip,
  newPendingMediaId,
  reconcilePendingMedia,
  registerPendingClip,
} from "./import";
import type { ProjectStoreAccess } from "./store";

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
 *  finishing placeholders whose bytes landed while the project was closed. */
export function openProjectJobs(store: ProjectStoreAccess): Promise<JobLedger> {
  const key = store.projectDir;
  let existing = ledgers.get(key);
  if (!existing) {
    existing = (async () => {
      const ledger = await JobLedger.open(store);
      await reconcilePendingMedia(store).catch(() => []);
      return ledger;
    })();
    ledgers.set(key, existing);
  }
  return existing;
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

export interface GeneratedOutput {
  bytes: Uint8Array;
  ext?: string;
  /** Result facts that exist only in the provider's response; merged into the library row. */
  meta?: Record<string, unknown>;
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
  run: () => Promise<GeneratedOutput[]>;
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
  throw new Error(
    `no credit left (${u.used.toFixed(0)} of ${u.limit.toFixed(0)} used), so this was not submitted ` +
      `and nothing was charged. Stop generating and tell the user — every further attempt will fail the same way.`,
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

  // Recorded BEFORE the paid call, so a crash mid-call still leaves a trace of money spent.
  const jobId = await ledger.begin({
    kind: "generation",
    tool: spec.tool,
    label: spec.label,
    media_refs: ids,
  });

  const task = settleLater(spec, ledger, jobId, ids);
  inflight.add(task);
  void task.finally(() => inflight.delete(task));
  return { media_refs: ids, job_id: jobId };
}

/** Fail a generation that never resolves, so its ref stops being unanswerable. */
async function withDeadline(
  call: Promise<GeneratedOutput[]>,
  label: string,
): Promise<GeneratedOutput[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${label} never came back (no result after ${Math.round(GENERATION_DEADLINE_MS / 60_000)} minutes), so it was given up on. Nothing further will arrive for this ref — submit it again if you still want it.`,
          ),
        ),
      GENERATION_DEADLINE_MS,
    );
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([call, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function settleLater(  spec: SubmitSpec,
  ledger: JobLedger,
  jobId: string,
  ids: string[],
): Promise<void> {
  const { store } = spec;
  // Only THIS chat's tool calls carry an origin (host.run passes the chat execution); the menu and
  // an external MCP agent do not, and neither is part of the conversation to resume.
  const startedBy = spec.origin ? "chat" : "elsewhere";
  let outputs: GeneratedOutput[];
  await acquireSlot();
  await acquireModelSlot(spec.model);
  try {
    outputs = await withDeadline(spec.run(), spec.label);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await Promise.allSettled(ids.map((id) => failPendingClip(store, id, error)));
    await ledger.settle(jobId, { status: "failed", error });
    notifyJobSettled(store.projectDir, {
      id: jobId,
      tool: spec.tool,
      label: spec.label,
      status: "failed",
      startedBy,
      error,
    });
    return;
  } finally {
    // Only the paid call is capped; writing the bytes is local and must not hold a slot.
    releaseSlot();
    releaseModelSlot(spec.model);
  }

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
    const out = outputs[i];
    if (!out) {
      failures.push(`${ids[i]}: ${missing}`);
      await failPendingClip(store, ids[i], missing).catch(() => undefined);
      continue;
    }
    try {
      await finalizePendingClip(store, ids[i], out.bytes, { meta: out.meta });
      landed.push(ids[i]);
    } catch (e) {
      // The project closed before the row could be flipped. The BYTES are already on disk, so
      // this is deferred, not lost -- the next open reconciles it. Leave the row `generating`.
      if (e instanceof ProjectClosingError) {
        deferred.push(ids[i]);
        continue;
      }
      const msg = e instanceof Error ? e.message : String(e);
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
    tool: spec.tool,
    label: spec.label,
    status: ok.length ? "done" : "failed",
    startedBy,
    ...(ok.length ? { media_refs: ok } : {}),
    ...(failures.length ? { error: failures.join("; ") } : {}),
  });
}
