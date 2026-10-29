// The default (streaming) chat route used to throw RateLimitError on the server's first "busy" answer, so a round queued
// behind a long generation ended the person's turn with nothing having run. A typed busy answer is now waited out
// (bounded; nothing ran, so asking again is free) and everything else behaves exactly as before.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setApiBase } from "../api/config";
import { setClerkTokenProvider, setSessionRenewer } from "../api/auth";
import { rateLimitConfig, RateLimitError } from "../api/http";
import { CreditLimitError } from "../api/usage";
import { clearRecentFailures, recentFailures } from "../observability/recentFailures";
import { inferRoundStreaming, type InferBody } from "./api";

const body: InferBody = { round_input: { user_text: "hi" } };
const ORIGINAL = { ...rateLimitConfig };
const DTO = { kind: "text", final_text: "done", pending_calls: [], finish_reason: "stop", usage: {}, provider_snapshot: {} };

const busy = (error = "account_busy", retryAfter = "2") =>
  new Response(JSON.stringify({ detail: { error, reason: "line_full", retry_after_s: Number(retryAfter) } }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": retryAfter, "x-request-id": "busy-call" },
  });

const served = () =>
  new Response(new TextEncoder().encode(`event: result\ndata: ${JSON.stringify(DTO)}\n\n`), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });

function script(...answers: Response[]) {
  let calls = 0;
  const fn = vi.fn(async () => answers[Math.min(calls++, answers.length - 1)].clone());
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  Object.assign(rateLimitConfig, ORIGINAL);
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.useFakeTimers();
  setClerkTokenProvider(async () => "tok");
  clearRecentFailures();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setClerkTokenProvider(null);
  setSessionRenewer(null);
  setApiBase(null);
  clearRecentFailures();
  Object.assign(rateLimitConfig, ORIGINAL);
});

describe("a busy answer on the streaming chat route", () => {
  it.each(["account_busy", "server_busy"])("%s is waited out and the round then completes", async (error) => {
    const fn = script(busy(error, "2"), served());
    const pending = inferRoundStreaming(body, () => undefined);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    await expect(pending).resolves.toMatchObject({ kind: "text", final_text: "done" });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("repeats the identical request each time (nothing ran, so nothing can be doubled)", async () => {
    const fn = script(busy("account_busy", "1"), busy("server_busy", "1"), served());
    const pending = inferRoundStreaming(body, () => undefined);
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    const bodies = fn.mock.calls.map((call) => (call as unknown as [string, RequestInit])[1].body);
    expect(new Set(bodies).size).toBe(1);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("a waited-out answer is not a failure: nothing is noted for it", async () => {
    script(busy("account_busy", "1"), served());
    const pending = inferRoundStreaming(body, () => undefined);
    await vi.advanceTimersByTimeAsync(3_000);
    await pending;
    expect(recentFailures()).toEqual([]);
  });

  it("is bounded: when the line never clears the person gets the usual busy answer, and the last one is noted", async () => {
    const fn = script(busy("account_busy", "1"));
    const pending = inferRoundStreaming(body, () => undefined);
    const caught = pending.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    const error = (await caught) as RateLimitError & { requestId?: string };
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.requestId).toBe("busy-call");
    expect(fn).toHaveBeenCalledTimes(rateLimitConfig.retries + 1);
    expect(recentFailures()).toMatchObject([{ where: "turn", code: "account_busy", requestId: "busy-call", status: 429 }]);
  });

  it("ends the wait when the person presses Stop, and asks nothing more", async () => {
    const fn = script(busy("account_busy", "30"), served());
    const stop = new AbortController();
    const caught = inferRoundStreaming(body, () => undefined, stop.signal).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    stop.abort();
    expect(await caught).toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("what the streaming route still does at once", () => {
  it("throws the busy sentence for a 429 that is not the server's busy answer", async () => {
    const fn = script(new Response(JSON.stringify({ detail: "rate limited" }), { status: 429 }), served());
    await expect(inferRoundStreaming(body, () => undefined)).rejects.toBeInstanceOf(RateLimitError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws the credit wall for a 402", async () => {
    const fn = script(new Response(JSON.stringify({ detail: { error: "credit_limit_reached" } }), { status: 402 }), served());
    await expect(inferRoundStreaming(body, () => undefined)).rejects.toBeInstanceOf(CreditLimitError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws a server failure as before, once", async () => {
    const fn = script(new Response("upstream down", { status: 503 }), served());
    await expect(inferRoundStreaming(body, () => undefined)).rejects.toThrow(/503: upstream down/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("serves a round that was never busy exactly as before", async () => {
    const fn = script(served());
    await expect(inferRoundStreaming(body, () => undefined)).resolves.toMatchObject({ final_text: "done" });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
