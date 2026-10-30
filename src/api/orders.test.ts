import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth", async (io) => {
  const actual = await io<typeof import("./auth")>();
  return { ...actual, notifyAuthFailure: vi.fn() };
});

import { notifyAuthFailure, setClerkTokenProvider } from "./auth";
import orderViews from "./__fixtures__/orderViews.json";
import { rateLimitConfig } from "./http";
import {
  __resetOrderPolling,
  acknowledgeAcceptedOrder,
  ackOrder,
  downloadOrderResult,
  getOrder,
  isAcceptedOrder,
  markOrderAccepted,
  newOrderId,
  OrderCollectedError,
  OrderExpiredError,
  OrderFailedError,
  OrderNotFoundError,
  OrderUnreachableError,
  OrderWaitSuspended,
  orderPolling,
  ORDER_ID,
  pollDelayMs,
  waitForOrder,
} from "./orders";
import { FakeOrderServer } from "../test/orderServer";

let server: FakeOrderServer;
let sleeps: number[];
const realTransientBackoff = rateLimitConfig.transientBackoffS;

beforeEach(() => {
  server = new FakeOrderServer();
  sleeps = [];
  orderPolling.sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  rateLimitConfig.transientBackoffS = 0.001;
  setClerkTokenProvider(async () => "tok");
  vi.stubGlobal("fetch", server.fetch);
});

afterEach(() => {
  __resetOrderPolling();
  rateLimitConfig.transientBackoffS = realTransientBackoff;
  setClerkTokenProvider(null);
  vi.unstubAllGlobals();
  vi.mocked(notifyAuthFailure).mockClear();
});

const ID = "0123456789abcdef0123456789abcdef";

describe("order numbers", () => {
  it("are always ones the server accepts, and never repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i += 1) {
      const id = newOrderId();
      expect(id).toMatch(ORDER_ID);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  it("still are when the platform has no random-UUID helper", () => {
    vi.stubGlobal("crypto", {});
    const ids = new Set(Array.from({ length: 50 }, () => newOrderId()));
    for (const id of ids) expect(id).toMatch(ORDER_ID);
    expect(ids.size).toBe(50);
  });

  it("are checked by the same rule the server uses", () => {
    for (const bad of ["", "short", "a".repeat(15), "a".repeat(65), "has space in it 123", "slash/in/the/middle1"])
      expect(ORDER_ID.test(bad)).toBe(false);
    for (const good of ["a".repeat(16), "a".repeat(64), "123e4567-e89b-12d3-a456-426614174000"])
      expect(ORDER_ID.test(good)).toBe(true);
  });
});

describe("how often an order is asked about", () => {
  it("is quick at first, never slower than ten seconds, and never speeds up again", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5000 }), (n) => {
        const d = pollDelayMs(n);
        expect(d).toBeGreaterThanOrEqual(1000);
        expect(d).toBeLessThanOrEqual(10_000);
        expect(pollDelayMs(n + 1)).toBeGreaterThanOrEqual(d);
      }),
    );
    expect(pollDelayMs(0)).toBeLessThanOrEqual(2000);
    expect(pollDelayMs(100_000)).toBe(10_000);
  });
});

