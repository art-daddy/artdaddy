// The gap this closes: the app's worst failures kill the process, so nothing inside the
// webview is alive to report them. A 1.84 GB media read aborted the Rust side with
// 0xE0000008 and Sentry showed a quiet week while the editor crashed repeatedly.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureMock = vi.hoisted(() => vi.fn());
const native = vi.hoisted(() => ({ shell: "web", invoke: vi.fn() }));
vi.mock("./sentry", () => ({ captureError: captureMock }));
vi.mock("../platform", () => ({
  platform: {
    get name() {
      return native.shell;
    },
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));

import {
  beginSessionActivity,
  installCrashWatch as installWatch,
  noteSessionProject,
  startCrashWatch,
} from "./crashWatch";
import { useAuth } from "../store/auth";
import { setClerkTokenProvider } from "../api/auth";
import { __resetAppEvents } from "../api/appEvents";

const watches: (() => void)[] = [];
const installCrashWatch: typeof installWatch = (options) => {
  const stop = installWatch(options);
  watches.push(stop);
  return stop;
};

/** A localStorage that survives "restarts" — the whole point is what outlives the process. */
function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

beforeEach(() => {
  captureMock.mockReset();
  native.shell = "web";
  native.invoke.mockReset();
  useAuth.setState({
    status: "unlocked",
    hasStoredSession: true,
    profile: { user_id: "qa_account" } as never,
  });
  setClerkTokenProvider(async () => "crash-watch-test-token");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).endsWith("/me") ? { user_id: "qa_account" } : { ok: true, status: "ok" },
          ),
          { status: 200 },
        ),
    ),
  );
});
afterEach(() => {
  for (const stop of watches.splice(0)) stop();
  __resetAppEvents();
  setClerkTokenProvider(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("crash watch", () => {
  it("reports the previous session when it died without shutting down", () => {
    const storage = fakeStorage();
    let t = 1_000_000;
    // Session 1 runs for 30s, opens a project, then the process is killed: nothing clears it.
    startCrashWatch({ storage, now: () => t, release: "artdaddy@0.5.0" });
    t += 30_000;
    storage.setItem(
      "artdaddy.session",
      JSON.stringify({ startedAt: 1_000_000, aliveAt: t, projectId: "t001_a84a4e" }),
    );

    // Session 2 starts and finds the marker nobody cleared.
    const r = startCrashWatch({ storage, now: () => t + 5_000 });

    expect(r.reportedCrash).toBe(true);
    expect(captureMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureMock.mock.calls[0];
    expect(String((err as Error).message)).toMatch(/without shutting down/i);
    // The report has to name the project, or it points at nothing actionable.
    expect((ctx as { project_id?: string }).project_id).toBe("t001_a84a4e");
    expect((ctx as { ran_for_ms?: number }).ran_for_ms).toBe(30_000);
  });

  // The failure direction: a clean shutdown must NOT look like a crash, or every restart
  // files a false report and the signal is worthless.
  it("says nothing when the previous session shut down cleanly", () => {
    const storage = fakeStorage();
    let t = 5_000_000;
    startCrashWatch({ storage, now: () => t });
    storage.removeItem("artdaddy.session"); // what the clean-exit handler does
    t += 10_000;

    const r = startCrashWatch({ storage, now: () => t });
    expect(r.reportedCrash).toBe(false);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("says nothing on a first ever launch", () => {
    const r = startCrashWatch({ storage: fakeStorage() });
    expect(r.reportedCrash).toBe(false);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("ignores a marker too short-lived to be a real session", () => {
    const storage = fakeStorage();
    storage.setItem("artdaddy.session", JSON.stringify({ startedAt: 100, aliveAt: 400 }));
    expect(startCrashWatch({ storage }).reportedCrash).toBe(false);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("keeps the marker readable when a project is noted mid-session", () => {
    const storage = fakeStorage();
    vi.stubGlobal("localStorage", storage);
    startCrashWatch({ storage, now: () => 9_000_000 });
    noteSessionProject("p42");
    const s = JSON.parse(storage.getItem("artdaddy.session")!) as { projectId?: string };
    expect(s.projectId).toBe("p42");
  });

  it("survives a corrupt marker rather than throwing on boot", () => {
    const storage = fakeStorage();
    storage.setItem("artdaddy.session", "{not json");
    expect(() => startCrashWatch({ storage })).not.toThrow();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("keeps a concurrent export visible when a model download finishes first", () => {
    vi.useFakeTimers();
    const storage = fakeStorage();
    vi.stubGlobal("localStorage", storage);
    const stopWatch = installCrashWatch();
    const finishExport = beginSessionActivity("export");
    const finishModel = beginSessionActivity("whisper-model-download");

    finishModel();
    vi.advanceTimersByTime(5_000);
    const marker = JSON.parse(storage.getItem("artdaddy.session")!) as { activity?: string };
    expect(marker.activity).toBe("export");

    finishExport();
    stopWatch();
  });
});

describe("native crash watch", () => {
  const failure = () => ({
    id: "native-1",
    kind: "renderer_exited",
    at: 1_800_000_000_000,
    eligible: true,
    session: {
      launch_id: "previous",
      release: "test",
      started_at: 1_799_999_950_000,
      alive_at: 1_799_999_990_000,
      context: { project_id: "p1", user_id: "qa_account", activity: "playback" },
    },
  });
  const response = () => ({
    launch_id: "next",
    renderer_epoch: 1,
    previous_exit: null,
    storage_ok: true,
    failures: [failure()],
  });

  it("never acknowledges a native report whose delivery timed out", async () => {
    vi.useFakeTimers();
    native.shell = "tauri";
    native.invoke.mockImplementation(async (command) =>
      command === "runtime_health_begin" || command === "runtime_health_status" ? response() : true,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (String(url).endsWith("/me"))
          return new Response(JSON.stringify({ user_id: "qa_account" }), { status: 200 });
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new Error("delivery timed out")), {
            once: true,
          });
        });
      }),
    );
    const stop = installCrashWatch();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(
      native.invoke.mock.calls.filter(([command]) => command === "runtime_health_ack"),
    ).toEqual([]);
    stop();
  });

  it("delivers a native observation made after startup even if the page did not reload", async () => {
    vi.useFakeTimers();
    native.shell = "tauri";
    native.invoke.mockImplementation(async (command) => {
      if (command === "runtime_health_begin") return { ...response(), failures: [] };
      if (command === "runtime_health_status") return response();
      return true;
    });
    const stored: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (String(url).endsWith("/me"))
          return new Response(JSON.stringify({ user_id: "qa_account" }), { status: 200 });
        stored.push(JSON.parse(init!.body as string));
        return new Response(JSON.stringify({ ok: true, status: "ok" }), { status: 200 });
      }),
    );
    const stop = installCrashWatch();
    await vi.advanceTimersByTimeAsync(1);
    expect(stored).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stored).toEqual([
      expect.objectContaining({ event_id: "native-1", via: "renderer_exited" }),
    ]);
    expect(
      native.invoke.mock.calls.filter(([command]) => command === "runtime_health_ack"),
    ).toHaveLength(1);
    stop();
  });

  it("does not report a stale web marker when the native process confirms a clean quit", async () => {
    vi.useFakeTimers();
    native.shell = "tauri";
    const storage = fakeStorage();
    storage.setItem("artdaddy.session", JSON.stringify({ startedAt: 100, aliveAt: 10_000 }));
    vi.stubGlobal("localStorage", storage);
    native.invoke.mockResolvedValue({
      launch_id: "next",
      renderer_epoch: 1,
      previous_exit: "quit",
      storage_ok: true,
      failures: [],
    });
    const stop = installCrashWatch();
    await vi.advanceTimersByTimeAsync(1);
    expect(captureMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    stop();
  });

  it("reports the observed native failure and acknowledges only after storage confirms it", async () => {
    vi.useFakeTimers();
    native.shell = "tauri";
    const failure = {
      id: "native-1",
      kind: "renderer_exited",
      at: 1_800_000_000_000,
      eligible: true,
      session: {
        launch_id: "previous",
        release: "test",
        started_at: 1_799_999_950_000,
        alive_at: 1_799_999_990_000,
        context: { project_id: "p1", user_id: "qa_account", activity: "playback" },
      },
    };
    native.invoke.mockImplementation(async (command) =>
      command === "runtime_health_begin"
        ? {
            launch_id: "next",
            renderer_epoch: 1,
            previous_exit: null,
            storage_ok: true,
            failures: [failure],
          }
        : true,
    );
    const stored: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        if (String(_url).endsWith("/me"))
          return new Response(JSON.stringify({ user_id: "qa_account" }), { status: 200 });
        stored.push(JSON.parse(init!.body as string));
        return new Response(JSON.stringify({ ok: true, status: "ok" }), { status: 200 });
      }),
    );
    const stop = installCrashWatch();
    await vi.advanceTimersByTimeAsync(1);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      event: "app_error",
      via: "renderer_exited",
      event_id: "native-1",
      project_id: "p1",
      occurred_at: 1_800_000_000,
    });
    expect(stored[0].reason).toContain("playback");
    expect(native.invoke).toHaveBeenCalledWith("runtime_health_ack", {
      token: { launch_id: "next", renderer_epoch: 1 },
      ids: ["native-1"],
    });
    stop();
  });

  it("retains an unconfirmed report and retries after the server is available", async () => {
    vi.useFakeTimers();
    native.shell = "tauri";
    native.invoke.mockImplementation(async (command) =>
      command === "runtime_health_begin" || command === "runtime_health_status" ? response() : true,
    );
    const requests: Array<Record<string, unknown>> = [];
    let online = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        if (String(_url).endsWith("/me"))
          return new Response(JSON.stringify({ user_id: "qa_account" }), { status: 200 });
        requests.push(JSON.parse(init!.body as string));
        return new Response(JSON.stringify({ ok: online, status: online ? "ok" : "disabled" }), {
          status: 200,
        });
      }),
    );
    const stop = installCrashWatch();
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toHaveLength(1);
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(
      native.invoke.mock.calls.filter(([command]) => command === "runtime_health_ack"),
    ).toHaveLength(0);
    online = true;
    await vi.advanceTimersByTimeAsync(29_000);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requests).toHaveLength(2);
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(requests[0].event_id).toBe(requests[1].event_id);
    expect(
      native.invoke.mock.calls.filter(([command]) => command === "runtime_health_ack"),
    ).toHaveLength(1);
    stop();
  });

  it("waits for startup identity and discards on sign-out instead of reporting to the next account", async () => {
    vi.useFakeTimers();
    native.shell = "tauri";
    useAuth.setState({ status: "checking", profile: null });
    native.invoke.mockImplementation(async (command) =>
      command === "runtime_health_begin" ? response() : true,
    );
    const stop = installCrashWatch();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).not.toHaveBeenCalled();
    useAuth.getState().markLocked();
    await vi.advanceTimersByTimeAsync(1);
    useAuth.setState({
      status: "unlocked",
      hasStoredSession: true,
      profile: { user_id: "qa_account" } as never,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
    stop();
  });

  it("does not copy a native failure into Sentry under a token from another account", async () => {
    vi.useFakeTimers();
    native.shell = "tauri";
    native.invoke.mockImplementation(async (command) =>
      command === "runtime_health_begin" ? response() : true,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url) =>
          new Response(
            JSON.stringify(
              String(url).endsWith("/me")
                ? { user_id: "different_account" }
                : { ok: true, status: "ok" },
            ),
            { status: 200 },
          ),
      ),
    );
    const stop = installCrashWatch();
    await vi.advanceTimersByTimeAsync(1);
    expect(captureMock).not.toHaveBeenCalled();
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/telemetry/app")),
    ).toEqual([]);
    expect(
      native.invoke.mock.calls.filter(([command]) => command === "runtime_health_ack"),
    ).toHaveLength(1);
    stop();
  });

  it("does not start reporting after its watcher was disposed during native setup", async () => {
    vi.useFakeTimers();
    native.shell = "tauri";
    let finish!: (value: unknown) => void;
    native.invoke.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const stop = installCrashWatch();
    await vi.advanceTimersByTimeAsync(1);
    stop();
    finish(response());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });
});

