import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const h = vi.hoisted(() => ({ state: {} as any }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("../store/editor", () => ({ useEditor: (sel: any) => sel(h.state) }));

import Inspector from "./Inspector";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function state(tracks: any[], selection: string | null) {
  return {
    timeline: { canvas: { width: 1080, height: 1920, fps: 30 }, tracks },
    selection,
    playhead: 0,
    setClipProperties: vi.fn(),
    setCanvas: vi.fn(),
    setTransition: vi.fn(),
    setPlayhead: vi.fn(),
  };
}

beforeEach(() => {
  h.state = state(
    [
      {
        id: "v1",
        kind: "video",
        clips: [{ id: "c1", source: "a.mp4", timeline_in: 0, timeline_out: 60, opacity: 0.8 }],
      },
    ],
    "c1",
  );
});

function scrub(label: string, value: string) {
  fireEvent.pointerDown(screen.getByLabelText(label), { clientX: 0 });
  fireEvent(window, new MouseEvent("pointerup", {}));
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("Inspector", () => {
  it("shows transform + playback + crop fields for a video clip", () => {
    render(<Inspector />);
    expect(screen.getByLabelText("opacity")).toHaveTextContent("0.80");
    for (const l of ["px", "py", "scale", "fit", "rotate", "speed", "crop left"]) {
      expect(screen.getByLabelText(l)).toBeInTheDocument();
    }
  });

  it("editing opacity writes via setClipProperties", () => {
    render(<Inspector />);
    fireEvent.pointerDown(screen.getByLabelText("opacity"), { clientX: 0 });
    fireEvent(window, new MouseEvent("pointerup", {})); // no move -> edit
    const input = screen.getByLabelText("opacity");
    fireEvent.change(input, { target: { value: "0.5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.state.setClipProperties).toHaveBeenCalledWith("c1", { opacity: 0.5 });
  });

  it("editing Pos X writes a transform.position patch", () => {
    render(<Inspector />);
    fireEvent.pointerDown(screen.getByLabelText("px"), { clientX: 0 });
    fireEvent(window, new MouseEvent("pointerup", {}));
    const input = screen.getByLabelText("px");
    fireEvent.change(input, { target: { value: "0.25" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.state.setClipProperties).toHaveBeenCalledWith("c1", {
      transform: { position: { x: 0.25 } },
    });
  });

  it("shows canvas settings when nothing is selected", () => {
    h.state = state([], null);
    render(<Inspector />);
    expect(screen.getByLabelText("canvas width")).toHaveTextContent("1080");
    fireEvent.pointerDown(screen.getByLabelText("canvas fps"), { clientX: 0 });
    fireEvent(window, new MouseEvent("pointerup", {}));
    fireEvent.change(screen.getByLabelText("canvas fps"), { target: { value: "24" } });
    fireEvent.keyDown(screen.getByLabelText("canvas fps"), { key: "Enter" });
    expect(h.state.setCanvas).toHaveBeenCalledWith({ fps: 24 });
  });

  it("shows volume + fade for an audio clip", () => {
    h.state = state(
      [
        {
          id: "a1",
          kind: "audio",
          clips: [
            {
              id: "au1",
              kind: "audio",
              source: "m.mp3",
              timeline_in: 0,
              timeline_out: 60,
              volume: 1,
            },
          ],
        },
      ],
      "au1",
    );
    render(<Inspector />);
    for (const l of ["volume", "fade in", "fade out"])
      expect(screen.getByLabelText(l)).toBeInTheDocument();
    expect(screen.queryByLabelText("speed")).not.toBeInTheDocument();
  });

  it("shows text fields for a text clip", () => {
    h.state = state(
      [
        {
          id: "t1",
          kind: "text",
          clips: [{ id: "tx1", kind: "text", text: "Hi", timeline_in: 0, timeline_out: 60 }],
        },
      ],
      "tx1",
    );
    render(<Inspector />);
    for (const l of ["text content", "font size", "color", "align"])
      expect(screen.getByLabelText(l)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("text content"), { target: { value: "Hello" } });
    expect(h.state.setClipProperties).toHaveBeenCalledWith("tx1", { text: "Hello" });
  });

  it("edits transform, crop, and fit fields", () => {
    render(<Inspector />);
    for (const [l, v] of [
      ["px", "0.2"],
      ["py", "0.3"],
      ["scale", "1.5"],
      ["rotate", "45"],
      ["speed", "2"],
      ["crop left", "0.1"],
      ["crop right", "0.1"],
      ["crop top", "0.1"],
      ["crop bottom", "0.1"],
    ] as const)
      scrub(l, v);
    fireEvent.change(screen.getByLabelText("fit"), { target: { value: "cover" } });
    expect(h.state.setClipProperties.mock.calls.length).toBeGreaterThanOrEqual(10);
  });

  it("speed change adjusts source_out to preserve the duration invariant", () => {
    h.state = state(
      [
        {
          id: "v1",
          kind: "video",
          clips: [
            {
              id: "c1",
              source: "a.mp4",
              timeline_in: 0,
              timeline_out: 60,
              source_in: 0,
              source_out: 60,
            },
          ],
        },
      ],
      "c1",
    );
    render(<Inspector />);
    scrub("speed", "2");
    expect(h.state.setClipProperties).toHaveBeenCalledWith("c1", { speed: 2, source_out: 120 });
  });

  it("edits audio volume + fades", () => {
    h.state = state(
      [
        {
          id: "a1",
          kind: "audio",
          clips: [
            {
              id: "au1",
              kind: "audio",
              source: "m.mp3",
              timeline_in: 0,
              timeline_out: 60,
              volume: 1,
            },
          ],
        },
      ],
      "au1",
    );
    render(<Inspector />);
    for (const [l, v] of [
      ["volume", "0.5"],
      ["fade in", "5"],
      ["fade out", "5"],
    ] as const)
      scrub(l, v);
    expect(h.state.setClipProperties.mock.calls.length).toBe(3);
  });

  it("edits text style (font/size/color/align)", () => {
    h.state = state(
      [
        {
          id: "t1",
          kind: "text",
          clips: [{ id: "tx1", kind: "text", text: "Hi", timeline_in: 0, timeline_out: 60 }],
        },
      ],
      "tx1",
    );
    render(<Inspector />);
    fireEvent.change(screen.getByLabelText("font"), { target: { value: "serif" } });
    scrub("font size", "80");
    fireEvent.change(screen.getByLabelText("color"), { target: { value: "#ff0000" } });
    fireEvent.change(screen.getByLabelText("align"), { target: { value: "left" } });
    expect(h.state.setClipProperties.mock.calls.length).toBe(4);
  });

  it("the stopwatch enables keyframing (constant -> a key at the playhead)", () => {
    render(<Inspector />);
    fireEvent.click(screen.getByLabelText("keyframe opacity"));
    expect(h.state.setClipProperties).toHaveBeenCalledWith("c1", { opacity: [{ t: 0, v: 0.8 }] });
  });

  it("the stopwatch on Pos X keyframes transform.position.x", () => {
    render(<Inspector />);
    fireEvent.click(screen.getByLabelText("keyframe px"));
    expect(h.state.setClipProperties).toHaveBeenCalledWith("c1", {
      transform: { position: { x: [{ t: 0, v: 0.5 }] } },
    });
  });

  it("editing an animated value upserts a keyframe at the playhead", () => {
    h.state = state(
      [
        {
          id: "v1",
          kind: "video",
          clips: [
            {
              id: "c1",
              source: "a.mp4",
              timeline_in: 0,
              timeline_out: 60,
              opacity: [{ t: 0, v: 1 }],
            },
          ],
        },
      ],
      "c1",
    );
    h.state.playhead = 1; // 1s @30fps -> frame 30
    render(<Inspector />);
    scrub("opacity", "0.5");
    expect(h.state.setClipProperties).toHaveBeenCalledWith("c1", {
      opacity: [
        { t: 0, v: 1 },
        { t: 30, v: 0.5 },
      ],
    });
  });

  it("keyframe nav seeks to the next key and ignores nav past the ends", () => {
    h.state = state(
      [
        {
          id: "v1",
          kind: "video",
          clips: [
            {
              id: "c1",
              source: "a.mp4",
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
      "c1",
    );
    h.state.playhead = 10 / 30; // frame 10 -> relFrame 0 (at the first key)
    render(<Inspector />);
    fireEvent.click(screen.getByLabelText("next keyframe opacity"));
    expect(h.state.setPlayhead).toHaveBeenCalledWith((10 + 30) / 30);
    h.state.setPlayhead.mockClear();
    fireEvent.click(screen.getByLabelText("prev keyframe opacity")); // none before relFrame 0
    expect(h.state.setPlayhead).not.toHaveBeenCalled();
  });

  it("the diamond removes the key at the playhead when present", () => {
    h.state = state(
      [
        {
          id: "v1",
          kind: "video",
          clips: [
            {
              id: "c1",
              source: "a.mp4",
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
      "c1",
    );
    h.state.playhead = 1; // frame 30 -> relFrame 30 (a key is here)
    render(<Inspector />);
    const toggle = screen.getByLabelText("toggle keyframe opacity");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(h.state.setClipProperties).toHaveBeenCalledWith("c1", { opacity: [{ t: 0, v: 1 }] });
  });

  it("the diamond adds a key at the playhead when absent", () => {
    h.state = state(
      [
        {
          id: "v1",
          kind: "video",
          clips: [
            {
              id: "c1",
              source: "a.mp4",
              timeline_in: 0,
              timeline_out: 60,
              opacity: [{ t: 0, v: 1 }],
            },
          ],
        },
      ],
      "c1",
    );
    h.state.playhead = 1; // frame 30 -> relFrame 30 (no key here; held value is 1)
    render(<Inspector />);
    const toggle = screen.getByLabelText("toggle keyframe opacity");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(h.state.setClipProperties).toHaveBeenCalledWith("c1", {
      opacity: [
        { t: 0, v: 1 },
        { t: 30, v: 1 },
      ],
    });
  });

  it("the stopwatch off collapses the curve to a constant at the playhead", () => {
    h.state = state(
      [
        {
          id: "v1",
          kind: "video",
          clips: [
            {
              id: "c1",
              source: "a.mp4",
              timeline_in: 0,
              timeline_out: 60,
              opacity: [
                { t: 0, v: 0 },
                { t: 60, v: 1 },
              ],
            },
          ],
        },
      ],
      "c1",
    );
    h.state.playhead = 1; // frame 30 -> relFrame 30 -> linear midpoint 0.5
    render(<Inspector />);
    fireEvent.click(screen.getByLabelText("keyframe opacity"));
    expect(h.state.setClipProperties).toHaveBeenCalledWith("c1", { opacity: 0.5 });
  });

  it("edits color grading and merges into the color object", () => {
    h.state = state(
      [
        {
          id: "v1",
          kind: "video",
          clips: [
            {
              id: "c1",
              source: "a.mp4",
              timeline_in: 0,
              timeline_out: 60,
              color: { saturation: 1.5 },
            },
          ],
        },
      ],
      "c1",
    );
    render(<Inspector />);
    for (const [l, v] of [
      ["brightness", "0.2"],
      ["contrast", "1.2"],
      ["saturation", "0.8"],
      ["gamma", "1.1"],
    ] as const)
      scrub(l, v);
    expect(h.state.setClipProperties).toHaveBeenNthCalledWith(1, "c1", {
      color: { saturation: 1.5, brightness: 0.2 },
    });
    expect(h.state.setClipProperties.mock.calls.length).toBe(4);
  });

  it("reset color clears the color object", () => {
    h.state = state(
      [
        {
          id: "v1",
          kind: "video",
          clips: [
            {
              id: "c1",
              source: "a.mp4",
              timeline_in: 0,
              timeline_out: 60,
              color: { brightness: 0.5 },
            },
          ],
        },
      ],
      "c1",
    );
    render(<Inspector />);
    fireEvent.click(screen.getByText("Reset color"));
    expect(h.state.setClipProperties).toHaveBeenCalledWith("c1", { color: null });
  });

  it("does not show color grading for audio clips", () => {
    h.state = state(
      [
        {
          id: "a1",
          kind: "audio",
          clips: [{ id: "au1", kind: "audio", source: "m.mp3", timeline_in: 0, timeline_out: 60 }],
        },
      ],
      "au1",
    );
    render(<Inspector />);
    expect(screen.queryByLabelText("brightness")).not.toBeInTheDocument();
  });

  it("shows a hint when the clip has no preceding clip on its track", () => {
    render(<Inspector />); // default state: a single clip c1
    expect(screen.getByText(/Needs a clip before it/)).toBeInTheDocument();
    expect(screen.queryByLabelText("transition kind")).not.toBeInTheDocument();
  });

  it("adds a transition on a clip that has a preceding clip", () => {
    h.state = state(
      [
        {
          id: "v1",
          kind: "video",
          clips: [
            { id: "c0", source: "a.mp4", timeline_in: 0, timeline_out: 60 },
            { id: "c1", source: "b.mp4", timeline_in: 60, timeline_out: 120 },
          ],
        },
      ],
      "c1",
    );
    render(<Inspector />);
    fireEvent.change(screen.getByLabelText("transition kind"), { target: { value: "wipe-l" } });
    expect(h.state.setTransition).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ kind: "wipe-l", duration: 15 }),
    );
  });

  it("edits duration + expr and clears the transition", () => {
    h.state = state(
      [
        {
          id: "v1",
          kind: "video",
          clips: [
            { id: "c0", source: "a.mp4", timeline_in: 0, timeline_out: 60 },
            {
              id: "c1",
              source: "b.mp4",
              timeline_in: 45,
              timeline_out: 105,
              transition_in: { kind: "custom", duration: 15, expr: "A*B" },
            },
          ],
        },
      ],
      "c1",
    );
    render(<Inspector />);
    expect(screen.getByLabelText("transition expr")).toHaveValue("A*B");
    scrub("transition duration", "20");
    expect(h.state.setTransition).toHaveBeenCalledWith("c1", {
      kind: "custom",
      duration: 20,
      expr: "A*B",
    });
    fireEvent.change(screen.getByLabelText("transition kind"), { target: { value: "" } });
    expect(h.state.setTransition).toHaveBeenCalledWith("c1", null);
  });
});
