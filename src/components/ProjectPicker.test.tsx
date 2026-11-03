import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const switchTo = vi.fn((_id: string | null) => Promise.resolve());
vi.mock("../store/closeCoordinator", () => ({ useProjectSwitch: () => switchTo }));

const refresh = vi.fn(() => Promise.resolve());
const create = vi.fn((name: string) => Promise.resolve({ id: `id-${name}` }));
const projects = [
  { id: "old", name: "Last month's cut", path: "/p/old", lastOpenedAt: "2020-01-01T00:00:00Z" },
  { id: "new", name: "Today's reel", path: "/p/new", lastOpenedAt: new Date().toISOString() },
];
let listed = projects;
vi.mock("../store/projects", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useProjects: (sel: any) => sel({ projects: listed, refresh, create }),
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p }));
const { pickMediaPaths } = vi.hoisted(() => ({
  pickMediaPaths: vi.fn(async (): Promise<string[] | null> => []),
}));
vi.mock("../lib/upload", async (orig) => ({ ...(await orig<object>()), pickMediaPaths }));

import ProjectPicker from "./ProjectPicker";
import { OS_DROP_EVENT } from "../lib/osDrop";
import { peekFirstFootage, peekFirstPrompt, setFirstPrompt } from "../store/firstPrompt";

afterEach(() => {
  setFirstPrompt("", "");
  vi.clearAllMocks();
  listed = projects;
});

/** N projects, newest first, so the cap and the expand can be exercised. */
function many(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    name: `Project ${i}`,
    path: `/p/${i}`,
    lastOpenedAt: new Date(Date.now() - i * 60_000).toISOString(),
  }));
}

describe("ProjectPicker", () => {
  it("does not create a project when Enter is pressed on an empty prompt", () => {
    render(<ProjectPicker />);
    fireEvent.keyDown(screen.getByLabelText(/Describe what you want/), { key: "Enter" });
    expect(create).not.toHaveBeenCalled();
    expect(switchTo).not.toHaveBeenCalled();
  });

  it("creates only once while a repeated Start click is waiting for disk", async () => {
    let finish!: (project: { id: string }) => void;
    create.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<ProjectPicker />);
    await userEvent.type(screen.getByLabelText(/Describe what you want/), "Make my reel");
    await userEvent.dblClick(screen.getByRole("button", { name: "Start" }));
    expect(create).toHaveBeenCalledTimes(1);
    await act(async () => finish({ id: "one-request" }));
    expect(switchTo).toHaveBeenCalledTimes(1);
  });

  it("shows a usable failure message when creation rejects without an Error", async () => {
    create.mockRejectedValueOnce("untyped disk failure");
    render(<ProjectPicker />);
    await userEvent.type(screen.getByLabelText(/Describe what you want/), "Make my reel");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("Could not create the project.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  });

  it("lists every known project, most recent first", () => {
    render(<ProjectPicker />);
    const names = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    const recent = names.findIndex((t) => t.includes("Today's reel"));
    const older = names.findIndex((t) => t.includes("Last month's cut"));
    expect(recent).toBeGreaterThanOrEqual(0);
    expect(older).toBeGreaterThanOrEqual(0);
    expect(recent).toBeLessThan(older);
  });

  it("opens the project that was clicked, not merely some project", async () => {
    render(<ProjectPicker />);
    await userEvent.click(screen.getByText("Last month's cut"));
    expect(switchTo).toHaveBeenCalledWith("old");
  });

  it("refreshes the registry so a project created elsewhere is listed", () => {
    render(<ProjectPicker />);
    expect(refresh).toHaveBeenCalled();
  });

  it("creates from a prompt and switches to the project it made", async () => {
    render(<ProjectPicker />);
    await userEvent.type(screen.getByLabelText(/Describe what you want/), "a punchy travel reel");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    // Auto: the first video clip sets the canvas (T-31), so nothing is chosen here.
    await waitFor(() => expect(create).toHaveBeenCalledWith("a punchy travel reel", "auto"));
    // The failure that matters is creating a project and then leaving the user on the picker.
    await waitFor(() => expect(switchTo).toHaveBeenCalledWith("id-a punchy travel reel"));
    expect(peekFirstPrompt("id-a punchy travel reel")).toBe("a punchy travel reel");
    expect(peekFirstPrompt("another-project")).toBeNull();
  });

  it("does not open or queue a request whose start screen was left during creation", async () => {
    let finish!: (project: { id: string }) => void;
    create.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = render(<ProjectPicker />);
    await userEvent.type(screen.getByLabelText(/Describe what you want/), "Make my reel");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    view.unmount();
    await act(async () => finish({ id: "abandoned-project" }));
    expect(switchTo).not.toHaveBeenCalled();
    expect(peekFirstPrompt("abandoned-project")).toBeNull();
  });

  it("clears the queued first prompt if project navigation fails", async () => {
    switchTo.mockRejectedValueOnce(new Error("Navigation refused"));
    render(<ProjectPicker />);
    await userEvent.type(screen.getByLabelText(/Describe what you want/), "Make my reel");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("Navigation refused")).toBeInTheDocument();
    expect(peekFirstPrompt("id-Make my reel")).toBeNull();
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  });

  it("will not create from an empty or whitespace prompt", async () => {
    render(<ProjectPicker />);
    await userEvent.type(screen.getByLabelText(/Describe what you want/), "   ");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(create).not.toHaveBeenCalled();
    expect(switchTo).not.toHaveBeenCalled();
  });

  it("stays on the picker and says why when create fails", async () => {
    create.mockRejectedValueOnce(new Error("disk full"));
    render(<ProjectPicker />);
    await userEvent.type(screen.getByLabelText(/Describe what you want/), "something");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("disk full")).toBeInTheDocument();
    expect(switchTo).not.toHaveBeenCalled();
    // …and the user can try again rather than being stuck on a disabled button.
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  });

  it("offers the same New Project form the File menu uses", async () => {
    render(<ProjectPicker />);
    await userEvent.click(screen.getByRole("button", { name: /New project/ }));
    expect(screen.getByPlaceholderText(/Project name/)).toBeInTheDocument();
  });

  it("shows only the five most recent until asked for the rest", async () => {
    listed = many(12);
    render(<ProjectPicker />);
    expect(screen.getByText("Project 0")).toBeInTheDocument();
    expect(screen.getByText("Project 4")).toBeInTheDocument();
    expect(screen.queryByText("Project 5")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Show all 12 projects/ }));
    expect(screen.getByText("Project 11")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
  });

  it("does not offer to expand when everything already fits", () => {
    listed = many(4);
    render(<ProjectPicker />);
    expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
  });

  it("keeps the MCP link reachable with a long project list", () => {
    // It used to sit under the list, so enough projects pushed it off a page that scrolled as
    // a whole. The list scrolls now; the link does not move.
    listed = many(50);
    const { container } = render(<ProjectPicker />);
    expect(screen.getByRole("button", { name: /Connect Claude/ })).toBeInTheDocument();
    // Nothing above the list may be in a scrolling container — that is what buried it.
    expect(container.querySelector(".overflow-y-auto")?.tagName).toBe("UL");
  });
});

