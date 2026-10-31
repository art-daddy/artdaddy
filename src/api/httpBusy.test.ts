// The server answers "not now" (account_busy, server_busy) when it has not started a request and charged nothing, so
// asking again is free. The default streaming chat route used to throw on the first such answer; it now waits out a typed
// busy answer, bounded, honouring the server's own delay, and a user Stop ends the wait. Any other refusal is passed on at once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchRetryingBusy, rateLimitConfig } from "./http";

const ORIGINAL = { ...rateLimitConfig };

function busy(
  error: "account_busy" | "server_busy",
  retryAfter?: string,
  retryAfterS?: number,
): Response {
  return new Response(
    JSON.stringify({
      detail: {
        error,
        reason: "line_full",
        ...(retryAfterS === undefined ? {} : { retry_after_s: retryAfterS }),
      },
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        ...(retryAfter === undefined ? {} : { "Retry-After": retryAfter }),
      },
    },
  );
}

const ok = () => new Response("{}", { status: 200 });

/** A fetch that replays a fixed script of responses (then repeats the last), recording when each call was made. */
function script(...answers: Response[]) {
  const at: number[] = [];
  const fn = vi.fn(async () => {
    at.push(Date.now());
    return answers[Math.min(at.length - 1, answers.length - 1)].clone();
  });
  vi.stubGlobal("fetch", fn);
  return { fn, at };
}

beforeEach(() => {
  Object.assign(rateLimitConfig, ORIGINAL);
  vi.spyOn(Math, "random").mockReturnValue(0); // no jitter: the schedule is exact
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.assign(rateLimitConfig, ORIGINAL);
});

describe("a typed busy answer", () => {
  it.each(["account_busy", "server_busy"] as const)(
    "%s is waited out and the request goes again",
    async (error) => {
      const { fn, at } = script(busy(error, "2"), ok());
      const pending = fetchRetryingBusy("https://api.example/inference/stream", { method: "POST" });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2);
      const res = await pending;
      expect(res.status).toBe(200);
      expect(fn).toHaveBeenCalledTimes(2);
      expect(at[1] - at[0]).toBe(2_000);
    },
  );

  it("honours the delay in the body when the header cannot be read", async () => {
    const { fn } = script(busy("account_busy", undefined, 7), ok());
    const pending = fetchRetryingBusy("https://api.example/inference/stream", {});
    await vi.advanceTimersByTimeAsync(6_999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect((await pending).status).toBe(200);
  });

  it("prefers the header when both are there", async () => {
    const { fn } = script(busy("account_busy", "3", 30), ok());
    const pending = fetchRetryingBusy("https://api.example/inference/stream", {});
    await vi.advanceTimersByTimeAsync(3_001);
    expect((await pending).status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("falls back to the normal back-off when it says nothing about the delay", async () => {
    const { fn } = script(busy("account_busy"), ok());
    const pending = fetchRetryingBusy("https://api.example/inference/stream", {});
    await vi.advanceTimersByTimeAsync(rateLimitConfig.baseS * 1000 - 1);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect((await pending).status).toBe(200);
  });

  it("never waits longer than the ceiling, however long the server asks", async () => {
    const { fn } = script(busy("account_busy", "100000"), ok());
    const pending = fetchRetryingBusy("https://api.example/inference/stream", {});
    await vi.advanceTimersByTimeAsync(rateLimitConfig.capS * 1000 + 1);
    expect((await pending).status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("is bounded: after the retry budget the last answer is handed back for the caller to report", async () => {
    const { fn } = script(busy("account_busy", "1"));
    const pending = fetchRetryingBusy("https://api.example/inference/stream", {});
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await pending;
    expect(res.status).toBe(429);
    expect(fn).toHaveBeenCalledTimes(rateLimitConfig.retries + 1);
  });

  it("is not retried at all when the budget is zero", async () => {
    rateLimitConfig.retries = 0;
    const { fn } = script(busy("account_busy", "1"), ok());
    expect((await fetchRetryingBusy("https://api.example/inference/stream", {})).status).toBe(429);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("ends the wait the moment the person presses Stop, without asking again", async () => {
    const { fn } = script(busy("account_busy", "30"), ok());
    const stop = new AbortController();
    const pending = fetchRetryingBusy("https://api.example/inference/stream", {}, stop.signal);
    const caught = pending.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    stop.abort();
    expect(await caught).toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("what is NOT waited out", () => {
  it.each([
    [
      "a 429 that is not the server's busy answer",
      () => new Response(JSON.stringify({ detail: "rate limited" }), { status: 429 }),
    ],
    ["a 429 with no body", () => new Response("", { status: 429 })],
    [
      "a 429 naming some other error",
      () => new Response(JSON.stringify({ detail: { error: "rate_limited" } }), { status: 429 }),
    ],
    [
      "the credit wall",
      () =>
        new Response(JSON.stringify({ detail: { error: "credit_limit_reached" } }), {
          status: 402,
        }),
    ],
    ["a server error", () => new Response("boom", { status: 503 })],
    [
      "a refusal of this build",
      () =>
        new Response(JSON.stringify({ detail: { error: "client_update_required" } }), {
          status: 426,
        }),
    ],
    ["an expired session", () => new Response("nope", { status: 401 })],
  ])("%s is handed back at once", async (_name, make) => {
    const { fn } = script(make(), ok());
    const res = await fetchRetryingBusy("https://api.example/inference/stream", {});
    expect(res.status).not.toBe(200);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(res.bodyUsed).toBe(false); // the caller still reads its own error body
  });

  it("a busy answer on a call that then works costs the caller nothing but the wait", async () => {
    const { fn } = script(busy("account_busy", "1"), busy("server_busy", "1"), ok());
    const pending = fetchRetryingBusy("https://api.example/inference/stream", {
      method: "POST",
      body: "{}",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(3);
    const sent = fn.mock.calls.map((call) => (call as unknown as [string, RequestInit])[1].body);
    expect(sent).toEqual(["{}", "{}", "{}"]);
  });
});
