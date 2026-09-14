// The keyframe lane. Its job is to make an animated property's shape VISIBLE and each key
// editable, so the assertions are about what the lane shows and what it commits — not about the
// DOM shape it happens to use today.
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const h = vi.hoisted(() => ({ state: {} as any }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("../store/editor", () => ({ useEditor: (sel: any) => sel(h.state) }));

import { KeyframeLane } from "./KeyframeLane";
import type { Clip } from "../timeline/model";

const setKeyframe = vi.fn();
const setClipProperties = vi.fn();
const onSeek = vi.fn();

beforeEach(() => {
  setKeyframe.mockReset();
  setClipProperties.mockReset();
  onSeek.mockReset();
  h.state = { setKeyframe, setClipProperties };
});

const lane = (clip: Partial<Clip>, kind = "video", relFrame = 0) =>
  render(
    <KeyframeLane
      clip={clip as Clip}
      clipId="c1"
      kind={kind}
      duration={100}
      relFrame={relFrame}
      onSeek={onSeek}
    />,
  );

const animated = {
  opacity: [
    { t: 0, v: 0 },
    { t: 50, v: 1 },
  ],
};

/** Scale and position live under `clip.transform`; rotate/opacity/volume sit on the clip. Tests
 *  that flatten that agree with a wrong path instead of catching it — which is exactly how the
 *  lane first shipped showing only three of its eight properties. */
const transformed = {
  transform: {
    position: { x: [{ t: 0, v: 0.2 }], y: 0.9 },
    scale_x: [
      { t: 0, v: 1 },
      { t: 30, v: 2 },
    ],
    scale: 1.5,
  },
  fit: "contain",
};

describe("KeyframeLane", () => {
  it("shows nothing at all when the clip has no animation", () => {
    const { container } = lane({ opacity: 0.5, rotate: 12 });
    expect(container).toBeEmptyDOMElement();
  });

  it("gives a row ONLY to properties that carry keys", () => {
    // Eight always-present rows would be noise; the stopwatch is how a property joins the lane.
    lane({ ...animated, rotate: 12 });
    expect(screen.getByLabelText("Opacity keyframes")).toBeInTheDocument();
    expect(screen.queryByLabelText("Rotation keyframes")).not.toBeInTheDocument();
  });

  it("draws one diamond per key, at its own time", () => {
    lane(animated);
    expect(screen.getByLabelText("Opacity keyframe at 0")).toBeInTheDocument();
    const late = screen.getByLabelText("Opacity keyframe at 50");
    expect(late.style.left).toBe("50%"); // half way along a 100-frame clip
  });

  it("offers an audio clip its volume, and a video clip its transform", () => {
    lane({ volume: [{ t: 0, v: 1 }] }, "audio");
    expect(screen.getByLabelText("Volume keyframes")).toBeInTheDocument();
    expect(screen.queryByLabelText("Opacity keyframes")).not.toBeInTheDocument();
  });

  it("marks a HELD key differently from a ramped one", () => {
    // The shape has to say "steps here" without a legend, or hold is invisible until you render.
    lane({
      opacity: [
        { t: 0, v: 0, ease: "hold" },
        { t: 50, v: 1 },
      ],
    });
    expect(screen.getByLabelText("Opacity keyframe at 0")).toHaveAttribute("data-ease", "hold");
    expect(screen.getByLabelText("Opacity keyframe at 50")).toHaveAttribute("data-ease", "linear");
  });

  it("seeks to a key when it is clicked", () => {
    lane(animated);
    fireEvent.click(screen.getByLabelText("Opacity keyframe at 50"));
    expect(onSeek).toHaveBeenCalledWith(50);
  });

  it("changes ONLY the easing on right-click — never the key's time or value", () => {
    // The failure this guards: an ease change that also rewrites t or v silently moves the
    // animation while claiming to restyle it.
    lane(animated);
    fireEvent.contextMenu(screen.getByLabelText("Opacity keyframe at 50"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Hold (step)" }));
    expect(setKeyframe).toHaveBeenCalledWith("c1", "opacity", 50, 1, {
      fromT: 50,
      ease: "hold",
    });
  });

  it("offers hold among the easings, since the renderers now understand it", () => {
    lane(animated);
    fireEvent.contextMenu(screen.getByLabelText("Opacity keyframe at 0"));
    for (const label of ["Linear", "Hold (step)", "Ease in", "Ease out", "Ease in-out"])
      expect(screen.getByRole("menuitem", { name: label })).toBeInTheDocument();
  });

  it("deletes one key and leaves the rest a curve", () => {
    lane(animated);
    fireEvent.contextMenu(screen.getByLabelText("Opacity keyframe at 0"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete keyframe" }));
    expect(setClipProperties).toHaveBeenCalledWith("c1", { opacity: [{ t: 50, v: 1 }] });
  });

  it("deleting the LAST key returns a constant, not an empty curve", () => {
    // An empty array is not "no animation" — it is a curve with nothing in it, which samples to
    // the fallback and loses the value the user had set.
    lane({ opacity: [{ t: 10, v: 0.25 }] });
    fireEvent.contextMenu(screen.getByLabelText("Opacity keyframe at 10"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete keyframe" }));
    expect(setClipProperties).toHaveBeenCalledWith("c1", { opacity: 0.25 });
  });

  it("finds the transform properties, which live a level deeper than the rest", () => {
    lane(transformed as unknown as Partial<Clip>);
    expect(screen.getByLabelText("Position X keyframes")).toBeInTheDocument();
    expect(screen.getByLabelText("Scale X keyframes")).toBeInTheDocument();
    // `scale` is a constant here, so it gets no row.
    expect(screen.queryByLabelText("Scale keyframes")).not.toBeInTheDocument();
  });

  it("keeps the sibling component when editing one axis of position", () => {
    // Writing `{position: {x}}` alone drops y, which recentres the clip vertically; writing
    // `{transform: {position}}` alone drops `scale` and `fit` with it.
    lane(transformed as unknown as Partial<Clip>);
    fireEvent.contextMenu(screen.getByLabelText("Position X keyframe at 0"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete keyframe" }));
    expect(setClipProperties).toHaveBeenCalledWith("c1", {
      transform: {
        position: { x: 0.2, y: 0.9 },
        scale_x: [
          { t: 0, v: 1 },
          { t: 30, v: 2 },
        ],
        scale: 1.5,
      },
    });
  });

  it("restyles a deep property through the same shared path", () => {
    lane(transformed as unknown as Partial<Clip>);
    fireEvent.contextMenu(screen.getByLabelText("Scale X keyframe at 30"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Hold (step)" }));
    expect(setKeyframe).toHaveBeenCalledWith("c1", "transform.scale_x", 30, 2, {
      fromT: 30,
      ease: "hold",
    });
  });

  it("closes the menu without editing anything when dismissed", () => {
    lane(animated);
    fireEvent.contextMenu(screen.getByLabelText("Opacity keyframe at 50"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.pointerDown(window);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(setKeyframe).not.toHaveBeenCalled();
    expect(setClipProperties).not.toHaveBeenCalled();
  });
});
