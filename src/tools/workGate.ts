// Heavy local work, app-wide: who may run now (4i).
//
// Someone waiting on a look gets its whisper at once, one look at a time: L3's four whispers at once
// (the background's and three windows, 8 threads each) made every one of them several times slower.
// The indexer's work is nobody's wait, so it takes turns: one whisper and one loudness measurement at
// a time across every project, and none STARTS while an export is queued or running
// or while a look's whisper runs or waits. A job already running
// is never stopped for one: the next simply does not start.

export type BackgroundKind = "whisper" | "loudness";

let exportsBusy = false;
/** Looks whose whisper is running or waiting for the one before it. */
let looks = 0;
let lookTail: Promise<unknown> = Promise.resolve();
/** Background jobs of each kind holding a turn (more than one only after {@link adoptTurn}). */
const running: Record<BackgroundKind, number> = { whisper: 0, loudness: 0 };
let waiters: Array<() => void> = [];
/** Bumped by the tests' reset: a turn or look taken before it gives nothing back after it. */
let generation = 0;
const watchers = new Set<() => void>();

/** Whether a look's whisper runs or waits, or a background job holds a turn: the one read-only view of this heavy local work, for the PC check, which never runs beside it. */
export function backgroundWorkActive(): boolean {
  return looks > 0 || running.whisper > 0 || running.loudness > 0;
}

/** Hears every change of {@link backgroundWorkActive}'s inputs. Returns the unsubscribe. A listener that throws is not heard of again by the gate and stops nothing. */
export function subscribeBackgroundWork(fn: () => void): () => void {
  watchers.add(fn);
  return () => void watchers.delete(fn);
}

function stirred(): void {
  for (const fn of [...watchers])
    try {
      fn();
    } catch {
      // A listener's failure is never the gate's.
    }
}

function wake(): void {
  const now = waiters;
  waiters = [];
  for (const w of now) w();
}

/** Who wants to hear an export begin or end (a speech run names it as a reason it is slow). */
const busyListeners = new Set<(busy: boolean) => void>();

/** The export queue's state: true while any export is queued or running. */
export function setExportsBusy(busy: boolean): void {
  if (exportsBusy === busy) return;
  exportsBusy = busy;
  if (!busy) wake();
  for (const listener of [...busyListeners]) {
    try {
      listener(busy);
    } catch {
      /* a listener is an observer: it can never change what the gate does */
    }
  }
}

/** Is an export queued or running right now? Read-only; the gate's behaviour is unchanged. */
export function exportsBusyNow(): boolean {
  return exportsBusy;
}

/** Is a look's whisper running or waiting right now? Read-only: while one is, no background whisper starts. */
export function lookActiveNow(): boolean {
  return looks > 0;
}

/** Hear when an export starts or ends. Returns the way to stop listening. */
export function onExportsBusy(listener: (busy: boolean) => void): () => void {
  busyListeners.add(listener);
  return () => busyListeners.delete(listener);
}

/** Run a look's whisper: at once, or after the look's whisper before it. Null, without running, when
 *  `signal` aborts first (Stop must answer at once, not after someone else's transcription). */
export async function lookWhisper<T>(
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T | null> {
  looks++;
  stirred();
  const gen = generation;
  const before = lookTail;
  let done!: () => void;
  lookTail = new Promise<void>((r) => (done = r));
  try {
    // `before` only ever resolves: each look's turn is handed on in its `finally`.
    const stopped = await Promise.race([before.then(() => false), aborted(signal)]);
    if (stopped) return null;
    return await run();
  } finally {
    // The next look starts once this one is over; a stopped one never ran, so it waits for nothing.
    before.finally(done).catch(() => undefined);
    if (gen === generation) {
      looks--;
      stirred();
      if (looks === 0) wake();
    }
  }
}

function aborted(signal?: AbortSignal): Promise<true> {
  return new Promise<true>((resolve) => {
    if (!signal) return;
    if (signal.aborted) return resolve(true);
    signal.addEventListener("abort", () => resolve(true), { once: true });
  });
}

/** Wait for a background job's turn. Resolves with the release to call when the job ends, or null
 *  when `signal` aborts first (its project closed: the job never started, so it never runs). */
export async function backgroundTurn(
  kind: BackgroundKind,
  signal?: AbortSignal,
): Promise<(() => void) | null> {
  for (;;) {
    if (signal?.aborted) return null;
    if (!exportsBusy && looks === 0 && running[kind] === 0) return hold(kind);
    await new Promise<void>((resolve) => {
      const onAbort = (): void => resolve();
      signal?.addEventListener("abort", onAbort, { once: true });
      waiters.push(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }
}

/** Take a turn now, whatever holds one: for a job already running that this page did not start
 *  (adopted after a crash of the page). The next job of its kind waits for it like any other. */
export function adoptTurn(kind: BackgroundKind): () => void {
  return hold(kind);
}

function hold(kind: BackgroundKind): () => void {
  running[kind]++;
  stirred();
  const gen = generation;
  let released = false;
  return () => {
    if (released || gen !== generation) return;
    released = true;
    running[kind]--;
    stirred();
    wake();
  };
}

/** Tests only. */
export function __resetWorkGate(): void {
  generation++;
  exportsBusy = false;
  looks = 0;
  lookTail = Promise.resolve();
  running.whisper = 0;
  running.loudness = 0;
  busyListeners.clear();
  stirred();
  wake();
}
