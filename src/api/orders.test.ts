import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth", async (io) => {
  const actual = await io<typeof import("./auth")>();
  return { ...actual, notifyAuthFailure: vi.fn() };
});
vi.mock("../update/compatibility", async (io) => {
  const actual = await io<typeof import("../update/compatibility")>();
  return { ...actual, fetchCompatibleClient: vi.fn(actual.fetchCompatibleClient) };
});

import { notifyAuthFailure, setClerkTokenProvider } from "./auth";
import orderViews from "./__fixtures__/orderViews.json";
import { rateLimitConfig } from "./http";
import { CreditLimitError } from "./usage";
import { RateLimitError } from "./http";
import { fetchCompatibleClient } from "../update/compatibility";
import {
  __resetOrderPolling,
  acknowledgeAcceptedOrder,
  ackOrder,
  downloadOrderResult,
  getOrder,
  isAcceptedOrder,
  isOrderVerdict,
  LOST_SUBMIT_GRACE_MS,
  markOrderAccepted,
  newOrderId,
  OrderCollectedError,
  OrderExpiredError,
  OrderFailedError,
  OrderNotFoundError,
  orderKnownToServer,
  OrderResultUnavailableError,
  OrderResultUnreadableError,
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
    // a loop that never ends is a failure of the code under test, not a hung test run
    if (sleeps.length > 200) throw new Error("the test ran out of patience: the code kept asking");
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
    for (const bad of [
      "",
      "short",
      "a".repeat(15),
      "a".repeat(65),
      "has space in it 123",
      "slash/in/the/middle1",
    ])
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
      if (state === "ready") expected.result.url = `https://storage.test/results/${ID}.json?sig=1`;
      if (state === "failed") expected.error = { retryable: false, ...server.behaviour.failure };
      expect(view).toEqual(expected);
    },
  );

  it("says so when the server has no such order", async () => {
    await expect(getOrder(ID)).rejects.toBeInstanceOf(OrderNotFoundError);
  });

  describe("a 404 is the server's verdict only when the server says so", () => {
    it.each([
      ["a gateway's own page", () => new Response("<h1>404 Not Found</h1>", { status: 404 })],
      ["an empty answer", () => new Response(null, { status: 404 })],
      [
        "another server's JSON",
        () => new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 }),
      ],
      [
        "a different error code",
        () =>
          new Response(JSON.stringify({ detail: { error: "something_else" } }), { status: 404 }),
      ],
      ["a bare object", () => new Response("{}", { status: 404 })],
    ])("%s is the server being out of reach, not the order being gone", async (_label, make) => {
      vi.stubGlobal("fetch", async () => make());
      await expect(getOrder(ID)).rejects.toBeInstanceOf(OrderUnreachableError);
    });

    it("is still one when the server's own error code is there", async () => {
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response(JSON.stringify({ detail: { error: "order_not_found" } }), { status: 404 }),
      );
      await expect(getOrder(ID)).rejects.toBeInstanceOf(OrderNotFoundError);
    });

    it("is waited out by a caller that is waiting for the order, which is then found when the real server answers", async () => {
      server.seed(ID, "generate_image", "ready");
      server.fault(/^GET \/orders/, 3, 404);
      const ready = await waitForOrder(ID);
      expect(ready.state).toBe("ready");
      expect(sleeps.length).toBe(3);
    });
  });

  it("puts the number in the address safely", async () => {
    server.seed(ID, "generate_image", "running");
    await getOrder(ID);
    expect(server.calls).toEqual([`GET /orders/${ID}`]);
    await expect(getOrder("../../ai/generate_image")).rejects.toBeInstanceOf(OrderNotFoundError);
    expect(server.calls.at(-1)).toBe("GET /orders/..%2F..%2Fai%2Fgenerate_image");
  });

  it.each([401, 429, 500, 502, 503])(
    "treats a %i as the server being out of reach, not as the order being gone",
    async (status) => {
      server.fault(/^GET \/orders/, 1, status);
      await expect(getOrder(ID)).rejects.toBeInstanceOf(OrderUnreachableError);
    },
  );

  it("does not take an answer it cannot read for an order", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ order: { state: "teleporting" } })),
    );
    await expect(getOrder(ID)).rejects.toThrow(/could not be understood/);
    vi.stubGlobal("fetch", async () => new Response("not json at all"));
    await expect(getOrder(ID)).rejects.toThrow(/could not be understood/);
  });

  it("does not take a ready order without its link or its charge, or a failed one without its reason", async () => {
    const stamps = { order_id: ID, created_at: 1, updated_at: 1 };
    const link = {
      url: "https://x.test/r",
      bytes: 1,
      content_type: "application/json",
      expires_at: 2,
    };
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
      async () =>
        new Response(
          JSON.stringify({
            order: {
              order_id: ID,
              state: "failed",
              created_at: 1,
              updated_at: 1,
              error: { message: "No." },
            },
          }),
        ),
    );
    const view = await getOrder(ID);
    expect(view.error).toEqual({ code: "generation_failed", message: "No.", retryable: false });
  });

  describe("the numbers of a credit refusal", () => {
    const wall = { scope: "user", used: 120.31, limit: 150, requested: 96, remaining: 29.69 };
    const failedWith = (detail: unknown) =>
      new Response(
        JSON.stringify({
          order: {
            order_id: ID,
            state: "failed",
            created_at: 1,
            updated_at: 1,
            error: { code: "credit_limit_reached", message: "No.", retryable: false, detail },
          },
        }),
      );
    const allowed = new Set(["scope", "used", "limit", "requested", "remaining"]);

    it("are kept exactly, with the failure", async () => {
      vi.stubGlobal("fetch", async () => failedWith(wall));
      expect((await getOrder(ID)).error).toEqual({
        code: "credit_limit_reached",
        message: "No.",
        retryable: false,
        detail: wall,
      });
    });

    it.each([
      undefined,
      null,
      {},
      "text",
      5,
      [1, 2],
      { scope: "everyone" },
      { used: -1 },
      { used: "12" },
      { email: "a@b.c", error: "x" },
    ])("leave no detail at all when there is nothing usable in %j", async (detail) => {
      vi.stubGlobal("fetch", async () => failedWith(detail));
      const view = await getOrder(ID);
      expect(view.error).toBeDefined();
      expect("detail" in (view.error ?? {})).toBe(false);
    });

    it("are never anything but finite non-negative credit numbers and a known scope, whatever the server sends", async () => {
      const responses: Response[] = [];
      await fc.assert(
        fc.asyncProperty(
          fc.jsonValue(),
          fc.dictionary(fc.constantFrom(...allowed, "email", "x"), fc.jsonValue()),
          async (junk, mixed) => {
            for (const detail of [junk, mixed]) {
              vi.stubGlobal("fetch", async () => failedWith(detail));
              const found = (await getOrder(ID)).error?.detail as
                Record<string, unknown> | undefined;
              if (!found) continue;
              expect(Object.keys(found).every((k) => allowed.has(k))).toBe(true);
              for (const [key, value] of Object.entries(found)) {
                if (key === "scope") expect(["user", "global"]).toContain(value);
                else
                  expect(typeof value === "number" && Number.isFinite(value) && value >= 0).toBe(
                    true,
                  );
              }
            }
            responses.length = 0;
          },
        ),
        { numRuns: 120 },
      );
    });

    it("lose nothing legitimate: every number the server sends gets through", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            used: fc.double({ min: 0, max: 1e6, noNaN: true }),
            limit: fc.double({ min: 0, max: 1e6, noNaN: true }),
            requested: fc.double({ min: 0, max: 1e6, noNaN: true }),
            remaining: fc.double({ min: 0, max: 1e6, noNaN: true }),
            scope: fc.constantFrom("user", "global"),
          }),
          async (detail) => {
            vi.stubGlobal("fetch", async () => failedWith(detail));
            expect((await getOrder(ID)).error?.detail).toEqual(JSON.parse(JSON.stringify(detail)));
          },
        ),
        { numRuns: 60 },
      );
    });

    it("reach the error a waiting caller is given", async () => {
      server.behaviour.outcome = "failed";
      server.behaviour.failure = {
        code: "credit_limit_reached",
        message: "No.",
        retryable: false,
        detail: wall,
      };
      server.seed(ID, "generate_image", "running");
      const error = (await waitForOrder(ID).catch((e: unknown) => e)) as OrderFailedError;
      expect(error).toBeInstanceOf(OrderFailedError);
      expect(error.detail).toEqual(wall);
      expect(error.code).toBe("credit_limit_reached");
    });
  });
});

