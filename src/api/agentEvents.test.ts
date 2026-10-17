// The trace has to survive the paths nobody watches: a tool that was never run, one whose
// arguments the model got wrong, and one that threw. Those are the failures worth counting,
// and none of them reaches the agent loop -- they are answered and discarded at the dispatch
// boundary, which is exactly why the instrumentation lives there and not in the loop.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config")>()),
  apiBase: () => "https://example.invalid",
}));
vi.mock("./auth", () => ({
  hasSession: async () => true,
  authedFetch: (
    url: string,
    init: RequestInit = {},
    send: (url: string, init: RequestInit) => Promise<Response> = (target, request) =>
      fetch(target, request),
  ) => send(url, init),
}));
vi.mock("../platform/host", () => ({
  hostInfo: () => ({ os: "windows", arch: "x86_64" }),
  resolveHostInfo: async () => undefined,
}));
vi.mock("../platform", () => ({ platform: { name: "tauri" } }));

import {
  __bufferedAgentEvents,
  __resetAgentEvents,
  agentEventContext,
  createToolTrace,
  flushAgentEvents,
  flushAgentEventsForExit,
  preview,
  recordAgentOutput,
  recordToolCall,
  recordToolDenied,
  setAgentContext,
} from "./agentEvents";
import { startHeartbeat, stopHeartbeat } from "./appEvents";
import { ClientToolRegistry } from "../tools/registry";
import { useAuth } from "../store/auth";
import { ClientTurnRunner } from "../agent/loop";
import type { RoundResultDTO } from "../agent/types";
import { useCompatibility } from "../update/compatibility";

const posted: unknown[] = [];

beforeEach(() => {
  __resetAgentEvents();
  useAuth.setState({ status: "unlocked", profile: null, hasStoredSession: true });
  useCompatibility.setState({ status: "allowed" });
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
  __resetAgentEvents();
  stopHeartbeat();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("anonymous pre-admission export outcomes", () => {
  it("counts a signed-out protocol refusal once without sending tool args or identity", async () => {
    useAuth.setState({ status: "locked", profile: null, hasStoredSession: false });
    const registry = new ClientToolRegistry();
    const handler = vi.fn(async () => ({ ok: true }));
    registry.register("export", handler);
    await registry.run("export", { private_filename: "C:/private/person-and-project.mov" });
    expect(handler).not.toHaveBeenCalled();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ status: "blocked", readiness: "unknown" });
    expect(Object.keys(posted[0] as object).sort()).toEqual(["app_version", "arch", "elapsed_ms", "operation", "platform", "project_size_band", "readiness", "reason_code", "shell", "status"]);
    expect(JSON.stringify(posted)).not.toContain("person-and-project");
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
  });

  it("counts only unadmitted outputs in a deduplicated partial batch and ignores repeated trace completion", () => {
    useAuth.setState({ status: "locked", profile: null, hasStoredSession: false });
    const trace = createToolTrace("export", { media_refs: ["media_a", " media_b ", "media_b"] }, agentEventContext());
    const result = { ok: false, error: "could not admit the second file", exports: [{ job_id: "already-admitted" }] };
    trace.result(result);
    trace.result(result);
    trace.error(new Error("later duplicate completion"));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ status: "blocked", operation: "copy" });
  });

  it("does not delay a refused tool while anonymous transport is still pending", async () => {
    useAuth.setState({ status: "locked", profile: null, hasStoredSession: false });
    let release!: () => void;
    let delivered = false;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => { await pending; delivered = true; return new Response("{}"); }));
    const registry = new ClientToolRegistry();
    registry.register("export", async () => ({ ok: false, error: "source unavailable" }));
    expect(await registry.run("export", {})).toMatchObject({ ok: false });
    expect(delivered).toBe(false);
    release();
    await pending;
  });
});

