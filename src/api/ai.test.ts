import { afterEach, describe, expect, it, vi } from "vitest";

// Fixed correlation ids so we can assert they're merged into the request body.
// A plain function (not a vi.fn) so `restoreMocks` never resets its return.
vi.mock("../observability/sentry", () => ({
  correlationBody: () => ({ project_id: "p1", transcript_id: "t1" }),
  identifyUser: async () => undefined,
}));
// Keep the real auth-header logic, but spy on the 401 notify side effect.
vi.mock("./auth", async (io) => {
  const actual = await io<typeof import("./auth")>();
  return { ...actual, notifyAuthFailure: vi.fn() };
});
// Keep the real CreditLimitError class, but spy on the over-limit side effect.
vi.mock("./usage", async (io) => {
  const actual = await io<typeof import("./usage")>();
  return { ...actual, markOverLimit: vi.fn() };
});

import { notifyAuthFailure, setClerkTokenProvider } from "./auth";
import { apiBase } from "./config";
import { CreditLimitError, markOverLimit } from "./usage";
import { callAiProxy, fromB64, toB64 } from "./ai";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  setClerkTokenProvider(null);
});

describe("callAiProxy", () => {
  it("POSTs to /ai/{name}, forwards the signal, and returns the parsed body", async () => {
    setClerkTokenProvider(async () => "tok");
    const payload = {
      result: { foo: 1 },
      media: [{ b64: "AA", ext: "png" }],
      metrics: { cost_usd: 0.5 },
    };
    const f = vi.fn(async () => jsonResponse(payload));
    vi.stubGlobal("fetch", f);

    const ctrl = new AbortController();
    const body = { args: { a: 1 }, media: { m1: { b64: "QQ", ext: "png" } } };
    const out = await callAiProxy("gen_image", body, ctrl.signal);

    expect(out).toEqual(payload);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${apiBase()}/ai/gen_image`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer tok");
    // Body = the caller's body merged with the correlation ids.
    expect(JSON.parse(init.body as string)).toEqual({
      ...body,
      project_id: "p1",
      transcript_id: "t1",
    });
    expect(init.signal).toBe(ctrl.signal);
    expect(notifyAuthFailure).not.toHaveBeenCalled();
    expect(markOverLimit).not.toHaveBeenCalled();
  });

  it("omits the auth header when no secret is stored", async () => {
    const f = vi.fn(async () => jsonResponse({ result: {} }));
    vi.stubGlobal("fetch", f);
    await callAiProxy("x", { args: {} });
    const init = (f.mock.calls[0] as unknown[])[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("on 401 prompts the user AND tells the model to stop rather than retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"detail":"invalid or expired session"}', { status: 401 })),
    );
    // The raw body reads as a generation failure, so the model retried a paid call that could not
    // succeed. Seen twice in one session on generate_music.
    const err = (await callAiProxy("generate_music", { args: {} }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err.message).toMatch(/sign in again/i);
    expect(err.message).toMatch(/do not retry/i);
    expect(err.message).not.toMatch(/invalid or expired session/);
    expect(notifyAuthFailure).toHaveBeenCalledTimes(1);
    expect(markOverLimit).not.toHaveBeenCalled();
  });

  it("marks over-limit and throws CreditLimitError on 402 with a JSON detail", async () => {
    const detail = { used: 10, limit: 10 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ detail }, 402)),
    );

    const err = await callAiProxy("x", { args: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CreditLimitError);
    expect((err as CreditLimitError).detail).toEqual(detail);
    expect(markOverLimit).toHaveBeenCalledWith(detail);
    expect(notifyAuthFailure).not.toHaveBeenCalled();
  });

  it("uses the raw text as the 402 detail when the body isn't JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("plain limit msg", { status: 402 })),
    );
    const err = await callAiProxy("x", { args: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CreditLimitError);
    expect(markOverLimit).toHaveBeenCalledWith("plain limit msg");
  });

  it("falls back to the whole body when a 402 JSON has no detail field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ nope: 1 }, 402)),
    );
    await expect(callAiProxy("x", { args: {} })).rejects.toBeInstanceOf(CreditLimitError);
    expect(markOverLimit).toHaveBeenCalledWith('{"nope":1}');
  });

  it("throws an Error with the status and body text on other non-ok responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    await expect(callAiProxy("x", { args: {} })).rejects.toThrow(/^500: boom$/);
    expect(notifyAuthFailure).not.toHaveBeenCalled();
  });

  it("falls back to statusText when the error body is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503, statusText: "Service Unavailable" })),
    );
    await expect(callAiProxy("x", { args: {} })).rejects.toThrow(/^503: Service Unavailable$/);
  });

  it("tolerates a response whose body can't be read as text", async () => {
    const fake = {
      ok: false,
      status: 500,
      statusText: "err",
      text: () => Promise.reject(new Error("unreadable")),
    } as unknown as Response;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fake),
    );
    await expect(callAiProxy("x", { args: {} })).rejects.toThrow(/^500: err$/);
  });
});

describe("base64 round-trip", () => {
  it("round-trips arbitrary bytes, including high / non-ASCII values", () => {
    const bytes = new Uint8Array([0, 1, 2, 65, 90, 127, 128, 200, 254, 255]);
    const b64 = toB64(bytes);
    expect(typeof b64).toBe("string");
    expect(fromB64(b64)).toEqual(bytes);
  });

  it("handles an empty buffer", () => {
    expect(toB64(new Uint8Array())).toBe("");
    expect(fromB64("")).toEqual(new Uint8Array());
  });
});
