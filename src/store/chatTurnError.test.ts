// A turn that ends in an error is reported once, by the code the person was shown and the id of the failed call: a typed
// error round, a thrown failure, and a host that would not start. A Stop is not an error and is not reported.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runnerStart = vi.fn(async (_t: string) => {});
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
import { RateLimitError } from "../api/http";
import { clearRecentFailures, recentFailures } from "../observability/recentFailures";
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
    emit("error", { error: "Our own sentence.", error_code: "content_policy", request_id: "3f9c1a2b7d4e5f60" });
    expect(reportTurnError).toHaveBeenCalledTimes(1);
    expect(reportTurnError).toHaveBeenCalledWith("content_policy", "3f9c1a2b7d4e5f60");
    expect(recentFailures()).toMatchObject([{ where: "turn", code: "content_policy", requestId: "3f9c1a2b7d4e5f60" }]);
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
    ["a busy answer that ran out of retries, naming its call", Object.assign(new RateLimitError(), { requestId: "rid2" }), "rate_limited", "rid2"],
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
