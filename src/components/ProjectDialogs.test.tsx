// Creating a project used to fail SILENTLY: submit() had a try/finally with no catch, so a
// rejection escaped as an unhandled rejection, the dialog stayed open and nothing was rendered.
// The button simply stopped working, and the user pressed it again. Found by driving the real
// UI, where a missing desktop bridge produced exactly that — but the same shape covers every
// real cause on desktop: an unwritable location, a permission error, a name that cannot be used.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NewProjectDialog } from "./ProjectDialogs";

const create = vi.fn();
vi.mock("../store/projects", () => ({
  useProjects: (sel: (s: { create: unknown }) => unknown) => sel({ create }),
}));
vi.mock("../platform", () => ({ platform: { name: "web" } }));

async function fillAndSubmit(name = "my film") {
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText(/Project name/i), name);
  await user.click(screen.getByRole("button", { name: /^Create$/ }));
  return user;
}

describe("NewProjectDialog", () => {
  beforeEach(() => {
    create.mockReset();
  });

  it("tells the user why a project could not be created", async () => {
    create.mockRejectedValue(new Error("permission denied"));
    const onClose = vi.fn();
    const onDone = vi.fn();
    render(<NewProjectDialog onClose={onClose} onDone={onDone} />);

    await fillAndSubmit();

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/permission denied/i));
    // Still open, so the typed name is not lost and the cause stays on screen.
    expect(onClose).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("leaves the button usable so the user can correct and retry", async () => {
    // The `finally` already reset busy; this pins that a failure does not strand the dialog in
    // "Creating…" and that a second attempt can succeed.
    create.mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce({ id: "p2" });
    const onClose = vi.fn();
    const onDone = vi.fn();
    render(<NewProjectDialog onClose={onClose} onDone={onDone} />);

    const user = await fillAndSubmit();
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /^Create$/ }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("p2"));
    expect(onClose).toHaveBeenCalled();
  });

  it("clears a previous failure when the next attempt succeeds", async () => {
    create.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ id: "p3" });
    render(<NewProjectDialog onClose={vi.fn()} onDone={vi.fn()} />);

    const user = await fillAndSubmit();
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /^Create$/ }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("closes only when the project was actually created", async () => {
    create.mockResolvedValue({ id: "p1" });
    const onClose = vi.fn();
    const onDone = vi.fn();
    render(<NewProjectDialog onClose={onClose} onDone={onDone} />);

    await fillAndSubmit();

    await waitFor(() => expect(onDone).toHaveBeenCalledWith("p1"));
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
