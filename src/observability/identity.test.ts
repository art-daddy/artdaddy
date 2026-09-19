// Every log must name a person and a machine.
//
// Two failures made this necessary. Sentry identified users by a hash, so a report could never
// be tied to the tester who filed it — the D:-drive crash sat in the dashboard for three days
// as an anonymous id. And `platform.name` is the SHELL ("tauri"), not the OS, so every event
// described a machine we could not identify as Windows, macOS or Linux.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { osFromUserAgent } from "../platform/host";

describe("osFromUserAgent", () => {
  // A table, walked — hand-checking one member is evidence about that member only.
  const cases: [string, string][] = [
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153 Safari/537.36 Edg/153",
      "windows",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17 Safari/605.1.15",
      "macos",
    ],
    ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36", "linux"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", "macos"],
    ["", "unknown"],
  ];

  it.each(cases)("reads %s as %s", (ua, expected) => {
    expect(osFromUserAgent(ua)).toBe(expected);
  });

  it("never reports the shell name", () => {
    // The bug this replaces: every export and every error said "tauri", which is true of
    // Windows, macOS and Linux alike and therefore says nothing.
    for (const [ua] of cases) expect(osFromUserAgent(ua)).not.toBe("tauri");
  });
});

describe("identifyUser", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function load() {
    const setUser = vi.fn();
    vi.doMock("@sentry/react", () => ({
      init: vi.fn(),
      setUser,
      setTag: vi.fn(),
      captureException: vi.fn(),
    }));
    const mod = await import("./sentry");
    return { mod, setUser };
  }

  it("does nothing at all when Sentry is off", async () => {
    // A no-op build must never touch the SDK; local dev and the test suite both run this way.
    const { mod, setUser } = await load();
    mod.identifyUser("user_123", "a@b.co");
    expect(setUser).not.toHaveBeenCalled();
  });

  it("names the person, not a hash, once enabled", async () => {
    const { mod, setUser } = await load();
    vi.stubEnv("VITE_SENTRY_DSN", "https://key@o1.ingest.sentry.io/2");
    vi.stubEnv("DEV", false);
    expect(mod.initSentry()).toBe(true);

    mod.identifyUser("user_3JQ", "hamza@example.com");
    expect(setUser).toHaveBeenCalledWith({ id: "user_3JQ", email: "hamza@example.com" });
    vi.unstubAllEnvs();
  });

  it("clears the user on sign-out rather than leaving the last one attached", async () => {
    // The failure direction: a stale identity would file the NEXT person's errors under the
    // previous one, which is worse than no identity at all.
    const { mod, setUser } = await load();
    vi.stubEnv("VITE_SENTRY_DSN", "https://key@o1.ingest.sentry.io/2");
    vi.stubEnv("DEV", false);
    mod.initSentry();

    mod.identifyUser(null);
    expect(setUser).toHaveBeenCalledWith(null);
    vi.unstubAllEnvs();
  });

  it("still reports the id when the email is not known yet", async () => {
    // A token minted before the server carried the claim has no email; an id alone is still
    // enough to count people and to look one up.
    const { mod, setUser } = await load();
    vi.stubEnv("VITE_SENTRY_DSN", "https://key@o1.ingest.sentry.io/2");
    vi.stubEnv("DEV", false);
    mod.initSentry();

    mod.identifyUser("user_x", null);
    expect(setUser).toHaveBeenCalledWith({ id: "user_x" });
    vi.unstubAllEnvs();
  });
});
