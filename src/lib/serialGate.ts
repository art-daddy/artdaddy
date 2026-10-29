// A gate that lets one task through at a time, in arrival order, and lets a waiting task give up. See serialGate.test.ts
// for what it must never do: run two tasks at once, or be left wedged by a task that fails or a waiter that is stopped.

const abortError = () => new DOMException("Aborted", "AbortError");

export class SerialGate {
  private busy = false;
  private readonly waiting: (() => void)[] = [];

  /** Run `task` when every task that arrived before it has finished. A `signal` that stops while it is still waiting
   *  rejects with an AbortError and the task never runs; once the task is running the signal is the task's own business. */
  async run<T>(task: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      // Stopped in the instant between being let through and starting: still never begins.
      if (signal?.aborted) throw abortError();
      return await task();
    } finally {
      release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const onAbort = () => {
        const at = this.waiting.indexOf(take);
        if (at >= 0) {
          this.waiting.splice(at, 1);
          reject(abortError());
        }
      };
      // Ownership of the gate is handed to this waiter: `busy` stays true until it releases.
      const take = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve(() => this.handOver());
      };
      if (!this.busy) {
        this.busy = true;
        take();
      } else {
        this.waiting.push(take);
        signal?.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  private handOver(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.busy = false;
  }
}
