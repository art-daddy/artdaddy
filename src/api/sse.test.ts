import { describe, expect, it, vi } from "vitest";

import { streamSSE, type SSEMessage } from "./sse";

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("streamSSE", () => {
  it("parses event/data frames and calls onEvent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          'event: turn_start\ndata: {"request_id":"r1"}\n\n',
          'event: final\ndata: {"text":"done"}\n\n',
        ]),
      ),
    );
    const events: SSEMessage[] = [];
    await streamSSE("http://x/msg", { text: "hi" }, (e) => events.push(e));
    expect(events.map((e) => e.event)).toEqual(["turn_start", "final"]);
    expect(events[1].data).toEqual({ text: "done" });
  });

  it("handles chunk splits, comments, and non-JSON data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse([": ping\n", "event: text\nda", "ta: plain\n\n"])),
    );
    const events: SSEMessage[] = [];
    await streamSSE("http://x", {}, (e) => events.push(e));
    expect(events).toEqual([{ event: "text", data: "plain" }]);
  });

  it("throws on a non-ok response including the body text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    await expect(streamSSE("http://x", {}, () => undefined)).rejects.toThrow(/500/);
  });

  it("throws when there is no response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, body: null }) as Response),
    );
    await expect(streamSSE("http://x", {}, () => undefined)).rejects.toThrow(/no response body/);
  });

  it("POSTs JSON with an SSE accept header", async () => {
    const fetchMock = vi.fn(async () => sseResponse(["event: turn_done\ndata: {}\n\n"]));
    vi.stubGlobal("fetch", fetchMock);
    await streamSSE("http://x/msg", { a: 1 }, () => undefined);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ a: 1 });
    expect((init.headers as Record<string, string>).Accept).toContain("event-stream");
  });
});
