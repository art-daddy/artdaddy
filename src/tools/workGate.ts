// Heavy local work, app-wide: who may run now (4i).
//
// Someone waiting on a look gets its whisper at once, one look at a time: L3's four whispers at once
// (the background's and three windows, 8 threads each) made every one of them several times slower.
// The indexer's work is nobody's wait, so it takes turns: one whisper and one loudness measurement at
// a time across every project, and none STARTS while an export is queued or running (Palmier's
// indexer waits while an export runs) or while a look's whisper runs or waits. A job already running
// is never stopped for one: the next simply does not start.

export type BackgroundKind = "whisper" | "loudness";

let exportsBusy = false;
/** Looks whose whisper is running or waiting for the one before it. */
let looks = 0;
let lookTail: Promise<unknown> = Promise.resolve();
const running: Record<BackgroundKind, boolean> = { whisper: false, loudness: false };
let waiters: Array<() => void> = [];

function wake(): void {
  const now = waiters;
  waiters = [];
  for (const w of now) w();
}

/** The export queue's state: true while any export is queued or running. */
export function setExportsBusy(busy: boolean): void {
  if (exportsBusy === busy) return;
  exportsBusy = busy;
  if (!busy) wake();
}

/** Run a look's whisper: at once, or after the look's whisper before it. Null, without running, when
 *  `signal` aborts first (Stop must answer at once, not after someone else's transcription). */
export async function lookWhisper<T>(
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T | null> {
  looks++;
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
    looks--;
    if (looks === 0) wake();
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
    if (!exportsBusy && looks === 0 && !running[kind]) {
      running[kind] = true;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        running[kind] = false;
        wake();
      };
    }
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

/** Tests only. */
export function __resetWorkGate(): void {
  exportsBusy = false;
  looks = 0;
  lookTail = Promise.resolve();
  running.whisper = false;
  running.loudness = false;
  wake();
}
