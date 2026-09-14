// The desktop quit guard. The reported bug: clicking the window's X did nothing at all, forever,
// whenever a project was open -- `core:window:allow-close` was not granted, so `win.close()` REJECTED
// after `preventDefault()` had already held the window. The rejection was unhandled, so the app could
// only be quit by killing the process.
//
// These drive the real `onCloseRequested` callback the app registers and assert the OUTCOME (did the
// window actually go away / did the user get a choice), not the calls made along the way.
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCloseCoordinator } from "./store/closeCoordinator";
import { useEditor } from "./store/editor";

vi.mock("./components/Shell", () => ({ default: () => <div>shell</div> }));
vi.mock("./components/AuthProvider", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("./components/MenuBar", () => ({ default: () => <div>menu</div> }));
vi.mock("./platform", () => ({ platform: { name: "tauri" } }));

const closeProject = vi.fn();
vi.mock("./project/documentRegistry", () => ({
  projectDocuments: {
    close: (...a: unknown[]) => closeProject(...a),
    whenIdle: () => Promise.resolve(),
    firstCloseFailed: () => null,
  },
}));

const winClose = vi.fn();
const winDestroy = vi.fn();
let handler: ((e: { preventDefault: () => void }) => unknown) | null = null;
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    close: () => winClose(),
    destroy: () => winDestroy(),
    onCloseRequested: (fn: (e: { preventDefault: () => void }) => unknown) => {
      handler = fn;
      return Promise.resolve(() => {});
    },
  }),
}));

import App from "./App";

/** Raise a close request and report whether the app held the window open. */
const requestClose = async () => {
  let prevented = false;
  await handler?.({ preventDefault: () => (prevented = true) });
  return prevented;
};

const flush = () => new Promise((r) => setTimeout(r, 0));

const mount = async () => {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <App />
    </MemoryRouter>,
  );
  await flush();
};

beforeEach(() => {
  handler = null;
  winClose.mockReset().mockResolvedValue(undefined);
  winDestroy.mockReset().mockResolvedValue(undefined);
  closeProject.mockReset().mockResolvedValue({ ok: true });
  useCloseCoordinator.setState({ pending: null, busy: false, exitHandler: null });
  useEditor.setState({ projectId: "p1", dirty: false });
});
afterEach(() => useCloseCoordinator.setState({ pending: null, exitHandler: null }));

describe("quitting the app", () => {
  it("closes the window once the project has saved", async () => {
    await mount();
    expect(await requestClose()).toBe(true); // held open while the save runs
    await flush();
    expect(closeProject).toHaveBeenCalled();
    expect(winClose).toHaveBeenCalled();
  });

  it("still closes when close() is DENIED — the reported bug left the app unquittable", async () => {
    winClose.mockRejectedValue(new Error("window.close not allowed: core:window:allow-close"));
    await mount();
    await requestClose();
    await flush();
    await flush();
    expect(winDestroy).toHaveBeenCalled(); // the window goes away regardless
  });

  it("offers recovery instead of hanging when the project close THROWS", async () => {
    closeProject.mockRejectedValue(new Error("disk gone"));
    await mount();
    await requestClose();
    await flush();
    await flush();
    expect(useCloseCoordinator.getState().pending).toMatchObject({ failedId: "p1", exit: true });
    expect(winClose).not.toHaveBeenCalled(); // unsaved work is never thrown away silently
  });

  it("asks before quitting with unsaved edits, and starts NO close until the user answers", async () => {
    useEditor.setState({ projectId: "p1", dirty: true });
    await mount();
    expect(await requestClose()).toBe(true);
    await flush();
    expect(useCloseCoordinator.getState().pending).toMatchObject({ kind: "unsaved", exit: true });
    expect(closeProject).not.toHaveBeenCalled();
    expect(winClose).not.toHaveBeenCalled();
  });

  it("lets the OS close the window when no project is open", async () => {
    useEditor.setState({ projectId: null });
    await mount();
    expect(await requestClose()).toBe(false); // never held open
    expect(closeProject).not.toHaveBeenCalled();
  });

  it("does not re-run the guard on the close it triggers itself", async () => {
    await mount();
    await requestClose();
    await flush();
    closeProject.mockClear();
    expect(await requestClose()).toBe(false); // re-entry: allowed straight through
    expect(closeProject).not.toHaveBeenCalled();
  });
});
