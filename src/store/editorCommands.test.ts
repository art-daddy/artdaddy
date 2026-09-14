// Guards the editor's mutation surface. These commands are what the UI (drag, trim,
// Ctrl+V, Delete) actually calls, and every one of them is a thin delegation — so
// the things that can break are the ARGUMENT SHAPE handed to the timeline tool, the
// "no project open" guard, and the two places real state is derived: the probed clip
// duration and the clipboard deep copy.
import { beforeEach, describe, expect, it, vi } from "vitest";

const edit = {
  applyTransitionTool: vi.fn(async (_a: unknown, _c: unknown) => ({ ok: true })),
  duplicateClipsTool: vi.fn(async (_a: unknown, _c: unknown) => ({ new_clip_ids: ["c2"] })),
  linkClipsTool: vi.fn(async (_a: unknown, _c: unknown) => ({ ok: true })),
  moveClipsTool: vi.fn(async (_a: unknown, _c: unknown) => ({ ok: true })),
  pasteClipsTool: vi.fn(async (_a: unknown, _c: unknown) => ({ new_clip_ids: ["c9"] })),
  removeClipsTool: vi.fn(async (_a: unknown, _c: unknown) => ({ ok: true })),
  rippleDeleteTool: vi.fn(async (_a: unknown, _c: unknown) => ({ ok: true })),
  splitClipsTool: vi.fn(async (_a: unknown, _c: unknown) => ({ ok: true })),
  trimClipsTool: vi.fn(async (_a: unknown, _c: unknown) => ({ ok: true })),
  unlinkClipsTool: vi.fn(async (_a: unknown, _c: unknown) => ({ ok: true })),
};
const ops = {
  addTrackTool: vi.fn(async (_a: unknown, _c: unknown) => ({ track_id: "v2" })),
  removeTracksTool: vi.fn(async (_a: unknown, _c: unknown) => ({ removed: 1 })),
  setCanvasTool: vi.fn(async (_a: unknown, _c: unknown) => ({ ok: true })),
  setTrackTool: vi.fn(async (_a: unknown, _c: unknown) => ({ track_id: "v1" })),
};
const addClipsTool = vi.fn(async (_a: unknown, _c: unknown) => ({ ok: true }));
const setClipPropertiesTool = vi.fn(async (_a: unknown, _c: unknown) => ({ ok: true }));

vi.mock("../timeline/edit", () => edit);
vi.mock("../timeline/ops", () => ops);
vi.mock("../timeline/placement", () => ({
  addClipsTool: (a: unknown, c: unknown) => addClipsTool(a, c),
}));
vi.mock("../timeline/props", () => ({
  setClipPropertiesTool: (a: unknown, c: unknown) => setClipPropertiesTool(a, c),
}));

const { makeEditorCommands } = await import("./editorCommands");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const TIMELINE = {
  units: "frames",
  canvas: { width: 1080, height: 1920, fps: 30 },
  tracks: [
    {
      id: "v1",
      kind: "video",
      z: 0,
      clips: [{ id: "c1", kind: "video", media_ref: "a.mp4", timeline_in: 30, timeline_out: 90 }],
    },
    { id: "a1", kind: "audio", z: 0, clips: [] },
  ],
};

function harness(overrides: Record<string, unknown> = {}) {
  const state: Record<string, unknown> = {
    store: {
      resolveRef: vi.fn(async (r: string) => `/abs/${r}`),
    },
    timeline: JSON.parse(JSON.stringify(TIMELINE)),
    playhead: 2,
    clipboard: null,
    selection: null,
    selectedIds: [],
    _index: { indexSource: vi.fn() },
    ...overrides,
  };
  const set = vi.fn((partial: Record<string, unknown>) => Object.assign(state, partial));
  const runner = {
    run: vi.fn(async (_program: string, _args: string[]) => ({
      code: 0,
      stdout: "2.0\n",
      stderr: "",
    })),
  };
  const cmds = makeEditorCommands(
    () => state as Any,
    set as Any,
    () => runner as Any,
  );
  return { cmds, state, set, runner };
}

beforeEach(() => vi.clearAllMocks());

describe("no project open — every command is an inert no-op", () => {
  // A UI gesture that fires before a project finishes loading must not throw and
  // must not write: an exception here surfaces as a dead toolbar, a write as a
  // clip landing in whatever project loads next.
  const calls: Array<[string, unknown[]]> = [
    ["moveClip", ["c1", { toTimelineIn: 0 }]],
    ["trimClip", ["c1", { timeline_in: 0 }]],
    ["splitClip", ["c1", 45]],
    ["deleteClips", [["c1"]]],
    ["rippleDeleteClip", ["c1"]],
    ["duplicateClip", ["c1"]],
    ["linkClips", [["c1", "c2"]]],
    ["unlinkClips", [["c1"]]],
    ["pasteClip", [0]],
    ["setClipProperties", ["c1", { opacity: 0.5 }]],
    ["setTransition", ["c1", { duration: 15 }]],
    ["setCanvas", [{ fps: 24 }]],
    ["addClip", ["a.mp4", "v1", 0]],
    ["addTrack", ["video"]],
    ["removeTrack", ["v1"]],
    ["setTrack", ["v1", { mute: true }]],
  ];

  for (const [name, args] of calls) {
    it(`${name} does nothing without a store`, async () => {
      const { cmds } = harness({ store: null });
      await expect((cmds as Any)[name](...args)).resolves.toBeUndefined();
      const touched = [
        ...Object.values(edit),
        ...Object.values(ops),
        addClipsTool,
        setClipPropertiesTool,
      ].filter((m) => (m as Any).mock.calls.length > 0);
      expect(touched).toEqual([]);
    });
  }
});

