import { beforeEach, describe, expect, it, vi } from "vitest";

// The PKCE/loopback exchange this app needs since Clerk's own SDK cannot run inside the Tauri
// webview at all (its origin is neither the verified web domain nor a browser Clerk trusts):
// the system browser completes a normal Clerk login on the real artdaddy.app/auth origin, then hands
// a short-lived one-time code back to this module via a deep link, which trades it for this
// app's OWN access/refresh tokens. See docs/PROJECT_DOCUMENT_ARCHITECTURE.md-adjacent reasoning
// in api/auth.ts for why the token PROVIDER shape stays generic.
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const platformMock = vi.hoisted(() => ({ name: "tauri" as "tauri" | "web" }));
vi.mock("../platform", () => ({ platform: platformMock }));
vi.mock("./config", () => ({ apiBase: () => "https://api.example.com" }));

const fetchMock = vi.hoisted(() => vi.fn());

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

async function importFresh() {
  vi.resetModules();
  return import("./desktopAuth");
}

beforeEach(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  invoke.mockReset();
  fetchMock.mockReset();
  platformMock.name = "tauri";
  // The pending attempt OUTLIVES the module now, so resetModules alone no longer isolates a
  // test from the one before it.
  localStorage.clear();
});

describe("PKCE pair generation", () => {
  it("derives the challenge as base64url(sha256(verifier)), not a copy of the verifier", async () => {
    const { generatePkcePair } = await importFresh();
    const { verifier, challenge } = await generatePkcePair();
    const expected = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(challenge).toBe(expected);
    expect(challenge).not.toBe(verifier);
  });

  it("never reuses a verifier across two calls", async () => {
    const { generatePkcePair } = await importFresh();
    const a = await generatePkcePair();
    const b = await generatePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
  });

  it("generates a fresh, non-empty state each call", async () => {
    const { generateState } = await importFresh();
    const a = generateState();
    const b = generateState();
    expect(a.length).toBeGreaterThan(16);
    expect(a).not.toBe(b);
  });
});

