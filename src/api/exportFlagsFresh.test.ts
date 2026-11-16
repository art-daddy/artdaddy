// How long a switch the server turned off takes to reach an app that is already open (api/exportFlags.ts). These drive
// the real question (the sign-in look, authedFetch, the deadline, the waits) against a fake server on a fake clock, and
// check what the app HOLDS and WHEN it asks, not how the code got there.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setClerkTokenProvider } from "./auth";
import {
  COMPILED_FLAG_DEFAULTS,
  EXPORT_FLAG_NAMES,
  __resetExportFlags,
  exportFlag,
  keepExportFlagsFresh,
  pcClass,
  refreshExportFlags,
  speechModelSources,
  type ExportFlagName,
} from "./exportFlags";

const MIN = 60_000;
const PLACE = "https://huggingface.co/some-org/some-copy/resolve/main/ggml-small.bin";

/** What a request of the app meets: the `nth` request (from 1), and the signal the app hangs up with. */
type Behave = (nth: number, signal: AbortSignal) => Promise<Response>;

/** A response as the app reads one: its status and its JSON (a plain object, so no stream waits on the fake clock). */
const answer = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
/** A page that is not JSON: a captive portal, an empty body, an answer cut short. */
const notJson = (status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  }) as unknown as Response;
/** What the server serves: every switch on except those named. */
const served = (
  off: readonly ExportFlagName[] = [],
  more: Record<string, unknown> = {},
): Response =>
  answer({
    v: 1,
    flags: Object.fromEntries(EXPORT_FLAG_NAMES.map((name) => [name, !off.includes(name)])),
    ...more,
  });

const hungUp = (): Error =>
  Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
/** A server that never answers; the request ends when the app hangs up. */
const hangs: Behave = (_nth, signal) =>
  new Promise<Response>((_resolve, reject) =>
    signal.addEventListener("abort", () => reject(hungUp())),
  );
/** A server that is asleep: it answers after `ms`, unless the app hangs up first. */
const wakes =
  (ms: number, reply: () => Response): Behave =>
  (_nth, signal) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(reply()), ms);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(hungUp());
      });
    });
/** A connection that does not notice the app hanging up, and answers after `ms` anyway. */
const deaf =
  (ms: number, reply: () => Response): Behave =>
  () =>
    new Promise<Response>((resolve) => setTimeout(() => resolve(reply()), ms));

/** The network as the app sees it, through the app's own `authedFetch` and the session it holds. */
function fakeServer(behave: Behave) {
  const asks: number[] = [];
  const carried: Array<{ url: string; method?: string; body: unknown; headers: string[] }> = [];
  let live = 0;
  let peak = 0;
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    asks.push(Date.now());
    carried.push({
      url: String(url),
      method: init?.method,
      body: init?.body,
      headers: Object.keys((init?.headers as Record<string, string> | undefined) ?? {}).map((h) =>
        h.toLowerCase(),
      ),
    });
    live++;
    peak = Math.max(peak, live);
    try {
      return await behave(asks.length, init?.signal as AbortSignal);
    } finally {
      live--;
    }
  });
  return { asks, carried, peak: () => peak };
}

const signedIn = async () => true;
const seconds = (ms: number): number => ms / 1000;

let visibility: DocumentVisibilityState = "visible";
let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  __resetExportFlags();
  setClerkTokenProvider(async () => "a-session-token");
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => {
  stop?.();
  stop = undefined;
  setClerkTokenProvider(null);
  delete (document as { visibilityState?: unknown }).visibilityState;
  vi.useRealTimers();
  __resetExportFlags();
});

