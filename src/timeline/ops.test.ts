import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ClientToolContext } from "../tools/context";
import { ProjectStoreAccess, joinPath, type FsLike } from "../tools/store";
import { registerTestDocument, resetTestDocuments } from "../test/timelineKit";
import { resetEditorContextSnapshot, setEditorContextSnapshot } from "../tools/editorContext";
import { applyOp, ensureTimeline, loadTimeline, replaceTimeline } from "./engine";
import {
  addTrackTool,
  getTimelineTool,
  redoTool,
  removeTracksTool,
  setCanvasTool,
  setTrackTool,
  setTracksTool,
  undoTool,
} from "./ops";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

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
const stubRunner = { run: async () => ({ code: 0, stdout: "", stderr: "" }) };
function makeStore(): ProjectStoreAccess {
  return new ProjectStoreAccess(DIR, new MemFs());
}
async function seeded(): Promise<{ ctx: ClientToolContext; store: ProjectStoreAccess }> {
  const store = makeStore();
  await ensureTimeline(store);
  return { ctx: { store, runner: stubRunner }, store };
}

// Run every op against an OPEN document for DIR (the real in-memory-session + gate path), and
// reset the injected resolver between tests.
beforeEach(() => registerTestDocument(DIR));
afterEach(resetTestDocuments);

