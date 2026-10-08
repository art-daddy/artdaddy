import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
//
// Built from what the server really sends (desktop_auth.py): `iat`/`exp` on the SERVER's clock and
// `expires_in`. This PC's two clocks are driven separately, because UJ-010 was exactly a PC whose
// wall clock disagreed with the server's: two hours slow, it kept a 30-minute token for 2.5 hours.
describe("ensureFreshAccessToken", () => {
  const SERVER_NOW = 1_800_000_000; // seconds, the server's clock
  const TTL = 1800; // ACCESS_TOKEN_TTL_SECONDS
  const MIN = 60_000;
  let wall = 0; // this PC's Date.now(), ms
  let mono = 0; // this PC's performance.now(), ms
  let spies: Array<{ mockRestore(): void }> = [];
  let rotation = 0;

  beforeEach(() => {
    wall = SERVER_NOW * 1000;
    mono = 5_000;
    spies = [
      vi.spyOn(Date, "now").mockImplementation(() => wall),
      vi.spyOn(performance, "now").mockImplementation(() => mono),
    ];
  });
  afterEach(() => {
    for (const s of spies) s.mockRestore();
    vi.useRealTimers();
  });

  /** A token as the server mints it at `serverSec` on ITS clock. Unsigned: nothing here verifies it. */
  function minted(serverSec = SERVER_NOW): string {
    const payload = Buffer.from(
      JSON.stringify({ sub: "user_1", iat: serverSec, exp: serverSec + TTL }),
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return `h.${payload}.s`;
  }
  const reply = (token: string, extra: Record<string, unknown> = { expires_in: TTL }) =>
    jsonResponse(200, { access_token: token, refresh_token: `rt-${++rotation}`, ...extra });
  /** Time passing on this PC: the wall clock and the monotonic clock, separately. */
  const pass = (wallMs: number, monoMs = wallMs) => {
    wall += wallMs;
    mono += monoMs;
  };

  /** Sign in so the module holds `token`, then forget how we got there. */
  async function withToken(token: string, extra?: Record<string, unknown>) {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "load_refresh_token" ? "rt-0" : undefined,
    );
    fetchMock.mockResolvedValue(reply(token, extra));
    const mod = await importFresh();
    await mod.refreshDesktopSession();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(reply(minted(SERVER_NOW + 1500)));
    return mod;
  }

  it("renews a token in its last minute BEFORE handing it to a request", async () => {
    const mod = await withToken(minted());
    pass(29.5 * MIN);

    const token = await mod.ensureFreshAccessToken();

    expect(fetchMock, "a spent token must be renewed, not sent").toHaveBeenCalledTimes(1);
    expect(token).toBe(mod.getAccessToken());
    expect(token).not.toBe(minted());
  });

  it("does not refresh a healthy token, so every request does not stampede the endpoint", async () => {
    const mod = await withToken(minted());
    pass(10 * MIN);

    const token = await mod.ensureFreshAccessToken();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(token).toBe(minted());
  });

  // UJ-010, the Tunisian PC: two hours slow. Read against its wall clock, `exp` was 2.5 h away when
  // the token had seconds left, so nothing renewed it and the turn ended "session expired".
  it("a PC two hours SLOW still renews before the token dies", async () => {
    wall = (SERVER_NOW - 2 * 3600) * 1000;
    const mod = await withToken(minted());
    pass(29.5 * MIN);

    await mod.ensureFreshAccessToken();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The opposite clock error: `exp` reads as long past, so every request renewed and rotated.
  it("a PC two hours FAST does not renew on every request", async () => {
    wall = (SERVER_NOW + 2 * 3600) * 1000;
    const mod = await withToken(minted());
    pass(1 * MIN);

    await mod.ensureFreshAccessToken();
    await mod.ensureFreshAccessToken();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A sleeping machine's monotonic clock can stand still (macOS), so the wall clock must count too.
  it("a machine that slept through the token's life renews on waking", async () => {
    const mod = await withToken(minted());
    pass(31 * MIN, 0);

    await mod.ensureFreshAccessToken();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ...and the wall clock can be set back while a token is held, so the monotonic clock counts too.
  it("a clock set back while the token is held still renews when its life is up", async () => {
    const mod = await withToken(minted());
    pass(-2 * 3600 * 1000 + 31 * MIN, 31 * MIN);

    await mod.ensureFreshAccessToken();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a token that arrives without expires_in is timed by its own iat and exp", async () => {
    wall = (SERVER_NOW - 2 * 3600) * 1000;
    const mod = await withToken(minted(), {});
    pass(29.5 * MIN);

    await mod.ensureFreshAccessToken();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ...and not renewed early on that account either: its life is exp - iat, not zero.
  for (const [label, extra] of [
    ["no expires_in", {}],
    ["expires_in 0", { expires_in: 0 }],
    ["a negative expires_in", { expires_in: -5 }],
    ["an unreadable expires_in", { expires_in: "soon" }],
  ] as const) {
    it(`with ${label}, a token's own iat and exp keep it until near its end`, async () => {
      const mod = await withToken(minted(), extra);
      pass(28 * MIN);

      await mod.ensureFreshAccessToken();

      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it("renews from exactly one minute before the end", async () => {
    const mod = await withToken(minted());
    pass(29 * MIN - 1);
    await mod.ensureFreshAccessToken();
    expect(fetchMock).not.toHaveBeenCalled();

    pass(1);
    await mod.ensureFreshAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The payload is base64url: '-' and '_' stand where base64 has '+' and '/'.
  it("reads a payload whose base64url uses '-' and '_'", async () => {
    const claims = { sub: "user_>>>???", iat: SERVER_NOW, exp: SERVER_NOW + TTL, pad: "ûï¿" };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    expect(payload, "the fixture must exercise both substitutions").toMatch(/-/);
    expect(payload).toMatch(/_/);
    const mod = await withToken(`ad_h.${payload}.s`, {});
    pass(28 * MIN);

    await mod.ensureFreshAccessToken();

    expect(mod.getUserId()).toBe("user_>>>???");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("off the desktop shell, never reaches for the keychain or the refresh endpoint", async () => {
    platformMock.name = "web";
    const mod = await importFresh();

    await expect(mod.ensureFreshAccessToken()).resolves.toBeNull();
    await expect(mod.renewAfterRejection(null)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  // Unreadable is not evidence of valid: a token whose life nothing states counts as spent.
  it("treats a token whose lifetime cannot be established as spent", async () => {
    const mod = await withToken("not-a-jwt", {});

    await mod.ensureFreshAccessToken();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ...but the token a renewal has just returned is the newest the server issued. Holding it back
  // sent the request with no token at all, which the server reads as signed out.
  it("sends the token a renewal just returned, even one whose life it cannot read", async () => {
    const mod = await withToken(minted());
    pass(31 * MIN);
    fetchMock.mockResolvedValue(reply("ad_at_opaque", {}));

    await expect(mod.ensureFreshAccessToken()).resolves.toBe("ad_at_opaque");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // What the server says a token lives is enough on its own: the payload need not be readable.
  it("keeps a token it cannot read for as long as the server said it lives", async () => {
    const mod = await withToken("ad_at_opaque", { expires_in: TTL });
    pass(28 * MIN);

    await expect(mod.ensureFreshAccessToken()).resolves.toBe("ad_at_opaque");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Only NUMERIC claims date a token. Anything else - a claim missing, written as text, null - must
  // read as "unknown, renew before use", never as a lifetime. `iat` without `exp` would compute NaN,
  // and NaN compares false with everything: that token would never have expired.
  it("dates a token by its own claims only when both are numbers", async () => {
    const near = fc.integer({ min: SERVER_NOW - 4000, max: SERVER_NOW + 4000 });
    const claim = fc.oneof(
      near,
      near.map(String),
      fc.constant(null),
      fc.boolean(),
      fc.constant(undefined),
    );
    const end = SERVER_NOW + TTL;
    await fc.assert(
      fc.asyncProperty(claim, claim, async (iat, exp) => {
        const payload = Buffer.from(JSON.stringify({ sub: "u", iat, exp })).toString("base64url");
        const mod = await withToken(`h.${payload}.s`, {});

        await mod.ensureFreshAccessToken();

        const dated = typeof iat === "number" && typeof exp === "number";
        const keeps = dated && (exp - iat) * 1000 > MIN;
        expect(fetchMock.mock.calls.length, `iat ${iat}, exp ${exp}`).toBe(keeps ? 0 : 1);
      }),
      {
        numRuns: 150,
        examples: [
          [SERVER_NOW, end],
          [SERVER_NOW, undefined],
          [String(SERVER_NOW), end],
          [SERVER_NOW, String(end)],
          [String(SERVER_NOW), String(end)],
          [null, end],
        ],
      },
    );
  });

  // The stored refresh token is one-time and rotates. Two simultaneous requests finding a spent
  // token must not both spend it: one rotation wins and the other would 401 a valid session.
  it("joins concurrent callers into a single refresh", async () => {
    const mod = await withToken(minted());
    pass(29.9 * MIN);

    const [a, b] = await Promise.all([mod.ensureFreshAccessToken(), mod.ensureFreshAccessToken()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  // UJ-010, the Mac: its token ran out while it slept and so did the server (min replicas 0). The
  // renewal gave up after 15 s, every cold start that week took 18-43 s, so the app sent the token
  // it knew had expired. The renewal must outlast the wake-up.
  it("renews through a server that takes 45 s to wake", async () => {
    const mod = await withToken(minted());
    pass(31 * MIN);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const renewed = minted(SERVER_NOW + 1900);
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(reply(renewed)), 45_000);
          init.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );

    const token = mod.ensureFreshAccessToken();
    for (let i = 0; i < 100 && fetchMock.mock.calls.length === 0; i++)
      await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(45_000);

    await expect(token).resolves.toBe(renewed);
  });

  it("never hands over a token it knows is spent when the server cannot be reached", async () => {
    const mod = await withToken(minted());
    pass(31 * MIN);
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(mod.ensureFreshAccessToken()).rejects.toMatchObject({
      name: "SessionRenewalUnavailableError",
    });
  });

  // A request with NO token reads to the server as signed out (401 -> the sign-in screen), which is
  // the wrong verdict for a stored session the server merely could not be asked about.
  it("does not send an unauthenticated request for a stored session it could not renew", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "load_refresh_token" ? "rt-0" : undefined,
    );
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const mod = await importFresh();

    await expect(mod.ensureFreshAccessToken()).rejects.toMatchObject({
      name: "SessionRenewalUnavailableError",
    });
  });

  // Still inside its life, a token beats none: the server accepts it for the seconds it has left.
  it("hands over a token in its last minute when the renewal fails, without throwing", async () => {
    const mod = await withToken(minted());
    pass(29.5 * MIN);
    fetchMock.mockRejectedValue(new TypeError("offline"));

    await expect(mod.ensureFreshAccessToken()).resolves.toBe(minted());
  });

  it("answers null, not an error, when there is no session at all", async () => {
    invoke.mockResolvedValue(null);
    const mod = await importFresh();

    await expect(mod.ensureFreshAccessToken()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Launch opens offline for a stored session while its renewal waits on a waking server, so whether
// the keychain holds one must be known as soon as anything has read or changed it.
describe("storedSessionKnown", () => {
  it("is unknown before the keychain was asked, then says what it holds", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "load_refresh_token" ? "rt-0" : undefined,
    );
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const mod = await importFresh();
    expect(mod.storedSessionKnown()).toBeNull();

    await mod.refreshDesktopSession();

    expect(mod.storedSessionKnown(), "known even though the server never answered").toBe(true);
  });

  it("is false when the keychain is empty", async () => {
    invoke.mockResolvedValue(null);
    const mod = await importFresh();
    await mod.refreshDesktopSession();
    expect(mod.storedSessionKnown()).toBe(false);
  });

  it("is false once the server rejects the stored token, and after sign-out", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "load_refresh_token" ? "rt-0" : undefined,
    );
    fetchMock.mockResolvedValue(jsonResponse(401, { detail: "invalid refresh token" }));
    const rejected = await importFresh();
    await rejected.refreshDesktopSession();
    expect(rejected.storedSessionKnown()).toBe(false);

    fetchMock.mockResolvedValue(
      jsonResponse(200, { access_token: "at", refresh_token: "rt-1", expires_in: 1800 }),
    );
    const signedOut = await importFresh();
    await signedOut.refreshDesktopSession();
    expect(signedOut.storedSessionKnown()).toBe(true);
    await signedOut.signOutDesktop();
    expect(signedOut.storedSessionKnown()).toBe(false);
  });
});

// The server checks a token before it does anything, so a 401 means nothing ran: renew and send
// the request again. A token can be refused while this PC still believes in it (revoked, or a
// clock set back further than the monotonic clock can see), so the local verdict does not decide.
describe("renewAfterRejection", () => {
  async function signedIn() {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "load_refresh_token" ? "rt-0" : undefined,
    );
    fetchMock.mockResolvedValue(
      jsonResponse(200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 1800 }),
    );
    const mod = await importFresh();
    await mod.refreshDesktopSession();
    fetchMock.mockClear();
    return mod;
  }

  it("renews a refused token even though this PC still believes in it", async () => {
    const mod = await signedIn();
    fetchMock.mockResolvedValue(
      jsonResponse(200, { access_token: "at-2", refresh_token: "rt-2", expires_in: 1800 }),
    );

    await expect(mod.renewAfterRejection("at-1")).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mod.getAccessToken()).toBe("at-2");
  });

  it("does not rotate again when a newer token already replaced the refused one", async () => {
    const mod = await signedIn();

    await expect(mod.renewAfterRejection("at-0")).resolves.toBe(true);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says no when the session itself is gone", async () => {
    const mod = await signedIn();
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "load_refresh_token" ? "rt-1" : undefined,
    );
    fetchMock.mockResolvedValue(jsonResponse(401, { detail: "invalid refresh token" }));

    await expect(mod.renewAfterRejection("at-1")).resolves.toBe(false);
  });

  it("says no when the server cannot be reached", async () => {
    const mod = await signedIn();
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(mod.renewAfterRejection("at-1")).resolves.toBe(false);
  });
});
