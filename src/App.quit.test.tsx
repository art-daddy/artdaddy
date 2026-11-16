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
import { useAuth } from "./store/auth";
import { setClerkTokenProvider } from "./api/auth";
import { EXPORT_FLAG_NAMES, __resetExportFlags, exportFlag } from "./api/exportFlags";
import { useCompatibility } from "./update/compatibility";
import { catalogIdentity } from "./contract";
import {
  __bufferedAgentEvents,
  __resetAgentEvents,
  flushAgentEvents,
  recordToolCall,
} from "./api/agentEvents";
import { __resetEditorEvents, recordEdit, recordImport } from "./api/editorEvents";

vi.mock("./components/Shell", () => ({ default: () => <div>shell</div> }));
vi.mock("./components/AuthProvider", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("./components/MenuBar", () => ({ default: () => <div>menu</div> }));
vi.mock("./platform", () => ({ platform: { name: "tauri" } }));
vi.mock("./mcp/service", () => ({ initMcp: async () => undefined }));
vi.mock("./tools/modelPrefetch", () => ({ startSpeechModelPrefetch: async () => undefined }));
vi.mock("./lib/osDrop", () => ({
  webOwnsFileDrops: () => false,
  startOsDropRouter: async () => () => undefined,
}));
// Whether a live session token is held (api/desktopAuth.ts): the test says, since nothing here signs in for real.
const session = vi.hoisted(() => ({ fresh: true }));
vi.mock("./api/desktopAuth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/desktopAuth")>()),
  hasFreshAccessToken: () => session.fresh,
}));

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
const deliveredTraces: Array<Record<string, unknown>> = [];
const deliveredEditor: Array<Record<string, unknown>> = [];
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
  __resetAgentEvents();
  __resetEditorEvents();
  useAuth.setState({ status: "unlocked", profile: null, hasStoredSession: true });
  setClerkTokenProvider(async () => "quit-trace-test-token");
  deliveredTraces.length = 0;
  deliveredEditor.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).endsWith("/client/compatibility")) {
        return new Response(
          JSON.stringify({
            catalog_id: catalogIdentity(),
            supported: true,
            required_update: false,
          }),
        );
      }
      if (String(url).endsWith("/telemetry/agent")) {
        deliveredTraces.push(JSON.parse(init!.body as string));
        return new Response("", { status: 200 });
      }
      if (String(url).endsWith("/telemetry/editor")) {
        deliveredEditor.push(JSON.parse(init!.body as string));
        return new Response("", { status: 200 });
      }
      return new Response("offline", { status: 503 });
    }),
  );
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
afterEach(() => {
  __resetAgentEvents();
  __resetEditorEvents();
  setClerkTokenProvider(null);
  useCloseCoordinator.setState({ pending: null, exitHandler: null });
});

describe("quitting the app", () => {
  it("delivers what a person did in the editor before closing the window, not a minute later", async () => {
    await mount();
    recordEdit("move", "p1");
    recordEdit("move", "p1");
    recordImport({ ok: false, reason: "unsupported_type", media: "unknown", via: "copy" }, "p1");
    await requestClose();
    expect(windowClosed).toBe(true);
    expect(deliveredEditor).toHaveLength(1);
    expect(deliveredEditor[0]).toMatchObject({
      project_id: "p1",
      events: [
        { kind: "import", ok: false, reason: "unsupported_type" },
        { kind: "edits", counts: { move: 2 } },
      ],
    });
  });

  it("delivers the pending trace before closing the window", async () => {
    await mount();
    recordToolCall({ name: "undo", ok: true, ms: 1 });
    await requestClose();
    expect(windowClosed).toBe(true);
    expect(deliveredTraces).toHaveLength(1);
    expect(deliveredTraces[0]).toMatchObject({ events: [{ name: "undo", ok: true }] });
  });

  it("delivers pending work even when no project is open", async () => {
    useEditor.setState({ projectId: null });
    await mount();
    recordToolCall({ name: "redo", ok: false, ms: 1 });
    await requestClose();
    expect(deliveredTraces).toHaveLength(1);
    expect(deliveredTraces[0]).toMatchObject({ events: [{ name: "redo", ok: false }] });
    expect(windowClosed).toBe(true);
    expect(closeProject).not.toHaveBeenCalled();
  });

  it("waits for a trace that was already sending before Quit", async () => {
    await mount();
    let received!: () => void;
    let deliver!: () => void;
    const started = new Promise<void>((resolve) => {
      received = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        received();
        return new Promise<Response>((resolve) => {
          deliver = () => {
            deliveredTraces.push(JSON.parse(init!.body as string));
            resolve(new Response("", { status: 200 }));
          };
        });
      }),
    );
    recordToolCall({ name: "undo", ok: true, ms: 1 });
    const sending = flushAgentEvents();
    await started;
    const closing = requestClose();
    await flush();
    expect(windowClosed).toBe(false);
    deliver();
    await sending;
    await closing;
    expect(windowClosed).toBe(true);
    expect(deliveredTraces).toHaveLength(1);
  });

  it("still quits when trace delivery ignores cancellation", async () => {
    await mount();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    recordToolCall({ name: "undo", ok: true, ms: 1 });
    vi.useFakeTimers();
    try {
      const closing = requestClose();
      await vi.advanceTimersByTimeAsync(2_100);
      expect(windowClosed).toBe(true);
      await closing;
      expect(closeProject).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps unsent traces and the window when the final save fails", async () => {
    closeProject.mockResolvedValue({ ok: false });
    await mount();
    recordToolCall({ name: "undo", ok: true, ms: 1 });
    await requestClose();
    expect(windowClosed).toBe(false);
    expect(deliveredTraces).toHaveLength(0);
    expect(__bufferedAgentEvents()).toMatchObject([{ name: "undo" }]);
  });

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
    expect(await requestClose()).toBe(true);
    expect(windowClosed).toBe(true);
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

  it("keeps the project after a decoding failure and installs only after a successful retry", async () => {
    update.download
      .mockRejectedValueOnce(new Error("error decoding response body"))
      .mockResolvedValueOnce("9.9.9");
    await clickRestart();
    expect(screen.getByText(/error decoding response body/)).toBeInTheDocument();
    expect(useEditor.getState().projectId).toBe("p1");
    expect(closeProject).not.toHaveBeenCalled();
    expect(update.install).not.toHaveBeenCalled();
    expect(windowClosed).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Restart & update" }));
    for (let attempt = 0; attempt < 6; attempt++) await flush();
    expect(screen.queryByText(/error decoding response body/)).not.toBeInTheDocument();
    expect(order).toEqual(["project closed", "update installed"]);
    expect(update.download).toHaveBeenCalledTimes(2);
    expect(update.install).toHaveBeenCalledTimes(1);
  });
});

