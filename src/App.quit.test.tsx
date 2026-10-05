// The desktop quit guard. The reported bug: clicking the window's X did nothing at all, forever,
// whenever a project was open -- `core:window:allow-close` was not granted, so `win.close()` REJECTED
// after `preventDefault()` had already held the window. The rejection was unhandled, so the app could
// only be quit by killing the process.
//
// These drive the real `onCloseRequested` callback the app registers and assert the OUTCOME (did the
// window actually go away / did the user get a choice), not the calls made along the way.
import { fireEvent, render, screen } from "@testing-library/react";
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
let windowClosed = false;
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    // Like Tauri: close() raises the close request, and the window goes away unless it is held.
    close: async () => {
      await winClose();
      let held = false;
      await handler?.({ preventDefault: () => (held = true) });
      if (!held) windowClosed = true;
    },
    destroy: () => winDestroy(),
    onCloseRequested: (fn: (e: { preventDefault: () => void }) => unknown) => {
      handler = fn;
      return Promise.resolve(() => {});
    },
  }),
}));

const order: string[] = [];
const update = vi.hoisted(() => ({
  check: vi.fn(),
  download: vi.fn(),
  install: vi.fn(),
}));
vi.mock("./update/updater", () => ({
  checkForUpdate: () => update.check(),
  downloadUpdate: () => update.download(),
  installUpdate: () => update.install(),
}));

// The export queue as the quit guard sees it: what is still running, and stopping it.
const exportsQ = vi.hoisted(() => ({
  running: [] as { job_id: string; filename: string; state: "running" | "queued" }[],
  cancel: vi.fn(),
  stuck: false, // an export that ignores being stopped and never settles
}));
vi.mock("./timeline/exportQueue", () => ({
  listExports: () => [...exportsQ.running],
  cancelExport: (id: string) => {
    exportsQ.cancel(id);
    if (!exportsQ.stuck) exportsQ.running = exportsQ.running.filter((e) => e.job_id !== id);
    return true;
  },
  whenExportsSettle: () => (exportsQ.stuck ? new Promise<void>(() => {}) : Promise.resolve()),
}));
const ask = vi.hoisted(() => vi.fn());
vi.mock("./lib/confirm", () => ({ confirmDestructive: (m: string) => ask(m) }));

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
  windowClosed = false;
  order.length = 0;
  winClose.mockReset().mockResolvedValue(undefined);
  winDestroy.mockReset().mockResolvedValue(undefined);
  closeProject.mockReset().mockImplementation(async () => {
    order.push("project closed");
    return { ok: true };
  });
  update.check.mockReset().mockResolvedValue(null);
  update.download.mockReset().mockResolvedValue("9.9.9");
  update.install.mockReset().mockImplementation(async () => {
    order.push("update installed");
  });
  useCloseCoordinator.setState({
    pending: null,
    busy: false,
    exitHandler: null,
    exitIntent: "quit",
    exitError: null,
  });
  useEditor.setState({ projectId: "p1", dirty: false });
  exportsQ.running = [];
  exportsQ.stuck = false;
  exportsQ.cancel.mockReset().mockImplementation(() => order.push("export stopped"));
  ask.mockReset();
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

