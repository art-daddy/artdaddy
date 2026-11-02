// A model round whose connection never answered, or answered 502, 503 or 504, is asked for once more, one second later,
// and never again. Every other answer keeps the single attempt it always had. This layer only ever sees the HEAD of an
// answer: nothing here can repeat a request once its first byte has arrived (agent/apiReconnect.test.ts covers that end).
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchRound, RECONNECT_DELAY_MS, rateLimitConfig, type RoundWait } from "./http";

const URL = "https://api.example/inference/stream";
const BODY = JSON.stringify({ round_input: { user_text: "hi" } });
const ORIGINAL = { ...rateLimitConfig };

type Step = "drop" | "busy" | number;

const busy = () =>
  new Response(
    JSON.stringify({ detail: { error: "account_busy", reason: "line_full", retry_after_s: 1 } }),
    { status: 429, headers: { "Retry-After": "1" } },
  );

/** A fetch that replays the steps (then repeats the last one): a dropped connection, the server's busy answer, or a status. */
function script(...steps: Step[]) {
  const sent: Array<{ at: number; body: unknown }> = [];
  const answers: Response[] = [];
  const fn = vi.fn(async (_url: string, init?: RequestInit) => {
    const step = steps[Math.min(sent.length, steps.length - 1)];
    sent.push({ at: Date.now(), body: init?.body });
    if (step === "drop") throw new TypeError("Failed to fetch");
    const res = step === "busy" ? busy() : new Response(`answer ${step}`, { status: step });
    answers.push(res);
    return res;
  });
  vi.stubGlobal("fetch", fn);
  return { fn, sent, answers };
}

/** Starts a round's fetch, keeping what the chat would be told and how it ended. */
function start(signal?: AbortSignal) {
  const waits: Array<RoundWait | null> = [];
  const outcome: { res?: Response; error?: unknown; done: boolean } = { done: false };
  void fetchRound(URL, { method: "POST", body: BODY }, signal, (w) => waits.push(w)).then(
    (res) => {
      outcome.res = res;
      outcome.done = true;
    },
    (error: unknown) => {
      outcome.error = error;
      outcome.done = true;
    },
  );
  return { waits, outcome };
}

beforeEach(() => {
  Object.assign(rateLimitConfig, ORIGINAL);
  vi.spyOn(Math, "random").mockReturnValue(0); // no jitter: the schedule is exact
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.assign(rateLimitConfig, ORIGINAL);
});

describe("a connection that never answered", () => {
  it("is asked again once, a second later, with the very same request, and the chat hears of it", async () => {
    const { fn, sent } = script("drop", 200);
    const { waits, outcome } = start();
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS - 1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(waits).toEqual(["reconnecting"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome.res?.status).toBe(200);
    expect(sent.map((s) => s.body)).toEqual([BODY, BODY]);
    expect(sent[1].at - sent[0].at).toBe(RECONNECT_DELAY_MS);
    expect(waits).toEqual(["reconnecting", null]);
  });

  it("is asked once and no more: a second drop is the failure the person gets", async () => {
    const { fn } = script("drop");
    const { waits, outcome } = start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(outcome.error).toBeInstanceOf(TypeError);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(waits).toEqual(["reconnecting", null]);
  });
});

describe("a 502, 503 or 504", () => {
  it.each([502, 503, 504])(
    "%i is asked again once, and the first answer's body is released",
    async (status) => {
      let released = false;
      let calls = 0;
      const fn = vi.fn(async () => {
        calls += 1;
        if (calls > 1) return new Response("{}", { status: 200 });
        const open = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("down")); // left open, as a live connection is
          },
          cancel() {
            released = true;
          },
        });
        return new Response(open, { status });
      });
      vi.stubGlobal("fetch", fn);
      const { outcome } = start();
      await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
      expect(outcome.res?.status).toBe(200);
      expect(fn).toHaveBeenCalledTimes(2);
      expect(released, "the first answer's connection was left open").toBe(true);
    },
  );

  it("a second gateway failure is the answer, handed back for the caller to report, and never a third request", async () => {
    const { fn } = script(502, 504, 200);
    const { outcome } = start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(outcome.res?.status).toBe(504);
    expect(await outcome.res?.text(), "the caller can still read it").toBe("answer 504");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("a gateway failure then a drop ends with the drop, and a drop then a gateway failure with the failure", async () => {
    const a = script(503, "drop");
    const first = start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first.outcome.error).toBeInstanceOf(TypeError);
    expect(a.fn).toHaveBeenCalledTimes(2);

    const b = script("drop", 503);
    const second = start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(second.outcome.res?.status).toBe(503);
    expect(b.fn).toHaveBeenCalledTimes(2);
  });
});

