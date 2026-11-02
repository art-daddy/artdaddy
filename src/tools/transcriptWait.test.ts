import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toolDefinition } from "../contract";
import { resetLiveWait, useLiveWait } from "../store/liveWait";
import { TranscriptionFailure } from "./speechFailure";
import {
  __resetWaiting,
  waitBoundMs,
  waitForRun,
  WAIT_DEFAULT_S,
  WAIT_MAX_S,
  type WaitRequest,
} from "./transcriptWait";

beforeEach(() => {
  vi.useFakeTimers();
  __resetWaiting();
  resetLiveWait();
});
afterEach(() => vi.useRealTimers());

describe("waitBoundMs", () => {
  it("reads wait_seconds as the caller meant it", () => {
    expect(waitBoundMs(undefined)).toBe(15_000);
    expect(waitBoundMs(0)).toBe(0);
    expect(waitBoundMs(30)).toBe(30_000);
    expect(waitBoundMs(2.5)).toBe(2_500);
    expect(waitBoundMs(60)).toBe(60_000);
    expect(waitBoundMs(61)).toBe(60_000);
    expect(waitBoundMs(1e9)).toBe(60_000);
  });

  it("treats anything that is not a sensible number as no answer, never as 0 or as forever", () => {
    for (const bad of [-1, -0.001, NaN, Infinity, -Infinity, "30", null, {}, [], true])
      expect(waitBoundMs(bad), String(bad)).toBe(WAIT_DEFAULT_S * 1000);
  });

  it("is a whole number of ms in [0, 60 s] for ANYTHING a caller could send, and never shrinks as the ask grows", () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const ms = waitBoundMs(raw);
        expect(Number.isInteger(ms)).toBe(true);
        expect(ms).toBeGreaterThanOrEqual(0);
        expect(ms).toBeLessThanOrEqual(WAIT_MAX_S * 1000);
      }),
    );
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 200, noNaN: true }),
        fc.double({ min: 0, max: 200, noNaN: true }),
        (a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          expect(waitBoundMs(lo)).toBeLessThanOrEqual(waitBoundMs(hi));
        },
      ),
    );
  });
});

let seq = 0;
const NEVER = (): Promise<never> => new Promise<never>(() => undefined);

function request<T>(run: Promise<T>, extra: Partial<WaitRequest<T>> = {}): WaitRequest<T> {
  return {
    key: `k${++seq}`,
    tool: "inspect_media",
    audioSeconds: 30,
    audioLabel: "0:30",
    run,
    boundMs: 15_000,
    samples: [],
    os: "windows",
    progress: () => null,
    ...extra,
  };
}

/** Starts a wait and records when it answered. */
function start<T>(req: WaitRequest<T>) {
  const t0 = Date.now();
  const seen: { at: number | null; outcome: Awaited<ReturnType<typeof waitForRun<T>>> | null } = {
    at: null,
    outcome: null,
  };
  void waitForRun(req).then((o) => {
    seen.at = Date.now() - t0;
    seen.outcome = o;
  });
  return seen;
}

