import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

// usage.ts keeps a module-level singleton (the mirrored credit balance). Reset
// the module registry before each test so every test sees a fresh, empty store.
type UsageModule = typeof import("./usage");

async function load(): Promise<UsageModule> {
  vi.resetModules();
  return import("./usage");
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getUsage", () => {
  it("starts unmetered and empty", async () => {
    const { getUsage } = await load();
    expect(getUsage()).toEqual({ metered: false, used: 0, limit: 0, remaining: 0, over: false });
  });
});

describe("formatCredits", () => {
  it("never rounds a positive balance to zero for display", async () => {
    const { formatCredits } = await load();
    fc.assert(
      fc.property(
        fc.double({ min: Number.MIN_VALUE, max: 1, noNaN: true, noDefaultInfinity: true }),
        (remaining) => {
          expect(Number(formatCredits(remaining))).toBeGreaterThan(0);
        },
      ),
    );
  });
});

describe("subscribeUsage", () => {
  it("notifies subscribers on a real change and stops after unsubscribe", async () => {
    const { subscribeUsage, markOverLimit, getUsage } = await load();
    const fn = vi.fn();
    const off = subscribeUsage(fn);

    markOverLimit({ used: 5, limit: 10 }); // changes state -> fires
    expect(fn).toHaveBeenCalledTimes(1);
    expect(getUsage().over).toBe(true);

    off();
    markOverLimit({ used: 6, limit: 10 }); // still changes state, but we're off
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not notify when nothing actually changed", async () => {
    const { subscribeUsage, markOverLimit } = await load();
    markOverLimit({ used: 5, limit: 10 });
    const fn = vi.fn();
    subscribeUsage(fn);
    markOverLimit({ used: 5, limit: 10 }); // identical -> no-op, no notify
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("markOverLimit", () => {
  it("keeps remaining credit when only this request's reservation is unaffordable", async () => {
    const { markOverLimit, getUsage } = await load();
    markOverLimit({ used: 99, limit: 100, remaining: 1, requested: 3, scope: "user" });
    expect(getUsage()).toEqual({ metered: true, used: 99, limit: 100, remaining: 1, over: false });
  });

  it("does not turn the global pause into an affordable account refusal", async () => {
    const { markOverLimit, getUsage } = await load();
    markOverLimit({ used: 12, limit: 100, remaining: 88, requested: 90, scope: "global" });
    expect(getUsage().over).toBe(true);
  });

  it.each([
    { used: 100, limit: 100, remaining: 0, requested: 3, scope: "user" },
    { used: 99, limit: 100, remaining: 0, requested: 3, scope: "user" },
    { used: 99, limit: 100, remaining: -1, requested: 3, scope: "user" },
    { used: 99, limit: 100, requested: 3, scope: "user" },
    { used: 99, limit: 100, remaining: 1, requested: 3 },
    { used: 99, limit: 100, remaining: 1, requested: 3, scope: "unknown" },
    { used: 99, limit: 100, remaining: 2, requested: 3, scope: "user" },
    { used: 99, limit: 100, remaining: 1, requested: 1, scope: "user" },
    { used: 99, limit: 100, remaining: 1, requested: Infinity, scope: "user" },
    { used: 99, limit: 100, remaining: "1", requested: 3, scope: "user" },
    { used: -1, limit: 100, remaining: 1, requested: 3, scope: "user" },
    { used: 99, limit: NaN, remaining: 1, requested: 3, scope: "user" },
  ])("keeps ambiguous or exhausted refusals blocking: %j", async (detail) => {
    const { markOverLimit, getUsage, CreditLimitError } = await load();
    const { isOutOfCredits, CREDIT_LIMIT } = await import("../lib/outOfCredits");
    markOverLimit(detail);
    expect(getUsage()).toMatchObject({ over: true, remaining: 0 });
    const error = new CreditLimitError(detail);
    expect(error.code).toBe(CREDIT_LIMIT);
    expect(isOutOfCredits(error.message)).toBe(true);
  });

  it("preserves valid headroom across fractional balances and reservation sizes", async () => {
    const { markOverLimit, getUsage, CreditLimitError } = await load();
    const { isOutOfCredits } = await import("../lib/outOfCredits");
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (usedUnits, remainingUnits, excessUnits) => {
          const used = usedUnits / 1000;
          const limit = (usedUnits + remainingUnits) / 1000;
          const remaining = limit - used;
          const requested = remaining + excessUnits / 1000;
          const detail = { used, limit, remaining, requested, scope: "user" };
          markOverLimit(detail);
          expect(getUsage()).toEqual({ metered: true, used, limit, remaining, over: false });
          const error = new CreditLimitError(detail);
          expect(isOutOfCredits(error.message)).toBe(false);
          expect(error.userMessage).not.toMatch(/(?:^|\s)0 credits remain/);
        },
      ),
    );
  });

  it("clears a prior exhausted mirror and can still be cleared on sign-out", async () => {
    const { markOverLimit, clearUsage, getUsage } = await load();
    markOverLimit({ used: 100, limit: 100 });
    markOverLimit({ used: 99, limit: 100, remaining: 1, requested: 3, scope: "user" });
    expect(getUsage()).toMatchObject({ over: false, remaining: 1 });
    clearUsage();
    expect(getUsage()).toEqual({ metered: false, used: 0, limit: 0, remaining: 0, over: false });
  });

  it("applies the detail's used/limit and flags over", async () => {
    const { markOverLimit, getUsage } = await load();
    markOverLimit({ used: 7, limit: 12 });
    expect(getUsage()).toEqual({ metered: true, used: 7, limit: 12, remaining: 0, over: true });
  });

  it("falls back to the current used/limit when the detail isn't an object", async () => {
    const { markOverLimit, getUsage } = await load();
    markOverLimit("boom");
    expect(getUsage()).toEqual({ metered: true, used: 0, limit: 0, remaining: 0, over: true });
  });
});

it("does not exhaust a fresh account when its first request is too expensive", async () => {
  const { markOverLimit, getUsage, CreditLimitError } = await load();
  const detail = { used: 0, limit: 1, remaining: 1, requested: 3, scope: "user" };
  markOverLimit(detail);
  expect(getUsage()).toEqual({ metered: true, used: 0, limit: 1, remaining: 1, over: false });
  expect(new CreditLimitError(detail).code).toBe("credit_request_unaffordable");
});

describe("refreshUsage", () => {
  it("reflects a metered balance and hits GET /usage", async () => {
    const { refreshUsage, getUsage } = await load();
    const f = vi.fn(async () => jsonResponse({ metered: true, used: 3, limit: 10, remaining: 7 }));
    vi.stubGlobal("fetch", f);

    await refreshUsage();
    expect(getUsage()).toEqual({ metered: true, used: 3, limit: 10, remaining: 7, over: false });
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain("/usage");
  });

  it("marks over when a metered balance has no remaining", async () => {
    const { refreshUsage, getUsage } = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ metered: true, used: 10, limit: 10, remaining: 0 })),
    );
    await refreshUsage();
    expect(getUsage().over).toBe(true);
  });

  it("defaults missing numeric fields to zero (and stays under limit)", async () => {
    const { refreshUsage, getUsage } = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ metered: true })),
    );
    await refreshUsage();
    expect(getUsage()).toEqual({ metered: true, used: 0, limit: 0, remaining: 0, over: false });
  });

  it("clears the over flag when the server reports unmetered", async () => {
    const { refreshUsage, markOverLimit, getUsage } = await load();
    markOverLimit({ used: 5, limit: 5 }); // over = true first
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ metered: false })),
    );
    await refreshUsage();
    expect(getUsage()).toMatchObject({ metered: false, over: false });
  });

  it("ignores a non-ok response", async () => {
    const { refreshUsage, getUsage } = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    await refreshUsage();
    expect(getUsage()).toEqual({ metered: false, used: 0, limit: 0, remaining: 0, over: false });
  });

  it("swallows network errors and keeps the last known balance", async () => {
    const { refreshUsage, markOverLimit, getUsage } = await load();
    markOverLimit({ used: 2, limit: 10 });
    const before = getUsage();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await refreshUsage();
    expect(getUsage()).toEqual(before);
  });
});

