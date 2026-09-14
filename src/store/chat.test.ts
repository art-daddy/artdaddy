import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { disposeChatStore, getChatStore, isChatExecutionCurrent, useChat } from "./chat";
import { useEditor } from "./editor";
import { __resetJobNotes, notifyJobSettled, pendingJobNotes, type SettledJob } from "./jobNotes";
import { loadClientSession, persistSession, persistSessionSoon } from "./transcriptFile";
import { inferRoundStreaming } from "../agent/api";
import { openToolHost } from "../tools/host";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// The client-owned loop replaces the SSE stream: `send`/`approve`/... build a
// ClientTurnRunner and drive it. We fake the runner so we can (a) assert the
// store delegates to it and (b) drive the store's `apply` reducer by calling the
// `emit` dep it was constructed with — the same event shapes the real runner emits.
const runnerStart = vi.fn(async (_t: string) => {});
const runnerApprove = vi.fn(async (_id?: string) => {});
const runnerDeny = vi.fn(async (_r: string, _id?: string) => {});
const runnerContinue = vi.fn(async () => {});
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
    approve = (id?: string) => runnerApprove(id);
    deny = (r: string, id?: string) => runnerDeny(r, id);
    continueRun = () => runnerContinue();
  },
}));
vi.mock("../tools/host", () => ({
  openToolHost: vi.fn((id: string) => ({
    projectId: id,
    ready: Promise.resolve(),
    has: () => false,
    run: vi.fn(async () => ({})),
    store: () => null,
  })),
}));
vi.mock("../agent/api", () => ({ inferRound: vi.fn(), inferRoundStreaming: vi.fn() }));
vi.mock("../agent/attachments", () => ({ collectInferenceAttachments: vi.fn() }));
vi.mock("./transcriptFile", () => ({
  loadClientSession: vi.fn(),
  persistSession: vi.fn(),
  persistSessionSoon: vi.fn(),
  persistSessionNow: vi.fn(async () => true),
}));

const loadSess = loadClientSession as unknown as ReturnType<typeof vi.fn>;
/** Drive the store's reducer the way the runner does, through the captured deps. */
const emit = (event: string, data: unknown) => lastDeps.emit(event, data);

function reset() {
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
}

function snap(over: Record<string, unknown> = {}) {
  return {
    cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    approval_mode: "default",
    finished: true,
    pending: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  lastDeps = null;
  reset();
  useEditor.setState({ projectId: null, store: null, timeline: null });
});

/** Put the editor into a desktop state (a co-located store the loop persists into). */
function setDesktop(pid: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useEditor.setState({
    projectId: pid,
    store: { projectDir: "C:/p", writeProjectText: vi.fn() } as any,
    timeline: null,
  });
}

describe("isChatExecutionCurrent (origin fence source)", () => {
  it("is current only for the live transcript id + execution token", () => {
    getChatStore("pf").setState({ transcriptId: "t1", execToken: 7 });
    const at = (executionId: number, chatSessionId = "t1") =>
      isChatExecutionCurrent("pf", { chatSessionId, branchId: 0, executionId });
    expect(at(7)).toBe(true);
    expect(at(6)).toBe(false); // a superseded/older execution token
    expect(at(7, "other")).toBe(false); // a different transcript (chat session)
    expect(
      isChatExecutionCurrent("unknown", { chatSessionId: "t1", branchId: 0, executionId: 7 }),
    ).toBe(false); // no chat instance
    disposeChatStore("pf");
  });
});

// The wake is a CHAIN — a job settles, a queue debounces it, a sink delivers it, the store starts
// a turn. Every link was tested alone; none of them proved the chain carries anything. These
// drive the real store from the real notify entry point.
describe("background jobs wake the chat", () => {
  const JOB: SettledJob = {
    id: "j1",
    tool: "generate_image",
    label: "a hero still",
    status: "done",
    startedBy: "chat",
    media_refs: ["media_gen_abc"],
  };

  function setDesktopWithLibrary(pid: string) {
    useEditor.setState({
      projectId: pid,
      // refreshMedia() runs on delivery and reads the catalog.
      store: {
        projectDir: "C:/p",
        writeProjectText: vi.fn(),
        listClips: vi.fn(async () => []),
      } as Any,
      timeline: null,
    });
  }

  /** Let the settle window elapse and the resulting async send run. */
  async function settleAndDrain() {
    await vi.advanceTimersByTimeAsync(2000);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }

  beforeEach(() => {
    __resetJobNotes();
    loadSess.mockResolvedValue({ requests: [], providerSnapshot: null, session: snap() });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetJobNotes();
  });

  it("starts a turn naming the finished media, marked as a system note", async () => {
    setDesktopWithLibrary("p1");
    await useChat.getState().load("p1");
    await Promise.resolve(); // the sink registers on a microtask

    notifyJobSettled("C:/p", JOB);
    expect(runnerStart).not.toHaveBeenCalled(); // still gathering — not delivered on arrival
    await settleAndDrain();

    expect(runnerStart).toHaveBeenCalledTimes(1);
    expect(runnerStart.mock.calls[0][0]).toContain("media_gen_abc");
    const last = useChat.getState().turns.at(-1);
    expect(last?.system).toBe(true);
  });

  it("holds the note while a turn is streaming instead of interrupting it", async () => {
    setDesktopWithLibrary("p1");
    await useChat.getState().load("p1");
    await Promise.resolve();
    useChat.setState({ streaming: true });

    notifyJobSettled("C:/p", JOB);
    await settleAndDrain();

    expect(runnerStart).not.toHaveBeenCalled();
    expect(pendingJobNotes("C:/p")).toHaveLength(1); // kept, not dropped
  });

  it("does not deliver into a project the chat has left", async () => {
    setDesktopWithLibrary("p1");
    await useChat.getState().load("p1");
    await Promise.resolve();

    // The editor moved on; the chat must not narrate p1's media into p2's transcript.
    useEditor.setState({ projectId: "p2", store: null, timeline: null } as Any);
    await useChat.getState().load("p2");
    await Promise.resolve();

    notifyJobSettled("C:/p", JOB);
    await settleAndDrain();

    expect(runnerStart).not.toHaveBeenCalled();
  });
});

