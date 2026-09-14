import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchWithRetry, RateLimitError, rateLimitConfig } from "./http";

function res(status: number, retryAfter?: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    body: null,
    headers: {
      get: (k: string) => (k.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null),
    },
  } as unknown as Response;
}

describe("fetchWithRetry", () => {
  const orig = { ...rateLimitConfig };
  beforeEach(() => {
    // Shrink the waits so the retry path runs in ~ms, not 15-60s.
    rateLimitConfig.retries = 2;
    rateLimitConfig.capS = 0.001;
    rateLimitConfig.baseS = 0.001;
    rateLimitConfig.transientBackoffS = 0.001;
  });
  afterEach(() => {
    Object.assign(rateLimitConfig, orig);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("retries a 429, then returns the first non-429", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(200));
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchWithRetry("u", { method: "GET" });
    expect(out.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 attempt + 2 retries
  });

  it("gives up after the retry budget, returning the final 429", async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(429));
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchWithRetry("u", { method: "GET" });
    expect(out.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 + retries(2)
  });

  it("passes a non-429 straight through (no retry)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(500));
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchWithRetry("u", { method: "GET" });
    expect(out.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops retrying the instant the signal aborts", async () => {
    const ctrl = new AbortController();
    const fetchMock = vi.fn().mockImplementation(() => {
      ctrl.abort(); // abort during the first attempt so the backoff wait rejects
      return Promise.resolve(res(429));
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWithRetry("u", { method: "GET" }, ctrl.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry after abort
  });

  it("honors a Retry-After HTTP-date header on a 429 (not just delta-seconds)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(429, new Date(Date.now() + 30_000).toUTCString()))
      .mockResolvedValueOnce(res(200));
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchWithRetry("u", { method: "GET" });
    expect(out.status).toBe(200); // parsed the date -> waited (capped) -> retried
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts a backoff already IN PROGRESS (mid-wait), not just a pre-aborted signal", async () => {
    rateLimitConfig.baseS = 10; // a long backoff so the abort lands DURING the sleep, not before it
    rateLimitConfig.capS = 60;
    const ctrl = new AbortController();
    const fetchMock = vi.fn().mockImplementation(async () => {
      setTimeout(() => ctrl.abort(), 5); // fire ~5ms into the ~10s backoff wait
      return res(429);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWithRetry("u", { method: "GET" }, ctrl.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("RateLimitError is a named, message-carrying error", () => {
    expect(new RateLimitError().message).toMatch(/rate-limited/i);
    expect(new RateLimitError("x").name).toBe("RateLimitError");
  });

  // Transient retry is OPT-IN. The default must stay off: re-firing a paid
  // generation call after an ambiguous timeout can bill the user twice.
  describe("transient (5xx / dropped connection) retry", () => {
    it("does NOT retry a dropped connection by default", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new TypeError("network down"));
      vi.stubGlobal("fetch", fetchMock);
      await expect(fetchWithRetry("u", { method: "GET" })).rejects.toThrow("network down");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("retries a 5xx once when opted in, then returns the success", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(res(500)).mockResolvedValueOnce(res(200));
      vi.stubGlobal("fetch", fetchMock);
      const out = await fetchWithRetry("u", { method: "GET" }, undefined, { transientRetries: 1 });
      expect(out.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("caps the transient retries and surfaces the final 5xx", async () => {
      const fetchMock = vi.fn().mockResolvedValue(res(503));
      vi.stubGlobal("fetch", fetchMock);
      const out = await fetchWithRetry("u", { method: "GET" }, undefined, { transientRetries: 1 });
      expect(out.status).toBe(503);
      expect(fetchMock).toHaveBeenCalledTimes(2); // 1 attempt + 1 retry, no more
    });

    it("retries a dropped connection once when opted in", async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("socket hang up"))
        .mockResolvedValueOnce(res(200));
      vi.stubGlobal("fetch", fetchMock);
      const out = await fetchWithRetry("u", { method: "GET" }, undefined, { transientRetries: 1 });
      expect(out.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not retry a transient failure once the user has aborted", async () => {
      const ctrl = new AbortController();
      const fetchMock = vi.fn().mockImplementation(() => {
        ctrl.abort();
        return Promise.reject(new TypeError("aborted mid-flight"));
      });
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        fetchWithRetry("u", { method: "GET" }, ctrl.signal, { transientRetries: 1 }),
      ).rejects.toThrow("aborted mid-flight");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("keeps the 429 budget separate from the transient budget", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(res(500))
        .mockResolvedValueOnce(res(429))
        .mockResolvedValueOnce(res(429))
        .mockResolvedValueOnce(res(200));
      vi.stubGlobal("fetch", fetchMock);
      const out = await fetchWithRetry("u", { method: "GET" }, undefined, { transientRetries: 1 });
      expect(out.status).toBe(200); // the 5xx retry did not eat a 429 attempt
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
  });
});
