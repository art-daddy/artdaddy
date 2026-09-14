import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authHeaders,
  getAccessToken,
  notifyAuthFailure,
  onAuthFailure,
  setClerkTokenProvider,
  verifyAccess,
} from "./auth";

function resp(status: number, data: unknown = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  setClerkTokenProvider(null);
  vi.unstubAllGlobals();
});

describe("Clerk token provider", () => {
  it("has no auth header until Clerk has a session", async () => {
    expect(await authHeaders()).toEqual({});
    expect(await getAccessToken()).toBeNull();
  });

  it("gets a fresh Clerk token for every request", async () => {
    let generation = 0;
    setClerkTokenProvider(async () => `jwt-${++generation}`);

    expect(await authHeaders()).toEqual({ Authorization: ["Bearer", "jwt-1"].join(" ") });
    expect(await authHeaders()).toEqual({ Authorization: ["Bearer", "jwt-2"].join(" ") });
  });

  it("trims the token and treats a blank one as no session", async () => {
    setClerkTokenProvider(async () => "  jwt  ");
    expect(await getAccessToken()).toBe("jwt");

    setClerkTokenProvider(async () => "   ");
    expect(await getAccessToken()).toBeNull();
    expect(await authHeaders()).toEqual({});
  });

  it("does not let an old effect cleanup remove a newer provider", async () => {
    const removeOld = setClerkTokenProvider(async () => "old");
    setClerkTokenProvider(async () => "new");

    removeOld();

    expect(await getAccessToken()).toBe("new");
  });
});

describe("verifyAccess", () => {
  it("returns true on 200 and sends the current Clerk token as a bearer token", async () => {
    setClerkTokenProvider(async () => "abc");
    const f = vi.fn(async () => resp(200, { ok: true }));
    vi.stubGlobal("fetch", f);
    expect(await verifyAccess()).toBe(true);
    const call = f.mock.calls[0] as unknown[];
    expect(String(call[0])).toContain("/auth/verify");
    expect(((call[1] as RequestInit).headers as Record<string, string>).Authorization).toBe(
      "Bearer abc",
    );
  });

  it("returns false on 401 (no/invalid session -> prompt sign-in)", async () => {
    setClerkTokenProvider(async () => "bad");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => resp(401, { detail: "nope" })),
    );
    expect(await verifyAccess()).toBe(false);
  });

  it("treats 404 (ungated server) as open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => resp(404)),
    );
    expect(await verifyAccess()).toBe(true);
  });

  // Distinguishes "can't currently tell" (server-side ClerkUnavailable, or any other
  // non-401 failure) from "invalid session" — the caller (store/auth.ts) maps this to
  // "offline", not "locked", so a transient outage doesn't bounce a signed-in user.
  it("throws on a network/other error (server unreachable, or Clerk verification unavailable)", async () => {
    setClerkTokenProvider(async () => "x");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => resp(503)),
    );
    await expect(verifyAccess()).rejects.toThrow();
  });

  it("omits the auth header when Clerk has no session", async () => {
    const f = vi.fn(async () => resp(200));
    vi.stubGlobal("fetch", f);
    await verifyAccess();
    expect((f.mock.calls[0] as unknown[])[1] as RequestInit).toMatchObject({ headers: {} });
  });
});

describe("auth failure listeners", () => {
  it("notifies subscribers and stops after unsubscribe", () => {
    const hit = vi.fn();
    const off = onAuthFailure(hit);
    notifyAuthFailure();
    expect(hit).toHaveBeenCalledTimes(1);
    off();
    notifyAuthFailure();
    expect(hit).toHaveBeenCalledTimes(1);
  });
});
