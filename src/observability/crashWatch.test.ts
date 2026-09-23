// The gap this closes: the app's worst failures kill the process, so nothing inside the
// webview is alive to report them. A 1.84 GB media read aborted the Rust side with
// 0xE0000008 and Sentry showed a quiet week while the editor crashed repeatedly.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureMock = vi.hoisted(() => vi.fn());
vi.mock("./sentry", () => ({ captureError: captureMock }));

import {
  beginSessionActivity,
  installCrashWatch,
  noteSessionProject,
  startCrashWatch,
} from "./crashWatch";

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

beforeEach(() => captureMock.mockReset());
afterEach(() => {
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
