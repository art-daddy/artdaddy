// The credit readout can say how much of "used" is held for generations still running (UJ-047).
//
// A generation holds its estimated cost the moment it starts, so for minutes `used` includes credits that are not spent
// yet and come back if the generation fails. The server says how much (`held`); the strip's tooltip passes it on.
// `held` is ABSENT, never 0, when nothing is held: every other consumer of the readout sees exactly what it always did.
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

type UsageModule = typeof import("./usage");

async function load(): Promise<UsageModule> {
  vi.resetModules();
  return import("./usage");
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

const balance = (extra: Record<string, unknown> = {}) => ({
  metered: true,
  used: 96,
  limit: 150,
  remaining: 54,
  over: false,
  pause_scope: null,
  ...extra,
});

function serve(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => json(body)));
}

afterEach(() => vi.unstubAllGlobals());

describe("held credits in the readout", () => {
  it("carries what the server says is held for generations in progress", async () => {
    const { refreshUsage, getUsage } = await load();
    serve(balance({ held: 96 }));
    await refreshUsage();
    expect(getUsage()).toEqual({ metered: true, used: 96, limit: 150, remaining: 54, over: false, held: 96 });
  });

  it("is absent, not zero, when nothing is held or the server does not say", async () => {
    const { refreshUsage, getUsage } = await load();
    for (const body of [balance({ held: 0 }), balance()]) {
      serve(body);
      await refreshUsage();
      expect(getUsage()).toEqual({ metered: true, used: 96, limit: 150, remaining: 54, over: false });
      expect("held" in getUsage()).toBe(false);
    }
  });

  it.each([-5, "7", null, true, [], {}])("ignores a held that is not a positive number (%j)", async (held) => {
    const { refreshUsage, getUsage } = await load();
    serve(balance({ held }));
    await refreshUsage();
    expect("held" in getUsage()).toBe(false);
  });

  it("follows the server: a later refresh without a hold clears it", async () => {
    const { refreshUsage, getUsage } = await load();
    serve(balance({ held: 96 }));
    await refreshUsage();
    expect(getUsage().held).toBe(96);
    serve(balance({ used: 40, remaining: 110 }));
    await refreshUsage();
    expect(getUsage().held).toBeUndefined();
  });

  it("is forgotten with the account", async () => {
    const { refreshUsage, clearUsage, getUsage } = await load();
    serve(balance({ held: 96 }));
    await refreshUsage();
    clearUsage();
    expect("held" in getUsage()).toBe(false);
  });

  it("tells subscribers when only the held amount changed, and not when nothing did", async () => {
    const { refreshUsage, subscribeUsage } = await load();
    const listener = vi.fn();
    subscribeUsage(listener);
    serve(balance({ held: 96 }));
    await refreshUsage();
    expect(listener).toHaveBeenCalledTimes(1);
    await refreshUsage();
    expect(listener).toHaveBeenCalledTimes(1);
    serve(balance({ held: 30 }));
    await refreshUsage();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("is a positive finite number or absent, whatever the server sends", async () => {
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (held) => {
        const { refreshUsage, getUsage } = await load();
        serve(balance({ held }));
        await refreshUsage();
        const shown = getUsage().held;
        return shown === undefined || (Number.isFinite(shown) && shown > 0);
      }),
      { numRuns: 80 },
    );
  });
});

describe("creditsTitle", () => {
  it("is what it always was when nothing is held", async () => {
    const { creditsTitle } = await load();
    expect(creditsTitle({ used: 96, limit: 150 })).toBe("96 / 150 credits used");
    expect(creditsTitle({ used: 96, limit: 150, held: undefined })).toBe("96 / 150 credits used");
  });

  it("says how much of what is used is reserved for generations in progress", async () => {
    const { creditsTitle } = await load();
    expect(creditsTitle({ used: 96, limit: 150, held: 96 })).toBe(
      "96 / 150 credits used (96 reserved for generations in progress)",
    );
  });

  it("formats credits like the rest of the readout", async () => {
    const { creditsTitle } = await load();
    expect(creditsTitle({ used: 0.1 + 0.2, limit: 150, held: 0.1 + 0.2 })).toBe(
      "0.3 / 150 credits used (0.3 reserved for generations in progress)",
    );
  });

  it("says nothing about a hold that is zero or negative", async () => {
    const { creditsTitle } = await load();
    for (const held of [0, -3, NaN]) expect(creditsTitle({ used: 5, limit: 10, held })).toBe("5 / 10 credits used");
  });
});
