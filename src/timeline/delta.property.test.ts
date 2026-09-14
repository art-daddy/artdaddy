// The delta is a PROMISE: "patch your model from this, don't re-read". The system
// prompt tells the model to trust it, so if a delta is ever incomplete the model works
// from a wrong picture with no signal that anything is missing — the worst failure mode
// we have, because nothing errors.
//
// These tests reconstruct the post-edit timeline from ONLY (pre-edit timeline + delta),
// exactly as the model would, and assert it matches reality. A delta that omits a
// change fails here even though the edit itself succeeded.
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setOpenDocumentResolver } from "../project/openDocuments";
import { ProjectDocument } from "../project/ProjectDocument";
import { asProjectId } from "../project/types";
import { ProjectStoreAccess, joinPath, type FsLike } from "../tools/store";
import { endProjectSession } from "../tools/coordinator";
import { applyOp, doRedo, doUndo, ensureTimeline, loadTimeline } from "./engine";
import type { Clip, Timeline } from "./model";

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
let doc: ProjectDocument;
beforeEach(() => {
  doc = new ProjectDocument(asProjectId("proj"), {
    open: async () => "loaded",
    dispose: async () => {},
  });
  setOpenDocumentResolver((id) => (id === asProjectId("proj") ? doc : undefined));
});
afterEach(async () => {
  await endProjectSession(DIR);
  setOpenDocumentResolver(() => undefined);
});

type Delta = {
  clips?: (Clip & { track: string })[];
  shifted?: { track: string; from_frame: number; by: number; count: number }[];
  removed_ids?: string[];
  created_tracks?: string[];
  clips_note?: string;
};

/** Rebuild a timeline's clip index from (before + delta) the way the model must:
 *  drop removed ids, slide whole runs by the shift rules, then overwrite with the
 *  resulting state of each changed clip. Returns id -> {track, in, out}. */
function patch(
  before: Timeline,
  delta: Delta,
): Map<string, { track: string; in: number; out: number }> {
  const index = new Map<string, { track: string; in: number; out: number }>();
  for (const t of before.tracks ?? [])
    for (const c of t.clips ?? [])
      index.set(String(c.id), {
        track: t.id,
        in: Number(c.timeline_in) || 0,
        out: Number(c.timeline_out) || 0,
      });

  for (const id of delta.removed_ids ?? []) index.delete(id);

  for (const rule of delta.shifted ?? []) {
    for (const [, v] of index) {
      if (v.track === rule.track && v.in >= rule.from_frame) {
        v.in += rule.by;
        v.out += rule.by;
      }
    }
  }
  for (const c of delta.clips ?? [])
    index.set(String(c.id), {
      track: c.track,
      in: Number(c.timeline_in) || 0,
      out: Number(c.timeline_out) || 0,
    });
  return index;
}

function actual(tl: Timeline): Map<string, { track: string; in: number; out: number }> {
  const index = new Map<string, { track: string; in: number; out: number }>();
  for (const t of tl.tracks ?? [])
    for (const c of t.clips ?? [])
      index.set(String(c.id), {
        track: t.id,
        in: Number(c.timeline_in) || 0,
        out: Number(c.timeline_out) || 0,
      });
  return index;
}

const seed =
  (n: number, gap = 0) =>
  (t: Timeline) => {
    t.tracks.push({
      id: "v",
      kind: "video",
      z: 0,
      clips: Array.from({ length: n }, (_, i) => ({
        id: `c${i}`,
        media_ref: "m.mp4",
        timeline_in: i * (10 + gap),
        timeline_out: i * (10 + gap) + 10,
      })) as Clip[],
    });
  };

/** The seeded track; every test here builds exactly one. */
const firstTrack = (t: Timeline) => t.tracks[0]!;
const clipsOf = (t: Timeline) => firstTrack(t).clips!;

