import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const h = vi.hoisted(() => ({ state: {} as any }));

vi.mock("../store/editor", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useEditor: Object.assign((sel: any) => sel(h.state), { getState: () => h.state }),
  _zoomBounds: { MIN_ZOOM: 4, MAX_ZOOM: 400, DEFAULT_ZOOM: 40 },
}));

// Captures the drag-position subscriber so a drag can be simulated without a real pointer.
const drag = vi.hoisted(() => ({
  point: null as
    ((p: { payload: { ref: string; name: string }; x: number; y: number } | null) => void) | null,
}));
vi.mock("../lib/dragSource", () => ({
  onDragPoint: (fn: (typeof drag)["point"]) => {
    drag.point = fn;
    return () => {
      drag.point = null;
    };
  },
}));

import TimelineEditor from "./TimelineEditor";

const timeline = {
  canvas: { width: 1080, height: 1920, fps: 30 },
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
      clips: [{ id: "au1", kind: "audio", media_ref: "m.mp3", timeline_in: 0, timeline_out: 90 }],
    },
  ],
};

beforeEach(() => {
  h.state = {
    timeline,
    selection: null,
    // selectedIds mirrors the store invariant (it tracks the single `selection`);
    // these tests are single-select, so they only need to set `selection`.
    get selectedIds(): string[] {
      return h.state.selection ? [h.state.selection] : [];
    },
    playhead: 0,
    zoom: 40,
    select: vi.fn(),
    selectAll: vi.fn(),
    setPlayhead: vi.fn(),
    setZoom: vi.fn(),
    beginGesture: vi.fn(),
    endGesture: vi.fn(),
    moveClip: vi.fn(() => Promise.resolve()),
    trimClip: vi.fn(() => Promise.resolve()),
    clipSourceFrames: vi.fn(() => Promise.resolve(null)),
    splitClip: vi.fn(() => Promise.resolve()),
    deleteClips: vi.fn(() => Promise.resolve()),
    rippleDeleteClip: vi.fn(() => Promise.resolve()),
    duplicateClip: vi.fn(() => Promise.resolve()),
    linkClips: vi.fn(() => Promise.resolve()),
    unlinkClips: vi.fn(() => Promise.resolve()),
    copyClip: vi.fn(),
    pasteClip: vi.fn(() => Promise.resolve()),
    clipboard: null,
    undo: vi.fn(() => Promise.resolve()),
    redo: vi.fn(() => Promise.resolve()),
    addClip: vi.fn(() => Promise.resolve()),
    addTrack: vi.fn(() => Promise.resolve()),
    removeTrack: vi.fn(() => Promise.resolve()),
    setTrack: vi.fn(() => Promise.resolve()),
    setTracks: vi.fn(() => Promise.resolve()),
    setTransition: vi.fn(() => Promise.resolve()),
    trackScale: { video: 1, audio: 1 },
    setTrackScale: vi.fn(),
    store: null,
    setSelectedRange: vi.fn(),
    selectedRange: null,
    selectMany: vi.fn(),
    selectGap: vi.fn(),
    selectedGap: null,
    rippleDeleteGap: vi.fn(),
  };
});

const key = (init: KeyboardEventInit) => window.dispatchEvent(new KeyboardEvent("keydown", init));
const ptr = (type: string, init: MouseEventInit) =>
  window.dispatchEvent(new MouseEvent(type, init));

