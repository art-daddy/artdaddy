// Every key the shortcut sheet lists (timeline/shortcuts.ts, shown by ShortcutSheet) does, in the timeline, what the
// sheet says it does. shortcuts.test.ts proves each combo MATCHES its entry; nothing proved that a handler then acts on
// it, so a key could be listed, match, and do nothing. This walks every entry the timeline handles and presses each of
// its keys exactly as the sheet prints it, with a clip selected, then checks the edit, the playhead, the zoom, the tool
// or the playback the person would see. A shortcut added to the registry without saying here what it does fails the
// first test, so the walk cannot quietly fall behind the sheet. The three pane keys of the View section are the menu
// bar's (MenuBar.test.tsx walks them).
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SHORTCUTS, type Combo } from "../timeline/shortcuts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const h = vi.hoisted(() => ({ state: {} as Any }));
vi.mock("../store/editor", () => ({
  useEditor: Object.assign((sel: (s: Any) => unknown) => sel(h.state), { getState: () => h.state }),
  _zoomBounds: { MIN_ZOOM: 4, MAX_ZOOM: 400, DEFAULT_ZOOM: 40 },
}));
vi.mock("../lib/dragSource", () => ({ onDragPoint: () => () => undefined }));

import TimelineEditor from "./TimelineEditor";

const FPS = 30;
const PLAYHEAD = 1; // seconds: frame 30, inside c1
const ZOOM = 40;
const END_FRAME = 90; // the last clip ends here
const timeline = {
  canvas: { width: 1080, height: 1920, fps: FPS },
  tracks: [
    {
      id: "v1",
      kind: "video",
      clips: [
        {
          id: "c1",
          media_ref: "clip.mp4",
          timeline_in: 0,
          timeline_out: 60,
          source_in: 0,
          source_out: 60,
        },
      ],
    },
    {
      id: "a1",
      kind: "audio",
      clips: [
        { id: "au1", kind: "audio", media_ref: "m.mp3", timeline_in: 0, timeline_out: END_FRAME },
      ],
    },
  ],
};

const ACTIONS = [
  "select",
  "selectAll",
  "selectMany",
  "selectForward",
  "selectGap",
  "setPlayhead",
  "setZoom",
  "setTrackScale",
  "setSelectedRange",
  "beginGesture",
  "endGesture",
  "moveClip",
  "moveSelectionBy",
  "nudgeClips",
  "trimClip",
  "trimToPlayhead",
  "rippleTrim",
  "rollEdit",
  "slipClip",
  "slideClip",
  "clipSourceFrames",
  "splitClip",
  "deleteClips",
  "rippleDeleteClip",
  "rippleDeleteGap",
  "duplicateClip",
  "linkClips",
  "unlinkClips",
  "copyClip",
  "pasteClip",
  "undo",
  "redo",
  "addClip",
  "addClips",
  "addTrack",
  "removeTrack",
  "setTrack",
  "setTracks",
  "setTransition",
  "setClipEnabled",
  "setClipProperties",
  "setKeyframe",
  "processImport",
] as const;

beforeEach(() => {
  h.state = {
    timeline,
    selection: "c1",
    get selectedIds(): string[] {
      return h.state.selection ? [h.state.selection] : [];
    },
    selectedGap: null,
    selectedRange: null,
    playhead: PLAYHEAD,
    zoom: ZOOM,
    trackScale: { video: 1, audio: 1 },
    clipboard: null,
    store: null,
    projectId: "p1",
  };
  // copyClip is synchronous in the store; every other action returns a promise the editor may chain on.
  for (const name of ACTIONS)
    h.state[name] = name === "copyClip" ? vi.fn() : vi.fn(() => Promise.resolve(null));
});

const TOOLS = ["pointer", "razor", "slip", "slide", "roll"] as const;
/** The tool whose button shows pressed: the one the next drag on a clip uses. */
const activeTool = (): string[] =>
  TOOLS.filter(
    (t) =>
      screen.getByRole("button", { name: `${t} tool` }).getAttribute("aria-pressed") === "true",
  );
const snapping = (): string | null =>
  screen.getByRole("button", { name: "snapping" }).getAttribute("aria-pressed");

/** Press a combo the way the sheet prints it: its key with exactly the modifiers it names ("any" is not held). */
function press(c: Combo, extra: { shiftKey?: boolean } = {}): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: c.key,
        ctrlKey: c.cmd === true,
        shiftKey: c.shift === true || extra.shiftKey === true,
        altKey: c.alt === true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

