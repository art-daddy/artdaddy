import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../observability/sentry", () => ({
  correlationBody: () => ({ project_id: "p1", transcript_id: "t1" }),
  identifyUser: async () => undefined,
}));
vi.mock("./auth", async (io) => {
  const actual = await io<typeof import("./auth")>();
  return { ...actual, notifyAuthFailure: vi.fn() };
});
vi.mock("./usage", async (io) => {
  const actual = await io<typeof import("./usage")>();
  return { ...actual, markOverLimit: vi.fn() };
});

import { setClerkTokenProvider } from "./auth";
import { callAiProxy } from "./ai";
import { rateLimitConfig, RateLimitError, SessionExpiredError, SessionRenewalUnavailableError } from "./http";
import { __resetOrderPolling, isAcceptedOrder, orderPolling, OrderFailedError, OrderWaitSuspended } from "./orders";
import { CreditLimitError, markOverLimit } from "./usage";
import { FakeOrderServer } from "../test/orderServer";
import { ClientUpdateRequiredError } from "../update/updater";

const ID = "0123456789abcdef0123456789abcdef";
const IMAGE = { result: { ok: true, count: 1 }, media: [{ b64: "aGVsbG8=", ext: ".png", kind: "image" }] };
const body = { args: { prompt: "a van" }, media: {}, order_id: ID };

let server: FakeOrderServer;
let sleeps: number[];
const realTransientBackoff = rateLimitConfig.transientBackoffS;

beforeEach(() => {
  server = new FakeOrderServer();
  server.behaviour.response = () => IMAGE;
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
  vi.mocked(markOverLimit).mockClear();
});

const posts = () => server.calls.filter((c) => c.startsWith("POST /ai/"));

describe("a paid call with an order number", () => {
  it("waits for the order the server takes and returns exactly what the live call would have", async () => {
    server.behaviour.pollsUntilDone = 3;
    const onOrder = vi.fn();
    const out = await callAiProxy("generate_image", body, undefined, { onOrder });
    expect(out).toEqual(IMAGE);
    expect(posts()).toEqual(["POST /ai/generate_image"]);
    expect(server.calls.filter((c) => c.startsWith("GET /orders"))).toHaveLength(3);
    expect(server.calls.some((c) => c.startsWith("GET https://storage.test"))).toBe(true);
    expect(onOrder).toHaveBeenCalledTimes(1);
    expect(onOrder).toHaveBeenCalledWith(ID);
    expect(isAcceptedOrder(ID)).toBe(true);
  });

  it("sends the number with the call, and the account's token with every ask but not to the storage link", async () => {
    const seen: { line: string; auth: string | undefined; body?: Record<string, unknown> }[] = [];
    const real = server.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers as Record<string, string>) ?? {};
      seen.push({
        line: `${init?.method ?? "GET"} ${String(input)}`,
        auth: headers.Authorization,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return real(input, init);
    });
    await callAiProxy("generate_image", body);
    expect(seen[0].body).toMatchObject({ order_id: ID, args: { prompt: "a van" }, project_id: "p1" });
    for (const s of seen.filter((x) => x.line.includes("/orders/") || x.line.includes("/ai/"))) expect(s.auth).toBeTruthy();
    for (const s of seen.filter((x) => x.line.includes("storage.test"))) expect(s.auth).toBeUndefined();
  });

  it("is served as before by a server that answers inline, and confirms nothing", async () => {
    server.behaviour.orders = false;
    const onOrder = vi.fn();
    expect(await callAiProxy("generate_image", body, undefined, { onOrder })).toEqual(IMAGE);
    expect(server.calls).toEqual(["POST /ai/generate_image"]);
    expect(onOrder).not.toHaveBeenCalled();
    expect(isAcceptedOrder(ID)).toBe(false);
  });

  it("is not an order at all when no number is given", async () => {
    const out = await callAiProxy("generate_image", { args: {}, media: {} });
    expect(out).toEqual(IMAGE);
    expect(server.calls).toEqual(["POST /ai/generate_image"]);
  });

  it("hands back an inline answer as it is, even one with nothing in it the app knows", async () => {
    server.behaviour.orders = false;
    server.behaviour.response = () => ({ metrics: { cost_usd: 0.1 } });
    const onOrder = vi.fn();
    expect(await callAiProxy("vision_image", body, undefined, { onOrder })).toEqual({ metrics: { cost_usd: 0.1 } });
    expect(onOrder).not.toHaveBeenCalled();
    expect(server.calls).toEqual(["POST /ai/vision_image"]);
  });

  it("waits for an order the server already had, instead of running it again", async () => {
    server.seed(ID, "generate_image", "ready", IMAGE, body.args);
    expect(await callAiProxy("generate_image", body)).toEqual(IMAGE);
    expect(server.orders.size).toBe(1);
    expect(isAcceptedOrder(ID)).toBe(true);
  });

  it("throws the server's own words and code when the order failed", async () => {
    server.behaviour.outcome = "failed";
    server.behaviour.failure = { code: "provider_refused", message: "Azure refused it.", retryable: false };
    const error = (await callAiProxy("generate_image", body).catch((e: unknown) => e)) as OrderFailedError;
    expect(error).toBeInstanceOf(OrderFailedError);
    expect(error.message).toBe("Azure refused it.");
    expect(error.code).toBe("provider_refused");
  });

  it("turns a rate-limited order into the rate-limit error the tools already know how to explain", async () => {
    server.behaviour.outcome = "failed";
    server.behaviour.failure = { code: "rate_limited", message: "429 from the vendor", retryable: true };
    await expect(callAiProxy("generate_image", body)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("still turns a refusal for lack of credit at the door into the credit-limit error", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ detail: { used: 10, limit: 10 } }), { status: 402 }));
    await expect(callAiProxy("generate_image", body)).rejects.toBeInstanceOf(CreditLimitError);
    expect(markOverLimit).toHaveBeenCalledWith({ used: 10, limit: 10 });
  });

  it("reports a refusal that is not a server error at once, without asking about the order", async () => {
    server.fault(/^POST \/ai/, 1, 400);
    await expect(callAiProxy("generate_image", body)).rejects.toThrow(/^400: /);
    expect(server.calls.filter((c) => c.startsWith("GET /orders"))).toEqual([]);
  });

  it.each([
    ["a build that must be updated", () => new ClientUpdateRequiredError()],
    ["a session that could not be renewed", () => new SessionRenewalUnavailableError()],
    ["a session that was revoked", () => new SessionExpiredError()],
  ])("does not go looking for an order when the call never left (%s)", async (_label, make) => {
    const error = make();
    vi.stubGlobal("fetch", async () => {
      throw error;
    });
    await expect(callAiProxy("generate_image", body)).rejects.toBe(error);
    expect(server.calls).toEqual([]);
  });

  it("does not send the same call twice on its own", async () => {
    server.fault(/^POST \/ai/, 1, 503);
    await expect(callAiProxy("generate_image", body)).rejects.toThrow(/^503: /);
    expect(posts()).toHaveLength(1);
  });
});

