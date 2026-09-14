// The invariant: every request goes to the CURRENTLY configured server, read at
// call time. A stale snapshot is the whole failure mode here — the app would keep
// talking to the old backend while the UI showed the new one.
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("api base configuration", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  async function load() {
    return import("./config");
  }

  it("falls back to the build default with nothing stored", async () => {
    const { apiBase, defaultApiBase, isApiBaseOverridden } = await load();
    expect(apiBase()).toBe(defaultApiBase());
    expect(isApiBaseOverridden()).toBe(false);
    expect(apiBase().endsWith("/")).toBe(false);
  });

  it("a stored override survives a restart", async () => {
    localStorage.setItem("artdaddy.api_base", "https://alpha.example.com");
    const { apiBase, isApiBaseOverridden } = await load();
    expect(apiBase()).toBe("https://alpha.example.com");
    expect(isApiBaseOverridden()).toBe(true);
  });

  it("takes effect immediately, without a reload", async () => {
    const { apiBase, setApiBase } = await load();
    const before = apiBase();
    setApiBase("https://new.example.com");
    expect(apiBase()).toBe("https://new.example.com");
    expect(apiBase()).not.toBe(before);
  });

  it("strips trailing slashes so paths can't double up", async () => {
    const { apiBase, setApiBase } = await load();
    setApiBase("https://alpha.example.com///");
    expect(apiBase()).toBe("https://alpha.example.com");
    expect(`${apiBase()}/health`).toBe("https://alpha.example.com/health");
  });

  it("reset returns to the build default and forgets the override", async () => {
    const { apiBase, defaultApiBase, isApiBaseOverridden, setApiBase } = await load();
    setApiBase("https://alpha.example.com");
    setApiBase(null);
    expect(apiBase()).toBe(defaultApiBase());
    expect(isApiBaseOverridden()).toBe(false);
    expect(localStorage.getItem("artdaddy.api_base")).toBeNull();
  });

  it.each([
    ["", "empty"],
    ["   ", "whitespace"],
    ["alpha.example.com", "no scheme"],
    ["ftp://alpha.example.com", "wrong scheme"],
    ["javascript:alert(1)", "script url"],
    ["not a url at all", "garbage"],
  ])("rejects %s (%s) instead of storing it", async (bad) => {
    const { apiBase, setApiBase } = await load();
    const before = apiBase();
    expect(() => setApiBase(bad)).toThrow();
    expect(apiBase()).toBe(before); // a rejected value must not be applied
  });

  it("notifies subscribers only when the server actually changes", async () => {
    const { setApiBase, onApiBaseChange } = await load();
    const seen: string[] = [];
    onApiBaseChange((b) => seen.push(b));
    setApiBase("https://alpha.example.com");
    setApiBase("https://alpha.example.com/"); // normalises to the same origin
    expect(seen).toEqual(["https://alpha.example.com"]);
  });
});

describe("requests follow the configured server", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("a server change redirects the NEXT request", async () => {
    const { setApiBase } = await import("./config");
    const { api } = await import("./client");
    const fetchMock = vi.fn(async (_url: string) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    setApiBase("https://one.example.com");
    await api.health();
    setApiBase("https://two.example.com");
    await api.health();

    expect(fetchMock.mock.calls[0][0]).toBe("https://one.example.com/health");
    expect(fetchMock.mock.calls[1][0]).toBe("https://two.example.com/health");
    vi.unstubAllGlobals();
  });

  it("api.base and platform.apiBaseUrl are live, not import-time snapshots", async () => {
    const { setApiBase } = await import("./config");
    const { api } = await import("./client");
    const { platform } = await import("../platform");

    setApiBase("https://moved.example.com");
    expect(api.base).toBe("https://moved.example.com");
    expect(platform.apiBaseUrl).toBe("https://moved.example.com");
  });

  it("re-locks (notifies an auth failure) when the server changes", async () => {
    const { setApiBase } = await import("./config");
    const auth = await import("./auth");
    auth.setClerkTokenProvider(async () => "clerk-jwt");
    expect(await auth.authHeaders()).toHaveProperty("Authorization");

    const hit = vi.fn();
    const off = auth.onAuthFailure(hit);
    setApiBase("https://two.example.com");
    off();

    // A token minted for one server means nothing on another — the app must
    // re-verify against the new server rather than silently appearing signed in.
    expect(hit).toHaveBeenCalledOnce();
  });
});
