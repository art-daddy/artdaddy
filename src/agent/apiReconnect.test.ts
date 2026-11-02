// The model round on the streaming route, with the one retry of a connection that never answered. What the person
// must be able to rely on: a drop BEFORE the answer starts costs one second and one more request; nothing after the
// first byte of an answer is ever sent again; a recovered drop is not reported as a failure; Stop is final.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setClerkTokenProvider, setSessionRenewer } from "../api/auth";
import { setApiBase } from "../api/config";
import { rateLimitConfig, RECONNECT_DELAY_MS, type RoundWait } from "../api/http";
import { clearRecentFailures, recentFailures } from "../observability/recentFailures";
import { inferRoundStreaming, type InferBody, type RoundDelta } from "./api";
import { RoundHttpError } from "./failureCopy";

const body: InferBody = { round_input: { user_text: "hi" } };
const ORIGINAL = { ...rateLimitConfig };
const DTO = {
  kind: "text",
  final_text: "done",
  pending_calls: [],
  finish_reason: "stop",
  usage: {},
  provider_snapshot: {},
};
const enc = new TextEncoder();
const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

type Step = () => Response;
const served: Step = () =>
  new Response(enc.encode(event("result", DTO)), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
const servedWithWord: Step = () =>
  new Response(enc.encode(event("delta", { kind: "text", text: "hi" }) + event("result", DTO)), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
const drop: Step = () => {
  throw new TypeError("Failed to fetch");
};
const status =
  (code: number): Step =>
  () =>
    new Response("upstream down", { status: code, headers: { "x-request-id": `req-${code}` } });
/** An answer that starts (one word arrives) and then the connection breaks. */
const breaksAfterFirstWord: Step = () => {
  let sent = false;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(enc.encode(event("delta", { kind: "text", text: "hel" })));
        } else controller.error(new TypeError("network error"));
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
};

function script(...steps: Step[]) {
  let calls = 0;
  const fn = vi.fn(async () => steps[Math.min(calls++, steps.length - 1)]());
  vi.stubGlobal("fetch", fn);
  return fn;
}

function run(signal?: AbortSignal) {
  const waits: Array<RoundWait | null> = [];
  const deltas: RoundDelta[] = [];
  const order: string[] = [];
  const sizes: number[] = [];
  const settled = inferRoundStreaming(
    body,
    (d) => {
      order.push("delta");
      deltas.push(d);
    },
    signal,
    {
      wait: (w) => waits.push(w),
      sent: (bytes) => sizes.push(bytes),
      head: () => order.push("head"),
    },
  ).then(
    (value) => ({ value }) as const,
    (error: unknown) => ({ error }) as const,
  );
  return { waits, deltas, order, sizes, settled };
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

describe("a round whose connection dropped before the answer started", () => {
  it("is made again and completes: one result, the same request twice, and nothing reported as a failure", async () => {
    const fn = script(drop, served);
    const { waits, settled } = run();
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
    expect(await settled).toMatchObject({ value: { kind: "text", final_text: "done" } });
    expect(fn).toHaveBeenCalledTimes(2);
    const sent = fn.mock.calls.map((c) => (c as unknown as [string, RequestInit])[1].body);
    expect(new Set(sent).size, "the same request, not a rebuilt one").toBe(1);
    expect(waits).toEqual(["reconnecting", null]);
    expect(recentFailures(), "a failure that was recovered is not a failure").toEqual([]);
  });

  it("with no network at all fails after the one try more, with the connection failure, noted once", async () => {
    const fn = script(drop);
    const { waits, settled } = run();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await settled).toMatchObject({ error: expect.any(TypeError) });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(waits).toEqual(["reconnecting", null]);
    expect(recentFailures()).toHaveLength(1);
  });
});

describe("a 502, 503 or 504 before the answer started", () => {
  it.each([502, 503, 504])(
    "%i is made again once, and a good answer then is the answer",
    async (code) => {
      const fn = script(status(code), served);
      const { settled } = run();
      await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
      expect(await settled).toMatchObject({ value: { final_text: "done" } });
      expect(fn).toHaveBeenCalledTimes(2);
      expect(recentFailures()).toEqual([]);
    },
  );

  it.each([502, 503, 504])(
    "%i twice is the failure the person is told of, with its words and request id, noted once",
    async (code) => {
      const fn = script(status(code), status(code), served);
      const { settled } = run();
      await vi.advanceTimersByTimeAsync(60_000);
      const out = (await settled) as { error: RoundHttpError & { requestId?: string } };
      expect(out.error).toBeInstanceOf(RoundHttpError);
      expect(out.error.message).toMatch(new RegExp(`${code}: upstream down`));
      expect(out.error.requestId).toBe(`req-${code}`);
      expect(fn).toHaveBeenCalledTimes(2);
      expect(recentFailures()).toHaveLength(1);
    },
  );
});

describe("once the answer has started", () => {
  it("nothing is ever sent again: a connection that breaks after the first word is the failure", async () => {
    const fn = script(breaksAfterFirstWord, served);
    const { deltas, waits, settled } = run();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await settled).toMatchObject({ error: expect.any(TypeError) });
    expect(deltas).toEqual([{ kind: "text", text: "hel" }]);
    expect(fn, "a round that had started is never asked for again").toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("nothing is ever sent again: an answer that ends without a result is the failure", async () => {
    const noResult: Step = () =>
      new Response(enc.encode(event("delta", { kind: "text", text: "x" })), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    const fn = script(noResult, served);
    const { settled } = run();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await settled).toMatchObject({
      error: { message: expect.stringMatching(/without a result/) },
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("what the round tells the turn's timing", () => {
  it("reports the request's size in BYTES, as sent, once per round (not once per attempt)", async () => {
    const fn = script(drop, served);
    const { sizes, settled } = run();
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
    await settled;
    const sentBody = (fn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string;
    expect(sizes).toEqual([new TextEncoder().encode(sentBody).length]);
  });

  it("counts a multi-byte message by its bytes, not its characters", async () => {
    const fn = script(served);
    const wide: InferBody = { round_input: { user_text: "héllo wörld 🎬 日本語" } };
    const sizes: number[] = [];
    await inferRoundStreaming(wide, () => undefined, undefined, { sent: (b) => sizes.push(b) });
    const sentBody = (fn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string;
    expect(sizes[0]).toBe(new TextEncoder().encode(sentBody).length);
    expect(sizes[0]).toBeGreaterThan(sentBody.length);
  });

  it("hears the server's answer begin before the first word, and not at all when none came", async () => {
    script(servedWithWord);
    const answered = run();
    await vi.advanceTimersByTimeAsync(0);
    await answered.settled;
    expect(answered.order).toEqual(["head", "delta"]);

    script(drop);
    const never = run();
    await vi.advanceTimersByTimeAsync(60_000);
    await never.settled;
    expect(never.order).toEqual([]);
  });

  it("hears it for a round the server then refused: the answer began, and said no", async () => {
    script(status(500));
    const refused = run();
    await vi.advanceTimersByTimeAsync(60_000);
    await refused.settled;
    expect(refused.order).toEqual(["head"]);
  });
});

describe("when the person presses Stop", () => {
  it("between the drop and the second try ends the round as a Stop, and the second request is never sent", async () => {
    const fn = script(drop, served);
    const stop = new AbortController();
    const { waits, settled } = run(stop.signal);
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS / 2);
    stop.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await settled).toMatchObject({ error: { name: "AbortError" } });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(waits).toEqual(["reconnecting", null]);
  });
});