describe("the dispatch boundary records every outcome", () => {
  it("records the actual error text instead of repeating the whole failed result", async () => {
    const registry = new ClientToolRegistry();
    registry.register("undo", async () => ({
      ok: false,
      error: "nothing to undo",
      unrelated: "other result metadata",
    }));
    await registry.run("undo", {});
    await flushAgentEvents();
    expect(posted).toMatchObject([{ events: [{ ok: false, error: "nothing to undo" }] }]);
  });

  it("does not require an offline-session flag for an unlocked live session", async () => {
    useAuth.setState({ status: "unlocked", hasStoredSession: false });
    recordToolCall({ name: "undo", ok: true, ms: 1 });
    await flushAgentEvents();
    expect(posted).toMatchObject([{ events: [{ name: "undo" }] }]);
  });

  it.each([null, undefined, false, 42, "plain reply", []])(
    "preserves a primitive or empty tool reply (%j) without a false failure",
    async (value) => {
      const registry = new ClientToolRegistry();
      registry.register("undo", async () => value);
      expect(await registry.run("undo", {})).toEqual(value);
      await flushAgentEvents();
      expect(posted).toMatchObject([
        {
          events: [
            {
              name: "undo",
              ok: true,
              error: "",
              result:
                value === undefined
                  ? ""
                  : typeof value === "string"
                    ? value
                    : JSON.stringify(value),
            },
          ],
        },
      ]);
    },
  );

  it("records a successful call with its arguments and result", async () => {
    const reg = new ClientToolRegistry();
    reg.register("undo", async () => ({ ok: true, undone: "split_clips" }));

    await reg.run("undo", {});

    const [ev] = __bufferedAgentEvents();
    expect(ev.kind).toBe("tool_call");
    expect(ev.name).toBe("undo");
    expect(ev.ok).toBe(true);
    expect(ev.error).toBe("");
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
  it("uses one deadline for several pending events and removes it after delivery", async () => {
    vi.useFakeTimers();
    recordToolCall({ name: "undo", ok: true, ms: 1 });
    recordToolCall({ name: "redo", ok: true, ms: 1 });
    expect(vi.getTimerCount()).toBe(1);
    await flushAgentEvents();
    expect(posted).toMatchObject([{ events: [{ name: "undo" }, { name: "redo" }] }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends a stalled delivery at its deadline and still delivers later events", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        signal = init!.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(new Error("offline deadline")), {
            once: true,
          });
        });
      }),
    );
    recordToolCall({ name: "undo", ok: true, ms: 1 });
    const pending = flushAgentEvents();
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(pending).resolves.toBeUndefined();
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        posted.push(JSON.parse(init!.body as string));
        return new Response("", { status: 200 });
      }),
    );
    recordToolCall({ name: "redo", ok: true, ms: 1 });
    await flushAgentEvents();
    expect(posted).toMatchObject([{ events: [{ name: "redo" }] }]);
  });

  it("delivers and finishes exit using browser numeric timers without leaving deadlines", async () => {
    vi.useFakeTimers();
    const schedule = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", (handler: () => void, delay?: number) =>
      Number(schedule(handler, delay)),
    );
    recordToolCall({ name: "undo", ok: true, ms: 1 });
    await flushAgentEventsForExit();
    expect(posted).toMatchObject([{ events: [{ name: "undo", ok: true }] }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let a stale completion swallow the new session's valid events", async () => {
    const previous = agentEventContext();
    useAuth.getState().markLocked();
    useAuth.setState({ status: "unlocked", hasStoredSession: true });
    recordToolCall({ name: "undo", ok: true, ms: 1 }, previous);
    recordToolCall({ name: "redo", ok: true, ms: 1 });
    await flushAgentEvents();
    expect(posted).toMatchObject([{ events: [{ name: "redo" }] }]);
    expect((posted[0] as { events: unknown[] }).events).toHaveLength(1);
  });

  it("records a tool's elapsed time, not a wall-clock timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const registry = new ClientToolRegistry();
    registry.register("undo", async () => {
      vi.setSystemTime(1_800_000_000_125);
      return { ok: true };
    });
    await registry.run("undo", {});
    await flushAgentEvents();
    expect(posted).toMatchObject([{ events: [{ name: "undo", ms: 125, call_id: "" }] }]);
  });

  it.each(["refused", "threw"])(
    "records an app call that %s before reaching the host",
    async (outcome) => {
      const submitted = agentEventContext();
      let rounds = 0;
      const runner = new ClientTurnRunner({
        eventContext: () => submitted,
        infer: async () => {
          const first = ++rounds === 1;
          return {
            kind: first ? "tool_calls" : "text",
            pending_calls: first
              ? [{ name: "not_registered", call_id: "model_call_1", arguments: {} }]
              : [],
            final_text: "",
            error: "",
            finish_reason: "",
            usage: {},
            provider_snapshot: {},
          };
        },
        runTool: async () => {
          if (outcome === "threw") throw new Error("host unavailable");
          return { ok: false, error: "tool not registered" };
        },
        emit: () => undefined,
        mode: () => "autopilot",
        stopped: () => false,
        onUsage: () => undefined,
        session: () => ({}),
      });
      await runner.start("go");
      await vi.waitFor(() => expect(posted).toHaveLength(1));
      expect(posted[0]).toMatchObject({
        surface: "app",
        events: [{ name: "not_registered", call_id: "model_call_1", ok: false }],
      });
      expect((posted[0] as { events: unknown[] }).events).toHaveLength(1);
    },
  );

  it("delivers a completed tool trace when the following model round throws", async () => {
    const registry = new ClientToolRegistry();
    registry.register("undo", async () => ({ ok: true }));
    const submitted = agentEventContext();
    let rounds = 0;
    const runner = new ClientTurnRunner({
      eventContext: () => submitted,
      infer: async () => {
        if (++rounds === 1)
          return {
            kind: "tool_calls",
            pending_calls: [{ name: "undo", call_id: "call_1", arguments: {} }],
            usage: {},
          } as RoundResultDTO;
        throw new Error("model connection lost");
      },
      runTool: (name, args, trace) => registry.run(name, args, trace.context, trace),
      emit: () => undefined,
      mode: () => "autopilot",
      stopped: () => false,
      onUsage: () => undefined,
      session: () => ({}),
    });
    await expect(runner.start("undo")).rejects.toThrow("model connection lost");
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ events: [{ name: "undo", ok: true }] });
  });

  it("keeps an app answer under its original turn after another project becomes active", async () => {
    setAgentContext({
      surface: "app",
      project_id: "original_project",
      model: "original-model",
      transcript_id: "original_chat",
    });
    const submitted = agentEventContext();
    const runner = new ClientTurnRunner({
      eventContext: () => submitted,
      infer: async () => {
        setAgentContext({
          project_id: "later_project",
          model: "later-model",
          transcript_id: "later_chat",
        });
        return { kind: "text", final_text: "the original answer", usage: {} } as RoundResultDTO;
      },
      runTool: async () => ({ ok: true }),
      emit: () => undefined,
      mode: () => "autopilot",
      stopped: () => false,
      onUsage: () => undefined,
      session: () => ({}),
    });
    await runner.start("go");
    await flushAgentEvents();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      project_id: "original_project",
      model: "original-model",
      transcript_id: "original_chat",
      events: [{ text: "the original answer" }],
    });
  });

  it("keeps each event's project and source rather than using the next turn's labels", async () => {
    setAgentContext({
      surface: "mcp",
      project_id: "external_project",
      model: "",
      transcript_id: "",
    });
    recordToolCall({ name: "undo", ok: true, ms: 1 });
    setAgentContext({
      surface: "app",
      project_id: "chat_project",
      model: "chat-model",
      transcript_id: "chat_1",
    });
    recordAgentOutput("the app answer");
    await flushAgentEvents();
    expect(posted).toHaveLength(2);
    expect(posted[0]).toMatchObject({
      surface: "mcp",
      project_id: "external_project",
      events: [{ name: "undo" }],
    });
    expect(posted[1]).toMatchObject({
      surface: "app",
      project_id: "chat_project",
      transcript_id: "chat_1",
      events: [{ text: "the app answer" }],
    });
  });

  it("sends a short MCP session on a timer without waiting for an in-app turn", async () => {
    vi.useFakeTimers();
    setAgentContext({ surface: "mcp", project_id: "external_project" });
    recordToolCall({ name: "undo", ok: true, ms: 1 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      surface: "mcp",
      project_id: "external_project",
      events: [{ name: "undo" }],
    });
  });

  it("keeps a slow tool under the project it started in", async () => {
    setAgentContext({ surface: "mcp", project_id: "original_project" });
    let finish!: (result: unknown) => void;
    const reg = new ClientToolRegistry();
    reg.register(
      "undo",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const running = reg.run("undo", {});
    setAgentContext({ surface: "app", project_id: "later_project" });
    finish({ ok: true });
    await running;
    await flushAgentEvents();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ surface: "mcp", project_id: "original_project" });
  });

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