describe("asking about an order", () => {
  it.each(["running", "ready", "failed", "collected", "expired"] as const)(
    "understands exactly what the server says of a %s order",
    async (state) => {
      server.behaviour.pollsUntilDone = 99; // asking must not be what moves it on
      server.seed(ID, "generate_image", state);
      const view = await getOrder(ID);
      const expected = JSON.parse(JSON.stringify(orderViews.views[state]));
      expected.order_id = ID;
      if (state === "ready") expected.result.url = `https://storage.test/results/${ID}.json`;
      if (state === "failed") expected.error = { retryable: false, ...server.behaviour.failure };
      expect(view).toEqual(expected);
    },
  );

  it("says so when the server has no such order", async () => {
    await expect(getOrder(ID)).rejects.toBeInstanceOf(OrderNotFoundError);
  });

  it("puts the number in the address safely", async () => {
    server.seed(ID, "generate_image", "running");
    await getOrder(ID);
    expect(server.calls).toEqual([`GET /orders/${ID}`]);
    await expect(getOrder("../../ai/generate_image")).rejects.toBeInstanceOf(OrderNotFoundError);
    expect(server.calls.at(-1)).toBe("GET /orders/..%2F..%2Fai%2Fgenerate_image");
  });

  it.each([401, 429, 500, 502, 503])("treats a %i as the server being out of reach, not as the order being gone", async (status) => {
    server.fault(/^GET \/orders/, 1, status);
    await expect(getOrder(ID)).rejects.toBeInstanceOf(OrderUnreachableError);
  });

  it("does not take an answer it cannot read for an order", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ order: { state: "teleporting" } })));
    await expect(getOrder(ID)).rejects.toThrow(/could not be understood/);
    vi.stubGlobal("fetch", async () => new Response("not json at all"));
    await expect(getOrder(ID)).rejects.toThrow(/could not be understood/);
  });

  it("does not take a ready order without its link or its charge, or a failed one without its reason", async () => {
    const stamps = { order_id: ID, created_at: 1, updated_at: 1 };
    const link = { url: "https://x.test/r", bytes: 1, content_type: "application/json", expires_at: 2 };
    for (const bad of [
      { ...stamps, state: "ready", charged_credits: 1 },
      { ...stamps, state: "ready", result: link },
      { ...stamps, state: "ready", result: { ...link, url: 5 }, charged_credits: 1 },
      { ...stamps, state: "collected" },
      { ...stamps, state: "expired" },
      { ...stamps, state: "failed" },
      { ...stamps, state: "failed", error: { code: "x" } },
      { order_id: 7, state: "running", created_at: 1, updated_at: 1 },
      { order_id: ID, state: "running", created_at: "1", updated_at: 1 },
    ]) {
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ order: bad })));
      await expect(getOrder(ID)).rejects.toThrow(/could not be understood/);
    }
  });

  it("fills in what a failed order leaves out, rather than refusing it", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ order: { order_id: ID, state: "failed", created_at: 1, updated_at: 1, error: { message: "No." } } })),
    );
    const view = await getOrder(ID);
    expect(view.error).toEqual({ code: "generation_failed", message: "No.", retryable: false });
  });
});

