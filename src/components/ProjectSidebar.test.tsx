import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

// The real FileTree renders its own "Library" header, because it owns the import / record /
// refresh actions that sit in it. The mock says so too — that is the fact this file guards:
// a second header here put LIBRARY on screen twice, one directly above the other.
vi.mock("./FileTree", () => ({
  default: ({ projectId, onHide }: { projectId: string; onHide?: () => void }) => (
    <div>
      <span>Library</span>
      <span>file-tree:{projectId}</span>
      {onHide && <button aria-label="hide Library">×</button>}
    </div>
  ),
}));

import ProjectSidebar from "./ProjectSidebar";

const atProject = (el: JSX.Element) =>
  render(
    <MemoryRouter initialEntries={["/p/abc"]}>
      <Routes>
        <Route path="/p/:projectId" element={el} />
      </Routes>
    </MemoryRouter>,
  );

describe("ProjectSidebar", () => {
  it("shows the file tree for the active project", () => {
    atProject(<ProjectSidebar />);
    expect(screen.getByText("file-tree:abc")).toBeInTheDocument();
  });

  it("says Library exactly once", () => {
    atProject(<ProjectSidebar />);
    expect(screen.getAllByText(/^library$/i)).toHaveLength(1);
  });

  // The hide button belongs in the ONE header, which the tree owns — not in a second one.
  it("gives the hide button to the tree's header rather than adding a header for it", () => {
    atProject(<ProjectSidebar onHide={vi.fn()} />);
    expect(screen.getByLabelText("hide Library")).toBeInTheDocument();
    expect(screen.getAllByText(/^library$/i)).toHaveLength(1);
  });

  it("prompts to open a project when none is active", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <ProjectSidebar />
      </MemoryRouter>,
    );
    expect(screen.getByText(/No project open/)).toBeInTheDocument();
    expect(screen.queryByText(/file-tree/)).not.toBeInTheDocument();
  });
});