describe("useChat.load", () => {
  it("maps transcript requests to turns and sets session", async () => {
    loadSess.mockResolvedValue({
      requests: [
        {
          id: "r1",
          message: { text: "hi", attachments: [{ path: "/a.mp4", kind: "video", name: "a" }] },
          response: [{ kind: "text", text: "ok" }],
        },
      ],
      providerSnapshot: null,
      session: snap({ cost_usd: 0.1 }),
    });
    await useChat.getState().load("p1");
    const st = useChat.getState();
    expect(st.projectId).toBe("p1");
    expect(st.turns).toHaveLength(1);
    expect(st.turns[0].userText).toBe("hi");
    expect(st.turns[0].attachments[0].path).toBe("/a.mp4");
    expect(st.session?.cost_usd).toBe(0.1);
  });
});

describe("useChat project-switch isolation", () => {
  it("drops a previous project's late loop events after switching", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    await useChat.getState().send("p1 prompt");
    const p1 = lastDeps; // the loop deps bound to p1's loopToken
    p1.emit("reasoning", { text: "p1 thinking" }); // lands in p1's turn
    expect(useChat.getState().turns[0].parts).toHaveLength(1);

    // Switch to p2 while p1's runner is still "live".
    loadSess.mockResolvedValue({ requests: [], providerSnapshot: null, session: snap() });
    await useChat.getState().load("p2");
    expect(useChat.getState().projectId).toBe("p2");
    expect(useChat.getState().turns).toHaveLength(0);

    // p1's runner keeps emitting — a stale loopToken MUST drop these.
    p1.emit("reasoning", { text: "leak" });
    p1.emit("text", { text: "p1 answer" });
    expect(useChat.getState().turns).toHaveLength(0);
  });
});

