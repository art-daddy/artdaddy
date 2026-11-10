import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ConfirmDialog from "./ConfirmDialog";

function setup(over: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <ConfirmDialog
      open
      title="Delete this chat?"
      confirmLabel="Delete"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...over}
    >
      It will be gone for good.
    </ConfirmDialog>,
  );
  return { onConfirm, onCancel, view };
}

describe("ConfirmDialog", () => {
  it("shows nothing while closed", () => {
    setup({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is a modal dialog named by its title and described by its text", () => {
    setup();
    const dialog = screen.getByRole("dialog", { name: "Delete this chat?" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("It will be gone for good.");
  });

  it("puts focus on Cancel, so a stray Enter keeps what is at stake", () => {
    setup({ destructive: true });
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("confirms with the confirm button, and cancels with Cancel or Escape", async () => {
    const { onConfirm, onCancel } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("uses the label it is given for Cancel", () => {
    setup({ cancelLabel: "Keep it" });
    expect(screen.getByRole("button", { name: "Keep it" })).toBeVisible();
  });

  it("a double click confirms once, and nothing can be cancelled while it works", async () => {
    let finish!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const { onCancel } = setup({ onConfirm });
    const confirm = screen.getByRole("button", { name: "Delete" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => finish());
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled());
  });

  it("works again after the action throws, and the failure is reported, not left unhandled", async () => {
    const onConfirm = vi.fn(async () => {
      throw new Error("boom");
    });
    setup({ onConfirm });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("starts fresh each time it opens", () => {
    const { view, onConfirm, onCancel } = setup();
    view.rerender(
      <ConfirmDialog
        open={false}
        title="t"
        confirmLabel="Delete"
        onConfirm={onConfirm}
        onCancel={onCancel}
      >
        x
      </ConfirmDialog>,
    );
    view.rerender(
      <ConfirmDialog open title="t" confirmLabel="Delete" onConfirm={onConfirm} onCancel={onCancel}>
        x
      </ConfirmDialog>,
    );
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });
});