describe("delegation shape", () => {
  // `moveClip` is deliberately absent here: it stopped being a delegation when Alt+drag needed
  // duplicate/ignore-link semantics, and now calls the operation through `runGesture`. Its
  // behaviour is asserted against a REAL store in editor.test.ts, which is the only place that
  // can tell a move from a duplicate.

  it("trimClip forwards the edges under the clip id", async () => {
    const { cmds } = harness();
    await cmds.trimClip("c1", { timeline_in: 45 } as Any);
    expect(edit.trimClipsTool).toHaveBeenCalledWith(
      { trims: [{ clip_id: "c1", timeline_in: 45 }] },
      expect.anything(),
    );
  });

  it("splitClip sends the cut point as `at`", async () => {
    const { cmds } = harness();
    await cmds.splitClip("c1", 60);
    expect(edit.splitClipsTool).toHaveBeenCalledWith(
      { splits: [{ clip_id: "c1", at: 60 }] },
      expect.anything(),
    );
  });

  it("setTrack merges the patch onto the track id", async () => {
    const { cmds } = harness();
    await cmds.setTrack("v1", { mute: true } as Any);
    expect(ops.setTrackTool).toHaveBeenCalledWith(
      { track_id: "v1", mute: true },
      expect.anything(),
    );
  });

  it("edit commands are given a runner that REFUSES to spawn a binary", async () => {
    const { cmds } = harness();
    await cmds.splitClip("c1", 60);
    const ctx = edit.splitClipsTool.mock.calls[0][1] as Any;
    await expect(ctx.runner.run("ffmpeg", [])).rejects.toThrow(
      /not available in the manual editor/,
    );
  });

  it("deleteClips ignores an empty selection", async () => {
    const { cmds } = harness();
    await cmds.deleteClips([]);
    expect(edit.removeClipsTool).not.toHaveBeenCalled();
  });

  it("deleteClips clears the selection after removing", async () => {
    const { cmds, state } = harness({ selection: "c1", selectedIds: ["c1"] });
    await cmds.deleteClips(["c1"]);
    expect(state.selection).toBeNull();
    expect(state.selectedIds).toEqual([]);
  });

  it("linkClips needs two clips; unlinkClips needs one", async () => {
    const { cmds } = harness();
    await cmds.linkClips(["c1"]);
    expect(edit.linkClipsTool).not.toHaveBeenCalled();
    await cmds.linkClips(["c1", "c2"]);
    expect(edit.linkClipsTool).toHaveBeenCalled();
    await cmds.unlinkClips([]);
    expect(edit.unlinkClipsTool).not.toHaveBeenCalled();
  });

  it("duplicateClip selects the clip it created", async () => {
    const { cmds, state } = harness();
    await cmds.duplicateClip("c1");
    expect(state.selection).toBe("c2");
    expect(state.selectedIds).toEqual(["c2"]);
  });

  it("rippleDeleteClip cuts exactly the clip's own span", async () => {
    const { cmds } = harness();
    await cmds.rippleDeleteClip("c1");
    expect(edit.rippleDeleteTool).toHaveBeenCalledWith(
      { track_id: "v1", start: 30, end: 90 },
      expect.anything(),
    );
  });

  it("rippleDeleteClip on a clip that isn't there does nothing", async () => {
    const { cmds } = harness();
    await cmds.rippleDeleteClip("nope");
    expect(edit.rippleDeleteTool).not.toHaveBeenCalled();
  });
});

