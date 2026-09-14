import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("./FileTree", () => ({
  default: ({ projectId }: { projectId: string }) => <div>file-tree:{projectId}</div>,
}));

import ProjectSidebar from "./ProjectSidebar";

describe("ProjectSidebar", () => {
  it("shows the file tree for the active project", () => {
    render(
      <MemoryRouter initialEntries={["/p/abc"]}>
        <Routes>
          <Route path="/p/:projectId" element={<ProjectSidebar />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("file-tree:abc")).toBeInTheDocument();
    expect(screen.getByText("Files")).toBeInTheDocument();
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
