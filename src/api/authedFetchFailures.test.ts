// Every paid call goes through authedFetch, so it is the one place a failed paid call is noted for a problem report.
//
// Noting is observation only: whatever it does, the caller must still get the same response (body unread), the same
// error, and nothing but paid calls is recorded. A retried 429 that finally succeeds is not a failure the person met.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authedFetch, setClerkTokenProvider, setSessionRenewer } from "./auth";
import { fetchWithRetry, rateLimitConfig } from "./http";
import { clearRecentFailures, recentFailures } from "../observability/recentFailures";

const BASE = "https://api.example";

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function serve(...answers: (Response | Error)[]) {
  let call = 0;
  const fn = vi.fn(async () => {
    const next = answers[Math.min(call++, answers.length - 1)];
    if (next instanceof Error) throw next;
    return next.clone();
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  setClerkTokenProvider(async () => "token");
  clearRecentFailures();
});

afterEach(() => {
  setClerkTokenProvider(null);
  setSessionRenewer(null);
  vi.unstubAllGlobals();
  clearRecentFailures();
});

describe("a failed paid call is noted once, with its code and request id", () => {
  it("notes the typed code the server answered with, and leaves the body readable for the caller", async () => {
    const body = { detail: { error: "credit_limit_reached", used: 150, limit: 150 } };
    serve(reply(402, body, { "x-request-id": "3f9c1a2b7d4e5f60" }));
    const res = await authedFetch(`${BASE}/inference/stream`, { method: "POST" });
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual(body);
    expect(recentFailures()).toMatchObject([
      { where: "turn", code: "credit_limit_reached", status: 402, requestId: "3f9c1a2b7d4e5f60" },
    ]);
  });

  it.each([
    ["/ai/vision_video", "vision", { detail: { error: "account_busy" } }, 429, "account_busy"],
    ["/ai/generate_image", "generation", { detail: { error: "server_busy" } }, 429, "server_busy"],
    ["/ai/generate_video", "generation", { error: "update_required" }, 426, "update_required"],
  ])("%s", async (path, where, body, status, code) => {
    serve(reply(status, body, { "x-request-id": "rid1" }));
    await authedFetch(`${BASE}${path}`, { method: "POST" });
    expect(recentFailures()).toMatchObject([{ where, code, status, requestId: "rid1" }]);
  });

  it("falls back to the status when the body says nothing typed", async () => {
    serve(reply(503, "<html>bad gateway</html>", { "x-request-id": "rid2" }));
    await authedFetch(`${BASE}/inference`, { method: "POST" });
    expect(recentFailures()).toMatchObject([{ where: "turn", code: "http_503", status: 503, requestId: "rid2" }]);
  });

  it("notes a call that never got an answer as a network failure, and rethrows the same error", async () => {
    const down = new TypeError("Failed to fetch");
    serve(down);
    await expect(authedFetch(`${BASE}/ai/vision_image`, { method: "POST" })).rejects.toBe(down);
    expect(recentFailures()).toMatchObject([{ where: "vision", code: "network" }]);
  });
});

describe("what is not a failure the person met", () => {
  it("notes nothing for an answer that worked", async () => {
    serve(reply(200, { ok: true }, { "x-request-id": "rid" }));
    await authedFetch(`${BASE}/inference/stream`, { method: "POST" });
    expect(recentFailures()).toEqual([]);
  });

  it.each(["/usage", "/me", "/auth/verify", "/telemetry/app", "/telemetry/feedback", "/billing/checkout"])(
    "notes nothing for a failing %s, which is not a paid call",
    async (path) => {
      serve(reply(500, { detail: { error: "boom" } }, { "x-request-id": "rid" }));
      await authedFetch(`${BASE}${path}`);
      expect(recentFailures()).toEqual([]);
    },
  );

  it("notes nothing when the person pressed Stop", async () => {
    serve(new DOMException("Aborted", "AbortError"));
    await expect(authedFetch(`${BASE}/inference/stream`, { method: "POST" })).rejects.toThrow("Aborted");
    expect(recentFailures()).toEqual([]);
  });

  it("notes nothing for a 429 the retry layer waited out", async () => {
    Object.assign(rateLimitConfig, { baseS: 0, capS: 1, retries: 3 });
    serve(reply(429, { detail: { error: "account_busy" } }), reply(429, { detail: { error: "account_busy" } }), reply(200, { ok: true }));
    const res = await authedFetch(`${BASE}/ai/vision_video`, { method: "POST" }, (u, i) => fetchWithRetry(u, i));
    expect(res.status).toBe(200);
    expect(recentFailures()).toEqual([]);
  });

  it("notes the answer that finally ended a retry budget", async () => {
    Object.assign(rateLimitConfig, { baseS: 0, capS: 1, retries: 1 });
    serve(reply(429, { detail: { error: "account_busy" } }, { "x-request-id": "last" }));
    const res = await authedFetch(`${BASE}/ai/vision_video`, { method: "POST" }, (u, i) => fetchWithRetry(u, i));
    expect(res.status).toBe(429);
    expect(recentFailures()).toMatchObject([{ code: "account_busy", requestId: "last" }]);
  });

  it("notes nothing for a 401 that renewal turned into success", async () => {
    setSessionRenewer(async () => true);
    serve(reply(401, { detail: "expired" }), reply(200, { ok: true }));
    const res = await authedFetch(`${BASE}/inference`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(recentFailures()).toEqual([]);
  });
});

describe("observing never changes what the caller gets", () => {
  it("hands back a response it could not copy, unchanged", async () => {
    const fake = { status: 500, ok: false, headers: new Headers({ "x-request-id": "rid" }), text: async () => "x" };
    vi.stubGlobal("fetch", vi.fn(async () => fake));
    const res = await authedFetch(`${BASE}/inference`, { method: "POST" });
    expect(res).toBe(fake);
    expect(recentFailures()).toMatchObject([{ code: "http_500", requestId: "rid" }]);
  });

  it("hands back a response with no headers at all, unchanged", async () => {
    const fake = { status: 502 };
    vi.stubGlobal("fetch", vi.fn(async () => fake));
    const res = await authedFetch(`${BASE}/ai/generate_image`, { method: "POST" });
    expect(res).toBe(fake);
    expect(recentFailures()).toMatchObject([{ where: "generation", code: "http_502" }]);
  });
});
