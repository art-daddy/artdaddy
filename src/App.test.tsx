import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("./components/Shell", () => ({
  default: ({ projectId }: { projectId: string | null }) => <div>shell:{projectId ?? "none"}</div>,
}));

// AuthProvider verifies a token in the BACKGROUND (never blocks the editor); a
// routing unit test has no backend, so stub it to just render its children.
vi.mock("./components/AuthProvider", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// App renders the real MenuBar, which needs a ClerkProvider — unrelated to routing.
import App from "./App";

describe("App routing", () => {
  it("renders the shell with no project at /", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByText("shell:none")).toBeInTheDocument();
  });

  it("passes the project id to the shell at /p/:id", () => {
    render(
      <MemoryRouter initialEntries={["/p/p1"]}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByText("shell:p1")).toBeInTheDocument();
  });

  it("blocks the webview default only when files are dragged over the window", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    const files = new Event("dragover", { cancelable: true });
    Object.defineProperty(files, "dataTransfer", { value: { types: ["Files"] } });
    const prevented = vi.spyOn(files, "preventDefault");
    window.dispatchEvent(files);
    expect(prevented).toHaveBeenCalled();

    const text = new Event("drop", { cancelable: true });
    Object.defineProperty(text, "dataTransfer", { value: { types: ["text/plain"] } });
    const ignored = vi.spyOn(text, "preventDefault");
    window.dispatchEvent(text);
    expect(ignored).not.toHaveBeenCalled();
  });
});
