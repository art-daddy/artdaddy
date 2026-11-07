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
  LOOK_COUNT_FIELDS,
  LOOK_FACT_FIELDS,
  LOOK_MS_FIELDS,
  LOOK_OUTCOMES,
  MAX_CALL_MS,
  MAX_LOOK_DIM,
  MAX_LOOK_KBPS,
  MAX_LOOK_SECONDS,
  MAX_TURN_COUNT,
  MAX_TURN_MS,
  parseServerTiming,
  preview,
  recordAgentOutput,
  recordLook,
  recordToolCall,
  recordToolDenied,
  recordTurnEnd,
  setAgentContext,
  TURN_COUNT_FIELDS,
  TURN_MS_FIELDS,
  TURN_SERVER_FIELDS,
} from "./agentEvents";
import type { LookReport } from "../tools/lookReport";
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

  // What the real tools do when Stop aborts them. They go through the registry, the one dispatch boundary every
  // call passes through, so that is what these tests use: a mocked dispatch would never see the answers the registry
  // makes. Vision and video tools catch the abort and answer with its words, a handler that throws is answered for
  // by the registry ("tool: message"), and the look and caption tools answer the marker.
  describe("a call that Stop ended", () => {
    const WAYS: [string, () => Promise<unknown>, string][] = [
      [
        "answers with the abort's words",
        async () => ({ ok: false, error: "signal is aborted without reason" }),
        "signal is aborted without reason",
      ],
      [
        "throws an AbortError",
        async () => {
          throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
        },
        "video_ask: The operation was aborted.",
      ],
      [
        "throws an Error that says aborted",
        async () => {
          throw new Error("The user aborted a request.");
        },
        "video_ask: The user aborted a request.",
      ],
      [
        "answers a host failure that says cancelled",
        async () => ({ ok: false, error: "encode for gemini failed: cancelled" }),
        "encode for gemini failed: cancelled",
      ],
      ["answers the marker", async () => ({ ok: false, error: "cancelled" }), "cancelled"],
    ];
    async function recorded(handler: () => Promise<unknown>, pressedStop: boolean) {
      const registry = new ClientToolRegistry();
      let stopped = false;
      registry.register("video_ask", async () => {
        stopped = pressedStop;
        return (await handler()) as never;
      });
      const submitted = agentEventContext();
      let rounds = 0;
      const runner = new ClientTurnRunner({
        eventContext: () => submitted,
        infer: async () => {
          const first = ++rounds === 1;
          return {
            kind: first ? "tool_calls" : "text",
            pending_calls: first ? [{ name: "video_ask", call_id: "call_1", arguments: {} }] : [],
            final_text: "",
            error: "",
            finish_reason: "",
            usage: {},
            provider_snapshot: {},
          };
        },
        runTool: (name, args, trace) => registry.run(name, args, trace.context, trace),
        emit: () => undefined,
        mode: () => "autopilot",
        stopped: () => stopped,
        onUsage: () => undefined,
        session: () => ({}),
      });
      await runner.start("go");
      await vi.waitFor(() => expect(posted).toHaveLength(1));
      return (posted[0] as { events: Record<string, unknown>[] }).events;
    }

    it.each(WAYS)(
      "is recorded as cancelled, the word the tool-failure analysis filters on, when it %s",
      async (_name, handler) => {
        const events = await recorded(handler, true);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          kind: "tool_call",
          name: "video_ask",
          call_id: "call_1",
          ok: false,
          error: "cancelled",
        });
      },
    );

    it.each(WAYS)(
      "is recorded as what it said when nobody pressed Stop, when it %s",
      async (_name, handler, said) => {
        const events = await recorded(handler, false);
        expect(events[0]).toMatchObject({ ok: false, error: said });
      },
    );

    it("keeps a real failure that comes after Stop", async () => {
      const events = await recorded(async () => ({ ok: false, error: "disk full" }), true);
      expect(events[0]).toMatchObject({ ok: false, error: "disk full" });
    });

    it("keeps a call that finished anyway as the success it was", async () => {
      const events = await recorded(async () => ({ ok: true, answer: "a red apple" }), true);
      expect(events[0]).toMatchObject({ ok: true, error: "" });
    });
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

