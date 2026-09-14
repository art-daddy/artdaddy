import { afterEach, describe, expect, it } from "vitest";

import {
  _pendingProjectLocks,
  beginProjectClose,
  isMutationRejected,
  isProjectClosing,
  runProjectMutation,
  whenProjectIdle,
  withProjectLock,
} from "./coordinator";
import {
  MutationAbortedError,
  MutationConflictError,
  MutationGate,
  ProjectClosingError,
} from "../project/MutationGate";
import { setOpenDocumentResolver } from "../project/openDocuments";
import { asProjectId, asSessionId } from "../project/types";

/** A controllable async gate so a test can hold an op "in flight". */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks run so we can observe what has (not) started yet. */
async function flushMicrotasks(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("withProjectLock", () => {
  it("runs a single op and returns its value", async () => {
    await expect(withProjectLock("/p", async () => 42)).resolves.toBe(42);
  });

  it("serializes concurrent read-modify-write on one project (no lost update)", async () => {
    // Shared 'manifest': RMW a counter with awaits in the middle. Unlocked, both
    // ops read 0 and write 1 (a LOST update -> 1). Serialized, op2 reads op1's
    // committed 1 and writes 2.
    const state = { n: 0 };
    const rmw = async () => {
      const read = state.n;
      await Promise.resolve();
      await Promise.resolve();
      state.n = read + 1;
    };
    await Promise.all([withProjectLock("/proj", rmw), withProjectLock("/proj", rmw)]);
    expect(state.n).toBe(2);
  });

  it("runs queued ops in FIFO order", async () => {
    const order: number[] = [];
    await Promise.all([
      withProjectLock("/p", async () => void order.push(1)),
      withProjectLock("/p", async () => void order.push(2)),
      withProjectLock("/p", async () => void order.push(3)),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("does not start the next op until the in-flight one settles", async () => {
    const gate = deferred();
    const order: string[] = [];
    const first = withProjectLock("/p", async () => {
      order.push("first:start");
      await gate.promise;
      order.push("first:end");
    });
    const second = withProjectLock("/p", async () => void order.push("second"));

    await flushMicrotasks();
    expect(order).toEqual(["first:start"]); // second is queued, not running

    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("a rejected op does not poison later ops; each caller gets its own outcome", async () => {
    const boom = new Error("boom");
    const p1 = withProjectLock("/p", async () => {
      throw boom;
    });
    const p2 = withProjectLock("/p", async () => "ok");
    await expect(p1).rejects.toBe(boom);
    await expect(p2).resolves.toBe("ok");
  });

  it("runs ops on distinct projects concurrently (no cross-project block)", async () => {
    const gateA = deferred();
    const events: string[] = [];
    const a = withProjectLock("/a", async () => {
      events.push("a:start");
      await gateA.promise;
      events.push("a:end");
    });
    const b = withProjectLock("/b", async () => void events.push("b:run"));

    await b; // resolves without waiting for the gated /a op
    expect(events).toContain("b:run");
    expect(events).not.toContain("a:end");

    gateA.resolve();
    await a;
  });

  it("normalizes separators + trailing slash so the same dir shares one queue", async () => {
    const gate = deferred();
    const order: string[] = [];
    const first = withProjectLock("C:/proj", async () => {
      order.push("first");
      await gate.promise;
    });
    // Backslashes + trailing slash: the SAME project -> must queue behind `first`.
    const second = withProjectLock("C:\\proj\\", async () => void order.push("second"));

    await flushMicrotasks();
    expect(order).toEqual(["first"]); // serialized, not interleaved

    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });

  it("drains the queue map back to idle once a project's ops settle", async () => {
    await flushMicrotasks(); // let any GC microtasks from earlier tests run
    const before = _pendingProjectLocks();
    await withProjectLock("/gc-unique", async () => undefined);
    await flushMicrotasks();
    expect(_pendingProjectLocks()).toBe(before);
  });
});

describe("project close lifecycle (beginProjectClose / whenProjectIdle)", () => {
  it("drains in-flight work before the close resolves; whenProjectIdle awaits the SAME drain; closing clears", async () => {
    const DIR = "C:/coord-close-1";
    const gate = deferred();
    let ran = false;
    const inflight = withProjectLock(DIR, async () => {
      await gate.promise;
      ran = true;
    });
    const drain = beginProjectClose(DIR);
    expect(isProjectClosing(DIR)).toBe(true);
    expect(whenProjectIdle(DIR)).toBe(drain); // a reopen awaits this exact promise while closing
    gate.resolve();
    await drain;
    expect(ran).toBe(true); // the close waited for the in-flight op (waitUntilIdle)
    expect(isProjectClosing(DIR)).toBe(false); // closing state cleared after the drain
    await inflight;
  });

  it("whenProjectIdle resolves immediately when the project is not closing", async () => {
    await expect(whenProjectIdle("C:/never-closed")).resolves.toBeUndefined();
  });

  it("is idempotent: a second beginProjectClose while pending returns the same drain", async () => {
    const DIR = "C:/coord-close-2";
    const gate = deferred();
    const inflight = withProjectLock(DIR, async () => void (await gate.promise));
    const d1 = beginProjectClose(DIR);
    const d2 = beginProjectClose(DIR);
    expect(d2).toBe(d1);
    gate.resolve();
    await d1;
    await inflight;
  });
});

describe("runProjectMutation (the mandatory project-mutation executor, Step 4)", () => {
  const PID = asProjectId("pm");
  const SID = asSessionId("s1");
  const dir = "/x/projects/pm";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docWith = (gate: MutationGate) =>
    setOpenDocumentResolver((id) => (id === PID ? ({ gate, sessionId: SID } as any) : undefined));
  afterEach(() => setOpenDocumentResolver(() => undefined));

  it("commits under the open document's GATE and advances the revision on markCommitted", async () => {
    const gate = new MutationGate(PID, SID);
    docWith(gate);
    expect(gate.currentRevision()).toBe(0);
    const r = await runProjectMutation(dir, "library.remove", async (doc, ctx) => {
      expect(doc).toBeTruthy(); // the open document was resolved
      expect(ctx).toBeTruthy(); // ...and the commit ran UNDER the gate (ctx provided)
      ctx?.markCommitted();
      return "ok";
    });
    expect(r).toBe("ok");
    expect(gate.currentRevision()).toBe(1); // a real project mutation advanced the SAME gate as timeline
  });

  it("falls back to the per-project lock when no document is open (ctx null)", async () => {
    let sawCtx: unknown = "unset";
    const r = await runProjectMutation("/x/projects/none", "library.remove", async (doc, ctx) => {
      sawCtx = ctx;
      expect(doc).toBeNull();
      return 7;
    });
    expect(r).toBe(7);
    expect(sawCtx).toBeUndefined(); // no gate ctx on the lock fallback (a bare store / pre-publish)
  });

  it("propagates the gate's not-written rejection when the project is closing", async () => {
    const gate = new MutationGate(PID, SID);
    await gate.beginClose(); // the project is closing -> admission closed
    docWith(gate);
    await expect(runProjectMutation(dir, "library.remove", async () => "x")).rejects.toBeInstanceOf(
      ProjectClosingError,
    );
  });

  it("isMutationRejected recognizes the gate's not-written rejections, not other errors", () => {
    expect(isMutationRejected(new ProjectClosingError())).toBe(true);
    expect(isMutationRejected(new MutationConflictError())).toBe(true);
    expect(isMutationRejected(new MutationAbortedError())).toBe(true);
    expect(isMutationRejected(new Error("disk full"))).toBe(false);
  });

  it("fails a NO-DOCUMENT commit CLOSED while the project is mid-close (no bare-lock bypass)", async () => {
    // Reviewer blocker 1: a late publish whose document was already evicted must NOT slip past on the
    // plain lock. Hold the project lock busy so beginProjectClose's drain can't finish → the dir stays
    // `closing`, and a no-document commit is rejected instead of running.
    const cdir = "/x/projects/closingpm";
    const hold = deferred();
    const busy = withProjectLock(cdir, () => hold.promise);
    const closing = beginProjectClose(cdir); // its drain queues BEHIND `busy`, so the dir stays closing
    expect(isProjectClosing(cdir)).toBe(true);
    let ran = false;
    await expect(
      runProjectMutation(cdir, "library.import", async () => {
        ran = true;
        return "x";
      }),
    ).rejects.toBeInstanceOf(ProjectClosingError);
    expect(ran).toBe(false); // the commit NEVER executed — nothing published during close
    hold.resolve();
    await busy;
    await closing;
    expect(isProjectClosing(cdir)).toBe(false);
  });

  it("RUNS a no-document commit for an IDLE (not-closing) project — renaming an inactive project still works", async () => {
    // The owner Q1 caveat: fail-closed must NOT break a genuinely document-less write. An inactive
    // project (never opened / a fresh store) has no document and is not closing → the plain lock runs.
    const idir = "/x/projects/idlepm";
    expect(isProjectClosing(idir)).toBe(false);
    let ran = false;
    const r = await runProjectMutation(idir, "project.settings", async (doc) => {
      ran = true;
      expect(doc).toBeNull();
      return "renamed";
    });
    expect(r).toBe("renamed");
    expect(ran).toBe(true);
  });

  it("rejects a commit whose Stop signal already aborted, under the open document's gate", async () => {
    // Reviewer blocker 1: the timeline dropped the Stop signal. runProjectMutation now threads it into
    // the gate request, so an edit whose turn was Stopped before admission is rejected — never committed.
    const gate = new MutationGate(PID, SID);
    docWith(gate);
    const ac = new AbortController();
    ac.abort();
    let ran = false;
    await expect(
      runProjectMutation(
        dir,
        "timeline.commit",
        async (_doc, ctx) => {
          ran = true;
          ctx?.markCommitted();
          return "x";
        },
        { signal: ac.signal },
      ),
    ).rejects.toBeInstanceOf(MutationAbortedError);
    expect(ran).toBe(false);
    expect(gate.currentRevision()).toBe(0); // rejected before the commit — the revision never advanced
  });
});