describe("CreditLimitError", () => {
  it("describes an unaffordable request without saying all paid work is blocked", async () => {
    const { CreditLimitError } = await load();
    const { isOutOfCredits } = await import("../lib/outOfCredits");
    const { isExpected } = await import("../lib/errors");
    const err = new CreditLimitError({
      used: 99,
      limit: 100,
      remaining: 1,
      requested: 3,
      scope: "user",
    });
    expect(err.userMessage).toMatch(/3.*credits.*1.*remain/i);
    expect(err.code).toBe("credit_request_unaffordable");
    expect(isOutOfCredits(err.message)).toBe(false);
    expect(err.message).not.toMatch(/no paid call can succeed|they are out of credits/i);
    expect(err.message).toMatch(/not submitted|not charged/i);
    expect(err.message).toMatch(/ask.*user|user.*approv/i);
    expect(err.message).toMatch(/other work.*not blocked/i);
    expect(err.message.startsWith("This request needs up to ")).toBe(true);
    expect(isExpected(err)).toBe(true);
  });

  it.each([null, { used: 99, limit: 100, remaining: 1, requested: 3, scope: "user" }])(
    "preserves caller context rather than hiding what was refused: %j",
    async (detail) => {
      const { CreditLimitError } = await load();
      const error = new CreditLimitError(detail, "The requested image was not submitted");
      expect(error.message).toContain("The requested image was not submitted");
    },
  );

  it("does not display a positive sub-cent remainder as zero", async () => {
    const { CreditLimitError } = await load();
    const err = new CreditLimitError({
      used: 99.999,
      limit: 100,
      remaining: 100 - 99.999,
      requested: 3,
      scope: "user",
    });
    expect(err.userMessage).toContain("0.001 credits remain");
    expect(err.code).toBe("credit_request_unaffordable");
  });

  it("uses singular credit for a one-credit remainder", async () => {
    const { CreditLimitError } = await load();
    const error = new CreditLimitError({
      used: 99,
      limit: 100,
      remaining: 1,
      requested: 3,
      scope: "user",
    });
    expect(error.userMessage).toContain("1 credit remains");
  });

  it("uses singular credit for a one-credit request", async () => {
    const { CreditLimitError } = await load();
    const error = new CreditLimitError({
      used: 99.5,
      limit: 100,
      remaining: 0.5,
      requested: 1,
      scope: "user",
    });
    expect(error.userMessage).toContain("needs up to 1 credit;");
  });

  it("does not make an unaffordable request appear to fit after display rounding", async () => {
    const { CreditLimitError } = await load();
    const error = new CreditLimitError({
      used: 0.0000002,
      limit: 1,
      remaining: 0.9999998,
      requested: 1,
      scope: "user",
    });
    expect(error.userMessage).toContain("0.9999998 credits remain");
    expect(error.userMessage).not.toContain("1 credit remains");
  });

  it("is an Error that carries the detail", async () => {
    const { CreditLimitError } = await load();
    const err = new CreditLimitError({ used: 1 });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CreditLimitError");
    expect(err.detail).toEqual({ used: 1 });
  });

  it("separates what the MODEL is told from what the user is shown", async () => {
    const { CreditLimitError } = await load();
    const err = new CreditLimitError(null);
    // `message` becomes the tool result. It has to stop the model, or it moves on to the next
    // paid tool, which cannot succeed either.
    expect(err.message).toMatch(/do not retry/i);
    expect(err.message).toMatch(/credit/i);
    // `userMessage` is a sentence for a person, not an instruction aimed at a model.
    expect(err.userMessage).toMatch(/out of credits/i);
    expect(err.userMessage).not.toMatch(/do not retry/i);
  });

  // Free credits are one-time. "It resets at the start of your next window" sent people to wait
  // for a refill that will never come.
  it("never promises the credits come back on their own", async () => {
    const { CreditLimitError } = await load();
    for (const err of [new CreditLimitError(null), new CreditLimitError({ scope: "global" })]) {
      expect(err.userMessage).not.toMatch(/reset|renew|refill|next window|period/i);
      expect(err.message).not.toMatch(/reset|renew|refill|next window/i);
    }
  });

  // Over MCP this text is the only thing a person ever sees; a button exists only in our chat.
  it("names the Discord invite in the text an external agent receives", async () => {
    const { CreditLimitError } = await load();
    const { DISCORD_URL } = await import("../lib/community");
    expect(new CreditLimitError(null).message).toContain(DISCORD_URL);
    expect(new CreditLimitError({ scope: "global" }).message).toContain(DISCORD_URL);
  });

  // The kill-switch is everyone's budget. Telling this user THEIR credits are gone would be
  // false, and they would ask for credits they already have.
  it("does not tell someone their own credits are gone when the shared budget tripped", async () => {
    const { CreditLimitError } = await load();
    const shared = new CreditLimitError({ scope: "global", used: 12, limit: 500 });
    expect(shared.userMessage).toMatch(/everyone/i);
    expect(shared.message).not.toMatch(/they are out of credits/i);
    expect(new CreditLimitError({ scope: "user" }).userMessage).not.toMatch(/everyone/i);
  });
});

describe("request headroom through the real HTTP wrappers", () => {
  it.each(["generation", "plain round", "streamed round"])(
    "preserves the balance on %s",
    async (sender) => {
      const { getUsage, CreditLimitError } = await load();
      const detail = { used: 99, limit: 100, remaining: 1, requested: 3, scope: "user" };
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse({ detail }, 402)),
      );
      const response =
        sender === "generation"
          ? (await import("./ai")).callAiProxy("generate_image", { args: {} })
          : sender === "plain round"
            ? (await import("../agent/api")).inferRound({ round_input: { user_text: "hi" } })
            : (await import("../agent/api")).inferRoundStreaming(
                { round_input: { user_text: "hi" } },
                () => {},
              );
      const error = await response.catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(CreditLimitError);
      expect(error).toMatchObject({ code: "credit_request_unaffordable" });
      expect(getUsage()).toEqual({
        metered: true,
        used: 99,
        limit: 100,
        remaining: 1,
        over: false,
      });
    },
  );
});