describe("clipboard", () => {
  it("copyClip stores a DEEP copy — later edits to the source don't mutate it", async () => {
    const { cmds, state } = harness();
    cmds.copyClip("c1");
    const clipboard = state.clipboard as Any;
    expect(clipboard.clip.id).toBe("c1");
    expect(clipboard.trackId).toBe("v1");
    expect(clipboard.trackKind).toBe("video");

    (state.timeline as Any).tracks[0].clips[0].timeline_out = 999;
    expect(clipboard.clip.timeline_out).toBe(90);
  });

  it("copyClip on a missing clip leaves the clipboard alone", () => {
    const { cmds, state } = harness();
    cmds.copyClip("nope");
    expect(state.clipboard).toBeNull();
  });

  it("pasteClip lands on the ORIGINAL track when it still exists", async () => {
    const { cmds } = harness({
      clipboard: { clip: { id: "c1" }, trackId: "a1", trackKind: "audio" },
    });
    await cmds.pasteClip(60);
    expect(edit.pasteClipsTool).toHaveBeenCalledWith(
      { clips: [{ id: "c1" }], track_id: "a1", at: 60 },
      expect.anything(),
    );
  });

  it("pasteClip falls back to a track of the same KIND when the original is gone", async () => {
    const { cmds } = harness({
      clipboard: { clip: { id: "c1" }, trackId: "deleted", trackKind: "audio" },
    });
    await cmds.pasteClip(0);
    expect((edit.pasteClipsTool.mock.calls[0][0] as Any).track_id).toBe("a1");
  });

  it("pasteClip does nothing when no track of that kind survives", async () => {
    const { cmds } = harness({
      clipboard: { clip: { id: "c1" }, trackId: "gone", trackKind: "text" },
    });
    await cmds.pasteClip(0);
    expect(edit.pasteClipsTool).not.toHaveBeenCalled();
  });

  it("pasteClip with no frame pastes at the PLAYHEAD, converted to frames", async () => {
    const { cmds } = harness({
      playhead: 2.5,
      clipboard: { clip: { id: "c1" }, trackId: "v1", trackKind: "video" },
    });
    await cmds.pasteClip(undefined as Any);
    expect((edit.pasteClipsTool.mock.calls[0][0] as Any).at).toBe(75); // 2.5s × 30fps
  });

  it("pasteClip selects what it pasted", async () => {
    const { cmds, state } = harness({
      clipboard: { clip: { id: "c1" }, trackId: "v1", trackKind: "video" },
    });
    await cmds.pasteClip(0);
    expect(state.selection).toBe("c9");
  });

  it("pasteClip with an empty clipboard is a no-op", async () => {
    const { cmds } = harness();
    await cmds.pasteClip(0);
    expect(edit.pasteClipsTool).not.toHaveBeenCalled();
  });
});

describe("addClip duration probing", () => {
  it("uses the probed source duration, in frames at the canvas fps", async () => {
    const { cmds, runner } = harness();
    runner.run.mockResolvedValueOnce({ code: 0, stdout: "4.0\n", stderr: "" });
    await cmds.addClip("a.mp4", "v1", 15);
    expect((addClipsTool.mock.calls[0][0] as Any).entries[0]).toMatchObject({
      media_ref: "a.mp4",
      track_id: "v1",
      timeline_in: 15,
      timeline_out: 15 + 120,
    });
  });

  it("defaults a still / unprobeable source to 5 seconds rather than zero length", async () => {
    const { cmds, runner } = harness();
    runner.run.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "not a video" });
    await cmds.addClip("logo.png", "v1", 0);
    expect((addClipsTool.mock.calls[0][0] as Any).entries[0].timeline_out).toBe(150);
  });

  it("defaults when ffprobe throws outright", async () => {
    const { cmds, runner } = harness();
    runner.run.mockRejectedValueOnce(new Error("no binary"));
    await cmds.addClip("logo.png", "v1", 0);
    expect((addClipsTool.mock.calls[0][0] as Any).entries[0].timeline_out).toBe(150);
  });

  it("never produces a zero-length clip from a zero/garbage duration", async () => {
    for (const stdout of ["0", "-3", "abc", ""]) {
      vi.clearAllMocks();
      const { cmds, runner } = harness();
      runner.run.mockResolvedValueOnce({ code: 0, stdout, stderr: "" });
      await cmds.addClip("x.mp4", "v1", 0);
      const e = (addClipsTool.mock.calls[0][0] as Any).entries[0];
      expect(e.timeline_out - e.timeline_in).toBeGreaterThan(0);
    }
  });

  it("clamps a negative drop position to the start of the timeline", async () => {
    const { cmds } = harness();
    await cmds.addClip("a.mp4", "v1", -40);
    expect((addClipsTool.mock.calls[0][0] as Any).entries[0].timeline_in).toBe(0);
  });

  it("probes the RESOLVED absolute path, not the project-relative ref", async () => {
    const { cmds, runner, state } = harness();
    await cmds.addClip("library/a.mp4", "v1", 0);
    expect((state.store as Any).resolveRef).toHaveBeenCalledWith("library/a.mp4");
    expect(runner.run.mock.calls[0][1]).toContain("/abs/library/a.mp4");
  });

  it("passes a REAL runner to the placement tool (unlike the pure edit ops)", async () => {
    const { cmds, runner } = harness();
    await cmds.addClip("a.mp4", "v1", 0);
    expect((addClipsTool.mock.calls[0][1] as Any).runner).toBe(runner);
  });
});

describe("processImport", () => {
  it("hands the source to the per-project indexer", async () => {
    const { cmds, state } = harness();
    await cmds.processImport("library/a.mp4");
    expect((state._index as Any).indexSource).toHaveBeenCalledWith("library/a.mp4");
  });

  it("survives having no indexer yet", async () => {
    const { cmds } = harness({ _index: undefined });
    await expect(cmds.processImport("library/a.mp4")).resolves.toBeUndefined();
  });
});
