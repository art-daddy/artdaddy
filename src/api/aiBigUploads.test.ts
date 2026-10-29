// The server holds only one big request body at a time (a body costs about 7-8 times its size in memory and the container
// is small), and turns the rest away busy. The app used to fire up to four big clip uploads at once (parallel
// video_ask / video_find_moment reads) and have three refused; it now sends big uploads one at a time, in order, while
// small calls are never held up. A failing, stopped or waiting upload must never leave the line stuck.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setClerkTokenProvider } from "./auth";
import { BIG_UPLOAD_BYTES, callAiProxy } from "./ai";

const mib = (n: number) => "A".repeat(Math.floor(n * 1024 * 1024));
const big = () => ({ args: {}, media: { video: { b64: mib(9) } } }); // above the line
const small = () => ({ args: { prompt: "what is this?" }, media: { image: { b64: "AAAA" } } });

interface Pending {
  body: string;
  respond: (res: Response) => void;
}

/** A fetch whose every call waits for the test to answer it, so the order and overlap of requests is visible. */
function manualFetch() {
  const pending: Pending[] = [];
  const fn = vi.fn((_url: string, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      pending.push({ body: String(init?.body ?? ""), respond: resolve });
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, pending };
}

const answer = (status = 200) => new Response(JSON.stringify({ result: { ok: true } }), { status, headers: { "Content-Type": "application/json" } });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => setClerkTokenProvider(async () => "tok"));
afterEach(() => {
  setClerkTokenProvider(null);
  vi.unstubAllGlobals();
});

describe("big uploads", () => {
  it("are sent one at a time: the next starts only when the previous one has been answered", async () => {
    const { fn, pending } = manualFetch();
    const first = callAiProxy("vision_video", big());
    const second = callAiProxy("vision_video", big());
    const third = callAiProxy("vision_video", big());
    await tick();
    expect(fn).toHaveBeenCalledTimes(1);
    pending[0].respond(answer());
    await first;
    await tick();
    expect(fn).toHaveBeenCalledTimes(2);
    pending[1].respond(answer());
    await second;
    await tick();
    expect(fn).toHaveBeenCalledTimes(3);
    pending[2].respond(answer());
    await third;
  });

  it("go in the order they were asked for", async () => {
    const { pending } = manualFetch();
    const bodies = ["one", "two", "three"].map((tag) => ({ args: { tag }, media: { video: { b64: mib(9) } } }));
    const runs = bodies.map((b) => callAiProxy("vision_video", b));
    for (let i = 0; i < bodies.length; i += 1) {
      await tick();
      expect(JSON.parse(pending[i].body).args.tag).toBe(["one", "two", "three"][i]);
      pending[i].respond(answer());
    }
    await Promise.all(runs);
  });

  it("do not hold up small calls, which still run beside them", async () => {
    const { fn, pending } = manualFetch();
    const bigRun = callAiProxy("vision_video", big());
    const smallRuns = [callAiProxy("vision_image", small()), callAiProxy("vision_image", small())];
    await tick();
    expect(fn).toHaveBeenCalledTimes(3); // the big one and both small ones are in flight together
    pending.forEach((p) => p.respond(answer()));
    await Promise.all([bigRun, ...smallRuns]);
  });

  it("let a later big upload start once the earlier one FAILED", async () => {
    const { fn, pending } = manualFetch();
    const first = callAiProxy("vision_video", big()).catch((e: unknown) => e);
    const second = callAiProxy("vision_video", big());
    await tick();
    pending[0].respond(new Response("upstream down", { status: 500 }));
    expect(await first).toBeInstanceOf(Error);
    await tick();
    expect(fn).toHaveBeenCalledTimes(2);
    pending[1].respond(answer());
    await second;
  });

  it("let a later big upload start once the earlier one's connection dropped", async () => {
    const { fn, pending } = manualFetch();
    let drop!: (e: unknown) => void;
    fn.mockImplementationOnce(
      () =>
        new Promise<Response>((_resolve, reject) => {
          drop = reject;
        }),
    );
    const first = callAiProxy("vision_video", big()).catch((e: unknown) => e);
    const second = callAiProxy("vision_video", big());
    await tick();
    drop(new TypeError("Failed to fetch"));
    expect(await first).toBeInstanceOf(TypeError);
    await tick();
    expect(pending).toHaveLength(1);
    pending[0].respond(answer());
    await second;
  });

  it("can be stopped while waiting: it is never sent, and the one behind it is not held up", async () => {
    const { fn, pending } = manualFetch();
    const first = callAiProxy("vision_video", big());
    const stop = new AbortController();
    const waiting = callAiProxy("vision_video", big(), stop.signal).catch((e: unknown) => e);
    const third = callAiProxy("vision_video", { args: { tag: "third" }, media: { video: { b64: mib(9) } } });
    await tick();
    stop.abort();
    expect(await waiting).toMatchObject({ name: "AbortError" });
    pending[0].respond(answer());
    await first;
    await tick();
    expect(fn).toHaveBeenCalledTimes(2); // the stopped one never went out
    expect(JSON.parse(pending[1].body).args.tag).toBe("third");
    pending[1].respond(answer());
    await third;
  });
});

describe("what counts as big", () => {
  it("is a request body above the limit the server holds one at a time (8 MB)", () => {
    expect(BIG_UPLOAD_BYTES).toBe(8 * 1024 * 1024);
  });

  it("is judged by the request actually sent, not by the media alone", async () => {
    const { fn, pending } = manualFetch();
    const wide = (tag: string) => ({ args: { tag, notes: mib(9) }, media: {} });
    const runs = [callAiProxy("vision_image", wide("a")), callAiProxy("vision_image", wide("b"))];
    await tick();
    expect(fn).toHaveBeenCalledTimes(1);
    pending[0].respond(answer());
    await tick();
    pending[1].respond(answer());
    await Promise.all(runs);
  });

  it("does not hold a body that is just under the limit", async () => {
    const { fn, pending } = manualFetch();
    const under = () => ({ args: {}, media: { video: { b64: mib(7.5) } } });
    const runs = [callAiProxy("vision_video", under()), callAiProxy("vision_video", under())];
    await tick();
    expect(fn).toHaveBeenCalledTimes(2);
    pending.forEach((p) => p.respond(answer()));
    await Promise.all(runs);
  });
});
