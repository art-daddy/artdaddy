// A turn that ends in an error is reported once, by the code the person was shown and the id of the failed call: a typed
// error round, a thrown failure, and a host that would not start. A Stop is not an error and is not reported.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runnerStart = vi.fn(async (_t: string) => {});
const runnerRetry = vi.fn(async () => {});
// Whether the live runner still holds a round that can be sent again.
const runnerState = { canRetry: true };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lastDeps: any = null;
vi.mock("../agent/loop", () => ({
  ClientTurnRunner: class {
    pending: unknown = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(deps: any) {
      lastDeps = deps;
    }
    start = (t: string) => runnerStart(t);
    takeUnsentResults = () => [];
    approve = async () => {};
    deny = async () => {};
    continueRun = async () => {};
    retry = () => runnerRetry();
    get canRetry() {
      return runnerState.canRetry;
    }
  },
}));
const hostReady: { current: Promise<void> } = { current: Promise.resolve() };
vi.mock("../tools/host", () => ({
  openToolHost: vi.fn((id: string) => ({
    projectId: id,
    get ready() {
      return hostReady.current;
    },
    has: () => false,
    run: vi.fn(async () => ({})),
    store: () => null,
  })),
}));
vi.mock("../agent/api", () => ({ inferRound: vi.fn(), inferRoundStreaming: vi.fn() }));
vi.mock("../agent/attachments", () => ({ collectInferenceAttachments: vi.fn() }));
vi.mock("../agent/historyFrames", () => ({ historyAttachments: vi.fn(async () => []) }));
vi.mock("./transcriptFile", () => ({
  loadClientSession: vi.fn(),
  persistSession: vi.fn(),
  persistSessionSoon: vi.fn(),
  persistSessionNow: vi.fn(async () => true),
}));
vi.mock("../api/appEvents", async (io) => ({
  ...(await io<typeof import("../api/appEvents")>()),
  reportTurnError: vi.fn(),
}));

import { reportTurnError } from "../api/appEvents";
import { RateLimitError, SessionExpiredError } from "../api/http";
import { CreditLimitError } from "../api/usage";
import { RoundHttpError } from "../agent/failureCopy";
import { ClientUpdateRequiredError } from "../update/updater";
import { clearRecentFailures, recentFailures } from "../observability/recentFailures";
import { __bufferedAgentEvents, __resetAgentEvents } from "../api/agentEvents";
import { useAuth } from "./auth";
import { useChat } from "./chat";
import { useEditor } from "./editor";

const emit = (event: string, data: unknown) => lastDeps.emit(event, data);

function setDesktop(pid: string) {
  useEditor.setState({
    projectId: pid,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store: { projectDir: "C:/p", writeProjectText: vi.fn() } as any,
    timeline: null,
  });
}

async function startTurn() {
  setDesktop("p1");
  useChat.setState({ projectId: "p1" });
  await useChat.getState().send("go");
}

beforeEach(() => {
  vi.clearAllMocks();
  lastDeps = null;
  hostReady.current = Promise.resolve();
  clearRecentFailures();
  useChat.setState({
    projectId: null,
    turns: [],
    session: null,
    providerSnapshot: null,
    streaming: false,
    pending: null,
    closing: false,
    error: null,
    model: "gpt-5.4-mini",
    effort: "high",
    mode: "default",
  });
  useEditor.setState({ projectId: null, store: null, timeline: null });
});
afterEach(() => clearRecentFailures());

describe("an error round", () => {
  it("is reported by its typed code and request id, and kept for a problem report", async () => {
    await startTurn();
    emit("error", {
      error: "Our own sentence.",
      error_code: "content_policy",
      request_id: "3f9c1a2b7d4e5f60",
    });
    expect(reportTurnError).toHaveBeenCalledTimes(1);
    expect(reportTurnError).toHaveBeenCalledWith("content_policy", "3f9c1a2b7d4e5f60");
    expect(recentFailures()).toMatchObject([
      { where: "turn", code: "content_policy", requestId: "3f9c1a2b7d4e5f60" },
    ]);
  });

  it("shows the person exactly the sentence it always did, with the code kept on the part", async () => {
    await startTurn();
    emit("error", { error: "Our own sentence.", error_code: "content_policy", request_id: "rid" });
    expect(useChat.getState().error).toBe("Our own sentence.");
    expect(useChat.getState().turns[0].parts.at(-1)).toEqual({
      kind: "error",
      error: "Our own sentence.",
      error_code: "content_policy",
      request_id: "rid",
    });
  });

  it("is reported as unknown when the server typed nothing", async () => {
    await startTurn();
    emit("error", { error: "boom" });
    expect(reportTurnError).toHaveBeenCalledWith("unknown", undefined);
  });
});