// T-31: the canvas follows the first video clip unless the person chose one.
describe("the aspect a new project starts with", () => {
  it("is Auto, offered first, and says what it means", () => {
    render(<ProjectPicker />);
    const aspect = screen.getByLabelText("Aspect") as HTMLSelectElement;
    expect(aspect.value).toBe("auto");
    expect([...aspect.options].map((o) => o.textContent)).toEqual([
      "Auto (from your first clip)",
      "9:16",
      "16:9",
      "1:1",
    ]);
  });

  it.each(["9:16", "16:9", "1:1"])(
    "a chosen %s is kept: it is what the project is made with",
    async (shape) => {
      render(<ProjectPicker />);
      await userEvent.selectOptions(screen.getByLabelText("Aspect"), shape);
      await userEvent.type(screen.getByLabelText(/Describe what you want/), "my reel");
      await userEvent.click(screen.getByRole("button", { name: "Start" }));
      await waitFor(() => expect(create).toHaveBeenCalledWith("my reel", shape));
    },
  );
});

// T-30: footage can be chosen on the start screen. It cannot be imported here (an import needs the open
// project), so what the person chose travels with the first prompt, and the chat brings it in before sending.
describe("footage chosen on the start screen", () => {
  const prompt = async (text = "Make my reel") =>
    userEvent.type(screen.getByLabelText(/Describe what you want/), text);
  const dropOnPicker = (paths: string[], target = "picker") =>
    act(() => {
      window.dispatchEvent(
        new CustomEvent(OS_DROP_EVENT, { detail: { paths, target, element: null, x: 0, y: 0 } }),
      );
    });

  it("is optional: with none chosen the start is exactly what it was", async () => {
    render(<ProjectPicker />);
    expect(screen.getByRole("button", { name: /Add footage/ })).toBeInTheDocument();
    expect(screen.getByText(/Optional/)).toBeInTheDocument();
    await prompt();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(switchTo).toHaveBeenCalledWith("id-Make my reel"));
    expect(peekFirstPrompt("id-Make my reel")).toBe("Make my reel");
    expect(peekFirstFootage("id-Make my reel")).toEqual([]);
  });

  it("goes with the first prompt, in the order it was chosen, once the project exists", async () => {
    pickMediaPaths.mockResolvedValueOnce(["C:/v/a.mp4", "C:/v/sub/b.mov"]);
    render(<ProjectPicker />);
    await userEvent.click(screen.getByRole("button", { name: /Add footage/ }));
    expect(await screen.findByText("a.mp4")).toBeInTheDocument();
    expect(screen.getByText("b.mov")).toBeInTheDocument();
    await prompt();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(switchTo).toHaveBeenCalledWith("id-Make my reel"));
    expect(peekFirstFootage("id-Make my reel")).toEqual([
      { name: "a.mp4", path: "C:/v/a.mp4" },
      { name: "b.mov", path: "C:/v/sub/b.mov" },
    ]);
    // for the project that was made, not for another
    expect(peekFirstFootage("another-project")).toEqual([]);
  });

  it("one file chosen twice is one file, and a cancelled dialog adds none", async () => {
    pickMediaPaths.mockResolvedValueOnce(["C:/v/a.mp4"]);
    pickMediaPaths.mockResolvedValueOnce(["C:/v/a.mp4"]);
    pickMediaPaths.mockResolvedValueOnce([]);
    render(<ProjectPicker />);
    for (let i = 0; i < 3; i++)
      await userEvent.click(screen.getByRole("button", { name: /Add footage/ }));
    await waitFor(() => expect(pickMediaPaths).toHaveBeenCalledTimes(3));
    expect(screen.getAllByText("a.mp4")).toHaveLength(1);
  });

  it("the same file twice in ONE pick is one file too", async () => {
    pickMediaPaths.mockResolvedValueOnce(["C:/v/a.mp4", "C:/v/b.mp4", "C:/v/a.mp4"]);
    render(<ProjectPicker />);
    await userEvent.click(screen.getByRole("button", { name: /Add footage/ }));
    await screen.findByText("b.mp4");
    expect(screen.getAllByText("a.mp4")).toHaveLength(1);
  });

  it("on the web, one file is the same file by name, size and date, and another date is another file", async () => {
    pickMediaPaths.mockResolvedValue(null);
    const { container } = render(<ProjectPicker />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const take = (...files: File[]) => fireEvent.change(input, { target: { files } });
    const made = (name: string, lastModified: number) =>
      new File(["x"], name, { type: "video/mp4", lastModified });
    take(made("a.mp4", 1000));
    await screen.findByText("a.mp4");
    take(made("a.mp4", 1000)); // the same file chosen again
    take(made("a.mp4", 2000)); // a different file that happens to share a name
    await waitFor(() => expect(screen.getAllByText("a.mp4")).toHaveLength(2));
  });

  it("can be taken out again before starting", async () => {
    pickMediaPaths.mockResolvedValueOnce(["C:/v/a.mp4", "C:/v/b.mp4"]);
    render(<ProjectPicker />);
    await userEvent.click(screen.getByRole("button", { name: /Add footage/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Remove a.mp4" }));
    expect(screen.queryByText("a.mp4")).not.toBeInTheDocument();
    await prompt();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(switchTo).toHaveBeenCalled());
    expect(peekFirstFootage("id-Make my reel")).toEqual([{ name: "b.mp4", path: "C:/v/b.mp4" }]);
  });

  it("takes files dropped on the prompt box, keeps media only, and ignores a drop meant for another zone", async () => {
    render(<ProjectPicker />);
    dropOnPicker(["C:/x/clip.mp4", "C:/x/notes.txt", "D:/y/song.mp3"]);
    expect(await screen.findByText("clip.mp4")).toBeInTheDocument();
    expect(screen.getByText("song.mp3")).toBeInTheDocument();
    expect(screen.queryByText("notes.txt")).not.toBeInTheDocument();
    dropOnPicker(["C:/x/other.mp4"], "chat");
    expect(screen.queryByText("other.mp4")).not.toBeInTheDocument();
  });

  it("on the web, where there is no dialog, a chosen File is carried as the file itself", async () => {
    pickMediaPaths.mockResolvedValueOnce(null);
    const { container } = render(<ProjectPicker />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "web.mp4", { type: "video/mp4" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText("web.mp4")).toBeInTheDocument();
    await prompt();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(switchTo).toHaveBeenCalled());
    expect(peekFirstFootage("id-Make my reel")).toEqual([{ name: "web.mp4", file }]);
  });

  it("is still there to try again when the project could not be made", async () => {
    pickMediaPaths.mockResolvedValueOnce(["C:/v/a.mp4"]);
    create.mockRejectedValueOnce(new Error("disk full"));
    render(<ProjectPicker />);
    await userEvent.click(screen.getByRole("button", { name: /Add footage/ }));
    await screen.findByText("a.mp4");
    await prompt();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("disk full")).toBeInTheDocument();
    expect(screen.getByText("a.mp4")).toBeInTheDocument();
    expect(peekFirstFootage("id-Make my reel")).toEqual([]); // nothing queued for a project that was never made
  });

  it("says why when the file dialog cannot open", async () => {
    pickMediaPaths.mockRejectedValueOnce(new Error("dialog unavailable"));
    render(<ProjectPicker />);
    await userEvent.click(screen.getByRole("button", { name: /Add footage/ }));
    expect(await screen.findByText("dialog unavailable")).toBeInTheDocument();
  });
});