describe("useChat.send + event reducer", () => {
  it("drives a bypass turn to final via the client loop", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    await useChat.getState().send("edit it");
    expect(runnerStart).toHaveBeenCalledWith("edit it");

    emit("turn_start", { request_id: "r" });
    emit("reasoning", { text: "think" });
    emit("tool_call", { name: "get_timeline", args: {} });
    emit("tool_result", { name: "get_timeline", ok: true, result: {} });
    emit("text", { text: "done" });
    emit("final", { text: "done" }); // repeats assistant text — reducer must not dup
    emit("turn_done", snap({ cost_usd: 0.01, input_tokens: 5 }));

    const st = useChat.getState();
    expect(st.turns[0].parts.map((p) => p.kind)).toEqual([
      "reasoning",
      "tool_call",
      "tool_result",
      "text",
    ]);
    expect(st.turns[0].status).toBe("done");
    expect(st.streaming).toBe(false);
    expect(st.session?.cost_usd).toBe(0.01);
  });

  it("pauses on awaiting_approval, then approve resumes the runner", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    await useChat.getState().send("make art");
    emit("tool_call", { name: "generate_image", args: {} });
    emit("awaiting_approval", {
      calls: [
        {
          call_id: "c1",
          name: "generate_image",
          arguments: {},
          rationale: "",
          reasoning_summary: [],
        },
      ],
    });
    emit("turn_paused", snap({ finished: false, pending: true }));
    expect(useChat.getState().pending?.[0].name).toBe("generate_image");
    expect(useChat.getState().turns[0].status).toBe("awaiting");

    await useChat.getState().approve();
    expect(runnerApprove).toHaveBeenCalled();
    expect(useChat.getState().pending).toEqual([]);
    emit("final", { text: "made" });
    emit("turn_done", snap({ cost_usd: 0.2 }));
    expect(useChat.getState().turns[0].status).toBe("done");
  });

  it("surfaces every gated call in the round at once, and answers them one by one", async () => {
    // The point of batching: a round with three paid reads interrupts the user ONCE.
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    await useChat.getState().send("look at these");
    const call = (id: string, name: string) => ({
      call_id: id,
      name,
      arguments: {},
      rationale: "",
      reasoning_summary: [],
    });
    emit("awaiting_approval", {
      calls: [call("c1", "video_ask"), call("c2", "image_ask"), call("c3", "vision_describe")],
    });

    expect(useChat.getState().pending).toHaveLength(3);

    await useChat.getState().approve("c2");
    // Only the answered one leaves; the turn is still waiting on the other two.
    expect(useChat.getState().pending?.map((p) => p.call_id)).toEqual(["c1", "c3"]);
    expect(useChat.getState().turns[0].status).not.toBe("streaming");

    await useChat.getState().deny("no", "c1");
    await useChat.getState().approve("c3");
    expect(useChat.getState().pending).toEqual([]);
  });

  it("still understands a single bare approval payload", async () => {
    // Older shape: one call, not wrapped in `calls`.
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    await useChat.getState().send("hi");
    emit("awaiting_approval", {
      call_id: "c9",
      name: "generate_image",
      arguments: {},
      rationale: "",
      reasoning_summary: [],
    });
    expect(useChat.getState().pending?.[0].call_id).toBe("c9");
  });

  it("deny resumes the runner with a reason", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    await useChat.getState().send("make art");
    emit("awaiting_approval", {
      call_id: "c",
      name: "x",
      arguments: {},
      rationale: "",
      reasoning_summary: [],
    });
    await useChat.getState().deny("no");
    expect(runnerDeny).toHaveBeenCalledWith("no", "c");
    expect(useChat.getState().pending).toEqual([]);
  });

  it("marks the turn errored on an error event", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    await useChat.getState().send("go");
    emit("error", { error: "boom" });
    expect(useChat.getState().error).toBe("boom");
    expect(useChat.getState().turns[0].status).toBe("error");
  });

  it("handles a runner throw WITHOUT leaking the raw error to the user", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    runnerStart.mockRejectedValueOnce(new Error("neterr"));
    await useChat.getState().send("go");
    expect(useChat.getState().streaming).toBe(false);
    // Presentation boundary: a human sees a clean sentence, never the raw "neterr".
    const shown = useChat.getState().error ?? "";
    expect(shown).not.toContain("neterr");
    expect(shown).toBeTruthy();
    expect(useChat.getState().turns[0].status).toBe("error");
  });

  it("a network failure shows a connectivity message, not a raw fetch error", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    runnerStart.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await useChat.getState().send("go");
    expect(useChat.getState().error).toBe(
      "Couldn't reach the server. Check your connection and try again.",
    );
  });

  it("send is a no-op without a project, while streaming, or with blank text", async () => {
    await useChat.getState().send("hi");
    useChat.setState({ projectId: "p1", streaming: true });
    await useChat.getState().send("hi");
    useChat.setState({ streaming: false });
    await useChat.getState().send("   ");
    expect(runnerStart).not.toHaveBeenCalled();
  });

  it("the admission fence (closing) refuses send until resume() lowers it (finding #2)", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    // Quiesce raises the fence (close SAVE phase): a send must NOT start a NEW turn that could enqueue
    // a snapshot after the close's final one.
    useChat.getState().quiesce();
    expect(useChat.getState().closing).toBe(true);
    await useChat.getState().send("while closing");
    expect(runnerStart).not.toHaveBeenCalled();
    // Keep editing: resume lowers the fence -> send is admitted again.
    useChat.getState().resume();
    expect(useChat.getState().closing).toBe(false);
    await useChat.getState().send("after resume");
    expect(runnerStart).toHaveBeenCalledWith("after resume");
  });

  it("quiesce during an active turn clears the stuck streaming/pending flags (finding #2)", () => {
    setDesktop("p1");
    useChat.setState({
      projectId: "p1",
      streaming: true,
      pending: { tool: "x" } as Any,
      canContinue: true,
    });
    useChat.getState().quiesce();
    expect(useChat.getState().streaming).toBe(false); // no eternal spinner after the turn is retired
    expect(useChat.getState().pending).toBeNull();
    expect(useChat.getState().canContinue).toBe(false);
    expect(useChat.getState().closing).toBe(true);
  });

  it("quiesce NORMALIZES the aborted turn (status done + provider reset) like Stop (finding #4)", () => {
    setDesktop("p1");
    useChat.setState({
      projectId: "p1",
      streaming: true,
      providerSnapshot: { previous_response_id: "mid-turn" },
      turns: [
        {
          id: "t1",
          userText: "a",
          attachments: [],
          parts: [],
          status: "streaming",
          undone: false,
          checkpoint: null,
          timelineAfter: null,
        },
      ],
    });
    useChat.getState().quiesce();
    expect(useChat.getState().turns[0].status).toBe("done"); // no stuck spinner in the UI
    expect(useChat.getState().providerSnapshot).toBeNull(); // the invalidated mid-turn chain is reset
    expect(useChat.getState().streaming).toBe(false);
    expect(useChat.getState().closing).toBe(true);
  });

  it("whenQuiescent awaits an ALREADY-ADMITTED undo before resolving (finding #2)", async () => {
    const persist = persistSession as unknown as ReturnType<typeof vi.fn>;
    let releasePersist!: () => void;
    persist.mockReturnValueOnce(new Promise<void>((r) => (releasePersist = r)));
    setDesktop("p1");
    useChat.setState({
      projectId: "p1",
      session: snap(),
      turns: [
        {
          id: "t1",
          userText: "a",
          attachments: [],
          parts: [],
          status: "done",
          undone: false,
          checkpoint: null,
          timelineAfter: null,
        },
      ],
    });
    const undoP = useChat.getState().undo(); // admitted; in flight — stalled on its persist
    let quiescent = false;
    const qP = useChat
      .getState()
      .whenQuiescent()
      .then(() => (quiescent = true));
    await new Promise((r) => setTimeout(r, 0)); // let the undo reach its stalled persist
    expect(quiescent).toBe(false); // the close SAVE must NOT capture the final snapshot mid-undo
    releasePersist(); // the undo's transcript write completes
    await undoP;
    await qP;
    expect(quiescent).toBe(true); // whenQuiescent resolves only after the in-flight op lands IN FULL
    expect(useChat.getState().turns[0].undone).toBe(true);
  });

  it("approve/deny are no-ops without a pending call", async () => {
    useChat.setState({ projectId: "p1", pending: null });
    await useChat.getState().approve();
    await useChat.getState().deny();
    expect(runnerApprove).not.toHaveBeenCalled();
    expect(runnerDeny).not.toHaveBeenCalled();
  });
});

