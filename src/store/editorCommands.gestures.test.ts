// The editor's hand gestures, driven through the REAL editor store, the real operations and the real
// undo history: nudge, dragging a selection, Shift+E, Q / W at the playhead, ripple / roll / slip /
// slide, the rail a trim drag stops at, restacking tracks, Delete on a gap, copy and paste, dragging a
// keyframe and Alt-dragging one half of a pair. Mutation testing (26 Nov) found most of these commands
// run by no test at all (a command emptied to `{}` went unnoticed), and editorCommands.test.ts checks
// only what each one hands to a mocked tool. Here each case asserts what the person sees afterwards:
// where the clips are, which footage they play, what is selected, and that one gesture is exactly one
// Ctrl+Z which brings back the timeline as it was.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetTimelineBus } from "../timeline/bus";
import { findClip } from "../timeline/helpers";
import type { Timeline } from "../timeline/model";
import { clearDurationCache, clearHasAudioCache, clearHasVideoCache } from "../timeline/placement";
import { __setCanvasChangeConfirmationForTests } from "../lib/confirm";
import { registerTestDocument, resetTestDocuments } from "../test/timelineKit";
import type { CommandRunner } from "../tools/command";
import { type FsLike, ProjectStoreAccess } from "../tools/store";
import { setProjectStoreFactory, setRunnerFactory, useEditor } from "./editor";
import { useProjectNotice } from "./projectNotice";