describe("waiting for an order", () => {
  it("asks until it is ready, at the pace it should, and gives the ready order back", async () => {
    server.behaviour.pollsUntilDone = 14;
    server.seed(ID, "generate_image", "running");
    const ready = await waitForOrder(ID);
    expect(ready.state).toBe("ready");
    expect(ready.result.url).toBe(`https://storage.test/results/${ID}.json?sig=1`);
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
    server.behaviour.failure = {
      code: "provider_refused",
      message: "Azure refused it.",
      retryable: true,
    };
    server.seed(ID, "generate_image", "running");
    const error = (await waitForOrder(ID).catch((e: unknown) => e)) as OrderFailedError;
    expect(error).toBeInstanceOf(OrderFailedError);
    expect(error.message).toBe("Azure refused it.");
    expect(error.code).toBe("provider_refused");
    expect(error.retryable).toBe(true);
    server.orders.clear();
    server.behaviour.failure = {
      code: "provider_refused",
      message: "Azure refused it.",
      retryable: false,
    };
    server.seed(ID, "generate_image", "running");
    expect(((await waitForOrder(ID).catch((e: unknown) => e)) as OrderFailedError).retryable).toBe(
      false,
    );
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
    await expect(waitForOrder(ID, { signal: stop.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    const asked = server.calls.length;
    await Promise.resolve();
    expect(server.calls).toHaveLength(asked);
  });
});

describe("whether the server has an order", () => {
  it("says yes for an order of any state, without moving it on", async () => {
    server.behaviour.pollsUntilDone = 99;
    server.seed(ID, "generate_image", "running");
    expect(await orderKnownToServer(ID)).toBe(true);
    expect(server.orders.get(ID)?.state).toBe("running");
  });

  it("says no only when the server itself says it has no such order, and only after giving a request still on its way time to arrive", async () => {
    expect(LOST_SUBMIT_GRACE_MS).toBeGreaterThanOrEqual(3000); // long enough for a slow request to land
    expect(await orderKnownToServer(ID)).toBe(false);
    expect(server.calls.filter((c) => c.startsWith("GET /orders"))).toHaveLength(2);
    expect(sleeps).toEqual([LOST_SUBMIT_GRACE_MS]);
  });

  it("says yes for an order that reaches the server during that time: the request that made it was only slow", async () => {
    const real = server.fetch;
    let asked = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/orders/")) {
        asked += 1;
        if (asked === 2) server.seed(ID, "generate_image", "running"); // it arrives while the app waits
      }
      return real(input, init);
    });
    expect(await orderKnownToServer(ID)).toBe(true);
    expect(sleeps).toEqual([LOST_SUBMIT_GRACE_MS]);
  });

  it("does not wait at all for an order the server already has", async () => {
    server.seed(ID, "generate_image", "ready");
    expect(await orderKnownToServer(ID)).toBe(true);
    expect(sleeps).toEqual([]);
  });

  it("keeps asking while the server cannot answer, and asks to sign in once if the session lapsed", async () => {
    server.seed(ID, "generate_image", "running");
    server.fault(/^GET \/orders/, 2, "drop");
    server.fault(/^GET \/orders/, 2, 401);
    expect(await orderKnownToServer(ID)).toBe(true);
    expect(sleeps).toEqual([2000, 4000, 15_000, 15_000]);
    expect(notifyAuthFailure).toHaveBeenCalledTimes(1);
  });

  it("stops without ending the order when this build may no longer ask", async () => {
    server.seed(ID, "generate_image", "running");
    server.fault(/^GET \/orders/, 1, 426);
    await expect(orderKnownToServer(ID)).rejects.toBeInstanceOf(OrderWaitSuspended);
  });
});