const s = (): Any => h.state;
const step = (c: Combo): number => (c.key === "ArrowRight" ? 1 : -1);

/** What each shortcut must do, from the state set up above (clip c1 selected, playhead at 1 s, zoom 40, pointer tool,
 *  snapping on). `before` runs first when the shortcut needs another state to show its effect. */
const DOES: Record<string, { before?: () => void; then: (c: Combo) => void }> = {
  selectAll: { then: () => expect(s().selectAll).toHaveBeenCalledTimes(1) },
  undo: {
    then: () => expect([s().undo.mock.calls.length, s().redo.mock.calls.length]).toEqual([1, 0]),
  },
  redo: {
    then: () => expect([s().redo.mock.calls.length, s().undo.mock.calls.length]).toEqual([1, 0]),
  },
  cut: {
    then: () => {
      expect(s().copyClip).toHaveBeenCalledWith("c1");
      expect(s().deleteClips).toHaveBeenCalledWith(["c1"]);
    },
  },
  copy: {
    then: () => {
      expect(s().copyClip).toHaveBeenCalledWith("c1");
      expect(s().deleteClips).not.toHaveBeenCalled();
    },
  },
  paste: { then: () => expect(s().pasteClip).toHaveBeenCalledTimes(1) },
  duplicate: { then: () => expect(s().duplicateClip).toHaveBeenCalledWith("c1") },
  delete: {
    then: () => {
      expect(s().deleteClips).toHaveBeenCalledWith(["c1"]);
      expect(s().rippleDeleteClip).not.toHaveBeenCalled();
    },
  },
  split: { then: () => expect(s().splitClip).toHaveBeenCalledWith("c1", PLAYHEAD * FPS) },
  toolPointer: {
    before: () => press({ key: "c" }), // from the razor, so the switch back shows
    then: () => expect(activeTool()).toEqual(["pointer"]),
  },
  toolRazor: { then: () => expect(activeTool()).toEqual(["razor"]) },
  toolSlip: { then: () => expect(activeTool()).toEqual(["slip"]) },
  toolSlide: { then: () => expect(activeTool()).toEqual(["slide"]) },
  toolRoll: { then: () => expect(activeTool()).toEqual(["roll"]) },
  snapping: { then: () => expect(snapping()).toBe("false") },
  selectForwardTrack: { then: () => expect(s().selectForward).toHaveBeenCalledWith("track") },
  selectForwardAll: { then: () => expect(s().selectForward).toHaveBeenCalledWith("all") },
  toggleEnabled: { then: () => expect(s().setClipEnabled).toHaveBeenCalledWith(["c1"], false) },
  trimHead: { then: () => expect(s().trimToPlayhead).toHaveBeenCalledWith("c1", "head") },
  trimTail: { then: () => expect(s().trimToPlayhead).toHaveBeenCalledWith("c1", "tail") },
  nudge: {
    then: (c) => {
      expect(s().nudgeClips).toHaveBeenCalledWith(["c1"], step(c));
      expect(s().setPlayhead).not.toHaveBeenCalled();
    },
  },
  deselect: {
    before: () => press({ key: "c" }),
    then: () => {
      expect(s().select).toHaveBeenCalledWith(null);
      expect(activeTool()).toEqual(["pointer"]);
    },
  },
  play: { then: () => expect(played).toBe(1) },
  goStart: { then: () => expect(s().setPlayhead).toHaveBeenCalledWith(0) },
  goEnd: { then: () => expect(s().setPlayhead).toHaveBeenCalledWith(END_FRAME / FPS) },
  step: {
    then: (c) => {
      expect(s().setPlayhead).toHaveBeenCalledWith(PLAYHEAD + step(c) / FPS);
      expect(s().nudgeClips).not.toHaveBeenCalled();
    },
  },
  zoomIn: { then: () => expect(s().setZoom.mock.calls[0][0]).toBeGreaterThan(ZOOM) },
  zoomOut: { then: () => expect(s().setZoom.mock.calls[0][0]).toBeLessThan(ZOOM) },
};

let played = 0;
beforeEach(() => {
  played = 0;
});
const onPlay = () => {
  played += 1;
};

const PANES = SHORTCUTS.filter((sc) => sc.id.startsWith("pane")).map((sc) => sc.id);
const OURS = SHORTCUTS.filter((sc) => !PANES.includes(sc.id));
const ALL_PRESSES = OURS.flatMap((sc) =>
  sc.combos.map((c, i) => [`${sc.id} (${sc.label}), key ${i + 1}: ${c.key}`, sc.id, c] as const),
);

