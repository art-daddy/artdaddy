import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { retryFn, discardFn, cancelFn, navigate } = vi.hoisted(() => ({
  retryFn: vi.fn(),
  discardFn: vi.fn(),
  cancelFn: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("../project/documentRegistry", () => ({
  projectDocuments: {
    retryClose: (id: string) => retryFn(id),
    discardClose: (id: string) => discardFn(id),
    cancelClose: (id: string) => cancelFn(id),
  },
}));
vi.mock("react-router-dom", async (orig) => {
  const actual = await orig<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigate };
});

import CloseFailedDialog from "./CloseFailedDialog";
import { useCloseCoordinator } from "../store/closeCoordinator";

beforeEach(() => {
  retryFn.mockReset();
  discardFn.mockReset().mockResolvedValue(undefined);
  cancelFn.mockReset();
  navigate.mockReset();
  useCloseCoordinator.setState({ pending: null, busy: false, exitHandler: null });
});

describe("CloseFailedDialog", () => {
  it("renders nothing when no close is pending", () => {
    render(<CloseFailedDialog />);
    expect(screen.queryByText(/Couldn.t save this project/)).toBeNull();
  });

  it("Retry re-saves and, on success, navigates to the switch target + clears", async () => {
    retryFn.mockResolvedValue({ ok: true });
    useCloseCoordinator.getState().setPending({ failedId: "A", target: "B" });
    render(<CloseFailedDialog />);
    await act(async () => {
      fireEvent.click(screen.getByText("Retry save"));
    });
    expect(retryFn).toHaveBeenCalledWith("A");
    expect(navigate).toHaveBeenCalledWith("/p/B");
    expect(useCloseCoordinator.getState().pending).toBeNull();
  });

  it("Retry that fails again keeps the modal up (no navigation)", async () => {
    retryFn.mockResolvedValue({ ok: false });
    useCloseCoordinator.getState().setPending({ failedId: "A", target: "B" });
    render(<CloseFailedDialog />);
    await act(async () => {
      fireEvent.click(screen.getByText("Retry save"));
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(useCloseCoordinator.getState().pending).not.toBeNull();
  });

  it("Discard requires a destructive confirm, then tears down and navigates", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    useCloseCoordinator.getState().setPending({ failedId: "A", target: null });
    render(<CloseFailedDialog />);
    await act(async () => {
      fireEvent.click(screen.getByText("Discard"));
    });
    expect(discardFn).toHaveBeenCalledWith("A");
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("Discard cancelled at the confirm does NOT tear down", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    useCloseCoordinator.getState().setPending({ failedId: "A", target: null });
    render(<CloseFailedDialog />);
    await act(async () => {
      fireEvent.click(screen.getByText("Discard"));
    });
    expect(discardFn).not.toHaveBeenCalled();
    expect(useCloseCoordinator.getState().pending).not.toBeNull();
  });

  it("Keep editing cancels the close (fresh scope) and clears — no navigation", async () => {
    useCloseCoordinator.getState().setPending({ failedId: "A", target: "B" });
    render(<CloseFailedDialog />);
    await act(async () => {
      fireEvent.click(screen.getByText("Keep editing"));
    });
    expect(cancelFn).toHaveBeenCalledWith("A");
    expect(navigate).not.toHaveBeenCalled();
    expect(useCloseCoordinator.getState().pending).toBeNull();
  });

  it("for an app-exit close, a successful retry calls the exit handler instead of navigating", async () => {
    const exit = vi.fn();
    retryFn.mockResolvedValue({ ok: true });
    useCloseCoordinator.setState({ exitHandler: exit });
    useCloseCoordinator.getState().setPending({ failedId: "A", target: null, exit: true });
    render(<CloseFailedDialog />);
    await act(async () => {
      fireEvent.click(screen.getByText("Retry save"));
    });
    expect(exit).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("a Retry that THROWS never leaves the recovery modal stuck busy (finding #5)", async () => {
    retryFn.mockRejectedValue(new Error("unexpected"));
    useCloseCoordinator.getState().setPending({ failedId: "A", target: "B" });
    render(<CloseFailedDialog />);
    await act(async () => {
      fireEvent.click(screen.getByText("Retry save"));
    });
    expect(useCloseCoordinator.getState().busy).toBe(false); // re-enabled, not frozen
    expect(useCloseCoordinator.getState().pending).not.toBeNull(); // modal stays up for another try
    expect(navigate).not.toHaveBeenCalled();
  });

  it("a Discard whose teardown THROWS re-enables the actions (finding #5)", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    discardFn.mockReset().mockRejectedValue(new Error("teardown boom"));
    useCloseCoordinator.getState().setPending({ failedId: "A", target: null });
    render(<CloseFailedDialog />);
    await act(async () => {
      fireEvent.click(screen.getByText("Discard"));
    });
    expect(useCloseCoordinator.getState().busy).toBe(false); // not stuck
    expect(navigate).not.toHaveBeenCalled(); // did not "finish" on a failed teardown
  });
});
