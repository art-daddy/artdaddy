import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authedFetch,
  getAccessToken,
  hasSession,
  notifyAuthFailure,
  onAuthFailure,
  setClerkTokenProvider,
  setSessionRenewer,
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
  setSessionRenewer(null);
  vi.unstubAllGlobals();
});

/** The Authorization header of each request `f` was asked to send. */
const sentAuth = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls.map(
    (c) =>
      (((c as unknown[])[1] as RequestInit).headers as Record<string, string | undefined>)
        .Authorization,
  );

describe("Clerk token provider", () => {
  it("sends no auth header until Clerk has a session", async () => {
    const f = vi.fn(async () => resp(200));
    vi.stubGlobal("fetch", f);
    await authedFetch("https://api.example.com/x");
    expect(sentAuth(f)).toEqual([undefined]);
    expect(await getAccessToken()).toBeNull();
    expect(await hasSession()).toBe(false);
  });

  it("gets a fresh Clerk token for every request", async () => {
    let generation = 0;
    setClerkTokenProvider(async () => `jwt-${++generation}`);
    const f = vi.fn(async () => resp(200));
    vi.stubGlobal("fetch", f);

    await authedFetch("https://api.example.com/x");
    await authedFetch("https://api.example.com/x");

    expect(sentAuth(f)).toEqual(["Bearer jwt-1", "Bearer jwt-2"]);
  });

  it("trims the token and treats a blank one as no session", async () => {
    setClerkTokenProvider(async () => "  jwt  ");
    expect(await getAccessToken()).toBe("jwt");

    setClerkTokenProvider(async () => "   ");
    expect(await getAccessToken()).toBeNull();
    expect(await hasSession()).toBe(false);
  });

  it("does not let an old effect cleanup remove a newer provider", async () => {
    const removeOld = setClerkTokenProvider(async () => "old");
    setClerkTokenProvider(async () => "new");

    removeOld();

    expect(await getAccessToken()).toBe("new");
  });
});