describe("waiting for an order", () => {
  it("asks until it is ready, at the pace it should, and gives the ready order back", async () => {
    server.behaviour.pollsUntilDone = 14;
    server.seed(ID, "generate_image", "running");
    const ready = await waitForOrder(ID);
    expect(ready.state).toBe("ready");
    expect(ready.result.url).toBe(`https://storage.test/results/${ID}.json`);
    expect(server.calls.filter((c) => c.startsWith("GET /orders"))).toHaveLength(14);
    expect(sleeps).toEqual(Array.from({ length: 13 }, (_, i) => pollDelayMs(i)));
    expect(new Set(sleeps).size).toBeGreaterThan(1); // the pace really does slow down as it goes on
  });

  it("returns at once for an order that is already ready, without waiting", async () => {
    server.seed(ID, "generate_image", "ready");
    await waitForOrder(ID);
    expect(sleeps).toEqual([]);
  });

  it("waits out dropped connections and a server that is briefly down, and still finds the order", async () => {
    server.behaviour.pollsUntilDone = 2;
    server.seed(ID, "generate_image", "running");
    server.fault(/^GET \/orders/, 2, "drop");
    server.fault(/^GET \/orders/, 2, 503);
    const ready = await waitForOrder(ID);
    expect(ready.state).toBe("ready");
    expect(sleeps.slice(0, 4)).toEqual([2000, 4000, 8000, 16_000]);
  });

  it("never waits more than thirty seconds between tries, however long the server is away", async () => {
    server.seed(ID, "generate_image", "ready");
    server.fault(/^GET \/orders/, 12, "drop");
    await waitForOrder(ID);
    expect(Math.max(...sleeps)).toBe(30_000);
    expect(sleeps).toHaveLength(12);
  });

  it("starts counting again once the server answers, so a second outage is waited out from the short delay", async () => {
    server.behaviour.pollsUntilDone = 99;
    server.seed(ID, "generate_image", "running");
    const script = ["drop", "ok", "drop", "ok", "drop", "ready"];
    const real = server.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const step = script.shift();
      if (step === "drop") throw new TypeError("Failed to fetch");
      if (step === "ready") server.orders.get(ID)!.state = "ready";
      return real(input, init);
    });
    await waitForOrder(ID);
    expect(sleeps).toEqual([2000, pollDelayMs(0), 2000, pollDelayMs(1), 2000]);
  });

  it("asks to sign in again each time the session lapses after having worked, not just the first time", async () => {
    server.behaviour.pollsUntilDone = 99;
    server.seed(ID, "generate_image", "running");
    let n = 0;
    const real = server.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      n += 1;
      if (n === 1 || n === 3) return new Response("{}", { status: 401 });
      if (n >= 5) server.orders.get(ID)!.state = "ready";
      return real(input, init);
    });
    await waitForOrder(ID);
    expect(notifyAuthFailure).toHaveBeenCalledTimes(2);
  });

  it("goes on after the session lapses, asking to sign in once, and finishes when it is back", async () => {
    server.seed(ID, "generate_image", "ready");
    server.fault(/^GET \/orders/, 3, 401);
    const ready = await waitForOrder(ID);
    expect(ready.state).toBe("ready");
    expect(notifyAuthFailure).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([15_000, 15_000, 15_000]);
  });

  it("fails with the server's own reason, code and advice when the order failed", async () => {
    server.behaviour.outcome = "failed";
    server.behaviour.failure = { code: "provider_refused", message: "Azure refused it.", retryable: true };
    server.seed(ID, "generate_image", "running");
    const error = (await waitForOrder(ID).catch((e: unknown) => e)) as OrderFailedError;
    expect(error).toBeInstanceOf(OrderFailedError);
    expect(error.message).toBe("Azure refused it.");
    expect(error.code).toBe("provider_refused");
    expect(error.retryable).toBe(true);
    server.orders.clear();
    server.behaviour.failure = { code: "provider_refused", message: "Azure refused it.", retryable: false };
    server.seed(ID, "generate_image", "running");
    expect(((await waitForOrder(ID).catch((e: unknown) => e)) as OrderFailedError).retryable).toBe(false);
  });

  it("says the order is not there when the server has never heard of it", async () => {
    await expect(waitForOrder(ID)).rejects.toBeInstanceOf(OrderNotFoundError);
  });

  it("says a finished result that nobody collected in time is gone, and that it was charged", async () => {
    server.seed(ID, "generate_image", "expired");
    const error = (await waitForOrder(ID).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(OrderExpiredError);
    expect(error.message).toMatch(/seven days|7 days/i);
    expect(error.message).toMatch(/charged/i);
  });

  it("says a result that was already taken (by another window) is already taken", async () => {
    server.seed(ID, "generate_image", "collected");
    await expect(waitForOrder(ID)).rejects.toBeInstanceOf(OrderCollectedError);
  });

  it("stops asking, without ending the order, when this build is no longer allowed to ask", async () => {
    server.seed(ID, "generate_image", "running");
    server.fault(/^GET \/orders/, 1, 426);
    await expect(waitForOrder(ID)).rejects.toBeInstanceOf(OrderWaitSuspended);
    expect(server.orders.get(ID)?.state).toBe("running");
  });

  it("stops at once when asked to, and asks nothing more", async () => {
    server.behaviour.pollsUntilDone = 99;
    server.seed(ID, "generate_image", "running");
    const stop = new AbortController();
    orderPolling.sleep = async () => {
      stop.abort();
      throw new DOMException("Aborted", "AbortError");
    };
    await expect(waitForOrder(ID, { signal: stop.signal })).rejects.toMatchObject({ name: "AbortError" });
    const asked = server.calls.length;
    await Promise.resolve();
    expect(server.calls).toHaveLength(asked);
  });
});

