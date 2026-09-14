import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectStoreAccess, joinPath, type FsLike } from "../tools/store";
import {
  applyOp,
  applyTimelineTransition,
  ctxApplyOp,
  doRedo,
  doUndo,
  ensureStarterTimeline,
  ensureTimeline,
  loadTimeline,
  rearmTimelinePersist,
  replaceTimeline,
} from "./engine";
import { endProjectSession } from "../tools/coordinator";
import { setOpenDocumentResolver } from "../project/openDocuments";
import { ProjectDocument } from "../project/ProjectDocument";
import { asProjectId } from "../project/types";
import type { ClientToolContext } from "../tools/context";
import { onTimelineChange } from "./bus";
import { OpError } from "./errors";
import { DEFAULT_VISUAL_TRACK } from "./helpers";
import { emptyTimeline, type Timeline, type Track } from "./model";

class MemFs implements FsLike {
  files = new Map<string, string>();
  async exists(p: string): Promise<boolean> {
    return this.files.has(joinPath(p));
  }
  async readTextFile(p: string): Promise<string> {
    const v = this.files.get(joinPath(p));
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  }
  async writeTextFile(p: string, c: string): Promise<void> {
    this.files.set(joinPath(p), c);
  }
  async mkdir(): Promise<void> {}
}

const DIR = "C:/proj";
function store(fs: MemFs = new MemFs()): ProjectStoreAccess {
  return new ProjectStoreAccess(DIR, fs);
}
const videoTrack = (): Track => ({ id: "v", kind: "video", z: 0, clips: [] });

// Every engine test runs against an OPEN document for DIR (segment "proj"): timeline commits
// route through its in-memory TimelineSession + gate, exactly like production. A fresh doc per
// test isolates state; afterEach flushes the async autosave then clears the injected resolver.
// (Tests needing a specially-configured document — origin fence, close drain — build their own
// and re-point the resolver, overriding this default.)
let doc: ProjectDocument;
beforeEach(() => {
  doc = new ProjectDocument(asProjectId("proj"), {
    open: async () => "loaded",
    dispose: async () => {},
  });
  setOpenDocumentResolver((id) => (id === asProjectId("proj") ? doc : undefined));
});
afterEach(async () => {
  await doc.autosave.flush();
  setOpenDocumentResolver(() => undefined);
});

describe("ensureTimeline / loadTimeline", () => {
  it("seeds an empty timeline once and is idempotent", async () => {
    const s = store();
    await ensureTimeline(s);
    const tl = await loadTimeline(s);
    expect(tl.tracks).toEqual([]);
    expect(tl.canvas.fps).toBe(30);
    await applyOp(s, "add_track", (t) => {
      t.tracks.push(videoTrack());
    });
    await ensureTimeline(s);
    expect((await loadTimeline(s)).tracks.length).toBe(1);
  });
});

