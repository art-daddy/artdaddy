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
  mediaTabs: [] as { ref: string; transient: boolean }[],
  activeMediaTab: null as string | null,
}));

vi.mock("./PreviewCanvas", () => ({ default: () => <div>preview</div> }));
vi.mock("./SourceMonitor", () => ({
  default: ({ mediaRef }: { mediaRef: string }) => <div>source:{mediaRef}</div>,
}));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("../store/chat", () => ({ useChat: (sel: any) => sel({ session: h.session }) }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("../store/projects", () => ({ useProjects: (sel: any) => sel({ active: h.active }) }));
vi.mock("../store/editor", () => ({
  useEditor: Object.assign(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sel: any) =>
      sel({
        timeline: h.timeline,
        playhead: h.playhead,
        setPlayhead: h.setPlayhead,
        mediaTabs: h.mediaTabs,
        activeMediaTab: h.activeMediaTab,
        mediaNames: {},
        setActiveMediaTab: vi.fn(),
        openMediaTab: vi.fn(),
        closeMediaTab: vi.fn(),
      }),
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
  h.mediaTabs = [];
  h.activeMediaTab = null;
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

  // The source monitor used to be a pane of its own. Now it is a TAB of this one, so the
  // thing to prove is that the two monitors never drive the stage at the same time:
  // whichever tab is showing owns the picture, the chrome and the transport.
  describe("source tabs", () => {
    it("starts on the live preview, with no source monitor over it", () => {
      h.timeline = timeline;
      render(<StagePanel projectId="p1" />);
      expect(screen.getByText("preview")).toBeInTheDocument();
      expect(screen.queryByText(/^source:/)).not.toBeInTheDocument();
      expect(screen.getByLabelText("preview time")).toBeInTheDocument();
    });

    it("shows the clip a source tab points at", () => {
      h.timeline = timeline;
      h.mediaTabs = [{ ref: "m_1", transient: true }];
      h.activeMediaTab = "m_1";
      render(<StagePanel projectId="p1" />);
      expect(screen.getByText("source:m_1")).toBeInTheDocument();
    });

    // The reason for the overlay: a glance at a library clip must not cost a worker
    // teardown and a re-decode of the whole composite when you switch back.
    it("keeps the live compositor mounted underneath rather than tearing it down", () => {
      h.timeline = timeline;
      h.mediaTabs = [{ ref: "m_1", transient: true }];
      h.activeMediaTab = "m_1";
      render(<StagePanel projectId="p1" />);
      expect(screen.getByText("preview")).toBeInTheDocument();
    });

    it("hands the transport to the source tab, so only one clock is showing", () => {
      h.timeline = timeline;
      h.mediaTabs = [{ ref: "m_1", transient: true }];
      h.activeMediaTab = "m_1";
      render(<StagePanel projectId="p1" />);
      expect(screen.queryByLabelText("preview time")).not.toBeInTheDocument();
    });

    // Zoom / crop / Live-Rendered act on the PROGRAM monitor. Left visible over a source
    // clip they would be controls with nothing to control.
    it("withholds the program-monitor controls while a source tab is showing", () => {
      h.timeline = timeline;
      h.active = { name: "My Reel", manifest: { final_mp4: "x.mp4" } };
      h.mediaTabs = [{ ref: "m_1", transient: true }];
      h.activeMediaTab = "m_1";
      render(<StagePanel projectId="p1" />);
      expect(screen.queryByLabelText("canvas zoom")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("crop mode")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Rendered" })).not.toBeInTheDocument();
      expect(screen.queryByText(/1080×1920/)).not.toBeInTheDocument();
    });

    // Space is the timeline's play key. On a source tab it would start the program monitor
    // the user cannot see -- audio under a clip they are auditioning.
    it("ignores the timeline's play key while a source tab is showing", () => {
      h.timeline = timeline;
      h.mediaTabs = [{ ref: "m_1", transient: true }];
      h.activeMediaTab = "m_1";
      render(<StagePanel projectId="p1" />);
      window.dispatchEvent(new Event("artdaddy:toggle-play"));
      expect(screen.queryByRole("button", { name: "pause" })).not.toBeInTheDocument();
    });

    it("stops program playback when the user leaves the live tab", () => {
      h.timeline = timeline;
      const { rerender } = render(<StagePanel projectId="p1" />);
      fireEvent.click(screen.getByRole("button", { name: "play" }));
      expect(screen.getByRole("button", { name: "pause" })).toBeInTheDocument();
      h.mediaTabs = [{ ref: "m_1", transient: true }];
      h.activeMediaTab = "m_1";
      rerender(<StagePanel projectId="p1" />);
      h.activeMediaTab = null;
      rerender(<StagePanel projectId="p1" />);
      // Back on the live tab the transport is idle, not still running from before.
      expect(screen.getByRole("button", { name: "play" })).toBeInTheDocument();
    });
  });
});
