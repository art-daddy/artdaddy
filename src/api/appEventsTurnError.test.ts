// turn_error: one failed agent turn, as a beacon carrying only the code the person was shown and the failed request's id.
//
// A turn that ended in an error left no event, so the funnel could not tell a wall from lost interest. The beacon holds
// nothing the person wrote (no prompt, no message) and nothing the server's own alphabet would refuse, and a failed
// request is reported once however many places notice it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth", async (io) => {
  const actual = await io<typeof import("./auth")>();
  return { ...actual, hasSession: vi.fn(async () => true) };
});
vi.mock("../platform/host", async (io) => {
  const actual = await io<typeof import("../platform/host")>();
  return {
    ...actual,
    resolveHostInfo: vi.fn(async () => ({ os: "windows", arch: "x86_64" })),
    hostInfo: () => ({ os: "windows", arch: "x86_64" }),
  };
});

import { __resetAppEvents, reportTurnError } from "./appEvents";
import { hasSession, setClerkTokenProvider } from "./auth";
import { useAuth } from "../store/auth";

function captureFetch() {
  const calls: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, status: "ok" }), { status: 200 });
    }),
  );
  return calls;
}

beforeEach(() => {
  __resetAppEvents();
  useAuth.setState({ status: "unlocked", profile: null, hasStoredSession: true });
  setClerkTokenProvider(async () => "isolated-telemetry-session");
  vi.mocked(hasSession).mockResolvedValue(true);
});
afterEach(() => {
  __resetAppEvents();
  setClerkTokenProvider(null);
  vi.unstubAllGlobals();
});

describe("reportTurnError", () => {
  it("sends the code and the request id, and nothing else the person could have written", async () => {
    const calls = captureFetch();
    reportTurnError("content_policy", "3f9c1a2b7d4e5f60");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      event: "turn_error",
      ok: false,
      error_code: "content_policy",
      request_id: "3f9c1a2b7d4e5f60",
    });
    expect(Object.keys(calls[0]).sort()).toEqual(
      [
        "app_version",
        "arch",
        "error_code",
        "event",
        "ok",
        "os",
        "project_id",
        "request_id",
        "shell",
      ].sort(),
    );
  });

  it("leaves the request id out when the call never got one", async () => {
    const calls = captureFetch();
    reportTurnError("network");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).not.toHaveProperty("request_id");
    expect(calls[0]).toMatchObject({ error_code: "network" });
  });

  it("speaks the server's alphabet and bounds, whatever it is given", async () => {
    const calls = captureFetch();
    reportTurnError("no way! <x>".padEnd(80, "y"), "id\r\nX: 1".padEnd(200, "z"));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const { error_code: code, request_id: id } = calls[0] as {
      error_code: string;
      request_id: string;
    };
    expect(code).toMatch(/^[A-Za-z0-9_.:-]{1,40}$/);
    expect(id).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/);
    expect(code.startsWith("no_way___x_")).toBe(true);
  });

  it("reports an empty code as unknown, never as blank", async () => {
    const calls = captureFetch();
    reportTurnError("", "r1");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ error_code: "unknown" });
  });

  it("reports one failed request once, however many places notice it", async () => {
    const calls = captureFetch();
    reportTurnError("content_policy", "same");
    reportTurnError("content_policy", "same");
    reportTurnError("provider_timeout", "same");
    reportTurnError("content_policy", "other");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.map((c) => c.request_id)).toEqual(["same", "other"]);
  });

  it("does not collapse failures that have no request id (each is its own)", async () => {
    const calls = captureFetch();
    reportTurnError("network");
    reportTurnError("network");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
  });

  it("never throws, even when the network is down (a beacon is not a feature)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))),
    );
    expect(() => reportTurnError("network", "r")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
