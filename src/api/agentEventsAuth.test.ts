// A signed-out beacon is a guaranteed 401. It matters because the heartbeat repeats: the
// skip is what stops an unauthenticated app from retrying that 401 every five minutes for
// as long as it stays open.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ signedIn: false }));

vi.mock("./config", () => ({
  apiBase: () => "https://example.invalid",
  onApiBaseChange: () => () => undefined,
}));
vi.mock("../platform/host", () => ({
  hostInfo: () => ({ os: "windows", arch: "x86_64" }),
  resolveHostInfo: async () => undefined,
}));
vi.mock("../platform", () => ({ platform: { name: "tauri" } }));

import {
  __resetAgentEvents,
  agentEventContext,
  flushAgentEvents,
  recordToolCall,
} from "./agentEvents";
import { startHeartbeat, stopHeartbeat } from "./appEvents";
import { useAuth } from "../store/auth";
import { setClerkTokenProvider, setSessionRenewer } from "./auth";

beforeEach(() => {
  __resetAgentEvents();
  useAuth.setState({ status: "locked", profile: null, hasStoredSession: false });
  session.signedIn = false;
  setClerkTokenProvider(async () => (session.signedIn ? "trace-test-token" : null));
  setSessionRenewer(null);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 200 })),
  );
});

afterEach(() => {
  __resetAgentEvents();
  setClerkTokenProvider(null);
  setSessionRenewer(null);
  stopHeartbeat();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("signed out", () => {
  it("discards offline work with no stored session even when a token source still answers", async () => {
    session.signedIn = true;
    useAuth.setState({ status: "offline", hasStoredSession: false });
    recordToolCall({ name: "undo", ok: true, ms: 1 });
    useAuth.setState({ status: "unlocked", hasStoredSession: true });
    await flushAgentEvents();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not send buffered work if the token disappears without an auth-store update", async () => {
    session.signedIn = true;
    useAuth.setState({ status: "unlocked", hasStoredSession: true });
    recordToolCall({ name: "undo", ok: true, ms: 1 });
    session.signedIn = false;
    await flushAgentEvents();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not give signed-out work to the next account when it signs in before the timer", async () => {
    recordToolCall({ name: "undo", ok: true, ms: 1 });
    session.signedIn = true;
    useAuth.setState({ status: "unlocked", hasStoredSession: true });
    await flushAgentEvents();
    expect(fetch).not.toHaveBeenCalled();
  });

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
  it("delivers when offline with a stored session and preserves the event envelope", async () => {
    session.signedIn = true;
    useAuth.setState({ status: "offline", hasStoredSession: true });
    recordToolCall({ name: "undo", ok: true, ms: 1 });
    await flushAgentEvents();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://example.invalid/telemetry/agent");
    expect(request!.method).toBe("POST");
    expect(new Headers(request!.headers).get("Content-Type")).toBe("application/json");
    const body = JSON.parse(request!.body as string);
    expect(body.events).toMatchObject([{ name: "undo", ok: true }]);
    expect(body.sent_at).toBeTypeOf("number");
    expect(body).not.toHaveProperty("generation");
  });

  it("samples the send clock after token retrieval rather than before waiting", async () => {
    session.signedIn = true;
    useAuth.setState({ status: "unlocked", hasStoredSession: true });
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    let calls = 0;
    let releaseToken!: (token: string) => void;
    let tokenRequested!: () => void;
    const requested = new Promise<void>((resolve) => {
      tokenRequested = resolve;
    });
    setClerkTokenProvider(async () => {
      if (++calls === 1) return "trace-test-token";
      tokenRequested();
      return new Promise<string>((resolve) => {
        releaseToken = resolve;
      });
    });
    recordToolCall({ name: "undo", ok: true, ms: 1 });
    const sending = flushAgentEvents();
    await requested;
    vi.setSystemTime(1_800_000_020_000);
    releaseToken("trace-test-token");
    await sending;
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.sent_at).toBe(1_800_000_020);
    expect(body.events[0].at).toBe(1_800_000_000);
  });

  it("discards queued traces when sign-out happens before delivery", async () => {
    session.signedIn = true;
    useAuth.setState({ status: "unlocked", hasStoredSession: true });
    recordToolCall({ name: "undo", ok: true, ms: 1 });
    useAuth.getState().markLocked();
    useAuth.setState({ status: "unlocked", hasStoredSession: true });
    await flushAgentEvents();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("discards a tool completion that ignored sign-out", async () => {
    session.signedIn = true;
    useAuth.setState({ status: "unlocked", hasStoredSession: true });
    const submitted = agentEventContext();
    useAuth.getState().markLocked();
    useAuth.setState({ status: "unlocked", hasStoredSession: true });
    recordToolCall({ name: "undo", ok: true, ms: 1 }, submitted);
    await flushAgentEvents();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rechecks the session after the last token fetch, even if it ignores cancellation", async () => {
    session.signedIn = true;
    useAuth.setState({ status: "unlocked", hasStoredSession: true });
    let calls = 0;
    let releaseToken!: (token: string) => void;
    let tokenRequested!: () => void;
    const requested = new Promise<void>((resolve) => {
      tokenRequested = resolve;
    });
    setClerkTokenProvider(async () => {
      if (++calls === 1) return "trace-test-token";
      tokenRequested();
      return new Promise<string>((resolve) => {
        releaseToken = resolve;
      });
    });
    recordToolCall({ name: "undo", ok: true, ms: 1 });
    const sending = flushAgentEvents();
    await requested;
    useAuth.getState().markLocked();
    releaseToken("next-account-test-token");
    await sending;
    expect(fetch).not.toHaveBeenCalled();
  });

  it("POSTs once there is an identity to attribute to", async () => {
    session.signedIn = true;
    useAuth.setState({ status: "unlocked", hasStoredSession: true });
    recordToolCall({ name: "undo", ok: true, ms: 1 });
    await flushAgentEvents();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