describe("a server that is asleep when the app asks", () => {
  it("is waited for: the answer of a server that needs 26 seconds to wake is taken", async () => {
    const server = fakeServer(wakes(26_000, () => served(["speech_word_times"])));
    const done = refreshExportFlags();
    await vi.advanceTimersByTimeAsync(26_000);
    await done;
    expect(exportFlag("speech_word_times")).toBe(false);
    expect(exportFlag("speech_wake")).toBe(true); // only what the server named
    expect(server.asks).toHaveLength(1);
  });

  it("is waited for past the 30 seconds the app's own text promises, and given up on after a while", async () => {
    fakeServer(hangs);
    let ended = false;
    void refreshExportFlags().then(() => (ended = true));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(ended).toBe(true);
    for (const name of EXPORT_FLAG_NAMES)
      expect(exportFlag(name), name).toBe(COMPILED_FLAG_DEFAULTS[name]);
  });
});

describe("a question that got no answer", () => {
  it("is asked again soon, not after the whole ten minutes, and then the switches apply", async () => {
    const server = fakeServer((nth, signal) =>
      nth === 1 ? hangs(nth, signal) : Promise.resolve(served(["speech_wake"])),
    );
    let missedAt = 0;
    void refreshExportFlags().then(() => (missedAt = Date.now()));
    for (let i = 0; i < 300 && !missedAt; i++) await vi.advanceTimersByTimeAsync(1_000); // to the deadline, whatever it is
    expect(missedAt).toBeGreaterThan(0);
    expect(exportFlag("speech_wake")).toBe(true);
    await vi.advanceTimersByTimeAsync(missedAt + 10_000 - Date.now());
    await refreshExportFlags(); // ten seconds after the miss: inside its short wait, so not asked again
    expect(server.asks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(missedAt + 65_000 - Date.now());
    await refreshExportFlags(); // 65 seconds after the miss
    expect(server.asks).toHaveLength(2);
    expect(exportFlag("speech_wake")).toBe(false);
  });

  it("waits longer after each miss in a row, up to ten minutes, and never asks sooner than a minute", async () => {
    const server = fakeServer(() => Promise.resolve(answer({}, 503)));
    stop = keepExportFlagsFresh();
    void refreshExportFlags(); // the ask the app makes when it opens
    await vi.advanceTimersByTimeAsync(60 * MIN);
    const gaps = server.asks.slice(1).map((at, i) => at - server.asks[i]);
    const WAITS = [60, 120, 240, 480, 600, 600, 600, 600]; // seconds
    expect(gaps.length).toBeGreaterThanOrEqual(WAITS.length);
    WAITS.forEach((wait, i) => {
      expect(gaps[i], `gap ${i + 1}`).toBeGreaterThanOrEqual(wait * 1000);
      expect(gaps[i], `gap ${i + 1}`).toBeLessThanOrEqual(wait * 1000 + 30_000);
    });
  });

  it("is followed by the full ten minutes once the server answers", async () => {
    const server = fakeServer((nth) => Promise.resolve(nth === 1 ? answer({}, 503) : served()));
    stop = keepExportFlagsFresh();
    void refreshExportFlags();
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(server.asks.length).toBeGreaterThanOrEqual(3);
    expect(server.asks[1] - server.asks[0]).toBeLessThanOrEqual(MIN + 30_000); // after the miss: a minute
    expect(server.asks[2] - server.asks[1]).toBeGreaterThanOrEqual(10 * MIN); // after the answer: the whole wait
  });

  it("does not remember old misses: one that comes after an answer is followed by a minute, not by four", async () => {
    // Asks at 0 (miss), 60 (miss), 180 (answer), 780 (miss) and 840 seconds: had the answer not put the count back, the
    // wait after the third miss would be 240 seconds and the fifth ask would come at 1020.
    const server = fakeServer((nth) =>
      Promise.resolve(nth <= 2 || nth === 4 ? answer({}, 503) : served()),
    );
    stop = keepExportFlagsFresh();
    void refreshExportFlags();
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(server.asks.length).toBeGreaterThanOrEqual(5);
    expect(server.asks[3] - server.asks[2]).toBeGreaterThanOrEqual(10 * MIN); // after the answer: the whole wait
    expect(server.asks[4] - server.asks[3]).toBeLessThanOrEqual(MIN + 30_000); // after the miss: a minute
  });
});

describe("an answer that is not one", () => {
  const held = () => ({
    flags: EXPORT_FLAG_NAMES.map((name) => exportFlag(name)),
    pc: pcClass(),
    places: speechModelSources(),
    kept: localStorage.getItem("artdaddy.exportFlags.v1"),
  });
  const allOff = {
    v: 1,
    flags: Object.fromEntries(EXPORT_FLAG_NAMES.map((name) => [name, false])),
    pc_class: { ok_over: 0.6, weak_over: 7 },
    speech_model_sources: [],
  };
  const FAILURES: Array<[string, () => Promise<Response>]> = [
    [
      "the network is down",
      async () => {
        throw new TypeError("fetch failed");
      },
    ],
    ...[400, 401, 403, 404, 408, 425, 429, 500, 502, 503, 504].map(
      (status): [string, () => Promise<Response>] => [
        `HTTP ${status} carrying what looks like an answer`,
        async () => answer(allOff, status),
      ],
    ),
    ["a page that is not JSON (a captive portal)", async () => notJson()],
    ["an empty answer (204)", async () => notJson(204)],
    ["null", async () => answer(null)],
    ["a list", async () => answer([])],
    ["a string", async () => answer("ok")],
    ["an answer of a newer kind (v 2)", async () => answer({ ...allOff, v: 2 })],
    ["an answer with no version", async () => answer({ flags: allOff.flags })],
    ["an answer with no flags", async () => answer({ v: 1 })],
    ["flags that are not an object", async () => answer({ v: 1, flags: "all" })],
  ];

  it.each(FAILURES)(
    "changes nothing the app holds, and is asked again soon: %s",
    async (_label, fetcher) => {
      await refreshExportFlags({
        fetcher: async () =>
          served(["speech_wake", "lean_decoders"], {
            pc_class: { ok_over: 1.5, weak_over: 5 },
            speech_model_sources: [PLACE],
          }),
        signedIn,
        force: true,
      });
      const before = held();
      expect(before.flags).toContain(false); // so that a change would show
      expect(before.pc).toEqual({ okOver: 1.5, weakOver: 5 });
      expect(before.places).toEqual([PLACE]);

      await refreshExportFlags({ fetcher, signedIn, force: true });
      expect(held()).toEqual(before);

      // The miss is a miss, not an answer: it costs a short wait and not the ten minutes.
      const again = vi.fn(async () => served(["speech_wake", "lean_decoders", "pc_check"]));
      await vi.advanceTimersByTimeAsync(30_000);
      await refreshExportFlags({ fetcher: again, signedIn });
      expect(again).not.toHaveBeenCalled(); // the short wait is kept: nobody is hammered
      await vi.advanceTimersByTimeAsync(31_000);
      await refreshExportFlags({ fetcher: again, signedIn });
      expect(again).toHaveBeenCalledTimes(1);
      expect(exportFlag("pc_check")).toBe(false);
    },
  );

  it("names no switch: no switch changes, and it is an answer (the full wait applies)", async () => {
    await refreshExportFlags({
      fetcher: async () => served(["speech_wake"]),
      signedIn,
      force: true,
    });
    await refreshExportFlags({
      fetcher: async () => answer({ v: 1, flags: {} }),
      signedIn,
      force: true,
    });
    expect(exportFlag("speech_wake")).toBe(false);
    for (const name of EXPORT_FLAG_NAMES.filter((n) => n !== "speech_wake"))
      expect(exportFlag(name), name).toBe(true);
    const next = vi.fn(async () => served());
    await vi.advanceTimersByTimeAsync(5 * MIN);
    await refreshExportFlags({ fetcher: next, signedIn });
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the sign-in look throws at once",
      {
        signedIn: () => {
          throw new Error("no keychain");
        },
      },
    ],
    [
      "the request throws at once",
      {
        signedIn,
        fetcher: () => {
          throw new Error("no network stack");
        },
      },
    ],
    ["the request returns nothing", { signedIn, fetcher: async () => undefined }],
    [
      "the answer cannot be read",
      {
        signedIn,
        fetcher: async () =>
          ({
            ok: true,
            status: 200,
            json: async () => {
              throw new Error("stream reset");
            },
          }) as unknown as Response,
      },
    ],
  ])("never throws, never rejects and holds what it held when %s", async (_label, options) => {
    await refreshExportFlags({
      fetcher: async () => served(["speech_wake"]),
      signedIn,
      force: true,
    });
    const asking = refreshExportFlags({ ...(options as object), force: true });
    expect(asking).toBeInstanceOf(Promise);
    await expect(asking).resolves.toBeUndefined();
    expect(exportFlag("speech_wake")).toBe(false);
    expect(exportFlag("lean_decoders")).toBe(true);
  });
});

