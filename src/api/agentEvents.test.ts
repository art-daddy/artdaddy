// The trace has to survive the paths nobody watches: a tool that was never run, one whose
// arguments the model got wrong, and one that threw. Those are the failures worth counting,
// and none of them reaches the agent loop -- they are answered and discarded at the dispatch
// boundary, which is exactly why the instrumentation lives there and not in the loop.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({ apiBase: () => "https://example.invalid" }));
vi.mock("./auth", () => ({ authHeaders: async () => ({ Authorization: "Bearer t" }) }));
vi.mock("../platform/host", () => ({
  hostInfo: () => ({ os: "windows", arch: "x86_64" }),
  resolveHostInfo: async () => undefined,
}));
vi.mock("../platform", () => ({ platform: { name: "tauri" } }));

import {
  __bufferedAgentEvents,
  __resetAgentEvents,
  flushAgentEvents,
  preview,
  recordAgentOutput,
  recordToolCall,
  recordToolDenied,
} from "./agentEvents";
import { startHeartbeat, stopHeartbeat } from "./appEvents";
import { ClientToolRegistry } from "../tools/registry";

const posted: unknown[] = [];

beforeEach(() => {
  __resetAgentEvents();
  posted.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      posted.push(JSON.parse(init.body));
      return { ok: true } as Response;
    }),
  );
});

afterEach(() => {
  stopHeartbeat();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the dispatch boundary records every outcome", () => {
  it("records a successful call with its arguments and result", async () => {
    const reg = new ClientToolRegistry();
    reg.register("undo", async () => ({ ok: true, undone: "split_clips" }));

    await reg.run("undo", {});

    const [ev] = __bufferedAgentEvents();
    expect(ev.kind).toBe("tool_call");
    expect(ev.name).toBe("undo");
    expect(ev.ok).toBe(true);
    expect(ev.result).toContain("split_clips");
  });

  it("records a handler that THREW as a failure, with the message", async () => {
    const reg = new ClientToolRegistry();
    reg.register("undo", () => {
      throw new Error("registry exploded");
    });

    await reg.run("undo", {});

    const [ev] = __bufferedAgentEvents();
    expect(ev.ok).toBe(false);
    expect(ev.error).toContain("registry exploded");
  });

  it("records the rejections the agent loop never sees", async () => {
    const reg = new ClientToolRegistry();
    reg.register("undo", async () => ({ ok: true }));

    // Malformed args: answered before the handler is ever reached.
    await reg.run("undo", null as unknown as Record<string, unknown>);

    const [ev] = __bufferedAgentEvents();
    expect(ev.ok).toBe(false);
    expect(ev.error).toContain("must be an object");
  });

  it("counts a tool that ANSWERS {ok:false} as a failure, not a success", async () => {
    // The whole point: this call "succeeded" at the transport level. Treating it as a
    // success would make a broken tool indistinguishable from a working one.
    const reg = new ClientToolRegistry();
    reg.register("undo", async () => ({ ok: false, error: "nothing to undo" }));

    await reg.run("undo", {});

    expect(__bufferedAgentEvents()[0].ok).toBe(false);
  });

  it("does not change what the caller receives", async () => {
    const reg = new ClientToolRegistry();
    reg.register("undo", async () => ({ ok: true, marker: 42 }));

    expect(await reg.run("undo", {})).toEqual({ ok: true, marker: 42 });
  });
});

describe("batching", () => {
  it("flushes on its own at the server's batch ceiling", async () => {
    for (let i = 0; i < 50; i++) {
      recordToolCall({ name: "undo", ok: true, ms: 1 });
    }
    await vi.waitFor(() => expect(posted.length).toBe(1));
    expect((posted[0] as { events: unknown[] }).events.length).toBe(50);
  });

  it("empties the buffer BEFORE awaiting, so a concurrent record is not lost", async () => {
    recordToolCall({ name: "undo", ok: true, ms: 1 });
    const inFlight = flushAgentEvents();
    recordAgentOutput("arrived mid-flush");
    await inFlight;

    // The second event must still be pending, not swallowed by the flush that was already away.
    expect(__bufferedAgentEvents().map((e) => e.kind)).toEqual(["agent_output"]);
  });

  it("survives a dead server without throwing or dropping later events", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    recordToolCall({ name: "undo", ok: true, ms: 1 });
    await expect(flushAgentEvents()).resolves.toBeUndefined();

    recordToolCall({ name: "redo", ok: true, ms: 1 });
    expect(__bufferedAgentEvents()).toHaveLength(1);
  });

  it("sends nothing when there is nothing to send", async () => {
    await flushAgentEvents();
    expect(posted).toHaveLength(0);
  });
});

describe("what gets recorded", () => {
  it("keeps a denial distinct from a failure", () => {
    recordToolDenied("remove_clips", "call_1", "user denied this tool call");
    expect(__bufferedAgentEvents()[0].kind).toBe("tool_denied");
  });

  it("ignores an empty agent answer rather than storing a blank row", () => {
    recordAgentOutput("");
    expect(__bufferedAgentEvents()).toHaveLength(0);
  });

  it("records unserialisable arguments instead of losing the call", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(preview(cyclic, 100)).toBe("[unserialisable]");
  });

  it("truncates rather than shipping an unbounded payload", () => {
    expect(preview("x".repeat(5_000), 2_000)).toHaveLength(2_000);
  });
});

describe("heartbeat", () => {
  it("beats while a project is open", async () => {
    vi.useFakeTimers();
    startHeartbeat("proj_1");
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);
    expect(fetch).toHaveBeenCalled();
  });

  it("stops when asked, so a closed project cannot keep reporting", async () => {
    vi.useFakeTimers();
    startHeartbeat("proj_1");
    stopHeartbeat();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("replaces the previous beat instead of running two", async () => {
    vi.useFakeTimers();
    startHeartbeat("proj_1");
    startHeartbeat("proj_2");
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);

    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as { body: string }).body);
    expect(body.project_id).toBe("proj_2");
  });

  it("does not schedule anything without a project", async () => {
    vi.useFakeTimers();
    startHeartbeat("");
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(fetch).not.toHaveBeenCalled();
  });
});
