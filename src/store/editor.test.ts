import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import { _resetTimelineBus, emitTimelineChange } from "../timeline/bus";
import { applyOp } from "../timeline/engine";
import { findClip } from "../timeline/helpers";
import { emptyTimeline, type Timeline } from "../timeline/model";
import { addClipsTool, clearHasAudioCache } from "../timeline/placement";
import {
  audioRunner,
  makeRunner,
  registerTestDocument,
  resetTestDocuments,
  seededCtx,
} from "../test/timelineKit";
import { type FsLike, ProjectStoreAccess } from "../tools/store";
import {
  _zoomBounds,
  activateEditorProject,
  createProjectStore,
  deactivateEditorProject,
  disposeEditorStore,
  getEditorStore,
  setProjectStoreFactory,
  setRunnerFactory,
  useEditor,
} from "./editor";

vi.mock("../tools/dataRoot", () => ({
  boundProjectId: () => "",
  projectsRoot: vi.fn(async () => "/root/projects"),
  projectDirFor: vi.fn(async (id: string) => `/root/projects/${id}`),
}));

// Mock stores must live at joinPath(projectsRoot(), projectId) so the editor's
// bus subscription (which filters writes by that dir) accepts their updates.
const P1 = "/root/projects/p1";
const P2 = "/root/projects/p2";

class MemFs implements FsLike {
  files = new Map<string, string>();
  async exists(p: string) {
    return this.files.has(p);
  }
  async readTextFile(p: string) {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  }
  async writeTextFile(p: string, c: string) {
    this.files.set(p, c);
  }
  async mkdir() {}
}

function seedStore(dir = P1, timeline: Timeline = emptyTimeline()) {
  const fs = new MemFs();
  fs.files.set(`${dir}/internals/timeline.json`, JSON.stringify(timeline));
  registerTestDocument(dir); // back the store with an open document so applyOp/undo commit through it
  return { store: new ProjectStoreAccess(dir, fs), fs };
}

/** A timeline with something on it, so "has content" is not the same as "has tracks". */
function withClip(timelineOut = 120): Timeline {
  const tl = emptyTimeline();
  tl.tracks = [
    {
      id: "v1",
      kind: "video",
      z: 0,
      clips: [
        {
          id: "clip_1",
          media_ref: "media_1",
          kind: "video",
          timeline_in: 0,
          timeline_out: timelineOut,
          source_in: 0,
          source_out: timelineOut,
        },
      ],
    },
  ];
  return tl;
}

beforeEach(() => {
  _resetTimelineBus();
  clearHasAudioCache();
});

afterEach(async () => {
  useEditor.getState().dispose();
  await resetTestDocuments();
});