describe("timeline ops", () => {
  it("every tool errors without a context", async () => {
    for (const tool of [
      getTimelineTool,
      setCanvasTool,
      addTrackTool,
      removeTracksTool,
      setTrackTool,
      undoTool,
      redoTool,
    ]) {
      expect((await tool({}, null)).ok).toBe(false);
    }
  });

  it("get_timeline returns the current timeline (and errors when missing)", async () => {
    const { ctx } = await seeded();
    const r = await getTimelineTool({}, ctx);
    expect(r.ok).toBe(true);
    expect((r.timeline as Any).canvas.fps).toBe(30);
    const empty: ClientToolContext = { store: makeStore(), runner: stubRunner };
    expect((await getTimelineTool({}, empty)).ok).toBe(false);
  });

  it("get_timeline surfaces the ambient editor context (playhead / selection / range)", async () => {
    const { ctx } = await seeded();
    resetEditorContextSnapshot();
    setEditorContextSnapshot({
      playheadFrame: 90,
      selectedClipIds: ["clip_x"],
      selectedRange: { startFrame: 30, endFrame: 90 },
      selectedGap: null,
    });
    try {
      const r = (await getTimelineTool({}, ctx)) as Any;
      expect(r.current_frame).toBe(90);
      expect(r.current_timecode).toBe("00:00:03:00");
      expect(r.selected_clip_ids).toEqual(["clip_x"]);
      expect(r.selected_range.startFrame).toBe(30);
      expect(r.selected_range.endFrame).toBe(90);
      expect(r.selected_range.semantics).toBe("startInclusiveEndExclusive");
      expect(r.selected_gap).toBeUndefined();
    } finally {
      resetEditorContextSnapshot();
    }
  });

  it("get_timeline reports a selected gap as the span it resolves to now", async () => {
    const { ctx, store } = await seeded();
    await replaceTimeline(store, {
      canvas: { width: 1920, height: 1080, fps: 30 },
      tracks: [
        {
          id: "v1",
          kind: "video",
          z: 0,
          clips: [
            { id: "a", media_ref: "m", kind: "video", timeline_in: 0, timeline_out: 30 },
            { id: "b", media_ref: "m", kind: "video", timeline_in: 60, timeline_out: 90 },
          ],
        },
      ],
    } as Any);
    resetEditorContextSnapshot();
    setEditorContextSnapshot({
      playheadFrame: null,
      selectedClipIds: [],
      selectedRange: null,
      // The store keeps the click as a POINT; the span is derived here.
      selectedGap: { trackId: "v1", atFrame: 45 },
    });
    try {
      const r = (await getTimelineTool({}, ctx)) as Any;
      expect(r.selected_gap.trackId).toBe("v1");
      expect(r.selected_gap.startFrame).toBe(30);
      expect(r.selected_gap.endFrame).toBe(60);
      expect(r.selected_gap.durationFrames).toBe(30);
    } finally {
      resetEditorContextSnapshot();
    }
  });

  it("get_timeline reports NO gap once the space has been filled", async () => {
    // The reason the selection is a point rather than a span: between the click and this read
    // the gap can be closed, and a remembered span would now name material. Reporting it would
    // invite the model to ripple over a clip.
    const { ctx, store } = await seeded();
    await replaceTimeline(store, {
      canvas: { width: 1920, height: 1080, fps: 30 },
      tracks: [
        {
          id: "v1",
          kind: "video",
          z: 0,
          clips: [{ id: "a", media_ref: "m", kind: "video", timeline_in: 0, timeline_out: 90 }],
        },
      ],
    } as Any);
    resetEditorContextSnapshot();
    setEditorContextSnapshot({
      playheadFrame: null,
      selectedClipIds: [],
      selectedRange: null,
      selectedGap: { trackId: "v1", atFrame: 45 },
    });
    try {
      expect(((await getTimelineTool({}, ctx)) as Any).selected_gap).toBeUndefined();
    } finally {
      resetEditorContextSnapshot();
    }
  });

  it("get_timeline omits default-valued fields but keeps the round-trip keys", async () => {
    const { ctx, store } = await seeded();
    await replaceTimeline(store, {
      canvas: { width: 1080, height: 1920, fps: 30 },
      tracks: [
        {
          id: "v1",
          kind: "video",
          z: 0,
          mute: false,
          hidden: false,
          sync_locked: true,
          clips: [
            {
              id: "c1",
              media_ref: "a.mp4",
              kind: "video",
              timeline_in: 0,
              timeline_out: 60,
              source_in: 0,
              source_out: 60,
              speed: 1,
              volume: 1,
              opacity: 1,
              transform: {},
              effects: [],
              link_group: "lg1",
            },
            {
              id: "c2",
              media_ref: "b.mp4",
              kind: "video",
              timeline_in: 60,
              timeline_out: 120,
              source_in: 0,
              source_out: 60,
              volume: 0.5,
              opacity: 0.8,
            },
          ],
        },
      ],
    } as Any);
    const r = (await getTimelineTool({}, ctx)) as Any;
    expect(r.window).toBeUndefined();
    const t = r.timeline.tracks[0];
    expect(t.mute).toBeUndefined(); // false -> stripped
    expect(t.hidden).toBeUndefined();
    expect(t.sync_locked).toBeUndefined(); // default (locked) -> stripped
    const c1 = t.clips[0];
    expect(c1.speed).toBeUndefined();
    expect(c1.volume).toBeUndefined();
    expect(c1.opacity).toBeUndefined();
    expect(c1.transform).toBeUndefined(); // empty object -> stripped
    expect(c1.effects).toBeUndefined(); // empty array -> stripped
    // keys the edit tools accept survive the compaction
    expect([c1.id, c1.media_ref, c1.link_group]).toEqual(["c1", "a.mp4", "lg1"]);
    expect([c1.timeline_in, c1.timeline_out, c1.source_in, c1.source_out]).toEqual([0, 60, 0, 60]);
    // non-default values are kept
    expect([t.clips[1].volume, t.clips[1].opacity]).toEqual([0.5, 0.8]);
  });

  it("get_timeline windows clips to [start_frame, end_frame) and reports total_clips", async () => {
    const { ctx, store } = await seeded();
    await replaceTimeline(store, {
      canvas: { width: 1080, height: 1920, fps: 30 },
      tracks: [
        {
          id: "v1",
          kind: "video",
          z: 0,
          clips: [
            { id: "a", media_ref: "a.mp4", kind: "video", timeline_in: 0, timeline_out: 50 },
            { id: "b", media_ref: "b.mp4", kind: "video", timeline_in: 100, timeline_out: 150 },
            { id: "c", media_ref: "c.mp4", kind: "video", timeline_in: 200, timeline_out: 250 },
          ],
        },
      ],
    } as Any);
    const r = (await getTimelineTool({ start_frame: 90, end_frame: 160 }, ctx)) as Any;
    expect(r.window).toEqual([90, 160]);
    const t = r.timeline.tracks[0];
    expect(t.clips.map((c: Any) => c.id)).toEqual(["b"]); // only b overlaps [90,160)
    expect(t.total_clips).toBe(3);
  });

  it("get_timeline: only start_frame windows to the timeline end; an inverted window errors", async () => {
    const { ctx, store } = await seeded();
    await replaceTimeline(store, {
      canvas: { width: 1080, height: 1920, fps: 30 },
      tracks: [
        {
          id: "v1",
          kind: "video",
          z: 0,
          clips: [
            { id: "a", media_ref: "a.mp4", kind: "video", timeline_in: 0, timeline_out: 50 },
            { id: "b", media_ref: "b.mp4", kind: "video", timeline_in: 100, timeline_out: 150 },
          ],
        },
      ],
    } as Any);
    const r = (await getTimelineTool({ start_frame: 60 }, ctx)) as Any;
    expect(r.window).toEqual([60, 150]); // end defaults to the timeline end
    expect(r.timeline.tracks[0].clips.map((c: Any) => c.id)).toEqual(["b"]);
    expect(((await getTimelineTool({ start_frame: 100, end_frame: 50 }, ctx)) as Any).ok).toBe(
      false,
    );
  });

  it("get_timeline: start_frame on an EMPTY timeline reads it all, it does not error", async () => {
    // A strict-schema model must send every key, so a fresh project gets
    // {start_frame: 0, end_frame: null} -> a DERIVED end of 0. Erroring there blamed
    // the model for the project being empty and cost it a round on its first call.
    const { ctx, store } = await seeded();
    await replaceTimeline(store, {
      canvas: { width: 1080, height: 1920, fps: 30 },
      tracks: [{ id: "v1", kind: "video", z: 0, clips: [] }],
    } as Any);
    const r = (await getTimelineTool({ start_frame: 0, end_frame: null }, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.window).toBeUndefined(); // no window applied, the whole timeline came back
    // An end the CALLER actually supplied is still rejected.
    expect(((await getTimelineTool({ start_frame: 5, end_frame: 5 }, ctx)) as Any).ok).toBe(false);
  });

  it("add_track / set_track / remove_tracks round-trip", async () => {
    const { ctx, store } = await seeded();
    const add = await addTrackTool({ kind: "video" }, ctx);
    expect(add.ok).toBe(true);
    const id = add.track_id as string;
    expect(id).toMatch(/^track_/);
    expect(
      (
        await setTrackTool(
          { track_id: id, mute: true, hidden: true, sync_locked: false, z: 5 },
          ctx,
        )
      ).ok,
    ).toBe(true);
    const tl = await loadTimeline(store);
    expect(tl.tracks[0].mute).toBe(true);
    expect(tl.tracks[0].hidden).toBe(true);
    expect(tl.tracks[0].sync_locked).toBe(false);
    expect(tl.tracks[0].z).toBe(5);
    expect((await removeTracksTool({ track_ids: [id] }, ctx)).ok).toBe(true);
    expect((await loadTimeline(store)).tracks.length).toBe(0);
  });

  it("add_track rejects a bad kind and a duplicate id", async () => {
    const { ctx } = await seeded();
    expect((await addTrackTool({ kind: "nope" }, ctx)).ok).toBe(false);
    await addTrackTool({ id: "v", kind: "video" }, ctx);
    expect((await addTrackTool({ id: "v", kind: "video" }, ctx)).ok).toBe(false);
  });

  it("auto-increments track z", async () => {
    const { ctx, store } = await seeded();
    await addTrackTool({ kind: "video" }, ctx);
    await addTrackTool({ kind: "video" }, ctx);
    expect((await loadTimeline(store)).tracks.map((t) => t.z)).toEqual([0, 1]);
  });

  it("set_track and remove_tracks report bad targets", async () => {
    const { ctx } = await seeded();
    expect((await setTrackTool({ track_id: "nope" }, ctx)).ok).toBe(false);
    expect((await removeTracksTool({ track_ids: ["nope"] }, ctx)).ok).toBe(false);
    expect((await removeTracksTool({ track_ids: "x" as Any }, ctx)).ok).toBe(false);
  });

  describe("set_tracks (plural)", () => {
    // A restack touches every track it passes. Issuing one set_track each cost one undo
    // entry PER TRACK, so a single drag took N presses of Ctrl+Z to put back.
    it("restacks several tracks in ONE op", async () => {
      const { ctx, store } = await seeded();
      await addTrackTool({ id: "a", kind: "video" }, ctx);
      await addTrackTool({ id: "b", kind: "video" }, ctx);
      await addTrackTool({ id: "c", kind: "video" }, ctx);
      const r = await setTracksTool(
        {
          tracks: [
            { track_id: "a", z: 2 },
            { track_id: "b", z: 0 },
            { track_id: "c", z: 1 },
          ],
        },
        ctx,
      );
      expect(r.ok).toBe(true);
      const byId = Object.fromEntries((await loadTimeline(store)).tracks.map((t) => [t.id, t.z]));
      expect(byId).toEqual({ a: 2, b: 0, c: 1 });
    });

    it("is ATOMIC: one bad id leaves every other track untouched", async () => {
      // The failure direction. A per-track loop would have already written the good ones.
      const { ctx, store } = await seeded();
      await addTrackTool({ id: "a", kind: "video" }, ctx);
      await addTrackTool({ id: "b", kind: "video" }, ctx);
      const before = (await loadTimeline(store)).tracks.map((t) => t.z);
      const r = await setTracksTool(
        {
          tracks: [
            { track_id: "a", z: 9 },
            { track_id: "nope", z: 1 },
          ],
        },
        ctx,
      );
      expect(r.ok).toBe(false);
      expect((await loadTimeline(store)).tracks.map((t) => t.z)).toEqual(before);
    });

    it("rejects a non-list and needs no context", async () => {
      const { ctx } = await seeded();
      expect((await setTracksTool({ tracks: "x" as Any }, ctx)).ok).toBe(false);
      expect((await setTracksTool({ tracks: [] }, null)).ok).toBe(false);
    });
  });

  it("the canvas op rebases every clip frame by the fps ratio (doubles on 30→60)", async () => {
    const { ctx, store } = await seeded(); // canvas fps 30
    await addTrackTool({ id: "v", kind: "video" }, ctx);
    await applyOp(store, "seed", (t) => {
      t.tracks[0].clips!.push({
        media_ref: "a.mp4",
        source_in: 10,
        source_out: 40,
        timeline_in: 0,
        timeline_out: 30,
        opacity: [
          { t: 0, v: 0 },
          { t: 30, v: 1 },
        ],
        fade: { in: 6, out: 6 },
      });
    });
    const r = await setCanvasTool({ fps: 60 }, ctx);
    expect(r.ok).toBe(true);
    const tl = await loadTimeline(store);
    expect(tl.canvas.fps).toBe(60);
    const c = tl.tracks[0].clips![0];
    expect([c.timeline_in, c.timeline_out]).toEqual([0, 60]); // spans doubled
    expect(c.source_in).toBe(20); // 10 × 2
    expect(c.source_out).toBe(80); // derived: 20 + (60-0)×speed
    expect((c.opacity as Any).map((k: Any) => k.t)).toEqual([0, 60]); // keyframe times doubled
    expect(c.fade).toEqual({ in: 12, out: 12 }); // fades doubled (and survive the frame-span clamp)
  });

  it("rebases an inbound transition's duration by the fps ratio", async () => {
    const { ctx, store } = await seeded(); // fps 30
    await addTrackTool({ id: "v", kind: "video" }, ctx);
    await applyOp(store, "seed", (t) => {
      t.tracks[0].clips!.push(
        { media_ref: "a.mp4", source_in: 0, source_out: 30, timeline_in: 0, timeline_out: 30 },
        {
          media_ref: "b.mp4",
          source_in: 0,
          source_out: 30,
          timeline_in: 30,
          timeline_out: 60,
          transition_in: { kind: "fade", duration: 5 },
        },
      );
    });
    const r = await setCanvasTool({ fps: 60 }, ctx);
    expect(r.ok).toBe(true);
    const clips = (await loadTimeline(store)).tracks[0].clips!;
    expect(clips[1].transition_in!.duration).toBe(10); // 5 × 2
  });

  it("pushes later same-track clips right so fps-rounding can't overlap them", async () => {
    const { ctx, store } = await seeded(); // fps 30
    await addTrackTool({ id: "v", kind: "video" }, ctx);
    await applyOp(store, "seed", (t) => {
      // three abutting 1-frame clips; ×1.5 rounds each length up to 2, so the
      // naive scaled starts (0, 2, 3) would collide — clip 3 must slide to 4.
      for (let i = 0; i < 3; i++)
        t.tracks[0].clips!.push({
          media_ref: "a.mp4",
          source_in: i,
          source_out: i + 1,
          timeline_in: i,
          timeline_out: i + 1,
        });
    });
    const r = await setCanvasTool({ fps: 45 }, ctx); // scale 1.5
    expect(r.ok).toBe(true);
    const clips = (await loadTimeline(store)).tracks[0].clips!;
    for (let i = 1; i < clips.length; i++)
      expect(clips[i].timeline_in).toBeGreaterThanOrEqual(clips[i - 1].timeline_out); // no overlap
    expect(clips.map((c) => [c.timeline_in, c.timeline_out])).toEqual([
      [0, 2],
      [2, 4],
      [4, 6],
    ]);
  });

  it("undo restores the exact pre-change frames after an fps rebase", async () => {
    const { ctx, store } = await seeded(); // fps 30
    await addTrackTool({ id: "v", kind: "video" }, ctx);
    await applyOp(store, "seed", (t) => {
      t.tracks[0].clips!.push({
        media_ref: "a.mp4",
        source_in: 7,
        source_out: 30,
        timeline_in: 3,
        timeline_out: 26,
        opacity: [
          { t: 0, v: 0 },
          { t: 23, v: 1 },
        ],
      });
    });
    const before = await loadTimeline(store);
    const r = await setCanvasTool({ fps: 45 }, ctx); // 1.5× → rounding on odd frames
    expect(r.ok).toBe(true);
    expect((await undoTool({}, ctx)).ok).toBe(true);
    expect(await loadTimeline(store)).toEqual(before); // exact restore, no rounding drift
  });

  it("a no-op fps + a dims change leaves every clip frame untouched", async () => {
    const { ctx, store } = await seeded(); // canvas fps 30
    await addTrackTool({ id: "v", kind: "video" }, ctx);
    await applyOp(store, "seed", (t) => {
      t.tracks[0].clips!.push({
        media_ref: "a.mp4",
        source_in: 0,
        source_out: 30,
        timeline_in: 0,
        timeline_out: 30,
      });
    });
    // fps set to the CURRENT value is a no-op (no rebase); dims never rebase clips.
    const r = await setCanvasTool({ width: 1280, height: 720, fps: 30 }, ctx);
    expect(r.ok).toBe(true);
    const tl = await loadTimeline(store);
    expect([tl.canvas.width, tl.canvas.height, tl.canvas.fps]).toEqual([1280, 720, 30]);
    const c = tl.tracks[0].clips![0];
    expect([c.timeline_in, c.timeline_out]).toEqual([0, 30]);
  });

  it("rejects a non-positive fps", async () => {
    const { ctx } = await seeded();
    const r = await setCanvasTool({ fps: 0 }, ctx);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("fps");
  });

  it("undo / redo via the tools", async () => {
    const { ctx, store } = await seeded();
    await addTrackTool({ id: "v", kind: "video" }, ctx);
    expect((await undoTool({}, ctx)).ok).toBe(true);
    expect((await loadTimeline(store)).tracks.length).toBe(0);
    expect((await redoTool({}, ctx)).ok).toBe(true);
    expect((await loadTimeline(store)).tracks.length).toBe(1);
  });
});
