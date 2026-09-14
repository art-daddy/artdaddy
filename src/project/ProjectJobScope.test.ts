import { describe, expect, it } from "vitest";

import { ProjectClosingError } from "./MutationGate";
import { ProjectJobScope } from "./ProjectJobScope";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ProjectJobScope", () => {
  it("runs a job with an abort signal and reports it completed", async () => {
    const scope = new ProjectJobScope();
    let sawSignal = false;
    const result = await scope.run({ kind: "probe" }, async (signal) => {
      sawSignal = signal instanceof AbortSignal;
      return 42;
    });
    expect(result).toBe(42);
    expect(sawSignal).toBe(true);
    expect(scope.list()).toHaveLength(0); // terminal jobs are cleared from the active set
  });

  it("cancel(id) aborts a specific running job", async () => {
    const scope = new ProjectJobScope();
    const d = deferred();
    let aborted = false;
    const p = scope.run({ kind: "download" }, async (signal) => {
      signal.addEventListener("abort", () => (aborted = true));
      await d.promise;
    });
    await Promise.resolve();
    const [status] = scope.list();
    expect(status.kind).toBe("download");
    expect(status.state).toBe("running");
    scope.cancel(status.id);
    expect(aborted).toBe(true);
    d.resolve();
    await p;
  });

  it("beginClose aborts cancelOnClose jobs but not finishBeforeClose, and waits only for the latter", async () => {
    const scope = new ProjectJobScope();
    const dCancel = deferred();
    const dFinish = deferred();
    let cancelAborted = false;
    let finishAborted = false;
    const pCancel = scope.run({ kind: "download", policy: "cancelOnClose" }, async (signal) => {
      signal.addEventListener("abort", () => (cancelAborted = true));
      await dCancel.promise;
    });
    const pFinish = scope.run({ kind: "commit", policy: "finishBeforeClose" }, async (signal) => {
      signal.addEventListener("abort", () => (finishAborted = true));
      await dFinish.promise;
    });
    await Promise.resolve();
    let closed = false;
    const closeP = scope.beginClose().then(() => (closed = true));
    expect(cancelAborted).toBe(true); // cancelOnClose aborted
    expect(finishAborted).toBe(false); // finishBeforeClose left alone
    dCancel.resolve();
    await pCancel;
    await Promise.resolve();
    expect(closed).toBe(false); // close still waits for the finishBeforeClose job
    dFinish.resolve();
    await pFinish;
    await closeP;
    expect(closed).toBe(true);
  });

  it("detaches a resumable job on close (aborts it; does not wait)", async () => {
    const scope = new ProjectJobScope();
    const d = deferred();
    let aborted = false;
    const p = scope.run({ kind: "generate", policy: "resumable" }, async (signal) => {
      signal.addEventListener("abort", () => (aborted = true));
      await d.promise;
    });
    await Promise.resolve();
    await scope.beginClose(); // resolves WITHOUT waiting for the resumable job
    expect(aborted).toBe(true); // detached
    d.resolve();
    await p;
  });

  it("rejects a job submitted after close begins", async () => {
    const scope = new ProjectJobScope();
    await scope.beginClose();
    await expect(scope.run({ kind: "x" }, async () => {})).rejects.toBeInstanceOf(
      ProjectClosingError,
    );
  });
});
