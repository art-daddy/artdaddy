import { afterEach, describe, expect, it, vi } from "vitest";

// ensureContract is a best-effort preload; stub it so inferRound doesn't hit the
// real contract loader.
vi.mock("../contract", () => ({ ensureContract: vi.fn(async () => {}) }));
// Keep real auth-header logic; spy the 401 side effect.
vi.mock("../api/auth", async (io) => {
  const actual = await io<typeof import("../api/auth")>();
  return { ...actual, notifyAuthFailure: vi.fn() };
});
// Keep the real CreditLimitError class; spy the over-limit side effect.
vi.mock("../api/usage", async (io) => {
  const actual = await io<typeof import("../api/usage")>();
  return { ...actual, markOverLimit: vi.fn() };
});

import { notifyAuthFailure, setClerkTokenProvider } from "../api/auth";
import { apiBase, setApiBase } from "../api/config";
import { CreditLimitError, markOverLimit } from "../api/usage";
import { inferRound, inferRoundStreaming, type InferBody } from "./api";

function res(data: unknown, status = 200): Response {
  return new Response(typeof data === "string" ? data : JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
const body: InferBody = { round_input: { user_text: "hi" } };

afterEach(() => {
  setClerkTokenProvider(null);
  setApiBase(null);
});

describe("inferRound", () => {
  it("POSTs to /inference with auth + signal and returns the parsed result", async () => {
    setClerkTokenProvider(async () => "tok");
    const dto = { kind: "text", final_text: "ok" };
    const f = vi.fn(async () => res(dto));
    vi.stubGlobal("fetch", f);

    const ctrl = new AbortController();
    const out = await inferRound(body, ctrl.signal);

    expect(out).toEqual(dto);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${apiBase()}/inference`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toEqual(body);
    expect(init.signal).toBe(ctrl.signal);
  });

  it("notifies auth failure and throws on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => res("nope", 401)),
    );
    await expect(inferRound(body)).rejects.toThrow(/401/);
    expect(notifyAuthFailure).toHaveBeenCalled();
  });

  it("throws CreditLimitError + marks over-limit on 402 (parsed detail)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => res({ detail: { error: "credit_limit_reached" } }, 402)),
    );
    await expect(inferRound(body)).rejects.toBeInstanceOf(CreditLimitError);
    expect(markOverLimit).toHaveBeenCalledWith({ error: "credit_limit_reached" });
  });

  it("falls back to raw text when the 402 body isn't JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => res("too poor", 402)),
    );
    await expect(inferRound(body)).rejects.toBeInstanceOf(CreditLimitError);
    expect(markOverLimit).toHaveBeenCalledWith("too poor");
  });

  it("throws a generic error on any other non-ok status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => res("boom", 500)),
    );
    await expect(inferRound(body)).rejects.toThrow(/500: boom/);
  });
});

/** An SSE response body built from raw frames. */
function sse(frames: string[], status = 200): Response {
  return new Response(new TextEncoder().encode(frames.join("")), {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}
const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe("inferRoundStreaming", () => {
  const dto = { kind: "text", final_text: "hello" };

  it("reports each delta as it arrives and returns the terminal result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([
          frame("delta", { kind: "reasoning", text: "think" }),
          frame("delta", { kind: "text", text: "hel" }),
          frame("delta", { kind: "text", text: "lo" }),
          frame("result", dto),
        ]),
      ),
    );
    const seen: unknown[] = [];

    const out = await inferRoundStreaming(body, (d) => seen.push(d));

    expect(out).toEqual(dto);
    expect(seen).toEqual([
      { kind: "reasoning", text: "think" },
      { kind: "text", text: "hel" },
      { kind: "text", text: "lo" },
    ]);
  });

  it("reassembles the streamed text into what the result carries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([
          frame("delta", { kind: "text", text: "hel" }),
          frame("delta", { kind: "text", text: "lo" }),
          frame("result", dto),
        ]),
      ),
    );
    const chunks: string[] = [];

    const out = await inferRoundStreaming(body, (d) => {
      if (d.kind === "text") chunks.push(d.text);
    });

    expect(chunks.join("")).toBe(out.final_text);
  });

  it("posts to /inference/stream, asking for SSE, with auth and the abort signal", async () => {
    setClerkTokenProvider(async () => "tok");
    const f = vi.fn(async () => sse([frame("result", dto)]));
    vi.stubGlobal("fetch", f);
    const ctrl = new AbortController();

    await inferRoundStreaming(body, () => {}, ctrl.signal);

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${apiBase()}/inference/stream`);
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toBe("text/event-stream");
    expect(headers.Authorization).toBe("Bearer tok");
    expect(init.signal).toBe(ctrl.signal);
  });

  it("falls back to the plain round against a server that has no stream route", async () => {
    setApiBase("http://old-a.test");
    const f = vi
      .fn()
      .mockImplementationOnce(async () => res("Not Found", 404))
      .mockImplementation(async () => res(dto));
    vi.stubGlobal("fetch", f);

    const out = await inferRoundStreaming(body, () => {});

    expect(out).toEqual(dto);
    expect((f.mock.calls[1] as unknown as [string])[0]).toBe("http://old-a.test/inference");
  });

  it("remembers per SERVER that there is no stream route, instead of re-asking every round", async () => {
    // A 404 per round would double every request against an older server -- and the memo
    // must be keyed by server, or pointing the app at an up-to-date one would never stream.
    setApiBase("http://old-b.test");
    const f = vi
      .fn()
      .mockImplementationOnce(async () => res("Not Found", 404))
      .mockImplementation(async () => res(dto));
    vi.stubGlobal("fetch", f);

    await inferRoundStreaming(body, () => {});
    const afterFirst = f.mock.calls.length;
    await inferRoundStreaming(body, () => {});

    const urls = f.mock.calls.slice(afterFirst).map((c) => (c as unknown as [string])[0]);
    expect(urls).toEqual(["http://old-b.test/inference"]);

    // a DIFFERENT server is still offered the stream
    setApiBase("http://new-b.test");
    const g = vi.fn(async () => sse([frame("result", dto)]));
    vi.stubGlobal("fetch", g);
    await inferRoundStreaming(body, () => {});
    expect((g.mock.calls[0] as unknown as [string])[0]).toBe("http://new-b.test/inference/stream");
  });

  it("does NOT silently re-run the round when the stream dies after it started", async () => {
    // The failure direction that costs money: the server has already burned tokens for
    // this round, so quietly retrying it on /inference would charge the user twice for
    // one turn. It must surface instead.
    const f = vi.fn(async () => sse([frame("delta", { kind: "text", text: "par" })]));
    vi.stubGlobal("fetch", f);

    await expect(inferRoundStreaming(body, () => {})).rejects.toThrow(/without a result/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("maps 402 to CreditLimitError just like the plain round", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => res({ detail: { error: "credit_limit_reached" } }, 402)),
    );
    await expect(inferRoundStreaming(body, () => {})).rejects.toBeInstanceOf(CreditLimitError);
    expect(markOverLimit).toHaveBeenCalledWith({ error: "credit_limit_reached" });
  });

  it("notifies auth failure on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => res("nope", 401)),
    );
    await expect(inferRoundStreaming(body, () => {})).rejects.toThrow(/401/);
    expect(notifyAuthFailure).toHaveBeenCalled();
  });
});
