// The hand-edit counters (api/editorEvents.ts) hang off the editor's one registry of actions. The questions worth testing are not
// "does the wrapper call recordEdit": they are whether EVERY action a person can take is either counted or named as not an edit
// (walked from the real store, so a new action cannot go uncounted by accident), whether every word the server knows has
// something that produces it, whether taking a real action through the real store counts it under the right project without
// changing what the action does, and whether counting can ever stop or slow an edit.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EDIT_KINDS, recordEdit, type EditKind } from "../api/editorEvents";
import { _resetTimelineBus } from "../timeline/bus";
import { findClip } from "../timeline/helpers";
import { addClipsTool, clearHasAudioCache } from "../timeline/placement";
import { audioRunner, resetTestDocuments, seededCtx } from "../test/timelineKit";
import {
  countHandEdits,
  HAND_EDIT_KIND,
  propertyEditKind,
  type HandActionKey,
} from "./editorCommands";
import { getEditorStore, setProjectStoreFactory, useEditor } from "./editor";

vi.mock("../tools/dataRoot", async (orig) => ({
  ...(await orig<typeof import("../tools/dataRoot")>()),
  projectsRoot: vi.fn(async () => "/root/projects"),
  projectDirFor: vi.fn(async (id: string) => `/root/projects/${id}`),
}));
vi.mock("../api/editorEvents", async (orig) => ({
  ...(await orig<typeof import("../api/editorEvents")>()),
  recordEdit: vi.fn(),
}));

const P1 = "/root/projects/p1";
const recorded = (): [string, string][] =>
  vi.mocked(recordEdit).mock.calls.map(([kind, project]) => [kind, project ?? ""]);

/** Every function the editor store has that is NOT an action on the project: selection, the view, the loading and closing of a
 *  project. Each is here on purpose; a new function that is in neither this list nor HAND_EDIT_KIND fails the walk below. */
const NOT_EDITS = new Set<string>([
  "refreshMedia",
  "load",
  "reload",
  "select",
  "selectAll",
  "selectMany",
  "selectForward",
  "selectGap",
  "openMediaTab",
  "closeMediaTab",
  "setActiveMediaTab",
  "setSelectedRange",
  "setPlayhead",
  "setZoom",
  "setTrackScale",
  "beginGesture",
  "endGesture",
  "dispose",
]);

beforeEach(() => {
  vi.mocked(recordEdit).mockClear();
  _resetTimelineBus();
  clearHasAudioCache();
});

afterEach(async () => {
  useEditor.getState().dispose();
  await resetTestDocuments();
});

describe("the walk: every action of the editor is counted or named as not an edit", () => {
  const functions = (): string[] => {
    const state = getEditorStore("walk").getState() as unknown as Record<string, unknown>;
    return Object.keys(state).filter((key) => typeof state[key] === "function");
  };

  it("fails on an action that is neither counted nor named as not an edit", () => {
    const unclassified = functions().filter(
      (key) => !(key in HAND_EDIT_KIND) && !NOT_EDITS.has(key),
    );
    expect(
      unclassified,
      `these editor actions are in neither HAND_EDIT_KIND (editorCommands.ts) nor NOT_EDITS: decide whether a person taking them changes the project`,
    ).toEqual([]);
  });

  it("names nothing that is not there, so a removed action cannot leave a stale entry that hides the next one", () => {
    const present = new Set(functions());
    expect([...Object.keys(HAND_EDIT_KIND)].filter((key) => !present.has(key))).toEqual([]);
    expect([...NOT_EDITS].filter((key) => !present.has(key))).toEqual([]);
  });

  it("never lists one action as both an edit and not an edit", () => {
    expect([...NOT_EDITS].filter((key) => key in HAND_EDIT_KIND)).toEqual([]);
  });
});