describe("one question at a time", () => {
  it("is never two in flight, whoever asks and whenever, while a slow server answers", async () => {
    const server = fakeServer(wakes(40_000, () => served(["speech_wake"])));
    stop = keepExportFlagsFresh();
    const together = [
      refreshExportFlags(),
      refreshExportFlags(),
      refreshExportFlags({ force: true }),
    ];
    await vi.advanceTimersByTimeAsync(45_000);
    await Promise.all(together);
    expect(server.asks).toHaveLength(1);
    expect(exportFlag("speech_wake")).toBe(false);
    // The wait starts when the question ENDS (at 40 seconds), not when it began: 630 seconds in, a question that began
    // at 0 would already be due, and one that ended at 40 is not.
    await vi.advanceTimersByTimeAsync(585_000);
    expect(server.asks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.asks).toHaveLength(2);
    expect(server.asks[1] - server.asks[0]).toBeGreaterThanOrEqual(640_000);
    expect(server.peak()).toBe(1);
  });

  it("is never two in flight, across the deadline, while a server that never answers is asked again and again", async () => {
    const server = fakeServer(hangs);
    stop = keepExportFlagsFresh();
    void refreshExportFlags();
    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect(server.asks.length).toBeGreaterThanOrEqual(4);
    expect(server.peak()).toBe(1);
  });
});

