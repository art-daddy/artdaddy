// The one-intent-one-undo guarantee, through the REAL stack: gate, session, persisted timeline.
//
// These assert the OUTCOME a user feels (how many times must I press Ctrl+Z?), not that some
// function was called. The old shape — one applyOp per step — passes every unit test while costing
// the user N presses, which is exactly how the N-entry import survived 2600 green tests.
import { describe, expect, it } from "vitest";

import { seededCtx } from "../test/timelineKit";
import { doUndo, loadTimeline, runGesture } from "./engine";
import { OpError } from "./errors";
import type { Timeline } from "./model";

const addTrack = (id: string) => (t: Timeline) => {
  t.tracks.push({ id, kind: "video", z: t.tracks.length + 10, clips: [] });
};

const trackIds = async (store: Parameters<typeof loadTimeline>[0]): Promise<string[]> =>
  (await loadTimeline(store)).tracks.map((t) => String(t.id));

describe("runGesture — one intent, one undo entry", () => {
  it("three steps in one gesture cost ONE Ctrl+Z", async () => {
    const { ctx, store } = await seededCtx();
    const before = await trackIds(store);

    await runGesture(store, "gesture", (apply) => {
      apply("a", addTrack("g1"));
      apply("b", addTrack("g2"));
      apply("c", addTrack("g3"));
    });
    expect(await trackIds(store)).toEqual([...before, "g1", "g2", "g3"]);

    await doUndo(store);
    expect(await trackIds(store)).toEqual(before);
    void ctx;
  });

  it("the same three steps as separate edits cost THREE — the behaviour this replaces", async () => {
    const { store } = await seededCtx();
    const before = await trackIds(store);
    for (const id of ["g1", "g2", "g3"]) {
      await runGesture(store, "separate", (apply) => {
        apply("one", addTrack(id));
      });
    }
    await doUndo(store);
    // Only the last one came back — proof the grouped case above is doing real work.
    expect(await trackIds(store)).toEqual([...before, "g1", "g2"]);
  });

  it("a step that refuses rolls the WHOLE intent back and leaves no entry", async () => {
    const { store } = await seededCtx();
    const before = await trackIds(store);

    const r = (await runGesture(store, "half a gesture", (apply) => {
      apply("a", addTrack("g1"));
      apply("boom", () => {
        throw new OpError("nope");
      });
    })) as { ok: boolean; error?: string };

    // The caller is told, rather than being handed a silent partial success.
    expect(r.ok).toBe(false);
    expect(r.error).toContain("nope");
    // The first step is gone: a partial intent must not survive its own failure.
    expect(await trackIds(store)).toEqual(before);
    // ...and undo must not now eat an UNRELATED earlier edit, which is what a stray entry would do.
    await doUndo(store);
    expect(await trackIds(store)).toEqual(before);
  });

  it("a gesture that changes nothing writes no history", async () => {
    const { store } = await seededCtx();
    await runGesture(store, "seed", (apply) => {
      apply("a", addTrack("g1"));
    });
    const after = await trackIds(store);

    await runGesture(store, "no-op", () => {
      /* the intent was refused before touching anything */
    });

    // One undo still lands on the seed, not on a phantom empty entry.
    await doUndo(store);
    expect(await trackIds(store)).toEqual(after.filter((t) => t !== "g1"));
  });

  it("holds the lease for the whole intent, so a concurrent edit cannot interleave", async () => {
    const { store } = await seededCtx();
    const before = await trackIds(store);
    let interleaved = false;

    const gesture = runGesture(store, "slow gesture", async (apply) => {
      apply("a", addTrack("g1"));
      await Promise.resolve(); // yields — the gate must still be held across this
      interleaved = (await trackIds(store)).includes("other");
      apply("b", addTrack("g2"));
    });
    const other = runGesture(store, "other edit", (apply) => {
      apply("x", addTrack("other"));
    });
    await Promise.all([gesture, other]);

    expect(interleaved).toBe(false);
    // The gesture's undo removes ITS two tracks and leaves the concurrent edit alone.
    expect(await trackIds(store)).toEqual([...before, "g1", "g2", "other"]);
  });
});