describe("what is NOT asked again", () => {
  it.each([400, 401, 402, 404, 413, 422, 426, 429, 500, 501, 505])(
    "a %i is handed back at once, unread",
    async (status) => {
      const { fn, answers } = script(status, 200);
      const { waits, outcome } = start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(outcome.res?.status).toBe(status);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(answers[0].bodyUsed).toBe(false);
      expect(waits).toEqual([]);
    },
  );

  it("an error that is not a failure of the network is thrown at once", async () => {
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    vi.stubGlobal("fetch", fn);
    const { waits, outcome } = start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(outcome.error).toMatchObject({ message: "boom" });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("an abort is thrown at once", async () => {
    const fn = vi.fn(async () => {
      throw new DOMException("Aborted", "AbortError");
    });
    vi.stubGlobal("fetch", fn);
    const { outcome } = start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(outcome.error).toMatchObject({ name: "AbortError" });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("when the person presses Stop", () => {
  it("a Stop that arrives with the drop is not asked again", async () => {
    const stop = new AbortController();
    const fn = vi.fn(async () => {
      stop.abort();
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fn);
    const { waits, outcome } = start(stop.signal);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(outcome.done).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("a Stop during the pause ends it at once, and nothing more is sent", async () => {
    const { fn } = script("drop", 200);
    const stop = new AbortController();
    const { waits, outcome } = start(stop.signal);
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS / 2);
    stop.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(outcome.error).toMatchObject({ name: "AbortError" });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(waits).toEqual(["reconnecting", null]);
  });

  it("a Stop that arrives with a gateway failure hands that answer back and does not ask again", async () => {
    const stop = new AbortController();
    const fn = vi.fn(async () => {
      stop.abort();
      return new Response("down", { status: 503 });
    });
    vi.stubGlobal("fetch", fn);
    const { outcome } = start(stop.signal);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(outcome.res?.status).toBe(503);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("together with the server's busy answer", () => {
  it("a busy wait on its own is heard as busy and then as nothing, with no reconnect", async () => {
    const { fn } = script("busy", 200);
    const { waits, outcome } = start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(outcome.res?.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(waits).toEqual(["busy", null]);
  });

  it("a request asked again that finds the server busy waits it out like any other", async () => {
    script("drop", "busy", 200);
    const { waits, outcome } = start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(outcome.res?.status).toBe(200);
    expect(waits).toEqual(["reconnecting", "busy", null, null]);
  });

  it("a busy wait that ends in a drop is asked again once, and the chat hears each in turn", async () => {
    script("busy", "drop", 200);
    const { waits, outcome } = start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(outcome.res?.status).toBe(200);
    expect(waits).toEqual(["busy", null, "reconnecting", null]);
  });
});

// The invariants, over any run of answers, rather than the scripts above: it asks again at most once, only after
// a drop or a gateway failure, always finishes, and always leaves the chat with nothing waiting.
describe("whatever the answers are", () => {
  const step = fc.oneof(
    fc.constant<Step>("drop"),
    fc.constant<Step>("busy"),
    fc.constantFrom<Step>(200, 400, 401, 402, 429, 500, 502, 503, 504),
  );

  it("asks again at most once, never when the first answer was a real one, and always ends clean", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 8 }), async (steps) => {
        const { fn } = script(...steps);
        const { waits, outcome } = start();
        await vi.advanceTimersByTimeAsync(10 * 60_000);

        const stepAt = (i: number): Step => steps[Math.min(i, steps.length - 1)];
        const attempts = Array.from({ length: fn.mock.calls.length }, (_, i) => stepAt(i));
        expect(outcome.done, "it must always end").toBe(true);
        // Asked again at most once: of every attempt that was not the server asking us to wait, at most two.
        expect(attempts.filter((a) => a !== "busy").length).toBeLessThanOrEqual(2);
        expect(waits.filter((w) => w === "reconnecting").length).toBeLessThanOrEqual(1);
        expect(fn.mock.calls.length).toBeLessThanOrEqual(2 * (rateLimitConfig.retries + 1));
        // Only after a drop or a gateway failure, the first time.
        const firstReal = steps.find((s) => s !== "busy");
        const mayAskAgain =
          firstReal === "drop" || firstReal === 502 || firstReal === 503 || firstReal === 504;
        if (!mayAskAgain) expect(waits).not.toContain("reconnecting");
        // The chat is never left with a note on: the last thing it hears is "nothing".
        if (waits.length > 0) expect(waits[waits.length - 1]).toBeNull();
      }),
      { numRuns: 200 },
    );
  });
});