describe("what comes after the deadline", () => {
  it("is never taken, even when nothing newer has answered", async () => {
    fakeServer(deaf(150_000, () => served(["speech_wake"])));
    void refreshExportFlags();
    await vi.advanceTimersByTimeAsync(2 * MIN); // the app has given up by now, whatever the deadline is
    await vi.advanceTimersByTimeAsync(40_000); // the connection answers at 150 s
    expect(exportFlag("speech_wake")).toBe(true);
  });

  it("is never taken over a newer answer: the old state does not switch a behaviour back on", async () => {
    // The first question is held by a connection that answers at 200 s with the state of the day before; the retry gets
    // the state now (speech_wake off) at once.
    const old = deaf(200_000, () => served());
    const first = refreshExportFlags({ fetcher: (_url, init) => old(1, init!.signal!), signedIn });
    await vi.advanceTimersByTimeAsync(130_000); // past the deadline and the short wait after it
    void refreshExportFlags({ fetcher: async () => served(["speech_wake"]), signedIn });
    await vi.advanceTimersByTimeAsync(1);
    expect(exportFlag("speech_wake")).toBe(false);
    await vi.advanceTimersByTimeAsync(80_000); // the old connection answers
    await first;
    expect(exportFlag("speech_wake")).toBe(false);
  });
});