describe("applyTimelineTransition (pure)", () => {
  it("returns before + next + receipt and NEVER mutates the input timeline", () => {
    const current = emptyTimeline();
    const r = applyTimelineTransition(current, "add_track", (t) => {
      t.tracks.push(videoTrack());
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next.tracks).toHaveLength(1);
    expect(r.before.tracks).toHaveLength(0);
    expect(r.receipt).toMatchObject({ ok: true, op: "add_track" });
    // Purity: the caller's live timeline is untouched — the caller owns the commit.
    expect(current.tracks).toHaveLength(0);
  });

  it("maps an OpError to a structured failure with no validation_errors", () => {
    const r = applyTimelineTransition(emptyTimeline(), "x", () => {
      throw new OpError("boom");
    });
    expect(r).toEqual({ ok: false, error: "boom" });
  });

  it("rejects a mutation that produces an invalid timeline, leaving nothing to commit", () => {
    const r = applyTimelineTransition(emptyTimeline(), "dup", (t) => {
      t.tracks.push(videoTrack(), videoTrack()); // two tracks share id "v" -> invalid
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("dup: rejected by validation");
    expect(r.validation_errors?.length).toBeGreaterThan(0);
  });

  it("rejects a non-object timeline", () => {
    const r = applyTimelineTransition(42 as unknown as Timeline, "x", () => {});
    expect(r).toEqual({
      ok: false,
      error: "timeline.json is not a timeline object; bootstrap the timeline first.",
    });
  });
});

describe("timeline commits routed through an open document's in-memory session", () => {
  // Uses the file-level open document + resolver (see the top-level beforeEach/afterEach).

  it("commits an edit through the gate and mirrors it to disk", async () => {
    const s = store();
    await ensureTimeline(s);
    const r = await applyOp(s, "add_track", (t) => {
      t.tracks.push(videoTrack());
    });
    expect(r.ok).toBe(true);
    expect((await loadTimeline(s)).tracks).toHaveLength(1);
    expect(doc.timeline?.current().tracks).toHaveLength(1); // in-memory truth
  });

  it("advances the gate revision once per committed edit (proves each leased the gate)", async () => {
    const s = store();
    await ensureTimeline(s);
    const base = doc.gate.currentRevision();
    await applyOp(s, "a", (t) => void t.tracks.push(videoTrack()));
    await applyOp(s, "b", (t) => void t.tracks.push({ id: "v2", kind: "video", z: 1, clips: [] }));
    expect(doc.gate.currentRevision()).toBe(base + 2);
    expect((await loadTimeline(s)).tracks).toHaveLength(2);
  });

  it("a {ok:false} validation reject and a no-op do NOT advance the gate revision (finding #8)", async () => {
    const s = store();
    await ensureTimeline(s);
    await applyOp(s, "seed", (t) => void t.tracks.push(videoTrack())); // one track, id "v"
    const base = doc.gate.currentRevision();
    // A validation-rejected edit (duplicate track id) returns {ok:false} and must NOT bump the revision.
    const bad = await applyOp(
      s,
      "dup",
      (t) => void t.tracks.push({ id: "v", kind: "video", z: 1, clips: [] }),
    );
    expect(bad.ok).toBe(false);
    expect(doc.gate.currentRevision()).toBe(base); // no state change -> no bump
    // A no-op ensureTimeline (the file already exists) also does not bump.
    await ensureTimeline(s);
    expect(doc.gate.currentRevision()).toBe(base);
    // A nothing-to-redo is a no-op too (nothing was undone).
    expect((await doRedo(s)).ok).toBe(false);
    expect(doc.gate.currentRevision()).toBe(base);
    // A real edit resumes advancing it.
    await applyOp(s, "ok", (t) => void t.tracks.push({ id: "v2", kind: "video", z: 2, clips: [] }));
    expect(doc.gate.currentRevision()).toBe(base + 1);
  });

  it("does NOT reload timeline.json per edit — only the first edit reads disk", async () => {
    const fs = new MemFs();
    const readSpy = vi.spyOn(fs, "readTextFile");
    const s = new ProjectStoreAccess(DIR, fs);
    await ensureTimeline(s);
    await applyOp(s, "a", (t) => void t.tracks.push({ id: "a", kind: "video", z: 0, clips: [] }));
    await applyOp(s, "b", (t) => void t.tracks.push({ id: "b", kind: "video", z: 1, clips: [] }));
    expect(readSpy).toHaveBeenCalledTimes(1); // one lazy-create read; the 2nd edit built on memory
    expect(doc.timeline?.current().tracks.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("readers observe the in-memory timeline without touching disk once the session exists", async () => {
    const fs = new MemFs();
    const s = new ProjectStoreAccess(DIR, fs);
    await ensureTimeline(s);
    await applyOp(
      s,
      "seed",
      (t) => void t.tracks.push({ id: "a", kind: "video", z: 0, clips: [] }),
    );
    const readSpy = vi.spyOn(fs, "readTextFile");
    const tl = await loadTimeline(s); // a reader call (get_timeline/inspect/preview/export all funnel here)
    expect(readSpy).not.toHaveBeenCalled(); // served from doc.timeline, NOT a disk read
    expect(tl.tracks.map((t) => t.id)).toEqual(["a"]);
  });

  it("editor + agent edits share ONE undo history (undo reverts the last, whoever made it)", async () => {
    const s = store();
    await ensureTimeline(s);
    await applyOp(s, "a", (t) => void t.tracks.push({ id: "a", kind: "video", z: 0, clips: [] }));
    await applyOp(s, "b", (t) => void t.tracks.push({ id: "b", kind: "video", z: 1, clips: [] }));
    expect((await doUndo(s)).ok).toBe(true);
    expect((await loadTimeline(s)).tracks.map((t) => t.id)).toEqual(["a"]); // b undone
    expect((await doUndo(s)).ok).toBe(true);
    expect((await loadTimeline(s)).tracks).toHaveLength(0); // a undone
    expect((await doRedo(s)).ok).toBe(true);
    expect((await loadTimeline(s)).tracks.map((t) => t.id)).toEqual(["a"]); // a redone
  });

  it("undo returns the change delta describing what it restored (not just 'undone')", async () => {
    // undo can restore arbitrarily much; a bare {undone:true} leaves the model holding
    // a stale picture, so it must report the revert in the same vocabulary as an edit.
    const s = store();
    await ensureTimeline(s);
    await applyOp(
      s,
      "seed",
      (t) =>
        void t.tracks.push({
          id: "v1",
          kind: "video",
          z: 0,
          clips: [{ id: "c1", media_ref: "m.mp4", timeline_in: 0, timeline_out: 60 }],
        }),
    );
    await applyOp(s, "remove_clips", (t) => void (t.tracks[0].clips = []));

    const u = (await doUndo(s)) as Record<string, unknown>;
    expect(u.ok).toBe(true);
    // The removed clip came BACK: it must appear as a changed clip, with its span.
    const clips = u.clips as { id: string; timeline_in: number; timeline_out: number }[];
    expect(clips.map((c) => c.id)).toContain("c1");
    expect(clips.find((c) => c.id === "c1")).toMatchObject({ timeline_in: 0, timeline_out: 60 });

    // ...and redoing the removal reports it as a removal, not as a changed clip.
    const r = (await doRedo(s)) as Record<string, unknown>;
    expect(r.ok).toBe(true);
    expect(r.removed_ids).toEqual(["c1"]);
  });

  it("a no-op undo reports no delta (nothing to undo must not look like a change)", async () => {
    const s = store();
    await ensureTimeline(s);
    const u = (await doUndo(s)) as Record<string, unknown>;
    expect(u.ok).toBe(false);
    expect(u.clips).toBeUndefined();
    expect(u.removed_ids).toBeUndefined();
  });

  it("a restore swaps the in-memory timeline and resets its history", async () => {
    const s = store();
    await ensureTimeline(s);
    await applyOp(s, "a", (t) => void t.tracks.push({ id: "a", kind: "video", z: 0, clips: [] }));
    const restored = emptyTimeline();
    restored.tracks = [{ id: "restored", kind: "video", z: 0, clips: [] }];
    expect(await replaceTimeline(s, restored)).toBe(true);
    expect((await loadTimeline(s)).tracks.map((t) => t.id)).toEqual(["restored"]);
    expect(doc.timeline?.canUndo()).toBe(false); // the old branch's history is gone
    expect((await doUndo(s)).ok).toBe(false);
  });

  it("clears dirty once the async autosave flushes", async () => {
    const s = store();
    await ensureTimeline(s);
    await applyOp(s, "a", (t) => void t.tracks.push({ id: "a", kind: "video", z: 0, clips: [] }));
    await doc.autosave.flush();
    expect(doc.timeline?.isDirty()).toBe(false); // persisted -> not dirty
    expect(doc.timeline?.current().tracks.map((t) => t.id)).toEqual(["a"]);
  });

  it("emits dirty=true on an edit and dirty=false when the autosave completes (Unsaved signal)", async () => {
    const s = store();
    await ensureTimeline(s);
    const events: Array<{ source: string; dirty?: boolean }> = [];
    const off = onTimelineChange((_tl, c) => events.push({ source: c.source, dirty: c.dirty }));
    await applyOp(s, "a", (t) => void t.tracks.push({ id: "a", kind: "video", z: 0, clips: [] }));
    expect(events.some((e) => e.source === "engine" && e.dirty === true)).toBe(true); // edit -> Unsaved
    await doc.autosave.flush();
    expect(events.some((e) => e.source === "saved" && e.dirty === false)).toBe(true); // saved -> clears
    off();
  });

  it("close flushes the last edit to disk BEFORE teardown (no data loss on close/switch)", async () => {
    const closingDoc = new ProjectDocument(asProjectId("proj"), {
      open: async () => "loaded",
      dispose: async () => {
        endProjectSession(DIR); // mimic editor dispose bumping the coordinator session generation
      },
    });
    setOpenDocumentResolver((id) => (id === asProjectId("proj") ? closingDoc : undefined));
    const s = store();
    await ensureTimeline(s);
    await applyOp(s, "a", (t) => void t.tracks.push({ id: "a", kind: "video", z: 0, clips: [] }));
    // The edit is in memory; its disk write is async and may not have landed yet.
    await closingDoc.close(); // gate drain -> autosave.flush (sessionLive still true) -> children.close (bump)
    setOpenDocumentResolver(() => undefined); // reads now go to disk
    expect((await loadTimeline(s)).tracks.map((t) => t.id)).toEqual(["a"]); // flushed before the bump
  });

  it("a failed persist leaves the document dirty (Unsaved) without rolling back the edit", async () => {
    const fs = new MemFs();
    const s = store(fs);
    await ensureTimeline(s);
    vi.spyOn(fs, "writeTextFile").mockRejectedValue(new Error("disk full"));
    await applyOp(s, "a", (t) => void t.tracks.push({ id: "a", kind: "video", z: 0, clips: [] }));
    await doc.autosave.flush();
    expect(doc.timeline?.current().tracks.map((t) => t.id)).toEqual(["a"]); // edit NOT rolled back
    expect(doc.timeline?.isDirty()).toBe(true); // persist failed -> stays Unsaved
  });

  it("blocks close until a transient save failure clears (bounded retry), landing the last edit", async () => {
    const fs = new MemFs();
    const okDoc = new ProjectDocument(asProjectId("proj"), {
      open: async () => "loaded",
      dispose: async () => {},
    });
    setOpenDocumentResolver((id) => (id === asProjectId("proj") ? okDoc : undefined));
    const s = store(fs);
    await ensureTimeline(s);
    const realWrite = fs.writeTextFile.bind(fs);
    let fails = 2; // two transient write failures, then success — within MAX_PERSIST_RETRIES
    vi.spyOn(fs, "writeTextFile").mockImplementation(async (p: string, c: string) => {
      if (p.includes("timeline.json") && fails > 0) {
        fails--;
        throw new Error("EBUSY: transient write failure");
      }
      return realWrite(p, c);
    });
    await applyOp(s, "a", (t) => void t.tracks.push(videoTrack()));
    await okDoc.close(); // the autosave retry means flush BLOCKS until the edit lands
    expect(fails).toBe(0); // it retried past both failures
    expect(okDoc.timeline?.isDirty()).toBe(false); // the last edit reached disk (clean)
  });

  it("surfaces a persistent final-save failure on close via onCloseSaveFailed (never silent)", async () => {
    const failed: string[] = [];
    const fs = new MemFs();
    const failDoc = new ProjectDocument(
      asProjectId("proj"),
      { open: async () => "loaded", dispose: async () => {} },
      { onCloseSaveFailed: (id) => failed.push(String(id)) },
    );
    setOpenDocumentResolver((id) => (id === asProjectId("proj") ? failDoc : undefined));
    const s = store(fs);
    await ensureTimeline(s);
    let writes = 0; // count only the persist attempts (ensureTimeline already ran, un-mocked)
    vi.spyOn(fs, "writeTextFile").mockImplementation(async (p: string) => {
      if (p.includes("timeline.json")) writes++;
      throw new Error("disk full"); // every persist fails
    });
    await applyOp(s, "a", (t) => void t.tracks.push(videoTrack()));
    await failDoc.close(); // retries are exhausted -> timeline still dirty -> surfaced, not swallowed
    expect(failed).toEqual(["proj"]);
    expect(failDoc.timeline?.isDirty()).toBe(true); // the lost edit is NOT silently marked saved
    // The retry is BOUNDED: the first attempt + exactly MAX_PERSIST_RETRIES (3) re-attempts = 4
    // writes, never an unbounded loop. Pins the `attempt < cap` boundary (a `<=` off-by-one that
    // retried once more would make 5) — the close-barrier must stop, not spin.
    expect(writes).toBe(4);
  });

  it("Retry after a recovered disk RE-ATTEMPTS the timeline write, not a drained-autosave no-op (finding #3)", async () => {
    const fs = new MemFs();
    const s = store(fs);
    // Wire the close-SAVE re-arm exactly as documentRegistry does: a Retry re-schedules a FRESH
    // persist onto the same autosave (reset budget), so the actual disk write is re-attempted.
    const retryDoc = new ProjectDocument(
      asProjectId("proj"),
      { open: async () => "loaded", dispose: async () => {} },
      { rearmTimelineSave: (d) => rearmTimelinePersist(s, d) },
    );
    setOpenDocumentResolver((id) => (id === asProjectId("proj") ? retryDoc : undefined));
    await ensureTimeline(s);
    let broken = true;
    const realWrite = fs.writeTextFile.bind(fs);
    vi.spyOn(fs, "writeTextFile").mockImplementation(async (p: string, c: string) => {
      if (p.includes("timeline.json") && broken) throw new Error("disk full"); // every persist fails while broken
      return realWrite(p, c);
    });
    await applyOp(s, "a", (t) => void t.tracks.push(videoTrack()));
    expect((await retryDoc.close()).ok).toBe(false); // retries exhausted -> close-failed
    expect(retryDoc.timeline?.isDirty()).toBe(true);
    broken = false; // the disk recovers
    expect((await retryDoc.retryClose()).ok).toBe(true); // Retry re-attempts the ACTUAL write
    expect(retryDoc.timeline?.isDirty()).toBe(false); // the edit finally reached disk (clean)
    setOpenDocumentResolver(() => undefined);
    expect((await loadTimeline(s)).tracks).toHaveLength(1); // durable on disk
  });

  it("rejects an agent commit carrying a SUPERSEDED execution origin (the origin fence)", async () => {
    const CURRENT = 2;
    const fenced = new ProjectDocument(
      asProjectId("proj"),
      { open: async () => "loaded", dispose: async () => {} },
      { isOriginCurrent: (o) => o.executionId === CURRENT },
    );
    setOpenDocumentResolver((id) => (id === asProjectId("proj") ? fenced : undefined));
    const s = store();
    await ensureTimeline(s);
    const current = { chatSessionId: "t1", branchId: 0, executionId: CURRENT };
    const stale = { chatSessionId: "t1", branchId: 0, executionId: 1 };
    // A commit from the CURRENT execution lands.
    const ok = await applyOp(
      s,
      "a",
      (t) => void t.tracks.push({ id: "a", kind: "video", z: 0, clips: [] }),
      current,
    );
    expect(ok.ok).toBe(true);
    // A commit from a SUPERSEDED execution is rejected at the gate — nothing more lands.
    const rejected = await applyOp(
      s,
      "b",
      (t) => void t.tracks.push({ id: "b", kind: "video", z: 1, clips: [] }),
      stale,
    );
    expect(rejected.ok).toBe(false);
    expect(fenced.timeline?.current().tracks.map((t) => t.id)).toEqual(["a"]); // b was never applied
    await fenced.autosave.flush();
  });

  it("ctxApplyOp threads the tool context's origin so a superseded agent-tool commit is fenced", async () => {
    const CURRENT = 3;
    const fenced = new ProjectDocument(
      asProjectId("proj"),
      { open: async () => "loaded", dispose: async () => {} },
      { isOriginCurrent: (o) => o.executionId === CURRENT },
    );
    setOpenDocumentResolver((id) => (id === asProjectId("proj") ? fenced : undefined));
    const s = store();
    await ensureTimeline(s);
    const ctx = (executionId: number) =>
      ({
        store: s,
        origin: { chatSessionId: "t", branchId: 0, executionId },
      }) as unknown as ClientToolContext;
    const ok = await ctxApplyOp(
      ctx(CURRENT),
      "a",
      (t) => void t.tracks.push({ id: "a", kind: "video", z: 0, clips: [] }),
    );
    expect(ok.ok).toBe(true);
    const rejected = await ctxApplyOp(
      ctx(1),
      "b",
      (t) => void t.tracks.push({ id: "b", kind: "video", z: 1, clips: [] }),
    );
    expect(rejected.ok).toBe(false); // superseded execution -> fenced at the gate
    expect(fenced.timeline?.current().tracks.map((t) => t.id)).toEqual(["a"]);
    await fenced.autosave.flush();
  });

  it("re-checks origin at the final apply — a supersede DURING the lazy load is rejected", async () => {
    let current = true;
    const fenced = new ProjectDocument(
      asProjectId("proj"),
      { open: async () => "loaded", dispose: async () => {} },
      { isOriginCurrent: () => current },
    );
    setOpenDocumentResolver((id) => (id === asProjectId("proj") ? fenced : undefined));
    const fs = new MemFs();
    const s = new ProjectStoreAccess(DIR, fs);
    await ensureTimeline(s); // seeds disk; no session yet
    // Preflight passes (current=true at submission). The first edit's lazy load reads disk — flip
    // current=false THERE so assertCanCommit (after the load) catches the now-superseded origin.
    const realRead = fs.readTextFile.bind(fs);
    vi.spyOn(fs, "readTextFile").mockImplementation(async (p: string) => {
      current = false;
      return realRead(p);
    });
    const r = await applyOp(
      s,
      "a",
      (t) => void t.tracks.push({ id: "a", kind: "video", z: 0, clips: [] }),
      {
        chatSessionId: "t",
        branchId: 0,
        executionId: 1,
      },
    );
    expect(r.ok).toBe(false); // preflight passed, but assertCanCommit caught the mid-lease supersede
    expect(fenced.timeline?.current().tracks ?? []).toHaveLength(0); // nothing was applied
    await fenced.autosave.flush();
  });

  it("rejects a commit submitted after the gate began closing (nothing lands)", async () => {
    const s = store();
    await ensureTimeline(s);
    void doc.gate.beginClose();
    const r = await applyOp(s, "add_track", (t) => {
      t.tracks.push(videoTrack());
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("closed");
    expect((await loadTimeline(s)).tracks).toHaveLength(0); // the edit never wrote
  });

  it("rejects an undo and a redo submitted after the gate began closing (nothing lands)", async () => {
    const s = store();
    await ensureTimeline(s);
    await applyOp(s, "a", (t) => void t.tracks.push(videoTrack())); // give undo/redo something to move
    void doc.gate.beginClose();
    const u = await doUndo(s);
    expect(u.ok).toBe(false);
    expect(String(u.error)).toContain("closed");
    const r = await doRedo(s);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("closed");
    expect((await loadTimeline(s)).tracks).toHaveLength(1); // the edit stands; neither undo nor redo committed
  });
});

describe("full timeline round-trip", () => {
  // A rich timeline exercising every field family (keyframe tracks, transform,
  // fades, transition, grade, effects, crop/flip/glow, links, text) survives
  // save -> load and JSON stringify -> parse byte-for-byte. Mirrors other NLEs'
  // ProjectRoundTripTests: the persisted model is lossless.
  const rich: Timeline = {
    units: "frames",
    canvas: { width: 1920, height: 1080, fps: 30 },
    failures: [],
    tracks: [
      {
        id: "v1",
        kind: "video",
        z: 0,
        clips: [
          {
            id: "c1",
            kind: "video",
            media_ref: "hero.mp4",
            source_in: 12,
            source_out: 132,
            timeline_in: 0,
            timeline_out: 120,
            speed: 1,
            transform: {
              position: {
                x: [
                  { t: 0, v: 0.5 },
                  { t: 60, v: 0.4, ease: "ease-in-out" },
                  { t: 119, v: 0.5 },
                ],
                y: 0.5,
              },
              scale: [
                { t: 0, v: 1 },
                { t: 119, v: 1.2 },
              ],
              scale_x: 1,
            },
            rotate: [
              { t: 0, v: 0 },
              { t: 119, v: 15 },
            ],
            opacity: [
              { t: 0, v: 0 },
              { t: 20, v: 1 },
            ],
            crop: { left: 0.05, right: 0.05 },
            flip: { h: true },
            glow: { amount: 30, opacity: 0.5 },
            blend: "screen",
            color: { exposure: 0.2, saturation: 1.1, temperature: -0.1 },
            effects: [{ type: "blur.gaussian", radius: 8 }],
            fade: { in: 6, out: 6 },
            link_group: "g1",
          },
        ],
      },
      {
        id: "v2",
        kind: "video",
        z: 1,
        clips: [
          // A crossfade needs a preceding clip on the same track (validateTimeline rejects a
          // lone-clip transition, exactly like applyOp) — so c2 transitions FROM c2a.
          {
            id: "c2a",
            kind: "video",
            media_ref: "intro.mp4",
            source_in: 0,
            source_out: 90,
            timeline_in: 40,
            timeline_out: 130,
          },
          {
            id: "c2",
            kind: "video",
            media_ref: "broll.mp4",
            source_in: 0,
            source_out: 90,
            timeline_in: 130,
            timeline_out: 220,
            transition_in: { kind: "crossfade", duration: 10 },
          },
        ],
      },
      {
        id: "a1",
        kind: "audio",
        z: 2,
        clips: [
          {
            id: "a-c1",
            kind: "audio",
            media_ref: "vo.mp3",
            source_in: 0,
            source_out: 120,
            timeline_in: 0,
            timeline_out: 120,
            volume: [
              { t: 0, v: 1 },
              { t: 100, v: 0.2 },
            ],
            fade: { in: 3, out: 3 },
            duck: { against: "hero.mp4", ratio: 0.3, threshold: 0.05 },
            link_group: "g1",
          },
        ],
      },
      {
        id: "t1",
        kind: "text",
        z: 3,
        clips: [
          {
            id: "cap1",
            kind: "text",
            timeline_in: 0,
            timeline_out: 60,
            content: [{ text: "Hello", bold: true }],
            style: { font: "Inter", size: 72, color: "#ffffff" },
            animation: { kind: "pop", duration: 8 },
          },
        ],
      },
    ],
  };

  it("survives JSON stringify -> parse deep-equal", () => {
    expect(JSON.parse(JSON.stringify(rich))).toEqual(rich);
  });

  it("survives a save -> load through the store deep-equal", async () => {
    const s = store();
    await ensureTimeline(s);
    await replaceTimeline(s, rich);
    expect(await loadTimeline(s)).toEqual(rich);
  });
});

describe("loop / stretch fill", () => {
  it("keeps a loop clip's short source (validate + derive exempt loop/stretch)", async () => {
    const s = store();
    await ensureTimeline(s);
    await applyOp(s, "add_track", (t) => {
      t.tracks.push({ id: "a1", kind: "audio", z: 0, clips: [] });
    });
    // A 15-frame tone looped to fill a 30-frame slot: source span != timeline span.
    const r = await applyOp(s, "seed", (t) => {
      t.tracks[0].clips!.push({
        id: "loopc",
        kind: "audio",
        media_ref: "tone.wav",
        source_in: 0,
        source_out: 15,
        timeline_in: 0,
        timeline_out: 30,
        loop: true,
      });
    });
    expect(r.ok).toBe(true); // parity is NOT enforced for a loop clip
    const c = (await loadTimeline(s)).tracks[0].clips![0];
    expect([c.source_in, c.source_out]).toEqual([0, 15]); // source_out preserved, NOT derived to 30
    expect([c.timeline_in, c.timeline_out]).toEqual([0, 30]);
  });

  it("derives a NON-loop clip's source_out to the slot (contrast)", async () => {
    const s = store();
    await ensureTimeline(s);
    await applyOp(s, "add_track", (t) => {
      t.tracks.push({ id: "a1", kind: "audio", z: 0, clips: [] });
    });
    // Same spans WITHOUT loop: deriveSourceSpans rewrites source_out to fill the
    // slot (source_out is derived, never authoritative), so it's a full clip — the
    // short 15-frame source is NOT preserved the way a loop clip's is.
    const r = await applyOp(s, "seed", (t) => {
      t.tracks[0].clips!.push({
        id: "normalc",
        kind: "audio",
        media_ref: "tone.wav",
        source_in: 0,
        source_out: 15,
        timeline_in: 0,
        timeline_out: 30,
      });
    });
    expect(r.ok).toBe(true);
    expect((await loadTimeline(s)).tracks[0].clips![0].source_out).toBe(30); // derived to the slot, not 15
  });
});

describe("ensureStarterTimeline", () => {
  const starterIds = ["v1", "a1"];

  it("seeds one video + one audio starter track for a fresh project", async () => {
    const s = store();
    const tl = await ensureStarterTimeline(s);
    expect(tl.tracks.map((t) => t.id)).toEqual(starterIds);
    expect((await loadTimeline(s)).tracks.map((t) => t.id)).toEqual(starterIds);
  });

  it("seeds a track the default placement will actually use", async () => {
    // Two places name the starting video track. If they drift, the first clip a user adds
    // conjures a second track next to the empty seeded one, and the timeline opens with a
    // lane nothing will ever land on.
    const s = store();
    const tl = await ensureStarterTimeline(s);
    const target = tl.tracks.find((t) => t.id === DEFAULT_VISUAL_TRACK);
    expect(target, `no starter track named ${DEFAULT_VISUAL_TRACK}`).toBeTruthy();
    expect(target!.kind).toBe("video");
  });

  it("seeds starters onto a valid but empty timeline", async () => {
    const s = store();
    await ensureTimeline(s); // valid, 0 tracks
    expect((await ensureStarterTimeline(s)).tracks.map((t) => t.id)).toEqual(starterIds);
  });

  it("preserves an existing timeline that already has tracks", async () => {
    const s = store();
    await ensureTimeline(s);
    await applyOp(s, "seed", (t) => {
      t.tracks.push(videoTrack());
    });
    expect((await ensureStarterTimeline(s)).tracks.map((t) => t.id)).toEqual(["v"]);
  });

  it("does NOT overwrite the real timeline when the read fails (data-loss guard)", async () => {
    const fs = new MemFs();
    const s = store(fs);
    await ensureTimeline(s);
    // Seed a real 3-track timeline on DISK (no in-memory session yet), so ensureStarterTimeline
    // reads it BACK from disk — where the transient read failure below strikes.
    const key = [...fs.files.keys()].find((k) => k.includes("timeline.json"))!;
    fs.files.set(
      key,
      JSON.stringify({
        units: "frames",
        canvas: { width: 1920, height: 1080, fps: 30 },
        tracks: [0, 1, 2].map((i) => ({ id: `t${i}`, kind: "video", z: i, clips: [] })),
      }),
    );
    // Simulate a transient read failure (e.g. racing a concurrent write).
    const realRead = fs.readTextFile.bind(fs);
    fs.readTextFile = async (p: string) => {
      if (p.includes("timeline.json")) throw new Error("EBUSY: read failed");
      return realRead(p);
    };
    await expect(ensureStarterTimeline(s)).rejects.toThrow();
    // The real timeline must be intact — NOT clobbered with starter tracks.
    fs.readTextFile = realRead;
    expect((await loadTimeline(s)).tracks.length).toBe(3);
  });

  it("refuses a SEMANTICALLY malformed existing timeline (bad canvas / null track) (R7-4)", async () => {
    const fs = new MemFs();
    const s = store(fs);
    await ensureTimeline(s); // valid timeline at the canonical path
    const key = [...fs.files.keys()].find((k) => k.includes("timeline.json"))!;
    // tracks is an ARRAY (the old shallow check passed) but a track is null.
    fs.files.set(
      key,
      JSON.stringify({ canvas: { width: 1920, height: 1080, fps: 30 }, tracks: [null] }),
    );
    await expect(ensureStarterTimeline(s)).rejects.toThrow(/malformed/);
    // A canvas-less / invalid-canvas timeline must be refused, NOT seeded over.
    fs.files.set(key, JSON.stringify({ canvas: { width: 0, height: 1080, fps: 30 }, tracks: [] }));
    await expect(ensureStarterTimeline(s)).rejects.toThrow(/malformed/);
  });

  it("opens a schema-valid timeline whose tracks omit the optional z (R8-4)", async () => {
    const fs = new MemFs();
    const s = store(fs);
    await ensureTimeline(s);
    const key = [...fs.files.keys()].find((k) => k.includes("timeline.json"))!;
    // z is optional in the model + schema, but the strict validator requires it -- a
    // persisted track without z must still open (z is filled), not be refused (was a
    // R7-4 regression).
    fs.files.set(
      key,
      JSON.stringify({
        canvas: { width: 1920, height: 1080, fps: 30 },
        tracks: [{ id: "v1", kind: "video", clips: [] }],
      }),
    );
    const tl = await ensureStarterTimeline(s);
    expect(tl.tracks.map((t) => t.id)).toEqual(["v1"]);
    expect(tl.tracks[0].z).toBe(0); // filled default
  });

  it("makes a z-less timeline editable + persists the filled z (R9-5)", async () => {
    const fs = new MemFs();
    const s = store(fs);
    await ensureTimeline(s);
    const key = [...fs.files.keys()].find((k) => k.includes("timeline.json"))!;
    // A persisted track that omits the optional z opened fine (z filled in memory) but
    // the first edit reloaded the z-less file and the strict validator rejected it.
    // normalizeTimeline now fills z on every mutation, so the edit succeeds AND the
    // saved file carries z (durable, not just an open-time patch).
    fs.files.set(
      key,
      JSON.stringify({
        canvas: { width: 1920, height: 1080, fps: 30 },
        tracks: [{ id: "v1", kind: "video", clips: [] }],
      }),
    );
    const r = await applyOp(s, "add_track", (t) => {
      t.tracks.push({ id: "v2", kind: "video", z: 1, clips: [] } as Track);
      return {};
    });
    expect(r.ok).toBe(true);
    const saved = JSON.parse(fs.files.get(key)!) as { tracks: { z?: number }[] };
    expect(saved.tracks[0].z).toBe(0); // filled + PERSISTED (was absent -> would reject)
    expect(saved.tracks[1].z).toBe(1);
  });

  it("loadTimeline fills optional units + z at the load boundary so every reader is valid (R10-4)", async () => {
    const fs = new MemFs();
    const s = store(fs);
    await ensureTimeline(s);
    const key = [...fs.files.keys()].find((k) => k.includes("timeline.json"))!;
    fs.files.set(
      key,
      JSON.stringify({
        canvas: { width: 1920, height: 1080, fps: 30 },
        tracks: [
          { id: "v1", kind: "video", clips: [] },
          { id: "v2", kind: "video", clips: [] },
        ],
      }),
    );
    const tl = await loadTimeline(s);
    // export/inspect/undo all read through loadTimeline, so they now see filled defaults
    expect(tl.units).toBe("frames");
    expect(tl.tracks.map((t) => t.z)).toEqual([0, 1]); // distinct z by index -> no add_track nextZ collision
  });

  it("canonicalizes a z-less snapshot on write (replaceTimeline / undo restore) (R11-4)", async () => {
    const fs = new MemFs();
    const s = store(fs);
    await ensureTimeline(s);
    // A legacy z-less snapshot restored by replaceTimeline (turn checkpoint) or undo/redo
    // must not land raw: saveTimeline canonicalizes before writing + emitting.
    await replaceTimeline(s, {
      units: "frames",
      canvas: { width: 1920, height: 1080, fps: 30 },
      tracks: [{ id: "v1", kind: "video", clips: [] }],
    } as Timeline);
    const key = [...fs.files.keys()].find((k) => k.includes("timeline.json"))!;
    const saved = JSON.parse(fs.files.get(key)!) as { units?: string; tracks: { z?: number }[] };
    expect(saved.units).toBe("frames");
    expect(saved.tracks[0].z).toBe(0);
  });

  it("rejects an invalid snapshot instead of persisting/broadcasting it (R11 follow-up)", async () => {
    const fs = new MemFs();
    const s = store(fs);
    await ensureTimeline(s);
    const key = [...fs.files.keys()].find((k) => k.includes("timeline.json"))!;
    const before = fs.files.get(key);
    // Duplicate track id -> validateTimeline rejects; replaceTimeline must refuse to persist
    // AND emit rather than pushing a corrupt timeline live (a restored checkpoint can come
    // from a tampered/corrupt session file).
    await expect(
      replaceTimeline(s, {
        canvas: { width: 1920, height: 1080, fps: 30 },
        tracks: [
          { id: "v1", kind: "video", z: 0, clips: [] },
          { id: "v1", kind: "video", z: 1, clips: [] },
        ],
      } as Timeline),
    ).rejects.toThrow(/invalid timeline snapshot/);
    expect(fs.files.get(key)).toBe(before); // the bad snapshot never landed on disk
  });
});

describe("applyOp pipeline", () => {
  let s: ProjectStoreAccess;
  beforeEach(async () => {
    s = store();
    await ensureTimeline(s);
  });

  it("applies a mutation, records undo, and returns info", async () => {
    const r = await applyOp(s, "add_track", (t) => {
      t.tracks.push(videoTrack());
      return { track_id: "v" };
    });
    expect(r.ok).toBe(true);
    expect(r.op).toBe("add_track");
    expect(r.track_id).toBe("v");
    expect((await loadTimeline(s)).tracks.length).toBe(1);
  });

  it("rejects on validation and leaves the timeline unchanged", async () => {
    await applyOp(s, "add_track", (t) => {
      t.tracks.push(videoTrack());
    });
    const r = await applyOp(s, "bad", (t) => {
      // timeline_out <= timeline_in is a hard validation error the pipeline can't
      // auto-correct (a source-parity mismatch, by contrast, is now derived away),
      // so the whole op is rejected and rolled back.
      t.tracks[0].clips!.push({
        media_ref: "a.mp4",
        source_in: 0,
        timeline_in: 60,
        timeline_out: 30,
      });
    });
    expect(r.ok).toBe(false);
    expect(r.validation_errors).toBeDefined();
    expect((await loadTimeline(s)).tracks[0].clips!.length).toBe(0);
  });

  it("surfaces an OpError as { ok:false }", async () => {
    const r = await applyOp(s, "x", () => {
      throw new OpError("boom");
    });
    expect(r).toEqual({ ok: false, error: "boom" });
  });

  it("rethrows a non-OpError from the mutation", async () => {
    await expect(
      applyOp(s, "x", () => {
        throw new TypeError("unexpected");
      }),
    ).rejects.toThrow("unexpected");
  });

  it("reports clamp notes", async () => {
    await applyOp(s, "add_track", (t) => {
      t.tracks.push(videoTrack());
    });
    const r = await applyOp(s, "add", (t) => {
      t.tracks[0].clips!.push({
        media_ref: "a.mp4",
        source_in: 0,
        source_out: 60,
        timeline_in: 0,
        timeline_out: 60,
        opacity: 3,
      });
    });
    expect(r.ok).toBe(true);
    expect(r.clamped).toBeDefined();
  });

  it("sorts clips by timeline_in at the save boundary", async () => {
    await applyOp(s, "add_track", (t) => {
      t.tracks.push(videoTrack());
    });
    await applyOp(s, "seed", (t) => {
      t.tracks[0].clips!.push(
        { media_ref: "a.mp4", source_in: 0, source_out: 30, timeline_in: 60, timeline_out: 90 },
        { media_ref: "a.mp4", source_in: 0, source_out: 30, timeline_in: 0, timeline_out: 30 },
      );
    });
    const clips = (await loadTimeline(s)).tracks[0].clips!;
    expect(clips.map((c) => c.timeline_in)).toEqual([0, 60]);
  });
});

describe("undo / redo", () => {
  it("round-trips through the two stacks", async () => {
    const s = store();
    await ensureTimeline(s);
    await applyOp(s, "add_track", (t) => {
      t.tracks.push(videoTrack());
    });
    expect((await loadTimeline(s)).tracks.length).toBe(1);
    expect((await doUndo(s)).ok).toBe(true);
    expect((await loadTimeline(s)).tracks.length).toBe(0);
    expect((await doRedo(s)).ok).toBe(true);
    expect((await loadTimeline(s)).tracks.length).toBe(1);
  });
  it("reports empty stacks", async () => {
    const s = store();
    await ensureTimeline(s);
    expect(String((await doUndo(s)).error)).toContain("nothing to undo");
    expect(String((await doRedo(s)).error)).toContain("nothing to redo");
  });

  it("keeps undo/redo history IN MEMORY — never writes history.json (R11 follow-up)", async () => {
    // Editor undo is a within-session affordance now: works in memory but persists NOTHING
    // to disk (no timeline.json/history.json two-file window). Durable restore = transcript.
    const fs = new MemFs();
    const s = store(fs);
    await ensureTimeline(s);
    await applyOp(s, "add_track", (t) => {
      t.tracks.push(videoTrack());
    });
    expect((await doUndo(s)).ok).toBe(true);
    expect((await loadTimeline(s)).tracks.length).toBe(0);
    expect((await doRedo(s)).ok).toBe(true);
    expect((await loadTimeline(s)).tracks.length).toBe(1);
    expect([...fs.files.keys()].some((k) => k.includes("history.json"))).toBe(false);
  });

  it("shares ONE history between the editor store and the AI/host store — same projectDir (R11 follow-up #1)", async () => {
    // The editor and the agent tool-host hold SEPARATE ProjectStoreAccess objects over the
    // same project dir. History is keyed by DIR, so a manual undo undoes ONLY the AI edit,
    // never wipes both (the object-keyed bug this replaces did exactly that).
    const fs = new MemFs();
    const ed = store(fs); // editor's store instance
    const ai = store(fs); // tool-host's store instance (DIFFERENT object, SAME dir + fs)
    await ensureTimeline(ed);
    await applyOp(
      ed,
      "manual",
      (t) => void t.tracks.push({ id: "m", kind: "video", z: 0, clips: [] }),
    );
    await applyOp(ai, "ai", (t) => void t.tracks.push({ id: "a", kind: "video", z: 1, clips: [] }));
    expect((await loadTimeline(ed)).tracks.map((t) => t.id)).toEqual(["m", "a"]);
    expect((await doUndo(ed)).ok).toBe(true); // manual undo via the EDITOR store
    expect((await loadTimeline(ai)).tracks.map((t) => t.id)).toEqual(["m"]); // ONLY the AI edit undone
  });

  it("seeds under the lock, so a reopen can't clobber an edit committing concurrently (finding #1)", async () => {
    const fs = new MemFs();
    const s1 = store(fs);
    await ensureTimeline(s1); // an empty timeline.json exists (0 tracks)
    // Edit E1 (adds a 'user' track) blocks mid-commit, holding the project lock.
    let releaseWrite!: () => void;
    let signalWriting!: () => void;
    const blocked = new Promise<void>((r) => (releaseWrite = r));
    const writing = new Promise<void>((r) => (signalWriting = r));
    const realWrite = fs.writeTextFile.bind(fs);
    let firstWrite = true;
    fs.writeTextFile = async (p: string, c: string) => {
      if (firstWrite) {
        firstWrite = false;
        signalWriting();
        await blocked;
      }
      return realWrite(p, c);
    };
    const e1 = applyOp(
      s1,
      "e1",
      (t) => void t.tracks.push({ id: "user", kind: "video", z: 0, clips: [] }),
    );
    await writing; // E1 holds the lock, mid-write
    // A reopen's ensureStarterTimeline must serialize BEHIND E1 (its read + seed are ONE RMW under
    // the lock), so it reads E1's committed [user] track and does NOT seed starter tracks over it.
    const s2 = store(fs);
    const reopenedP = ensureStarterTimeline(s2);
    releaseWrite();
    const [, reopened] = await Promise.all([e1, reopenedP]);
    fs.writeTextFile = realWrite;
    expect(reopened.tracks.map((t) => t.id)).toEqual(["user"]); // E1's edit survived — NOT clobbered
    expect((await loadTimeline(s2)).tracks.map((t) => t.id)).toEqual(["user"]); // on disk too
  });

  it("resets editor history on a checkpoint restore (replaceTimeline) (R11 follow-up #3)", async () => {
    const fs = new MemFs();
    const s = store(fs);
    await ensureTimeline(s);
    await applyOp(s, "e", (t) => void t.tracks.push(videoTrack()));
    // A chat checkpoint restore jumps to a different branch -> the editor undo stack is stale.
    await replaceTimeline(s, {
      units: "frames",
      canvas: { width: 1920, height: 1080, fps: 30 },
      tracks: [],
    } as Timeline);
    expect(String((await doUndo(s)).error)).toContain("nothing to undo");
  });

  it("lets an edit QUEUED behind a checkpoint RESTORE record undo on the new branch (restore != close, R11 f/u)", async () => {
    // A restore (replaceTimeline) resets the undo BRANCH but does NOT close the session, so an
    // edit that queues behind the restore and runs after it MUST stay undoable on the new branch
    // — the opposite of the close case above (which fences the queued edit). Guards the regression
    // where restore + close shared one generation bump and a restore-queued edit was wrongly fenced.
    const fs = new MemFs();
    const s = store(fs);
    await ensureTimeline(s);
    let releaseWrite!: () => void;
    let signalRestoreWriting!: () => void;
    const blocked = new Promise<void>((r) => (releaseWrite = r));
    const restoreWriting = new Promise<void>((r) => (signalRestoreWriting = r));
    const realWrite = fs.writeTextFile.bind(fs);
    let firstWrite = true;
    fs.writeTextFile = async (p: string, c: string) => {
      if (firstWrite) {
        firstWrite = false;
        signalRestoreWriting(); // the restore is now inside its write, holding the lock
        await blocked;
      }
      return realWrite(p, c);
    };
    const restore = replaceTimeline(s, {
      units: "frames",
      canvas: { width: 1920, height: 1080, fps: 30 },
      tracks: [{ id: "cp", kind: "video", z: 0, clips: [] }],
    } as Timeline);
    await restoreWriting; // the restore holds the lock, mid-write
    const queued = applyOp(
      s,
      "queued",
      (t) => void t.tracks.push({ id: "q", kind: "video", z: 1, clips: [] }),
    ); // queues behind the restore
    releaseWrite();
    await Promise.all([restore, queued]);
    fs.writeTextFile = realWrite;
    expect((await loadTimeline(s)).tracks.map((t) => t.id)).toEqual(["cp", "q"]); // restore + the queued edit both applied
    expect((await doUndo(s)).ok).toBe(true); // the queued edit IS undoable (new branch), NOT fenced
    expect((await loadTimeline(s)).tracks.map((t) => t.id)).toEqual(["cp"]); // undo removes only the queued edit
  });
});

describe("history & concurrency", () => {
  it("clears the redo stack when a new edit is applied", async () => {
    const s = store();
    await ensureTimeline(s);
    await applyOp(s, "add_track", (t) => {
      t.tracks.push(videoTrack());
    });
    expect((await doUndo(s)).ok).toBe(true); // redo now holds the add_track
    await applyOp(s, "add_track_2", (t) => {
      t.tracks.push({ id: "v2", kind: "video", z: 0, clips: [] });
    });
    // The stale redo branch is discarded by the new edit.
    expect((await doRedo(s)).ok).toBe(false);
  });

  it("caps undo history at 50 states (drops the oldest)", async () => {
    const s = store();
    await ensureTimeline(s);
    for (let i = 0; i < 60; i++) {
      await applyOp(s, "add", (t) => {
        t.tracks.push({ id: `t${i}`, kind: "video", z: 0, clips: [] });
      });
    }
    let undos = 0;
    while ((await doUndo(s)).ok) undos++;
    expect(undos).toBe(50);
  });

  it("retries a transient timeline.json read, then succeeds", async () => {
    const fs = new MemFs();
    const s = store(fs);
    await ensureTimeline(s);
    // A 1-track timeline on DISK with no in-memory session yet, so loadTimeline reads disk (where
    // the transient failure strikes) rather than serving from the document.
    const key = [...fs.files.keys()].find((k) => k.includes("timeline.json"))!;
    fs.files.set(
      key,
      JSON.stringify({
        units: "frames",
        canvas: { width: 1920, height: 1080, fps: 30 },
        tracks: [{ id: "v", kind: "video", z: 0, clips: [] }],
      }),
    );
    const realRead = fs.readTextFile.bind(fs);
    let fails = 2; // fail twice (a racing write), then the real read wins — within LOAD_RETRIES
    fs.readTextFile = async (p: string) => {
      if (p.includes("timeline.json") && fails > 0) {
        fails--;
        throw new Error("EBUSY: read raced a write");
      }
      return realRead(p);
    };
    const tl = await loadTimeline(s);
    expect(tl.tracks.length).toBe(1);
    expect(fails).toBe(0); // it genuinely retried
  });

  it("gives up after exactly LOAD_RETRIES failed reads instead of retrying forever", async () => {
    const fs = new MemFs();
    const s = store(fs);
    await ensureTimeline(s); // a file exists on disk; no in-memory session yet -> loadTimeline reads disk
    const realRead = fs.readTextFile.bind(fs);
    let reads = 0;
    fs.readTextFile = async (p: string) => {
      if (p.includes("timeline.json")) {
        reads++;
        throw new Error("EBUSY: the read keeps racing a write");
      }
      return realRead(p);
    };
    await expect(loadTimeline(s)).rejects.toThrow("EBUSY");
    // BOUNDED: exactly LOAD_RETRIES (4) read attempts, never an unbounded loop. Pins the
    // `attempt < LOAD_RETRIES` upper boundary — a `<=` off-by-one (5 reads) or a dropped
    // loop condition fails this. Symmetric to the persist-retry bound (writes === 4) above,
    // and an ASSERTION kill for the loadTimeline-retry mutants Stryker had only been catching
    // by timeout luck (they reclassify to survivors when the baseline test time shifts).
    expect(reads).toBe(4);
  });
});

describe("no open document (bare store) — commits fail cleanly, never crash", () => {
  // Supersede the file-level open-document resolver so runTimelineCommit takes the coordinator
  // fallback and applyOpLocked/doUndoLocked/doRedoLocked hit their `!doc` guards (Phase 5.5).
  beforeEach(() => setOpenDocumentResolver(() => undefined));

  it("applyOp refuses without an open document (no crash, nothing applied)", async () => {
    const s = store();
    await ensureTimeline(s);
    const r = await applyOp(s, "add_track", (t) => void t.tracks.push(videoTrack()));
    expect(r.ok).toBe(false);
    // The refusal must name the remedy, not just the state: "no open project for this store" is
    // what an agent saw while every READ kept succeeding, so the project looked healthy and the
    // only cure anyone found was restarting the app.
    const why = String((r as { error?: string }).error);
    expect(why).toContain("no open document");
    expect(why).toContain("manage_project");
    expect((await loadTimeline(s)).tracks).toHaveLength(0);
  });

  it("doUndo and doRedo report nothing to undo/redo without an open document", async () => {
    const s = store();
    await ensureTimeline(s);
    expect(String((await doUndo(s)).error)).toContain("nothing to undo");
    expect(String((await doRedo(s)).error)).toContain("nothing to redo");
  });

  it("replaceTimeline returns false without an open document", async () => {
    const s = store();
    await ensureTimeline(s);
    expect(await replaceTimeline(s, emptyTimeline())).toBe(false);
  });
});