describe("startDesktopSignIn", () => {
  it("refuses cleanly off the desktop shell, without touching invoke", async () => {
    platformMock.name = "web";
    const { startDesktopSignIn } = await importFresh();
    const result = await startDesktopSignIn();
    expect(result.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("opens the desktop-auth URL with a challenge and state, and derives it from THIS attempt's verifier", async () => {
    invoke.mockResolvedValue(undefined);
    const { startDesktopSignIn } = await importFresh();
    const result = await startDesktopSignIn();
    expect(result.ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith(
      "open_desktop_auth",
      expect.objectContaining({
        url: expect.stringContaining("https://artdaddy.app/auth?"),
      }),
    );
    const openedUrl = new URL(invoke.mock.calls[0][1].url);
    expect(openedUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(openedUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(openedUrl.searchParams.get("state")).toBeTruthy();
  });

  it("surfaces a failure when the OS refuses to open the browser, without leaving a pending attempt", async () => {
    invoke.mockRejectedValueOnce(new Error("os refused"));
    const { startDesktopSignIn, handleDeepLinkCallback } = await importFresh();
    const started = await startDesktopSignIn();
    expect(started.ok).toBe(false);

    // A callback arriving after a failed open must not be treated as belonging to this
    // (never-actually-started) attempt.
    const stray = await handleDeepLinkCallback("artdaddy://auth/callback?code=x&state=y");
    expect(stray.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("handleDeepLinkCallback — negative cases", () => {
  it("reports an unreachable backend instead of rejecting, since nothing catches a rejection here", async () => {
    // The OS event handler calls this fire-and-forget, so a thrown fetch is reported nowhere:
    // the user gets no message and the button never changes. It must RESOLVE with a failure.
    invoke.mockResolvedValue(undefined);
    const { startDesktopSignIn, handleDeepLinkCallback } = await importFresh();
    await startDesktopSignIn();
    const state = new URL(invoke.mock.calls[0][1].url).searchParams.get("state")!;
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await handleDeepLinkCallback(`artdaddy://auth/callback?code=abc&state=${state}`);
    expect(result.ok).toBe(false);
    expect("message" in result && result.message).toBeTruthy();
  });

  it("completes a callback that COLD-STARTED the app, in a process that never ran startDesktopSignIn", async () => {
    // On Windows the deep link launches the app when it is not already running, so the callback
    // routinely lands in a brand-new process. Every other test here starts and finishes the
    // attempt in ONE module instance, which is why an in-memory-only attempt passed them all
    // while desktop sign-in could never complete for a real user.
    invoke.mockResolvedValue(undefined);
    const starter = await importFresh();
    await starter.startDesktopSignIn();
    const state = new URL(invoke.mock.calls[0][1].url).searchParams.get("state")!;

    // A DIFFERENT module instance = the cold-started process. It shares nothing but storage.
    fetchMock.mockResolvedValue(
      jsonResponse(200, { access_token: "at-cold", refresh_token: "rt-cold", expires_in: 900 }),
    );
    const coldStarted = await importFresh();
    const result = await coldStarted.handleDeepLinkCallback(
      `artdaddy://auth/callback?code=code-from-browser&state=${state}`,
    );

    expect(result.ok, `cold-start callback was refused: ${JSON.stringify(result)}`).toBe(true);
    expect(coldStarted.getAccessToken()).toBe("at-cold");
  });

  it("a cold-started process still refuses a callback whose state does not match", async () => {
    invoke.mockResolvedValue(undefined);
    const starter = await importFresh();
    await starter.startDesktopSignIn();

    const coldStarted = await importFresh();
    const result = await coldStarted.handleDeepLinkCallback(
      "artdaddy://auth/callback?code=x&state=not-the-persisted-state",
    );
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a callback when no sign-in attempt is pending", async () => {
    const { handleDeepLinkCallback } = await importFresh();
    const result = await handleDeepLinkCallback("artdaddy://auth/callback?code=abc&state=xyz");
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a callback whose state does not match the pending attempt (CSRF/fixation defense)", async () => {
    invoke.mockResolvedValue(undefined);
    const { startDesktopSignIn, handleDeepLinkCallback } = await importFresh();
    await startDesktopSignIn();
    const result = await handleDeepLinkCallback(
      "artdaddy://auth/callback?code=abc&state=not-the-real-state",
    );
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("only accepts the state from the MOST RECENT startDesktopSignIn call — an older attempt cannot complete a newer one", async () => {
    invoke.mockResolvedValue(undefined);
    const { startDesktopSignIn, handleDeepLinkCallback } = await importFresh();
    await startDesktopSignIn();
    const firstUrl = new URL(invoke.mock.calls[0][1].url);
    const firstState = firstUrl.searchParams.get("state")!;

    await startDesktopSignIn(); // user clicked "sign in" again before finishing the first attempt

    const result = await handleDeepLinkCallback(
      `artdaddy://auth/callback?code=abc&state=${firstState}`,
    );
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects and does not call the backend when the callback URL carries neither code nor state", async () => {
    invoke.mockResolvedValue(undefined);
    const { startDesktopSignIn, handleDeepLinkCallback } = await importFresh();
    await startDesktopSignIn();
    const result = await handleDeepLinkCallback("artdaddy://auth/callback");
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a failure (not a thrown exception) when the backend rejects the code, and clears the pending attempt", async () => {
    invoke.mockResolvedValue(undefined);
    fetchMock.mockResolvedValue(jsonResponse(400, { error: "invalid or expired code" }));
    const { startDesktopSignIn, handleDeepLinkCallback, getAccessToken } = await importFresh();
    await startDesktopSignIn();
    const state = new URL(invoke.mock.calls[0][1].url).searchParams.get("state")!;
    const result = await handleDeepLinkCallback(`artdaddy://auth/callback?code=bad&state=${state}`);
    expect(result.ok).toBe(false);
    expect(getAccessToken()).toBeNull();

    // The failed attempt must not still be "pending" — replaying the same callback again
    // must not re-hit the backend a second time for an attempt that already failed.
    fetchMock.mockClear();
    const replay = await handleDeepLinkCallback(`artdaddy://auth/callback?code=bad&state=${state}`);
    expect(replay.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cannot be redeemed twice client-side even if the backend's own single-use check were bypassed", async () => {
    invoke.mockResolvedValue(undefined);
    fetchMock.mockResolvedValue(
      jsonResponse(200, { access_token: "at1", refresh_token: "rt1", expires_in: 900 }),
    );
    const { startDesktopSignIn, handleDeepLinkCallback } = await importFresh();
    await startDesktopSignIn();
    const state = new URL(invoke.mock.calls[0][1].url).searchParams.get("state")!;
    const first = await handleDeepLinkCallback(`artdaddy://auth/callback?code=good&state=${state}`);
    expect(first.ok).toBe(true);

    fetchMock.mockClear();
    const second = await handleDeepLinkCallback(
      `artdaddy://auth/callback?code=good&state=${state}`,
    );
    expect(second.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("on success, stores the refresh token via the OS keychain command and exposes the access token", async () => {
    invoke.mockResolvedValue(undefined);
    fetchMock.mockResolvedValue(
      jsonResponse(200, { access_token: "at1", refresh_token: "rt1", expires_in: 900 }),
    );
    const { startDesktopSignIn, handleDeepLinkCallback, getAccessToken } = await importFresh();
    await startDesktopSignIn();
    const state = new URL(invoke.mock.calls[0][1].url).searchParams.get("state")!;
    const result = await handleDeepLinkCallback(
      `artdaddy://auth/callback?code=good&state=${state}`,
    );
    expect(result.ok).toBe(true);
    expect(getAccessToken()).toBe("at1");
    expect(invoke).toHaveBeenCalledWith("store_refresh_token", { token: "rt1" });
  });

  it("never exposes an access token unless the refresh token was actually persisted first (ordering)", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "store_refresh_token") throw new Error("keychain write failed");
      return undefined;
    });
    fetchMock.mockResolvedValue(
      jsonResponse(200, { access_token: "at1", refresh_token: "rt1", expires_in: 900 }),
    );
    const { startDesktopSignIn, handleDeepLinkCallback, getAccessToken } = await importFresh();
    await startDesktopSignIn();
    const state = new URL(invoke.mock.calls[0][1].url).searchParams.get("state")!;
    const result = await handleDeepLinkCallback(
      `artdaddy://auth/callback?code=good&state=${state}`,
    );
    // A rotated pair the app couldn't durably store must never look like a live session --
    // the next launch would have no refresh token to fall back on anyway.
    expect(result.ok).toBe(false);
    expect(getAccessToken()).toBeNull();
  });

  it("sends the code_verifier that matches the challenge from THIS attempt, never a stale one", async () => {
    invoke.mockResolvedValue(undefined);
    fetchMock.mockResolvedValue(
      jsonResponse(200, { access_token: "at1", refresh_token: "rt1", expires_in: 900 }),
    );
    const { startDesktopSignIn, handleDeepLinkCallback } = await importFresh();
    await startDesktopSignIn();
    const url = new URL(invoke.mock.calls[0][1].url);
    const challengeSent = url.searchParams.get("code_challenge")!;
    const state = url.searchParams.get("state")!;
    await handleDeepLinkCallback(`artdaddy://auth/callback?code=good&state=${state}`);

    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse(opts.body as string);
    const rederivedChallenge = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.code_verifier)),
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(rederivedChallenge).toBe(challengeSent);
  });
});

describe("refreshDesktopSession", () => {
  it("reports no session and never calls the backend when nothing is stored in the keychain", async () => {
    invoke.mockResolvedValue(null); // load_refresh_token: nothing stored
    const { refreshDesktopSession } = await importFresh();
    const result = await refreshDesktopSession();
    expect(result).toEqual({ status: "missing", hasStoredSession: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears the stored refresh token (does not retry forever) when the backend rejects it as revoked/expired", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "load_refresh_token" ? "stale-rt" : undefined,
    );
    fetchMock.mockResolvedValue(jsonResponse(401, { error: "revoked" }));
    const { refreshDesktopSession } = await importFresh();
    const result = await refreshDesktopSession();
    expect(result).toEqual({ status: "invalid", hasStoredSession: false });
    expect(invoke).toHaveBeenCalledWith("clear_refresh_token", undefined);
  });

  it("rotates the refresh token on success (old one is replaced, not reused)", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "load_refresh_token" ? "old-rt" : undefined,
    );
    fetchMock.mockResolvedValue(
      jsonResponse(200, { access_token: "at2", refresh_token: "new-rt", expires_in: 900 }),
    );
    const { refreshDesktopSession, getAccessToken } = await importFresh();
    const result = await refreshDesktopSession();
    expect(result).toEqual({ status: "refreshed", hasStoredSession: true });
    expect(getAccessToken()).toBe("at2");
    expect(invoke).toHaveBeenCalledWith("store_refresh_token", { token: "new-rt" });
  });

  it("joins concurrent refreshes so a rotating token is submitted and stored exactly once", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "load_refresh_token" ? "one-time-rt" : undefined,
    );
    let answer!: (value: ReturnType<typeof jsonResponse>) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const { refreshDesktopSession } = await importFresh();

    const first = refreshDesktopSession();
    const second = refreshDesktopSession();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    answer(jsonResponse(200, { access_token: "at2", refresh_token: "new-rt" }));

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "refreshed", hasStoredSession: true },
      { status: "refreshed", hasStoredSession: true },
    ]);
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "load_refresh_token")).toHaveLength(1);
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "store_refresh_token")).toHaveLength(1);
  });

  it("does not clear a new deep-link session when an older refresh later returns 401", async () => {
    let stored: string | null = "stale-rt";
    invoke.mockImplementation(async (cmd: string, args?: { token?: string }) => {
      if (cmd === "load_refresh_token") return stored;
      if (cmd === "store_refresh_token") stored = args?.token ?? null;
      if (cmd === "clear_refresh_token") stored = null;
      if (cmd === "open_desktop_auth") return undefined;
      return undefined;
    });
    let answerRefresh!: (value: ReturnType<typeof jsonResponse>) => void;
    fetchMock
      .mockReturnValueOnce(
        new Promise((resolve) => {
          answerRefresh = resolve;
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { access_token: "signed-in-at", refresh_token: "signed-in-rt" }),
      );
    const { refreshDesktopSession, startDesktopSignIn, handleDeepLinkCallback, getAccessToken } =
      await importFresh();

    const refreshing = refreshDesktopSession();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await startDesktopSignIn();
    const state = new URL(
      invoke.mock.calls.find(([cmd]) => cmd === "open_desktop_auth")![1].url,
    ).searchParams.get("state")!;
    await expect(
      handleDeepLinkCallback(`artdaddy://auth/callback?code=fresh&state=${state}`),
    ).resolves.toEqual({ ok: true });
    answerRefresh(jsonResponse(401, { error: "stale" }));

    await expect(refreshing).resolves.toEqual({
      status: "superseded",
      hasStoredSession: null,
    });
    expect(stored).toBe("signed-in-rt");
    expect(getAccessToken()).toBe("signed-in-at");
  });

  it("does not clear a refresh token changed by another writer before a 401 arrives", async () => {
    let stored: string | null = "submitted-rt";
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_refresh_token") return stored;
      if (cmd === "clear_refresh_token") stored = null;
      return undefined;
    });
    let answer!: (value: ReturnType<typeof jsonResponse>) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const { refreshDesktopSession } = await importFresh();

    const refreshing = refreshDesktopSession();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    stored = "other-writer-rt";
    answer(jsonResponse(401, { error: "submitted token was stale" }));

    await expect(refreshing).resolves.toEqual({
      status: "unavailable",
      hasStoredSession: true,
    });
    expect(stored).toBe("other-writer-rt");
    expect(invoke).not.toHaveBeenCalledWith("clear_refresh_token", undefined);
  });

  it("does NOT clear the refresh token on a transient backend outage (503) -- only a definitive 401 justifies that", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "load_refresh_token" ? "good-rt" : undefined,
    );
    fetchMock.mockResolvedValue(jsonResponse(503, { error: "unavailable" }));
    const { refreshDesktopSession, getAccessToken } = await importFresh();
    const result = await refreshDesktopSession();
    expect(result).toEqual({ status: "unavailable", hasStoredSession: true });
    expect(getAccessToken()).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("clear_refresh_token", undefined);
  });

  it("does NOT clear the refresh token when the request itself fails (offline) -- a network blip is not a revoked token", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "load_refresh_token" ? "good-rt" : undefined,
    );
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const { refreshDesktopSession } = await importFresh();
    const result = await refreshDesktopSession();
    expect(result).toEqual({ status: "unavailable", hasStoredSession: true });
    expect(invoke).not.toHaveBeenCalledWith("clear_refresh_token", undefined);
  });

  it("never commits the new access token if persisting the rotated refresh token fails (ordering)", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_refresh_token") return "old-rt";
      if (cmd === "store_refresh_token") throw new Error("keychain write failed");
      return undefined;
    });
    fetchMock.mockResolvedValue(
      jsonResponse(200, { access_token: "at2", refresh_token: "new-rt", expires_in: 900 }),
    );
    const { refreshDesktopSession, getAccessToken } = await importFresh();
    const result = await refreshDesktopSession();
    expect(result).toEqual({ status: "unavailable", hasStoredSession: true });
    expect(getAccessToken()).toBeNull();
  });
});