describe("editor store", () => {
  it("loads the project's timeline via the fs-backed store", async () => {
    const { store } = seedStore();
    setProjectStoreFactory(() => store);
    await useEditor.getState().load("p1");
    const s = useEditor.getState();
    expect(s.projectId).toBe("p1");
    expect(s.store).toBe(store);
    expect(s.timeline?.canvas).toBeTruthy();
    expect(s.loading).toBe(false);
  });

  it("seeds starter tracks when timeline.json is missing", async () => {
    setProjectStoreFactory(() => new ProjectStoreAccess("/proj", new MemFs()));
    await useEditor.getState().load("p1");
    expect(useEditor.getState().timeline?.tracks.map((t) => t.id)).toEqual(["v1", "a1"]);
    expect(useEditor.getState().loading).toBe(false);
  });

  it("seeds starter tracks when the timeline has none", async () => {
    const { store } = seedStore(); // emptyTimeline -> tracks: []
    setProjectStoreFactory(() => store);
    await useEditor.getState().load("p1");
    const tl = useEditor.getState().timeline;
    expect(tl?.tracks.map((t) => [t.id, t.kind])).toEqual([
      ["v1", "video"],
      ["a1", "audio"],
    ]);
  });

  it("keeps existing tracks (does not re-seed) when the timeline already has some", async () => {
    const tl = {
      ...emptyTimeline(),
      tracks: [{ id: "vX", kind: "video", z: 0, clips: [] }],
    } as Timeline;
    const { store } = seedStore(P1, tl);
    setProjectStoreFactory(() => store);
    await useEditor.getState().load("p1");
    expect(useEditor.getState().timeline?.tracks.map((t) => t.id)).toEqual(["vX"]);
  });

  it("live-updates the timeline when any write emits on the bus (AI or manual)", async () => {
    const { store } = seedStore();
    setProjectStoreFactory(() => store);
    await useEditor.getState().load("p1");
    const r = await applyOp(store, "widen", (tl) => {
      tl.canvas.width = 1234;
    });
    expect(r.ok).toBe(true);
    expect(useEditor.getState().timeline?.canvas.width).toBe(1234);
  });

  it("defers bus updates during a gesture and applies them on endGesture", async () => {
    const { store } = seedStore();
    setProjectStoreFactory(() => store);
    await useEditor.getState().load("p1");
    useEditor.getState().beginGesture();
    await applyOp(store, "widen", (tl) => {
      tl.canvas.width = 777;
    });
    expect(useEditor.getState().timeline?.canvas.width).not.toBe(777);
    useEditor.getState().endGesture();
    expect(useEditor.getState().timeline?.canvas.width).toBe(777);
  });

  it("undo and redo move through the shared history and refresh via the bus", async () => {
    const { store } = seedStore();
    setProjectStoreFactory(() => store);
    await useEditor.getState().load("p1");
    await applyOp(store, "widen", (tl) => {
      tl.canvas.width = 999;
    });
    expect(useEditor.getState().timeline?.canvas.width).toBe(999);
    await useEditor.getState().undo();
    expect(useEditor.getState().timeline?.canvas.width).not.toBe(999);
    await useEditor.getState().redo();
    expect(useEditor.getState().timeline?.canvas.width).toBe(999);
  });

  it("select / setPlayhead / setZoom update and clamp view state", () => {
    const st = useEditor.getState();
    st.select("clip_9");
    expect(useEditor.getState().selection).toBe("clip_9");
    st.setPlayhead(-5);
    expect(useEditor.getState().playhead).toBe(0);
    st.setPlayhead(3.5);
    expect(useEditor.getState().playhead).toBe(3.5);
    st.setZoom(1); // below MIN -> clamps to 4
    expect(useEditor.getState().zoom).toBe(4);
    st.setZoom(10_000); // above MAX -> clamps to 400
    expect(useEditor.getState().zoom).toBe(400);
  });

  it("ignores writes to a different project's timeline", async () => {
    const { store: s1 } = seedStore(P1);
    const { store: s2 } = seedStore(P2);
    setProjectStoreFactory((dir) => (dir.endsWith("/p1") ? s1 : s2));
    await useEditor.getState().load("p1");
    await useEditor.getState().load("p2");
    await applyOp(s1, "widen", (tl) => {
      tl.canvas.width = 4242;
    });
    expect(useEditor.getState().timeline?.canvas.width).not.toBe(4242);
  });

  // A tab addresses media through THIS project's store, so one carried across a switch would
  // render project A's clip against project B's library -- a broken tab, or worse, a hit on a
  // ref that happens to exist in both.
  it("carries no preview tab across a project switch", async () => {
    const { store: s1 } = seedStore(P1);
    const { store: s2 } = seedStore(P2);
    setProjectStoreFactory((dir) => (dir.endsWith("/p1") ? s1 : s2));
    await useEditor.getState().load("p1");
    useEditor.getState().openMediaTab("a.mp4", { pin: true });
    expect(useEditor.getState().activeMediaTab).toBe("a.mp4");
    await useEditor.getState().load("p2");
    expect(useEditor.getState().mediaTabs).toEqual([]);
    expect(useEditor.getState().activeMediaTab).toBeNull();
  });

  // An empty project composites to nothing, so people open a library clip just to see something
  // — and then the first edit lands BEHIND that tab. One user watched his source footage while
  // the agent built a 9:16 short, reported "the timeline does not show the final video", and
  // exported a file that had been correct the whole time.
  it("reveals the timeline the moment it gains its first clips", async () => {
    const { store } = seedStore(P1);
    setProjectStoreFactory(() => store);
    await useEditor.getState().load("p1");
    useEditor.getState().openMediaTab("a.mp4", { pin: true });
    expect(useEditor.getState().activeMediaTab).toBe("a.mp4");

    emitTimelineChange(withClip(), "engine", P1);

    expect(useEditor.getState().activeMediaTab).toBeNull();
  });

  // ...but only the FIRST time. Yanking the view on every subsequent edit would fight anyone
  // using the source monitor to pick the next in/out point.
  it("leaves the source monitor alone once the timeline already has clips", async () => {
    const { store } = seedStore(P1, withClip());
    setProjectStoreFactory(() => store);
    await useEditor.getState().load("p1");
    useEditor.getState().openMediaTab("a.mp4", { pin: true });

    emitTimelineChange(withClip(240), "engine", P1);

    expect(useEditor.getState().activeMediaTab).toBe("a.mp4");
  });

  it("does not reveal a timeline that is still empty", async () => {
    const { store } = seedStore(P1);
    setProjectStoreFactory(() => store);
    await useEditor.getState().load("p1");
    useEditor.getState().openMediaTab("a.mp4", { pin: true });

    emitTimelineChange(emptyTimeline(), "engine", P1);

    expect(useEditor.getState().activeMediaTab).toBe("a.mp4");
  });
  it("a superseded load does NOT clobber the winning project's store (F5)", async () => {
    const { store: s1 } = seedStore(P1);
    const { store: s2 } = seedStore(P2);
    // p1's store build hangs; p2's resolves immediately -> p2 must win the race.
    let resolveS1!: (s: ProjectStoreAccess) => void;
    const s1Deferred = new Promise<ProjectStoreAccess>((r) => (resolveS1 = r));
    setProjectStoreFactory((dir) => (dir.endsWith("/p1") ? s1Deferred : s2));

    const loadingA = useEditor.getState().load("p1"); // suspends building p1's store
    await useEditor.getState().load("p2"); // p2 takes over (projectId = "p2", store = s2)
    expect(useEditor.getState().projectId).toBe("p2");
    expect(useEditor.getState().store).toBe(s2);

    resolveS1(s1); // p1's slow build finishes LATE, after p2 already won
    await loadingA;

    // The stale p1 load tore itself down instead of committing s1 over p2's s2.
    expect(useEditor.getState().projectId).toBe("p2");
    expect(useEditor.getState().store).toBe(s2);
  });

  it("a same-id re-activation supersedes the earlier one (A->B->A) so a late stale load bails (R6-3)", async () => {
    const { store: a1 } = seedStore(P1);
    const { store: a2 } = seedStore(P1);
    // The FIRST load of p1 hangs building its store; a later load of the SAME id
    // resolves now. A bare projectId check couldn't tell the two apart -> the stale
    // first load would clobber the second. The generation counter distinguishes them.
    let resolveA1!: (s: ProjectStoreAccess) => void;
    const a1Deferred = new Promise<ProjectStoreAccess>((r) => (resolveA1 = r));
    let call = 0;
    setProjectStoreFactory(() => (++call === 1 ? a1Deferred : a2));

    const first = useEditor.getState().load("p1"); // A1: suspends on the store build
    const second = await useEditor.getState().load("p1"); // A2: same id, resolves + commits
    expect(second).toBe("loaded");
    expect(useEditor.getState().store).toBe(a2);

    resolveA1(a1); // A1 finishes LATE, after A2 already won
    expect(await first).toBe("superseded"); // caught by the generation, not the id
    expect(useEditor.getState().store).toBe(a2); // A1 did NOT clobber A2
  });

  it("fails the load on a malformed existing timeline instead of revealing an empty workspace (R6-4)", async () => {
    const fs = new MemFs();
    // Valid JSON but NOT a timeline: ensureStarterTimeline refuses to overwrite it.
    fs.files.set(`${P1}/internals/timeline.json`, JSON.stringify(123));
    setProjectStoreFactory(() => new ProjectStoreAccess(P1, fs));
    const outcome = await useEditor.getState().load("p1");
    expect(outcome).toBe("failed"); // was silently "loaded" with a null timeline
    expect(useEditor.getState().error).toBeTruthy();
    expect(useEditor.getState().timeline).toBeNull();
  });

  it("dispose() retires an in-flight load so it can't reinstall after teardown (R7-2)", async () => {
    const { store: s1 } = seedStore(P1);
    let resolveStore!: (s: ProjectStoreAccess) => void;
    setProjectStoreFactory(() => new Promise<ProjectStoreAccess>((r) => (resolveStore = r)));
    const loading = useEditor.getState().load("p1"); // suspends building the store
    await new Promise((r) => setTimeout(r, 0)); // let load reach makeProjectStore (assigns resolveStore)
    useEditor.getState().dispose(); // user navigates away -> teardown bumps the generation
    resolveStore(s1); // the slow store build finishes AFTER dispose
    expect(await loading).toBe("superseded");
    expect(useEditor.getState().store).toBeNull(); // did NOT reinstall over the disposed state
    expect(useEditor.getState().projectId).toBeNull();
  });

  it("undo/redo/reload are no-ops without a store", async () => {
    await useEditor.getState().undo();
    await useEditor.getState().redo();
    await useEditor.getState().reload();
    expect(useEditor.getState().error).toBeNull();
  });

  it("reload re-reads the timeline from disk", async () => {
    const { store, fs } = seedStore();
    setProjectStoreFactory(() => store);
    await useEditor.getState().load("p1");
    fs.files.set(
      `${P1}/internals/timeline.json`,
      JSON.stringify({ ...emptyTimeline(), canvas: { width: 55, height: 66, fps: 24 } }),
    );
    await useEditor.getState().reload();
    expect(useEditor.getState().timeline?.canvas.width).toBe(55);
  });

  it("surfaces a load error", async () => {
    setProjectStoreFactory(() => {
      throw new Error("nope");
    });
    await useEditor.getState().load("p1");
    expect(useEditor.getState().error).toContain("nope");
    expect(useEditor.getState().loading).toBe(false);
  });
});

