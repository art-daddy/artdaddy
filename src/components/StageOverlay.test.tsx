// The invariant this file exists for: ONE gesture writes ONCE. TimelineSession.apply pushes
// an undo entry per call, so an overlay that committed per pointermove would make Ctrl+Z
// useless after any drag — and no geometry test can see that.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const h = vi.hoisted(() => ({ state: {} as any }));
vi.mock("../store/editor", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useEditor: Object.assign((sel: any) => sel(h.state), { getState: () => h.state }),
}));

import StageOverlay from "./StageOverlay";
import { _resetAssetDims, setAssetDims } from "../preview/assetDims";

const CANVAS = { width: 1000, height: 1000, fps: 30 };
const clip = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  kind: "video",
  media_ref: "v.mp4",
  timeline_in: 0,
  timeline_out: 60,
  transform: { position: { x: 0.5, y: 0.5 }, scale: 0.5 },
  ...over,
});

beforeEach(() => {
  _resetAssetDims();
  h.state = {
    timeline: { canvas: CANVAS, tracks: [{ id: "v1", kind: "video", z: 0, clips: [clip()] }] },
    playhead: 0,
    selection: "c1",
    select: vi.fn(),
    setClipProperties: vi.fn(() => Promise.resolve()),
    beginGesture: vi.fn(),
    endGesture: vi.fn(),
  };
  // happy-dom gives every element a 0x0 box; the overlay measures its host to place handles.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 400,
    height: 400,
  } as DOMRect);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class {
    constructor(private cb: () => void) {}
    observe() {
      this.cb();
    }
    disconnect() {}
  };
});

const ptr = (type: string, init: MouseEventInit) =>
  window.dispatchEvent(new MouseEvent(type, init));

