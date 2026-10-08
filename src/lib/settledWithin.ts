/** `p`'s value, or null once `ms` pass or `signal` aborts, whichever is first. `p` keeps running
 *  either way; a rejection of `p` also reads as null, so pass a promise that does not reject when
 *  a failure must be told apart from a timeout. */
export function settledWithin<T>(
  p: Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T | null> {
  return new Promise((resolve) => {
    const finish = (v: T | null): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve(v);
    };
    const stop = (): void => finish(null);
    const timer = setTimeout(stop, ms);
    if (signal?.aborted) return stop();
    signal?.addEventListener("abort", stop, { once: true });
    p.then(finish, stop);
  });
}