describe("what each action counts as", () => {
  it("every word the server knows is produced by something a person can do", () => {
    const produced = new Set<EditKind>();
    for (const rule of Object.values(HAND_EDIT_KIND))
      if (typeof rule === "string") produced.add(rule);
    produced.add(
      (HAND_EDIT_KIND.moveClip as (id: string, o: { duplicate?: boolean }) => EditKind)("c", {
        duplicate: true,
      }),
    );
    for (const props of [{ color: {} }, { text: "x" }, { opacity: 1 }])
      produced.add(propertyEditKind(props));
    expect([...produced].sort()).toEqual([...EDIT_KINDS].sort());
  });

  it("an Alt-drag that leaves the original is an add, and a plain drag is a move", () => {
    const rule = HAND_EDIT_KIND.moveClip as (id: string, o: { duplicate?: boolean }) => EditKind;
    expect(rule("c", { duplicate: true })).toBe("add");
    expect(rule("c", { duplicate: false })).toBe("move");
    expect(rule("c", {})).toBe("move");
  });

  it("a change of properties is told from the NAMES of what it touches, never what they hold", () => {
    expect(propertyEditKind({ color: { exposure: 0.4 } })).toBe("effect");
    expect(propertyEditKind({ effects: [] })).toBe("effect");
    expect(propertyEditKind({ text: "my private title" })).toBe("text");
    expect(propertyEditKind({ style: { size: "xl" } })).toBe("text");
    expect(propertyEditKind({ opacity: 0.5 })).toBe("property");
    expect(propertyEditKind({ transform: { scale: 2 } })).toBe("property");
    expect(propertyEditKind({})).toBe("property");
    expect(propertyEditKind(null)).toBe("property");
    expect(propertyEditKind(undefined)).toBe("property");
    // The value of a property decides nothing: the same name with another value is the same kind.
    expect(propertyEditKind({ text: "" })).toBe(
      propertyEditKind({ text: "something else entirely" }),
    );
  });

  it("the commands that change nothing are counted as nothing", () => {
    const nothing = Object.entries(HAND_EDIT_KIND)
      .filter(([, rule]) => rule === null)
      .map(([key]) => key);
    expect(nothing.sort()).toEqual(["clipSourceFrames", "copyClip", "processImport"]);
  });

  it("each action is the kind of edit a person would call it (stated again here, so a slip in the table is a failing test)", () => {
    const expected: Record<string, EditKind> = {
      trimClip: "trim",
      nudgeClips: "move",
      moveSelectionBy: "move",
      setClipEnabled: "property",
      trimToPlayhead: "trim",
      rippleTrim: "trim",
      rollEdit: "trim",
      slipClip: "trim",
      slideClip: "move",
      splitClip: "split",
      deleteClips: "delete",
      rippleDeleteClip: "delete",
      rippleDeleteGap: "delete",
      duplicateClip: "add",
      linkClips: "link",
      unlinkClips: "link",
      pasteClip: "add",
      setKeyframe: "keyframe",
      setTransition: "transition",
      setCanvas: "canvas",
      addClip: "add",
      addClips: "add",
      addTrack: "track",
      removeTrack: "track",
      setTrack: "track",
      setTracks: "track",
      undo: "undo",
      redo: "redo",
    };
    const stated = Object.fromEntries(
      Object.entries(HAND_EDIT_KIND).filter(([, rule]) => typeof rule === "string"),
    );
    expect(stated).toEqual(expected);
  });
});