describe("signOutDesktop", () => {
  it("drops the in-memory access token and clears the OS keychain entry", async () => {
    invoke.mockResolvedValue(undefined);
    fetchMock.mockResolvedValue(
      jsonResponse(200, { access_token: "at1", refresh_token: "rt1", expires_in: 900 }),
    );
    const { startDesktopSignIn, handleDeepLinkCallback, signOutDesktop, getAccessToken } =
      await importFresh();
    await startDesktopSignIn();
    const state = new URL(invoke.mock.calls[0][1].url).searchParams.get("state")!;
    await handleDeepLinkCallback(`artdaddy://auth/callback?code=good&state=${state}`);
    expect(getAccessToken()).toBe("at1");

    await signOutDesktop();
    expect(getAccessToken()).toBeNull();
    expect(invoke).toHaveBeenCalledWith("clear_refresh_token", undefined);
  });

  it("wins over a refresh whose keychain write was already in flight", async () => {
    let releaseStore!: () => void;
    const storeBlocked = new Promise<void>((resolve) => {
      releaseStore = resolve;
    });
    let stored: string | null = "old-rt";
    invoke.mockImplementation(async (cmd: string, args?: { token?: string }) => {
      if (cmd === "load_refresh_token") return stored;
      if (cmd === "store_refresh_token") {
        await storeBlocked;
        stored = args?.token ?? null;
      }
      if (cmd === "clear_refresh_token") stored = null;
      return undefined;
    });
    fetchMock.mockResolvedValue(
      jsonResponse(200, { access_token: "at2", refresh_token: "new-rt" }),
    );
    const { refreshDesktopSession, signOutDesktop, getAccessToken } = await importFresh();

    const refreshing = refreshDesktopSession();
    await vi.waitFor(() =>
      expect(invoke.mock.calls.some(([cmd]) => cmd === "store_refresh_token")).toBe(true),
    );
    const signingOut = signOutDesktop();
    releaseStore();

    await expect(refreshing).resolves.toEqual({ status: "superseded", hasStoredSession: null });
    await signingOut;
    expect(getAccessToken()).toBeNull();
    expect(stored).toBeNull();
  });

  it("blocks a new refresh that starts after sign-out begins", async () => {
    let releaseClear!: () => void;
    const clearBlocked = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_refresh_token") return "old-rt";
      if (cmd === "clear_refresh_token") await clearBlocked;
      return undefined;
    });
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const { refreshDesktopSession, signOutDesktop } = await importFresh();

    const signingOut = signOutDesktop();
    await vi.waitFor(() =>
      expect(invoke.mock.calls.some(([cmd]) => cmd === "clear_refresh_token")).toBe(true),
    );
    await expect(refreshDesktopSession()).resolves.toEqual({
      status: "missing",
      hasStoredSession: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    releaseClear();
    await signingOut;
  });

  it("keeps refresh blocked when the OS refuses to open a new sign-in attempt", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_refresh_token") return "old-rt";
      if (cmd === "open_desktop_auth") throw new Error("browser unavailable");
      return undefined;
    });
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const { signOutDesktop, startDesktopSignIn, refreshDesktopSession } = await importFresh();

    await signOutDesktop();
    await expect(startDesktopSignIn()).resolves.toMatchObject({ ok: false });
    await expect(refreshDesktopSession()).resolves.toEqual({
      status: "missing",
      hasStoredSession: false,
    });
  });
});

