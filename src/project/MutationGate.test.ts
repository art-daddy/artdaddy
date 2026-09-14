import { describe, expect, it } from "vitest";

import {
  MutationAbortedError,
  MutationConflictError,
  MutationGate,
  type MutationOrigin,
  type MutationRequest,
  ProjectClosingError,
} from "./MutationGate";
import { asProjectId, asSessionId } from "./types";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const PID = asProjectId("p1");
const SID = asSessionId("s1");
const gate = (isOriginCurrent?: (o: MutationOrigin) => boolean) =>
  new MutationGate(PID, SID, isOriginCurrent);
const req = (over: Partial<MutationRequest> = {}): MutationRequest => ({
  operation: "op",
  documentSessionId: SID,
  ...over,
});

describe("MutationGate", () => {
  it("runs mutations one at a time in FIFO order", async () => {
    const g = gate();
    const order: string[] = [];
    const d1 = deferred();
    const d2 = deferred();
    const p1 = g.run(req({ operation: "a" }), async () => {
      order.push("a-start");
      await d1.promise;
      order.push("a-end");
    });
    const p2 = g.run(req({ operation: "b" }), async () => {
      order.push("b-start");
      await d2.promise;
      order.push("b-end");
    });
    await Promise.resolve();
    expect(order).toEqual(["a-start"]); // b waits — one at a time
    d1.resolve();
    await p1;
    await Promise.resolve();
    expect(order).toEqual(["a-start", "a-end", "b-start"]); // b starts only after a ends
    d2.resolve();
    await p2;
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("advances the revision ONLY when a mutation marks committed; baseRevision reflects it", async () => {
    const g = gate();
    expect(g.currentRevision()).toBe(0);
    await g.run(req(), async (ctx) => {
      expect(ctx.baseRevision).toBe(0);
      ctx.markCommitted();
    });
    expect(g.currentRevision()).toBe(1);
    await g.run(req(), async (ctx) => {
      expect(ctx.baseRevision).toBe(1);
      ctx.markCommitted();
    });
    expect(g.currentRevision()).toBe(2);
  });

  it("does NOT advance the revision for a read / no-op that never marks committed", async () => {
    const g = gate();
    await g.run(req(), async () => "a read — nothing changed"); // never calls markCommitted
    expect(g.currentRevision()).toBe(0); // a read / no-op / {ok:false} is not a state change
    await g.run(req(), async (ctx) => ctx.markCommitted()); // a real mutation DOES advance it
    expect(g.currentRevision()).toBe(1);
  });

  it("does not advance the revision when the operation throws, and lets the next op run", async () => {
    const g = gate();
    await expect(
      g.run(req(), async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(g.currentRevision()).toBe(0);
    await g.run(req(), async (ctx) => ctx.markCommitted()); // lease was released -> next op proceeds + commits
    expect(g.currentRevision()).toBe(1);
  });

  it("assertCanCommit rejects a mutation whose signal aborted WHILE it waited in the queue (cancel-after-queue)", async () => {
    const g = gate();
    const d1 = deferred();
    const ac = new AbortController();
    // `a` holds the lease; `b` (with a signal) queues behind it, past its submission preflight.
    const p1 = g.run(req({ operation: "a" }), async () => {
      await d1.promise;
    });
    const p2 = g.run(req({ operation: "b", signal: ac.signal }), async (ctx) =>
      ctx.assertCanCommit(),
    );
    await Promise.resolve(); // a leased, b queued
    ac.abort(); // the cancellation fires WHILE b waits — submission preflight already passed
    d1.resolve();
    await p1;
    await expect(p2).rejects.toBeInstanceOf(MutationAbortedError); // re-checked at the commit boundary, not just submission
  });

  it("rejects a submission after close begins (ProjectClosingError)", async () => {
    const g = gate();
    await g.beginClose();
    await expect(g.run(req(), async () => {})).rejects.toBeInstanceOf(ProjectClosingError);
  });

  it("beginClose rejects queued work but lets the already-leased commit finish", async () => {
    const g = gate();
    const d1 = deferred();
    let aCommitted = false;
    let bRan = false;
    const p1 = g.run(req({ operation: "a" }), async () => {
      await d1.promise;
      aCommitted = true;
    });
    const p2 = g.run(req({ operation: "b" }), async () => {
      bRan = true;
    });
    await Promise.resolve(); // a is leased/running, b is queued
    const closeP = g.beginClose();
    await expect(p2).rejects.toBeInstanceOf(ProjectClosingError); // queued -> rejected
    expect(bRan).toBe(false);
    d1.resolve();
    await p1;
    expect(aCommitted).toBe(true); // the admitted commit still finished
    await closeP; // close resolves only after the admitted commit settled
  });

  it("preflight rejects a stale session, an aborted signal, and a superseded origin", async () => {
    const g = gate((o) => o.branchId === 2); // only branch 2 is current
    await expect(
      g.run({ operation: "x", documentSessionId: asSessionId("other") }, async () => {}),
    ).rejects.toBeInstanceOf(MutationConflictError);
    const ac = new AbortController();
    ac.abort();
    await expect(
      g.run({ operation: "x", documentSessionId: SID, signal: ac.signal }, async () => {}),
    ).rejects.toBeInstanceOf(MutationAbortedError);
    await expect(
      g.run(
        {
          operation: "x",
          documentSessionId: SID,
          origin: { chatSessionId: "c", branchId: 1, executionId: 1 },
        },
        async () => {},
      ),
    ).rejects.toBeInstanceOf(MutationConflictError);
  });

  it("assertCanCommit rejects a commit whose chat branch was superseded mid-flight", async () => {
    let currentBranch = 1;
    const g = gate((o) => o.branchId === currentBranch);
    const origin: MutationOrigin = { chatSessionId: "c", branchId: 1, executionId: 1 };
    const d = deferred();
    const p = g.run({ operation: "restore", documentSessionId: SID, origin }, async (ctx) => {
      await d.promise; // the op stages work...
      currentBranch = 2; // ...a checkpoint restore bumped the branch under it
      ctx.assertCanCommit(); // must reject: this origin (branch 1) is now superseded
    });
    d.resolve();
    await expect(p).rejects.toBeInstanceOf(MutationConflictError);
  });

  it("waitForIdle resolves once the in-flight commit settles", async () => {
    const g = gate();
    await expect(g.waitForIdle()).resolves.toBeUndefined();
    const d = deferred();
    const p = g.run(req(), async () => {
      await d.promise;
    });
    await Promise.resolve();
    let idle = false;
    const idleP = g.waitForIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    d.resolve();
    await p;
    await idleP;
    expect(idle).toBe(true);
  });
});