describe("editor store — clip edits", () => {
  async function loaded(entries: Array<Record<string, unknown>>) {
    const { ctx, store } = await seededCtx(audioRunner, P1);
    const r = (await addClipsTool({ entries }, ctx)) as {
      created: Array<{ clip_id: string; kind: string }>;
    };
    setProjectStoreFactory(() => store);
    await useEditor.getState().load("p1");
    return {
      store,
      videos: r.created.filter((c) => c.kind === "video").map((c) => ({ id: c.clip_id as string })),
    };
  }

  it("moveClip repositions the clip through the shared op + bus", async () => {
    const { videos } = await loaded([{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }]);
    await useEditor.getState().moveClip(videos[0].id, { toTimelineIn: 30 });
    const c = findClip(useEditor.getState().timeline!, videos[0].id)![1];
    expect([c.timeline_in, c.timeline_out]).toEqual([30, 90]);
  });

  it("moveClip with duplicate:true LEAVES the original and adds a copy at the target", async () => {
    // Alt+drag. If this ever silently degraded to a move, the user would lose the clip they
    // were copying FROM — which is why the original's span is asserted, not just the count.
    const { videos } = await loaded([{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }]);
    await useEditor.getState().moveClip(videos[0].id, { toTimelineIn: 120, duplicate: true });
    const tl = useEditor.getState().timeline!;
    const orig = findClip(tl, videos[0].id)![1];
    expect([orig.timeline_in, orig.timeline_out]).toEqual([0, 60]);
    const video = tl.tracks.find((t) => t.kind === "video")!;
    const copy = (video.clips ?? []).find((c) => c.id !== videos[0].id);
    expect(copy && [copy.timeline_in, copy.timeline_out]).toEqual([120, 180]);
  });

  it("moveClip with ignoreLinks:true leaves the linked partner behind", async () => {
    const { videos } = await loaded([{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }]);
    const tl0 = useEditor.getState().timeline!;
    const audio = tl0.tracks.find((t) => t.kind === "audio")!;
    const partner = (audio.clips ?? [])[0];
    if (!partner) return; // the fixture has no linked half; the link case is covered in the sweep
    await useEditor.getState().moveClip(videos[0].id, { toTimelineIn: 30, ignoreLinks: true });
    const after = findClip(useEditor.getState().timeline!, String(partner.id))![1];
    expect(after.timeline_in).toBe(partner.timeline_in);
    // ...while the clip the user actually dragged DID move.
    expect(findClip(useEditor.getState().timeline!, videos[0].id)![1].timeline_in).toBe(30);
  });

  it("trimClip changes the clip boundary", async () => {
    const { videos } = await loaded([{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }]);
    await useEditor.getState().trimClip(videos[0].id, { timeline_out: 40, source_out: 40 });
    expect(findClip(useEditor.getState().timeline!, videos[0].id)![1].timeline_out).toBe(40);
  });

  it("splitClip cuts the clip in two", async () => {
    const { videos } = await loaded([{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }]);
    await useEditor.getState().splitClip(videos[0].id, 30);
    const videoTrack = useEditor.getState().timeline!.tracks.find((t) => t.kind === "video")!;
    expect(videoTrack.clips!.length).toBe(2);
  });

  it("linkClips groups two clips into one link_group and unlinkClips dissolves it", async () => {
    const { ctx, store } = await seededCtx(makeRunner(), P1);
    const r1 = (await addClipsTool(
      { entries: [{ media_ref: "a.png", timeline_in: 0, timeline_out: 30, track_id: "v1" }] },
      ctx,
    )) as { created: Array<{ clip_id: string }> };
    const r2 = (await addClipsTool(
      { entries: [{ media_ref: "b.png", timeline_in: 0, timeline_out: 30, track_id: "v2" }] },
      ctx,
    )) as { created: Array<{ clip_id: string }> };
    const id1 = r1.created[0].clip_id;
    const id2 = r2.created[0].clip_id;
    setProjectStoreFactory(() => store);
    await useEditor.getState().load("p1");
    await useEditor.getState().linkClips([id1, id2]);
    const g = findClip(useEditor.getState().timeline!, id1)![1].link_group;
    expect(g).toBeTruthy();
    expect(findClip(useEditor.getState().timeline!, id2)![1].link_group).toBe(g);
    await useEditor.getState().unlinkClips([id1]);
    expect(findClip(useEditor.getState().timeline!, id1)![1].link_group).toBeUndefined();
    expect(findClip(useEditor.getState().timeline!, id2)![1].link_group).toBeUndefined();
  });

  it("deleteClips removes the clip (lift)", async () => {
    const { videos } = await loaded([{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }]);
    await useEditor.getState().deleteClips([videos[0].id]);
    expect(findClip(useEditor.getState().timeline!, videos[0].id)).toBeNull();
  });

  it("rippleDeleteClip removes the clip and pulls later clips left", async () => {
    const { videos } = await loaded([
      { media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 },
      { media_ref: "b.mp4", timeline_in: 60, timeline_out: 120 },
    ]);
    await useEditor.getState().rippleDeleteClip(videos[0].id);
    const s = useEditor.getState().timeline!;
    expect(findClip(s, videos[0].id)).toBeNull();
    expect(findClip(s, videos[1].id)![1].timeline_in).toBe(0);
  });

  it("duplicateClip clones the selected clip right after it and selects the copy", async () => {
    const { videos } = await loaded([{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }]);
    await useEditor.getState().duplicateClip(videos[0].id);
    const sel = useEditor.getState().selection;
    expect(sel).toBeTruthy();
    expect(sel).not.toBe(videos[0].id);
    const copy = findClip(useEditor.getState().timeline!, sel!)![1];
    expect([copy.timeline_in, copy.timeline_out]).toEqual([60, 120]);
  });

  it("copyClip + pasteClip clones the copied clip at the playhead", async () => {
    const { videos } = await loaded([{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }]);
    useEditor.getState().copyClip(videos[0].id);
    expect(useEditor.getState().clipboard).toBeTruthy();
    useEditor.getState().setPlayhead(4); // 4s @30fps -> frame 120
    await useEditor.getState().pasteClip();
    const sel = useEditor.getState().selection;
    expect(sel).toBeTruthy();
    const copy = findClip(useEditor.getState().timeline!, sel!)![1];
    expect([copy.timeline_in, copy.timeline_out]).toEqual([120, 180]);
  });

  it("setTransition sets the transition_in field without moving the clip (duration-only model)", async () => {
    const { videos } = await loaded([
      { media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 },
      { media_ref: "b.mp4", timeline_in: 60, timeline_out: 120 },
    ]);
    await useEditor.getState().setTransition(videos[1].id, { kind: "crossfade", duration: 15 });
    const b = findClip(useEditor.getState().timeline!, videos[1].id)![1];
    expect([b.timeline_in, b.timeline_out]).toEqual([60, 120]);
    expect(b.transition_in).toEqual({ kind: "crossfade", duration: 15 });
  });

  it("setClipProperties writes properties to the clip", async () => {
    const { videos } = await loaded([{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }]);
    await useEditor.getState().setClipProperties(videos[0].id, { opacity: 0.5, rotate: 90 });
    const c = findClip(useEditor.getState().timeline!, videos[0].id)![1];
    expect([c.opacity, c.rotate]).toEqual([0.5, 90]);
  });

  it("setCanvas updates the canvas settings", async () => {
    const { store } = await seededCtx(undefined, P1);
    setProjectStoreFactory(() => store);
    await useEditor.getState().load("p1");
    await useEditor.getState().setCanvas({ width: 720, height: 1280 });
    expect([
      useEditor.getState().timeline!.canvas.width,
      useEditor.getState().timeline!.canvas.height,
    ]).toEqual([720, 1280]);
  });

  it("addClip probes duration and adds a clip at the drop frame", async () => {
    const { store } = await seededCtx(undefined, P1);
    setProjectStoreFactory(() => store);
    setRunnerFactory(() =>
      makeRunner((_p, a) => {
        if (a.includes("format=duration")) return { code: 0, stdout: "2.0", stderr: "" }; // 2s -> 60f
        if (a.includes("-select_streams")) return { code: 0, stdout: "1", stderr: "" }; // has audio
        return { code: 0, stdout: "", stderr: "" };
      }),
    );
    await useEditor.getState().load("p1");
    await useEditor.getState().addClip("a.mp4", undefined, 30);
    const tl = useEditor.getState().timeline!;
    const vids = tl.tracks.flatMap((t) => (t.kind === "video" ? (t.clips ?? []) : []));
    expect(vids).toHaveLength(1);
    expect([vids[0].timeline_in, vids[0].timeline_out]).toEqual([30, 90]);
  });

  it("addTrack appends a new track of the given kind", async () => {
    const { store } = await seededCtx(undefined, P1);
    setProjectStoreFactory(() => store);
    await useEditor.getState().load("p1");
    const before = useEditor.getState().timeline!.tracks.length;
    await useEditor.getState().addTrack("audio");
    const tracks = useEditor.getState().timeline!.tracks;
    expect(tracks.length).toBe(before + 1);
    expect(tracks[tracks.length - 1].kind).toBe("audio");
  });

  it("setTrack toggles hidden on the track", async () => {
    const { store } = await seededCtx(undefined, P1);
    setProjectStoreFactory(() => store);
    await useEditor.getState().load("p1");
    await useEditor.getState().addTrack("video");
    const tid =
      useEditor.getState().timeline!.tracks[useEditor.getState().timeline!.tracks.length - 1].id;
    await useEditor.getState().setTrack(tid, { hidden: true });
    expect(useEditor.getState().timeline!.tracks.find((t) => t.id === tid)!.hidden).toBe(true);
  });

  it("removeTrack drops the track", async () => {
    const { store } = await seededCtx(undefined, P1);
    setProjectStoreFactory(() => store);
    await useEditor.getState().load("p1");
    await useEditor.getState().addTrack("text");
    const tid =
      useEditor.getState().timeline!.tracks[useEditor.getState().timeline!.tracks.length - 1].id;
    await useEditor.getState().removeTrack(tid);
    expect(useEditor.getState().timeline!.tracks.find((t) => t.id === tid)).toBeUndefined();
  });

  // ── gap selection ────────────────────────────────────────────────────────────
  // The rule: Delete has exactly ONE target. A clip selection and a gap selection are mutually
  // exclusive, which every clip-selection producer gets by routing its patch through `clipSel`.
  // A new producer could skip that helper, so these pin the RULE across all four that exist.
  async function withGap() {
    const { videos } = await loaded([
      { media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 },
      { media_ref: "a.mp4", timeline_in: 100, timeline_out: 160 },
    ]);
    return { videos, trackId: String(videoTrack().id) };
  }
  const videoTrack = () => useEditor.getState().timeline!.tracks.find((t) => t.kind === "video")!;
  const v1Spans = () => (videoTrack().clips ?? []).map((c) => [c.timeline_in, c.timeline_out]);

  it("selecting a gap drops the clip selection", async () => {
    const { videos, trackId } = await withGap();
    useEditor.getState().select(videos[0].id);
    useEditor.getState().selectGap(trackId, 80);
    expect(useEditor.getState().selectedGap).toEqual({ trackId, atFrame: 80 });
    expect(useEditor.getState().selectedIds).toEqual([]);
  });

  for (const [name, act] of [
    ["select", () => useEditor.getState().select(null)],
    ["selectAll", () => useEditor.getState().selectAll()],
    ["selectMany", () => useEditor.getState().selectMany([])],
    ["selectForward", () => useEditor.getState().selectForward("all")],
  ] as const) {
    it(`${name} never leaves BOTH a clip selection and a gap selected`, async () => {
      // The invariant is "at most one target", not "this helper ran". `selectForward` with no
      // anchor returns early and leaves the gap alone — which is fine, because it selects no
      // clips either. Asserting the mechanism instead of the rule failed on exactly that.
      const { videos, trackId } = await withGap();
      useEditor.getState().select(videos[0].id); // selectForward needs an anchor
      useEditor.getState().selectGap(trackId, 80);
      expect(useEditor.getState().selectedGap).not.toBeNull();
      act();
      const s = useEditor.getState();
      expect(s.selectedIds.length > 0 && s.selectedGap !== null).toBe(false);
    });
  }

  it("a producer that DOES select clips drops the gap", async () => {
    const { videos, trackId } = await withGap();
    for (const act of [
      () => useEditor.getState().select(videos[0].id),
      () => useEditor.getState().selectAll(),
      () => useEditor.getState().selectMany([videos[1].id]),
    ]) {
      useEditor.getState().selectGap(trackId, 80);
      expect(useEditor.getState().selectedGap).not.toBeNull();
      act();
      expect(useEditor.getState().selectedIds.length).toBeGreaterThan(0);
      expect(useEditor.getState().selectedGap).toBeNull();
    }
  });

  it("clicking empty space that is NOT a gap deselects rather than selecting", async () => {
    const { videos, trackId } = await withGap();
    useEditor.getState().select(videos[0].id);
    useEditor.getState().selectGap(trackId, 500); // past the last clip — unbounded, so not a gap
    expect(useEditor.getState().selectedGap).toBeNull();
    expect(useEditor.getState().selectedIds).toEqual([]);
  });

  it("rippleDeleteGap closes the gap without trimming either neighbour", async () => {
    const { trackId } = await withGap();
    useEditor.getState().selectGap(trackId, 80);
    await useEditor.getState().rippleDeleteGap();
    expect(v1Spans()).toEqual([
      [0, 60],
      [60, 120],
    ]);
    expect(useEditor.getState().selectedGap).toBeNull();
  });

  it("a gap an edit has since filled resolves to nothing — the point cannot go stale", async () => {
    // The failure direction for storing a POINT rather than a span: arm the selection, close the
    // hole by hand, then fire the delete. A span cached at click time would cut 40 frames of
    // real material here.
    const { videos, trackId } = await withGap();
    useEditor.getState().selectGap(trackId, 80);
    expect(useEditor.getState().selectedGap).not.toBeNull(); // armed, or this proves nothing
    await useEditor.getState().moveClip(videos[1].id, { toTimelineIn: 60 });
    await useEditor.getState().rippleDeleteGap();
    expect(v1Spans()).toEqual([
      [0, 60],
      [60, 120],
    ]);
  });

  it("a locked track has no selectable gap — the ripple behind Delete would refuse it", async () => {
    const { trackId } = await withGap();
    useEditor.getState().selectGap(trackId, 80);
    expect(useEditor.getState().selectedGap).not.toBeNull(); // selectable while unlocked
    await useEditor.getState().setTrack(trackId, { locked: true });
    useEditor.getState().selectGap(trackId, 80);
    expect(useEditor.getState().selectedGap).toBeNull();
  });

  it("edit actions are no-ops without a store", async () => {
    await useEditor.getState().moveClip("x", { toTimelineIn: 0 });
    await useEditor.getState().trimClip("x", { timeline_in: 0 });
    await useEditor.getState().splitClip("x", 1);
    await useEditor.getState().deleteClips(["x"]);
    await useEditor.getState().rippleDeleteClip("x");
    await useEditor.getState().duplicateClip("x");
    useEditor.getState().copyClip("x");
    await useEditor.getState().pasteClip();
    await useEditor.getState().setClipProperties("x", { opacity: 1 });
    await useEditor.getState().setTransition("x", { kind: "crossfade", duration: 5 });
    await useEditor.getState().setCanvas({ fps: 24 });
    await useEditor.getState().addTrack("video");
    await useEditor.getState().removeTrack("x");
    await useEditor.getState().setTrack("x", { mute: true });
    expect(useEditor.getState().timeline).toBeNull();
  });
});