// Each of the exporter's safety behaviours can be switched off from the server (api/exportFlags.ts). A PC that
// already has the app open must hear it without anyone starting an export.
describe("opening the app", () => {
  it("asks the server which of the exporter's safety behaviours are on, a few seconds in", async () => {
    __resetExportFlags();
    useCompatibility.setState({ status: "allowed" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      render(
        <MemoryRouter initialEntries={["/"]}>
          <App />
        </MemoryRouter>,
      );
      const asks = () =>
        vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/client/export-flags"))
          .length;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(asks()).toBe(0); // not in the first moments, while the window paints and signing in settles
      await vi.advanceTimersByTimeAsync(6_000);
      expect(asks()).toBe(1);
    } finally {
      vi.useRealTimers();
      __resetExportFlags();
    }
  });
});

// The opening ask is not the only one (api/exportFlags.ts, keepExportFlagsFresh): an app that stays open keeps hearing
// the server's switches, and an opening ask that the server was too asleep to answer is not lost.
describe("leaving the app open", () => {
  const FLAGS = "/client/export-flags";
  const served = (off: string[]): Response =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        v: 1,
        flags: Object.fromEntries(EXPORT_FLAG_NAMES.map((name) => [name, !off.includes(name)])),
      }),
    }) as unknown as Response;
  const hangs = (_nth: number, signal: AbortSignal) =>
    new Promise<Response>((_resolve, reject) =>
      signal.addEventListener("abort", () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
      ),
    );
  /** What the flags route does with its nth request; every other route is answered as the rest of this file does. */
  const serve = (behave: (nth: number, signal: AbortSignal) => Promise<Response>) => {
    const others = vi.mocked(fetch).getMockImplementation()!;
    let nth = 0;
    vi.mocked(fetch).mockImplementation(async (url, init) =>
      String(url).endsWith(FLAGS) ? behave(++nth, init!.signal as AbortSignal) : others(url, init),
    );
    return () => nth;
  };
  const open = () => {
    useCompatibility.setState({ status: "allowed" });
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    return render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
  };

  beforeEach(() => {
    __resetExportFlags();
    session.fresh = true;
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetExportFlags();
  });

  it("hears a switch the server turns off within about ten minutes, with no export and no restart", async () => {
    let off: string[] = [];
    serve(async () => served(off));
    open();
    await vi.advanceTimersByTimeAsync(10_000); // the opening ask, 4 seconds in, has been answered
    expect(exportFlag("speech_wake")).toBe(true);
    off = ["speech_wake"];
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(exportFlag("speech_wake")).toBe(false);
  });

  it("still hears the opening answer from a server that needs 26 seconds to wake", async () => {
    serve(
      (_nth, signal) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(served(["speech_wake"])), 26_000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    );
    open();
    await vi.advanceTimersByTimeAsync(4_000 + 26_000 + 5_000);
    expect(exportFlag("speech_wake")).toBe(false);
  });

  it("asks again within a few minutes when the opening ask got no answer, not after ten", async () => {
    const asked = serve((nth, signal) =>
      nth === 1 ? hangs(nth, signal) : Promise.resolve(served(["speech_wake"])),
    );
    open();
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 5_000);
    expect(asked()).toBe(2);
    expect(exportFlag("speech_wake")).toBe(false);
  });

  it("stops asking when the app is gone", async () => {
    const asked = serve(async () => served([]));
    const { unmount } = open();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(asked()).toBe(1);
    unmount();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(asked()).toBe(1);
  });

  it("does not look at the session while none is held, and asks within a look of one being held", async () => {
    let signedIn = false;
    const look = vi.fn(async () => (signedIn ? "a-session-token" : null));
    setClerkTokenProvider(look);
    session.fresh = false; // nobody signed in, or a token that has run out
    const asked = serve(async () => served(["speech_wake"]));
    open();
    await vi.advanceTimersByTimeAsync(10_000); // the opening ask, 4 seconds in, finds nobody: the one look the app always makes
    const opening = look.mock.calls.length;
    expect(opening).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(look.mock.calls.length).toBe(opening); // no more, for half an hour: a look may have to renew the session
    expect(asked()).toBe(0);
    signedIn = true;
    session.fresh = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(asked()).toBe(1);
    expect(exportFlag("speech_wake")).toBe(false);
  });

  it("holds nothing up while an ask waits for a server that never answers: the window is up and the gate stays open", async () => {
    const asked = serve(hangs);
    const { getByText } = open();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(asked()).toBe(1); // out, and unanswered
    expect(getByText("shell")).toBeInTheDocument();
    expect(useCompatibility.getState().status).toBe("allowed");
  });
});