describe("collecting the result", () => {
  const dto = {
    result: { ok: true, count: 1 },
    media: [{ b64: "aGVsbG8=", ext: ".png", kind: "image" }],
  };

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
      if (String(input).startsWith("https://storage.test"))
        seen.push({ ...((init?.headers as Record<string, string>) ?? {}) });
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

  const STORAGE_GET = /^GET https:\/\/storage\.test/;
  const storageCalls = () => server.calls.filter((c) => STORAGE_GET.test(c)).length;

  it("is not held up by the build compatibility check: that guards calls to our server, and this reads a file already paid for", async () => {
    server.seed(ID, "generate_image", "ready", dto);
    const ready = await waitForOrder(ID);
    vi.mocked(fetchCompatibleClient).mockClear();
    await downloadOrderResult(ready);
    expect(
      vi
        .mocked(fetchCompatibleClient)
        .mock.calls.filter(([url]) => String(url).startsWith("https://storage.test")),
    ).toEqual([]);
  });

  it("keeps trying through far more than four failures, pausing longer each time, and asks for a fresh link every third", async () => {
    server.seed(ID, "generate_image", "ready", dto);
    const ready = await waitForOrder(ID);
    server.calls.length = 0;
    sleeps.length = 0;
    server.fault(STORAGE_GET, 7, "drop");
    expect(await downloadOrderResult(ready)).toEqual(dto);
    expect(storageCalls()).toBe(8);
    expect(sleeps).toEqual([2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
    expect(server.calls.filter((c) => c.startsWith("GET /orders"))).toHaveLength(2); // after the third and the sixth
  });

  it.each([
    ["a dropped connection", "drop" as const],
    ["a 500", 500],
    ["a 502", 502],
    ["a 503", 503],
    ["a 408", 408],
    ["a 429", 429],
    ["an answer cut off half way", "cut-body" as const],
  ])("treats %s as something to wait out, not as the end", async (_what, kind) => {
    server.seed(ID, "generate_image", "ready", dto);
    const ready = await waitForOrder(ID);
    server.fault(STORAGE_GET, 2, kind);
    expect(await downloadOrderResult(ready)).toEqual(dto);
    expect(storageCalls()).toBe(3);
  });

  it.each([400, 401, 403, 404])(
    "treats a %s from the link as one that ran out and asks the server for a fresh one",
    async (status) => {
      server.seed(ID, "generate_image", "ready", dto);
      const ready = await waitForOrder(ID);
      server.calls.length = 0;
      server.fault(STORAGE_GET, 1, status);
      expect(await downloadOrderResult(ready)).toEqual(dto);
      expect(server.calls.filter((c) => c.startsWith("GET /orders"))).toHaveLength(1);
    },
  );

  it.each([405, 409, 410, 418])(
    "does not wait out a %s: nothing about it will change",
    async (status) => {
      server.seed(ID, "generate_image", "ready", dto);
      const ready = await waitForOrder(ID);
      server.calls.length = 0;
      server.fault(STORAGE_GET, 9, status);
      await expect(downloadOrderResult(ready)).rejects.toThrow(
        new RegExp(`could not be downloaded \\(${status}\\)`),
      );
      expect(storageCalls()).toBe(1);
    },
  );

  it("goes on with the fresh link it is given, not the old one", async () => {
    server.seed(ID, "generate_image", "ready", dto);
    const ready = await waitForOrder(ID); // its link is the first one handed out
    await getOrder(ID); // ...and the server has since handed out a newer one
    server.strictLinks = true; // only the newest link works now
    expect(await downloadOrderResult(ready)).toEqual(dto);
  });

  it("stops for now, without a verdict, when the link keeps being refused while the server still says the result is ready", async () => {
    server.seed(ID, "generate_image", "ready", dto);
    const ready = await waitForOrder(ID);
    server.calls.length = 0;
    sleeps.length = 0;
    server.fault(STORAGE_GET, 99, 404);
    await expect(downloadOrderResult(ready)).rejects.toBeInstanceOf(OrderResultUnavailableError);
    expect(storageCalls()).toBe(11);
    expect(server.orders.get(ID)?.state).toBe("ready");
    // A link the storage keeps refusing is asked about once a second, never as fast as the network carries it: the first refresh
    // is free, each of the nine after it waits.
    expect(sleeps).toHaveLength(9);
    expect(Math.min(...sleeps)).toBeGreaterThanOrEqual(1000);
  });

  it("stops for now, without a verdict, when the connection never comes back", async () => {
    server.seed(ID, "generate_image", "ready", dto);
    const ready = await waitForOrder(ID);
    server.calls.length = 0;
    server.fault(STORAGE_GET, 99, "drop");
    await expect(downloadOrderResult(ready)).rejects.toBeInstanceOf(OrderResultUnavailableError);
    expect(storageCalls()).toBe(21);
  });

  it("starts counting the refused links again after a failure in transit", async () => {
    server.seed(ID, "generate_image", "ready", dto);
    const ready = await waitForOrder(ID);
    // nine refused links, a dropped connection, nine more: each run alone is under the limit of ten, and together they are not
    server.fault(STORAGE_GET, 9, 404);
    server.fault(STORAGE_GET, 1, "drop");
    server.fault(STORAGE_GET, 9, 404);
    expect(await downloadOrderResult(ready)).toEqual(dto);
    expect(storageCalls()).toBe(20);
  });

  it("stops at once when asked to, even in the middle of waiting out a failure", async () => {
    server.seed(ID, "generate_image", "ready", dto);
    const ready = await waitForOrder(ID);
    server.calls.length = 0;
    server.fault(STORAGE_GET, 99, "drop");
    const controller = new AbortController();
    orderPolling.sleep = async (ms, signal) => {
      sleeps.push(ms);
      if (sleeps.length === 2) controller.abort();
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    };
    await expect(downloadOrderResult(ready, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(storageCalls()).toBe(2);
  });

  it("says a result that is not a result is unreadable, as a verdict, and does not try again", async () => {
    server.seed(ID, "generate_image", "ready", { result: "text, not an object" });
    const ready = await waitForOrder(ID);
    server.calls.length = 0;
    const failure = await downloadOrderResult(ready).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(OrderResultUnreadableError);
    expect(isOrderVerdict(failure)).toBe(true);
    expect(storageCalls()).toBe(1);
  });
});

describe("what is the server's own word on an order", () => {
  it("is exactly: failed, not found, expired, collected, an unreadable result, and the limits as the tools translate them", () => {
    for (const verdict of [
      new OrderFailedError("no", "generation_failed"),
      new OrderNotFoundError(ID),
      new OrderExpiredError(),
      new OrderCollectedError(),
      new OrderResultUnreadableError(),
      new RateLimitError("busy"),
      new CreditLimitError({ used: 1, limit: 1 }),
    ])
      expect(isOrderVerdict(verdict), verdict.name).toBe(true);
  });

  it("is never the app's own trouble: a lost connection, a suspended build, an unavailable link or any other error", () => {
    for (const trouble of [
      new TypeError("Failed to fetch"),
      new Error("The finished result could not be downloaded (418)."),
      new OrderResultUnavailableError(),
      new OrderWaitSuspended(),
      new OrderUnreachableError("down", "server"),
      new DOMException("Aborted", "AbortError"),
      "a string",
      null,
    ])
      expect(isOrderVerdict(trouble)).toBe(false);
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