describe("collecting the result", () => {
  const dto = { result: { ok: true, count: 1 }, media: [{ b64: "aGVsbG8=", ext: ".png", kind: "image" }] };

  it("downloads exactly the response the live call would have returned", async () => {
    server.seed(ID, "generate_image", "ready", dto);
    const ready = await waitForOrder(ID);
    expect(await downloadOrderResult(ready)).toEqual(dto);
  });

  it("does not send the account's token to the storage link", async () => {
    server.seed(ID, "generate_image", "ready", dto);
    const seen: Record<string, string>[] = [];
    const real = server.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://storage.test")) seen.push({ ...((init?.headers as Record<string, string>) ?? {}) });
      return real(input, init);
    });
    await downloadOrderResult(await waitForOrder(ID));
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]).map((k) => k.toLowerCase())).not.toContain("authorization");
  });

  it("asks for a fresh link when the one it was given has expired", async () => {
    server.seed(ID, "generate_image", "ready", dto);
    server.expireLinksOnce = true;
    const links = new Set<string>();
    const real = server.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://storage.test")) links.add(String(input));
      return real(input, init);
    });
    expect(await downloadOrderResult(await waitForOrder(ID))).toEqual(dto);
    expect(server.calls.filter((c) => c.startsWith("GET /orders"))).toHaveLength(2);
  });

  it("says a result that was taken meanwhile (by another window) is already taken, not gone", async () => {
    server.seed(ID, "generate_image", "ready", dto);
    const ready = await waitForOrder(ID);
    server.orders.get(ID)!.state = "collected";
    await expect(downloadOrderResult(ready)).rejects.toBeInstanceOf(OrderCollectedError);
  });

  it("says the result is gone when the file has been removed since", async () => {
    server.seed(ID, "generate_image", "ready", dto);
    const ready = await waitForOrder(ID);
    server.orders.get(ID)!.state = "expired";
    await expect(downloadOrderResult(ready)).rejects.toBeInstanceOf(OrderExpiredError);
  });

  it("waits out a storage hiccup", async () => {
    server.seed(ID, "generate_image", "ready", dto);
    server.fault(/^GET https:\/\/storage\.test/, 2, 503);
    expect(await downloadOrderResult(await waitForOrder(ID))).toEqual(dto);
  });

  it("does not mistake a file that is not a result for one", async () => {
    server.seed(ID, "generate_image", "ready", ["not", "a", "result"]);
    await expect(downloadOrderResult(await waitForOrder(ID))).rejects.toThrow(/could not be read/);
  });
});

describe("confirming receipt", () => {
  it("collects the order on the server", async () => {
    server.seed(ID, "generate_image", "ready");
    expect(await ackOrder(ID)).toBe(true);
    expect(server.orders.get(ID)?.state).toBe("collected");
  });

  it("tries again after a dropped connection, and never throws when it cannot", async () => {
    server.seed(ID, "generate_image", "ready");
    server.fault(/^POST \/orders/, 1, "drop");
    expect(await ackOrder(ID)).toBe(true);
    server.seed(ID.replace("0", "1"), "generate_image", "ready");
    server.fault(/^POST \/orders/, 99, "drop");
    expect(await ackOrder(ID.replace("0", "1"))).toBe(false);
  });

  it("has nothing to confirm for an order the server never had", async () => {
    expect(await ackOrder(ID)).toBe(true);
  });
});

describe("which orders the server took", () => {
  it("remembers the ones it accepted, so a plain inline answer is never confirmed", () => {
    expect(isAcceptedOrder(ID)).toBe(false);
    markOrderAccepted(ID);
    expect(isAcceptedOrder(ID)).toBe(true);
    expect(isAcceptedOrder(ID + "x")).toBe(false);
  });

  it("confirms an accepted order once, and forgets it when the server has been told", async () => {
    server.seed(ID, "generate_image", "ready");
    markOrderAccepted(ID);
    await acknowledgeAcceptedOrder(ID);
    expect(server.orders.get(ID)?.state).toBe("collected");
    expect(isAcceptedOrder(ID)).toBe(false);
    server.calls.length = 0;
    await acknowledgeAcceptedOrder(ID);
    expect(server.calls).toEqual([]);
  });

  it("says nothing to the server about an order it never took", async () => {
    server.seed(ID, "generate_image", "ready");
    await acknowledgeAcceptedOrder(ID);
    expect(server.calls).toEqual([]);
    expect(server.orders.get(ID)?.state).toBe("ready");
  });

  it("keeps an order it could not confirm, so confirming can be tried again later", async () => {
    server.seed(ID, "generate_image", "ready");
    markOrderAccepted(ID);
    server.fault(/^POST \/orders/, 99, "drop");
    await acknowledgeAcceptedOrder(ID);
    expect(isAcceptedOrder(ID)).toBe(true);
    expect(server.orders.get(ID)?.state).toBe("ready");
  });
});
