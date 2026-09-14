import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-resizable-panels", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  PanelGroup: ({ children }: any) => <div>{children}</div>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Panel: ({ children }: any) => <div>{children}</div>,
  PanelResizeHandle: () => <div />,
}));
vi.mock("./LeftColumn", () => ({ default: () => <div>leftcol</div> }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("./StagePanel", () => ({ default: ({ projectId }: any) => <div>stage:{projectId}</div> }));
vi.mock("./ChatView", () => ({ default: () => <div>chat</div> }));
vi.mock("./ProjectPicker", () => ({ default: () => <div>project-picker</div> }));

const openMock = vi.fn((_id: string) => Promise.resolve());
const openDocMock = vi.fn((_id: string) => Promise.resolve({} as unknown));
const closeDocMock = vi.fn((_id: string) => Promise.resolve());
const whenIdleMock = vi.fn(() => Promise.resolve());
const firstCloseFailedMock = vi.fn((): { id: string } | undefined => undefined);
const navigate = vi.fn();
vi.mock("react-router-dom", async (orig) => {
  const actual = await orig<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigate };
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("../store/projects", () => ({ useProjects: (sel: any) => sel({ open: openMock }) }));
// The real Inspector/TimelineEditor render (unmocked) inside Shell and read editor/chat via
// the hooks; a stub selecting from an empty state is enough here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("../store/chat", () => ({ useChat: (sel: any) => sel({}) }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("../store/editor", () => ({ useEditor: (sel: any) => sel({}) }));
vi.mock("../tools/host", () => ({
  openToolHost: () => ({ ready: Promise.resolve() }),
  closeToolHost: () => undefined,
}));
// Shell now routes activation through the ProjectDocument registry (the single lifecycle owner).
vi.mock("../project/documentRegistry", () => ({
  projectDocuments: {
    open: (id: string) => openDocMock(id),
    close: (id: string) => closeDocMock(id),
    whenIdle: () => whenIdleMock(),
    firstCloseFailed: () => firstCloseFailedMock(),
  },
}));

import Shell from "./Shell";
import { useCloseCoordinator } from "../store/closeCoordinator";

beforeEach(() => useCloseCoordinator.setState({ pending: null, busy: false, exitHandler: null }));
afterEach(() => vi.clearAllMocks());

describe("Shell", () => {
  it("opens the document and reveals the panes once the project loads", async () => {
    render(<Shell projectId="p1" />);
    expect(screen.getByText("leftcol")).toBeInTheDocument();
    // open() now runs AFTER the close-before-open barrier + the failed-close veto (findings #3/#4), so
    // it's awaited rather than synchronous.
    await waitFor(() => expect(openMock).toHaveBeenCalledWith("p1"));
    // The panes reveal only AFTER open() + the document open resolve (RF7), so they never
    // flash the previous project's store state.
    await waitFor(() => expect(screen.getByText("stage:p1")).toBeInTheDocument());
    expect(screen.getByText("chat")).toBeInTheDocument();
    expect(openDocMock).toHaveBeenCalledWith("p1");
  });

  it("holds the panes on a placeholder while open() is pending (RF7)", async () => {
    let releaseOpen: () => void = () => {};
    openMock.mockReturnValueOnce(new Promise<void>((r) => (releaseOpen = () => r())));
    render(<Shell projectId="p1" />);
    // While open() is pending, NO stage/chat pane is mounted (no flash of the previous
    // project's store state) -- only the placeholder, and the document is not opened yet.
    expect(screen.getByText(/Opening project/)).toBeInTheDocument();
    expect(screen.queryByText("stage:p1")).not.toBeInTheDocument();
    expect(screen.queryByText("chat")).not.toBeInTheDocument();
    expect(openDocMock).not.toHaveBeenCalled();
    releaseOpen();
    await waitFor(() => expect(screen.getByText("stage:p1")).toBeInTheDocument());
    expect(screen.getByText("chat")).toBeInTheDocument();
  });

  it("shows an error and hides the panes when the document open fails (Q2)", async () => {
    openDocMock.mockRejectedValueOnce(new Error("unreadable"));
    render(<Shell projectId="p1" />);
    // A failed open must surface an error, NOT reveal a null / stale workspace.
    expect(await screen.findByText(/Couldn't open this project/)).toBeInTheDocument();
    expect(screen.queryByText("stage:p1")).not.toBeInTheDocument();
    expect(screen.queryByText("chat")).not.toBeInTheDocument();
  });

  it("refuses a project when open() rejects: opens no document and shows the message", async () => {
    const msg = "This project was created by a newer version of ArtDaddy.";
    openMock.mockRejectedValueOnce(new Error(msg));
    render(<Shell projectId="too-new" />);
    // The refusal message replaces the editor, and the chat pane is gone.
    expect(await screen.findByText(msg)).toBeInTheDocument();
    expect(screen.queryByText("stage:too-new")).not.toBeInTheDocument();
    expect(screen.queryByText("chat")).not.toBeInTheDocument();
    // Crucially: no document (timeline/chat/tool host) is opened for a refused project.
    expect(openDocMock).not.toHaveBeenCalled();
  });

  it("withholds the whole workspace and offers the picker with no project", () => {
    render(<Shell projectId={null} />);
    expect(screen.getByText("project-picker")).toBeInTheDocument();
    // The reported bug: a LIBRARY with nothing to list and a FILES tree of no project used to
    // render anyway. No pane that describes a project may mount without one.
    expect(screen.queryByText("leftcol")).not.toBeInTheDocument();
    expect(screen.queryByText("chat")).not.toBeInTheDocument();
    expect(screen.queryByText(/stage:/)).not.toBeInTheDocument();
    expect(openMock).not.toHaveBeenCalled();
    expect(openDocMock).not.toHaveBeenCalled();
  });

  it("closes the document on unmount", () => {
    const { unmount } = render(<Shell projectId="p2" />);
    unmount();
    expect(closeDocMock).toHaveBeenCalledWith("p2");
  });

  it("closes the document on route teardown so no hidden turn keeps running (R7-3)", async () => {
    const { rerender, unmount } = render(<Shell projectId="p1" />);
    await waitFor(() => expect(openDocMock).toHaveBeenCalledWith("p1"));
    // Leaving to NO project must close the document (which retires the chat turn + disposes
    // the stores) even though the open effect won't run again.
    rerender(<Shell projectId={null} />);
    expect(closeDocMock).toHaveBeenCalledWith("p1");
    unmount();
  });

  it("waits for the previous project to finish closing before opening the next", async () => {
    const { rerender } = render(<Shell projectId="p1" />);
    await waitFor(() => expect(openDocMock).toHaveBeenCalledWith("p1"));
    openDocMock.mockClear();
    // Hold the close-before-open barrier: p2 must not open until the previous close settles.
    let releaseIdle: () => void = () => {};
    whenIdleMock.mockReturnValueOnce(new Promise<void>((r) => (releaseIdle = () => r())));
    rerender(<Shell projectId="p2" />);
    await waitFor(() => expect(closeDocMock).toHaveBeenCalledWith("p1")); // p1 closed on switch
    await Promise.resolve();
    expect(openDocMock).not.toHaveBeenCalledWith("p2"); // ...and p2 is blocked on the barrier
    releaseIdle();
    await waitFor(() => expect(openDocMock).toHaveBeenCalledWith("p2"));
  });

  it("vetoes opening a project over a FAILED close: routes back to it + raises the modal (finding #4)", async () => {
    // A previous project's close FAILED (retained, close-failed). A raw route change to p2 (browser
    // Back/Forward or direct URL — bypassing the menu's useProjectSwitch) must NOT open p2 over it:
    // Shell routes BACK to the failed p1 and raises the Retry/Discard/Cancel modal.
    firstCloseFailedMock.mockReturnValueOnce({ id: "p1" });
    render(<Shell projectId="p2" />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/p/p1", { replace: true }));
    expect(openDocMock).not.toHaveBeenCalledWith("p2"); // p2 was NOT opened over the failed p1
    expect(useCloseCoordinator.getState().pending).toEqual({ failedId: "p1", target: "p2" });
  });

  it("does NOT veto when navigating TO the failed project itself — reveals it + the modal (finding #4)", async () => {
    // We ARE going to the failed project; falling through reveals it (with the modal already up),
    // instead of looping the navigation back onto itself.
    firstCloseFailedMock.mockReturnValueOnce({ id: "p1" });
    render(<Shell projectId="p1" />);
    await waitFor(() => expect(openDocMock).toHaveBeenCalledWith("p1"));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("vetoes leaving to the HOME route when a close failed: routes back + raises the modal (finding #3)", async () => {
    // Browser Back from /p/A to / must NOT silently hide a failed close — the null (home) destination
    // is vetoed too, routing back to the failed project with the recovery modal.
    firstCloseFailedMock.mockReturnValueOnce({ id: "p1" });
    render(<Shell projectId={null} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/p/p1", { replace: true }));
    expect(useCloseCoordinator.getState().pending).toEqual({ failedId: "p1", target: null });
  });

  it("does NOT persist the target as active before the veto (finding #3)", async () => {
    // projects.open() persists the project as the active id; it must run AFTER the veto so a switch we
    // veto never leaves the target persisted as active.
    firstCloseFailedMock.mockReturnValueOnce({ id: "p1" });
    render(<Shell projectId="p2" />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/p/p1", { replace: true }));
    expect(openMock).not.toHaveBeenCalledWith("p2"); // never persisted p2 as active
    expect(openDocMock).not.toHaveBeenCalledWith("p2");
  });
});
