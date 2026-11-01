// A time limit for the tools that only look or wait.
//
// Nothing but the person pressing Stop could end a tool call: a look that stalled, or a vision
// call whose upload never finished, held the whole turn. A tool that READS, or waits on work that
// can be rebuilt, now answers within a bound, and the model is told in a sentence it can act on.
// A tool that MAKES something (an edit, an import, a generation, a render) is never cut off here:
// stopping it half way leaves a half-made thing, and its own progress is what the person watches.
//
// Which tools those are is the contract's effect class (`contract/effects.ts`), not a second list.
import { toolEffect } from "../contract/effects";

/** The most a bounded tool call may hold a turn. Calls that ran past it in the field mostly failed
 *  anyway (video_find_moment: 1 of 9 over five minutes succeeded). */
export const READ_BOUND_MS = 5 * 60_000;
/** After the bound the tool is told to stop and gets this long to do it; then the turn goes on. */
export const ABORT_GRACE_MS = 3_000;

const BOUNDED_EFFECTS: ReadonlySet<string> = new Set(["read", "derived-job"]);

/** The most `name` may hold a turn, in ms, or null when it is never cut off. A tool the contract
 *  does not classify is never cut off: a limit is only ever applied on purpose. */
export function toolBoundMs(name: string): number | null {
  const effect = toolEffect(name);
  return effect !== undefined && BOUNDED_EFFECTS.has(effect) ? READ_BOUND_MS : null;
}

export type Bounded<T> = { timedOut: false; value: T } | { timedOut: true; boundMs: number };

/** Run `run` for at most `boundMs` (null: no limit). The run gets a signal that ends with the
 *  caller's own (Stop) or at the bound. At the bound the run is told to stop and has `graceMs` to
 *  do it; whatever it then does, the answer is `timedOut`, and a late result or failure is dropped
 *  here, so the turn never sees two answers for one call. */
export function runBounded<T>(
  run: (signal: AbortSignal) => Promise<T>,
  opts: { boundMs: number | null; signal?: AbortSignal; graceMs?: number },
): Promise<Bounded<T>> {
  const own = new AbortController();
  const parent = opts.signal;
  const onParentAbort = (): void => own.abort();
  if (parent?.aborted) own.abort();
  else parent?.addEventListener("abort", onParentAbort);

  let started: Promise<T>;
  try {
    started = run(own.signal);
  } catch (e) {
    started = Promise.reject(e);
  }
  return new Promise<Bounded<T>>((resolve, reject) => {
    let over = false;
    let done = false;
    let bound: ReturnType<typeof setTimeout> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = (answer: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(bound);
      clearTimeout(grace);
      parent?.removeEventListener("abort", onParentAbort);
      answer();
    };
    const timedOut = (): void =>
      finish(() => resolve({ timedOut: true, boundMs: opts.boundMs ?? 0 }));
    started.then(
      (value) => (over ? timedOut() : finish(() => resolve({ timedOut: false, value }))),
      (error: unknown) => (over ? timedOut() : finish(() => reject(error))),
    );
    if (opts.boundMs !== null) {
      bound = setTimeout(() => {
        over = true;
        own.abort();
        grace = setTimeout(timedOut, opts.graceMs ?? ABORT_GRACE_MS);
      }, opts.boundMs);
    }
  });
}

/** What the model reads when a tool was stopped at its bound. */
export function timedOutResult(name: string, boundMs: number): Record<string, unknown> {
  const minutes = Math.max(1, Math.round(boundMs / 60_000));
  return {
    ok: false,
    timed_out: true,
    bound_s: Math.round(boundMs / 1000),
    error:
      `${name} did not finish within ${minutes} minute${minutes === 1 ? "" : "s"} and was stopped. ` +
      `Nothing was changed. Do not repeat the same call: tell the user it took too long and try ` +
      `something smaller (a shorter time range, a smaller file) or another way.`,
  };
}

/** Whether a tool result is the answer {@link timedOutResult} makes. */
export function isTimedOutResult(result: unknown): boolean {
  return (
    result !== null &&
    typeof result === "object" &&
    (result as { timed_out?: unknown }).timed_out === true
  );
}