describe("mutation delta completeness", () => {
  it("an edit's delta reconstructs the timeline exactly (property, random edits)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 8 }),
        fc.integer({ min: 0, max: 7 }),
        fc.integer({ min: -20, max: 40 }),
        async (n, victim, shift) => {
          const s = new ProjectStoreAccess(DIR, new MemFs());
          doc = new ProjectDocument(asProjectId("proj"), {
            open: async () => "loaded",
            dispose: async () => {},
          });
          setOpenDocumentResolver((id) => (id === asProjectId("proj") ? doc : undefined));
          await ensureTimeline(s);
          await applyOp(s, "seed", seed(n));

          const before = await loadTimeline(s);
          const target = `c${victim % n}`;
          const receipt = (await applyOp(s, "move", (t) => {
            const c = clipsOf(t).find((x) => x.id === target);
            if (c) {
              c.timeline_in = Math.max(0, (Number(c.timeline_in) || 0) + shift);
              c.timeline_out = (Number(c.timeline_in) || 0) + 10;
            }
          })) as Delta & { ok: boolean };
          if (!receipt.ok || receipt.clips_note) return; // capped delta: completeness not claimed
          const after = await loadTimeline(s);
          expect(patch(before, receipt)).toEqual(actual(after));
          await endProjectSession(DIR);
        },
      ),
      { numRuns: 25 },
    );
  });

  it("UNDO's delta reconstructs the reverted timeline exactly", async () => {
    const s = new ProjectStoreAccess(DIR, new MemFs());
    await ensureTimeline(s);
    await applyOp(s, "seed", seed(5));
    await applyOp(s, "remove", (t) => void (firstTrack(t).clips = clipsOf(t).slice(0, 2)));

    const before = await loadTimeline(s);
    const receipt = (await doUndo(s)) as Delta & { ok: boolean };
    expect(receipt.ok).toBe(true);
    const after = await loadTimeline(s);
    expect(patch(before, receipt)).toEqual(actual(after)); // all 3 clips came back, correctly placed
  });

  it("REDO's delta reconstructs the re-applied timeline exactly", async () => {
    const s = new ProjectStoreAccess(DIR, new MemFs());
    await ensureTimeline(s);
    await applyOp(s, "seed", seed(5));
    await applyOp(s, "remove", (t) => void (firstTrack(t).clips = clipsOf(t).slice(0, 2)));
    await doUndo(s);

    const before = await loadTimeline(s);
    const receipt = (await doRedo(s)) as Delta & { ok: boolean };
    expect(receipt.ok).toBe(true);
    const after = await loadTimeline(s);
    expect(patch(before, receipt)).toEqual(actual(after));
  });

  it("a bulk slide is reported as SHIFT RULES, not one row per clip", async () => {
    // The delta has to stay small or "don't re-read" stops being affordable.
    const s = new ProjectStoreAccess(DIR, new MemFs());
    await ensureTimeline(s);
    await applyOp(s, "seed", seed(40));

    const before = await loadTimeline(s);
    const receipt = (await applyOp(s, "ripple", (t) => {
      for (const c of clipsOf(t)) {
        c.timeline_in = (Number(c.timeline_in) || 0) + 100;
        c.timeline_out = (Number(c.timeline_out) || 0) + 100;
      }
    })) as Delta & { ok: boolean };

    expect(receipt.shifted?.length).toBe(1);
    expect(receipt.shifted?.[0]).toMatchObject({ track: "v", by: 100, count: 40 });
    expect(receipt.clips ?? []).toHaveLength(0); // NOT 40 clip rows
    const after = await loadTimeline(s);
    expect(patch(before, receipt)).toEqual(actual(after)); // and it is still complete
  });

  it("undoing a bulk slide also collapses to rules", async () => {
    const s = new ProjectStoreAccess(DIR, new MemFs());
    await ensureTimeline(s);
    await applyOp(s, "seed", seed(40));
    await applyOp(s, "ripple", (t) => {
      for (const c of clipsOf(t)) {
        c.timeline_in = (Number(c.timeline_in) || 0) + 100;
        c.timeline_out = (Number(c.timeline_out) || 0) + 100;
      }
    });

    const before = await loadTimeline(s);
    const receipt = (await doUndo(s)) as Delta & { ok: boolean };
    expect(receipt.shifted?.[0]).toMatchObject({ track: "v", by: -100, count: 40 });
    const after = await loadTimeline(s);
    expect(patch(before, receipt)).toEqual(actual(after));
  });
});
