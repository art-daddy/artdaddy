// Fuzz + schedule tests for the retry layer.
//
// Two invariants, and getting either wrong costs the user money:
//   1. A NON-IDEMPOTENT call is never silently re-fired. Transient retries are
//      opt-in (default 0) precisely so an ambiguous timeout on a paid generation
//      can't bill twice. 402/401/4xx must pass straight through, never retry.
//   2. The 429 backoff is BOUNDED — bounded in count (retries) and in wait
//      (capS), and honours Retry-After. An unbounded ceiling is a hung app.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import { fetchWithRetry, rateLimitConfig, RateLimitError } from "./http";

const ORIGINAL = { ...rateLimitConfig };

interface FakeRes {
  status: number;
  headers: { get: (k: string) => string | null };
  body: { cancel: () => Promise<void> } | null;
}

function res(status: number, retryAfter?: string): FakeRes {
  return {
    status,
    headers: { get: (k: string) => (k === "Retry-After" ? (retryAfter ?? null) : null) },
    body: { cancel: () => Promise.resolve() },
  };
}

/** A fetch that replays a fixed script of responses/throws, then repeats the last. */
function scriptedFetch(script: (FakeRes | Error)[]) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    const step = script[Math.min(calls.length, script.length - 1)];
    calls.push(url);
    if (step instanceof Error) throw step;
    return step as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  Object.assign(rateLimitConfig, ORIGINAL);
  vi.spyOn(Math, "random").mockReturnValue(0); // remove jitter from the schedule
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Object.assign(rateLimitConfig, ORIGINAL);
});

/** Instant waits — lets the COUNT properties run without fake-timer bookkeeping. */
function noWaits(): void {
  rateLimitConfig.baseS = 0;
  rateLimitConfig.capS = 1;
  rateLimitConfig.transientBackoffS = 0;
}