// The server checks the token before it does any work, so a 401 means nothing ran and sending
// the request again cannot do anything twice. UJ-010: the round a stale token lost was the one
// the user was waiting on, and it was simply dropped.
describe("authedFetch", () => {
  function session(first: string) {
    let token = first;
    setClerkTokenProvider(async () => token);
    const renewer = vi.fn(async (refused: string | null) => {
      token = `${refused}-renewed`;
      return true;
    });
    setSessionRenewer(renewer);
    return renewer;
  }

  it("renews a refused session and sends the request once more, with the new token", async () => {
    const renewer = session("t1");
    const f = vi
      .fn()
      .mockResolvedValueOnce(resp(401))
      .mockResolvedValueOnce(resp(200, { ok: 1 }));
    vi.stubGlobal("fetch", f);

    const res = await authedFetch("https://api.example.com/inference", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"round":1}',
    });

    expect(res.status).toBe(200);
    expect(renewer).toHaveBeenCalledWith("t1");
    expect(sentAuth(f)).toEqual(["Bearer t1", "Bearer t1-renewed"]);
    // The same request, not a different one: method, body and the caller's own headers.
    const [a, b] = f.mock.calls.map((c) => (c as unknown[])[1] as RequestInit);
    expect([b.method, b.body]).toEqual([a.method, a.body]);
    expect((b.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("sends it at most twice: a second 401 is the answer", async () => {
    session("t1");
    const f = vi.fn(async () => resp(401));
    vi.stubGlobal("fetch", f);

    expect((await authedFetch("https://api.example.com/x")).status).toBe(401);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("does not send again when the session could not be renewed", async () => {
    session("t1").mockResolvedValue(false);
    const f = vi.fn(async () => resp(401));
    vi.stubGlobal("fetch", f);

    expect((await authedFetch("https://api.example.com/x")).status).toBe(401);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("leaves every other answer alone", async () => {
    const renewer = session("t1");
    for (const status of [200, 402, 403, 429, 500]) {
      const f = vi.fn(async () => resp(status));
      vi.stubGlobal("fetch", f);
      expect((await authedFetch("https://api.example.com/x")).status).toBe(status);
      expect(f).toHaveBeenCalledTimes(1);
    }
    expect(renewer).not.toHaveBeenCalled();
  });

  it("sends through the caller's own fetcher both times (a 429-retrying one)", async () => {
    session("t1");
    const send = vi.fn().mockResolvedValueOnce(resp(401)).mockResolvedValueOnce(resp(200));
    vi.stubGlobal("fetch", vi.fn());

    await authedFetch("https://api.example.com/x", {}, send);

    expect(sentAuth(send)).toEqual(["Bearer t1", "Bearer t1-renewed"]);
  });

  it("does not send again when the renewal itself fails", async () => {
    setClerkTokenProvider(async () => "t1");
    setSessionRenewer(async () => {
      throw new Error("keychain locked");
    });
    const f = vi.fn(async () => resp(401));
    vi.stubGlobal("fetch", f);

    expect((await authedFetch("https://api.example.com/x")).status).toBe(401);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("re-sends after a 401 that carried no body", async () => {
    session("t1");
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(resp(200));
    vi.stubGlobal("fetch", f);

    expect((await authedFetch("https://api.example.com/x")).status).toBe(200);
  });

  it("does not let an old effect cleanup remove a newer renewer", async () => {
    setClerkTokenProvider(async () => "t1");
    const old = vi.fn(async () => true);
    const newer = vi.fn(async () => false);
    const removeOld = setSessionRenewer(old);
    const removeNewer = setSessionRenewer(newer);
    removeOld();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => resp(401)),
    );

    await authedFetch("https://api.example.com/x");
    expect(newer).toHaveBeenCalledTimes(1);

    removeNewer();
    await authedFetch("https://api.example.com/x");
    expect(newer).toHaveBeenCalledTimes(1);
    expect(old).not.toHaveBeenCalled();
  });

  it("sends nothing when a spent session cannot be renewed", async () => {
    setClerkTokenProvider(async () => {
      throw new Error("renewal unavailable");
    });
    const f = vi.fn(async () => resp(200));
    vi.stubGlobal("fetch", f);

    await expect(authedFetch("https://api.example.com/x")).rejects.toThrow(/renewal unavailable/);
    expect(f).not.toHaveBeenCalled();
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
    await expect(verifyAccess()).rejects.toThrow(/503/);
  });

  it("omits the auth header when Clerk has no session", async () => {
    const f = vi.fn(async () => resp(200));
    vi.stubGlobal("fetch", f);
    await verifyAccess();
    expect(sentAuth(f)).toEqual([undefined]);
  });

  it("renews a refused token before answering 'locked'", async () => {
    let token = "stale";
    setClerkTokenProvider(async () => token);
    setSessionRenewer(async () => {
      token = "renewed";
      return true;
    });
    const f = vi.fn().mockResolvedValueOnce(resp(401)).mockResolvedValueOnce(resp(200));
    vi.stubGlobal("fetch", f);

    expect(await verifyAccess()).toBe(true);
  });
});

// One door: a request that carries a token anywhere else skips the renewal and the second try.
describe("the authenticated door", () => {
  it("is the only place a request gets an Authorization header", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = join(__dirname, "..");
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$|\.e2e\.ts$/.test(name)) out.push(p);
      }
      return out;
    };
    const carriesToken = /\bAuthorization\b\s*:|Bearer \$\{|authHeaders\(/;
    const offenders = walk(src)
      .map((f) => f.slice(src.length + 1).replace(/\\/g, "/"))
      .filter((rel) => rel !== "api/auth.ts")
      .filter((rel) => carriesToken.test(readFileSync(join(src, rel), "utf8")));
    expect(offenders).toEqual([]);
  }, 30_000);
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
