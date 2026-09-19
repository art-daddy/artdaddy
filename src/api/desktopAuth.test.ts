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
    const ok = await refreshDesktopSession();
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears the stored refresh token (does not retry forever) when the backend rejects it as revoked/expired", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "load_refresh_token" ? "stale-rt" : undefined,
    );
    fetchMock.mockResolvedValue(jsonResponse(401, { error: "revoked" }));
    const { refreshDesktopSession } = await importFresh();
    const ok = await refreshDesktopSession();
    expect(ok).toBe(false);
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
    const ok = await refreshDesktopSession();
    expect(ok).toBe(true);
    expect(getAccessToken()).toBe("at2");
    expect(invoke).toHaveBeenCalledWith("store_refresh_token", { token: "new-rt" });
  });

  it("does NOT clear the refresh token on a transient backend outage (503) -- only a definitive 401 justifies that", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "load_refresh_token" ? "good-rt" : undefined,
    );
    fetchMock.mockResolvedValue(jsonResponse(503, { error: "unavailable" }));
    const { refreshDesktopSession, getAccessToken } = await importFresh();
    const ok = await refreshDesktopSession();
    expect(ok).toBe(false);
    expect(getAccessToken()).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("clear_refresh_token", undefined);
  });

  it("does NOT clear the refresh token when the request itself fails (offline) -- a network blip is not a revoked token", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "load_refresh_token" ? "good-rt" : undefined,
    );
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const { refreshDesktopSession } = await importFresh();
    const ok = await refreshDesktopSession();
    expect(ok).toBe(false);
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
    const ok = await refreshDesktopSession();
    expect(ok).toBe(false);
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
});