// Owner decision 2026-10-05: an export dies with the app, so quitting while one runs asks first.
describe("quitting while an export runs", () => {
  const running = () => {
    exportsQ.running = [{ job_id: "e1", filename: "cut.mp4", state: "running" }];
  };

  it("asks first, and No keeps the app, the project and the export", async () => {
    running();
    ask.mockResolvedValue(false);
    await mount();
    expect(await requestClose()).toBe(true);
    for (let i = 0; i < 4; i++) await flush();
    expect(ask).toHaveBeenCalledWith("An export is still running. Quit and stop it?");
    expect(exportsQ.cancel).not.toHaveBeenCalled();
    expect(closeProject).not.toHaveBeenCalled();
    expect(windowClosed).toBe(false);
  });

  it("Quit stops the export first, then saves the project and closes", async () => {
    running();
    ask.mockResolvedValue(true);
    await mount();
    await requestClose();
    for (let i = 0; i < 6; i++) await flush();
    expect(order).toEqual(["export stopped", "project closed"]);
    expect(windowClosed).toBe(true);
  });

  it("asks even with no project open: the export does not belong to one", async () => {
    running();
    ask.mockResolvedValue(false);
    useEditor.setState({ projectId: null });
    await mount();
    expect(await requestClose()).toBe(true);
    await flush();
    expect(ask).toHaveBeenCalled();
    expect(windowClosed).toBe(false);
  });

  it("asks nothing when no export runs", async () => {
    await mount();
    await requestClose();
    for (let i = 0; i < 4; i++) await flush();
    expect(ask).not.toHaveBeenCalled();
    expect(closeProject).toHaveBeenCalled();
  });

  it("an export that will not stop cannot trap the user: one Quit is enough", async () => {
    running();
    exportsQ.stuck = true;
    ask.mockResolvedValue(true);
    await mount();
    vi.useFakeTimers();
    try {
      const closing = requestClose();
      await vi.advanceTimersByTimeAsync(10_000); // the wait for the export gives up
      await vi.advanceTimersByTimeAsync(10_000); // (room for a second wait, were there one)
      await closing;
    } finally {
      vi.useRealTimers();
    }
    for (let i = 0; i < 6; i++) await flush();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(closeProject).toHaveBeenCalled(); // the project is still saved on the way out
    expect(windowClosed).toBe(true);
  });

  it("a later quit asks again: one Quit answers that quit only", async () => {
    running();
    exportsQ.stuck = true;
    ask.mockResolvedValue(true);
    closeProject.mockResolvedValue({ ok: false }); // the save fails, so the app stays open
    await mount();
    vi.useFakeTimers();
    try {
      const closing = requestClose();
      await vi.advanceTimersByTimeAsync(10_000);
      await closing;
    } finally {
      vi.useRealTimers();
    }
    for (let i = 0; i < 6; i++) await flush();
    expect(windowClosed).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    useCloseCoordinator.setState({ pending: null });
    ask.mockResolvedValue(false);
    expect(await requestClose()).toBe(true);
    await flush();
    expect(ask).toHaveBeenCalledTimes(2); // the export still runs, so this quit asks too
  });
});

// "Restart & update" used to install and relaunch straight from Rust, so the unsaved-edits prompt,
// the final save and the lock release never ran: the relaunched app then warned that the user's
// own project was "open somewhere else". It now leaves through the same door as closing the window.
describe("Restart & update", () => {
  const clickRestart = async () => {
    await mount();
    fireEvent.click(await screen.findByRole("button", { name: "Restart & update" }));
    for (let i = 0; i < 6; i++) await flush();
  };
  beforeEach(() => update.check.mockResolvedValue({ version: "9.9.9" }));

  it("closes the project first, then installs", async () => {
    await clickRestart();
    expect(update.download).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["project closed", "update installed"]);
    expect(windowClosed).toBe(false); // the installer ends the process, not a window close
  });

  it("asks about unsaved edits first, and installs nothing until the user answers", async () => {
    useEditor.setState({ projectId: "p1", dirty: true });
    await clickRestart();
    expect(useCloseCoordinator.getState().pending).toMatchObject({ kind: "unsaved", exit: true });
    expect(update.install).not.toHaveBeenCalled();
    expect(closeProject).not.toHaveBeenCalled();
  });

  it("after Cancel, an ordinary quit just quits", async () => {
    useEditor.setState({ projectId: "p1", dirty: true });
    await clickRestart();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    useEditor.setState({ projectId: "p1", dirty: false });
    await requestClose();
    for (let i = 0; i < 4; i++) await flush();
    expect(update.install).not.toHaveBeenCalled();
    expect(winClose).toHaveBeenCalled();
  });

  it("installs straight away when no project is open", async () => {
    useEditor.setState({ projectId: null });
    await clickRestart();
    expect(update.install).toHaveBeenCalledTimes(1);
    expect(windowClosed).toBe(false);
  });

  it("keeps the project open and says why when the download fails", async () => {
    update.download.mockRejectedValue(new Error("offline"));
    await clickRestart();
    expect(closeProject).not.toHaveBeenCalled();
    expect(update.install).not.toHaveBeenCalled();
    expect(screen.getByText(/offline/)).toBeInTheDocument();
  });
});
