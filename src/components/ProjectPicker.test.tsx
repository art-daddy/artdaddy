import { render, screen, waitFor } from "@testing-library/react";
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

import ProjectPicker from "./ProjectPicker";

afterEach(() => {
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
    await waitFor(() => expect(create).toHaveBeenCalledWith("a punchy travel reel", "9:16"));
    // The failure that matters is creating a project and then leaving the user on the picker.
    await waitFor(() => expect(switchTo).toHaveBeenCalledWith("id-a punchy travel reel"));
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
