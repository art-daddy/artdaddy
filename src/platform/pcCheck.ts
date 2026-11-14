// The PC check: ONE service that decides when a probe of this PC may run, runs one probe at a time inside a time box and keeps its
// answer. It knows no probe by name: the export speed test, and later the speech probe, register themselves. It never disturbs an
// export, a look, playback or the person typing: a run it stops stores nothing, and `pcClass()` never waits for anything.
// Everything it touches is injected (the clock and timers, the storage, the signals of the world, the probe's commands and files).
import type { Flags3c, PcClass } from "../timeline/exportTypes3c";
import {
  checkedRecord,
  classOfRecord,
  readPcCheck,
  recordIsCurrent,
  unfinishedRecord,
  writePcCheck,
  type PcCheckNow,
  type PcCheckRecord,
  type StorageLike,
} from "../timeline/pcClass";
import type { ProbeOutcome } from "./host";

export type PcCheckReason = "idle" | "dialog" | "question" | "update";
export type PcCheckOutcome = "done" | "unfinished" | "aborted" | "skipped";

/** What the world tells the service (all of it is the lane's to wire): every field is required, and one that is not exactly
 *  `false` counts as busy, so a signal the lane forgets can only keep a probe from starting. */
export interface PcCheckSignals {
  /** An export is queued or running. */
  exportBusy: boolean;
  /** An export is being asked its questions: the queue's own busy flag does not follow it yet. */
  exportAsked: boolean;
  playing: boolean;
  /** A look or a background speech job runs. */
  lookOrSpeechJob: boolean;
  projectOpen: boolean;
  /** When the person last touched the editor, on the same clock as `now()`. */
  lastInputAtMs: number;
}

/** What a probe may use besides the service's own clock and storage: the capability lane's command runner and the app's cache. */
export interface PcCheckFiles {
  /** The folder the check keeps its files in. */
  dir(): Promise<string>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** A file's size in bytes, or null when there is no such file. */
  size(path: string): Promise<number | null>;
}

export interface PcCheckDeps {
  now(): number;
  storage: StorageLike | null;
  build: string;
  /** The logical core count of this PC: a record measured with another count is not this PC's. */
  cores: number;
  /** The server's switches, read when a decision is made; `pc_check` off removes the class altogether. */
  flags?: () => Pick<Flags3c, "pc_check">;
  /** True while a battery reports discharging; null or absent when the page cannot tell. */
  batteryDischarging?: () => boolean | null;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** `runCapabilityProbe` (`platform/host.ts`): one short ffmpeg command, never throwing. */
  probe(
    args: readonly string[],
    options: { timeoutMs: number; kind: string; signal?: AbortSignal },
  ): Promise<ProbeOutcome>;
  files: PcCheckFiles;
}

export interface ProbeDefinition {
  id: string;
  /** Bumped when the probe means something different: a record of another revision is not believed. */
  revision: number;
  ttlMs: number;
  /** The whole time box: when it is over the signal aborts and the check is stored as not finished. */
  budgetMs: number;
  /** The record of the probe that says so (else of the first one registered) is the PC's class. */
  definesClass?: boolean;
  /** Measures. `record` is a finished check, or null when it could not finish; `stored` says the probe keeps its own answer
   *  elsewhere (the service then writes nothing). A probe must stop at once when `signal` aborts, and must not store after it. */
  run(ctx: {
    signal: AbortSignal;
    deps: PcCheckDeps;
  }): Promise<{ record: PcCheckRecord | null; stored: boolean }>;
}

export interface PcCheckService {
  registerProbe(def: ProbeDefinition): void;
  /** Asks for a run (`id` names one probe; without it every probe that is due, or all of them when `force`). From the dialog or a
   *  question a person is waiting: the run takes the slot as soon as it is free and is skipped if an export or a look is on
   *  then; it never waits for the editor to be idle. `idle` and `update` only make the next idle moment take it. */
  requestRun(opts: { reason: PcCheckReason; force?: boolean; id?: string }): void;
  result(id: string): PcCheckRecord | null;
  /** The stored class, or `unknown`, at once. Never waits. */
  pcClass(): PcClass;
  status(): { running: string | null; lastOutcome: Record<string, PcCheckOutcome> };
  subscribe(fn: () => void): () => void;
  setSignals(s: PcCheckSignals): void;
  /** Holds the one slot while `fn` runs, so the chip test and the probes never overlap: waits behind a running probe or
   *  another holder, and is never run when `signal` aborts first, or the service is disposed (`ran: false`). `fn`'s own
   *  failure is the caller's: the slot is given back and the error passes on. */
  withSlot<T>(
    id: string,
    fn: () => Promise<T>,
    opts?: { signal?: AbortSignal },
  ): Promise<{ ran: true; value: T } | { ran: false }>;
  dispose(): void;
}