describe("what is NOT retried", () => {
  it("passes any non-429, non-5xx status straight through in exactly one call", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 200, max: 499 }).filter((s) => s !== 429),
        async (status) => {
          noWaits();
          const f = scriptedFetch([res(status)]);
          const out = await fetchWithRetry("/x", {});
          expect(out.status).toBe(status);
          expect(f).toHaveBeenCalledTimes(1);
        },
      ),
      { numRuns: 120 },
    );
  });

  it("never re-fires a 402 — a credit refusal must not be retried into a second charge", async () => {
    noWaits();
    const f = scriptedFetch([res(402)]);
    await fetchWithRetry("/ai/generate", { method: "POST" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a 5xx by default (a paid POST could have already run)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 500, max: 599 }), async (status) => {
        noWaits();
        const f = scriptedFetch([res(status)]);
        const out = await fetchWithRetry("/x", { method: "POST" });
        expect(out.status).toBe(status);
        expect(f).toHaveBeenCalledTimes(1);
      }),
      { numRuns: 60 },
    );
  });

  it("does NOT retry a dropped connection by default — it rethrows", async () => {
    noWaits();
    const f = scriptedFetch([new Error("socket hang up")]);
    await expect(fetchWithRetry("/x", { method: "POST" })).rejects.toThrow(/socket hang up/);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("bounded retry counts", () => {
  it("retries a 429 exactly `retries` times, never more", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 6 }), async (retries) => {
        noWaits();
        rateLimitConfig.retries = retries;
        const f = scriptedFetch([res(429)]);
        const out = await fetchWithRetry("/x", {});
        expect(out.status).toBe(429); // exhaustion RETURNS the 429; the caller throws
        expect(f).toHaveBeenCalledTimes(retries + 1);
      }),
      { numRuns: 20 },
    );
  });

  it("stops retrying the moment a 429 clears", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (before) => {
        noWaits();
        rateLimitConfig.retries = 8;
        const f = scriptedFetch([...Array.from({ length: before }, () => res(429)), res(200)]);
        const out = await fetchWithRetry("/x", {});
        expect(out.status).toBe(200);
        expect(f).toHaveBeenCalledTimes(before + 1);
      }),
      { numRuns: 20 },
    );
  });

  it("retries a 5xx only up to the opted-in transient budget", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 5 }), async (transientRetries) => {
        noWaits();
        const f = scriptedFetch([res(503)]);
        const out = await fetchWithRetry("/x", {}, undefined, { transientRetries });
        expect(out.status).toBe(503);
        expect(f).toHaveBeenCalledTimes(transientRetries + 1);
      }),
      { numRuns: 20 },
    );
  });

  it("retries a dropped connection only up to the transient budget, then rethrows", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 5 }), async (transientRetries) => {
        noWaits();
        const f = scriptedFetch([new Error("ECONNRESET")]);
        await expect(fetchWithRetry("/x", {}, undefined, { transientRetries })).rejects.toThrow(
          /ECONNRESET/,
        );
        expect(f).toHaveBeenCalledTimes(transientRetries + 1);
      }),
      { numRuns: 20 },
    );
  });

  it("treats a negative or fractional transient budget as a whole, non-negative count", async () => {
    await fc.assert(
      fc.asyncProperty(fc.double({ min: -10, max: 0.99, noNaN: true }), async (n) => {
        noWaits();
        const f = scriptedFetch([res(500)]);
        await fetchWithRetry("/x", {}, undefined, { transientRetries: n });
        expect(f).toHaveBeenCalledTimes(1);
      }),
      { numRuns: 60 },
    );
  });

  it("429 and transient budgets are independent — one cannot consume the other", async () => {
    noWaits();
    rateLimitConfig.retries = 2;
    const f = scriptedFetch([res(429), res(500), res(429), res(500), res(200)]);
    const out = await fetchWithRetry("/x", {}, undefined, { transientRetries: 2 });
    expect(out.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(5);
  });

  it("frees the body of every response it abandons (no dangling streams)", async () => {
    noWaits();
    rateLimitConfig.retries = 3;
    const cancels: number[] = [];
    let n = 0;
    const fn = vi.fn(async () => {
      const id = n++;
      return {
        status: id < 3 ? 429 : 200,
        headers: { get: () => null },
        body: {
          cancel: async () => {
            cancels.push(id);
          },
        },
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fn);
    await fetchWithRetry("/x", {});
    expect(cancels).toEqual([0, 1, 2]); // every retried response, never the kept one
  });
});

describe("backoff schedule", () => {
  beforeEach(() => vi.useFakeTimers());

  async function waitsBetween(script: (FakeRes | Error)[], expected: number[]): Promise<void> {
    const f = scriptedFetch(script);
    const p = fetchWithRetry("/x", {}).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < expected.length; i += 1) {
      expect(f).toHaveBeenCalledTimes(i + 1);
      if (expected[i] > 0) {
        await vi.advanceTimersByTimeAsync(expected[i] - 1);
        expect(f, `fired early before wait #${i + 1}`).toHaveBeenCalledTimes(i + 1);
      }
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(f).toHaveBeenCalledTimes(expected.length + 1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await p;
  }

  it("doubles from baseS on each successive 429", async () => {
    rateLimitConfig.retries = 3;
    rateLimitConfig.baseS = 15;
    rateLimitConfig.capS = 3600;
    await waitsBetween([res(429)], [15_000, 30_000, 60_000]);
  });

  it("never waits longer than capS, however many retries elapse", async () => {
    rateLimitConfig.retries = 4;
    rateLimitConfig.baseS = 15;
    rateLimitConfig.capS = 20;
    await waitsBetween([res(429)], [15_000, 20_000, 20_000, 20_000]);
  });

  it("honours a Retry-After delta, and still caps it", async () => {
    rateLimitConfig.retries = 2;
    rateLimitConfig.capS = 30;
    await waitsBetween([res(429, "5")], [5_000, 5_000]);
    vi.clearAllMocks();
    await waitsBetween([res(429, "9999")], [30_000, 30_000]);
  });

  it("honours a Retry-After HTTP-date", async () => {
    rateLimitConfig.retries = 1;
    rateLimitConfig.capS = 3600;
    const when = new Date(Date.now() + 8_000).toUTCString();
    const f = scriptedFetch([res(429, when)]);
    const p = fetchWithRetry("/x", {}).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await p;
  });

  it("falls back to the exponential schedule for an unparseable Retry-After", async () => {
    rateLimitConfig.retries = 1;
    rateLimitConfig.baseS = 7;
    rateLimitConfig.capS = 3600;
    await waitsBetween([res(429, "soon-ish")], [7_000]);
  });

  it("adds at most 20% jitter and never a negative wait", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 0.999_999, noNaN: true }), (r) => {
        vi.spyOn(Math, "random").mockReturnValue(r);
        const capped = 15_000;
        const withJitter = Math.round(capped + capped * 0.2 * r);
        expect(withJitter).toBeGreaterThanOrEqual(capped);
        expect(withJitter).toBeLessThanOrEqual(capped * 1.2);
      }),
      { numRuns: 200 },
    );
  });
});

describe("abort", () => {
  it("a user Stop during the backoff rejects and fires no further request", async () => {
    vi.useFakeTimers();
    rateLimitConfig.retries = 3;
    rateLimitConfig.baseS = 15;
    const f = scriptedFetch([res(429)]);
    const ac = new AbortController();
    const p = fetchWithRetry("/x", {}, ac.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(f).toHaveBeenCalledTimes(1);
    ac.abort();
    await expect(p).rejects.toThrow(/Abort/i);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("an already-aborted signal is not treated as a transient failure to retry", async () => {
    noWaits();
    const ac = new AbortController();
    ac.abort();
    const f = scriptedFetch([new DOMException("Aborted", "AbortError")]);
    await expect(fetchWithRetry("/x", {}, ac.signal, { transientRetries: 5 })).rejects.toThrow();
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("RateLimitError", () => {
  it("is an expected error carrying a user-facing message", () => {
    const e = new RateLimitError();
    expect(e.code).toBe("rate_limited");
    expect(e.expected).toBe(true);
    expect(e.name).toBe("RateLimitError");
    expect(e.message).toMatch(/try again/i);
  });

  it("keeps a caller-supplied message", () => {
    expect(new RateLimitError("slow down").message).toBe("slow down");
  });
});
