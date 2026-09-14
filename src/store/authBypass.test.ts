// The dev/e2e bypass is a build-time flag, and it used to be read in AuthProvider alone -- so the
// UI opened while the MCP bridge, which asks isSignedOutGate(), still refused every call. An agent
// then faced a sign-in refusal from an app that was visibly signed in. The rule has one owner, so
// the bypass has to live with it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const gateWith = async (bypass: string | undefined) => {
  if (bypass === undefined) vi.stubEnv("VITE_E2E_AUTH_BYPASS", "");
  else vi.stubEnv("VITE_E2E_AUTH_BYPASS", bypass);
  return import("./auth");
};

describe("the e2e auth bypass", () => {
  it("opens the gate for a locked session when set", async () => {
    const { isSignedOutGate, authBypassed } = await gateWith("1");
    expect(authBypassed()).toBe(true);
    expect(isSignedOutGate({ status: "locked", hasStoredSession: false })).toBe(false);
    // Offline with no stored session is the other way in.
    expect(isSignedOutGate({ status: "offline", hasStoredSession: false })).toBe(false);
  });

  it("changes nothing when unset -- the gate still closes", async () => {
    const { isSignedOutGate, authBypassed } = await gateWith(undefined);
    expect(authBypassed()).toBe(false);
    expect(isSignedOutGate({ status: "locked", hasStoredSession: false })).toBe(true);
    expect(isSignedOutGate({ status: "offline", hasStoredSession: false })).toBe(true);
    expect(isSignedOutGate({ status: "unlocked", hasStoredSession: true })).toBe(false);
  });

  it("only accepts exactly '1', so a stray value cannot disable the gate", async () => {
    for (const v of ["0", "true", "yes", "", " 1"]) {
      const { authBypassed } = await gateWith(v);
      expect(authBypassed(), v).toBe(false);
      vi.resetModules();
    }
  });
});