/** The editor must have been quiet this long before a probe starts by itself. */
export const IDLE_BEFORE_RUN_MS = 20_000;
export const DEFAULT_BUDGET_MS = 20_000;
const MAX_BUDGET_MS = 600_000;
const MAX_TIMER_MS = 86_400_000;
/** After a check that did not finish: the wait before the next automatic try, by the number of tries that failed in a row. */
export const UNFINISHED_BACKOFF_MS = [600_000, 1_800_000, 21_600_000, 86_400_000] as const;

/** How long to wait before trying again after `failures` checks in a row did not finish: none before the first failure, then
 *  10 minutes, 30 minutes, 6 hours and a day for every failure after the fourth. A count that is not a number waits a day. */
export function unfinishedBackoffMs(failures: number): number {
  const last = UNFINISHED_BACKOFF_MS[UNFINISHED_BACKOFF_MS.length - 1];
  if (typeof failures !== "number" || Number.isNaN(failures)) return last;
  if (failures < 1) return 0;
  return UNFINISHED_BACKOFF_MS[Math.min(Math.floor(failures), UNFINISHED_BACKOFF_MS.length) - 1];
}

interface Timer {
  handle: unknown;
}
interface Run {
  def: ProbeDefinition;
  reason: PcCheckReason;
  controller: AbortController;
  aborted: boolean;
  /** The person's last input when the run began: a later one stops an automatic run. */
  inputAtStart: number;
  box: Timer | null;
}
interface Waiter {
  id: string;
  fn: () => Promise<unknown>;
  resolve: (outcome: { ran: true; value: never } | { ran: false }) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
}

const isAutomatic = (reason: PcCheckReason): boolean => reason === "idle" || reason === "update";

function acceptDefinition(def: unknown): ProbeDefinition | null {
  if (def === null || typeof def !== "object") return null;
  const { id, revision, ttlMs, budgetMs, run } = def as Record<string, unknown>;
  if (typeof id !== "string" || id === "" || id.length > 64) return null;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) return null;
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) return null;
  if (typeof budgetMs !== "number" || !Number.isFinite(budgetMs) || budgetMs <= 0) return null;
  return typeof run === "function" ? (def as ProbeDefinition) : null;
}