// An exit nobody marked is reported with the one short word the operating system's own log gives for it (power loss, a
// restart to update, this app's crash and its exception code, ...). Only that word: the log's entries carry user names and paths.
describe("native crash watch, what ended an unexpected exit", () => {
  const unexpected = (kind = "unclean_exit") => ({
    id: "native-9",
    kind,
    at: 1_800_000_000_000,
    eligible: true,
    session: {
      launch_id: "previous",
      release: "test",
      started_at: 1_799_999_950_000,
      alive_at: 1_799_999_990_000,
      context: { project_id: "p1", user_id: "qa_account", activity: "idle" },
    },
  });
  /** The native side answers the status calls with one failure, and the cause lookup as the test says. */
  function app(kind: string, cause: (args: unknown) => Promise<unknown>) {
    native.shell = "tauri";
    native.invoke.mockImplementation(async (command, args) => {
      if (command === "runtime_health_begin")
        return {
          launch_id: "next",
          renderer_epoch: 1,
          previous_exit: null,
          storage_ok: true,
          failures: [unexpected(kind)],
        };
      if (command === "runtime_health_cause") return cause(args);
      return true;
    });
    const stored: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (String(url).endsWith("/me"))
          return new Response(JSON.stringify({ user_id: "qa_account" }), { status: 200 });
        stored.push(JSON.parse(init!.body as string));
        return new Response(JSON.stringify({ ok: true, status: "ok" }), { status: 200 });
      }),
    );
    return stored;
  }

  it("says what ended it, in the report and in the error the developers read, and nothing else about the log", async () => {
    vi.useFakeTimers();
    const stored = app("unclean_exit", async () => "power_loss");
    const stop = installCrashWatch();
    await vi.advanceTimersByTimeAsync(1);
    expect(native.invoke).toHaveBeenCalledWith("runtime_health_cause", {
      token: { launch_id: "next", renderer_epoch: 1 },
      id: "native-9",
    });
    expect(stored).toHaveLength(1);
    expect(stored[0].reason).toBe("unclean_exit after 40s during idle (power_loss)");
    expect(captureMock.mock.calls[0][1]).toMatchObject({ cause: "power_loss" });
    // Asked before the report goes, and the report is acknowledged only after it was stored.
    const order = native.invoke.mock.calls.map(([command]) => command);
    expect(order.indexOf("runtime_health_cause")).toBeLessThan(order.indexOf("runtime_health_ack"));
    stop();
  });

  it("asks about an unexpected exit only: a renderer that died has its own cause", async () => {
    vi.useFakeTimers();
    const stored = app("renderer_exited", async () => "power_loss");
    const stop = installCrashWatch();
    await vi.advanceTimersByTimeAsync(1);
    expect(native.invoke.mock.calls.map(([command]) => command)).not.toContain(
      "runtime_health_cause",
    );
    expect(stored[0].reason).toBe("renderer_exited after 40s during idle");
    stop();
  });

  it("still reports the exit, without a cause, when the log cannot be read or has nothing to say", async () => {
    vi.useFakeTimers();
    for (const answer of [
      async () => {
        throw new Error("the command is not there");
      },
      async () => null,
      async () => undefined,
    ]) {
      native.invoke.mockReset();
      captureMock.mockReset();
      const stored = app("unclean_exit", answer);
      const stop = installCrashWatch();
      await vi.advanceTimersByTimeAsync(1);
      expect(stored).toHaveLength(1);
      expect(stored[0].reason).toBe("unclean_exit after 40s during idle");
      expect(captureMock.mock.calls[0][1]).not.toHaveProperty("cause");
      stop();
    }
  });

  it("does not wait on a log that never answers: the exit is reported after a few seconds without it", async () => {
    vi.useFakeTimers();
    const stored = app("unclean_exit", () => new Promise(() => undefined));
    const stop = installCrashWatch();
    await vi.advanceTimersByTimeAsync(1);
    expect(stored).toEqual([]);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(stored).toHaveLength(1);
    expect(stored[0].reason).toBe("unclean_exit after 40s during idle");
    stop();
  });

  it("takes only a word of the right shape: nothing the log wrote (a name, a path, a sentence) gets into a report", async () => {
    vi.useFakeTimers();
    const good = ["power_loss", "app_crash:c0000005", "webview_crash:80000003", "unknown"];
    const bad = [
      "C:\\Users\\someone\\AppData",
      "someone's PC restarted",
      "app_crash:zzzz",
      "power loss",
      "POWER_LOSS",
      "x".repeat(60),
      "",
      42,
      { cause: "power_loss" },
    ];
    for (const word of [...good, ...bad]) {
      native.invoke.mockReset();
      captureMock.mockReset();
      const stored = app("unclean_exit", async () => word);
      const stop = installCrashWatch();
      await vi.advanceTimersByTimeAsync(1);
      expect(stored).toHaveLength(1);
      const wanted = good.includes(word as string)
        ? `unclean_exit after 40s during idle (${String(word)})`
        : "unclean_exit after 40s during idle";
      expect(stored[0].reason, String(word)).toBe(wanted);
      stop();
    }
  });
});
