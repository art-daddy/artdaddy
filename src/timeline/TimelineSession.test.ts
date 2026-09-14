import { describe, expect, it } from "vitest";

import { TimelineSession } from "./TimelineSession";
import { emptyTimeline, type Timeline, type Track } from "./model";

const track = (id: string): Track => ({ id, kind: "video", z: 0, clips: [] });
const addTrack = (id: string) => (t: Timeline) => {
  t.tracks.push(track(id));
};

describe("TimelineSession", () => {
  it("starts clean at revision 0 with empty history", () => {
    const s = new TimelineSession(emptyTimeline());
    expect(s.isDirty()).toBe(false);
    expect(s.revision()).toBe(0);
    expect(s.canUndo()).toBe(false);
    expect(s.canRedo()).toBe(false);
  });

  it("apply updates the timeline, records undo, clears redo, marks dirty, and bumps revision", () => {
    const s = new TimelineSession(emptyTimeline());
    const r = s.apply("add_track", addTrack("v1"));
    expect(r.ok).toBe(true);
    expect(s.current().tracks).toHaveLength(1);
    expect(s.canUndo()).toBe(true);
    expect(s.canRedo()).toBe(false);
    expect(s.isDirty()).toBe(true);
    expect(s.revision()).toBe(1);
  });

  it("carries a composite `tag` through undo→redo and leaves a plain edit untagged", () => {
    const s = new TimelineSession(emptyTimeline());
    s.apply("plain", addTrack("v1")); // no tag
    s.apply("cascade", addTrack("v2"), "T1"); // a tagged composite slot
    expect(s.undo().tag).toBe("T1"); // undoing the composite reports its tag (doc runs the library restore)
    expect(s.undo().tag).toBeUndefined(); // the plain slot carries no tag
    expect(s.redo().tag).toBeUndefined(); // redo mirrors: plain first
    expect(s.redo().tag).toBe("T1"); // then the composite — so redo re-runs the companion
  });

  it("revertLastApply erases the just-applied tagged slot CLEANLY — restores the timeline, leaves NO redo entry (blocker 3)", () => {
    const s = new TimelineSession(emptyTimeline());
    s.apply("plain", addTrack("v1"));
    s.apply("cascade", addTrack("v2"), "T1"); // the composite's timeline half
    expect(s.current().tracks).toHaveLength(2);

    const reverted = s.revertLastApply("T1"); // its coupled catalog write failed -> roll the timeline back
    expect(reverted).toBe(true);
    expect(s.current().tracks).toHaveLength(1); // restored to pre-cascade
    expect(s.current().tracks[0].id).toBe("v1");
    expect(s.canRedo()).toBe(false); // NOT a normal undo — the failed command is NOT left redoable (no phantom history)
    expect(s.undo().tag).toBeUndefined(); // the ONLY remaining slot is the earlier plain edit — the tagged slot is gone
    expect(s.canUndo()).toBe(false);
  });

  it("revertLastApply REFUSES when the top slot's tag doesn't match — never corrupts an unrelated edit", () => {
    const s = new TimelineSession(emptyTimeline());
    s.apply("cascade", addTrack("v1"), "T1");
    s.apply("later", addTrack("v2")); // a different edit is now on top of the stack
    const reverted = s.revertLastApply("T1"); // T1 is no longer the most-recent apply
    expect(reverted).toBe(false);
    expect(s.current().tracks).toHaveLength(2); // state untouched
    expect(s.canUndo()).toBe(true);
  });

  it("historySnapshots unions the undo + redo stacks (what a restore could bring back)", () => {
    const s = new TimelineSession(emptyTimeline());
    s.apply("a", addTrack("v1"));
    s.apply("b", addTrack("v2"));
    s.undo(); // moves one snapshot onto the redo stack
    expect(s.historySnapshots()).toHaveLength(2); // 1 undo + 1 redo
  });

  it("undo restores the previous snapshot and redo re-applies it (round-trip)", () => {
    const s = new TimelineSession(emptyTimeline());
    s.apply("add_track", addTrack("v1"));
    expect(s.current().tracks).toHaveLength(1);

    const u = s.undo();
    expect(u.ok).toBe(true);
    expect(s.current().tracks).toHaveLength(0); // back to the empty base
    expect(s.canRedo()).toBe(true);
    expect(s.revision()).toBe(2);

    const rd = s.redo();
    expect(rd.ok).toBe(true);
    expect(s.current().tracks).toHaveLength(1);
    expect(s.revision()).toBe(3);
  });

  it("a fresh edit after an undo clears the redo branch", () => {
    const s = new TimelineSession(emptyTimeline());
    s.apply("a", addTrack("v1"));
    s.undo();
    expect(s.canRedo()).toBe(true);
    s.apply("b", addTrack("v2")); // diverge — the redo branch is abandoned
    expect(s.canRedo()).toBe(false);
    expect(s.current().tracks.map((t) => t.id)).toEqual(["v2"]);
  });

  it("a rejected mutation leaves the timeline, dirty flag, revision, and history untouched", () => {
    const s = new TimelineSession(emptyTimeline());
    const r = s.apply("dup", (t) => {
      t.tracks.push(track("v"), track("v")); // duplicate id -> invalid
    });
    expect(r.ok).toBe(false);
    expect(s.current().tracks).toHaveLength(0);
    expect(s.isDirty()).toBe(false);
    expect(s.revision()).toBe(0);
    expect(s.canUndo()).toBe(false);
  });

  it("replace swaps the whole timeline and resets both history stacks", () => {
    const s = new TimelineSession(emptyTimeline());
    s.apply("a", addTrack("v1"));
    s.undo(); // populate the redo stack too
    expect(s.canRedo()).toBe(true);

    const restored = emptyTimeline();
    restored.tracks = [track("restored")];
    const rr = s.replace(restored);
    expect(rr.ok).toBe(true);
    expect(s.current().tracks.map((t) => t.id)).toEqual(["restored"]);
    expect(s.canUndo()).toBe(false);
    expect(s.canRedo()).toBe(false);
  });

  it("replace refuses an invalid snapshot and leaves state intact", () => {
    const s = new TimelineSession(emptyTimeline());
    s.apply("a", addTrack("v1"));
    const rev = s.revision();
    const rr = s.replace(42 as unknown as Timeline);
    expect(rr.ok).toBe(false);
    expect(s.current().tracks).toHaveLength(1); // unchanged
    expect(s.revision()).toBe(rev);
  });

  it("undo marks dirty again after a save cleared it", () => {
    const s = new TimelineSession(emptyTimeline());
    s.apply("a", addTrack("v1"));
    s.markSaved(s.revision());
    expect(s.isDirty()).toBe(false);
    s.undo();
    expect(s.isDirty()).toBe(true); // undo is an un-persisted change
  });

  it("markSaved only clears dirty when the saved revision is still current (edit-during-save)", () => {
    const s = new TimelineSession(emptyTimeline());
    s.apply("a", addTrack("v1")); // revision 1
    const saving = s.revision();
    s.apply("b", addTrack("v2")); // revision 2 landed DURING the async write of revision 1
    s.markSaved(saving); // stale save completes
    expect(s.isDirty()).toBe(true); // the newer revision 2 is still unsaved
    s.markSaved(s.revision()); // the revision-2 save completes
    expect(s.isDirty()).toBe(false);
  });

  it("undo on an empty stack is a structured no-op", () => {
    const s = new TimelineSession(emptyTimeline());
    expect(s.undo()).toEqual({ ok: false, error: "nothing to undo" });
    expect(s.redo()).toEqual({ ok: false, error: "nothing to redo" });
  });

  it("caps the undo stack at 50 entries", () => {
    const s = new TimelineSession(emptyTimeline());
    for (let i = 0; i < 60; i++) s.apply(`op${i}`, addTrack(`v${i}`));
    // Only the last 50 before-snapshots are retained; undo can be invoked at most 50 times.
    let undos = 0;
    while (s.canUndo()) {
      s.undo();
      undos++;
      if (undos > 100) break; // safety
    }
    expect(undos).toBe(50);
  });
});