// The timeline's "Generating…" label is driven off this map. ClipThumbnail renders it correctly
// and the catalog carries the status, but nothing proved the two were connected — an empty map
// would leave every placeholder looking like an ordinary clip that renders black.
describe("editor store — media status", () => {
  it("publishes generating/failed from the catalog, and nothing for ready media", async () => {
    const { store, fs } = seedStore(P1);
    fs.files.set(
      `${P1}/internals/library.json`,
      JSON.stringify({
        clips: [
          { id: "m_ready", filename: "a.mp4", path: "library/a.mp4" },
          { id: "m_gen", filename: "b.png", path: "library/b.png", status: "generating" },
          { id: "m_bad", filename: "c.png", path: "library/c.png", status: "failed" },
        ],
      }),
    );
    useEditor.setState({ projectId: "p1", store });

    useEditor.getState().refreshMedia();
    await waitFor(() => expect(useEditor.getState().mediaStatus.m_gen).toBe("generating"));

    const st = useEditor.getState().mediaStatus;
    expect(st.m_bad).toBe("failed");
    expect(st.m_ready).toBeUndefined(); // a ready clip must not carry a status
  });
});

describe("editor store — remaining view state + listeners", () => {
  it("multi-select: additive toggles, selectAll picks all clips, null clears", async () => {
    const { ctx, store } = await seededCtx(makeRunner(), P1);
    const r = (await addClipsTool(
      {
        entries: [
          { media_ref: "a.png", timeline_in: 0, timeline_out: 60 },
          { media_ref: "b.png", timeline_in: 60, timeline_out: 120 },
        ],
      },
      ctx,
    )) as { created: Array<{ clip_id: string; kind: string }> };
    setProjectStoreFactory(() => store);
    await useEditor.getState().load("p1");
    const ids = r.created.filter((c) => c.kind === "video").map((c) => c.clip_id);
    const st = useEditor.getState();
    st.select(ids[0]);
    st.select(ids[1], { additive: true });
    expect(useEditor.getState().selectedIds).toEqual(ids);
    st.select(ids[1], { additive: true }); // toggle off
    expect(useEditor.getState().selectedIds).toEqual([ids[0]]);
    st.selectAll();
    const total = useEditor
      .getState()
      .timeline!.tracks.reduce((n, t) => n + (t.clips?.length ?? 0), 0);
    expect(useEditor.getState().selectedIds.length).toBe(total);
    st.select(null);
    expect(useEditor.getState().selectedIds).toEqual([]);
  });

  it("selecting a linked clip expands to its whole link group; additive toggles the group", async () => {
    const { ctx, store } = await seededCtx(makeRunner(), P1);
    const r1 = (await addClipsTool(
      { entries: [{ media_ref: "a.png", timeline_in: 0, timeline_out: 30, track_id: "v1" }] },
      ctx,
    )) as { created: Array<{ clip_id: string }> };
    const r2 = (await addClipsTool(
      { entries: [{ media_ref: "b.png", timeline_in: 0, timeline_out: 30, track_id: "v2" }] },
      ctx,
    )) as { created: Array<{ clip_id: string }> };
    const id1 = r1.created[0].clip_id;
    const id2 = r2.created[0].clip_id;
    setProjectStoreFactory(() => store);
    await useEditor.getState().load("p1");
    await useEditor.getState().linkClips([id1, id2]);
    // a single click selects the whole group
    useEditor.getState().select(id1);
    expect(new Set(useEditor.getState().selectedIds)).toEqual(new Set([id1, id2]));
    expect(useEditor.getState().selection).toBe(id1);
    // additive-clicking a member of an already-selected group toggles the group OFF
    useEditor.getState().select(id2, { additive: true });
    expect(useEditor.getState().selectedIds).toEqual([]);
    // additive-clicking an unselected group adds the whole group
    useEditor.getState().select(id1, { additive: true });
    expect(new Set(useEditor.getState().selectedIds)).toEqual(new Set([id1, id2]));
  });

  it("setSelectedRange (ordered+clamped) / setTrackScale (clamped)", () => {
    const st = useEditor.getState();
    st.setSelectedRange({ startFrame: 50, endFrame: 10 }); // reversed -> ordered
    expect(useEditor.getState().selectedRange).toEqual({ startFrame: 10, endFrame: 50 });
    st.setSelectedRange({ startFrame: 5, endFrame: 5 }); // empty -> null
    expect(useEditor.getState().selectedRange).toBeNull();
    st.setSelectedRange(null);
    expect(useEditor.getState().selectedRange).toBeNull();
    st.setTrackScale("video", 99); // clamps to 3
    expect(useEditor.getState().trackScale.video).toBe(3);
    st.setTrackScale("audio", 0.1); // clamps to 0.5
    expect(useEditor.getState().trackScale.audio).toBe(0.5);
  });

  it("processImport + the artdaddy:files-changed listener re-sweep without throwing", async () => {
    const { store } = await seededCtx(undefined, P1);
    setProjectStoreFactory(() => store);
    await useEditor.getState().load("p1");
    await expect(useEditor.getState().processImport("a.mp4")).resolves.toBeUndefined();
    expect(() => window.dispatchEvent(new Event("artdaddy:files-changed"))).not.toThrow();
  });
});