vi.mock("../tools/dataRoot", async (orig) => ({
  ...(await orig<typeof import("../tools/dataRoot")>()),
  projectsRoot: vi.fn(async () => "/root/projects"),
  projectDirFor: vi.fn(async (id: string) => `/root/projects/${id}`),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const P1 = "/root/projects/p1";

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

/** ffprobe as the editor uses it: the length of each named file, a picture stream in every file and a
 *  sound stream in none (so a dropped .mp4 is one video clip), an error for a damaged file, and
 *  nothing for anything else. */
function ffprobe(seconds: Record<string, number>, damaged: string[] = []): CommandRunner {
  return {
    run: async (program, args) => {
      const file = String(args[args.length - 1] ?? "");
      if (damaged.some((n) => file.endsWith(n)))
        return { code: 1, stdout: "", stderr: "Invalid data found when processing input" };
      const name = Object.keys(seconds).find((n) => file.endsWith(n));
      if (program === "ffprobe" && args.includes("format=duration") && name)
        return { code: 0, stdout: `${seconds[name]}\n`, stderr: "" };
      if (program === "ffprobe" && args.includes("-select_streams"))
        return {
          code: 0,
          stdout: args[args.indexOf("-select_streams") + 1] === "v" ? "1" : "",
          stderr: "",
        };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

const vid = (id: string, tin: number, tout: number, sin = 0, over: Any = {}): Any => ({
  id,
  kind: "video",
  media_ref: `${id}.mp4`,
  timeline_in: tin,
  timeline_out: tout,
  source_in: sin,
  source_out: sin + (tout - tin),
  ...over,
});
const track = (id: string, kind: string, clips: Any[], over: Any = {}): Any => ({
  id,
  kind,
  z: 0,
  clips,
  ...over,
});
const tl = (fps: number, ...tracks: Any[]): Timeline =>
  ({ units: "frames", canvas: { width: 1920, height: 1080, fps }, tracks }) as Timeline;

/** Open a project holding `timeline`, its media `seconds` long, in the real editor store. */
async function open(
  timeline: Timeline,
  seconds: Record<string, number> = {},
  damaged: string[] = [],
): Promise<string> {
  const fs = new MemFs();
  fs.files.set(`${P1}/internals/timeline.json`, JSON.stringify(timeline));
  registerTestDocument(P1);
  const store = new ProjectStoreAccess(P1, fs);
  setProjectStoreFactory(() => store);
  setRunnerFactory(() => ffprobe(seconds, damaged));
  await useEditor.getState().load("p1");
  expect(useEditor.getState().error).toBeNull();
  return JSON.stringify(now());
}
const ed = () => useEditor.getState();
const now = (): Timeline => {
  const t = ed().timeline;
  if (!t) throw new Error("no timeline open");
  return t;
};
const clipOf = (id: string): Any => {
  const found = findClip(now(), id);
  if (!found) throw new Error(`no clip ${id}`);
  return found[1];
};
const at = (id: string): [number, number] => [clipOf(id).timeline_in, clipOf(id).timeline_out];
const footage = (id: string): [number, number] => [clipOf(id).source_in, clipOf(id).source_out];
const same = (opened: string) => expect(JSON.stringify(now())).toBe(opened);

beforeEach(() => {
  _resetTimelineBus();
  clearDurationCache();
  clearHasAudioCache();
  clearHasVideoCache();
});

afterEach(async () => {
  ed().dispose();
  await resetTestDocuments();
});

describe("nudge", () => {
  it("moves every selected clip by the same number of frames, and one Ctrl+Z puts them back", async () => {
    const opened = await open(
      tl(
        30,
        track("v1", "video", [vid("a", 30, 90), vid("b", 90, 150)]),
        track("v2", "video", [vid("x", 0, 60)]),
      ),
    );
    await ed().nudgeClips(["a", "b"], 5);
    expect(at("a")).toEqual([35, 95]);
    expect(at("b")).toEqual([95, 155]);
    expect(at("x")).toEqual([0, 60]);
    await ed().undo();
    same(opened);
    await ed().redo();
    expect(at("a")).toEqual([35, 95]);
  });

  it("a nudge that cannot move adds no undo step: Ctrl+Z still undoes the last real edit", async () => {
    const opened = await open(tl(30, track("v1", "video", [vid("a", 0, 60), vid("b", 90, 150)])));
    await ed().nudgeClips(["b"], 10);
    await ed().nudgeClips(["a"], -5); // already at frame 0
    expect(at("a")).toEqual([0, 60]);
    await ed().undo();
    same(opened);
  });
});

describe("dragging a selection of clips", () => {
  const lane = () =>
    tl(30, track("v1", "video", [vid("a", 0, 30), vid("b", 30, 60), vid("x", 90, 120)]));

  it("moves the selection as one, in one Ctrl+Z", async () => {
    const opened = await open(lane());
    await ed().moveSelectionBy(["a", "b"], 30);
    expect(at("a")).toEqual([30, 60]);
    expect(at("b")).toEqual([60, 90]);
    expect(at("x")).toEqual([90, 120]);
    await ed().undo();
    same(opened);
  });

  it("refuses to drop the selection on a clip outside it, leaving everything where it was", async () => {
    const opened = await open(lane());
    await ed().moveSelectionBy(["a", "b"], 40);
    same(opened);
  });

  it("leaves a single clip to the single-clip drag", async () => {
    const opened = await open(lane());
    await ed().moveSelectionBy(["b"], 100);
    same(opened);
  });
});

describe("Shift+E", () => {
  it("disables a picture and its own sound in one step, and Ctrl+Z turns both back on", async () => {
    await open(
      tl(
        30,
        track("v1", "video", [vid("v", 0, 60, 0, { link_group: "g" }), vid("x", 60, 120)]),
        track("a1", "audio", [
          vid("s", 0, 60, 0, { kind: "audio", media_ref: "v.mp4", link_group: "g" }),
        ]),
      ),
    );
    await ed().setClipEnabled(["v"], false);
    expect(clipOf("v").disabled).toBe(true);
    expect(clipOf("s").disabled).toBe(true);
    expect(clipOf("x").disabled).toBeUndefined();
    await ed().undo();
    expect(clipOf("v").disabled).toBeUndefined();
    expect(clipOf("s").disabled).toBeUndefined();
  });
});

describe("Q / W at the playhead", () => {
  it("cuts at the playhead counted in the project's own frame rate (25 fps here)", async () => {
    const opened = await open(tl(25, track("v1", "video", [vid("a", 0, 100)])));
    useEditor.setState({ playhead: 2 }); // 2 s = frame 50 at 25 fps
    await ed().trimToPlayhead("a", "head");
    expect(at("a")).toEqual([50, 100]);
    expect(footage("a")).toEqual([50, 100]);
    await ed().undo();
    same(opened);
    await ed().trimToPlayhead("a", "tail");
    expect(at("a")).toEqual([0, 50]);
    expect(footage("a")).toEqual([0, 50]);
  });
});

describe("edges dragged outward never make a clip play past the end of its own file", () => {
  // The editor probes each file's length before the edit; without it the edit has no limit, and the
  // export later runs out of frames (the bug the probe was added for).
  const lastFrame = (id: string, fileFrames: number) =>
    expect(clipOf(id).source_out).toBeLessThanOrEqual(fileFrames);

  it("ripple trim", async () => {
    await open(tl(30, track("v1", "video", [vid("a", 0, 60), vid("b", 60, 120)])), {
      "a.mp4": 3,
      "b.mp4": 10,
    });
    await ed().rippleTrim("a", "tail", 150);
    lastFrame("a", 90);
  });

  it("roll: the outgoing clip's file is probed too", async () => {
    await open(tl(30, track("v1", "video", [vid("a", 0, 60), vid("b", 60, 120, 30)])), {
      "a.mp4": 2,
      "b.mp4": 10,
    });
    await ed().rollEdit("a", 80);
    lastFrame("a", 60);
  });

  it("slip", async () => {
    await open(tl(30, track("v1", "video", [vid("a", 0, 60, 30)])), { "a.mp4": 4 });
    await ed().slipClip("a", 60);
    lastFrame("a", 120);
  });

  it("slide: the neighbours' files are probed too", async () => {
    await open(
      tl(30, track("v1", "video", [vid("a", 0, 60), vid("b", 60, 120), vid("c", 120, 180, 60)])),
      { "a.mp4": 2, "b.mp4": 10, "c.mp4": 10 },
    );
    await ed().slideClip("b", 10);
    lastFrame("a", 60);
  });

  it("a roll or slide aimed at a cut with nothing beyond it, or at a clip that is gone, changes nothing", async () => {
    const opened = await open(tl(30, track("v1", "video", [vid("a", 0, 60), vid("b", 60, 120)])));
    await expect(ed().rollEdit("b", 150)).resolves.toBeUndefined();
    await expect(ed().rollEdit("gone", 10)).resolves.toBeUndefined();
    await expect(ed().slideClip("gone", 5)).resolves.toBeUndefined();
    same(opened);
  });
});

describe("the rail a trim drag stops at", () => {
  it("is the clip's footage in the project's frames, and nothing for a still or a clip that is gone", async () => {
    await open(
      tl(
        25,
        track("v1", "video", [
          vid("a", 0, 100),
          { id: "p", kind: "image", media_ref: "p.png", timeline_in: 100, timeline_out: 150 },
        ]),
      ),
      { "a.mp4": 4 },
    );
    expect(await ed().clipSourceFrames("a")).toBe(100);
    expect(await ed().clipSourceFrames("p")).toBeNull();
    expect(await ed().clipSourceFrames("gone")).toBeNull();
  });
});

describe("restacking tracks", () => {
  const two = () =>
    tl(
      30,
      track("v1", "video", [vid("a", 0, 60)]),
      track("v2", "video", [vid("b", 0, 60)], { z: 1 }),
    );
  const z = (id: string) => (now().tracks.find((t) => t.id === id) as Any).z;

  it("changes several tracks at once, as one Ctrl+Z", async () => {
    const opened = await open(two());
    await ed().setTracks([
      { trackId: "v1", z: 1 },
      { trackId: "v2", z: 0 },
    ]);
    expect([z("v1"), z("v2")]).toEqual([1, 0]);
    await ed().undo();
    same(opened);
  });

  it("an empty restack adds no undo step", async () => {
    const opened = await open(two());
    await ed().setTracks([
      { trackId: "v1", z: 1 },
      { trackId: "v2", z: 0 },
    ]);
    await ed().setTracks([]);
    await ed().undo();
    same(opened);
  });
});

describe("Delete on a gap", () => {
  it("with no gap selected does nothing", async () => {
    const opened = await open(tl(30, track("v1", "video", [vid("a", 0, 60), vid("b", 90, 150)])));
    await expect(ed().rippleDeleteGap()).resolves.toBeUndefined();
    same(opened);
  });
});

describe("copy and paste", () => {
  const two = () =>
    tl(
      25,
      track("v1", "video", [vid("a", 0, 50)]),
      track("v2", "video", [vid("x", 0, 50)], { z: 1 }),
    );

  it("pastes on the track it was copied from, at the playhead in the project's frames, and selects the copy", async () => {
    await open(two());
    ed().copyClip("x");
    useEditor.setState({ playhead: 4 }); // 4 s = frame 100 at 25 fps
    await ed().pasteClip(undefined as unknown as number);
    const pasted = ed().selection;
    expect(pasted).toBeTruthy();
    expect(pasted).not.toBe("x");
    expect(findClip(now(), pasted!)![0].id).toBe("v2");
    expect(at(pasted!)).toEqual([100, 150]);
    expect(ed().selectedIds).toEqual([pasted]);
  });

  it("a paste or a duplicate that is refused leaves the selection as it was", async () => {
    await open(two());
    ed().copyClip("x");
    await ed().setTrack("v2", { locked: true });
    ed().select("a");
    const before = { selection: ed().selection, selectedIds: ed().selectedIds };
    await ed().pasteClip(100);
    expect({ selection: ed().selection, selectedIds: ed().selectedIds }).toEqual(before);
    await ed().duplicateClip("x");
    expect({ selection: ed().selection, selectedIds: ed().selectedIds }).toEqual(before);
    expect(now().tracks.find((t) => t.id === "v2")!.clips).toHaveLength(1);
  });
});

describe("dragging a keyframe", () => {
  const withVolume = (volume: Any) =>
    tl(30, track("v1", "video", [vid("a", 0, 60, 0, { volume })]));

  it("moves the key that was grabbed instead of adding a second one", async () => {
    await open(
      withVolume([
        { t: 0, v: 1 },
        { t: 30, v: 0.5 },
      ]),
    );
    await ed().setKeyframe("a", "volume", 40, 0.5, { fromT: 30 });
    expect(clipOf("a").volume).toEqual([
      { t: 0, v: 1 },
      { t: 40, v: 0.5 },
    ]);
  });

  it("moves the only key of a curve, which stays a single key", async () => {
    await open(withVolume([{ t: 10, v: 0.8 }]));
    await ed().setKeyframe("a", "volume", 20, 0.8, { fromT: 10 });
    expect(clipOf("a").volume).toEqual([{ t: 20, v: 0.8 }]);
  });

  it("a key set without grabbing one is added", async () => {
    await open(
      withVolume([
        { t: 0, v: 1 },
        { t: 30, v: 0.5 },
      ]),
    );
    await ed().setKeyframe("a", "volume", 15, 0.7);
    expect(clipOf("a").volume).toEqual([
      { t: 0, v: 1 },
      { t: 15, v: 0.7 },
      { t: 30, v: 0.5 },
    ]);
  });

  it("a key set on a clip that is gone does nothing", async () => {
    const opened = await open(withVolume([{ t: 0, v: 1 }]));
    await expect(ed().setKeyframe("gone", "volume", 5, 0.5)).resolves.toBeUndefined();
    same(opened);
  });
});

describe("dragging one half of a linked pair", () => {
  const pair = () =>
    tl(
      30,
      track("v1", "video", [vid("v", 0, 60, 0, { link_group: "g" })]),
      track("a1", "audio", [
        vid("s", 0, 60, 0, { kind: "audio", media_ref: "v.mp4", link_group: "g" }),
      ]),
    );

  it("with Alt held moves only the half that was dragged; without it the sound follows", async () => {
    const opened = await open(pair());
    await ed().moveClip("v", { toTimelineIn: 30, ignoreLinks: true });
    expect(at("v")).toEqual([30, 90]);
    expect(at("s")).toEqual([0, 60]);
    await ed().undo();
    same(opened);
    await ed().moveClip("v", { toTimelineIn: 30 });
    expect(at("v")).toEqual([30, 90]);
    expect(at("s")).toEqual([30, 90]);
  });
});

describe("dropping files onto a lane", () => {
  // A drop of a picture that does not match the canvas would ask the person; these answer "keep".
  beforeEach(() => {
    __setCanvasChangeConfirmationForTests(async () => false);
    useProjectNotice.getState().clear();
  });
  afterEach(() => __setCanvasChangeConfirmationForTests(null));
  const lanes = () =>
    tl(30, track("v1", "video", [vid("x", 0, 30)]), track("t1", "text", [], { z: 1 }));
  const onLane = (id: string) =>
    (now().tracks.find((t) => t.id === id)?.clips ?? []).map((c) => [
      c.timeline_in,
      c.timeline_out,
    ]);

  it("several files land one after another from the drop point, and one Ctrl+Z takes them all away", async () => {
    const opened = await open(lanes(), { "a.mp4": 2, "b.mp4": 3 });
    await ed().addClips(["a.mp4", "b.mp4"], "v1", 60);
    expect(useProjectNotice.getState().message).toBeNull();
    expect(onLane("v1")).toEqual([
      [0, 30],
      [60, 120],
      [120, 210],
    ]);
    await ed().undo();
    same(opened);
  });

  it.each([
    [["broken.mp4"], "Couldn't add that file to the timeline: "],
    [["a.mp4", "broken.mp4"], "Couldn't add those 2 files to the timeline: "],
  ])("a drop that cannot be read says so, and adds nothing (%j)", async (files, said) => {
    const opened = await open(lanes(), { "a.mp4": 2 }, ["broken.mp4"]);
    await ed().addClips(files, "v1", 60);
    expect(useProjectNotice.getState().message).toMatch(new RegExp(`^${said}\\S`));
    same(opened);
  });
});