// One coherent intent = ONE Ctrl+Z. These challenge the FAILURE direction: a throw partway, a
// refused intent, a no-op, nesting, and the composite whose coupled side effect fails.
describe("TimelineSession.transaction", () => {
  it("collapses many applies into ONE undo entry that restores the pre-transaction state", async () => {
    const s = new TimelineSession(emptyTimeline());
    s.apply("earlier", addTrack("v0"));
    await s.transaction("import 3 files", async () => {
      s.apply("a", addTrack("v1"));
      s.apply("b", addTrack("v2"));
      s.apply("c", addTrack("v3"));
    });
    expect(s.current().tracks.map((t) => t.id)).toEqual(["v0", "v1", "v2", "v3"]);
    s.undo();
    // ONE undo removes all three — and stops at the earlier edit rather than eating it.
    expect(s.current().tracks.map((t) => t.id)).toEqual(["v0"]);
    expect(s.canUndo()).toBe(true);
  });

  it("a transaction that changes NOTHING pushes no entry", async () => {
    const s = new TimelineSession(emptyTimeline());
    s.apply("earlier", addTrack("v0"));
    const depth = s.historySnapshots().length;
    await s.transaction("refused", async () => {
      /* the intent was refused before it touched anything */
    });
    expect(s.historySnapshots().length).toBe(depth);
    expect(s.current().tracks.map((t) => t.id)).toEqual(["v0"]);
  });

  it("a throw restores the pre-transaction timeline and pushes NOTHING", async () => {
    const s = new TimelineSession(emptyTimeline());
    s.apply("earlier", addTrack("v0"));
    const depth = s.historySnapshots().length;
    await expect(
      s.transaction("half an import", async () => {
        s.apply("a", addTrack("v1"));
        throw new Error("disk died");
      }),
    ).rejects.toThrow("disk died");
    // The half-applied step is gone, and it left no undo entry to trip over later.
    expect(s.current().tracks.map((t) => t.id)).toEqual(["v0"]);
    expect(s.historySnapshots().length).toBe(depth);
  });

  it("a nested transaction JOINS the outer one — still one entry", async () => {
    const s = new TimelineSession(emptyTimeline());
    await s.transaction("outer", async () => {
      s.apply("a", addTrack("v1"));
      await s.transaction("inner", async () => {
        s.apply("b", addTrack("v2"));
      });
    });
    s.undo();
    expect(s.current().tracks).toHaveLength(0);
    expect(s.canUndo()).toBe(false);
  });

  it("undo, redo and replace refuse while a transaction is open", async () => {
    const s = new TimelineSession(emptyTimeline());
    s.apply("earlier", addTrack("v0"));
    await s.transaction("intent", async () => {
      s.apply("a", addTrack("v1"));
      expect(s.undo().ok).toBe(false);
      expect(s.redo().ok).toBe(false);
      expect(s.replace(emptyTimeline()).ok).toBe(false);
      // ...and none of them mangled the work in progress.
      expect(s.current().tracks.map((t) => t.id)).toEqual(["v0", "v1"]);
    });
  });

  it("carries ONE composite tag out to the single entry, so undo still runs its library companion", async () => {
    const s = new TimelineSession(emptyTimeline());
    await s.transaction("cascade delete", async () => {
      s.apply("remove clips", addTrack("v1"), "T1");
      s.apply("tidy", addTrack("v2"));
    });
    expect(s.undo().tag).toBe("T1");
  });

  it("REFUSES two composites in one intent rather than silently stranding one companion", async () => {
    const s = new TimelineSession(emptyTimeline());
    await expect(
      s.transaction("two cascades", async () => {
        s.apply("first", addTrack("v1"), "T1");
        s.apply("second", addTrack("v2"), "T2");
      }),
    ).rejects.toThrow(/at most one composite/);
    expect(s.current().tracks).toHaveLength(0);
    expect(s.canUndo()).toBe(false);
  });

  it("revertLastApply inside a transaction voids the WHOLE intent, leaving no entry", async () => {
    const s = new TimelineSession(emptyTimeline());
    s.apply("earlier", addTrack("v0"));
    const depth = s.historySnapshots().length;
    await s.transaction("cascade whose catalog write fails", async () => {
      s.apply("tidy", addTrack("v1"));
      s.apply("remove clips", addTrack("v2"), "T1");
      expect(s.revertLastApply("T1")).toBe(true);
    });
    // Both steps are gone — a composite's failure voids the intent, not just its own half.
    expect(s.current().tracks.map((t) => t.id)).toEqual(["v0"]);
    expect(s.historySnapshots().length).toBe(depth);
  });
});
