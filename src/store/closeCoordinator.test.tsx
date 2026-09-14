import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { closeFn, navigate } = vi.hoisted(() => ({ closeFn: vi.fn(), navigate: vi.fn() }));

vi.mock("../project/documentRegistry", () => ({
  projectDocuments: { close: (id: string) => closeFn(id) },
}));
vi.mock("react-router-dom", async (orig) => {
  const actual = await orig<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigate };
});

import { useCloseCoordinator, useProjectSwitch } from "./closeCoordinator";

const at = (path: string) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>;
  };

beforeEach(() => {
  closeFn.mockReset();
  navigate.mockReset();
  useCloseCoordinator.getState().clearPending();
});

describe("useProjectSwitch (controlled switch-veto)", () => {
  it("closes the current project then navigates when it closes cleanly", async () => {
    closeFn.mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useProjectSwitch(), { wrapper: at("/p/A") });
    await act(async () => {
      await result.current("B");
    });
    expect(closeFn).toHaveBeenCalledWith("A"); // current closed FIRST
    expect(navigate).toHaveBeenCalledWith("/p/B");
    expect(useCloseCoordinator.getState().pending).toBeNull();
  });

  it("VETOES the switch and raises the modal when the close fails — stays on the current project", async () => {
    closeFn.mockResolvedValue({ ok: false });
    const { result } = renderHook(() => useProjectSwitch(), { wrapper: at("/p/A") });
    await act(async () => {
      await result.current("B");
    });
    expect(navigate).not.toHaveBeenCalled(); // never left A
    expect(useCloseCoordinator.getState().pending).toEqual({ failedId: "A", target: "B" });
  });

  it("navigates directly with no current project (nothing to close)", async () => {
    const { result } = renderHook(() => useProjectSwitch(), { wrapper: at("/") });
    await act(async () => {
      await result.current("B");
    });
    expect(closeFn).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/p/B");
  });

  it("re-selecting the SAME project is a no-op navigation (no close)", async () => {
    const { result } = renderHook(() => useProjectSwitch(), { wrapper: at("/p/A") });
    await act(async () => {
      await result.current("A");
    });
    expect(closeFn).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/p/A");
  });
});
