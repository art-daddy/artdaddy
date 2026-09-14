import { describe, expect, it, vi } from "vitest";

import { ApiError, api } from "./client";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("api client", () => {
  it("GET /health", async () => {
    const f = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", f);
    const r = await api.health();
    expect(r.ok).toBe(true);
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain("/health");
  });

  it("POST /stop hits the right path with a POST", async () => {
    const f = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", f);
    await api.stop();
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain("/stop");
    expect(((f.mock.calls[0] as unknown[])[1] as RequestInit).method).toBe("POST");
  });

  it("throws ApiError with the server detail on non-ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ detail: "nope" }, 404)),
    );
    await expect(api.stop()).rejects.toMatchObject({ status: 404, message: "nope" });
  });

  it("falls back to statusText when there is no detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500, statusText: "err" })),
    );
    await expect(api.stop()).rejects.toBeInstanceOf(ApiError);
  });

  it("returns undefined for 204 responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    expect(await api.stop()).toBeUndefined();
  });
});