// The access token lives ~30 minutes and nothing used to renew it until a live call came back
// 401. That made the FIRST prompt after any idle spell fail for everyone, every time: the 401
// triggered the refresh, the refresh worked, and the request that paid for it was thrown away.
// A real user reported it as "it errored, then the same prompt worked".
describe("ensureFreshAccessToken", () => {
  /** A token whose `exp` claim sits `secondsFromNow` away. Unsigned: nothing here verifies it. */
  function tokenExpiringIn(secondsFromNow: number): string {
    const payload = Buffer.from(
      JSON.stringify({ sub: "user_1", exp: Math.floor(Date.now() / 1000) + secondsFromNow }),
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return `h.${payload}.s`;
  }

  /** Sign in so the module holds `token`, then forget how we got there. */
  async function withToken(token: string) {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "load_refresh_token" ? "rt-0" : undefined,
    );
    fetchMock.mockResolvedValue(
      jsonResponse(200, { access_token: token, refresh_token: "rt-1", expires_in: 1800 }),
    );
    const mod = await importFresh();
    await mod.refreshDesktopSession();
    fetchMock.mockClear();
    return mod;
  }

  it("renews a token that is about to expire BEFORE handing it to a request", async () => {
    const mod = await withToken(tokenExpiringIn(10)); // inside the skew
    fetchMock.mockResolvedValue(
      jsonResponse(200, { access_token: tokenExpiringIn(1800), refresh_token: "rt-2" }),
    );

    const token = await mod.ensureFreshAccessToken();

    expect(fetchMock, "a spent token must be renewed, not sent").toHaveBeenCalledTimes(1);
    expect(token).not.toBe("");
    expect(mod.getAccessToken()).toBe(token);
  });

  it("does not refresh a healthy token, so every request does not stampede the endpoint", async () => {
    const mod = await withToken(tokenExpiringIn(1800));

    const token = await mod.ensureFreshAccessToken();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(token).toBe(mod.getAccessToken());
  });

  // Unreadable is not evidence of valid. Treating an undated token as fine is the failure
  // direction that puts us straight back to "first request 401s".
  it("treats a token with no readable expiry as spent", async () => {
    const mod = await withToken("not-a-jwt");
    fetchMock.mockResolvedValue(
      jsonResponse(200, { access_token: tokenExpiringIn(1800), refresh_token: "rt-2" }),
    );

    await mod.ensureFreshAccessToken();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The stored refresh token is one-time and rotates. Two simultaneous requests finding a spent
  // token must not both spend it: one rotation wins and the other would 401 a valid session.
  it("joins concurrent callers into a single refresh", async () => {
    const mod = await withToken(tokenExpiringIn(5));
    fetchMock.mockResolvedValue(
      jsonResponse(200, { access_token: tokenExpiringIn(1800), refresh_token: "rt-2" }),
    );

    const [a, b] = await Promise.all([mod.ensureFreshAccessToken(), mod.ensureFreshAccessToken()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  // Falling back to the token in hand beats sending none: no Authorization header is a
  // guaranteed 401, whereas a token seconds from expiry may still be accepted.
  it("falls back to the held token, without throwing, when the refresh cannot be made", async () => {
    const held = tokenExpiringIn(5);
    const mod = await withToken(held);
    invoke.mockResolvedValue(null); // the keychain has nothing to refresh with
    await expect(mod.ensureFreshAccessToken()).resolves.toBe(held);
  });

  it("never throws when the refresh request itself explodes", async () => {
    const mod = await withToken(tokenExpiringIn(5));
    fetchMock.mockRejectedValue(new TypeError("offline"));
    await expect(mod.ensureFreshAccessToken()).resolves.not.toThrow();
  });
});