describe("waitForRun", () => {
  it("hands back what the run made when it makes it within the bound", async () => {
    const seen = start(request(new Promise<string>((r) => setTimeout(() => r("words"), 4_000))));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(seen).toEqual({ at: 4_000, outcome: { kind: "done", value: "words" } });
  });

  it("answers at the bound, not before and not after, whatever the run is doing", async () => {
    const seen = start(request(NEVER(), { boundMs: 7_000 }));
    await vi.advanceTimersByTimeAsync(6_999);
    expect(seen.at).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(seen.at).toBe(7_000);
    expect(seen.outcome).toMatchObject({
      kind: "pending",
      status: { status: "in_progress", waited_s: 7 },
    });
  });

  it("leaves the run going: what it makes after the bound is there for the next wait", async () => {
    let finish!: (v: string) => void;
    const run = new Promise<string>((r) => (finish = r));
    const first = start(request(run, { key: "same" }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(first.outcome?.kind).toBe("pending");
    finish("late words");
    const second = start(request(run, { key: "same" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(second.outcome).toEqual({ kind: "done", value: "late words" });
    expect(second.at).toBe(0);
  });

  it("ends at once on Stop, and the run it was waiting for is untouched", async () => {
    const stop = new AbortController();
    let finish!: (v: string) => void;
    const run = new Promise<string>((r) => (finish = r));
    const seen = start(request(run, { signal: stop.signal, boundMs: 60_000 }));
    await vi.advanceTimersByTimeAsync(2_000);
    stop.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual({ at: 2_000, outcome: { kind: "cancelled" } });
    finish("still made");
    await expect(run).resolves.toBe("still made");
  });

  it("does not start waiting for a call that was stopped before it began", async () => {
    const stop = new AbortController();
    stop.abort();
    const seen = start(request(NEVER(), { signal: stop.signal }));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual({ at: 0, outcome: { kind: "cancelled" } });
  });

  // The chat says "Transcribing the audio" for exactly as long as a tool is waiting here, so the
  // record must be there while the wait lasts and gone by every way it can end.
  describe("the chat's record of who is waiting on speech", () => {
    const waiting = (): string[] => useLiveWait.getState().speechWaits.map((w) => w.tool);

    it("names the tool for as long as it waits, and not a moment after it answers", async () => {
      const seen = start(request(NEVER(), { tool: "add_captions", boundMs: 7_000 }));
      await vi.advanceTimersByTimeAsync(6_999);
      expect(waiting()).toEqual(["add_captions"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(seen.outcome?.kind).toBe("pending");
      expect(waiting()).toEqual([]);
    });

    it("is empty after every way a wait can end, and the run it waited for is not touched", async () => {
      const stop = new AbortController();
      const ends: Array<[string, Partial<WaitRequest<string>>, () => void]> = [
        ["done", {}, () => undefined],
        ["failed", {}, () => undefined],
        ["pending", { boundMs: 3_000 }, () => undefined],
        ["stopped", { signal: stop.signal, boundMs: 60_000 }, () => stop.abort()],
      ];
      for (const [name, extra, cause] of ends) {
        let finish!: (v: string) => void;
        let fail!: (e: unknown) => void;
        const run = new Promise<string>((res, rej) => ((finish = res), (fail = rej)));
        const seen = start(request(run, extra));
        await vi.advanceTimersByTimeAsync(1_000);
        expect(waiting(), `${name}: while waiting`).toEqual(["inspect_media"]);
        if (name === "done") finish("words");
        if (name === "failed") fail(new Error("boom"));
        cause();
        await vi.advanceTimersByTimeAsync(3_000);
        expect(seen.outcome, name).not.toBeNull();
        expect(waiting(), `${name}: after`).toEqual([]);
        finish("late"); // whatever the run does afterwards changes nothing in the record
        await vi.advanceTimersByTimeAsync(0);
        expect(waiting(), `${name}: after the run ended`).toEqual([]);
      }
    });

    it("is empty for a call that was stopped before it began", async () => {
      const stop = new AbortController();
      stop.abort();
      start(request(NEVER(), { signal: stop.signal }));
      await vi.advanceTimersByTimeAsync(0);
      expect(waiting()).toEqual([]);
    });

    it("lists each waiting tool, and one ending does not end another", async () => {
      start(request(NEVER(), { tool: "add_captions", boundMs: 5_000 }));
      start(request(NEVER(), { tool: "inspect_media", boundMs: 9_000 }));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(waiting().sort()).toEqual(["add_captions", "inspect_media"]);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(waiting()).toEqual(["inspect_media"]);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(waiting()).toEqual([]);
    });
  });

  describe("when the run fails", () => {
    it("keeps the reason the failure named", async () => {
      const seen = start(
        request(Promise.reject(new TranscriptionFailure("language_rejected", "no such language"))),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(seen.outcome).toMatchObject({
        kind: "failed",
        status: { status: "failed", reason: "language_rejected", error: "no such language" },
      });
    });

    it("calls an error that named nothing the engine's, whatever was thrown", async () => {
      for (const thrown of [new Error("boom"), "a string", 42, undefined, { odd: true }]) {
        const seen = start(request(Promise.reject(thrown)));
        await vi.advanceTimersByTimeAsync(0);
        expect(seen.outcome).toMatchObject({ kind: "failed", status: { reason: "engine_failed" } });
      }
    });

    it("is not a failure the caller sees when the run fails after the bound has passed", async () => {
      let fail!: (e: unknown) => void;
      const run = new Promise<string>((_, reject) => (fail = reject));
      const seen = start(request(run));
      await vi.advanceTimersByTimeAsync(15_000);
      expect(seen.outcome?.kind).toBe("pending");
      fail(new Error("late"));
      await vi.advanceTimersByTimeAsync(0); // an unhandled rejection here would fail the whole run
    });
  });

  describe("what a look that has to stop waiting tells the model", () => {
    const answers = async (extra: Partial<WaitRequest<never>> = {}) => {
      const seen = start(request(NEVER(), extra));
      await vi.advanceTimersByTimeAsync(extra.boundMs ?? 15_000);
      return (seen.outcome as unknown as { status: Record<string, unknown> }).status;
    };

    it("says the transcript is not ready, how long it may take and how to get it, and forbids guessing the speech", async () => {
      const s = await answers({ audioSeconds: 120, audioLabel: "2:00" });
      expect(s).toMatchObject({ status: "in_progress", stage: "transcribing", waited_s: 15 });
      expect(s.note).toMatch(/not ready/);
      expect(s.note).toMatch(/2:00 of audio/);
      expect(s.note).toMatch(/Do not guess/);
      expect(s.note).toMatch(/wait_seconds/);
      expect(s.note).toMatch(/frames, metadata and loudness .* are final/);
      expect(s.note).not.toMatch(/no speech|silent/i);
    });

    it("says so when it was the speech model's download that was pending, with how far it is", async () => {
      const s = await answers({ progress: () => ({ pct: 40, etaS: 90 }) });
      expect(s).toMatchObject({ stage: "downloading_speech_model", progress_pct: 40 });
      expect(s.note).toMatch(/speech model is still downloading \(40%/);
      expect(s.note).toMatch(/one-time/);
      expect(s.note).toMatch(/Do not guess/);
    });

    it("adds the transcription that follows the download to the download's own time left", async () => {
      const none = await answers({ progress: () => ({ pct: 10, etaS: 0 }) });
      __resetWaiting(); // the first look's run never ends here, and would count as queued ahead
      const some = await answers({ progress: () => ({ pct: 10, etaS: 100 }) });
      expect(none.eta_s as number).toBeGreaterThanOrEqual(1);
      expect((some.eta_s as number) - (none.eta_s as number)).toBe(100);
    });

    it("gives no time left while the download's speed is not known yet, rather than a made-up one", async () => {
      const s = await answers({ progress: () => ({ pct: 0, etaS: null }) });
      expect(s.eta_s).toBeUndefined();
      expect(s.stage).toBe("downloading_speech_model");
    });

    it("gives no time left for a span of unknown length", async () => {
      const s = await answers({ audioSeconds: null });
      expect(s.eta_s).toBeUndefined();
    });

    it("never says how long a call waited when it did not", async () => {
      const s = await answers({ boundMs: 0 });
      expect(s.waited_s).toBe(0);
      expect(s.note).not.toMatch(/this call waited/);
    });
  });

  describe("the time left", () => {
    const etaAt = async (
      audio: number,
      boundS: number,
      samples: WaitRequest<never>["samples"] = [],
    ) => {
      __resetWaiting();
      const seen = start(
        request(NEVER(), { audioSeconds: audio, boundMs: boundS * 1000, samples }),
      );
      await vi.advanceTimersByTimeAsync(boundS * 1000);
      return (seen.outcome as { status: { eta_s?: number } }).status.eta_s;
    };

    it("is a whole number of seconds from 1 to an hour, for any length of speech and any wait", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 100_000 }),
          fc.integer({ min: 0, max: 60 }),
          async (audio, bound) => {
            const eta = await etaAt(audio, bound);
            expect(Number.isInteger(eta)).toBe(true);
            expect(eta!).toBeGreaterThanOrEqual(1);
            expect(eta!).toBeLessThanOrEqual(3600);
          },
        ),
        { numRuns: 60 },
      );
    });

    it("is longer for more speech when the machine is what is slow", async () => {
      const short = await etaAt(60, 1);
      const long = await etaAt(1800, 1);
      expect(long!).toBeGreaterThan(short!);
    });

    it("does not collapse to 'about done' for a run that is already past its estimate", async () => {
      // 30 s of speech is estimated at about 14 s here; at 40 s the run is well past that.
      const eta = await etaAt(30, 40);
      expect(eta!).toBeGreaterThanOrEqual(20);
    });

    it("follows the machine's own measured pace", async () => {
      const slowMachine: WaitRequest<never>["samples"] = [[100, 203]]; // 2 s of work per second
      const fastMachine: WaitRequest<never>["samples"] = [[100, 13]]; // 0.1 s per second
      expect(await etaAt(600, 1, slowMachine)).toBeGreaterThan((await etaAt(600, 1, fastMachine))!);
    });

    it("counts the looks queued ahead: the fourth of four at once has the most to wait for", async () => {
      const looks = [0, 1, 2, 3].map(() => start(request(NEVER(), { audioSeconds: 30 })));
      await vi.advanceTimersByTimeAsync(15_000);
      const etas = looks.map((l) => (l.outcome as { status: { eta_s: number } }).status.eta_s);
      expect([...etas].sort((a, b) => a - b)).toEqual(etas);
      expect(etas[3]).toBeGreaterThan(etas[0] * 2);
    });

    it("forgets a look once its run is over: a finished look is not waited for again", async () => {
      let done!: (v: string) => void;
      const big = start(
        request(new Promise<string>((r) => (done = r)), { key: "big", audioSeconds: 3000 }),
      );
      await vi.advanceTimersByTimeAsync(15_000);
      expect(big.outcome?.kind).toBe("pending");
      done("ok");
      await vi.advanceTimersByTimeAsync(0);
      // Were the 50 minutes still queued ahead, this look's wait would be about a thousand seconds.
      const small = start(request(NEVER(), { audioSeconds: 30, boundMs: 1_000 }));
      await vi.advanceTimersByTimeAsync(1_000);
      expect((small.outcome as { status: { eta_s: number } }).status.eta_s).toBeLessThanOrEqual(14);
    });
  });
});

// The model reads the contract, not the code: what it is told about wait_seconds must be what the
// code does with it, and must be said wherever the tool is described.
describe("what the contract says about wait_seconds", () => {
  type Props = Record<string, { type?: string; description?: string }>;
  const tool = toolDefinition("inspect_media")!;
  const variants: Array<[string, string, Props]> = [
    ["the tool", tool.description ?? "", tool.parameters!.properties as Props],
    [
      "its text variant",
      tool.text_variant!.description,
      tool.text_variant!.parameters.properties as Props,
    ],
  ];

  it.each(variants)(
    "%s: declares the parameter with the limits the code enforces",
    (_n, description, props) => {
      expect(props.wait_seconds?.type).toBe("number");
      expect(props.wait_seconds?.description).toContain(`0-${WAIT_MAX_S}`);
      expect(props.wait_seconds?.description).toContain(`default ${WAIT_DEFAULT_S}`);
      expect(description).toContain(`default ${WAIT_DEFAULT_S}, max ${WAIT_MAX_S}`);
    },
  );

  it.each(variants)(
    "%s: tells the model what to do when the transcript is not ready, and what a failure carries",
    (_n, description) => {
      expect(description).toMatch(/never guess what is said/);
      expect(description).toMatch(/`eta_s`/);
      expect(description).toMatch(/pass a larger `wait_seconds`/);
      expect(description).toMatch(/`transcript\.status: "failed"` carries a `reason`/);
    },
  );
});