describe("TimelineEditor", () => {
  it("shows a placeholder when there is no timeline", () => {
    h.state.timeline = null;
    render(<TimelineEditor />);
    expect(screen.getByText(/No timeline yet/)).toBeInTheDocument();
  });

  it("renders track labels and clips", () => {
    render(<TimelineEditor />);
    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(screen.getByText("a1")).toBeInTheDocument();
    expect(screen.getByText("clip.mp4")).toBeInTheDocument();
    expect(screen.getByText(/2 tracks · 2 clips/)).toBeInTheDocument();
  });

  it("clicking a clip selects it", () => {
    render(<TimelineEditor />);
    fireEvent.click(screen.getByTitle("clip.mp4"));
    expect(h.state.select).toHaveBeenCalledWith("c1", { additive: false });
  });

  it("Delete lifts, Shift+Delete ripple-deletes the selected clip", () => {
    h.state.selection = "c1";
    render(<TimelineEditor />);
    key({ key: "Delete" });
    expect(h.state.deleteClips).toHaveBeenCalledWith(["c1"]);
    key({ key: "Delete", shiftKey: true });
    expect(h.state.rippleDeleteClip).toHaveBeenCalledWith("c1");
  });

  it("Ctrl+K splits the selected clip at the playhead, and S no longer does", () => {
    h.state.selection = "c1";
    h.state.playhead = 1; // 1s @ 30fps -> frame 30
    render(<TimelineEditor />);
    key({ key: "k", ctrlKey: true });
    expect(h.state.splitClip).toHaveBeenCalledWith("c1", 30);
    // S is the snapping toggle now. If it still split, users would cut clips by accident.
    h.state.splitClip.mockClear();
    key({ key: "s" });
    expect(h.state.splitClip).not.toHaveBeenCalled();
  });

  it("Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo", () => {
    render(<TimelineEditor />);
    key({ key: "z", ctrlKey: true });
    expect(h.state.undo).toHaveBeenCalled();
    key({ key: "z", ctrlKey: true, shiftKey: true });
    expect(h.state.redo).toHaveBeenCalledTimes(1);
    key({ key: "y", ctrlKey: true });
    expect(h.state.redo).toHaveBeenCalledTimes(2);
  });

  it("arrow keys step the playhead by a frame", () => {
    render(<TimelineEditor />);
    key({ key: "ArrowRight" });
    expect(h.state.setPlayhead).toHaveBeenCalledWith(1 / 30);
    key({ key: "ArrowLeft" });
    expect(h.state.setPlayhead).toHaveBeenCalledWith(0);
  });

  it("ignores shortcuts while typing in an input", () => {
    h.state.selection = "c1";
    render(<TimelineEditor />);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(h.state.deleteClips).not.toHaveBeenCalled();
    input.remove();
  });

  it("zoom buttons and Fit call setZoom", () => {
    render(<TimelineEditor />);
    fireEvent.click(screen.getByTitle("Zoom in"));
    expect(h.state.setZoom).toHaveBeenCalledWith(40 * 1.3);
    fireEvent.click(screen.getByTitle("Zoom out"));
    expect(h.state.setZoom).toHaveBeenCalledWith(40 / 1.3);
    fireEvent.click(screen.getByTitle("Fit"));
    expect(h.state.setZoom).toHaveBeenCalledTimes(3);
  });

  it("scrubbing the ruler sets the playhead", () => {
    render(<TimelineEditor />);
    fireEvent.pointerDown(screen.getByLabelText("timeline scrubber"), { clientX: 40 }); // 40px @ 40px/s -> 1s
    expect(h.state.setPlayhead).toHaveBeenCalledWith(1);
  });

  it("dragging a clip body moves it (beginGesture + moveClip)", () => {
    render(<TimelineEditor />);
    fireEvent.pointerDown(screen.getByTitle("clip.mp4"), { clientX: 0 });
    expect(h.state.beginGesture).toHaveBeenCalled();
    ptr("pointermove", { clientX: 40 }); // +40px -> +30 frames
    ptr("pointerup", {});
    expect(h.state.moveClip).toHaveBeenCalledWith("c1", {
      toTimelineIn: 30,
      toTrack: undefined,
      duplicate: false,
      ignoreLinks: false,
    });
  });

  // c1 is 60 frames long; the audio clip ends at 90. Dropping c1 at frame 33 puts
  // its TAIL at 93 — 3 frames from 90, inside the 8px threshold — while its head
  // (33) is nowhere near a target. Head-only snapping leaves it stranded at 33.
  it("a move snaps by the clip's TAIL when only that edge is near a target", () => {
    render(<TimelineEditor />);
    fireEvent.pointerDown(screen.getByTitle("clip.mp4"), { clientX: 0 });
    ptr("pointermove", { clientX: 44 }); // 44px -> frame 33
    ptr("pointerup", {});
    expect(h.state.moveClip).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ toTimelineIn: 30 }),
    );
  });

  it("a move still snaps by the clip's HEAD", () => {
    render(<TimelineEditor />);
    fireEvent.pointerDown(screen.getByTitle("clip.mp4"), { clientX: 0 });
    ptr("pointermove", { clientX: 116 }); // 116px -> frame 87, 3 frames from 90
    ptr("pointerup", {});
    expect(h.state.moveClip).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ toTimelineIn: 90 }),
    );
  });

  it("the snapping TOGGLE bypasses snapping on BOTH edges", () => {
    // This used to be "hold Alt". Alt is the override key now (duplicate / one half of a
    // linked pair / ignore the trim handle), and snapping is a mode, as in Premiere.
    render(<TimelineEditor />);
    fireEvent.click(screen.getByLabelText("snapping"));
    fireEvent.pointerDown(screen.getByTitle("clip.mp4"), { clientX: 0 });
    ptr("pointermove", { clientX: 44 }); // tail would snap 93 -> 90
    ptr("pointerup", {});
    expect(h.state.moveClip).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ toTimelineIn: 33 }),
    );
  });

  it("Alt+drag DUPLICATES and detaches the link, instead of bypassing snapping", () => {
    render(<TimelineEditor />);
    fireEvent.pointerDown(screen.getByTitle("clip.mp4"), { clientX: 0, altKey: true });
    ptr("pointermove", { clientX: 44, altKey: true });
    ptr("pointerup", {});
    expect(h.state.moveClip).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ duplicate: true, ignoreLinks: true }),
    );
    // ...and Alt did NOT bypass the snap: the tail still pulled to 90.
    expect(h.state.moveClip).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ toTimelineIn: 30 }),
    );
  });

  it("Alt on a trim handle moves instead of trimming", () => {
    render(<TimelineEditor />);
    const clip = screen.getByTitle("clip.mp4");
    fireEvent.pointerDown(within(clip).getByLabelText("trim end"), { clientX: 80, altKey: true });
    ptr("pointermove", { clientX: 120, altKey: true });
    ptr("pointerup", {});
    expect(h.state.trimClip).not.toHaveBeenCalled();
    expect(h.state.moveClip).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ duplicate: true }),
    );
  });

  it("a press that never moves writes NOTHING, on the body or either handle", () => {
    // The trim path follows the pointer's ABSOLUTE frame and the handle's centre sits inside the
    // clip's edge, so a click on it used to commit a several-frame trim. Snapping hid that by
    // pulling the edge back onto itself; the sweep caught it the moment snapping became a mode.
    render(<TimelineEditor />);
    const clip = screen.getByTitle("clip.mp4");
    for (const target of [
      clip,
      within(clip).getByLabelText("trim start"),
      within(clip).getByLabelText("trim end"),
    ]) {
      fireEvent.pointerDown(target, { clientX: 80 });
      ptr("pointerup", {});
    }
    expect(h.state.trimClip).not.toHaveBeenCalled();
    expect(h.state.moveClip).not.toHaveBeenCalled();
  });

  it("a purely VERTICAL drag still counts as movement — it changes track", () => {
    // The failure direction for the guard above. An X-only "did it move?" test refuses every
    // cross-track drag, because dragging a clip straight down moves X not at all.
    render(<TimelineEditor />);
    fireEvent.pointerDown(screen.getByTitle("clip.mp4"), { clientX: 40, clientY: 10 });
    ptr("pointermove", { clientX: 40, clientY: 90 });
    ptr("pointerup", {});
    expect(h.state.moveClip).toHaveBeenCalled();
  });

  it("dragging a trim handle trims the clip", () => {
    render(<TimelineEditor />);
    const clip = screen.getByTitle("clip.mp4");
    fireEvent.pointerDown(within(clip).getByLabelText("trim end"), { clientX: 80 }); // frame 60
    ptr("pointermove", { clientX: 100 }); // frame 75
    ptr("pointerup", {});
    expect(h.state.trimClip).toHaveBeenCalledWith("c1", { timeline_out: 75, source_out: 75 });
  });

  describe("a trim never invents a source window", () => {
    // A still has no source_in/source_out. `Number(undefined) || 0` used to turn that
    // absence into a real 0, so the drag sent a lone source_out; validateTimeline rejects
    // a half-written window, applyOp discarded the whole edit, and the clip snapped back.
    const still = {
      canvas: { width: 1080, height: 1920, fps: 30 },
      tracks: [
        {
          id: "v1",
          kind: "video",
          clips: [
            { id: "img", kind: "image", media_ref: "p.png", timeline_in: 0, timeline_out: 60 },
          ],
        },
      ],
    };

    it("sends NO source edge when the clip has none (tail)", () => {
      h.state.timeline = still;
      render(<TimelineEditor />);
      const clip = screen.getByTitle("p.png");
      fireEvent.pointerDown(within(clip).getByLabelText("trim end"), { clientX: 80 });
      ptr("pointermove", { clientX: 140 });
      ptr("pointerup", {});
      expect(h.state.trimClip).toHaveBeenCalledTimes(1);
      const [, edges] = h.state.trimClip.mock.calls[0];
      expect(edges).not.toHaveProperty("source_out");
      expect(edges.timeline_out).toBeGreaterThan(60);
    });

    it("sends NO source edge when the clip has none (head)", () => {
      h.state.timeline = still;
      render(<TimelineEditor />);
      const clip = screen.getByTitle("p.png");
      fireEvent.pointerDown(within(clip).getByLabelText("trim start"), { clientX: 0 });
      ptr("pointermove", { clientX: 30 });
      ptr("pointerup", {});
      const [, edges] = h.state.trimClip.mock.calls[0];
      expect(edges).not.toHaveProperty("source_in");
    });

    it("never asks for a length probe on a clip with no window", () => {
      // Probing a still is a pointless ffprobe on every grab of the handle.
      h.state.timeline = still;
      render(<TimelineEditor />);
      const clip = screen.getByTitle("p.png");
      fireEvent.pointerDown(within(clip).getByLabelText("trim end"), { clientX: 80 });
      ptr("pointerup", {});
      expect(h.state.clipSourceFrames).not.toHaveBeenCalled();
    });
  });

  it("the tail ghost STOPS at the end of the footage", async () => {
    // The ghost used to be unbounded while the commit clamped, so the clip visibly sprang
    // back on release. Source is 90 frames from in-point 0 -> the tail cannot pass 90.
    h.state.clipSourceFrames = vi.fn(() => Promise.resolve(90));
    render(<TimelineEditor />);
    const clip = screen.getByTitle("clip.mp4");
    fireEvent.pointerDown(within(clip).getByLabelText("trim end"), { clientX: 80 });
    await Promise.resolve();
    await Promise.resolve();
    ptr("pointermove", { clientX: 900 }); // way past the end of the media
    ptr("pointerup", {});
    const [, edges] = h.state.trimClip.mock.calls[0];
    expect(edges.timeline_out).toBe(90);
  });

  it("the head ghost STOPS at source frame 0", async () => {
    // Dragging the head LEFT consumes footage before source_in. With source_in 0 there is
    // none, so the head cannot move earlier than where it already is.
    h.state.clipSourceFrames = vi.fn(() => Promise.resolve(90));
    render(<TimelineEditor />);
    const clip = screen.getByTitle("clip.mp4");
    fireEvent.pointerDown(within(clip).getByLabelText("trim start"), { clientX: 0 });
    await Promise.resolve();
    ptr("pointermove", { clientX: -400 });
    ptr("pointerup", {});
    const [, edges] = h.state.trimClip.mock.calls[0];
    expect(edges.timeline_in).toBe(0);
  });

  describe("razor tool", () => {
    it("cuts where you CLICK, not at the playhead", () => {
      // The distinction is the entire reason the tool exists: S already splits at the
      // playhead, so a razor that ignored the click position would be redundant.
      h.state.playhead = 0;
      render(<TimelineEditor />);
      fireEvent.click(screen.getByLabelText("razor tool"));
      fireEvent.pointerDown(screen.getByTitle("clip.mp4"), { clientX: 40 }); // 40px -> frame 30
      expect(h.state.splitClip).toHaveBeenCalledWith("c1", 30);
      expect(h.state.moveClip).not.toHaveBeenCalled(); // and it must NOT start a drag
    });

    it("refuses a cut on the clip's own edge, which would make an empty piece", () => {
      render(<TimelineEditor />);
      fireEvent.click(screen.getByLabelText("razor tool"));
      fireEvent.pointerDown(screen.getByTitle("clip.mp4"), { clientX: 0 }); // frame 0 == timeline_in
      expect(h.state.splitClip).not.toHaveBeenCalled();
    });

    it("C arms the razor, V and Escape put the pointer back", () => {
      // fireEvent (not the bare window dispatch the other tests use) so React flushes the
      // re-render — these assert on RENDERED state, not on a mock call.
      render(<TimelineEditor />);
      fireEvent.keyDown(window, { key: "c" });
      expect(screen.getByLabelText("razor tool")).toHaveAttribute("aria-pressed", "true");
      fireEvent.keyDown(window, { key: "v" });
      expect(screen.getByLabelText("pointer tool")).toHaveAttribute("aria-pressed", "true");
      fireEvent.keyDown(window, { key: "c" });
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.getByLabelText("pointer tool")).toHaveAttribute("aria-pressed", "true");
    });

    it("Ctrl+C still copies rather than arming the razor", () => {
      h.state.selection = "c1";
      render(<TimelineEditor />);
      fireEvent.keyDown(window, { key: "c", ctrlKey: true });
      expect(h.state.copyClip).toHaveBeenCalledWith("c1");
      expect(screen.getByLabelText("razor tool")).toHaveAttribute("aria-pressed", "false");
    });
  });

  // Every modal tool, not just the razor it was reported on: they share one handler, so
  // verifying the razor alone would be evidence about the razor alone. `aria-pressed` is a
  // TOGGLE contract — a button that can be pressed and never released lies to the user and to
  // assistive tech, and left the only way back to the pointer being a key the user has to know.
  describe.each(["razor tool", "slip tool", "slide tool", "roll tool"])(
    "%s button",
    (label: string) => {
      it("releases back to the pointer when clicked again", () => {
        render(<TimelineEditor />);
        const btn = screen.getByLabelText(label);

        fireEvent.click(btn);
        expect(btn).toHaveAttribute("aria-pressed", "true");

        fireEvent.click(btn);
        expect(btn).toHaveAttribute("aria-pressed", "false");
        expect(screen.getByLabelText("pointer tool")).toHaveAttribute("aria-pressed", "true");
      });

      it("still switches straight to another tool without passing through the pointer", () => {
        render(<TimelineEditor />);
        fireEvent.click(screen.getByLabelText(label));
        const other = label === "razor tool" ? "slip tool" : "razor tool";
        fireEvent.click(screen.getByLabelText(other));
        expect(screen.getByLabelText(other)).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByLabelText(label)).toHaveAttribute("aria-pressed", "false");
      });
    },
  );

  describe("marquee select", () => {
    it("selects every clip the sweep touches, in ONE selection update", () => {
      const { container } = render(<TimelineEditor />);
      const lanes = container.querySelector('[data-track-id="v1"]')!.parentElement!.parentElement!;
      fireEvent.pointerDown(lanes, { button: 0, clientX: 0, clientY: 0 });
      ptr("pointermove", { clientX: 200, clientY: 200 });
      ptr("pointerup", { clientX: 200, clientY: 200 });
      expect(h.state.selectMany).toHaveBeenCalledTimes(1);
      expect(h.state.selectMany.mock.calls[0][0].sort()).toEqual(["au1", "c1"]);
    });

    it("a click that barely moves is not a marquee", () => {
      const { container } = render(<TimelineEditor />);
      const lanes = container.querySelector('[data-track-id="v1"]')!.parentElement!.parentElement!;
      fireEvent.pointerDown(lanes, { button: 0, clientX: 10, clientY: 10 });
      ptr("pointermove", { clientX: 11, clientY: 11 });
      ptr("pointerup", { clientX: 11, clientY: 11 });
      expect(h.state.selectMany).not.toHaveBeenCalled();
    });

    it("the razor tool does not start a marquee", () => {
      const { container } = render(<TimelineEditor />);
      fireEvent.click(screen.getByLabelText("razor tool"));
      const lanes = container.querySelector('[data-track-id="v1"]')!.parentElement!.parentElement!;
      fireEvent.pointerDown(lanes, { button: 0, clientX: 0, clientY: 0 });
      ptr("pointermove", { clientX: 200, clientY: 200 });
      ptr("pointerup", { clientX: 200, clientY: 200 });
      expect(h.state.selectMany).not.toHaveBeenCalled();
    });
  });

  // The library -> timeline gesture is pointer-based now (Tauri owns the drag handler once file
  // drops are enabled), so the lane is reached by a CustomEvent from the drag source rather than
  // by a dataTransfer payload. What matters is unchanged: the clip lands on the lane under the
  // cursor, at the frame under the cursor.
  it("a library drag released on a lane adds the clip at the drop frame", () => {
    const { container } = render(<TimelineEditor />);
    const lane = container.querySelector('[data-track-id="v1"]')! as HTMLElement;
    lane.dispatchEvent(
      new CustomEvent("artdaddy:clip-drop", { detail: { ref: "clip2.mp4", x: 40, y: 0 } }),
    );
    // 40px @ 40px/s, 30fps -> frame 30
    expect(h.state.addClip).toHaveBeenCalledWith("clip2.mp4", "v1", 30);
  });

  // The landing preview. What matters is not that a box appears but that it appears WHERE THE
  // CLIP LANDS — a preview computed apart from the commit is how a ghost ends up promising a
  // frame the drop then ignores.
  describe("drop landing preview", () => {
    const overLane = (container: HTMLElement, id: string): HTMLElement => {
      const lane = container.querySelector(`[data-track-id="${id}"]`) as HTMLElement;
      lane.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 40 }) as DOMRect;
      document.elementFromPoint = () => lane;
      return lane;
    };

    it("shows nothing until a drag is over a lane", () => {
      render(<TimelineEditor />);
      expect(screen.queryByTestId("drop-ghost")).toBeNull();
    });

    it("marks the landing frame, and clears when the drag ends", () => {
      const { container } = render(<TimelineEditor />);
      overLane(container, "v1");
      act(() => drag.point?.({ payload: { ref: "clip2.mp4", name: "clip2" }, x: 40, y: 10 }));
      // 40px @ 40px/s, 30fps -> frame 30
      expect(screen.getByTestId("drop-ghost").getAttribute("data-frame")).toBe("30");
      act(() => drag.point?.(null));
      expect(screen.queryByTestId("drop-ghost")).toBeNull();
    });

    // x=86px is ~6px from the clip edge at frame 60, INSIDE the 12px snap radius — so snapping
    // actually changes the answer here. Pick a point where it doesn't and this test passes even
    // when the preview and the commit are computed by different code.
    it("previews the SAME frame the drop then writes", () => {
      const { container } = render(<TimelineEditor />);
      const lane = overLane(container, "v1");
      act(() => drag.point?.({ payload: { ref: "clip2.mp4", name: "clip2" }, x: 86, y: 10 }));
      const previewed = Number(screen.getByTestId("drop-ghost").getAttribute("data-frame"));
      expect(previewed).toBe(60); // snapped to the neighbouring clip's edge, not the raw 65
      lane.dispatchEvent(
        new CustomEvent("artdaddy:clip-drop", { detail: { ref: "clip2.mp4", x: 86, y: 10 } }),
      );
      expect(h.state.addClip).toHaveBeenCalledWith("clip2.mp4", "v1", previewed);
    });

    it("follows the pointer onto another lane", () => {
      const { container } = render(<TimelineEditor />);
      overLane(container, "v1");
      act(() => drag.point?.({ payload: { ref: "m.mp3", name: "m" }, x: 40, y: 10 }));
      expect(
        screen.getByTestId("drop-ghost").closest("[data-track-id]")?.getAttribute("data-track-id"),
      ).toBe("v1");
      overLane(container, "a1");
      act(() => drag.point?.({ payload: { ref: "m.mp3", name: "m" }, x: 40, y: 80 }));
      expect(
        screen.getByTestId("drop-ghost").closest("[data-track-id]")?.getAttribute("data-track-id"),
      ).toBe("a1");
    });

    it("never previews a negative frame when dragged left of zero", () => {
      const { container } = render(<TimelineEditor />);
      const lane = container.querySelector('[data-track-id="v1"]') as HTMLElement;
      lane.getBoundingClientRect = () => ({ left: 200, top: 0, width: 800, height: 40 }) as DOMRect;
      document.elementFromPoint = () => lane;
      act(() => drag.point?.({ payload: { ref: "clip2.mp4", name: "clip2" }, x: 10, y: 10 }));
      expect(
        Number(screen.getByTestId("drop-ghost").getAttribute("data-frame")),
      ).toBeGreaterThanOrEqual(0);
    });

    it("clears the ghost once the clip is dropped", () => {
      const { container } = render(<TimelineEditor />);
      const lane = overLane(container, "v1");
      act(() => drag.point?.({ payload: { ref: "clip2.mp4", name: "clip2" }, x: 40, y: 10 }));
      expect(screen.queryByTestId("drop-ghost")).not.toBeNull();
      act(
        () =>
          void lane.dispatchEvent(
            new CustomEvent("artdaddy:clip-drop", { detail: { ref: "clip2.mp4", x: 40, y: 10 } }),
          ),
      );
      expect(screen.queryByTestId("drop-ghost")).toBeNull();
    });

    // Files dragged from Explorer/Finder arrive as a routed window event, not a pointer drag.
    // The real osDrop subscriber runs here (it is not mocked), so a change to the router's
    // payload shape fails this test rather than silently dropping the ghost.
    it("previews an OS file drag over a lane, and clears it on leave", () => {
      const { container } = render(<TimelineEditor />);
      overLane(container, "v1");
      act(
        () =>
          void window.dispatchEvent(
            new CustomEvent("artdaddy:os-drag-over", { detail: { target: "track", x: 86, y: 10 } }),
          ),
      );
      expect(screen.getByTestId("drop-ghost").getAttribute("data-frame")).toBe("60");

      act(
        () => void window.dispatchEvent(new CustomEvent("artdaddy:os-drag-over", { detail: null })),
      );
      expect(screen.queryByTestId("drop-ghost")).toBeNull();
    });

    it("shows no ghost when an OS drag is over something other than a lane", () => {
      const { container } = render(<TimelineEditor />);
      overLane(container, "v1");
      act(
        () =>
          void window.dispatchEvent(
            new CustomEvent("artdaddy:os-drag-over", {
              detail: { target: "library", x: 86, y: 10 },
            }),
          ),
      );
      expect(screen.queryByTestId("drop-ghost")).toBeNull();
    });
  });

  it("lands on the lane it was released over, not the first one", () => {
    // The failure direction: routing by anything other than the released element would drop
    // every clip onto whichever lane subscribed first.
    const { container } = render(<TimelineEditor />);
    const audio = container.querySelector('[data-track-id="a1"]')! as HTMLElement;
    audio.dispatchEvent(
      new CustomEvent("artdaddy:clip-drop", { detail: { ref: "music.mp3", x: 40, y: 0 } }),
    );
    expect(h.state.addClip).toHaveBeenCalledWith("music.mp3", "a1", 30);
  });

  it("ignores a drop that carries no ref", () => {
    const { container } = render(<TimelineEditor />);
    const lane = container.querySelector('[data-track-id="a1"]')! as HTMLElement;
    lane.dispatchEvent(new CustomEvent("artdaddy:clip-drop", { detail: { ref: "", x: 40, y: 0 } }));
    expect(h.state.addClip).not.toHaveBeenCalled();
  });

  it("renders keyframe diamonds on the selected clip and seeks on click", () => {
    h.state.timeline = {
      canvas: { width: 1080, height: 1920, fps: 30 },
      tracks: [
        {
          id: "v1",
          kind: "video",
          clips: [
            {
              id: "c1",
              source: "clip.mp4",
              timeline_in: 10,
              timeline_out: 70,
              opacity: [
                { t: 0, v: 1 },
                { t: 30, v: 0 },
              ],
            },
          ],
        },
      ],
    };
    h.state.selection = "c1";
    render(<TimelineEditor />);
    expect(screen.getByLabelText("keyframe at 0")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("keyframe at 30"));
    expect(h.state.setPlayhead).toHaveBeenCalledWith((10 + 30) / 30); // timeline_in + t, in seconds
  });

  it("shows keyframe diamonds only for the selected clip", () => {
    h.state.timeline = {
      canvas: { width: 1080, height: 1920, fps: 30 },
      tracks: [
        {
          id: "v1",
          kind: "video",
          clips: [
            {
              id: "c1",
              source: "clip.mp4",
              timeline_in: 0,
              timeline_out: 60,
              opacity: [
                { t: 0, v: 1 },
                { t: 30, v: 0 },
              ],
            },
          ],
        },
      ],
    };
    h.state.selection = null;
    render(<TimelineEditor />);
    expect(screen.queryByLabelText("keyframe at 30")).not.toBeInTheDocument();
  });

  it("add-track buttons call addTrack with the kind", () => {
    render(<TimelineEditor />);
    fireEvent.click(screen.getByTitle("Add video track"));
    fireEvent.click(screen.getByTitle("Add audio track"));
    fireEvent.click(screen.getByTitle("Add text track"));
    expect(h.state.addTrack.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      "video",
      "audio",
      "text",
    ]);
  });

  it("mute/hide toggles write via setTrack", () => {
    render(<TimelineEditor />);
    fireEvent.click(screen.getByLabelText("hide v1")); // video track -> hide
    expect(h.state.setTrack).toHaveBeenCalledWith("v1", { hidden: true });
    fireEvent.click(screen.getByLabelText("mute a1")); // audio track -> mute
    expect(h.state.setTrack).toHaveBeenCalledWith("a1", { mute: true });
  });

  it("sync-lock toggle releases a locked track", () => {
    render(<TimelineEditor />);
    fireEvent.click(screen.getByLabelText("sync lock v1")); // default (locked) -> release
    expect(h.state.setTrack).toHaveBeenCalledWith("v1", { sync_locked: false });
  });

  it("sync-lock toggle re-locks a released track", () => {
    h.state.timeline = {
      canvas: { width: 1080, height: 1920, fps: 30 },
      tracks: [{ id: "v1", kind: "video", sync_locked: false, clips: [] }],
    };
    render(<TimelineEditor />);
    fireEvent.click(screen.getByLabelText("sync lock v1")); // released -> lock
    expect(h.state.setTrack).toHaveBeenCalledWith("v1", { sync_locked: true });
  });

  it("deleting a track confirms when it has clips, then calls removeTrack", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<TimelineEditor />);
    fireEvent.click(screen.getByLabelText("delete v1"));
    await waitFor(() => expect(h.state.removeTrack).toHaveBeenCalledWith("v1"));
    expect(confirm).toHaveBeenCalled();
    confirm.mockReturnValue(false);
    fireEvent.click(screen.getByLabelText("delete a1"));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    expect(h.state.removeTrack).toHaveBeenCalledTimes(1); // cancelled
    confirm.mockRestore();
  });

  it("right-click opens a context menu whose items call the ops", () => {
    render(<TimelineEditor />);
    fireEvent.contextMenu(screen.getByTitle("clip.mp4"));
    expect(h.state.select).toHaveBeenCalledWith("c1");
    fireEvent.click(screen.getByText("Split at playhead"));
    expect(h.state.splitClip).toHaveBeenCalledWith("c1", 0); // playhead 0 -> frame 0
    fireEvent.contextMenu(screen.getByTitle("clip.mp4"));
    fireEvent.click(screen.getByText("Ripple delete"));
    expect(h.state.rippleDeleteClip).toHaveBeenCalledWith("c1");
    fireEvent.contextMenu(screen.getByTitle("clip.mp4"));
    fireEvent.click(screen.getByText("Delete"));
    expect(h.state.deleteClips).toHaveBeenCalledWith(["c1"]);
  });

  it("clicking the backdrop closes the context menu", () => {
    render(<TimelineEditor />);
    fireEvent.contextMenu(screen.getByTitle("clip.mp4"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("menu").parentElement!);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("right-clicking the backdrop also closes the context menu", () => {
    render(<TimelineEditor />);
    fireEvent.contextMenu(screen.getByTitle("clip.mp4"));
    fireEvent.contextMenu(screen.getByRole("menu").parentElement!);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("toggling an already-hidden track shows it again", () => {
    h.state.timeline = {
      canvas: { width: 1080, height: 1920, fps: 30 },
      tracks: [{ id: "v1", kind: "video", hidden: true, clips: [] }],
    };
    render(<TimelineEditor />);
    fireEvent.click(screen.getByLabelText("hide v1"));
    expect(h.state.setTrack).toHaveBeenCalledWith("v1", { hidden: false });
  });

  it("Duplicate (menu + Ctrl+D) calls duplicateClip", () => {
    h.state.selection = "c1";
    render(<TimelineEditor />);
    fireEvent.contextMenu(screen.getByTitle("clip.mp4"));
    fireEvent.click(screen.getByText("Duplicate"));
    expect(h.state.duplicateClip).toHaveBeenCalledWith("c1");
    key({ key: "d", ctrlKey: true });
    expect(h.state.duplicateClip).toHaveBeenCalledTimes(2);
  });

  it("Link (menu) links the multi-selected clips", () => {
    Object.defineProperty(h.state, "selectedIds", { value: ["c1", "au1"], configurable: true });
    render(<TimelineEditor />);
    fireEvent.contextMenu(screen.getByTitle("clip.mp4"));
    fireEvent.click(screen.getByText(/Link 2 clips/));
    expect(h.state.linkClips).toHaveBeenCalledWith(["c1", "au1"]);
  });

  it("Unlink (menu) unlinks a linked clip", () => {
    h.state.timeline = {
      canvas: { width: 1080, height: 1920, fps: 30 },
      tracks: [
        {
          id: "v1",
          kind: "video",
          clips: [
            { id: "c1", media_ref: "clip.mp4", timeline_in: 0, timeline_out: 60, link_group: "g" },
          ],
        },
      ],
    };
    render(<TimelineEditor />);
    fireEvent.contextMenu(screen.getByTitle("clip.mp4"));
    fireEvent.click(screen.getByText("Unlink"));
    expect(h.state.unlinkClips).toHaveBeenCalledWith(["c1"]);
  });

  it("Copy (menu + Ctrl+C) and Paste (Ctrl+V) call the clipboard actions", () => {
    h.state.selection = "c1";
    render(<TimelineEditor />);
    fireEvent.contextMenu(screen.getByTitle("clip.mp4"));
    fireEvent.click(screen.getByText("Copy"));
    expect(h.state.copyClip).toHaveBeenCalledWith("c1");
    key({ key: "c", ctrlKey: true });
    expect(h.state.copyClip).toHaveBeenCalledTimes(2);
    key({ key: "v", ctrlKey: true });
    expect(h.state.pasteClip).toHaveBeenCalled();
  });

  it("shows Paste in the menu only when the clipboard has a clip", () => {
    render(<TimelineEditor />);
    fireEvent.contextMenu(screen.getByTitle("clip.mp4"));
    expect(screen.queryByText("Paste")).not.toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("menu").parentElement!); // close it
    h.state.clipboard = { clip: {}, trackId: "v1", trackKind: "video" };
    fireEvent.contextMenu(screen.getByTitle("clip.mp4"));
    fireEvent.click(screen.getByText("Paste"));
    expect(h.state.pasteClip).toHaveBeenCalled();
  });

  it("shows a transition badge and resizes it by dragging the wedge", async () => {
    h.state.timeline = {
      canvas: { width: 1080, height: 1920, fps: 30 },
      tracks: [
        {
          id: "v1",
          kind: "video",
          clips: [
            { id: "c0", media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 },
            {
              id: "c1",
              media_ref: "b.mp4",
              timeline_in: 45,
              timeline_out: 105,
              transition_in: { kind: "crossfade", duration: 15 },
            },
          ],
        },
      ],
    };
    render(<TimelineEditor />);
    const handle = screen.getByLabelText("transition resize end");
    fireEvent.pointerDown(handle, { clientX: 0 });
    expect(h.state.beginGesture).toHaveBeenCalled();
    ptr("pointermove", { clientX: 80 }); // cut at 60px; end edge +20px -> 40px wedge -> 30 frames
    ptr("pointerup", {});
    expect(h.state.setTransition).toHaveBeenCalledWith("c1", {
      kind: "crossfade",
      duration: 30,
      expr: undefined,
    });
    await Promise.resolve(); // endGesture() runs in setTransition().finally() (a microtask)
    expect(h.state.endGesture).toHaveBeenCalled();
  });

  it("renders a zoom scrollbar whose end handle zooms", () => {
    render(<TimelineEditor />);
    expect(screen.getByLabelText("timeline zoom")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByLabelText("zoom end"), { clientX: 10 });
    ptr("pointermove", { clientX: 40 });
    ptr("pointerup", {});
    expect(h.state.setZoom).toHaveBeenCalled();
  });
});

describe("fade knobs never sit on the trim handles", () => {
  // Reported as "small circles on each edge of a clip that aren't even clickable — hovering them
  // selects the trim edge". They ARE clickable: they are the fade in/out handles. But at rest
  // (fade = 0) the knob was positioned at offset 0, i.e. ON TOP of the TRIM_W-wide trim strip,
  // with the SAME ew-resize cursor and no highlight of its own — so the outer edge of every clip
  // silently ran two different gestures depending on how high up you grabbed it, and the trim
  // strip's hover highlight showed through the knob. Two hit boxes for two gestures must be
  // DISJOINT; that is the rule under test, not the arithmetic that achieves it.
  const TRIM_W = 8; // TimelineEditor's trim strip width
  const KNOB = 10; // the fade knob's diameter

  /** Hit box of a fade knob, in px from the clip edge it belongs to. */
  const knobBox = (edge: "in" | "out") => {
    const el = within(screen.getByTitle("clip.mp4")).getByLabelText(`fade ${edge}`);
    const off = parseFloat(edge === "in" ? el.style.left : el.style.right);
    return { near: off, far: off + KNOB };
  };

  beforeEach(() => {
    h.state.setClipProperties = vi.fn(() => Promise.resolve());
  });

  it("keeps an un-faded knob clear of the trim strip, at BOTH edges", () => {
    // The resting position of every clip in a fresh project — and the one that used to collide.
    render(<TimelineEditor />);
    for (const edge of ["in", "out"] as const) {
      expect(knobBox(edge).near).toBeGreaterThanOrEqual(TRIM_W);
    }
  });

  it("keeps the knob clear of the trim strip at every fade length, including past the end", () => {
    // The failure direction: clamping only the resting case leaves the far edge free to ride out
    // over the OPPOSITE trim strip once the fade grows to the whole clip.
    for (const frames of [0, 1, 15, 30, 60, 600]) {
      h.state.timeline = {
        ...timeline,
        tracks: [
          {
            ...timeline.tracks[0],
            clips: [{ ...timeline.tracks[0].clips[0], fade: { in: frames, out: frames } }],
          },
        ],
      };
      const { unmount } = render(<TimelineEditor />);
      const width = parseFloat(screen.getByTitle("clip.mp4").style.width);
      for (const edge of ["in", "out"] as const) {
        const box = knobBox(edge);
        expect(box.near).toBeGreaterThanOrEqual(TRIM_W);
        // measured from its own edge, so the opposite trim strip starts at width - TRIM_W
        expect(box.far).toBeLessThanOrEqual(width - TRIM_W);
      }
      unmount();
    }
    h.state.timeline = timeline;
  });

  it("hides them on a clip too narrow to hold them, instead of stacking them back up", () => {
    // 2 trim strips + 2 knobs = 36px. Below that there is nowhere collision-free to put them.
    h.state.timeline = {
      ...timeline,
      tracks: [
        {
          ...timeline.tracks[0],
          clips: [{ ...timeline.tracks[0].clips[0], timeline_out: 10 }], // 10 frames @ zoom 40 => 13px
        },
      ],
    };
    render(<TimelineEditor />);
    expect(screen.queryByLabelText("fade in")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("fade out")).not.toBeInTheDocument();
    h.state.timeline = timeline;
  });

  it("still commits a real fade when dragged — the knob is not decoration", () => {
    // Guards the obvious over-correction: moving the knob out of the trim strip must not be
    // achieved by making it inert or unreachable.
    render(<TimelineEditor />);
    const clip = screen.getByTitle("clip.mp4");
    fireEvent.pointerDown(within(clip).getByLabelText("fade in"), { clientX: 0 });
    ptr("pointermove", { clientX: 20 }); // 20px @ zoom 40 => 15 frames
    ptr("pointerup", {});
    expect(h.state.setClipProperties).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ fade: { in: 15, out: 0 } }),
    );
  });

  it("does not swallow the trim gesture it used to cover", () => {
    // The whole point of the move: the trim strip must still trim.
    render(<TimelineEditor />);
    const clip = screen.getByTitle("clip.mp4");
    fireEvent.pointerDown(within(clip).getByLabelText("trim start"), { clientX: 0 });
    ptr("pointermove", { clientX: 20 });
    ptr("pointerup", {});
    expect(h.state.trimClip).toHaveBeenCalled();
    expect(h.state.setClipProperties).not.toHaveBeenCalled();
  });
});
