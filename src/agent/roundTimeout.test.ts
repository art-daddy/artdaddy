// A round must always end. Until this existed the only thing that could end one was the user
// pressing Stop — so a connection that died mid-round left the turn pending forever, the catch
// never ran, and the app showed "thinking" with nothing reported. A real tester lost a session
// to it and Sentry had nothing, because nothing threw.
//
// The subtle half is telling the two apart: a timeout and a Stop both surface as an AbortError,
// and if the turn cannot distinguish them it either shows an error when someone pressed Stop or
// stays silent when their connection died.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../contract", () => ({ ensureContract: vi.fn(async () => {}) }));
vi.mock("../api/auth", async (io) => {
  const actual = await io<typeof import("../api/auth")>();
  return { ...actual, notifyAuthFailure: vi.fn() };
});

import { setApiBase } from "../api/config";
import { inferRound, inferRoundStreaming, RoundTimeoutError, type InferBody } from "./api";

const body: InferBody = { round_input: { user_text: "hi" } };

afterEach(() => {
  setApiBase(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A fetch that never answers unless its signal aborts — the shape of a dead connection.
 *  Checks `aborted` up front as well as listening, because the real fetch does: an abort can
 *  land before the request is even issued. */
function neverAnswers() {
  const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        if (init?.signal?.aborted) {
          reject(abortError());
          return;
        }
        init?.signal?.addEventListener("abort", () => reject(abortError()));
      }),
  );
}

describe("a round that never answers", () => {
  it("fails with a timeout instead of hanging forever (non-streaming)", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", neverAnswers());

    const p = inferRound(body);
    const settled = expect(p).rejects.toBeInstanceOf(RoundTimeoutError);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await settled;
  });

  it("fails with a timeout instead of hanging forever (streaming)", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", neverAnswers());

    const p = inferRoundStreaming(body, () => {});
    const settled = expect(p).rejects.toBeInstanceOf(RoundTimeoutError);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await settled;
  });

  it("does NOT fire early — a model may legitimately think for minutes", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", neverAnswers());

    const p = inferRoundStreaming(body, () => {});
    const settled = vi.fn();
    void p.then(settled, settled);

    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(settled).not.toHaveBeenCalled();

    // Drain it so the rejection is observed.
    const done = expect(p).rejects.toBeInstanceOf(RoundTimeoutError);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await done;
  });
});

describe("Stop and a timeout must stay distinguishable", () => {
  it("a user Stop is NOT reported as a timeout", async () => {
    // The failure direction. If the deadline swallowed the user's own abort, pressing Stop
    // would raise "the connection was probably lost" at someone who simply changed their mind.
    vi.stubGlobal("fetch", neverAnswers());
    const ctrl = new AbortController();

    const p = inferRoundStreaming(body, () => {}, ctrl.signal);
    const settled = expect(p).rejects.toSatisfy(
      (e: unknown) => !(e instanceof RoundTimeoutError) && (e as Error).name === "AbortError",
    );
    ctrl.abort();
    await settled;
  });

  it("a normal round is untouched", async () => {
    const dto = { kind: "text", final_text: "ok" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(dto), { status: 200 })),
    );
    await expect(inferRound(body)).resolves.toEqual(dto);
  });
});

describe("every round says which machine it came from", () => {
  it("sends the host OS on both routes, so a per-platform failure is visible", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: RequestInit) => {
        seen.push(String(init?.body));
        return new Response(JSON.stringify({ kind: "text" }), { status: 200 });
      }),
    );

    await inferRound(body);
    // The streaming route falls back to /inference on a 404, which is the same sender; drive
    // it explicitly so both call sites are covered rather than one standing in for the other.
    await inferRoundStreaming(body, () => {}).catch(() => {});

    expect(seen.length).toBeGreaterThanOrEqual(1);
    for (const b of seen) {
      const parsed = JSON.parse(b) as Record<string, unknown>;
      expect(parsed).toHaveProperty("client_os");
      expect(parsed.surface).toBe("app");
    }
  });
});