describe("every key the shortcut sheet lists does what it says in the timeline", () => {
  it("says what each shortcut the timeline handles must do, and leaves only the pane keys to the menu bar", () => {
    expect(Object.keys(DOES).sort()).toEqual(OURS.map((sc) => sc.id).sort());
    expect(PANES.sort()).toEqual(["paneAssistant", "paneInspector", "paneLibrary"]);
  });

  it.each(ALL_PRESSES)("%s", (_name, id, combo) => {
    window.addEventListener("artdaddy:toggle-play", onPlay);
    try {
      render(<TimelineEditor />);
      DOES[id].before?.();
      press(combo);
      DOES[id].then(combo);
    } finally {
      window.removeEventListener("artdaddy:toggle-play", onPlay);
    }
  });
});

describe("the modifiers the sheet's notes promise", () => {
  // "Hold Shift to close the gap behind it (ripple delete)."
  it("Shift with Delete or Backspace ripple-deletes the clip instead of lifting it", () => {
    render(<TimelineEditor />);
    for (const c of SHORTCUTS.find((sc) => sc.id === "delete")!.combos)
      press(c, { shiftKey: true });
    expect(s().rippleDeleteClip.mock.calls).toEqual([["c1"], ["c1"]]);
    expect(s().deleteClips).not.toHaveBeenCalled();
  });

  // "Shift nudges 5 frames at a time." / "Shift steps 5 frames at a time."
  it("Shift nudges the clip and steps the playhead five frames at a time", () => {
    render(<TimelineEditor />);
    for (const c of SHORTCUTS.find((sc) => sc.id === "nudge")!.combos) press(c, { shiftKey: true });
    for (const c of SHORTCUTS.find((sc) => sc.id === "step")!.combos) press(c, { shiftKey: true });
    expect(s().nudgeClips.mock.calls).toEqual([
      [["c1"], -5],
      [["c1"], 5],
    ]);
    expect(s().setPlayhead.mock.calls).toEqual([[PLAYHEAD - 5 / FPS], [PLAYHEAD + 5 / FPS]]);
  });

  it("enable / disable turns a disabled clip back on", () => {
    h.state.timeline = {
      ...timeline,
      tracks: [
        { ...timeline.tracks[0], clips: [{ ...timeline.tracks[0].clips[0], disabled: true }] },
        timeline.tracks[1],
      ],
    };
    render(<TimelineEditor />);
    press(SHORTCUTS.find((sc) => sc.id === "toggleEnabled")!.combos[0]);
    expect(s().setClipEnabled).toHaveBeenCalledWith(["c1"], true);
  });

  // The other direction: a key that edits a clip does nothing to the document when nothing is selected.
  it("leaves the project alone when no clip is selected", () => {
    h.state.selection = null;
    render(<TimelineEditor />);
    for (const id of [
      "cut",
      "copy",
      "duplicate",
      "delete",
      "split",
      "toggleEnabled",
      "trimHead",
      "trimTail",
      "nudge",
    ])
      for (const c of SHORTCUTS.find((sc) => sc.id === id)!.combos) press(c);
    const edits = [
      "copyClip",
      "deleteClips",
      "duplicateClip",
      "splitClip",
      "setClipEnabled",
      "trimToPlayhead",
      "nudgeClips",
    ];
    expect(edits.filter((name) => s()[name].mock.calls.length > 0)).toEqual([]);
  });

  // A key pressed while typing a name or a caption is text, not an edit.
  it("does nothing while a text field has the focus", () => {
    render(
      <>
        <input aria-label="name" />
        <TimelineEditor />
      </>,
    );
    const field = screen.getByRole("textbox", { name: "name" });
    field.focus();
    for (const sc of OURS)
      for (const c of sc.combos)
        act(() => {
          field.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: c.key,
              ctrlKey: c.cmd === true,
              shiftKey: c.shift === true,
              altKey: c.alt === true,
              bubbles: true,
            }),
          );
        });
    const called = ACTIONS.filter((name) => s()[name].mock.calls.length > 0);
    expect(called).toEqual([]);
    expect(activeTool()).toEqual(["pointer"]);
    expect(snapping()).toBe("true");
    // The control: the same kind of key from outside the field does reach the timeline, so the silence above is the
    // field's doing and not a key that never arrived.
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(s().setPlayhead).toHaveBeenCalledWith(0);
  });
});
