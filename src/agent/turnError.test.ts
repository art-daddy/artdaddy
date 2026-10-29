// A turn that ends in an error is reported by the code the person was shown and the id of the failed request. Typed
// rounds carry their own code; a thrown failure (a refusal, a busy answer, a timeout, a dropped connection) is mapped
// to one, and an error nobody recognised is "unexpected", never blank.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/appEvents", async (io) => ({
  ...(await io<typeof import("../api/appEvents")>()),
  reportTurnError: vi.fn(),
}));

import { reportTurnError } from "../api/appEvents";
import { RateLimitError, SessionExpiredError, SessionRenewalUnavailableError } from "../api/http";
import { CreditLimitError } from "../api/usage";
import { clearRecentFailures, recentFailures } from "../observability/recentFailures";
import { ClientUpdateRequiredError } from "../update/updater";
import { noteTurnError, requestIdOf, turnErrorCode } from "./turnError";

beforeEach(() => {
  clearRecentFailures();
  vi.mocked(reportTurnError).mockClear();
});
afterEach(() => clearRecentFailures());

describe("turnErrorCode", () => {
  const timeout = Object.assign(new Error("the model did not respond within 10 minutes"), { name: "RoundTimeoutError" });
  it.each([
    ["a busy answer that ran out of retries", new RateLimitError(), "rate_limited"],
    ["an expired session", new SessionExpiredError(), "session_expired"],
    ["a session that could not be renewed", new SessionRenewalUnavailableError(), "session_renewal_unavailable"],
    ["a build the server refuses", new ClientUpdateRequiredError(), "client_update_required"],
    ["the round deadline", timeout, "round_timeout"],
    ["an HTTP failure", new Error("503: upstream down"), "http_503"],
    ["a gateway failure with a body", new Error("502: <html>bad gateway</html>"), "http_502"],
    ["a dropped connection", new TypeError("Failed to fetch"), "network"],
    ["something nobody recognised", new Error("weird"), "unexpected"],
    ["a thrown string", "weird", "unexpected"],
    ["undefined", undefined, "unexpected"],
  ])("%s", (_name, error, code) => expect(turnErrorCode(error)).toBe(code));

  it("keeps the credit wall's own code", () => {
    expect(turnErrorCode(new CreditLimitError({ error: "credit_limit_reached" }))).toBe(new CreditLimitError({}).code);
  });
});

describe("requestIdOf", () => {
  it("reads the id a thrown failure carries, and nothing else", () => {
    expect(requestIdOf(Object.assign(new Error("x"), { requestId: "abc" }))).toBe("abc");
    expect(requestIdOf(new Error("x"))).toBeUndefined();
    expect(requestIdOf(Object.assign(new Error("x"), { requestId: 7 }))).toBeUndefined();
    expect(requestIdOf("abc")).toBeUndefined();
    expect(requestIdOf(null)).toBeUndefined();
  });
});

describe("noteTurnError", () => {
  it("notes the failure for a problem report and reports it as a turn_error", () => {
    noteTurnError("content_policy", "rid1");
    expect(recentFailures()).toMatchObject([{ where: "turn", code: "content_policy", requestId: "rid1" }]);
    expect(reportTurnError).toHaveBeenCalledWith("content_policy", "rid1");
  });

  it("adds what it knows to a failure the HTTP layer already noted for the same request", () => {
    // The HTTP layer saw 429 and noted http_429; the turn knows the typed reason.
    clearRecentFailures();
    noteTurnError("http_429", "rid2");
    noteTurnError("account_busy", "rid2");
    expect(recentFailures()).toMatchObject([{ code: "account_busy", requestId: "rid2" }]);
  });
});