describe("an app left open and visible", () => {
  it("hears a switch the server turns off within about ten minutes, and not sooner than the wait", async () => {
    let off: ExportFlagName[] = [];
    const server = fakeServer(() => Promise.resolve(served(off)));
    stop = keepExportFlagsFresh();
    void refreshExportFlags(); // the ask the app makes when it opens
    await vi.advanceTimersByTimeAsync(5_000);
    expect(exportFlag("speech_wake")).toBe(true);

    off = ["speech_wake", "speech_word_times"]; // the operator switches them off
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(exportFlag("speech_wake")).toBe(true); // one question per ten minutes, however long the app is open
    expect(server.asks).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(6 * MIN + 30_000); // 11 minutes and a half after the first answer
    expect(exportFlag("speech_wake")).toBe(false);
    expect(exportFlag("speech_word_times")).toBe(false);
    expect(server.asks).toHaveLength(2);
    const gap = server.asks[1] - server.asks[0];
    expect(seconds(gap)).toBeGreaterThanOrEqual(10 * 60);
    expect(seconds(gap)).toBeLessThanOrEqual(10 * 60 + 30);
  });

  it("keeps asking for as long as it is open: an hour is six questions, not one and not sixty", async () => {
    const server = fakeServer(() => Promise.resolve(served()));
    stop = keepExportFlagsFresh();
    void refreshExportFlags();
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(server.asks.length).toBeGreaterThanOrEqual(6);
    expect(server.asks.length).toBeLessThanOrEqual(7);
  });

  it("asks nothing while the window is hidden, and within a look of becoming visible again", async () => {
    visibility = "hidden";
    const server = fakeServer(() => Promise.resolve(served(["speech_wake"])));
    stop = keepExportFlagsFresh();
    await vi.advanceTimersByTimeAsync(40 * MIN);
    expect(server.asks).toHaveLength(0);
    expect(exportFlag("speech_wake")).toBe(true);
    visibility = "visible";
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.asks).toHaveLength(1);
    expect(exportFlag("speech_wake")).toBe(false);
  });

  it("asks nothing of nobody, and does not spend the wait on that: signing in is noticed within a look", async () => {
    setClerkTokenProvider(null);
    const server = fakeServer(() => Promise.resolve(served(["speech_wake"])));
    stop = keepExportFlagsFresh();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(server.asks).toHaveLength(0);
    setClerkTokenProvider(async () => "a-session-token");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.asks).toHaveLength(1);
    expect(exportFlag("speech_wake")).toBe(false);
  });

  it("does not so much as look at the session while none is at hand, and asks within a look of one coming", async () => {
    // A look at the session may have to renew it (api/desktopAuth.ts: a read of the keychain and a call to the server):
    // nothing may do that every half minute for an app that nobody is using.
    const look = vi.fn(async () => "a-session-token");
    setClerkTokenProvider(look);
    const server = fakeServer(() => Promise.resolve(served(["speech_wake"])));
    let atHand = false;
    stop = keepExportFlagsFresh(() => atHand);
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(look).not.toHaveBeenCalled();
    expect(server.asks).toHaveLength(0);
    atHand = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.asks).toHaveLength(1);
    expect(exportFlag("speech_wake")).toBe(false);
  });

  it("stops asking when it is stopped", async () => {
    const server = fakeServer(() => Promise.resolve(served()));
    const off = keepExportFlagsFresh();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.asks).toHaveLength(1);
    off();
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(server.asks).toHaveLength(1);
  });
});

describe("what the question carries", () => {
  it("is the session and the app's version and nothing else, however many times and for whatever reason it is asked", async () => {
    const server = fakeServer(() => Promise.resolve(served()));
    stop = keepExportFlagsFresh();
    void refreshExportFlags();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(server.carried.length).toBeGreaterThanOrEqual(3);
    for (const request of server.carried) {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/client/export-flags");
      expect(url.search).toBe("");
      expect(request.method ?? "GET").toBe("GET");
      expect(request.body).toBeUndefined();
      expect(
        request.headers.filter((h) => !["authorization", "x-client-version"].includes(h)),
      ).toEqual([]);
      expect(request.headers).toContain("authorization");
    }
  });
});