describe("a submit whose answer was lost", () => {
  it("finds the order the server did take, and never sends the call again", async () => {
    server.fault(/^POST \/ai/, 1, "lose-answer");
    const onOrder = vi.fn();
    expect(await callAiProxy("generate_image", body, undefined, { onOrder })).toEqual(IMAGE);
    expect(posts()).toHaveLength(1);
    expect(server.orders.size).toBe(1);
    expect(onOrder).toHaveBeenCalledWith(ID);
  });

  it("finds it even when the answer was a server error the order outlived", async () => {
    // the server made the order, then failed to say so: 5xx with an order behind it
    const real = server.fetch;
    let first = true;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await real(input, init);
      if (first && init?.method === "POST" && String(input).includes("/ai/")) {
        first = false;
        return new Response('{"detail":"bad gateway"}', { status: 502 });
      }
      return res;
    });
    expect(await callAiProxy("generate_image", body)).toEqual(IMAGE);
    expect(posts()).toHaveLength(1);
  });

  it("waits until the server can say, however long that takes, and then goes on", async () => {
    server.fault(/^POST \/ai/, 1, "lose-answer");
    server.fault(/^GET \/orders/, 3, "drop");
    expect(await callAiProxy("generate_image", body)).toEqual(IMAGE);
    expect(sleeps.slice(0, 3)).toEqual([2000, 4000, 8000]);
    expect(posts()).toHaveLength(1);
  });

  it("gives the original failure when the server never had the call, and does not send it again", async () => {
    server.fault(/^POST \/ai/, 1, "drop");
    await expect(callAiProxy("generate_image", body)).rejects.toThrow(/Failed to fetch/);
    expect(posts()).toHaveLength(1);
    expect(server.orders.size).toBe(0);
  });

  it("gives the server's error when it refused the call outright", async () => {
    server.fault(/^POST \/ai/, 1, 503);
    await expect(callAiProxy("generate_image", body)).rejects.toThrow(/^503: /);
    expect(server.orders.size).toBe(0);
  });

  it("does not ask about an order for a call that was not one", async () => {
    server.fault(/^POST \/ai/, 1, "drop");
    await expect(callAiProxy("generate_image", { args: {}, media: {} })).rejects.toThrow(/Failed to fetch/);
    expect(server.calls.filter((c) => c.startsWith("GET /orders"))).toEqual([]);
  });

  it("leaves the order alone, rather than failing it, when this build may no longer ask", async () => {
    server.fault(/^POST \/ai/, 1, "lose-answer");
    server.fault(/^GET \/orders/, 1, 426);
    await expect(callAiProxy("generate_image", body)).rejects.toBeInstanceOf(OrderWaitSuspended);
    expect(server.orders.get(ID)?.state).toBe("running");
  });
});

describe("a call that is stopped", () => {
  it("does not go looking for an order after the person stopped it", async () => {
    const stop = new AbortController();
    stop.abort();
    server.fault(/^POST \/ai/, 1, "drop");
    await expect(callAiProxy("generate_image", body, stop.signal)).rejects.toBeTruthy();
    expect(server.calls.filter((c) => c.startsWith("GET /orders"))).toEqual([]);
  });
});
