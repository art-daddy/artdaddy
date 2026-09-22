// A signed-out beacon is a guaranteed 401. It matters because the heartbeat repeats: the
// skip is what stops an unauthenticated app from retrying that 401 every five minutes for
// as long as it stays open.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const authHeaders = vi.hoisted(() => vi.fn(async () => ({}) as Record<string, string>));

vi.mock("./config", () => ({ apiBase: () => "https://example.invalid" }));
vi.mock("./auth", () => ({ authHeaders }));
vi.mock("../platform/host", () => ({
  hostInfo: () => ({ os: "windows", arch: "x86_64" }),
  resolveHostInfo: async () => undefined,
}));
vi.mock("../platform", () => ({ platform: { name: "tauri" } }));

import { __resetAgentEvents, flushAgentEvents, recordToolCall } from "./agentEvents";
import { startHeartbeat, stopHeartbeat } from "./appEvents";

beforeEach(() => {
  __resetAgentEvents();
  authHeaders.mockResolvedValue({});
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
    authHeaders.mockResolvedValue({ Authorization: "Bearer t" });
    await flushAgentEvents();

    // Nothing was retained from the signed-out flush: the second call has nothing to send.
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("signed in", () => {
  it("POSTs once there is an identity to attribute to", async () => {
    authHeaders.mockResolvedValue({ Authorization: "Bearer t" });
    recordToolCall({ name: "undo", ok: true, ms: 1 });
    await flushAgentEvents();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
