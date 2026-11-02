import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What the sign-in path REPORTS about itself (T-20): one word for every way a step can end, under the id of the
// try it belongs to, and nothing the person or the server wrote. The reporter is a spy here; that its reports
// really leave the app, and carry nothing secret, is tested in authEvents.test.ts and desktopAuth.privacy.test.ts.
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const platformMock = vi.hoisted(() => ({ name: "tauri" as "tauri" | "web" }));
vi.mock("../platform", () => ({ platform: platformMock }));
vi.mock("./config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config")>()),
  apiBase: () => "https://api.example.com",
}));
const reportAuthStep = vi.hoisted(() => vi.fn());
vi.mock("./authEvents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./authEvents")>()),
  reportAuthStep,
}));
const fetchMock = vi.hoisted(() => vi.fn());

const ID = /^[A-Za-z0-9_-]{12}$/;
const TOKENS = { access_token: "at-1", refresh_token: "rt-1", expires_in: 900 };

function reply(status: number, body: unknown = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function importFresh() {
  vi.resetModules();
  return import("./desktopAuth");
}

type Desktop = Awaited<ReturnType<typeof importFresh>>;
type Gate = { resolve: (value: unknown) => void; reject: (reason: unknown) => void };

/** Press "Log in" and return what the browser was opened with. */
async function startAttempt(desktop: Desktop) {
  invoke.mockResolvedValue(undefined);
  await desktop.startDesktopSignIn();
  const url = new URL(invoke.mock.calls.at(-1)![1].url);
  return { state: url.searchParams.get("state")!, attempt: url.searchParams.get("attempt")! };
}

const callbackUrl = (state: string, extra = "") =>
  `artdaddy://auth/callback?code=one-time-code-123456&state=${state}${extra}`;
const reportsFor = (step: string) =>
  reportAuthStep.mock.calls.filter(([reported]) => reported === step).map(([, detail]) => detail);

beforeEach(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  invoke.mockReset();
  fetchMock.mockReset();
  reportAuthStep.mockReset();
  platformMock.name = "tauri";
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("starting a sign-in", () => {
  it("names the try, and opens the browser on an address that carries the same name", async () => {
    const desktop = await importFresh();
    const { attempt } = await startAttempt(desktop);
    expect(attempt).toMatch(ID);
    expect(reportsFor("start")).toEqual([{ ok: true, attempt }]);
  });

  it("gives two tries two names", async () => {
    const desktop = await importFresh();
    const first = await startAttempt(desktop);
    const second = await startAttempt(desktop);
    expect(first.attempt).not.toBe(second.attempt);
  });

  it("says the browser could not be opened, under the name of the try that never began", async () => {
    invoke.mockRejectedValueOnce(new Error("os refused"));
    const desktop = await importFresh();
    await desktop.startDesktopSignIn();
    expect(reportsFor("start")).toEqual([
      { ok: false, reason: "open_failed", attempt: expect.stringMatching(ID) },
    ]);
  });

  it("reports nothing when sign-in is refused off the desktop shell", async () => {
    platformMock.name = "web";
    const desktop = await importFresh();
    await desktop.startDesktopSignIn();
    expect(reportAuthStep).not.toHaveBeenCalled();
  });
});

describe("a callback reports how it ended", () => {
  /** One report, for the callback step, saying exactly this: a word, the try, and how long it took. */
  const expectOneCallbackReport = (detail: Record<string, unknown>) => {
    expect(reportsFor("callback")).toEqual([detail]);
  };

  it("says no try was pending when none was", async () => {
    const desktop = await importFresh();
    await desktop.handleDeepLinkCallback(callbackUrl("whatever-state"));
    expectOneCallbackReport({ ok: false, reason: "no_attempt" });
  });

  it("says the link was not a sign-in link", async () => {
    const desktop = await importFresh();
    const { attempt } = await startAttempt(desktop);
    await desktop.handleDeepLinkCallback("https://evil.example/cb?code=x&state=y");
    expectOneCallbackReport({ ok: false, reason: "unrecognized", attempt, ms: expect.any(Number) });
  });

  it("says the link carried no code or state", async () => {
    const desktop = await importFresh();
    const { attempt } = await startAttempt(desktop);
    await desktop.handleDeepLinkCallback("artdaddy://auth/callback");
    expectOneCallbackReport({
      ok: false,
      reason: "missing_params",
      attempt,
      ms: expect.any(Number),
    });
  });

  it("says the state was not the pending try's, which is what pressing Log in twice looks like", async () => {
    const desktop = await importFresh();
    const first = await startAttempt(desktop);
    await startAttempt(desktop); // the person pressed the button again; only the LAST state wins
    await desktop.handleDeepLinkCallback(callbackUrl(first.state));
    expectOneCallbackReport({
      ok: false,
      reason: "state_mismatch",
      attempt: expect.stringMatching(ID),
      ms: expect.any(Number),
    });
  });

  it("reports the try the page says finished, not the newer one, when the link carries its name", async () => {
    const desktop = await importFresh();
    const first = await startAttempt(desktop);
    const second = await startAttempt(desktop);
    await desktop.handleDeepLinkCallback(callbackUrl(first.state, `&attempt=${first.attempt}`));
    expectOneCallbackReport({
      ok: false,
      reason: "state_mismatch",
      attempt: first.attempt,
      ms: expect.any(Number),
    });
    expect(first.attempt).not.toBe(second.attempt);
  });

  it("ignores a name in the link that is not an id, and falls back to the pending try's", async () => {
    const desktop = await importFresh();
    const { attempt } = await startAttempt(desktop);
    await desktop.handleDeepLinkCallback(callbackUrl("wrong-state", "&attempt=<script>x</script>"));
    expect(reportsFor("callback")[0]).toMatchObject({ reason: "state_mismatch", attempt });
  });

  it("says the server could not be reached", async () => {
    const desktop = await importFresh();
    const { state, attempt } = await startAttempt(desktop);
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await desktop.handleDeepLinkCallback(callbackUrl(state));
    expectOneCallbackReport({
      ok: false,
      reason: "exchange_network",
      attempt,
      ms: expect.any(Number),
    });
  });

  it.each([
    [400, "exchange_rejected"],
    [401, "exchange_rejected"],
    [410, "exchange_rejected"],
    [500, "exchange_server"],
    [503, "exchange_server"],
  ])("says what the server's %i answer to the code was", async (status, reason) => {
    const desktop = await importFresh();
    const { state } = await startAttempt(desktop);
    fetchMock.mockResolvedValue(reply(status));
    await desktop.handleDeepLinkCallback(callbackUrl(state));
    expect(reportsFor("callback")).toEqual([
      { ok: false, reason, attempt: expect.stringMatching(ID), ms: expect.any(Number) },
    ]);
  });

  it("says the server's reply could not be read", async () => {
    const desktop = await importFresh();
    const { state } = await startAttempt(desktop);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    });
    await desktop.handleDeepLinkCallback(callbackUrl(state));
    expect(reportsFor("callback")[0]).toMatchObject({ ok: false, reason: "exchange_unreadable" });
  });

  it("says the sign-in was cancelled when the person signed out while the code was being traded", async () => {
    const desktop = await importFresh();
    const { state } = await startAttempt(desktop);
    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    fetchMock.mockImplementation((url: string) =>
      url.endsWith("/auth/desktop/token") ? gate : Promise.resolve(reply(200)),
    );
    const running = desktop.handleDeepLinkCallback(callbackUrl(state));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await desktop.signOutDesktop();
    release(reply(200, TOKENS));
    const result = await running;
    expect(result.ok).toBe(false);
    expect(reportsFor("callback")[0]).toMatchObject({ ok: false, reason: "cancelled" });
  });

  it("says the session could not be saved when the keychain refused it", async () => {
    const desktop = await importFresh();
    const { state } = await startAttempt(desktop);
    invoke.mockImplementation(async (command: string) => {
      if (command === "store_refresh_token") throw new Error("keychain write failed");
      return undefined;
    });
    fetchMock.mockResolvedValue(reply(200, TOKENS));
    await desktop.handleDeepLinkCallback(callbackUrl(state));
    expect(reportsFor("callback")[0]).toMatchObject({ ok: false, reason: "not_saved" });
  });

  it("says something unexpected happened, without saying what", async () => {
    const desktop = await importFresh();
    const { state } = await startAttempt(desktop);
    invoke.mockImplementation((command: string) => {
      if (command === "store_refresh_token") throw new Error("path C:\\Users\\someone\\secret");
      return Promise.resolve(undefined);
    });
    fetchMock.mockResolvedValue(reply(200, TOKENS));
    const result = await desktop.handleDeepLinkCallback(callbackUrl(state));
    expect(result.ok).toBe(false);
    expect(reportsFor("callback")).toEqual([{ ok: false, reason: "error" }]);
    expect(JSON.stringify(reportAuthStep.mock.calls)).not.toContain("someone");
  });

  it("says it worked, once, under the try's name and how long the person took", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
    const desktop = await importFresh();
    const { state, attempt } = await startAttempt(desktop);
    vi.setSystemTime(new Date("2026-11-02T10:00:41Z"));
    fetchMock.mockResolvedValue(reply(200, TOKENS));
    const result = await desktop.handleDeepLinkCallback(callbackUrl(state));
    expect(result.ok).toBe(true);
    expectOneCallbackReport({ ok: true, attempt, ms: 41_000 });
  });

  it("reports exactly once per callback whatever the outcome, and never a second time for a replay", async () => {
    const desktop = await importFresh();
    const { state } = await startAttempt(desktop);
    fetchMock.mockResolvedValue(reply(200, TOKENS));
    await desktop.handleDeepLinkCallback(callbackUrl(state));
    await desktop.handleDeepLinkCallback(callbackUrl(state)); // the same link again: nothing is pending now
    expect(reportsFor("callback").map((detail) => (detail as { reason?: string }).reason)).toEqual([
      undefined,
      "no_attempt",
    ]);
  });
});