// The program that drives the editor over MCP is only worth knowing if it reaches the server. These read the
// bodies that were actually POSTed (what the server receives), not the labels the bridge hands over: a field
// the sender drops leaves the bridge's own test green and every row on the server without a program.
describe("which outside program drove the editor, as the server receives it", () => {
  const program = (client: string, name: string, version: string) => ({
    ...agentEventContext(),
    surface: "mcp",
    project_id: "external_project",
    mcp_client: client,
    mcp_client_name: name,
    mcp_client_version: version,
  });
  const call = (tool: string, labels: ReturnType<typeof program>) =>
    createToolTrace(tool, {}, labels, `${tool}-1`).result({ ok: true });

  it("says which program made the calls: its label, the name it announced and its version", async () => {
    call("undo", program("claude_code", "claude-code", "2.1.4"));
    await flushAgentEvents();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      surface: "mcp",
      mcp_client: "claude_code",
      mcp_client_name: "claude-code",
      mcp_client_version: "2.1.4",
      events: [{ name: "undo" }],
    });
  });

  it("keeps two programs' calls apart, each flushed under the program that made it", async () => {
    call("undo", program("claude_code", "claude-code", "2.1.4"));
    call("redo", program("cursor", "cursor-vscode", "0.9"));
    await flushAgentEvents();
    const seen = (posted as { mcp_client: string; events: { name: string }[] }[]).map((body) => [
      body.mcp_client,
      body.events.map((event) => event.name),
    ]);
    expect(seen).toEqual([
      ["claude_code", ["undo"]],
      ["cursor", ["redo"]],
    ]);
  });

  it("says nothing of a program for the app's own agent, and none carries over from an MCP call", async () => {
    call("undo", program("claude_code", "claude-code", "2.1.4"));
    recordAgentOutput("the app's own answer");
    await flushAgentEvents();
    expect(posted).toHaveLength(2);
    const [mcp, app] = posted as Record<string, unknown>[];
    expect(mcp.mcp_client).toBe("claude_code");
    expect(app.surface).toBe("app");
    expect(Object.keys(app).filter((key) => key.startsWith("mcp_"))).toEqual([]);
  });

  it("says a program announced nothing, rather than saying nothing", async () => {
    call("undo", program("unknown", "", ""));
    await flushAgentEvents();
    expect(posted[0]).toMatchObject({
      mcp_client: "unknown",
      mcp_client_name: "",
      mcp_client_version: "",
    });
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

// A look at footage (tools/lookReport.ts) is said with its own event. These read the body that was POSTed, because the
// server drops a field it does not know and refuses the whole flush over a number outside its range.
describe("a look, as the server receives it", () => {
  const report = (over: Partial<LookReport> = {}): LookReport => ({
    tool: "inspect_timeline",
    outcome: "partial",
    ms: 41_000,
    frames_ms: 40_000,
    slowest_ms: 31_000,
    frames: 6,
    cached: 1,
    gpu: 2,
    retried: 1,
    failed: 1,
    layers: 3,
    source: { codec: "hevc", width: 3840, height: 2160, dur_s: 612, kbps: 48_000 },
    ...over,
  });
  const sentEvent = async (): Promise<Record<string, unknown>> => {
    await flushAgentEvents();
    return (posted[0] as { events: Record<string, unknown>[] }).events[0];
  };

  it("carries every fact of the report, joined to its tool call by the call's id", async () => {
    recordLook(report(), "call_9");
    expect(await sentEvent()).toMatchObject({
      kind: "look",
      name: "inspect_timeline",
      call_id: "call_9",
      outcome: "partial",
      ms: 41_000,
      frames: 6,
      cached: 1,
      gpu: 2,
      retried: 1,
      failed: 1,
      layers: 3,
      frames_ms: 40_000,
      slowest_ms: 31_000,
      codec: "hevc",
      width: 3840,
      height: 2160,
      dur_s: 612,
      kbps: 48_000,
    });
  });

  it("is under the labels of the call it belongs to, not the next one's", async () => {
    setAgentContext({ surface: "app", project_id: "later" });
    recordLook(report(), "c", { ...agentEventContext(), surface: "mcp", project_id: "original" });
    await flushAgentEvents();
    expect(posted[0]).toMatchObject({ surface: "mcp", project_id: "original" });
  });

  it("says zero for what it does not know of its source, and carries nothing a person wrote", async () => {
    recordLook(report({ source: undefined }), "c");
    const event = await sentEvent();
    expect(event).toMatchObject({ codec: "", width: 0, height: 0, dur_s: 0, kbps: 0 });
    for (const key of ["args", "result", "error", "text", "ok", "path"])
      expect(event).not.toHaveProperty(key);
  });

  it("clamps every number to what the server accepts, so one absurd look cannot refuse the flush with it", async () => {
    recordLook(
      report({
        ms: 1e15,
        frames_ms: 1e15,
        slowest_ms: -5,
        frames: 1e9,
        failed: Number.NaN,
        source: { codec: "hevc", width: 1e9, height: 1e9, dur_s: 1e12, kbps: 1e12 },
      }),
      "c",
    );
    const event = await sentEvent();
    expect(event).toMatchObject({
      ms: MAX_CALL_MS,
      frames_ms: MAX_TURN_MS,
      slowest_ms: 0,
      frames: MAX_TURN_COUNT,
      failed: 0,
      width: MAX_LOOK_DIM,
      height: MAX_LOOK_DIM,
      dur_s: MAX_LOOK_SECONDS,
      kbps: MAX_LOOK_KBPS,
    });
  });

  it("puts a call id and a codec in the alphabet the server keeps, never a path", async () => {
    recordLook(
      report({ source: { codec: "C:\\Users\\me\\v.mp4" } }),
      "id with spaces/and\\slashes",
    );
    const event = await sentEvent();
    expect(event.call_id).toBe("id_with_spaces_and_slashes");
    expect(event.codec).toMatch(/^[A-Za-z0-9_.:-]*$/);
  });

  it("is not a tool call: it adds no failure, and a tool call is still its own event", async () => {
    recordLook(report(), "c");
    recordToolCall({ name: "inspect_timeline", call_id: "c", ok: true, ms: 41_000 });
    await flushAgentEvents();
    expect((posted[0] as { events: { kind: string }[] }).events.map((e) => e.kind)).toEqual([
      "look",
      "tool_call",
    ]);
  });

  it("has a word and a bound for every field the server reads (the lists the conformance test compares)", () => {
    const event = (() => {
      recordLook(report(), "c");
      return __bufferedAgentEvents()[0] as unknown as Record<string, unknown>;
    })();
    for (const key of [
      ...LOOK_COUNT_FIELDS,
      ...LOOK_MS_FIELDS,
      ...LOOK_FACT_FIELDS,
      "ms",
      "codec",
      "outcome",
    ])
      expect(event, key).toHaveProperty(key);
    expect(LOOK_OUTCOMES).toContain(event.outcome);
  });
});

describe("the server's timing, as a turn's end says it", () => {
  const summary = {
    wall_ms: 1,
    prep_ms: 0,
    request_ms: 0,
    think_ms: 0,
    stream_ms: 0,
    tool_ms: 0,
    wait_ms: 0,
    approval_ms: 0,
    other_ms: 1,
    rounds: 1,
    tools: 0,
    approvals: 0,
    reconnects: 0,
    busy_waits: 0,
    frames: 0,
    bytes_up: 0,
  };
  const timing = {
    rounds: 3,
    intake_ms: 900,
    line_ms: 0,
    admit_ms: 3_300,
    vendor_ms: 33_000,
    settle_ms: 1_200,
  };

  it("names how many rounds reported and sums their parts", async () => {
    recordTurnEnd({ turn_id: "t1", outcome: "done", server: timing, summary });
    await flushAgentEvents();
    const [event] = (posted[0] as { events: Record<string, unknown>[] }).events;
    expect(event).toMatchObject({
      srv_rounds: 3,
      srv_intake_ms: 900,
      srv_line_ms: 0,
      srv_admit_ms: 3_300,
      srv_vendor_ms: 33_000,
      srv_settle_ms: 1_200,
    });
  });

  it("says nothing of it when no round reported, rather than zeros", () => {
    recordTurnEnd({ turn_id: "t1", outcome: "done", summary });
    recordTurnEnd({ turn_id: "t2", outcome: "done", server: { ...timing, rounds: 0 }, summary });
    for (const event of __bufferedAgentEvents())
      for (const key of TURN_SERVER_FIELDS) expect(event).not.toHaveProperty(key);
  });

  it("clamps to what the server accepts", () => {
    recordTurnEnd({
      turn_id: "t1",
      outcome: "done",
      server: {
        rounds: 1e9,
        intake_ms: 1e15,
        line_ms: -1,
        admit_ms: Number.NaN,
        vendor_ms: 1e15,
        settle_ms: 5,
      },
      summary,
    });
    expect(__bufferedAgentEvents()[0]).toMatchObject({
      srv_rounds: MAX_TURN_COUNT,
      srv_intake_ms: MAX_TURN_MS,
      srv_line_ms: 0,
      srv_admit_ms: 0,
      srv_vendor_ms: MAX_TURN_MS,
      srv_settle_ms: 5,
    });
  });

  it("is not a part of the wall time, which keeps adding up without it", () => {
    for (const key of TURN_SERVER_FIELDS) {
      expect(TURN_MS_FIELDS as readonly string[]).not.toContain(key);
      expect(TURN_COUNT_FIELDS as readonly string[]).not.toContain(key);
    }
  });
});

describe("reading the server's timing frame", () => {
  const frame = {
    intake_ms: 250.4,
    line_ms: 0,
    admit_ms: 500,
    vendor_ms: 11_000,
    settle_ms: 399.6,
  };

  it("takes the five parts as whole milliseconds and ignores anything else the frame carries", () => {
    expect(parseServerTiming({ ...frame, a_future_part_ms: 7, note: "x" })).toEqual({
      intake_ms: 250,
      line_ms: 0,
      admit_ms: 500,
      vendor_ms: 11_000,
      settle_ms: 400,
    });
  });

  it("refuses a frame that is not whole: a missing part, a negative, a non-number, not an object", () => {
    for (const bad of [
      null,
      undefined,
      "x",
      3,
      [],
      {},
      { ...frame, settle_ms: undefined },
      { ...frame, vendor_ms: -1 },
      { ...frame, vendor_ms: Number.NaN },
      { ...frame, admit_ms: Number.POSITIVE_INFINITY },
      { ...frame, line_ms: "0" },
    ])
      expect(parseServerTiming(bad)).toBeNull();
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
