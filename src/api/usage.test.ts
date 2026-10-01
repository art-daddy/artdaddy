import { afterEach, describe, expect, it, vi } from "vitest";

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
