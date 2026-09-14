import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session: null as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  active: { name: "My Reel" } as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  timeline: null as any,
  playhead: 0,
  setPlayhead: vi.fn(),
}));

vi.mock("./PreviewCanvas", () => ({ default: () => <div>preview</div> }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("../store/chat", () => ({ useChat: (sel: any) => sel({ session: h.session }) }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("../store/projects", () => ({ useProjects: (sel: any) => sel({ active: h.active }) }));
vi.mock("../store/editor", () => ({
  useEditor: Object.assign(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sel: any) => sel({ timeline: h.timeline, playhead: h.playhead, setPlayhead: h.setPlayhead }),
    { getState: () => ({ playhead: h.playhead }) },
  ),
}));

import StagePanel from "./StagePanel";

const timeline = {
  canvas: { width: 1080, height: 1920, fps: 30 },
  tracks: [
    {
      id: "v1",
      kind: "video",
      clips: [{ id: "c1", source: "a.mp4", timeline_in: 0, timeline_out: 60 }],
    },
  ],
};

beforeEach(() => {
  h.session = null;
  h.active = { name: "My Reel" };
  h.timeline = null;
  h.playhead = 0;
  h.setPlayhead = vi.fn();
});

describe("StagePanel", () => {
  // A new project is NOT `timeline === null` — it already has empty v1/a1 tracks. Testing the
  // null case only is what let the empty stage ship invisible to every new project.
  it.each([
    ["before the timeline loads", null],
    [
      "on a new project, which already has empty tracks",
      {
        canvas: { width: 1080, height: 1920, fps: 30 },
        tracks: [
          { id: "v1", kind: "video", clips: [] },
          { id: "a1", kind: "audio", clips: [] },
        ],
      },
    ],
  ])("offers the two starting moves %s", (_label, tl) => {
    h.timeline = tl;
    render(<StagePanel projectId="p1" />);
    expect(screen.getByText("My Reel")).toBeInTheDocument();
    // Someone opening their first project has nothing to ask the agent ABOUT, so the stage
    // has to let them bring media in or make some.
    expect(screen.getByRole("button", { name: "upload file" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "record video" })).toBeInTheDocument();
    expect(screen.queryByText("preview")).not.toBeInTheDocument();
  });

  it("shows the WebGL composite when there's a timeline and no rendered video", () => {
    h.timeline = timeline;
    render(<StagePanel projectId="p1" />);
    expect(screen.getByText("preview")).toBeInTheDocument();
    expect(screen.getByText(/1080×1920/)).toBeInTheDocument();
  });

  it("defaults to the live composite but can switch to the rendered video", () => {
    h.timeline = timeline;
    h.active = { name: "My Reel", manifest: { final_mp4: "x.mp4" } };
    render(<StagePanel projectId="p1" />);
    // live-first: the WebGL composite reflects edits, not the stale render
    expect(screen.getByText("preview")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-video")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rendered" }));
    expect(screen.getByTestId("preview-video")).toBeInTheDocument();
    expect(screen.queryByText("preview")).not.toBeInTheDocument();
  });

  it("toggles canvas playback from the transport", () => {
    h.timeline = timeline;
    render(<StagePanel projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "play" }));
    expect(screen.getByRole("button", { name: "pause" })).toBeInTheDocument();
  });

  it("seeks via the transport scrubber -> setPlayhead", () => {
    h.timeline = timeline;
    render(<StagePanel projectId="p1" />);
    fireEvent.change(screen.getByLabelText("preview time"), { target: { value: "1" } });
    expect(h.setPlayhead).toHaveBeenCalledWith(1);
  });

  it("plays the rendered video on click (in Rendered mode)", () => {
    h.timeline = timeline;
    h.session = { final_mp4: "x.mp4" };
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    render(<StagePanel projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Rendered" }));
    fireEvent.click(screen.getByTestId("preview-video"));
    expect(play).toHaveBeenCalled();
    play.mockRestore();
  });

  it("reflects the rendered video's transport events (in Rendered mode)", () => {
    h.timeline = timeline;
    h.session = { final_mp4: "x.mp4" };
    render(<StagePanel projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Rendered" }));
    const v = screen.getByTestId("preview-video");
    fireEvent.durationChange(v);
    fireEvent.timeUpdate(v);
    fireEvent.play(v);
    expect(screen.getByRole("button", { name: "pause" })).toBeInTheDocument();
    fireEvent.pause(v);
    expect(screen.getByRole("button", { name: "play" })).toBeInTheDocument();
  });
});
