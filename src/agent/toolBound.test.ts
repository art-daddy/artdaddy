import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ABORT_GRACE_MS,
  READ_BOUND_MS,
  isTimedOutResult,
  runBounded,
  timedOutResult,
  toolBoundMs,
} from "./toolBound";
import { TOOL_EFFECTS } from "../contract/effects";
import { toolNames } from "../contract/views";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

// A tool that ignores the signal and answers after `ms`.
const answersAfter = <T>(ms: number, how: "resolve" | "reject", value: T) =>
  new Promise<T>((resolve, reject) =>
    setTimeout(() => (how === "resolve" ? resolve(value) : reject(new Error(String(value)))), ms),
  );

describe("which tools are time-boxed (the contract decides, tool by tool)", () => {
  const tools = toolNames();

  it("covers a real contract: every tool it lists has an effect class", () => {
    expect(tools.length).toBeGreaterThan(40);
    expect(tools.filter((t) => TOOL_EFFECTS[t] === undefined)).toEqual([]);
  });

  it("time-boxes exactly the tools that only look or wait, and never one that makes something", () => {
    const wrong = tools.filter((t) => {
      const effect = TOOL_EFFECTS[t];
      const waits = effect === "read" || effect === "derived-job";
      return toolBoundMs(t) !== (waits ? READ_BOUND_MS : null);
    });
    expect(wrong).toEqual([]);
    // The two ends of the rule are non-empty, so the walk above cannot pass by finding nothing.
    expect(tools.filter((t) => toolBoundMs(t) !== null).length).toBeGreaterThan(10);
    for (const maker of ["add_clips", "import_media", "generate_video", "export", "run_ffmpeg"])
      expect(toolBoundMs(maker), maker).toBeNull();
    for (const looker of ["inspect_media", "video_ask", "video_find_moment", "get_transcript"])
      expect(toolBoundMs(looker), looker).toBe(READ_BOUND_MS);
  });

  it("never limits a name the contract does not know, including names an object inherits", () => {
    for (const name of ["nope", "", "constructor", "toString", "__proto__", "hasOwnProperty"])
      expect(toolBoundMs(name), name).toBeNull();
  });
});

