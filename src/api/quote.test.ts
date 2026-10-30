// The app's price quote for a generation (UJ-047): what it asks the server, what it believes, and what it must never do.
// A quote is advice shown beside the Allow button. It must never block that button, never throw into the screen, never be
// mistaken for a paid call that failed, and never carry anything of the user's.
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setClerkTokenProvider } from "./auth";
import { clearRecentFailures, recentFailures } from "../observability/recentFailures";
import type { HoldInputs } from "../tools/holdInputs";
import { quoteHold } from "./quote";

const INPUTS: HoldInputs = { proxy: "generate_video", args: { backend_id: "veo-3.1-generate-001", duration: 8 } };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

function serve(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => handler(url, init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => clearRecentFailures());
afterEach(() => vi.unstubAllGlobals());

describe("what the quote asks", () => {
  it("posts the inputs to the quote route of the proxy the tool would call", async () => {
    const f = serve(() => json({ priced: true, credits: 96 }));
    expect(await quoteHold(INPUTS)).toEqual({ credits: 96 });
    const [url, init] = f.mock.calls[0];
    expect(url).toMatch(/\/ai\/generate_video\/quote$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ args: INPUTS.args });
  });

  it("is signed in as the account, like every other call", async () => {
    const off = setClerkTokenProvider(async () => "tok-1");
    try {
      const f = serve(() => json({ priced: true, credits: 3 }));
      await quoteHold(INPUTS);
      expect((f.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
    } finally {
      off();
    }
  });
});

describe("what the quote believes", () => {
  it("takes a positive finite number the server says is a price", async () => {
    for (const credits of [0.01, 1, 96, 384.5]) {
      serve(() => json({ priced: true, credits }));
      expect(await quoteHold(INPUTS), String(credits)).toEqual({ credits });
    }
  });

  it.each([
    ["no price", { priced: false }],
    ["nothing", {}],
    ["a price with no amount", { priced: true }],
    ["a free price", { priced: true, credits: 0 }],
    ["a negative price", { priced: true, credits: -4 }],
    ["an amount that is not a number", { priced: true, credits: "96" }],
    ["an amount that is null", { priced: true, credits: null }],
    ["an amount without the price flag", { credits: 96 }],
    ["a price flag that is not true", { priced: "yes", credits: 96 }],
    ["a list", [1, 2]],
    ["null", null],
  ])("shows nothing for %s", async (_name, body) => {
    serve(() => json(body));
    expect(await quoteHold(INPUTS)).toBeNull();
  });

  it("holds for any body at all: nothing, or a positive finite price", async () => {
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (body) => {
        serve(() => json(body));
        const quote = await quoteHold(INPUTS);
        return quote === null || (Number.isFinite(quote.credits) && quote.credits > 0);
      }),
      { numRuns: 150 },
    );
  });
});

describe("what the quote must never do", () => {
  it.each([401, 403, 404, 426, 429, 500, 503])("shows nothing, and does not throw, on a %i", async (status) => {
    serve(() => json({ detail: "nope" }, status));
    expect(await quoteHold(INPUTS)).toBeNull();
  });

  it("does not believe a price-shaped body on an error status", async () => {
    for (const status of [401, 404, 500, 503]) {
      serve(() => json({ priced: true, credits: 96 }, status));
      expect(await quoteHold(INPUTS), String(status)).toBeNull();
    }
  });

  it("shows nothing when the connection fails or the answer is not JSON", async () => {
    serve(() => {
      throw new TypeError("Failed to fetch");
    });
    expect(await quoteHold(INPUTS)).toBeNull();
    serve(() => new Response("<html>gateway</html>", { status: 200 }));
    expect(await quoteHold(INPUTS)).toBeNull();
  });

  it("is not a paid call, so a failed quote never lands in a problem report", async () => {
    serve(() => json({ detail: "boom" }, 500));
    await quoteHold(INPUTS);
    serve(() => {
      throw new TypeError("Failed to fetch");
    });
    await quoteHold(INPUTS);
    expect(recentFailures()).toEqual([]);
  });

  // Like the real fetch: an already-aborted signal rejects at once, and a later abort rejects the request in flight.
  const hangUntilAborted = (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException("aborted", "AbortError"));
      if (init.signal?.aborted) return abort();
      init.signal?.addEventListener("abort", abort);
    });

  it("gives up quietly when the bar goes away before the request goes out", async () => {
    const controller = new AbortController();
    serve(hangUntilAborted);
    const pending = quoteHold(INPUTS, controller.signal);
    controller.abort();
    expect(await pending).toBeNull();
    expect(recentFailures()).toEqual([]);
  });

  it("gives up quietly when the bar goes away while the request is in flight", async () => {
    const controller = new AbortController();
    const f = serve(hangUntilAborted);
    const pending = quoteHold(INPUTS, controller.signal);
    await vi.waitFor(() => expect(f).toHaveBeenCalled());
    controller.abort();
    expect(await pending).toBeNull();
    expect(recentFailures()).toEqual([]);
  });
});