describe("the wrapper", () => {
  const make = () => {
    const record = vi.fn();
    const split = vi.fn(async (_id: string, _at: number) => "done");
    const copy = vi.fn((_id: string) => undefined);
    const other = vi.fn(() => "untouched");
    const wrapped = countHandEdits(
      { splitClip: split, copyClip: copy, notAnAction: other },
      () => project,
      record,
    );
    let project = "p1";
    return { wrapped, record, split, copy, other, setProject: (id: string) => (project = id) };
  };

  it("counts an action when it is taken, as its kind, under the project that is open then", async () => {
    const { wrapped, record, setProject } = make();
    await wrapped.splitClip("c1", 30);
    setProject("p2");
    await wrapped.splitClip("c1", 31);
    expect(record.mock.calls).toEqual([
      ["split", "p1"],
      ["split", "p2"],
    ]);
  });

  it("passes what the action is given and what it returns straight through", async () => {
    const { wrapped, split } = make();
    expect(await wrapped.splitClip("clip_9", 77)).toBe("done");
    expect(split).toHaveBeenCalledWith("clip_9", 77);
  });

  it("counts nothing for a command that changes nothing, and leaves a function it does not know alone", () => {
    const { wrapped, record, copy, other } = make();
    wrapped.copyClip("c1");
    expect(wrapped.notAnAction()).toBe("untouched");
    expect(copy).toHaveBeenCalledWith("c1");
    expect(other).toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("counts an action that then fails, and lets the failure through", async () => {
    const record = vi.fn();
    const boom = new Error("refused");
    const wrapped = countHandEdits(
      { splitClip: async () => Promise.reject(boom) },
      () => "p1",
      record,
    );
    await expect(wrapped.splitClip()).rejects.toBe(boom);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("can never stop an edit: a counter that throws costs the edit nothing", async () => {
    const split = vi.fn(async () => "still done");
    const wrapped = countHandEdits(
      { splitClip: split },
      () => "p1",
      () => {
        throw new Error("the counter is broken");
      },
    );
    expect(await wrapped.splitClip()).toBe("still done");
    expect(split).toHaveBeenCalledTimes(1);
  });

  it("counts nothing while no project is open", async () => {
    const record = vi.fn();
    const wrapped = countHandEdits({ splitClip: async () => undefined }, () => "", record);
    await wrapped.splitClip();
    expect(record).not.toHaveBeenCalled();
  });
});

describe("a real action through the real store", () => {
  async function loaded(entries: Array<Record<string, unknown>>) {
    const { ctx, store } = await seededCtx(audioRunner, P1);
    const r = (await addClipsTool({ entries }, ctx)) as {
      created: Array<{ clip_id: string; kind: string }>;
    };
    setProjectStoreFactory(() => store);
    await useEditor.getState().load("p1");
    return { videos: r.created.filter((c) => c.kind === "video").map((c) => c.clip_id as string) };
  }

  it("every action the table counts really is counted when a person takes it, through the real store", async () => {
    const { videos } = await loaded([
      { media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 },
      { media_ref: "b.mp4", timeline_in: 60, timeline_out: 120 },
    ]);
    const [a, b] = videos;
    // What each counted action is given. The outcome of the edit does not matter here (some are refused, some do nothing):
    // taking the action is what is counted. A counted action with no sample fails below, so a new one must be shown here.
    const SAMPLE: Record<string, unknown[]> = {
      moveClip: [a, { toTimelineIn: 5 }],
      trimClip: [a, { timeline_out: 50 }],
      nudgeClips: [[a], 1],
      moveSelectionBy: [[a, b], 1],
      setClipEnabled: [[a], false],
      trimToPlayhead: [a, "head"],
      rippleTrim: [a, "tail", 50],
      rollEdit: [a, 40],
      slipClip: [a, 1],
      slideClip: [a, 1],
      splitClip: [a, 20],
      deleteClips: [[a]],
      rippleDeleteClip: [a],
      rippleDeleteGap: [],
      duplicateClip: [a],
      linkClips: [[a, b]],
      unlinkClips: [[a]],
      pasteClip: [0],
      setClipProperties: [a, { opacity: 0.5 }],
      setKeyframe: [a, "opacity", 5, 0.5],
      setTransition: [a, null],
      setCanvas: [{ fps: 30 }],
      addClip: ["a.mp4", "v1", 0],
      addClips: [["a.mp4"], "v1", 0],
      addTrack: ["video"],
      removeTrack: ["no-such-track"],
      setTrack: ["v1", { mute: true }],
      setTracks: [[{ trackId: "v1", z: 0 }]],
      undo: [],
      redo: [],
    };
    const counted = Object.entries(HAND_EDIT_KIND)
      .filter(([, rule]) => rule !== null)
      .map(([key]) => key);
    expect(Object.keys(SAMPLE).sort()).toEqual(counted.sort());
    const state = useEditor.getState() as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    for (const key of counted) {
      vi.mocked(recordEdit).mockClear();
      await Promise.resolve(state[key](...SAMPLE[key])).catch(() => undefined);
      const calls = recorded();
      expect(calls.length, `${key} was counted ${calls.length} times`).toBe(1);
      const rule = HAND_EDIT_KIND[key as HandActionKey] as
        EditKind | ((...given: unknown[]) => EditKind);
      const expected = typeof rule === "function" ? rule(...SAMPLE[key]) : rule;
      expect(calls[0], key).toEqual([expected, "p1"]);
    }
  });

  it("is counted under the project it was taken in, and still does what it did", async () => {
    const { videos } = await loaded([{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }]);
    await useEditor.getState().splitClip(videos[0], 30);
    const clips = useEditor.getState().timeline!.tracks.find((t) => t.kind === "video")!.clips!;
    expect(clips.length).toBe(2); // the edit itself is unchanged
    await useEditor.getState().deleteClips([clips[1].id as string]);
    expect(findClip(useEditor.getState().timeline!, String(clips[1].id))).toBeNull();
    await useEditor.getState().undo();
    expect(findClip(useEditor.getState().timeline!, String(clips[1].id))).not.toBeNull();
    await useEditor.getState().redo();
    expect(recorded()).toEqual([
      ["split", "p1"],
      ["delete", "p1"],
      ["undo", "p1"],
      ["redo", "p1"],
    ]);
  });

  it("tells an Alt-drag copy from a move, and a colour change from a plain setting", async () => {
    const { videos } = await loaded([{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }]);
    await useEditor.getState().moveClip(videos[0], { toTimelineIn: 120, duplicate: true });
    await useEditor.getState().moveClip(videos[0], { toTimelineIn: 10 });
    await useEditor.getState().setClipProperties(videos[0], { opacity: 0.5 });
    await useEditor.getState().setClipProperties(videos[0], { color: { exposure: 0.2 } });
    expect(recorded().map(([kind]) => kind)).toEqual(["add", "move", "property", "effect"]);
  });

  it("copying to the clipboard is not an edit, and neither is moving the playhead or selecting", async () => {
    const { videos } = await loaded([{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }]);
    useEditor.getState().copyClip(videos[0]);
    useEditor.getState().setPlayhead(2);
    useEditor.getState().select(videos[0]);
    useEditor.getState().setZoom(80);
    expect(recorded()).toEqual([]);
  });

  it("with no project open an action is neither done nor counted", async () => {
    await useEditor.getState().splitClip("x", 1);
    await useEditor.getState().deleteClips(["x"]);
    await useEditor.getState().undo();
    expect(recorded()).toEqual([]);
  });
});
