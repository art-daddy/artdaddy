import { describe, expect, it } from "vitest";

import type { ProjectChildren } from "./ProjectDocument";
import { ProjectDocumentRegistry } from "./ProjectDocumentRegistry";
import { asProjectId } from "./types";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drain a bounded number of microtasks. close() now defers children.close behind the empty
 *  gate/jobs drain, so the fake's `close` (f.closes[i]) is invoked a few microtasks later. */
async function flush(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/** Children whose `open` auto-resolves from a script (default "loaded"), and whose
 *  `close` is deferred so a test can observe close/open ordering. */
function fakeChildren(openResults: Array<"loaded" | "failed"> = []) {
  let openCalls = 0;
  const closes: Array<ReturnType<typeof deferred<void>>> = [];
  const children: ProjectChildren = {
    open: async () => {
      const r = openResults[openCalls] ?? "loaded";
      openCalls++;
      return r;
    },
    dispose: () => {
      const d = deferred<void>();
      closes.push(d);
      return d.promise;
    },
  };
  return {
    children,
    get openCalls() {
      return openCalls;
    },
    closes,
  };
}

describe("ProjectDocumentRegistry", () => {
  it("dedupes concurrent open(A) to one in-flight open and one instance", async () => {
    const openD = deferred<"loaded" | "failed">();
    let openCalls = 0;
    const children: ProjectChildren = {
      open: () => {
        openCalls++;
        return openD.promise;
      },
      dispose: async () => {},
    };
    const reg = new ProjectDocumentRegistry(() => children);
    const A = asProjectId("A");
    const p1 = reg.open(A);
    const p2 = reg.open(A);
    expect(p1).toBe(p2); // single-flight
    expect(openCalls).toBe(1);
    openD.resolve("loaded");
    const [d1, d2] = await Promise.all([p1, p2]);
    expect(d1).toBe(d2);
    expect(reg.get(A)).toBe(d1);
  });

  it("returns the already-open instance without reopening", async () => {
    const f = fakeChildren();
    const reg = new ProjectDocumentRegistry(() => f.children);
    const A = asProjectId("A");
    const doc = await reg.open(A);
    const again = await reg.open(A);
    expect(again).toBe(doc);
    expect(f.openCalls).toBe(1);
  });

  it("getAuthority keeps the CLOSING document as the runtime authority while get() hides it (reviewer blocker 1)", async () => {
    // The ownership/visibility split: the UI open-view (`get`/`listOpen`) drops a document the instant
    // close begins, but the runtime AUTHORITY view (`getAuthority`, which the mutation executor resolves
    // through) keeps the mid-close document so a late commit routes through its (closing) gate and is
    // REJECTED — instead of finding "no document" and slipping past admission on a bare lock.
    const f = fakeChildren();
    const reg = new ProjectDocumentRegistry(() => f.children);
    const A = asProjectId("A");
    const doc = await reg.open(A);
    expect(reg.get(A)).toBe(doc);
    expect(reg.getAuthority(A)).toBe(doc); // open: both views resolve it

    const closeP = reg.close(A); // dispose deferred (f.closes[0] pending) -> mid-close window
    expect(reg.get(A)).toBeUndefined(); // UI open-visibility: gone the instant close begins
    expect(reg.getAuthority(A)).toBe(doc); // runtime authority: the closing doc STILL owns the dir
    expect(reg.listOpen()).not.toContain(doc); // listOpen is the UI view too — excludes the closing doc

    await flush(); // let close drain the gate/jobs + save, reaching children.dispose
    expect(reg.getAuthority(A)).toBe(doc); // still mid-close (dispose pending) -> still the authority

    f.closes[0].resolve(); // dispose completes -> close finishes
    await closeP;
    await flush();
    expect(reg.getAuthority(A)).toBeUndefined(); // fully closed: no authority -> executor fallback + sessionLive belt own it now
  });

  it("an open of a closing project waits for the close, then builds a fresh instance", async () => {
    const f = fakeChildren();
    const reg = new ProjectDocumentRegistry(() => f.children);
    const A = asProjectId("A");
    const first = await reg.open(A);
    const closeP = reg.close(A); // close deferred (f.closes[0] pending)
    expect(reg.get(A)).toBeUndefined(); // removed from the open set synchronously
    const reopenP = reg.open(A);
    let reopened = false;
    void reopenP.then(() => {
      reopened = true;
    });
    await flush();
    expect(reopened).toBe(false); // reopen is blocked on the pending close (open-awaits-close)
    f.closes[0].resolve();
    await closeP;
    const second = await reopenP;
    expect(second).not.toBe(first); // fresh instance, not the torn-down one
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(f.openCalls).toBe(2);
  });

  it("close is idempotent and removes the document once settled", async () => {
    const f = fakeChildren();
    const reg = new ProjectDocumentRegistry(() => f.children);
    const A = asProjectId("A");
    await reg.open(A);
    const c1 = reg.close(A);
    const c2 = reg.close(A);
    expect(c2).toBe(c1); // same in-flight close promise
    await flush();
    expect(f.closes).toHaveLength(1);
    f.closes[0].resolve();
    await c1;
    expect(reg.get(A)).toBeUndefined();
  });

  it("evicts a failed open (after tearing it down) so a retry rebuilds from scratch", async () => {
    let openCalls = 0;
    let closeCalls = 0;
    const results: Array<"loaded" | "failed"> = ["failed", "loaded"];
    const reg = new ProjectDocumentRegistry(() => ({
      open: async () => results[openCalls++] ?? "loaded",
      dispose: async () => {
        closeCalls++; // auto-resolve so the document's teardown-on-failed settles
      },
    }));
    const A = asProjectId("A");
    await expect(reg.open(A)).rejects.toThrow(/could not open/);
    expect(reg.get(A)).toBeUndefined(); // a broken open is never cached
    expect(closeCalls).toBe(1); // ...and it was torn down, not left running
    const doc = await reg.open(A);
    expect(doc.phase()).toBe("open");
    expect(openCalls).toBe(2);
  });

  it("close while OPENING tears the doc down when it settles (no orphaned open)", async () => {
    const openD = deferred<"loaded" | "failed">();
    const closeD = deferred<void>();
    let opens = 0;
    let closes = 0;
    const children: ProjectChildren = {
      open: () => {
        opens++;
        return openD.promise;
      },
      dispose: () => {
        closes++;
        return closeD.promise;
      },
    };
    const reg = new ProjectDocumentRegistry(() => children);
    const A = asProjectId("A");
    const openP = reg.open(A); // in flight (openD pending)
    const closeP = reg.close(A); // close arrives mid-open -> dooms it
    expect(reg.get(A)).toBeUndefined();
    openD.resolve("loaded"); // the open finishes...
    await openP; // ...doc returned, but doomed -> never published as open
    expect(reg.get(A)).toBeUndefined();
    closeD.resolve();
    await closeP;
    expect(opens).toBe(1);
    expect(closes).toBe(1); // the doomed doc's children were torn down (no orphan)
    expect(reg.listOpen()).toHaveLength(0);
  });

  it("a reopen during a close-while-opening tears down the first and opens a fresh instance", async () => {
    const open1 = deferred<"loaded" | "failed">();
    const close1 = deferred<void>();
    const open2 = deferred<"loaded" | "failed">();
    let built = 0;
    const closesByInstance: number[] = [];
    const reg = new ProjectDocumentRegistry(() => {
      const idx = built++;
      closesByInstance[idx] = 0;
      return {
        open: () => (idx === 0 ? open1.promise : open2.promise),
        dispose: () => {
          closesByInstance[idx]++;
          return idx === 0 ? close1.promise : Promise.resolve();
        },
      };
    });
    const A = asProjectId("A");
    const firstP = reg.open(A); // instance 0 opening
    const closeP = reg.close(A); // dooms instance 0
    const reopenP = reg.open(A); // must wait for instance 0's teardown, then build instance 1
    let reopened = false;
    void reopenP.then(() => {
      reopened = true;
    });
    open1.resolve("loaded"); // instance 0 finishes opening (doomed)
    await firstP;
    await Promise.resolve();
    expect(reopened).toBe(false); // reopen still blocked on instance 0's close
    close1.resolve(); // instance 0 torn down
    await closeP;
    open2.resolve("loaded"); // instance 1 opens
    const second = await reopenP;
    expect(built).toBe(2);
    expect(closesByInstance[0]).toBe(1); // the first instance was torn down, not orphaned
    expect(reg.get(A)).toBe(second); // the fresh instance is the open one
  });

  it("whenIdle resolves only once in-flight closes settle (close-before-open barrier)", async () => {
    const f = fakeChildren();
    const reg = new ProjectDocumentRegistry(() => f.children);
    const A = asProjectId("A");
    await reg.open(A);
    const closeP = reg.close(A); // deferred close (f.closes[0] pending)
    let idle = false;
    const idleP = reg.whenIdle().then(() => {
      idle = true;
    });
    await flush();
    expect(idle).toBe(false); // not idle while A is still closing
    f.closes[0].resolve();
    await closeP;
    await idleP;
    expect(idle).toBe(true); // idle once the teardown settled
  });

  it("a FAILED close is retained and a reopen returns the SAME document, never a second (finding #2)", async () => {
    let saveOk = false;
    let built = 0;
    const reg = new ProjectDocumentRegistry(() => {
      built++;
      return {
        open: async () => "loaded",
        saveTranscript: async () => saveOk,
        dispose: async () => {},
      };
    });
    const A = asProjectId("A");
    const first = await reg.open(A);
    expect(await reg.close(A)).toEqual({ ok: false }); // the SAVE fails -> close-failed -> re-inserted
    expect(reg.get(A)).toBe(first); // retained (live), same instance
    // A reopen while close-failed must NOT construct a second live document.
    const again = await reg.open(A);
    expect(again).toBe(first); // one live document per project — the SAME instance
    expect(built).toBe(1); // no second document was ever built
    expect(reg.listOpen()).toHaveLength(1);
  });

  it("a reopen RACING an in-flight close that then FAILS returns the retained doc (finding #2)", async () => {
    const saveD = deferred<boolean>();
    let built = 0;
    const reg = new ProjectDocumentRegistry(() => {
      built++;
      return {
        open: async () => "loaded",
        saveTranscript: () => saveD.promise,
        dispose: async () => {},
      };
    });
    const A = asProjectId("A");
    const first = await reg.open(A);
    const closeP = reg.close(A); // enters the SAVE phase, blocked on saveD
    expect(reg.get(A)).toBeUndefined(); // removed from the open set synchronously
    const reopenP = reg.open(A); // reopen races: doOpen awaits the in-flight close (open-awaits-close)
    saveD.resolve(false); // the close SAVE fails -> re-insert + {ok:false}
    expect(await closeP).toEqual({ ok: false });
    const again = await reopenP;
    expect(again).toBe(first); // the retained doc, NOT a freshly-built second one over it
    expect(built).toBe(1);
    expect(reg.listOpen()).toHaveLength(1);
  });

  it("a close-DURING-OPEN (doomed) whose SAVE fails is RETAINED — a racing reopen returns it, no second doc (finding #1)", async () => {
    const openD = deferred<"loaded" | "failed">();
    let built = 0;
    const reg = new ProjectDocumentRegistry(() => {
      built++;
      return {
        open: () => openD.promise,
        saveTranscript: async () => false,
        dispose: async () => {},
      };
    });
    const A = asProjectId("A");
    const openP = reg.open(A); // #1: still OPENING (openD pending)
    const closeP = reg.close(A); // dooms #1 and chains its teardown (the pending-open close branch)
    const reopenP = reg.open(A); // #2: racing reopen — must await #1's doomed close, not build anew
    openD.resolve("loaded"); // #1 finishes opening -> doomed doc, never published
    // The doomed doc's SAVE fails: the pending branch must RE-INSERT it (like the open branch), else #2
    // finds nothing and builds a SECOND live document over the unreachable dirty original.
    expect(await closeP).toEqual({ ok: false });
    const first = await openP;
    const second = await reopenP;
    expect(second).toBe(first); // #2 returns the RETAINED doomed doc, not a second one
    expect(first.phase()).toBe("close-failed"); // retained, live, recoverable
    expect(built).toBe(1); // exactly ONE document was ever built
    expect(reg.listOpen()).toHaveLength(1);
  });

  it("a SECOND close dooms a reopen that slipped in after the FIRST close — A is never silently reopened (finding #1)", async () => {
    const open1 = deferred<"loaded" | "failed">();
    let built = 0;
    const reg = new ProjectDocumentRegistry(() => {
      const idx = built++;
      return {
        open: () => (idx === 0 ? open1.promise : Promise.resolve("loaded")),
        saveTranscript: async () => true,
        dispose: async () => {},
      };
    });
    const A = asProjectId("A");
    const openP1 = reg.open(A); // #1 opening
    const closeP1 = reg.close(A); // close #1 dooms #1
    const openP2 = reg.open(A); // a reopen slips in AFTER close #1
    const closeP2 = reg.close(A); // close #2 must ALSO doom that reopen — not merely reuse close #1's promise
    open1.resolve("loaded"); // #1 finishes opening (doomed) -> torn down
    expect((await closeP1).ok).toBe(true);
    expect((await closeP2).ok).toBe(true);
    await Promise.allSettled([openP1, openP2]); // the doomed reopen rejects (cancelled by the close)
    // The user closed A twice: A must stay CLOSED, never silently reopened by the waiting reopen.
    expect(reg.get(A)).toBeUndefined();
    expect(reg.listOpen()).toHaveLength(0);
    expect(built).toBe(1); // the doomed reopen was never even built
  });

  it("close1 FAILS, a racing reopen is doomed by close2, close2 SUCCEEDS => registry EMPTY + next open builds fresh (finding #1)", async () => {
    const open1 = deferred<"loaded" | "failed">();
    let saveCalls = 0;
    let built = 0;
    let disposes = 0;
    const reg = new ProjectDocumentRegistry(() => {
      const idx = built++;
      return {
        open: () => (idx === 0 ? open1.promise : Promise.resolve("loaded")),
        saveTranscript: async () => saveCalls++ > 0, // close1's save fails; close2 (retry on the SAME doc) succeeds
        dispose: async () => void disposes++,
      };
    });
    const A = asProjectId("A");
    const openP1 = reg.open(A); // #1 opening
    const closeP1 = reg.close(A); // close1 dooms #1
    const openP2 = reg.open(A); // a reopen slips in (entry2)
    const closeP2 = reg.close(A); // close2 dooms entry2
    open1.resolve("loaded"); // #1 finishes opening (doomed) -> doc1
    const [o1, o2] = await Promise.all([closeP1, closeP2]);
    expect(o1).toEqual({ ok: false }); // close1's save failed -> doc1 retained close-failed
    expect(o2).toEqual({ ok: true }); // close2 tore down the RETAINED doc and succeeded
    await Promise.allSettled([openP1, openP2]);
    // The registry is EMPTY — a successful close never leaves a disposed/closed doc registered as open
    // (the bug: settleClose reinserted on failure but never evicted a doc a prior failed close re-added).
    expect(reg.get(A)).toBeUndefined();
    expect(reg.listOpen()).toHaveLength(0);
    expect(disposes).toBe(1); // disposed exactly once (close2)
    expect(built).toBe(1); // one doc ever built (the doomed reopen never built)
    // The next open builds FRESH children — not a disposed, phase-`closed` instance.
    const fresh = await reg.open(A);
    expect(fresh.phase()).toBe("open");
    expect(built).toBe(2);
  });

  it("whenIdle waits for the LATEST (replacement) close, not just the first (finding #2)", async () => {
    const open1 = deferred<"loaded" | "failed">();
    const save2 = deferred<boolean>();
    let saveCalls = 0;
    let built = 0;
    const reg = new ProjectDocumentRegistry(() => {
      const idx = built++;
      return {
        open: () => (idx === 0 ? open1.promise : Promise.resolve("loaded")),
        saveTranscript: async () => (++saveCalls === 1 ? false : save2.promise), // close1 fails fast; close2 (retry) BLOCKS
        dispose: async () => {},
      };
    });
    const A = asProjectId("A");
    const openP1 = reg.open(A);
    const closeP1 = reg.close(A); // dooms #1 (p1)
    const openP2 = reg.open(A); // reopen (entry2)
    const closeP2 = reg.close(A); // dooms entry2, p2 REPLACES p1 in `closing`
    open1.resolve("loaded");
    expect(await closeP1).toEqual({ ok: false }); // close1 settled (failed); close2 now retrying, blocked on save2
    let idle = false;
    const idleP = reg.whenIdle().then(() => (idle = true));
    await flush();
    expect(idle).toBe(false); // must NOT resolve while close2 (the latest, which replaced p1) is still saving
    save2.resolve(true); // close2's save completes
    await closeP2;
    await idleP;
    expect(idle).toBe(true); // resolves ONLY after the latest close settled
    expect(reg.get(A)).toBeUndefined(); // and A ended closed + evicted
    await Promise.allSettled([openP1, openP2]);
  });

  it("firstCloseFailed surfaces a retained close-failed document, cleared on discard (finding #4)", async () => {
    const reg = new ProjectDocumentRegistry(() => ({
      open: async () => "loaded",
      saveTranscript: async () => false, // the close SAVE fails
      dispose: async () => {},
    }));
    const A = asProjectId("A");
    const doc = await reg.open(A);
    expect(reg.firstCloseFailed()).toBeUndefined(); // nothing failed yet
    expect(await reg.close(A)).toEqual({ ok: false });
    expect(reg.firstCloseFailed()).toBe(doc); // the retained, close-failed doc (Shell's veto backstop)
    expect(doc.phase()).toBe("close-failed");
    await reg.discardClose(A); // recovering it clears the backstop
    expect(reg.firstCloseFailed()).toBeUndefined();
    expect(reg.get(A)).toBeUndefined();
  });

  it("a close that unexpectedly REJECTS re-inserts the doc + reports failure, never orphans it (finding #5)", async () => {
    const reg = new ProjectDocumentRegistry(() => ({
      open: async () => "loaded",
      dispose: async () => {},
    }));
    const A = asProjectId("A");
    const doc = await reg.open(A);
    // Simulate a FUTURE regression where ProjectDocument.close() rejects (it is designed not to): the
    // registry must still NOT orphan the doc (evicted + unreachable) or let a later Retry falsely
    // report success — it re-inserts + reports {ok:false}.
    doc.close = () => Promise.reject(new Error("unexpected close throw"));
    expect(await reg.close(A)).toEqual({ ok: false });
    expect(reg.get(A)).toBe(doc); // reachable for Retry, not orphaned
  });
});