describe("useChat controls + session ops", () => {
  it("undo marks the last turn undone client-side; redo reverses it", async () => {
    useChat.setState({
      projectId: "p1",
      session: snap(),
      providerSnapshot: { previous_response_id: "r1" },
      turns: [
        {
          id: "t1",
          userText: "a",
          attachments: [],
          parts: [],
          status: "done",
          undone: false,
          checkpoint: null,
          timelineAfter: null,
        },
      ],
    });
    setDesktop("p1");
    await useChat.getState().undo();
    expect(useChat.getState().turns[0].undone).toBe(true);
    expect(useChat.getState().providerSnapshot).toBeNull();
    expect(useChat.getState().session?.can_undo).toBe(false);
    expect(useChat.getState().session?.can_redo).toBe(true);

    await useChat.getState().redo();
    expect(useChat.getState().turns[0].undone).toBe(false);
    expect(useChat.getState().session?.can_undo).toBe(true);
  });

  it("binds each op to its own project instance: A's undo never touches B (finding #2)", async () => {
    // Two independent project instances. Previously a SINGLE chat store routed every
    // project's writes, so an undo on the project the user just LEFT (A) whose set()
    // landed after they switched corrupted the now-active project (B). Each instance now
    // owns its own set/get, so A's undo can only ever mutate A.
    const mk = (id: string) =>
      ({
        id,
        userText: id,
        attachments: [],
        parts: [],
        status: "done",
        undone: false,
        checkpoint: null,
        timelineAfter: null,
      }) as Any;
    const a = getChatStore("A");
    const b = getChatStore("B");
    a.setState({
      projectId: "A",
      session: snap(),
      providerSnapshot: { previous_response_id: "rA" },
      turns: [mk("tA")],
    });
    b.setState({ projectId: "B", session: snap(), turns: [mk("tB")] });
    // A's undo reads the editor for its store; point it at A (the user then switches to B
    // mid-op -- but A's undo already captured A's editor + is bound to A's set).
    setDesktop("A");
    const p = a.getState().undo();
    setDesktop("B"); // user switched projects while A's undo was settling its persist
    await p;
    expect(a.getState().turns[0].undone).toBe(true); // A's undo landed on A's instance
    expect(b.getState().turns).toEqual([expect.objectContaining({ id: "tB", undone: false })]); // ...B untouched
    disposeChatStore("A");
    disposeChatStore("B");
  });

  it("setControls updates model/mode; refreshState recomputes the session", async () => {
    useChat.setState({ projectId: "p1" });
    useChat.getState().setControls({ model: "gpt-5.4", mode: "autopilot" });
    expect(useChat.getState().model).toBe("gpt-5.4");
    expect(useChat.getState().mode).toBe("autopilot");
    useChat.setState({ session: snap({ cost_usd: 1 }) });
    await useChat.getState().refreshState();
    expect(useChat.getState().session?.cost_usd).toBe(1);
  });

  it("session ops are no-ops without a project", async () => {
    await useChat.getState().undo();
    await useChat.getState().redo();
    await useChat.getState().stop();
    await useChat.getState().refreshState();
    expect(useChat.getState().turns).toHaveLength(0);
  });
});