describe("a saved session that cannot be renewed reports why", () => {
  const stored = (token: string | null = "stored-rt") =>
    invoke.mockImplementation(async (command: string) =>
      command === "load_refresh_token" ? token : undefined,
    );

  it("says the server turned it down, and that is the one case the session is cleared", async () => {
    stored();
    fetchMock.mockResolvedValue(reply(401));
    const desktop = await importFresh();
    expect(await desktop.refreshDesktopSession()).toEqual({
      status: "invalid",
      hasStoredSession: false,
    });
    expect(reportsFor("refresh")).toEqual([{ ok: false, reason: "rejected" }]);
  });

  it.each([
    [500, "server_error"],
    [502, "server_error"],
    [503, "server_error"],
  ])("says the server failed it (%i) without clearing anything", async (status, reason) => {
    stored();
    fetchMock.mockResolvedValue(reply(status));
    const desktop = await importFresh();
    expect((await desktop.refreshDesktopSession()).status).toBe("unavailable");
    expect(reportsFor("refresh")).toEqual([{ ok: false, reason }]);
    expect(invoke).not.toHaveBeenCalledWith("clear_refresh_token", undefined);
  });

  it("says the connection never held", async () => {
    stored();
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const desktop = await importFresh();
    await desktop.refreshDesktopSession();
    expect(reportsFor("refresh")).toEqual([{ ok: false, reason: "network" }]);
  });

  it("says the allowance ran out, which is a different thing from the connection failing", async () => {
    stored();
    fetchMock.mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const desktop = await importFresh();
    await desktop.refreshDesktopSession();
    expect(reportsFor("refresh")).toEqual([{ ok: false, reason: "timeout" }]);
  });

  it("says the keychain would not answer, before any saved token was read", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "load_refresh_token") throw new Error("keychain unavailable");
      return undefined;
    });
    const desktop = await importFresh();
    expect((await desktop.refreshDesktopSession()).status).toBe("unavailable");
    expect(reportsFor("refresh")).toEqual([{ ok: false, reason: "keychain" }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says the new session could not be saved", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "load_refresh_token") return "stored-rt";
      if (command === "store_refresh_token") throw new Error("keychain write failed");
      return undefined;
    });
    fetchMock.mockResolvedValue(reply(200, TOKENS));
    const desktop = await importFresh();
    await desktop.refreshDesktopSession();
    expect(reportsFor("refresh")).toEqual([{ ok: false, reason: "not_saved" }]);
  });

  it("says a reply it could not read as an error, not as a server failure", async () => {
    stored();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    });
    const desktop = await importFresh();
    await desktop.refreshDesktopSession();
    expect(reportsFor("refresh")).toEqual([{ ok: false, reason: "error" }]);
  });

  it("reports nothing when it works, or when there is nothing saved", async () => {
    stored();
    fetchMock.mockResolvedValue(reply(200, TOKENS));
    let desktop = await importFresh();
    expect((await desktop.refreshDesktopSession()).status).toBe("refreshed");

    invoke.mockReset();
    invoke.mockResolvedValue(null);
    desktop = await importFresh();
    expect((await desktop.refreshDesktopSession()).status).toBe("missing");
    expect(reportAuthStep).not.toHaveBeenCalled();
  });

  // The renewal is in flight when the person signs out, so whatever it then finds no longer matters: it is not a
  // failure of anything, and reporting it would count a sign-out as an outage. Every way it can end afterwards.
  it.each([
    ["a server error", (gate: Gate) => gate.resolve(reply(503))],
    ["a refusal of the saved session", (gate: Gate) => gate.resolve(reply(401))],
    [
      "a reply it cannot read",
      (gate: Gate) =>
        gate.resolve({
          ok: true,
          status: 200,
          json: async () => Promise.reject(new SyntaxError("x")),
        }),
    ],
    ["a new session it could not save", (gate: Gate) => gate.resolve(reply(200, TOKENS))],
    ["the connection failing", (gate: Gate) => gate.reject(new TypeError("Failed to fetch"))],
    [
      "the allowance running out",
      (gate: Gate) => gate.reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
    ],
  ])(
    "reports nothing when a sign-out overtakes a renewal that then meets %s",
    async (_name, settle) => {
      stored();
      const gate = {} as Gate;
      const pending = new Promise((resolve, reject) => {
        gate.resolve = resolve;
        gate.reject = reject;
      });
      // Only the renewal waits: signing out also calls fetch (to revoke the saved token) and must not.
      fetchMock.mockImplementation((url: string) =>
        url.endsWith("/auth/desktop/refresh") ? pending : Promise.resolve(reply(200)),
      );
      const desktop = await importFresh();
      const refreshing = desktop.refreshDesktopSession();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      await desktop.signOutDesktop();
      settle(gate);
      expect((await refreshing).status).toBe("superseded");
      expect(reportsFor("refresh")).toEqual([]);
    },
  );

  it("remembers that this machine has signed in before, whoever's session the renewal was", async () => {
    stored();
    fetchMock.mockResolvedValue(reply(200, TOKENS));
    const desktop = await importFresh();
    expect(localStorage.getItem("artdaddy.signed_in_before")).toBeNull();
    await desktop.refreshDesktopSession();
    expect(localStorage.getItem("artdaddy.signed_in_before")).toBe("1");
  });
});

describe("signing out", () => {
  it("forgets this install's id, so the next person at the machine does not inherit it", async () => {
    const { getInstallId } = await import("./authEvents");
    const before = getInstallId();
    expect(before).toMatch(ID);
    expect(getInstallId()).toBe(before);
    invoke.mockResolvedValue(null);
    const desktop = await importFresh();
    await desktop.signOutDesktop();
    expect(localStorage.getItem("artdaddy.install_id")).toBeNull();
    expect(getInstallId()).not.toBe(before);
  });

  it("keeps the fact that this machine has signed in before, which is not an identity", async () => {
    localStorage.setItem("artdaddy.signed_in_before", "1");
    invoke.mockResolvedValue(null);
    const desktop = await importFresh();
    await desktop.signOutDesktop();
    expect(localStorage.getItem("artdaddy.signed_in_before")).toBe("1");
  });
});
