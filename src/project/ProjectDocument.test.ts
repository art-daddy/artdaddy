import { describe, expect, it } from "vitest";

import { ProjectClosingError } from "./MutationGate";
import { ProjectDocument, type ProjectChildren } from "./ProjectDocument";
import { asProjectId } from "./types";
import { emptyTimeline } from "../timeline/model";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drain a bounded number of microtasks (close now defers children.close behind the empty
 *  gate/jobs drain, so children teardown lands a few microtasks after close() is called). */
async function flush(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe("ProjectDocument", () => {
  it("transitions opening -> open on a loaded open", async () => {
    const doc = new ProjectDocument(asProjectId("A"), {
      open: async () => "loaded",
      dispose: async () => {},
    });
    expect(doc.phase()).toBe("opening");
    expect(await doc.open()).toBe("loaded");
    expect(doc.phase()).toBe("open");
  });

  it("maps a children open error to 'failed' and tears the partial open down", async () => {
    let closes = 0;
    const doc = new ProjectDocument(asProjectId("A"), {
      open: async () => {
        throw new Error("boom");
      },
      dispose: async () => {
        closes++;
      },
    });
    expect(await doc.open()).toBe("failed");
    expect(doc.phase()).toBe("failed");
    expect(closes).toBe(1); // a failed open leaves nothing running
  });

  it("runs a registered composite companion on its tag, and no-ops for an unknown/absent tag", async () => {
    const doc = new ProjectDocument(asProjectId("A"), {
      open: async () => "loaded",
      dispose: async () => {},
    });
    const calls: string[] = [];
    doc.registerComposite("T1", {
      onUndo: async () => void calls.push("undo"),
      onRedo: async () => void calls.push("redo"),
    });
    await doc.runCompositeUndo("T1");
    await doc.runCompositeRedo("T1");
    expect(calls).toEqual(["undo", "redo"]);
    // an unknown tag (evicted slot) or no tag (a plain edit's undo) is a no-op.
    await doc.runCompositeUndo("nope");
    await doc.runCompositeUndo(undefined);
    expect(calls).toEqual(["undo", "redo"]);
  });

  it("tears children down when open returns 'failed' (chat activated, editor didn't load)", async () => {
    let closes = 0;
    const doc = new ProjectDocument(asProjectId("A"), {
      open: async () => "failed",
      dispose: async () => {
        closes++;
      },
    });
    expect(await doc.open()).toBe("failed");
    expect(closes).toBe(1);
  });

  it("close() flips to 'closing' synchronously and 'closed' only after children teardown", async () => {
    const closeD = deferred<void>();
    let closes = 0;
    const children: ProjectChildren = {
      open: async () => "loaded",
      dispose: () => {
        closes++;
        return closeD.promise;
      },
    };
    const doc = new ProjectDocument(asProjectId("A"), children);
    await doc.open();
    const p = doc.close();
    expect(doc.phase()).toBe("closing"); // synchronous flip — new work is rejected from here
    await flush();
    expect(closes).toBe(1); // children torn down after the (empty) gate/jobs drain
    closeD.resolve();
    await p;
    expect(doc.phase()).toBe("closed");
  });

  it("close is idempotent — every caller gets the same promise, children torn down once", async () => {
    const closeD = deferred<void>();
    let closes = 0;
    const children: ProjectChildren = {
      open: async () => "loaded",
      dispose: () => {
        closes++;
        return closeD.promise;
      },
    };
    const doc = new ProjectDocument(asProjectId("A"), children);
    await doc.open();
    const c1 = doc.close();
    const c2 = doc.close();
    expect(c2).toBe(c1);
    closeD.resolve();
    await c1;
    expect(closes).toBe(1);
    expect(doc.phase()).toBe("closed");
  });

  it("close drains the mutation gate (waits a leased commit) before tearing children down", async () => {
    let closedChildren = false;
    const doc = new ProjectDocument(asProjectId("A"), {
      open: async () => "loaded",
      dispose: async () => {
        closedChildren = true;
      },
    });
    await doc.open();
    const d = deferred<void>();
    const mutP = doc.gate.run({ operation: "m", documentSessionId: doc.sessionId }, async () => {
      await d.promise;
    });
    await Promise.resolve(); // let the mutation acquire its lease
    const closeP = doc.close();
    expect(doc.phase()).toBe("closing");
    await Promise.resolve();
    expect(closedChildren).toBe(false); // close waits for the leased commit before children teardown
    d.resolve();
    await mutP;
    await closeP;
    expect(closedChildren).toBe(true);
    expect(doc.phase()).toBe("closed");
  });

  it("rejects a mutation submitted after close begins", async () => {
    const doc = new ProjectDocument(asProjectId("A"), {
      open: async () => "loaded",
      dispose: async () => {},
    });
    await doc.open();
    void doc.close();
    await expect(
      doc.gate.run({ operation: "m", documentSessionId: doc.sessionId }, async () => {}),
    ).rejects.toBeInstanceOf(ProjectClosingError);
  });

  it("close cancels a cancelOnClose job but waits for a finishBeforeClose job", async () => {
    const doc = new ProjectDocument(asProjectId("A"), {
      open: async () => "loaded",
      dispose: async () => {},
    });
    await doc.open();
    const dCancel = deferred<void>();
    const dFinish = deferred<void>();
    let cancelAborted = false;
    const jCancel = doc.jobs.run({ kind: "dl", policy: "cancelOnClose" }, async (signal) => {
      signal.addEventListener("abort", () => (cancelAborted = true));
      await dCancel.promise;
    });
    const jFinish = doc.jobs.run({ kind: "commit", policy: "finishBeforeClose" }, async () => {
      await dFinish.promise;
    });
    await Promise.resolve();
    let closed = false;
    const closeP = doc.close().then(() => (closed = true));
    expect(cancelAborted).toBe(true); // cancelOnClose aborted at close
    dCancel.resolve();
    await jCancel;
    await Promise.resolve();
    expect(closed).toBe(false); // close still waits for the finishBeforeClose job
    dFinish.resolve();
    await jFinish;
    await closeP;
    expect(closed).toBe(true);
  });

  it("keeps the document ALIVE (close-failed) when the final save fails — never disposes", async () => {
    let disposed = 0;
    const doc = new ProjectDocument(asProjectId("A"), {
      open: async () => "loaded",
      saveTranscript: async () => false, // the SAVE phase (timeline + transcript) fails
      dispose: async () => {
        disposed++;
      },
    });
    await doc.open();
    const outcome = await doc.close();
    expect(outcome).toEqual({ ok: false });
    expect(doc.phase()).toBe("close-failed");
    expect(disposed).toBe(0); // children are NOT disposed while the save is unresolved (guardrail 2)
  });

  it("retryClose re-attempts the save and disposes on success", async () => {
    let ok = false;
    let disposed = 0;
    const doc = new ProjectDocument(asProjectId("A"), {
      open: async () => "loaded",
      saveTranscript: async () => ok,
      dispose: async () => {
        disposed++;
      },
    });
    await doc.open();
    expect((await doc.close()).ok).toBe(false); // save fails
    expect(doc.phase()).toBe("close-failed");
    ok = true; // the disk recovers
    expect((await doc.retryClose()).ok).toBe(true);
    expect(doc.phase()).toBe("closed");
    expect(disposed).toBe(1);
  });

  it("discardClose tears down DESPITE a dirty state (destructive)", async () => {
    let disposed = 0;
    const doc = new ProjectDocument(asProjectId("A"), {
      open: async () => "loaded",
      saveTranscript: async () => false,
      dispose: async () => {
        disposed++;
      },
    });
    await doc.open();
    await doc.close(); // fails -> close-failed
    await doc.discardClose();
    expect(doc.phase()).toBe("closed");
    expect(disposed).toBe(1);
  });

  it("cancelClose returns to editing with a FRESH gate + job scope", async () => {
    const doc = new ProjectDocument(asProjectId("A"), {
      open: async () => "loaded",
      saveTranscript: async () => false,
      dispose: async () => {},
    });
    await doc.open();
    const oldGate = doc.gate;
    const oldJobs = doc.jobs;
    await doc.close(); // fails -> close-failed
    expect(doc.phase()).toBe("close-failed");
    // the OLD gate is one-way closed — a mutation on it is rejected.
    await expect(
      oldGate.run({ operation: "m", documentSessionId: doc.sessionId }, async () => {}),
    ).rejects.toBeInstanceOf(ProjectClosingError);
    doc.cancelClose();
    expect(doc.phase()).toBe("open");
    expect(doc.gate).not.toBe(oldGate); // replaced with a fresh drained scope (guardrail 3)
    expect(doc.jobs).not.toBe(oldJobs);
    // the FRESH gate admits new work again — editing resumes.
    await expect(
      doc.gate.run({ operation: "m", documentSessionId: doc.sessionId }, async () => "ok"),
    ).resolves.toBe("ok");
  });

  it("a dispose THROW after a GOOD save COMPLETES the close — never retains a half-disposed doc as editable (finding #4)", async () => {
    let saveFailed = 0;
    const disposeFailed: unknown[] = [];
    const doc = new ProjectDocument(
      asProjectId("A"),
      {
        open: async () => "loaded",
        saveTranscript: async () => true, // the save SUCCEEDS (data is durable)...
        dispose: async () => {
          throw new Error("teardown boom"); // ...but child teardown throws AFTER the durable save
        },
      },
      { onCloseSaveFailed: () => saveFailed++, onDisposeFailed: (_id, e) => disposeFailed.push(e) },
    );
    await doc.open();
    // Data is safe, so the close COMPLETES; a half-disposed document must NOT be offered as editable via
    // close-failed (Keep-editing can't restore already-disposed child stores). The leak is reported.
    expect(await doc.close()).toEqual({ ok: true });
    expect(doc.phase()).toBe("closed"); // NOT close-failed
    expect(saveFailed).toBe(0); // the save did not fail
    expect(disposeFailed).toHaveLength(1); // the teardown leak is reported instead
  });

  it("a saveTranscript that THROWS is a failed save (close-failed) — children untouched, safe to Keep editing (finding #5)", async () => {
    let disposed = 0;
    const doc = new ProjectDocument(asProjectId("A"), {
      open: async () => "loaded",
      saveTranscript: async () => {
        throw new Error("save boom");
      },
      dispose: async () => {
        disposed++;
      },
    });
    await doc.open();
    await expect(doc.close()).resolves.toEqual({ ok: false });
    expect(doc.phase()).toBe("close-failed");
    expect(disposed).toBe(0); // dispose never ran on a failed save -> children fully intact for Keep-editing
  });

  it("cancelClose re-admits producers via onReopen (finding #2)", async () => {
    const reopened: string[] = [];
    const doc = new ProjectDocument(
      asProjectId("A"),
      { open: async () => "loaded", saveTranscript: async () => false, dispose: async () => {} },
      { onReopen: (id) => reopened.push(String(id)) },
    );
    await doc.open();
    await doc.close(); // save fails -> close-failed
    doc.cancelClose();
    expect(doc.phase()).toBe("open");
    expect(reopened).toEqual(["A"]); // the chat admission fence raised on save is lowered on Keep-editing
  });

  it("a throwing onBeginClose lands in close-failed (discoverable), never escapes leaving phase open (finding #3)", async () => {
    const doc = new ProjectDocument(
      asProjectId("A"),
      { open: async () => "loaded", saveTranscript: async () => true, dispose: async () => {} },
      {
        onBeginClose: () => {
          throw new Error("quiesce boom");
        },
      },
    );
    await doc.open();
    // An invariant-bearing hook that throws must be CONTAINED by the close error boundary: the close
    // resolves {ok:false} in close-failed (firstCloseFailed finds it), never escapes with phase `open`.
    expect(await doc.close()).toEqual({ ok: false });
    expect(doc.phase()).toBe("close-failed");
  });

  it("a throwing onDisposeFailed reporter does NOT derail a durable close (finding #3)", async () => {
    const doc = new ProjectDocument(
      asProjectId("A"),
      {
        open: async () => "loaded",
        saveTranscript: async () => true, // the save SUCCEEDS (data durable)
        dispose: async () => {
          throw new Error("teardown boom"); // teardown throws...
        },
      },
      {
        onDisposeFailed: () => {
          throw new Error("reporter boom"); // ...and the best-effort reporter ALSO throws
        },
      },
    );
    await doc.open();
    // A reporting callback must be non-throwing: a durable close still COMPLETES rather than becoming a
    // phantom {ok:false} stuck in `saving` with no recovery state.
    expect(await doc.close()).toEqual({ ok: true });
    expect(doc.phase()).toBe("closed");
  });

  it("a throwing onReopen does not undo cancelClose's return-to-editing (finding #3)", async () => {
    const doc = new ProjectDocument(
      asProjectId("A"),
      { open: async () => "loaded", saveTranscript: async () => false, dispose: async () => {} },
      {
        onReopen: () => {
          throw new Error("resume boom");
        },
      },
    );
    await doc.open();
    await doc.close(); // fails -> close-failed
    expect(() => doc.cancelClose()).not.toThrow(); // the throwing re-admit hook is contained
    expect(doc.phase()).toBe("open"); // returned to editing despite the hook throwing
  });

  it("onBeginClose fires SYNCHRONOUSLY the instant close begins, before the drain/save (finding #2)", async () => {
    const events: string[] = [];
    const doc = new ProjectDocument(
      asProjectId("A"),
      {
        open: async () => "loaded",
        saveTranscript: async () => {
          events.push("save");
          return true;
        },
        dispose: async () => {
          events.push("dispose");
        },
      },
      { onBeginClose: () => events.push("begin") },
    );
    await doc.open();
    const p = doc.close();
    expect(events[0]).toBe("begin"); // ran synchronously within close() — producers fenced before any await
    await p;
    expect(events).toEqual(["begin", "save", "dispose"]);
  });

  it("discardClose finalizes as CLOSED even when teardown THROWS — never editable again (finding #3)", async () => {
    const disposeFailed: unknown[] = [];
    const doc = new ProjectDocument(
      asProjectId("A"),
      {
        open: async () => "loaded",
        saveTranscript: async () => false,
        dispose: async () => {
          throw new Error("teardown boom");
        },
      },
      { onDisposeFailed: (_id, e) => disposeFailed.push(e) },
    );
    await doc.open();
    await doc.close(); // save fails -> close-failed
    expect(doc.phase()).toBe("close-failed");
    await doc.discardClose(); // destructive: a partial-teardown throw must still finalize as closed
    expect(doc.phase()).toBe("closed"); // NOT left close-failed (which would offer Keep-editing)
    expect(disposeFailed).toHaveLength(1);
  });

  it("re-arms a FRESH timeline persist when the close SAVE finds the timeline dirty (finding #3)", async () => {
    let rearms = 0;
    const doc = new ProjectDocument(
      asProjectId("A"),
      { open: async () => "loaded", dispose: async () => {} },
      {
        rearmTimelineSave: (d) => {
          rearms++;
          d.timeline!.markSaved(d.timeline!.revision()); // the re-attempt lands -> clears dirty
        },
      },
    );
    await doc.open();
    const session = await doc.timelineSession(async () => emptyTimeline());
    session.apply("edit", (t) => void t.tracks.push({ id: "v", kind: "video", z: 0, clips: [] }));
    expect(session.isDirty()).toBe(true);
    const outcome = await doc.close();
    expect(rearms).toBe(1); // the close SAVE re-attempted the ACTUAL write (not a drained-autosave no-op)
    expect(outcome).toEqual({ ok: true });
    expect(doc.phase()).toBe("closed");
  });

  it("a re-arm that still can't clear the dirty timeline fails the close (finding #3)", async () => {
    const doc = new ProjectDocument(
      asProjectId("A"),
      { open: async () => "loaded", dispose: async () => {} },
      { rearmTimelineSave: () => {} }, // the re-attempt does NOT clear dirty (disk still broken)
    );
    await doc.open();
    const session = await doc.timelineSession(async () => emptyTimeline());
    session.apply("edit", (t) => void t.tracks.push({ id: "v", kind: "video", z: 0, clips: [] }));
    await expect(doc.close()).resolves.toEqual({ ok: false });
    expect(doc.phase()).toBe("close-failed");
  });
});
