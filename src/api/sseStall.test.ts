// The failure nobody could see: a stream that OPENS and then goes quiet.
//
// A closed stream ends the read loop and throws "ended without a result"; that path always
// worked. This one never settled at all — the reader awaited the next chunk forever, so the
// turn's catch never ran, no error was reported, and the app showed "thinking" until it was
// restarted. Sentry is blind to it by construction (nothing throws), which is why it survived
// to a real user. These tests assert the OUTCOME (the promise settles) rather than the wiring.
import { describe, expect, it, vi } from "vitest";

import { readSSE, StreamStalledError } from "./sse";

/** A body the test drives by hand: nothing arrives until `push` is called. */
function controllable() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const enc = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    stream,
    push: (s: string) => ctrl.enqueue(enc.encode(s)),
    close: () => ctrl.close(),
    wasCancelled: () => cancelled,
  };
}

describe("readSSE — a silent socket must not hang the caller", () => {
  it("rejects once nothing has arrived for idleMs, instead of awaiting forever", async () => {
    vi.useFakeTimers();
    try {
      const { stream } = controllable(); // opened, never sends, never closes
      const read = readSSE(stream, () => {}, { idleMs: 90_000 });
      const settled = vi.fn();
      void read.then(settled, settled);
      const rejected = expect(read).rejects.toBeInstanceOf(StreamStalledError);

      await vi.advanceTimersByTimeAsync(89_000);
      expect(settled).not.toHaveBeenCalled(); // a long round is legitimate

      await vi.advanceTimersByTimeAsync(2_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT time out while the server's keepalive comments keep arriving", async () => {
    // The failure direction: if the idle timer ignored comment frames, every round longer
    // than 90s would die on a perfectly healthy connection.
    vi.useFakeTimers();
    try {
      const { stream, push, close } = controllable();
      const events: string[] = [];
      const read = readSSE(stream, (m) => events.push(m.event), { idleMs: 90_000 });

      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(60_000); // 10 minutes of pings
        push(": ping\n\n");
      }
      push('event: result\ndata: {"ok":true}\n\n');
      close();

      await expect(read).resolves.toBeUndefined();
      expect(events).toEqual(["result"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the socket when it stalls", async () => {
    // Without the cancel a stalled round leaks its connection for the life of the process.
    vi.useFakeTimers();
    try {
      const { stream, wasCancelled } = controllable();
      const read = readSSE(stream, () => {}, { idleMs: 1_000 });
      // Observe the rejection BEFORE advancing: the timer fires inside advanceTimersByTimeAsync,
      // and a handler attached afterwards arrives too late to count as handled.
      const settled = expect(read).rejects.toBeInstanceOf(StreamStalledError);
      await vi.advanceTimersByTimeAsync(1_500);
      await settled;
      await vi.advanceTimersByTimeAsync(0);
      expect(wasCancelled()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is unchanged when no idle bound is given", async () => {
    const { stream, push, close } = controllable();
    const events: string[] = [];
    const read = readSSE(stream, (m) => events.push(m.event));
    push('event: delta\ndata: {"kind":"text","text":"hi"}\n\n');
    close();
    await read;
    expect(events).toEqual(["delta"]);
  });
});
