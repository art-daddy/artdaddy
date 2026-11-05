import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { askQuestion } from "./store/exportQuestionHost";
import { planQuestions } from "./timeline/exportQuestions";

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

  it("shows a question an export asks (not enough memory, say) in a dialog over the whole app", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    const [question] = planQuestions({
      via: "chat",
      count: 1,
      reasons: new Set(["memory_shortage"]),
      memoryNeededBytes: 3.2e9,
      memoryUsableBytes: 1.9e9,
      spaceNeededBytes: null,
      destinationFreeBytes: null,
      scratchFreeBytes: null,
      destinationShort: false,
      scratchShort: false,
      drive: null,
      movable: false,
      seconds: null,
      secondsGuessed: false,
      executionLimitSeconds: null,
    });
    const outcome = askQuestion(question, { projectDir: "p" });
    const dialog = await screen.findByRole("dialog", { name: "Not enough free memory" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(await outcome).toMatchObject({ answer: "cancel", by: "dialog" });
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
