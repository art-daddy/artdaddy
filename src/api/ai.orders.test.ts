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
  return { ...actual, markOverLimit: vi.fn(), refreshUsage: vi.fn(async () => undefined) };
});

import { setClerkTokenProvider } from "./auth";
import orderViews from "./__fixtures__/orderViews.json";
import { callAiProxy } from "./ai";
import {
  rateLimitConfig,
  RateLimitError,
  SessionExpiredError,
  SessionRenewalUnavailableError,
} from "./http";
import {
  __resetOrderPolling,
  isAcceptedOrder,
  orderPolling,
  OrderFailedError,
  OrderWaitSuspended,
} from "./orders";
import { CreditLimitError, markOverLimit, refreshUsage } from "./usage";
import { FakeOrderServer } from "../test/orderServer";
import { ClientUpdateRequiredError } from "../update/updater";

const ID = "0123456789abcdef0123456789abcdef";
const IMAGE = {
  result: { ok: true, count: 1 },
  media: [{ b64: "aGVsbG8=", ext: ".png", kind: "image" }],
};
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
  vi.mocked(refreshUsage).mockClear();
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
    expect(seen[0].body).toMatchObject({
      order_id: ID,
      args: { prompt: "a van" },
      project_id: "p1",
    });
    for (const s of seen.filter((x) => x.line.includes("/orders/") || x.line.includes("/ai/")))
      expect(s.auth).toBeTruthy();
    for (const s of seen.filter((x) => x.line.includes("storage.test")))
      expect(s.auth).toBeUndefined();
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
    expect(await callAiProxy("vision_image", body, undefined, { onOrder })).toEqual({
      metrics: { cost_usd: 0.1 },
    });
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
    server.behaviour.failure = {
      code: "provider_refused",
      message: "Azure refused it.",
      retryable: false,
    };
    const error = (await callAiProxy("generate_image", body).catch(
      (e: unknown) => e,
    )) as OrderFailedError;
    expect(error).toBeInstanceOf(OrderFailedError);
    expect(error.message).toBe("Azure refused it.");
    expect(error.code).toBe("provider_refused");
  });

  it("turns a rate-limited order into the rate-limit error the tools already know how to explain", async () => {
    server.behaviour.outcome = "failed";
    server.behaviour.failure = {
      code: "rate_limited",
      message: "429 from the vendor",
      retryable: true,
    };
    await expect(callAiProxy("generate_image", body)).rejects.toBeInstanceOf(RateLimitError);
  });

  describe("an order the server refused for lack of credit after taking it", () => {
    const unaffordable = { scope: "user", used: 120, limit: 150, requested: 96, remaining: 30 };
    const exhausted = { scope: "user", used: 150, limit: 150, requested: 40, remaining: 0 };
    const paused = { scope: "global", used: 9000, limit: 9000, requested: 40, remaining: 0 };
    const refused = (detail?: Record<string, unknown>) => {
      server.behaviour.outcome = "failed";
      server.behaviour.failure = {
        code: "credit_limit_reached",
        message: "The server's own words. Nothing was charged.",
        retryable: false,
        ...(detail ? { detail } : {}),
      };
    };

    it.each([
      ["a request that costs more than what is left", unaffordable, "credit_request_unaffordable"],
      ["an account with nothing left", exhausted, undefined],
      ["the shared budget being used up", paused, undefined],
    ])(
      "ends as the credit-limit error the tools and the balance display already know, for %s",
      async (_label, detail, code) => {
        refused(detail);
        const error = (await callAiProxy("generate_image", body).catch(
          (e: unknown) => e,
        )) as CreditLimitError;
        expect(error).toBeInstanceOf(CreditLimitError);
        expect(error.code).toBe(code ?? new CreditLimitError(detail).code);
        expect(error.message).toBe(new CreditLimitError(detail).message); // exactly what the live call's 402 would have said
        expect(error.userMessage).toBe(new CreditLimitError(detail).userMessage);
        expect(error.detail).toEqual(detail);
        expect(markOverLimit).toHaveBeenCalledTimes(1);
        expect(markOverLimit).toHaveBeenCalledWith(detail);
      },
    );

    it("does not claim the account is over when the server gave no numbers, and asks for the real balance instead", async () => {
      refused();
      const error = (await callAiProxy("generate_image", body).catch(
        (e: unknown) => e,
      )) as OrderFailedError;
      expect(error).toBeInstanceOf(OrderFailedError);
      expect(error.message).toBe("The server's own words. Nothing was charged.");
      expect(markOverLimit).not.toHaveBeenCalled();
      expect(refreshUsage).toHaveBeenCalled();
    });

    it("leaves every other refusal alone: no balance is touched", async () => {
      server.behaviour.outcome = "failed";
      server.behaviour.failure = {
        code: "provider_refused",
        message: "Azure refused it.",
        retryable: false,
        detail: unaffordable,
      };
      const error = await callAiProxy("generate_image", body).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OrderFailedError);
      expect(markOverLimit).not.toHaveBeenCalled();
    });
  });

  it.each(orderViews.codes_the_app_acts_on)(
    "really acts on %s, as the contract fixture says: it is never handed on as a plain failed order",
    async (code) => {
      server.behaviour.outcome = "failed";
      server.behaviour.failure = {
        code,
        message: "x",
        retryable: false,
        detail: { scope: "user", used: 10, limit: 150, requested: 96, remaining: 20 },
      };
      const error = await callAiProxy("generate_image", body).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(OrderFailedError);
    },
  );

  it("still turns a refusal for lack of credit at the door into the credit-limit error", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ detail: { used: 10, limit: 10 } }), { status: 402 }),
    );
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

  it("collects an order whose acceptance came back with a body that is not JSON: it was accepted, whatever the body says", async () => {
    const real = server.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = await real(input, init);
      return String(input).includes("/ai/") && (init?.method ?? "GET") === "POST"
        ? new Response("<html>accepted</html>", { status: 202 })
        : answer;
    });
    const onOrder = vi.fn();
    expect(await callAiProxy("generate_image", body, undefined, { onOrder })).toEqual(IMAGE);
    expect(posts()).toHaveLength(1);
    expect(onOrder).toHaveBeenCalledWith(ID);
  });

  it("collects an order whose acceptance came back with an empty body", async () => {
    const real = server.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = await real(input, init);
      return String(input).includes("/ai/") && (init?.method ?? "GET") === "POST"
        ? new Response(null, { status: 202 })
        : answer;
    });
    expect(await callAiProxy("generate_image", body)).toEqual(IMAGE);
    expect(posts()).toHaveLength(1);
  });

  it("still fails a plain call whose answer is not JSON", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>oops</html>", { status: 200 }));
    await expect(callAiProxy("generate_image", { args: {}, media: {} })).rejects.toBeInstanceOf(
      Error,
    );
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
    await expect(callAiProxy("generate_image", { args: {}, media: {} })).rejects.toThrow(
      /Failed to fetch/,
    );
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