describe("useChat loop deps + remaining actions", () => {
  it("infer builds the round body (ids + model), calls the round, stores the refreshed snapshot", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1", transcriptId: "tx1", model: "gpt-5.4-mini" });
    await useChat.getState().send("hi");
    (inferRoundStreaming as Any).mockResolvedValue({
      kind: "text",
      final_text: "ok",
      usage: {},
      provider_snapshot: { previous_response_id: "R" },
    });
    const dto = await lastDeps.infer({ user_text: "hi" }, []);
    expect(dto.kind).toBe("text");
    const body = (inferRoundStreaming as Any).mock.calls.at(-1)[0];
    expect(body).toMatchObject({ model: "gpt-5.4-mini", project_id: "p1", transcript_id: "tx1" });
    expect(useChat.getState().providerSnapshot).toEqual({ previous_response_id: "R" });
  });

  it("runTool returns ok:false for an unknown client tool", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    await useChat.getState().send("hi");
    expect(await lastDeps.runTool("nope", {})).toEqual({ ok: false, error: "unknown tool: nope" });
  });

  it("wires onToolError / onUsage / mode / stopped / session", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1", mode: "autopilot" });
    await useChat.getState().send("hi");
    expect(() => lastDeps.onToolError("gen", {}, new Error("x"))).not.toThrow();
    lastDeps.onUsage({ cost_usd: 0.5, input_tokens: 3 });
    expect(useChat.getState().session?.cost_usd).toBeCloseTo(0.5);
    expect(lastDeps.mode()).toBe("autopilot");
    expect(typeof lastDeps.stopped()).toBe("boolean");
    expect(lastDeps.session()).toMatchObject({ approval_mode: "autopilot" });
  });

  it("a project switch supersedes the running turn: it halts + refuses tools (no hidden edits)", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    loadSess.mockResolvedValue({
      requests: [],
      transcriptId: "t2",
      session: null,
      providerSnapshot: null,
    });
    await useChat.getState().send("a");
    const stale = lastDeps; // turn A's deps
    expect(stale.stopped()).toBe(false); // active
    await useChat.getState().load("p2"); // switch -> hard-aborts + retires turn A
    expect(stale.stopped()).toBe(true); // the old turn now halts
    expect(await stale.runTool("any_tool", {})).toEqual({ ok: false, error: "turn cancelled" });
  });

  it("deactivate() invalidates a pending load so it can't repopulate after leaving (R8-7)", async () => {
    let resolveSess!: (v: unknown) => void;
    loadSess.mockReturnValueOnce(new Promise((r) => (resolveSess = r)));
    const loading = useChat.getState().load("p1"); // suspends inside loadClientSession
    useChat.getState().deactivate(); // leave the project -> bump the load generation
    resolveSess({ requests: [], transcriptId: "t2", session: null, providerSnapshot: null });
    await loading;
    // The superseded load must NOT commit its session onto the now-empty route.
    expect(useChat.getState().projectId).toBeNull();
    expect(useChat.getState().transcriptId).toBeNull();
  });

  it("a new message supersedes the previous turn's exec", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    await useChat.getState().send("a");
    const first = lastDeps;
    await useChat.getState().send("b"); // supersede() retires A, fresh exec for B
    expect(first.stopped()).toBe(true); // A halted
    expect(lastDeps.stopped()).toBe(false); // B is live
    expect(await first.runTool("x", {})).toEqual({ ok: false, error: "turn cancelled" });
  });

  it("a switch DURING host warm-up supersedes the send: it starts nothing (R4/F2)", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    // Hold the host warm-up open so we can switch projects mid-`await host.ready`.
    let releaseReady!: () => void;
    const ready = new Promise<void>((r) => (releaseReady = r));
    vi.mocked(openToolHost).mockImplementationOnce(
      (id: string) =>
        ({
          projectId: id,
          ready,
          has: () => false,
          run: vi.fn(async () => ({})),
          store: () => null,
        }) as Any,
    );
    loadSess.mockResolvedValue({ requests: [], providerSnapshot: null, session: snap() });
    const sending = useChat.getState().send("p1 prompt"); // suspends at `await host.ready`
    await useChat.getState().load("p2"); // the switch supersedes the pending send's exec
    releaseReady(); // warm-up completes AFTER the switch
    await sending;
    // The superseded send must run NOTHING (no runner started) and leave us on p2.
    expect(runnerStart).not.toHaveBeenCalled();
    expect(useChat.getState().projectId).toBe("p2");
  });

  it("a second send during host warm-up is blocked -- no orphan turn (RF8)", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    let releaseReady!: () => void;
    const ready = new Promise<void>((r) => (releaseReady = r));
    vi.mocked(openToolHost).mockImplementationOnce(
      (id: string) =>
        ({
          projectId: id,
          ready,
          has: () => false,
          run: vi.fn(async () => ({})),
          store: () => null,
        }) as Any,
    );
    const sending = useChat.getState().send("first"); // suspends at `await host.ready`
    expect(useChat.getState().streaming).toBe(true); // BUSY synchronously -> guards the 2nd send
    await useChat.getState().send("second"); // rejected by the streaming guard -> no-op
    expect(useChat.getState().turns).toHaveLength(1); // only "first" was ever added
    releaseReady();
    await sending;
    expect(runnerStart).toHaveBeenCalledTimes(1);
    expect(runnerStart).toHaveBeenCalledWith("first");
  });

  it("a failed host warm-up errors the turn instead of hanging streaming (RF8)", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    vi.mocked(openToolHost).mockImplementationOnce(
      (id: string) =>
        ({
          projectId: id,
          ready: Promise.reject(new Error("host boom")),
          has: () => false,
          run: vi.fn(async () => ({})),
          store: () => null,
        }) as Any,
    );
    await useChat.getState().send("go");
    expect(useChat.getState().streaming).toBe(false); // not stuck on the spinner
    // The turn errors, but the raw host fault ("host boom") is NOT shown to the user — it
    // goes to Sentry; the human sees a clean, non-leaking sentence.
    const shown = useChat.getState().error ?? "";
    expect(shown).not.toContain("host boom");
    expect(shown).toBeTruthy();
    expect(useChat.getState().turns[0].status).toBe("error");
    expect(runnerStart).not.toHaveBeenCalled();
  });

  it("a superseded turn's usage does NOT accumulate onto the current session (F3)", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    await useChat.getState().send("a");
    const stale = lastDeps; // turn A's deps
    await useChat.getState().send("b"); // supersede A -> A is no longer current
    const before = useChat.getState().session?.cost_usd ?? 0;
    stale.onUsage({ cost_usd: 5, input_tokens: 10 }); // A's late usage arrives
    expect(useChat.getState().session?.cost_usd ?? 0).toBe(before); // ignored (superseded)
  });

  it("a superseded turn's late rejection does NOT clobber the current state (F3)", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    // Turn A's runner hangs, then rejects AFTER we've switched away.
    let rejectA!: (e: unknown) => void;
    runnerStart.mockImplementationOnce(() => new Promise<void>((_res, rej) => (rejectA = rej)));
    const sendingA = useChat.getState().send("a"); // A: clears host warm-up, then hangs in runTurn
    await Promise.resolve(); // let send get past `await host.ready`...
    await Promise.resolve(); // ...and into runTurn (which sets streaming + hangs on start())
    expect(useChat.getState().streaming).toBe(true); // A is in-flight
    loadSess.mockResolvedValue({ requests: [], providerSnapshot: null, session: snap() });
    await useChat.getState().load("p2"); // supersede A (retire its exec)
    // Simulate the current (p2) turn being live so a stray write would be visible.
    useChat.setState({ streaming: true, error: "p2-sentinel" });
    rejectA(new Error("late A failure")); // A's catch fires with a retired exec
    await sendingA;
    // A's completion was a no-op: p2's live state is untouched.
    expect(useChat.getState().streaming).toBe(true);
    expect(useChat.getState().error).toBe("p2-sentinel");
  });

  it("stop aborts the in-flight round and ends the turn", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    await useChat.getState().send("go");
    await useChat.getState().stop();
    expect(useChat.getState().streaming).toBe(false);
    expect(useChat.getState().providerSnapshot).toBeNull();
    expect(useChat.getState().turns[0].status).toBe("done");
  });

  // The turn's timeline edits are durable via a SEPARATE path, so a turn that ends
  // without persisting leaves 25 clips on disk with no record and nothing to undo.
  // Asserting the round trip (persisted payload -> reload) rather than "a save was
  // called", because a save of the wrong snapshot would still pass the latter.
  describe("a turn survives every terminal path (data integrity)", () => {
    const lastPersisted = () => {
      const calls = (persistSessionSoon as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      return calls[calls.length - 1][1] as {
        requests: Array<{
          message: { text: string };
          checkpoint?: { timeline?: unknown };
        }>;
      };
    };

    it("persists the turn and its pre-turn checkpoint at SEND, before any tool runs", async () => {
      setDesktop("p1");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const before = { fps: 30, tracks: [] } as any;
      useEditor.setState({ timeline: before });
      useChat.setState({ projectId: "p1" });
      await useChat.getState().send("add 25 clips");
      const saved = lastPersisted();
      expect(saved.requests).toHaveLength(1);
      expect(saved.requests[0].message.text).toBe("add 25 clips");
      // Without this the edits are unrevertable, which was the actual damage.
      expect(saved.requests[0].checkpoint?.timeline).toEqual(before);
    });

    it("keeps a STOPPED turn across the reload that clears in-memory state", async () => {
      setDesktop("p1");
      useChat.setState({ projectId: "p1" });
      await useChat.getState().send("add 25 clips");
      await useChat.getState().stop();
      const saved = lastPersisted();
      expect(saved.requests.map((r) => r.message.text)).toContain("add 25 clips");

      // load() wipes `turns` and refills from disk — the exact step that destroyed it.
      loadSess.mockResolvedValueOnce({
        requests: saved.requests,
        providerSnapshot: null,
        session: null,
      });
      await useChat.getState().load("p1");
      expect(useChat.getState().turns.map((t) => t.userText)).toContain("add 25 clips");
    });

    it("persists a turn that ends in an ERROR, not just a clean one", async () => {
      setDesktop("p1");
      useChat.setState({ projectId: "p1" });
      runnerStart.mockRejectedValueOnce(new Error("boom"));
      await useChat.getState().send("do a thing");
      expect(useChat.getState().turns[0].status).toBe("error");
      expect(lastPersisted().requests.map((r) => r.message.text)).toContain("do a thing");
    });

    // Reported in alpha: after a crash the chat showed the user's message and NOTHING else --
    // the transcript was written at send and again at turn end, so a turn that never ended lost
    // every reasoning block and tool call. Asserting the round trip through a reload, because a
    // write of the wrong snapshot would still satisfy "persist was called".
    it("keeps the work done SO FAR when the turn never ends", async () => {
      setDesktop("p1");
      useChat.setState({ projectId: "p1" });
      await useChat.getState().send("cut the intro");
      emit("reasoning", { text: "looking at the clips" });
      emit("tool_call", { name: "trim_clips", args: { clip_id: "c1" } });
      emit("tool_result", { name: "trim_clips", result: { ok: true } });
      // No turn_done, no stop, no error: the process dies here.
      const saved = lastPersisted() as Any;

      loadSess.mockResolvedValueOnce({
        requests: saved.requests,
        providerSnapshot: null,
        session: null,
      });
      await useChat.getState().load("p1");
      const recovered = useChat.getState().turns[0];
      expect(recovered.userText).toBe("cut the intro");
      expect(recovered.parts.map((p: Any) => p.kind)).toEqual([
        "reasoning",
        "tool_call",
        "tool_result",
      ]);
      expect(recovered.parts[1]).toMatchObject({ name: "trim_clips" });
    });

    it("persists the retired turn when the project is closed mid-flight", async () => {
      setDesktop("p1");
      useChat.setState({ projectId: "p1" });
      await useChat.getState().send("mid-flight work");
      useChat.getState().quiesce();
      expect(lastPersisted().requests.map((r) => r.message.text)).toContain("mid-flight work");
    });

    // redo() only calls replaceTimeline when timelineAfter is set; without it the
    // turn flips back to not-undone while the timeline stays reverted, so the UI
    // claims the edits are back and they are not.
    it("records a redo target for a STOPPED turn, not just a completed one", async () => {
      setDesktop("p1");
      useChat.setState({ projectId: "p1" });
      await useChat.getState().send("add 25 clips");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const after = { fps: 30, tracks: [{ id: "t", clips: [1] }] } as any;
      useEditor.setState({ timeline: after }); // the turn's tools edited the timeline
      await useChat.getState().stop();
      expect(useChat.getState().turns[0].timelineAfter).toEqual(after);
    });

    it("re-stamps the redo target when Continue -> Stop makes further edits", async () => {
      setDesktop("p1");
      useChat.setState({ projectId: "p1" });
      await useChat.getState().send("go");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useEditor.setState({ timeline: { v: 1 } as any });
      await useChat.getState().stop();
      useChat.setState({ canContinue: true });
      await useChat.getState().continueRun();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const later = { v: 2 } as any;
      useEditor.setState({ timeline: later });
      await useChat.getState().stop();
      expect(useChat.getState().turns[0].timelineAfter).toEqual(later);
    });

    // The opposite direction: a Stop with nothing in flight must not overwrite a
    // finished turn's redo target with whatever the user has edited since.
    it("does NOT re-stamp a finished turn when Stop is pressed with nothing running", async () => {
      setDesktop("p1");
      useChat.setState({ projectId: "p1" });
      await useChat.getState().send("go");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const atTurnEnd = { v: "turn-end" } as any;
      useEditor.setState({ timeline: atTurnEnd });
      emit("turn_done", {});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useEditor.setState({ timeline: { v: "user-edited-later" } as any });
      await useChat.getState().stop();
      expect(useChat.getState().turns[0].timelineAfter).toEqual(atTurnEnd);
    });
  });

  it("continueRun resumes the paused runner", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    await useChat.getState().send("go");
    useChat.setState({ canContinue: true });
    await useChat.getState().continueRun();
    expect(runnerContinue).toHaveBeenCalled();
    expect(useChat.getState().canContinue).toBe(false);
  });

  it("restoreTo marks the turn + successors undone and resets continuity", async () => {
    setDesktop("p1");
    useChat.setState({
      projectId: "p1",
      providerSnapshot: { previous_response_id: "r" },
      turns: [
        {
          id: "t1",
          userText: "a",
          attachments: [],
          parts: [],
          status: "done",
          undone: false,
          checkpoint: null,
          timelineAfter: null,
        },
        {
          id: "t2",
          userText: "b",
          attachments: [],
          parts: [],
          status: "done",
          undone: false,
          checkpoint: null,
          timelineAfter: null,
        },
      ] as Any,
    });
    await useChat.getState().restoreTo("t1");
    expect(useChat.getState().turns.map((t: Any) => t.undone)).toEqual([true, true]);
    expect(useChat.getState().providerSnapshot).toBeNull();
  });

  // Restoring a checkpoint takes the conversation back to before that prompt, so the prompt has
  // to come back to the user -- otherwise the only copy of what they asked for is in a turn the
  // view has just dropped.
  it("restoreTo hands back the prompt it rolled away", async () => {
    setDesktop("p1");
    const attachments = [{ path: "lib/a.mp4", kind: "video" }] as Any;
    useChat.setState({
      projectId: "p1",
      turns: [
        {
          id: "t1",
          userText: "make it shorter",
          attachments,
          parts: [],
          status: "done",
          undone: false,
          checkpoint: null,
          timelineAfter: null,
        },
      ] as Any,
    });
    expect(await useChat.getState().restoreTo("t1")).toEqual({
      text: "make it shorter",
      attachments,
    });
  });

  it("restoreTo hands back nothing when there is no such turn to restore", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1", turns: [] });
    expect(await useChat.getState().restoreTo("nope")).toBeNull();
  });

  it("sendFeedback uploads a bundle and returns whether it was stored", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1", transcriptId: "tx1" });
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    expect(await useChat.getState().sendFeedback("up")).toBe(true);
    expect(f).toHaveBeenCalled();
  });

  it("sendFeedback is a no-op without a project", async () => {
    useChat.setState({ projectId: null });
    expect(await useChat.getState().sendFeedback("down")).toBe(false);
  });
});