describe("StageOverlay", () => {
  it("commits ONCE per move gesture, however many pointermoves it takes", () => {
    render(<StageOverlay />);
    fireEvent.pointerDown(screen.getByTestId("stage-box"), { clientX: 200, clientY: 200 });
    for (const x of [210, 220, 230, 240, 250]) ptr("pointermove", { clientX: x, clientY: 200 });
    expect(h.state.setClipProperties).not.toHaveBeenCalled(); // nothing written mid-drag
    ptr("pointerup", { clientX: 250, clientY: 200 });
    expect(h.state.setClipProperties).toHaveBeenCalledTimes(1);
  });

  it("writes the moved POSITION, and leaves scale alone", () => {
    render(<StageOverlay />);
    fireEvent.pointerDown(screen.getByTestId("stage-box"), { clientX: 200, clientY: 200 });
    ptr("pointermove", { clientX: 300, clientY: 200 });
    ptr("pointerup", { clientX: 300, clientY: 200 });
    const [id, props] = h.state.setClipProperties.mock.calls[0];
    expect(id).toBe("c1");
    // +100px on a 400px-wide canvas rect = +0.25 of the canvas.
    expect(props.transform.position.x).toBeCloseTo(0.75, 3);
    expect(props.transform.position.y).toBeCloseTo(0.5, 3);
    expect(props.transform.scale_x).toBeUndefined();
  });

  it("a press that never moves selects but writes NOTHING", () => {
    render(<StageOverlay />);
    fireEvent.pointerDown(screen.getByTestId("stage-box"), { clientX: 200, clientY: 200 });
    ptr("pointerup", { clientX: 200, clientY: 200 });
    expect(h.state.setClipProperties).not.toHaveBeenCalled();
    expect(h.state.endGesture).toHaveBeenCalled(); // and the gesture is still closed out
  });

  it("a corner drag writes scale_x/scale_y, once", () => {
    render(<StageOverlay />);
    fireEvent.pointerDown(screen.getByTestId("stage-handle-br"), { clientX: 300, clientY: 300 });
    ptr("pointermove", { clientX: 340, clientY: 340 });
    ptr("pointerup", { clientX: 340, clientY: 340 });
    expect(h.state.setClipProperties).toHaveBeenCalledTimes(1);
    const props = h.state.setClipProperties.mock.calls[0][1];
    expect(props.transform.scale_x).toBeGreaterThan(0.5);
    expect(props.transform.scale_y).toBeGreaterThan(0.5);
  });

  it("stamps a KEYFRAME instead of flattening an animated property", () => {
    // Dragging on the canvas must never silently destroy an animation the user built.
    h.state.timeline.tracks[0].clips[0] = clip({
      timeline_in: 30,
      timeline_out: 90,
      transform: {
        position: {
          x: [
            { t: 0, v: 0.2 },
            { t: 60, v: 0.8 },
          ],
          y: 0.5,
        },
        scale: 0.5,
      },
    });
    h.state.playhead = 1; // frame 30 absolute -> frame 0 relative to a clip starting at 30
    render(<StageOverlay />);
    fireEvent.pointerDown(screen.getByTestId("stage-box"), { clientX: 200, clientY: 200 });
    ptr("pointermove", { clientX: 240, clientY: 200 });
    ptr("pointerup", { clientX: 240, clientY: 200 });
    const props = h.state.setClipProperties.mock.calls[0][1];
    expect(Array.isArray(props.transform.position.x)).toBe(true); // still animated
    expect(props.transform.position.x).toContainEqual(expect.objectContaining({ t: 0 }));
    expect(props.transform.position.y).not.toBeInstanceOf(Array); // the static axis stays static
  });

  it("crop mode swaps the handles and writes crop, not transform", () => {
    render(<StageOverlay cropMode />);
    expect(screen.queryByTestId("stage-handle-br")).toBeNull();
    fireEvent.pointerDown(screen.getByTestId("stage-crop-left"), { clientX: 100, clientY: 200 });
    ptr("pointermove", { clientX: 140, clientY: 200 });
    ptr("pointerup", { clientX: 140, clientY: 200 });
    expect(h.state.setClipProperties).toHaveBeenCalledTimes(1);
    const props = h.state.setClipProperties.mock.calls[0][1];
    expect(props.crop.left).toBeCloseTo(0.1, 3);
    expect(props.transform).toBeUndefined();
  });

  it("shows no box when nothing is selected", () => {
    h.state.selection = null;
    render(<StageOverlay />);
    expect(screen.queryByTestId("stage-box")).toBeNull();
  });

  describe("rotation", () => {
    // The clip is centred in a 400x400 canvas, so its centre is (200, 200) and the rotate
    // knob sits straight above it. Dragging the knob to the RIGHT of the centre is a
    // quarter turn clockwise.
    const grabKnob = () => {
      const knob = screen.getByTestId("stage-handle-rotate");
      fireEvent.pointerDown(knob, { clientX: 200, clientY: 100 });
    };

    it("a knob drag writes `rotate` degrees, once, and touches nothing else", () => {
      render(<StageOverlay />);
      grabKnob();
      ptr("pointermove", { clientX: 300, clientY: 200 });
      ptr("pointerup", { clientX: 300, clientY: 200 });
      expect(h.state.setClipProperties).toHaveBeenCalledTimes(1);
      const [id, props] = h.state.setClipProperties.mock.calls[0];
      expect(id).toBe("c1");
      expect(props.rotate).toBeCloseTo(90, 3);
      expect(props.transform).toBeUndefined(); // rotation is not a transform-box edit
      expect(props.crop).toBeUndefined();
    });

    it("turns the way the pointer went, not the other way", () => {
      // A sign flip writes a perfectly plausible -90 and rotates the picture backwards.
      render(<StageOverlay />);
      grabKnob();
      ptr("pointermove", { clientX: 100, clientY: 200 });
      ptr("pointerup", { clientX: 100, clientY: 200 });
      expect(h.state.setClipProperties.mock.calls[0][1].rotate).toBeCloseTo(-90, 3);
    });

    it("snaps to the nearest 15°, so a near-miss lands square", () => {
      render(<StageOverlay />);
      grabKnob();
      // dx=+100, dy=-5 from the centre -> ~87.1°, inside the 4° window around 90.
      ptr("pointermove", { clientX: 300, clientY: 195 });
      ptr("pointerup", { clientX: 300, clientY: 195 });
      expect(h.state.setClipProperties.mock.calls[0][1].rotate).toBe(90);
    });

    it("...but a real angle between stops is left alone", () => {
      // The failure direction for snapping: if it snapped everywhere, rotation would only
      // ever produce multiples of 15 and the gesture would feel broken.
      render(<StageOverlay />);
      grabKnob();
      // dx=+100, dy=-78 -> ~52°, a clear 7° from 45 and 8° from 60.
      ptr("pointermove", { clientX: 300, clientY: 122 });
      ptr("pointerup", { clientX: 300, clientY: 122 });
      const deg = h.state.setClipProperties.mock.calls[0][1].rotate as number;
      expect(deg).toBeGreaterThan(48);
      expect(deg).toBeLessThan(57);
      expect(deg % 15).not.toBe(0);
    });

    it("a press on the knob that never moves writes nothing", () => {
      render(<StageOverlay />);
      grabKnob();
      ptr("pointerup", { clientX: 200, clientY: 100 });
      expect(h.state.setClipProperties).not.toHaveBeenCalled();
    });

    it("draws the rotated outline only when the clip IS rotated", () => {
      // Two visible rectangles disagreeing is the defect this file exists to avoid: the
      // axis-aligned div keeps its border at 0°, the polygon takes over once turned.
      const { unmount } = render(<StageOverlay />);
      expect(screen.queryByTestId("stage-outline")).toBeNull();
      unmount();
      h.state.timeline.tracks[0].clips[0].rotate = 30;
      render(<StageOverlay />);
      expect(screen.getByTestId("stage-outline")).toBeTruthy();
      expect(screen.getByTestId("stage-box").className).toContain("border-transparent");
    });

    it("puts the corner handles on the ROTATED corners", () => {
      // The whole point of the phase: at 0° the picture's corners are the box's corners, and
      // rotating must move the dots with the picture rather than leaving them upright.
      const { unmount } = render(<StageOverlay />);
      const before = screen.getByTestId("stage-handle-tl").getBoundingClientRect();
      const upright = { x: before.left, y: before.top };
      unmount();
      h.state.timeline.tracks[0].clips[0].rotate = 90;
      render(<StageOverlay />);
      const after = screen.getByTestId("stage-handle-tl");
      expect(after.style.left).not.toBe(`${upright.x}px`);
    });
  });

  describe("the box follows the PICTURE, not the slot it sits in", () => {
    // A landscape source in a square frame is letterboxed by `fit: contain`, so the
    // transform box is taller than anything visible. Drawing the box from the transform
    // put the handles in the black bars, which is what the user reported.
    beforeEach(() => {
      setAssetDims("v.mp4", { w: 800, h: 400 }); // 2:1 into a 1000x1000 canvas
      h.state.timeline.tracks[0].clips[0] = clip({ transform: undefined });
    });

    it("is half the height of the frame, not all of it", () => {
      render(<StageOverlay />);
      const box = screen.getByTestId("stage-box");
      // Canvas rect is the full 400x400 host; a 2:1 picture fills the width, half the height.
      expect(parseFloat(box.style.width)).toBeCloseTo(400, 0);
      expect(parseFloat(box.style.height)).toBeCloseTo(200, 0);
      expect(parseFloat(box.style.top)).toBeCloseTo(100, 0); // centred in the letterbox
    });

    it("puts the corner handles ON that box, not on the frame", () => {
      render(<StageOverlay />);
      const box = screen.getByTestId("stage-box");
      const tl = screen.getByTestId("stage-handle-tl");
      const top = parseFloat(box.style.top);
      // Vertically there is room (the picture is letterboxed), so the handle is centred
      // exactly on the corner — 100px down, NOT at the top of the frame.
      expect(parseFloat(tl.style.top) + 5).toBeCloseTo(top, 0);
      expect(top).toBeGreaterThan(50);
      // Horizontally the picture touches the frame edge, so the handle is nudged fully
      // inside — but it must still COVER the corner it belongs to.
      const left = parseFloat(tl.style.left);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left).toBeLessThanOrEqual(parseFloat(box.style.left));
      expect(left + 10).toBeGreaterThanOrEqual(parseFloat(box.style.left));
    });

    it("a drag still commits a TRANSFORM scale, not the picture's size", () => {
      // The gesture happens in picture space; the clip stores the box. A round trip that
      // forgot the letterbox would shrink the clip on every drag.
      render(<StageOverlay />);
      fireEvent.pointerDown(screen.getByTestId("stage-box"), { clientX: 200, clientY: 200 });
      ptr("pointermove", { clientX: 200, clientY: 260 });
      ptr("pointerup", { clientX: 200, clientY: 260 });
      const props = h.state.setClipProperties.mock.calls[0][1];
      // Moved 60px down on a 400px canvas = +0.15 — in CANVAS units, not picture units.
      expect(props.transform.position.y).toBeCloseTo(0.65, 3);
    });

    it("hit-tests the picture: a click in the black bar selects nothing", () => {
      render(<StageOverlay />);
      // y=40 is inside the transform box but above the letterboxed picture (top = 100).
      fireEvent.pointerDown(screen.getByTestId("stage-overlay"), { clientX: 200, clientY: 40 });
      expect(h.state.select).toHaveBeenCalledWith(null);
      h.state.select.mockClear();
      fireEvent.pointerDown(screen.getByTestId("stage-overlay"), { clientX: 200, clientY: 200 });
      expect(h.state.select).toHaveBeenCalledWith("c1");
    });
  });

  describe("a resize stops where the write stops", () => {
    // A tiny source: covering the 1000x1000 canvas already magnifies it 10x, so the zoom ceiling
    // lands at scale 0.6 — well inside the frame, where the RAIL is what stops the drag.
    beforeEach(() => {
      setAssetDims("v.mp4", { w: 100, h: 100 });
    });

    it("rails the GHOST, so dragging further stops growing the outline", () => {
      render(<StageOverlay />);
      const boxW = () => parseFloat(screen.getByTestId("stage-box").style.width);
      const start = boxW();
      fireEvent.pointerDown(screen.getByTestId("stage-handle-br"), { clientX: 300, clientY: 300 });
      act(() => ptr("pointermove", { clientX: 340, clientY: 340 }) as unknown as void);
      const near = boxW();
      act(() => ptr("pointermove", { clientX: 900, clientY: 900 }) as unknown as void);
      const far = boxW();
      ptr("pointerup", { clientX: 900, clientY: 900 });
      // The drag DID grow the outline...
      expect(near).toBeGreaterThan(start);
      // ...and then stopped: both drags are past the ceiling, so 340 and 900 show the same size.
      expect(far).toBeCloseTo(near, 3);
      expect(far).toBeLessThan(400); // and it railed BEFORE the canvas edge, so this is the rail
    });

    it("commits exactly the size the ghost showed — no snap-back", () => {
      render(<StageOverlay />);
      fireEvent.pointerDown(screen.getByTestId("stage-handle-br"), { clientX: 300, clientY: 300 });
      act(() => ptr("pointermove", { clientX: 900, clientY: 900 }) as unknown as void);
      const shown = parseFloat(screen.getByTestId("stage-box").style.width) / 400;
      ptr("pointerup", { clientX: 900, clientY: 900 });
      const props = h.state.setClipProperties.mock.calls[0][1];
      expect(props.transform.scale_x).toBeCloseTo(shown, 3);
      expect(props.transform.scale_x).toBeCloseTo(6 / (1000 / 100), 2);
    });
  });
});
