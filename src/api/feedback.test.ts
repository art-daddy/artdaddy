import { afterEach, describe, expect, it, vi } from "vitest";

// Keep the real auth-header logic, but spy on the 401 notify side effect.
vi.mock("./auth", async (io) => {
  const actual = await io<typeof import("./auth")>();
  return { ...actual, notifyAuthFailure: vi.fn() };
});

import { notifyAuthFailure, setClerkTokenProvider } from "./auth";
import { apiBase } from "./config";
import { submitFeedback, type FeedbackPayload } from "./feedback";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  setClerkTokenProvider(null);
});

describe("submitFeedback", () => {
  it("POSTs to /telemetry/feedback with auth + JSON body and returns true when stored", async () => {
    setClerkTokenProvider(async () => "tok");
    const f = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", f);

    const payload: FeedbackPayload = { kind: "up", bundle: { transcript: "t" } };
    expect(await submitFeedback(payload)).toBe(true);

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${apiBase()}/telemetry/feedback`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toEqual(payload);
    expect(notifyAuthFailure).not.toHaveBeenCalled();
  });

  it("omits the auth header when no secret is set", async () => {
    const f = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", f);
    await submitFeedback({ kind: "up", bundle: {} });
    const init = (f.mock.calls[0] as unknown[])[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("returns false when the server declines to store it (ok:false)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: false })),
    );
    expect(await submitFeedback({ kind: "down", bundle: {} })).toBe(false);
    expect(notifyAuthFailure).not.toHaveBeenCalled();
  });

  it("notifies on 401 and returns false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ detail: "no" }, 401)),
    );
    expect(await submitFeedback({ kind: "report", bundle: {} })).toBe(false);
    expect(notifyAuthFailure).toHaveBeenCalledTimes(1);
  });

  it("returns false on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    expect(await submitFeedback({ kind: "up", bundle: {} })).toBe(false);
    expect(notifyAuthFailure).not.toHaveBeenCalled();
  });

  it("returns false when an ok response body isn't valid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200 })),
    );
    expect(await submitFeedback({ kind: "up", bundle: {} })).toBe(false);
  });

  it("swallows network errors and never throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(submitFeedback({ kind: "up", bundle: {} })).resolves.toBe(false);
  });
});
