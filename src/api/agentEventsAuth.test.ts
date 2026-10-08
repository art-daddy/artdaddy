// A signed-out beacon is a guaranteed 401. It matters because the heartbeat repeats: the
// skip is what stops an unauthenticated app from retrying that 401 every five minutes for
// as long as it stays open.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ signedIn: false }));

vi.mock("./config", () => ({ apiBase: () => "https://example.invalid" }));
vi.mock("./auth", () => ({
  hasSession: async () => session.signedIn,
  authedFetch: (url: string, init: RequestInit = {}) => fetch(url, init),
}));
vi.mock("../platform/host", () => ({
  hostInfo: () => ({ os: "windows", arch: "x86_64" }),
  resolveHostInfo: async () => undefined,
}));
vi.mock("../platform", () => ({ platform: { name: "tauri" } }));

import { __resetAgentEvents, flushAgentEvents, recordToolCall } from "./agentEvents";
import { startHeartbeat, stopHeartbeat } from "./appEvents";

beforeEach(() => {
  __resetAgentEvents();
  session.signedIn = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true }) as Response),
  );
});

afterEach(() => {
  stopHeartbeat();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("signed out", () => {
  it("does not POST an agent trace nobody can be billed for", async () => {
    recordToolCall({ name: "undo", ok: true, ms: 1 });
    await flushAgentEvents();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not beat", async () => {
    vi.useFakeTimers();
    startHeartbeat("proj_1");
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still drops the buffer, so a long signed-out session cannot grow without bound", async () => {
    recordToolCall({ name: "undo", ok: true, ms: 1 });
    await flushAgentEvents();
    session.signedIn = true;
    await flushAgentEvents();

    // Nothing was retained from the signed-out flush: the second call has nothing to send.
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("signed in", () => {
  it("POSTs once there is an identity to attribute to", async () => {
    session.signedIn = true;
    recordToolCall({ name: "undo", ok: true, ms: 1 });
    await flushAgentEvents();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