describe("a turn that throws", () => {
  it.each([
    [
      "a busy answer that ran out of retries, naming its call",
      Object.assign(new RateLimitError(), { requestId: "rid2" }),
      "rate_limited",
      "rid2",
    ],
    ["an HTTP failure", new Error("503: upstream down"), "http_503", undefined],
    ["a dropped connection", new TypeError("Failed to fetch"), "network", undefined],
    ["something nobody recognised", new Error("weird"), "unexpected", undefined],
  ])("%s", async (_name, error, code, requestId) => {
    runnerStart.mockRejectedValueOnce(error);
    await startTurn();
    expect(useChat.getState().turns[0].status).toBe("error");
    expect(reportTurnError).toHaveBeenCalledTimes(1);
    expect(reportTurnError).toHaveBeenCalledWith(code, requestId);
    expect(recentFailures()).toMatchObject([{ where: "turn", code }]);
  });

  it("is NOT reported when the person pressed Stop", async () => {
    runnerStart.mockRejectedValueOnce(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    await startTurn();
    expect(reportTurnError).not.toHaveBeenCalled();
    expect(recentFailures()).toEqual([]);
  });
});

// What the person reads, by the same failures: a sentence that says what happened and what to do, never the
// generic apology an unrecognised error used to get.
describe("what the person is told when a turn throws", () => {
  it.each([
    [
      "a round that timed out",
      Object.assign(new Error("x"), { name: "RoundTimeoutError", ms: 600_000 }),
      /10 minutes.*Nothing was changed/,
    ],
    [
      "a stream that went quiet",
      Object.assign(new Error("x"), { name: "StreamStalledError", idleMs: 90_000 }),
      /nothing arrived for 90 seconds/,
    ],
    [
      "the ledger unreachable",
      new RoundHttpError(503, "metering_unavailable", "{}"),
      /credit balance.*nothing was charged/i,
    ],
    ["a gateway restart", new RoundHttpError(502, null, "<html>"), /restarting or overloaded/],
    ["a dropped connection", new TypeError("Failed to fetch"), /Couldn't reach the server/],
    ["an error nobody typed", new Error("ECONNRESET"), /couldn't tell why/],
  ])("%s", async (_name, error, words) => {
    runnerStart.mockRejectedValueOnce(error);
    await startTurn();
    const shown = useChat.getState().turns[0].parts.at(-1) as unknown as { error: string };
    expect(shown.error).toMatch(words);
    expect(useChat.getState().error).toBe(shown.error);
    expect(shown.error).not.toMatch(/something went wrong|ECONNRESET/i);
  });
});

// Sending a failed turn again: one click, nothing retyped, and only when it can help.
describe("trying a failed turn again", () => {
  const credit = () => new CreditLimitError({ used: 99, limit: 100, remaining: 1, scope: "user" });

  beforeEach(() => {
    runnerState.canRetry = true;
    runnerRetry.mockReset();
    runnerRetry.mockResolvedValue(undefined);
  });

  it.each([
    ["a dropped connection", () => new TypeError("Failed to fetch"), true],
    ["a gateway restart", () => new RoundHttpError(502, null, "<html>"), true],
    [
      "a round that timed out",
      () => Object.assign(new Error("x"), { name: "RoundTimeoutError", ms: 6e5 }),
      true,
    ],
    ["no credits left", credit, false],
    ["an update that is needed", () => new ClientUpdateRequiredError(), false],
    ["a session that is gone", () => new SessionExpiredError(), false],
  ])(
    "after %s, is offered only if sending the round again can help",
    async (_name, make, offered) => {
      runnerStart.mockRejectedValueOnce(make());
      await startTurn();
      expect(useChat.getState().turns[0].status).toBe("error");
      expect(useChat.getState().canRetry).toBe(offered);
    },
  );

  it("is offered after an error round, and not when the runner holds no round to send again", async () => {
    await startTurn();
    emit("error", { error: "The AI provider had a problem.", error_code: "provider_unavailable" });
    expect(useChat.getState().canRetry).toBe(true);

    useChat.setState({ canRetry: false });
    runnerState.canRetry = false;
    emit("error", { error: "again" });
    expect(useChat.getState().canRetry).toBe(false);
  });

  it("sends the round again without retyping: the turn runs again, its error is gone, its earlier words stay", async () => {
    runnerStart.mockImplementationOnce(async () => {
      emit("tool_call", { call_id: "c1", name: "inspect_media", args: {} });
      emit("tool_result", { call_id: "c1", name: "inspect_media", ok: true });
      throw new TypeError("Failed to fetch");
    });
    await startTurn();
    expect(useChat.getState().turns[0].parts.some((p) => p.kind === "error")).toBe(true);

    let seen: { streaming: boolean; status: string; kinds: string[] } | null = null;
    runnerRetry.mockImplementationOnce(async () => {
      const s = useChat.getState();
      seen = {
        streaming: s.streaming,
        status: s.turns[0].status,
        kinds: s.turns[0].parts.map((p) => String(p.kind)),
      };
      emit("text", { text: "here you go" });
      emit("turn_done", { cost_usd: 0 });
    });
    await useChat.getState().retry();

    expect(runnerRetry).toHaveBeenCalledTimes(1);
    expect(runnerStart).toHaveBeenCalledTimes(1); // the message was not sent again
    expect(seen).toEqual({
      streaming: true,
      status: "streaming",
      kinds: ["tool_call", "tool_result"],
    });
    const after = useChat.getState();
    expect(after.turns[0].status).toBe("done");
    expect(after.turns[0].userText).toBe("go");
    expect(after.turns[0].parts.some((p) => p.kind === "error")).toBe(false);
    expect(after.error).toBeNull();
    expect(after.canRetry).toBe(false);
  });

  it("is offered again, with the new failure and only one error shown, when the retry fails too", async () => {
    runnerStart.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await startTurn();
    runnerRetry.mockRejectedValueOnce(new RoundHttpError(503, "metering_unavailable", "{}"));
    await useChat.getState().retry();

    const s = useChat.getState();
    const errors = s.turns[0].parts.filter((p) => p.kind === "error") as unknown as Array<{
      error: string;
    }>;
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/credit balance/);
    expect(s.canRetry).toBe(true);
  });

  it("is reported as its own go at the same turn: the first ended in its failure, the second says it is a retry", async () => {
    __resetAgentEvents();
    useAuth.setState({ status: "unlocked", profile: null, hasStoredSession: true });
    try {
      runnerStart.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await startTurn();
      runnerRetry.mockImplementationOnce(async () => {
        emit("text", { text: "ok" });
        emit("turn_done", { cost_usd: 0 });
      });
      await useChat.getState().retry();

      const events = __bufferedAgentEvents();
      expect(events.map((e) => [e.kind, e.trigger ?? e.outcome])).toEqual([
        ["turn_start", "user"],
        ["turn_end", "error"],
        ["turn_start", "retry"],
        ["turn_end", "done"],
      ]);
      expect(new Set(events.map((e) => e.turn_id)).size).toBe(1);
    } finally {
      __resetAgentEvents();
    }
  });

  it("does nothing when it is not offered, while a run is in progress, or once the project is closing", async () => {
    runnerStart.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await startTurn();
    for (const blocked of [{ canRetry: false }, { streaming: true }, { closing: true }]) {
      useChat.setState({ canRetry: true, streaming: false, closing: false, ...blocked });
      await useChat.getState().retry();
    }
    expect(runnerRetry).not.toHaveBeenCalled();
  });

  it("is not offered for a round the runner no longer holds", async () => {
    runnerStart.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await startTurn();
    runnerState.canRetry = false;
    await useChat.getState().retry();
    expect(runnerRetry).not.toHaveBeenCalled();
  });

  it.each([
    ["a new message", async () => useChat.getState().send("something else")],
    ["Stop", async () => useChat.getState().stop()],
    ["leaving the project", async () => useChat.getState().deactivate()],
  ])("is no longer offered after %s", async (_name, act) => {
    runnerStart.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await startTurn();
    expect(useChat.getState().canRetry).toBe(true);
    await act();
    expect(useChat.getState().canRetry).toBe(false);
  });
});

describe("a tool host that would not start", () => {
  it("ends the turn as an error and says so", async () => {
    const failed = Promise.reject(new Error("fs broke"));
    failed.catch(() => undefined);
    hostReady.current = failed;
    await startTurn();
    expect(useChat.getState().turns[0].status).toBe("error");
    expect(reportTurnError).toHaveBeenCalledWith("host_unavailable", undefined);
  });
});

describe("a turn that works", () => {
  it("reports nothing", async () => {
    await startTurn();
    emit("turn_done", { cost_usd: 0 });
    expect(reportTurnError).not.toHaveBeenCalled();
    expect(recentFailures()).toEqual([]);
  });
});