describe("runBounded", () => {
  it("gives the tool's own answer when it finishes in time, and leaves no timer behind", async () => {
    const out = runBounded(() => answersAfter(1_000, "resolve", "done"), { boundMs: 5_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(out).resolves.toEqual({ timedOut: false, value: "done" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives the tool's own failure when it fails in time", async () => {
    const out = runBounded(() => answersAfter(10, "reject", "boom"), { boundMs: 5_000 });
    const seen = expect(out).rejects.toThrow("boom");
    await vi.advanceTimersByTimeAsync(10);
    await seen;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tells a tool that never finishes to stop at the bound, and goes on without it after the grace", async () => {
    let signal!: AbortSignal;
    const out = runBounded(
      (s) => {
        signal = s;
        return new Promise<string>(() => undefined);
      },
      { boundMs: 5_000 },
    );
    let answer: unknown = "pending";
    void out.then((a) => (answer = a));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    expect(answer).toBe("pending");
    await vi.advanceTimersByTimeAsync(ABORT_GRACE_MS);
    expect(answer).toEqual({ timedOut: true, boundMs: 5_000 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers at once when the tool obeys the stop, and still calls it timed out (not the tool's own value)", async () => {
    const out = runBounded(
      (s) =>
        new Promise<string>((resolve) => s.addEventListener("abort", () => resolve("cancelled"))),
      { boundMs: 5_000 },
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(out).resolves.toEqual({ timedOut: true, boundMs: 5_000 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("calls it timed out, never a throw, when the tool fails because it was told to stop", async () => {
    const out = runBounded(
      (s) =>
        new Promise<string>((_, reject) =>
          s.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
      { boundMs: 5_000 },
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(out).resolves.toEqual({ timedOut: true, boundMs: 5_000 });
  });

  it("drops a result that arrives after the answer, so the turn never sees two", async () => {
    const answers: unknown[] = [];
    const out = runBounded(() => answersAfter(20_000, "reject", "late failure"), {
      boundMs: 1_000,
    });
    void out.then((a) => answers.push(a));
    await vi.advanceTimersByTimeAsync(1_000 + ABORT_GRACE_MS);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(answers).toEqual([{ timedOut: true, boundMs: 1_000 }]);
  });

  it("passes the caller's Stop to the tool at once, and removes its listener on every path", async () => {
    const stop = new AbortController();
    const remove = vi.spyOn(stop.signal, "removeEventListener");
    let seen!: AbortSignal;
    const out = runBounded(
      (s) => {
        seen = s;
        return new Promise<string>((resolve) =>
          s.addEventListener("abort", () => resolve("cancelled")),
        );
      },
      { boundMs: 5_000, signal: stop.signal },
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(seen.aborted).toBe(false);
    stop.abort();
    expect(seen.aborted).toBe(true);
    await expect(out).resolves.toEqual({ timedOut: false, value: "cancelled" });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives a tool started after Stop an already-aborted signal", async () => {
    const stop = new AbortController();
    stop.abort();
    let aborted: boolean | null = null;
    const out = runBounded(
      (s) => {
        aborted = s.aborted;
        return Promise.resolve("cancelled");
      },
      { boundMs: 5_000, signal: stop.signal },
    );
    await vi.advanceTimersByTimeAsync(0);
    await out;
    expect(aborted).toBe(true);
  });

  it("with no bound sets no timer at all, lets a slow tool take as long as it takes, and still honours Stop", async () => {
    const stop = new AbortController();
    let answer: unknown = "pending";
    const out = runBounded(
      (s) =>
        new Promise<string>((resolve) => s.addEventListener("abort", () => resolve("cancelled"))),
      { boundMs: null, signal: stop.signal },
    );
    void out.then((a) => (answer = a));
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(answer).toBe("pending");
    stop.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(answer).toEqual({ timedOut: false, value: "cancelled" });
  });

  it("starts the tool at once, in the same tick, so a batch keeps its order", () => {
    let started = false;
    void runBounded(
      () => {
        started = true;
        return Promise.resolve("done");
      },
      { boundMs: 5_000 },
    );
    expect(started).toBe(true);
  });

  it("turns a tool that throws before it starts into a failure, not a crash", async () => {
    const out = runBounded(
      () => {
        throw new Error("sync boom");
      },
      { boundMs: 5_000 },
    );
    const seen = expect(out).rejects.toThrow("sync boom");
    await vi.advanceTimersByTimeAsync(0);
    await seen;
  });

  // The rule that must survive a rewrite: whatever a tool does, the turn gets exactly one answer, it
  // is the tool's own when the tool beat the bound and "timed out" otherwise, and it never arrives
  // later than the bound plus the grace.
  it("gives exactly one answer, the tool's own only if it beat the bound, by bound + grace at the latest", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 600_000 }),
        fc.integer({ min: 0, max: 1_200_000 }),
        fc.constantFrom("resolve" as const, "reject" as const),
        fc.constantFrom("ignores" as const, "obeys" as const),
        async (bound, delay, how, behaviour) => {
          fc.pre(delay !== bound);
          const answers: Array<{ kind: "answer" | "failure"; v: unknown }> = [];
          let told = false;
          const out = runBounded(
            (s) =>
              new Promise<string>((resolve, reject) => {
                const finish = (): void =>
                  how === "resolve" ? resolve("own") : reject(new Error("own failure"));
                const t = setTimeout(finish, delay);
                s.addEventListener("abort", () => {
                  told = true;
                  if (behaviour === "obeys") clearTimeout(t);
                });
              }),
            { boundMs: bound },
          );
          out.then(
            (v) => answers.push({ kind: "answer", v }),
            (e) => answers.push({ kind: "failure", v: String(e) }),
          );
          await vi.advanceTimersByTimeAsync(bound + ABORT_GRACE_MS);
          expect(answers).toHaveLength(1);
          // The tool is told to stop exactly when it has outlived the bound.
          expect(told).toBe(delay > bound);
          const first = answers[0];
          if (delay < bound) {
            if (how === "resolve")
              expect(first).toEqual({ kind: "answer", v: { timedOut: false, value: "own" } });
            else expect(first.kind).toBe("failure");
          } else {
            expect(first).toEqual({ kind: "answer", v: { timedOut: true, boundMs: bound } });
          }
          await vi.advanceTimersByTimeAsync(2_000_000);
          expect(answers).toHaveLength(1);
          expect(vi.getTimerCount()).toBe(0);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("what the model is told when a tool was stopped", () => {
  it("is a failure it can act on: which tool, how long, that nothing changed, and not to repeat it", () => {
    const r = timedOutResult("video_find_moment", READ_BOUND_MS);
    expect(r.ok).toBe(false);
    expect(r.timed_out).toBe(true);
    expect(r.bound_s).toBe(300);
    expect(String(r.error)).toContain("video_find_moment");
    expect(String(r.error)).toContain("5 minutes");
    expect(String(r.error)).toMatch(/Nothing was changed/);
    expect(String(r.error)).toMatch(/Do not repeat the same call/);
    expect(String(timedOutResult("x", 60_000).error)).toContain("1 minute and");
  });

  it("is recognised as such, and nothing else is", () => {
    expect(isTimedOutResult(timedOutResult("x", READ_BOUND_MS))).toBe(true);
    for (const other of [
      null,
      undefined,
      "timed_out",
      1,
      [],
      {},
      { ok: false },
      { timed_out: "yes" },
    ])
      expect(isTimedOutResult(other), JSON.stringify(other)).toBe(false);
  });
});
