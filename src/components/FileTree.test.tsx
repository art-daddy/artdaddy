import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAddMention } = vi.hoisted(() => ({ mockAddMention: vi.fn() }));
vi.mock("../lib/files", () => ({ listProjectFiles: vi.fn() }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("../store/chat", () => ({
  useChat: (sel: any) => sel({ session: null, addMention: mockAddMention }),
}));
let platformName = "web";
vi.mock("../platform", () => ({
  get platform() {
    return { name: platformName, capabilities: { localTools: true, fileSystem: true } };
  },
}));
vi.mock("../lib/upload", async (io) => {
  const actual = await io<typeof import("../lib/upload")>();
  return { ...actual, uploadFiles: vi.fn(async () => []), importPaths: vi.fn(async () => []) };
});

import { activeDrag } from "../lib/dragSource";
import { listProjectFiles } from "../lib/files";
import { importPaths, uploadFiles } from "../lib/upload";
import FileTree from "./FileTree";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getFiles = listProjectFiles as any;

const tree = [
  {
    name: "library",
    path: "library",
    type: "dir",
    children: [{ name: "clip.mp4", path: "library/clip.mp4", type: "file", size: 2048 }],
  },
  { name: "timeline.json", path: "timeline.json", type: "file", size: 512 },
];

// Switch the library panel from the default thumbnail grid to the list view via
// the right-click context menu.
async function openListView(container: HTMLElement) {
  fireEvent.contextMenu(container.firstChild as Element);
  fireEvent.click(await screen.findByText("List"));
}

describe("FileTree", () => {
  beforeEach(() => {
    platformName = "web";
    vi.mocked(uploadFiles).mockClear();
    vi.mocked(importPaths).mockClear();
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it("shows library media as thumbnail tiles by default", async () => {
    getFiles.mockResolvedValue(tree);
    render(<FileTree projectId="p1" />);
    expect(await screen.findByText("clip.mp4")).toBeInTheDocument();
    expect(screen.queryByText("library")).not.toBeInTheDocument(); // folders hidden in the grid
    expect(screen.queryByText("timeline.json")).not.toBeInTheDocument();
  });

  // A failed read used to render as an EMPTY library, which is indistinguishable from a project
  // with no media: reported as "library pane empty while the agent could see all 27 assets", with
  // nothing to do about it but restart the app.
  describe("a failed listing is not an empty library", () => {
    it("says it could not read, not that there is nothing there", async () => {
      getFiles.mockRejectedValue(new Error("scope: path not allowed"));
      render(<FileTree projectId="p1" />);
      expect(await screen.findByText(/Couldn’t read/i)).toBeInTheDocument();
      expect(screen.queryByText("No files yet.")).not.toBeInTheDocument();
      expect(screen.getByText(/scope: path not allowed/)).toBeInTheDocument();
    });

    it("offers a retry that actually re-reads, and recovers", async () => {
      getFiles.mockRejectedValueOnce(new Error("boom")).mockResolvedValue(tree);
      render(<FileTree projectId="p1" />);
      fireEvent.click(await screen.findByText("Try again"));
      expect(await screen.findByText("clip.mp4")).toBeInTheDocument();
      expect(screen.queryByText(/Couldn’t read/i)).not.toBeInTheDocument();
    });

    it("keeps the last good listing rather than blanking the panel", async () => {
      getFiles.mockResolvedValueOnce(tree).mockRejectedValue(new Error("boom"));
      render(<FileTree projectId="p1" />);
      await screen.findByText("clip.mp4");
      fireEvent.click(screen.getByLabelText("refresh files"));
      // The media the user could see a moment ago must not vanish because one read failed.
      await waitFor(() => expect(getFiles).toHaveBeenCalledTimes(2));
      expect(screen.getByText("clip.mp4")).toBeInTheDocument();
    });

    // The direction that keeps the message honest: an genuinely empty project still says so.
    it("still says 'No files yet' when the read succeeds and returns nothing", async () => {
      getFiles.mockResolvedValue([]);
      render(<FileTree projectId="p1" />);
      expect(await screen.findByText("No files yet.")).toBeInTheDocument();
    });
  });

  it("renders folders + files and collapses a folder (list view)", async () => {
    getFiles.mockResolvedValue(tree);
    const { container } = render(<FileTree projectId="p1" />);
    await screen.findByText("clip.mp4");
    await openListView(container);
    expect(screen.getByText("library")).toBeInTheDocument();
    expect(screen.getByText("timeline.json")).toBeInTheDocument();
    expect(screen.getByText("clip.mp4")).toBeInTheDocument(); // top-level folder open by default
    fireEvent.click(screen.getByText("library"));
    await waitFor(() => expect(screen.queryByText("clip.mp4")).not.toBeInTheDocument());
  });

  it("shows an empty state when there are no files", async () => {
    getFiles.mockResolvedValue([]);
    render(<FileTree projectId="p1" />);
    expect(await screen.findByText(/No files yet/)).toBeInTheDocument();
  });

  // Was "recovers to empty on a fetch error" — it asserted the defect: a failed read renders as an
  // empty library. That is what made "the library pane is empty" unreadable to the person looking
  // at it, and there was nothing to click.
  it("does not report a fetch error as an empty library", async () => {
    getFiles.mockRejectedValue(new Error("boom"));
    render(<FileTree projectId="p1" />);
    expect(await screen.findByText(/Couldn’t read/i)).toBeInTheDocument();
    expect(screen.queryByText(/No files yet/)).not.toBeInTheDocument();
  });

  // Tauri owns the drag handler now, so the gesture is pointer-based. What matters is what the
  // drag CARRIES to the timeline, not which attribute the element has.
  it("dragging a media tile offers it to the timeline as its library ref", async () => {
    getFiles.mockResolvedValue(tree);
    render(<FileTree projectId="p1" />);
    const tile = (await screen.findByText("clip.mp4")).closest("button")!;
    fireEvent.pointerDown(tile, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 60, clientY: 60 }); // past the 5px threshold
    expect(activeDrag()).toEqual({ ref: "library/clip.mp4", name: "clip.mp4" });
    fireEvent.pointerUp(window, { clientX: 60, clientY: 60 });
    expect(activeDrag()).toBeNull();
  });

  it("a click on a tile is not a drag", async () => {
    // The threshold is what keeps selecting a clip from starting a drag; without it every
    // click would spawn a ghost and the panel would be unusable.
    getFiles.mockResolvedValue(tree);
    render(<FileTree projectId="p1" />);
    const tile = (await screen.findByText("clip.mp4")).closest("button")!;
    fireEvent.pointerDown(tile, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 12, clientY: 12 });
    expect(activeDrag()).toBeNull();
    fireEvent.pointerUp(window, { clientX: 12, clientY: 12 });
  });

  it("a non-media file cannot be dragged to the timeline (list view)", async () => {
    getFiles.mockResolvedValue(tree);
    const { container } = render(<FileTree projectId="p1" />);
    await screen.findByText("clip.mp4");
    await openListView(container);
    const json = screen.getByText("timeline.json").closest("div")!;
    fireEvent.pointerDown(json, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 60, clientY: 60 });
    expect(activeDrag()).toBeNull();
    fireEvent.pointerUp(window, { clientX: 60, clientY: 60 });
  });

  it("refresh re-reads the file list", async () => {
    getFiles.mockResolvedValue([]);
    render(<FileTree projectId="p1" />);
    await screen.findByText(/No files yet/);
    getFiles.mockResolvedValue(tree);
    fireEvent.click(screen.getByLabelText("refresh files"));
    expect(await screen.findByText("clip.mp4")).toBeInTheDocument();
  });

  it("highlights on drag-over and imports dropped media", async () => {
    getFiles.mockResolvedValue([]);
    const { container } = render(<FileTree projectId="p1" />);
    await screen.findByText(/No files yet/);
    const root = container.firstChild as Element;
    fireEvent.dragOver(root, { dataTransfer: { types: ["Files"], dropEffect: "" } });
    expect(await screen.findByText("Drop to import")).toBeInTheDocument();
    const file = new File(["x"], "drop.mp4", { type: "video/mp4" });
    fireEvent.drop(root, { dataTransfer: { files: [file], types: ["Files"] } });
    await waitFor(() => expect(uploadFiles).toHaveBeenCalled());
  });

  // On desktop the page must NOT take the drop: claiming it is what made macOS hand the webview
  // a QuickLook still of the dropped video instead of handing Tauri the file, so the library
  // filled up with `.jpeg` copies of videos.
  it("ignores an HTML5 file drop on desktop and takes the routed PATHS instead", async () => {
    platformName = "tauri";
    getFiles.mockResolvedValue([]);
    const { container } = render(<FileTree projectId="p1" />);
    await screen.findByText(/No files yet/);
    const root = container.firstChild as Element;

    fireEvent.drop(root, {
      dataTransfer: {
        files: [new File(["x"], "preview.jpeg", { type: "image/jpeg" })],
        types: ["Files"],
      },
    });
    await waitFor(() => expect(uploadFiles).not.toHaveBeenCalled());

    window.dispatchEvent(
      new CustomEvent("artdaddy:os-drop", {
        detail: { paths: ["/Users/me/real.mov"], target: "library", element: null, x: 0, y: 0 },
      }),
    );
    await waitFor(() => expect(importPaths).toHaveBeenCalledWith("p1", ["/Users/me/real.mov"]));
  });

  it("offers Import media in the panel context menu", async () => {
    getFiles.mockResolvedValue(tree);
    const { container } = render(<FileTree projectId="p1" />);
    await screen.findByText("clip.mp4");
    fireEvent.contextMenu(container.firstChild as Element);
    expect(await screen.findByText("Import media\u2026")).toBeInTheDocument();
  });

  it("'Add to chat' stages a media mention for the clip", async () => {
    getFiles.mockResolvedValue(tree);
    render(<FileTree projectId="p1" />);
    const tile = (await screen.findByText("clip.mp4")).closest("button")!;
    fireEvent.contextMenu(tile);
    fireEvent.click(await screen.findByText("Add to chat"));
    expect(mockAddMention).toHaveBeenCalled();
  });
});