describe("streamed output", () => {
  const parts = () => useChat.getState().turns.at(-1)!.parts as Any[];

  async function startTurn() {
    setDesktop("p1");
    useChat.setState({ projectId: "p1", transcriptId: "tx1" });
    await useChat.getState().send("hi");
    (persistSessionSoon as Any).mockClear();
  }

  it("grows ONE part as tokens arrive instead of one part per token", async () => {
    await startTurn();

    emit("delta_text", { text: "he" });
    emit("delta_text", { text: "ll" });
    emit("delta_text", { text: "o" });

    const text = parts().filter((p) => p.kind === "text");
    expect(text).toHaveLength(1);
    expect(text[0].text).toBe("hello");
    expect(text[0].partial).toBe(true);
  });

  it("keeps reasoning and text in separate parts while both stream", async () => {
    await startTurn();

    emit("delta_reasoning", { text: "thinking" });
    emit("delta_text", { text: "answer" });

    expect(parts().map((p) => [p.kind, p.text])).toEqual([
      ["reasoning", "thinking"],
      ["text", "answer"],
    ]);
  });

  it("does NOT touch the disk while tokens stream", async () => {
    // The transcript writer runs per event. A write per token would be thousands of
    // writes a turn, and nothing is lost by waiting: the authoritative part persists.
    await startTurn();

    for (const t of ["a", "b", "c", "d", "e"]) emit("delta_text", { text: t });

    expect(persistSessionSoon).not.toHaveBeenCalled();

    emit("text", { text: "abcde" });
    expect(persistSessionSoon).toHaveBeenCalledTimes(1);
  });

  it("replaces the streamed preview with the authoritative part, never both", async () => {
    await startTurn();
    emit("delta_text", { text: "hel" });
    emit("delta_text", { text: "lo" });

    emit("text", { text: "hello" });

    const text = parts().filter((p) => p.kind === "text");
    expect(text).toHaveLength(1);
    expect(text[0]).toEqual({ kind: "text", text: "hello" });
    expect(text[0].partial).toBeUndefined();
  });

  it("retracts the stream when the round is reset upstream", async () => {
    // A retried / chain-reset attempt: the prose already shown is not the answer.
    await startTurn();
    emit("delta_text", { text: "first attempt" });

    emit("delta_reset", {});
    emit("delta_text", { text: "second" });

    const text = parts().filter((p) => p.kind === "text");
    expect(text).toHaveLength(1);
    expect(text[0].text).toBe("second");
  });

  it("drops prose streamed by a round that ends in a tool call", async () => {
    // A tool-call round can stream text that never becomes a `text` part. Left alone it
    // would sit in the transcript as an answer the model never gave.
    await startTurn();
    emit("delta_text", { text: "let me just" });

    emit("tool_call", { call_id: "c1", name: "add_clips", args: {} });

    expect(parts().some((p) => p.partial)).toBe(false);
    expect(parts().map((p) => p.kind)).toEqual(["tool_call"]);
  });

  it("leaves no half sentence behind when a turn ends mid-stream", async () => {
    await startTurn();
    emit("delta_text", { text: "half a sen" });

    emit("turn_done", snap());

    expect(parts().some((p) => p.partial)).toBe(false);
  });

  it("ignores deltas from a turn that has been superseded", async () => {
    await startTurn();
    const stale = lastDeps;
    await useChat.getState().send("second message");

    stale.emit("delta_text", { text: "ghost" });

    expect(parts().some((p) => String(p.text ?? "").includes("ghost"))).toBe(false);
  });
});