export function createPcCheckService(deps: PcCheckDeps): PcCheckService {
  const probes = new Map<string, ProbeDefinition>();
  /** The answers of this run of the app, for a storage that cannot hold them. */
  const session = new Map<string, PcCheckRecord>();
  /** Checks in a row that did not finish, by probe; absent until one fails (a stored one counts as the first). */
  const streaks = new Map<string, number>();
  const outcomes = new Map<string, PcCheckOutcome>();
  /** Probes asked to run at the next idle moment even though their record is current, with the reason they were asked for. */
  const forced = new Map<string, PcCheckReason>();
  const asked: { def: ProbeDefinition; reason: PcCheckReason }[] = [];
  const waiters: Waiter[] = [];
  const listeners = new Set<() => void>();

  const clock = (): number => {
    try {
      const t = deps.now();
      return Number.isFinite(t) ? t : 0;
    } catch {
      return 0;
    }
  };
  const cores = (): number =>
    Number.isFinite(deps.cores) && deps.cores >= 1 ? Math.floor(deps.cores) : 1;
  const enabled = (): boolean => {
    try {
      return deps.flags ? deps.flags().pc_check !== false : true;
    } catch {
      return true;
    }
  };
  const onBattery = (): boolean => {
    try {
      return deps.batteryDischarging?.() === true;
    } catch {
      return false;
    }
  };
  const arm = (ms: number, fn: () => void): Timer | null => {
    try {
      return { handle: deps.setTimer(fn, Math.max(0, ms)) };
    } catch {
      return null;
    }
  };
  const disarm = (timer: Timer | null): void => {
    if (!timer) return;
    try {
      deps.clearTimer(timer.handle);
    } catch {
      /* a timer that cannot be cleared fires into a service that checks again */
    }
  };
  const notify = (): void => {
    for (const fn of [...listeners])
      try {
        fn();
      } catch {
        /* one listener's failure is not another's */
      }
  };

  let signals: PcCheckSignals = {
    exportBusy: true,
    exportAsked: true,
    playing: true,
    lookOrSpeechJob: true,
    projectOpen: false,
    lastInputAtMs: clock(),
  };
  /** Since when nothing has been busy; the idle wait counts from the later of this and the last input. */
  let quietSince: number | null = null;
  let idle: Timer | null = null;
  /** The idle stretch (its start) in which a battery already kept the automatic run from starting. */
  let skippedStretch: number | null = null;
  let current: Run | null = null;
  let holder: { id: string } | null = null;
  let disposed = false;

  const busy = (s: PcCheckSignals): boolean =>
    s.exportBusy || s.exportAsked || s.playing || s.lookOrSpeechJob || !s.projectOpen;
  const blocked = (): boolean => disposed || !enabled() || busy(signals);
  const idleStretch = (): number => Math.max(quietSince ?? clock(), signals.lastInputAtMs);
  const slotFree = (): boolean => current === null && holder === null;

  const identity = (def: ProbeDefinition): PcCheckNow => ({
    atMs: clock(),
    build: deps.build,
    cores: cores(),
    revision: def.revision,
  });

  /** The probe's current record, from the storage or (newer, if the storage could not keep it) from this run of the app. */
  function recordOf(def: ProbeDefinition): PcCheckRecord | null {
    const now = identity(def);
    const stored = readPcCheck(deps.storage, def.id, now, def.ttlMs);
    const kept = session.get(def.id);
    const keptCurrent = kept && recordIsCurrent(kept, now, def.ttlMs) ? kept : null;
    if (stored && keptCurrent) return keptCurrent.atMs > stored.atMs ? keptCurrent : stored;
    return stored ?? keptCurrent;
  }

  const failuresOf = (def: ProbeDefinition, record: PcCheckRecord | null): number =>
    streaks.get(def.id) ?? (record?.outcome === "unfinished" ? 1 : 0);

  /** Whether the probe has a reason to run when a person asks: no current record, or one that did not finish. */
  function isDue(def: ProbeDefinition): boolean {
    const record = recordOf(def);
    return !record || record.outcome === "unfinished";
  }

  /** When a probe may next start by itself: now (asked to, or no current record), never (a finished check), or when the wait
   *  after a check that did not finish is over. */
  function readyAt(def: ProbeDefinition): number | null {
    if (forced.has(def.id)) return -Infinity;
    const record = recordOf(def);
    if (!record) return -Infinity;
    if (record.outcome === "done") return null;
    return record.atMs + unfinishedBackoffMs(failuresOf(def, record));
  }

  function nextAutomatic(): ProbeDefinition | null {
    const t = clock();
    for (const def of probes.values()) {
      const at = readyAt(def);
      if (at !== null && at <= t) return def;
    }
    return null;
  }

  function earliestReady(): number | null {
    let earliest: number | null = null;
    for (const def of probes.values()) {
      const at = readyAt(def);
      if (at !== null && (earliest === null || at < earliest)) earliest = at;
    }
    return earliest;
  }

  function classProbe(): ProbeDefinition | null {
    for (const def of probes.values()) if (def.definesClass === true) return def;
    return probes.values().next().value ?? null;
  }

  // Running ------------------------------------------------------------------------------------------------------------------

  function abort(run: Run): void {
    if (run.aborted) return;
    run.aborted = true;
    try {
      run.controller.abort();
    } catch {
      /* a listener of the signal that throws must not keep the run from stopping */
    }
  }

  /** Where a run's answer is kept, and what it was: the one place that writes, reached only from `settle` and `onBox` after the
   *  last await, with the gates checked there. A probe's identity fields are the service's to stamp, so a record can never be
   *  the wrong build or core count and be measured again for ever. */
  function commit(def: ProbeDefinition, value: unknown): "done" | "unfinished" {
    const result =
      value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const record = checkedRecord(result.record);
    const finished = record !== null && record.outcome === "done";
    const now = identity(def);
    if (result.stored === true) {
      // The probe keeps its own answer elsewhere: nothing to write, and a missing record is not a failure.
      const failed = record !== null && record.outcome === "unfinished";
      if (failed) streaks.set(def.id, failuresOf(def, recordOf(def)) + 1);
      else streaks.delete(def.id);
      return failed ? "unfinished" : "done";
    }
    if (finished) {
      const stamped: PcCheckRecord = {
        ...record,
        revision: def.revision,
        build: now.build,
        cores: now.cores,
        atMs: now.atMs,
      };
      session.set(def.id, stamped);
      writePcCheck(deps.storage, def.id, stamped);
      streaks.delete(def.id);
      return "done";
    }
    const failures = failuresOf(def, recordOf(def)) + 1;
    const unfinished = unfinishedRecord(now);
    session.set(def.id, unfinished);
    writePcCheck(deps.storage, def.id, unfinished);
    streaks.set(def.id, failures);
    return "unfinished";
  }

  function end(run: Run, outcome: PcCheckOutcome): void {
    if (current !== run) return;
    disarm(run.box);
    run.box = null;
    current = null;
    outcomes.set(run.def.id, outcome);
    notify();
    pump();
  }

  /** The probe answered (or failed). An answer for a run that is no longer the current one, because the box or a disposal
   *  ended it first, is thrown away; so is one for a run that was stopped, or that the world has since made busy. */
  function settle(run: Run, value: unknown): void {
    try {
      if (current !== run) return;
      if (run.aborted || blocked()) return end(run, "aborted");
      end(run, commit(run.def, value));
    } catch {
      end(run, "unfinished");
    }
  }

  function onBox(run: Run): void {
    run.box = null;
    if (current !== run) return;
    const stopped = run.aborted || blocked();
    abort(run);
    try {
      end(run, stopped ? "aborted" : commit(run.def, null));
    } catch {
      end(run, "unfinished");
    }
  }

  function start(def: ProbeDefinition, reason: PcCheckReason): void {
    const budget = Math.min(MAX_BUDGET_MS, def.budgetMs);
    const run: Run = {
      def,
      reason,
      controller: new AbortController(),
      aborted: false,
      inputAtStart: signals.lastInputAtMs,
      box: null,
    };
    // A run that cannot be time-boxed does not start.
    run.box = arm(budget, () => onBox(run));
    if (!run.box) {
      outcomes.set(def.id, "skipped");
      notify();
      return;
    }
    current = run;
    notify();
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(def.run({ signal: run.controller.signal, deps }));
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (value) => settle(run, value),
      () => settle(run, null),
    );
  }

  function hold(waiter: Waiter): void {
    waiter.cleanup();
    holder = { id: waiter.id };
    notify();
    const finish = (settled: () => void): void => {
      holder = null;
      settled();
      notify();
      pump();
    };
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(waiter.fn());
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (value) => finish(() => waiter.resolve({ ran: true, value: value as never })),
      (error) => finish(() => waiter.reject(error)),
    );
  }

  /** Whatever may use the slot next, in the order: whoever holds a turn through `withSlot` (a person is waiting for the chip
   *  test), then runs that were asked for, then the idle runner. */
  function pump(): void {
    if (disposed || !slotFree()) return;
    const waiter = waiters.shift();
    if (waiter) return hold(waiter);
    while (asked.length > 0) {
      const next = asked.shift()!;
      if (blocked()) {
        outcomes.set(next.def.id, "skipped");
        notify();
        continue;
      }
      start(next.def, next.reason);
      if (current) return;
    }
    schedule();
  }

  // Starting by itself ----------------------------------------------------------------------------------------------------

  /** Arms the one timer that starts the next probe that is ready when the editor has been quiet long enough. Called whenever
   *  anything it depends on changes, so nothing polls. */
  function schedule(): void {
    disarm(idle);
    idle = null;
    if (blocked() || !slotFree() || waiters.length > 0 || asked.length > 0) return;
    const ready = earliestReady();
    if (ready === null) return;
    const stretch = idleStretch();
    if (skippedStretch === stretch) return;
    const wake = Math.max(ready, stretch + IDLE_BEFORE_RUN_MS);
    idle = arm(Math.min(wake - clock(), MAX_TIMER_MS), onIdle);
  }

  function onIdle(): void {
    idle = null;
    if (blocked() || !slotFree() || waiters.length > 0 || asked.length > 0) return;
    const stretch = idleStretch();
    const def = nextAutomatic();
    if (!def || clock() < stretch + IDLE_BEFORE_RUN_MS) return schedule();
    if (onBattery() && !forced.has(def.id)) {
      skippedStretch = stretch;
      const t = clock();
      for (const other of probes.values()) {
        const at = readyAt(other);
        if (at !== null && at <= t && !forced.has(other.id)) outcomes.set(other.id, "skipped");
      }
      return notify();
    }
    const reason = forced.get(def.id) ?? "idle";
    forced.delete(def.id);
    start(def, reason);
  }

  // The service -----------------------------------------------------------------------------------------------------------

  function setSignals(next: PcCheckSignals): void {
    if (disposed) return;
    try {
      if (next !== null && typeof next === "object") {
        const raw = next as unknown as Record<string, unknown>;
        const t = clock();
        const input =
          typeof raw.lastInputAtMs === "number" && Number.isFinite(raw.lastInputAtMs)
            ? Math.min(raw.lastInputAtMs, t)
            : t;
        signals = {
          exportBusy: raw.exportBusy !== false,
          exportAsked: raw.exportAsked !== false,
          playing: raw.playing !== false,
          lookOrSpeechJob: raw.lookOrSpeechJob !== false,
          projectOpen: raw.projectOpen === true,
          lastInputAtMs: input,
        };
      }
      quietSince = busy(signals) ? null : (quietSince ?? clock());
      const run = current;
      if (run && !run.aborted) {
        if (blocked()) abort(run);
        else if (isAutomatic(run.reason) && signals.lastInputAtMs > run.inputAtStart) abort(run);
      }
      schedule();
    } catch {
      /* the signals stay as they were */
    }
  }

  function registerProbe(def: ProbeDefinition): void {
    if (disposed) return;
    const accepted = acceptDefinition(def);
    if (!accepted || probes.has(accepted.id)) return;
    probes.set(accepted.id, accepted);
    notify();
    schedule();
  }

  function requestRun(opts: { reason: PcCheckReason; force?: boolean; id?: string }): void {
    if (disposed) return;
    try {
      const reason = opts?.reason;
      if (!(["idle", "dialog", "question", "update"] as unknown[]).includes(reason)) return;
      const force = opts.force === true;
      const targets = typeof opts.id === "string" ? [probes.get(opts.id)] : [...probes.values()];
      let changed = false;
      for (const def of targets) {
        if (!def) continue;
        if (isAutomatic(reason)) {
          if (force) forced.set(def.id, reason);
          continue;
        }
        // A person is waiting for the answer: it takes the slot when it is free, and is not kept for a quieter moment.
        if (current?.def.id === def.id || asked.some((entry) => entry.def.id === def.id)) continue;
        if ((!force && !isDue(def)) || blocked()) {
          outcomes.set(def.id, "skipped");
          changed = true;
          continue;
        }
        asked.push({ def, reason });
      }
      if (changed) notify();
      pump();
    } catch {
      /* nothing was asked */
    }
  }

  function withSlot<T>(
    id: string,
    fn: () => Promise<T>,
    opts?: { signal?: AbortSignal },
  ): Promise<{ ran: true; value: T } | { ran: false }> {
    return new Promise((resolve, reject) => {
      const signal = opts?.signal;
      if (disposed || typeof fn !== "function" || signal?.aborted) return resolve({ ran: false });
      const waiter: Waiter = {
        id: String(id),
        fn,
        resolve: resolve as Waiter["resolve"],
        reject,
        cleanup: () => undefined,
      };
      if (signal) {
        const onAbort = (): void => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
          resolve({ ran: false });
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      waiters.push(waiter);
      pump();
    });
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    disarm(idle);
    idle = null;
    const run = current;
    if (run) {
      abort(run);
      disarm(run.box);
      run.box = null;
      current = null;
    }
    asked.length = 0;
    forced.clear();
    for (const waiter of waiters.splice(0)) {
      waiter.cleanup();
      waiter.resolve({ ran: false });
    }
    listeners.clear();
  }

  return {
    registerProbe,
    requestRun,
    result: (id) => {
      try {
        const def = probes.get(id);
        return def ? recordOf(def) : null;
      } catch {
        return null;
      }
    },
    pcClass: () => {
      try {
        if (!enabled()) return "unknown";
        const def = classProbe();
        return def ? classOfRecord(recordOf(def), deps.storage) : "unknown";
      } catch {
        return "unknown";
      }
    },
    status: () => ({
      running: current?.def.id ?? holder?.id ?? null,
      lastOutcome: Object.fromEntries(outcomes) as Record<string, PcCheckOutcome>,
    }),
    subscribe: (fn) => {
      if (disposed || typeof fn !== "function") return () => undefined;
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    setSignals,
    withSlot,
    dispose,
  };
}