describe("per-project registry + activation (frontmost document)", () => {
  afterEach(() => {
    deactivateEditorProject(null); // reset the active-project pointer
    disposeEditorStore("p1");
    disposeEditorStore("p2");
  });

  it("getEditorStore memoizes per project id and hands out independent instances", () => {
    const a1 = getEditorStore("p1");
    const a2 = getEditorStore("p1");
    const b = getEditorStore("p2");
    expect(a1).toBe(a2); // same id -> same instance
    expect(a1).not.toBe(b); // different id -> different instance
    expect(a1.getState().projectId).toBeNull(); // fresh + unloaded
  });

  it("disposeEditorStore drops the instance so a reopen builds a fresh one; unknown ids no-op", () => {
    const s1 = getEditorStore("p1");
    disposeEditorStore("p1");
    expect(getEditorStore("p1")).not.toBe(s1);
    expect(() => disposeEditorStore("never-opened")).not.toThrow();
  });

  it("activateEditorProject points the active view at the project's instance and loads it", async () => {
    const { store } = seedStore();
    setProjectStoreFactory(() => store);
    expect(await activateEditorProject("p1")).toBe("loaded");
    expect(useEditor.getState().projectId).toBe("p1"); // useEditor now resolves p1's instance
    expect(useEditor.getState().store).toBe(store);
  });

  it("deactivateEditorProject clears the active pointer and disposes the instance", async () => {
    const { store } = seedStore();
    setProjectStoreFactory(() => store);
    await activateEditorProject("p1");
    const active = getEditorStore("p1");
    deactivateEditorProject("p1");
    expect(useEditor.getState().projectId).toBeNull(); // falls back to the default empty store
    expect(getEditorStore("p1")).not.toBe(active); // the instance was disposed + rebuilt fresh
  });

  it("createProjectStore builds a store through the injected factory", async () => {
    const { store } = seedStore();
    setProjectStoreFactory((dir) => (dir === "/root/projects/p1" ? store : (undefined as never)));
    expect(await createProjectStore("/root/projects/p1")).toBe(store);
  });

  it("_zoomBounds exposes the ordered clamp constants that setZoom enforces", () => {
    expect(_zoomBounds.MIN_ZOOM).toBeLessThan(_zoomBounds.DEFAULT_ZOOM);
    expect(_zoomBounds.DEFAULT_ZOOM).toBeLessThan(_zoomBounds.MAX_ZOOM);
    useEditor.getState().setZoom(_zoomBounds.MAX_ZOOM + 999);
    expect(useEditor.getState().zoom).toBe(_zoomBounds.MAX_ZOOM);
    useEditor.getState().setZoom(_zoomBounds.MIN_ZOOM - 999);
    expect(useEditor.getState().zoom).toBe(_zoomBounds.MIN_ZOOM);
  });

  it("useEditor(selector) re-renders reactively when the active project changes", async () => {
    const { store } = seedStore();
    setProjectStoreFactory(() => store);
    const { result } = renderHook(() => useEditor((s) => s.projectId));
    expect(result.current).toBeNull(); // no active project -> default store
    await activateEditorProject("p1");
    await waitFor(() => expect(result.current).toBe("p1"));
  });
});
