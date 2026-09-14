import { describe, it, expect } from "vitest";

import { ArtDaddyError, isExpected, toUserMessage } from "./errors";
import { ApiError } from "../api/client";
import { RateLimitError } from "../api/http";
import { CreditLimitError } from "../api/usage";
import { OpError } from "../timeline/errors";
import {
  ProjectClosingError,
  MutationConflictError,
  MutationAbortedError,
} from "../project/MutationGate";

// The whole point of the base class is that "expected" lives WITH each error, so this
// table IS the contract: flipping a flag or a code in a definition fails here.
const expectedTrue = [
  new RateLimitError(),
  new CreditLimitError({ used: 1 }),
  new ProjectClosingError(),
  new MutationConflictError(),
  new MutationAbortedError(),
];
const expectedFalse = [new ApiError(500, "boom"), new OpError("nope")];

describe("ArtDaddyError family", () => {
  it("every typed error is an Error AND an ArtDaddyError, and keeps its own type", () => {
    for (const e of [...expectedTrue, ...expectedFalse]) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(ArtDaddyError);
      expect(typeof e.code).toBe("string");
      expect(e.code.length).toBeGreaterThan(0);
    }
  });

  it("preserves each subclass's public shape after re-parenting", () => {
    const api = new ApiError(404, "missing");
    expect(api).toBeInstanceOf(ApiError);
    expect(api.status).toBe(404);
    expect(api.name).toBe("ApiError");
    expect(api.message).toBe("missing");

    const credit = new CreditLimitError({ limit: 10 });
    expect(credit.detail).toEqual({ limit: 10 });

    expect(new ProjectClosingError().kind).toBe("closing");
    expect(new MutationConflictError().kind).toBe("conflict");
    expect(new MutationAbortedError().kind).toBe("cancelled");
  });

  it("codes are stable + distinct", () => {
    const codes = [...expectedTrue, ...expectedFalse].map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(new RateLimitError().code).toBe("rate_limited");
    expect(new CreditLimitError(null).code).toBe("credit_limit");
  });
});

describe("isExpected", () => {
  it("is true for handled control-flow errors", () => {
    for (const e of expectedTrue) expect(isExpected(e)).toBe(true);
  });

  it("is false for real faults and non-errors", () => {
    for (const e of expectedFalse) expect(isExpected(e)).toBe(false);
    expect(isExpected(new Error("plain"))).toBe(false);
    expect(isExpected("a string")).toBe(false);
    expect(isExpected(undefined)).toBe(false);
    expect(isExpected(null)).toBe(false);
  });

  it("narrows the type so a boundary can read .message", () => {
    const e: unknown = new RateLimitError("busy");
    // Compiles only because isExpected is a type guard (err is ArtDaddyError).
    if (isExpected(e)) expect(e.message).toBe("busy");
    else throw new Error("expected the guard to pass");
  });
});

describe("toUserMessage", () => {
  it("returns a typed error's own user-facing message", () => {
    expect(toUserMessage(new RateLimitError("slow down"))).toBe("slow down");
    expect(toUserMessage(new CreditLimitError(null))).toMatch(/credit limit/i);
  });

  it("maps ApiError by STATUS and never leaks the raw server detail", () => {
    expect(toUserMessage(new ApiError(401, "unauthorized"))).toMatch(/sign in/i);
    expect(toUserMessage(new ApiError(403, "forbidden"))).toMatch(/access/i);
    expect(toUserMessage(new ApiError(404, "not found"))).toMatch(/find/i);
    expect(toUserMessage(new ApiError(503, "upstream connect error"))).toMatch(/try again/i);
    // Adversarial: a raw 500 detail (could be a stack) must NOT reach the user.
    expect(toUserMessage(new ApiError(500, "TRACEBACK secret.py line 42"))).not.toContain(
      "TRACEBACK",
    );
  });

  it("maps a fetch/network failure to a connectivity line", () => {
    expect(toUserMessage(new TypeError("Failed to fetch"))).toMatch(/reach the server/i);
    expect(toUserMessage(new TypeError("NetworkError when attempting to fetch"))).toMatch(
      /reach the server/i,
    );
  });

  it("falls back to a generic apology WITHOUT echoing the raw error", () => {
    const msg = toUserMessage(new Error("kaboom at 0xdeadbeef"));
    expect(msg).not.toContain("kaboom");
    expect(msg).toBe("Something went wrong. Please try again.");
    expect(toUserMessage("a bare string")).toBe("Something went wrong. Please try again.");
    expect(toUserMessage(undefined)).toBe("Something went wrong. Please try again.");
    expect(toUserMessage(null)).toBe("Something went wrong. Please try again.");
  });
});
