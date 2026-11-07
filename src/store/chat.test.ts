import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  disposeChatStore,
  getChatStore,
  isChatExecutionCurrent,
  quiesceChatProject,
  resumeChatProject,
  saveProjectSessionNow,
  resetHistoryModeSupport,
  useChat,
} from "./chat";
import { useEditor } from "./editor";
import { peekFirstPrompt, setFirstPrompt } from "./firstPrompt";
import { resetLiveWait, useLiveWait } from "./liveWait";
import { __resetJobNotes, notifyJobSettled, pendingJobNotes, type SettledJob } from "./jobNotes";
import {
  loadClientSession,
  persistSession,
  persistSessionNow,
  persistSessionSoon,
} from "./transcriptFile";
import { inferRoundStreaming } from "../agent/api";
import { askForAttention } from "../lib/attention";
import { TIMELINE_CHANGED_NOTE } from "../agent/compose";
import { STATE_BLOCK_MARK } from "../agent/stateBlock";
import { ABORT_GRACE_MS, READ_BOUND_MS, timedOutResult } from "../agent/toolBound";
import {
  __bufferedAgentEvents,
  __resetAgentEvents,
  agentEventContext,
  createToolTrace,
  setAgentContext,
} from "../api/agentEvents";
import { useAuth } from "./auth";
import { clearRecentFailures, noteFailure } from "../observability/recentFailures";
import { setOpenDocumentResolver } from "../project/openDocuments";
import { emptyTimeline, type Timeline } from "../timeline/model";
import { openToolHost, type ToolRunOptions } from "../tools/host";
import { joinPath, type ProjectStoreAccess } from "../tools/store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// The client-owned loop replaces the SSE stream: `send`/`approve`/... build a
// ClientTurnRunner and drive it. We fake the runner so we can (a) assert the
// store delegates to it and (b) drive the store's `apply` reducer by calling the
// `emit` dep it was constructed with — the same event shapes the real runner emits.
const runnerStart = vi.fn(async (_t: string) => {});
// What each new runner was started with (the debt it carries), and what the live runner
// still owes (its unsent results).
const runnerCarried = vi.fn((_carried: unknown) => {});
const runnerUnsent: unknown[] = [];
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
    start = (t: string, carried?: unknown) => {
      runnerCarried(carried);
      return runnerStart(t);
    };
    takeUnsentResults = () => runnerUnsent.splice(0);
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
vi.mock("../lib/attention", () => ({ askForAttention: vi.fn(async () => undefined) }));
vi.mock("../agent/attachments", () => ({ collectInferenceAttachments: vi.fn() }));
// The history's own frames (read from the project by historyFrames.ts, tested there).
const { HISTORY_FRAMES } = vi.hoisted(() => ({
  HISTORY_FRAMES: [{ kind: "image", b64: "SElTVA==", ext: ".jpg", call_id: "c1", index: 0 }],
}));
vi.mock("../agent/historyFrames", () => ({
  historyAttachments: vi.fn(async () => HISTORY_FRAMES),
}));
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
  it("preserves a waiting start request through a refused close and discards it on disposal", () => {
    const projectId = "first-prompt-close";
    getChatStore(projectId).setState({ projectId });
    setFirstPrompt(projectId, "Create a creative Instagram reel");
    quiesceChatProject(projectId);
    expect(peekFirstPrompt(projectId)).toBe("Create a creative Instagram reel");
    resumeChatProject(projectId);
    expect(peekFirstPrompt(projectId)).toBe("Create a creative Instagram reel");
    disposeChatStore(projectId);
    expect(peekFirstPrompt(projectId)).toBeNull();
    expect(getChatStore(projectId).getState().turns).toEqual([]);
    disposeChatStore(projectId);
  });

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

describe("owned chat final-save durability", () => {
  it("retries the retained brief on Keep Editing after storage becomes writable", async () => {
    const actual = await vi.importActual<typeof import("./transcriptFile")>("./transcriptFile");
    const projectId = "failed-save-resume-retry";
    const projectDir = `C:/qa/${projectId}`;
    const transcriptPath = joinPath(projectDir, actual.SESSION_REL);
    const files = new Map<string, string>([
      [transcriptPath, JSON.stringify({ requests: [], provider_snapshot: null })],
    ]);
    const before = files.get(transcriptPath);
    let writable = false;
    const store = {
      projectDir,
      sessionLive: () => true,
      writeProjectText: async (target: string, body: string, guard?: () => boolean) => {
        if (guard && !guard()) return false;
        if (!writable) throw new Error("QA transcript write denied");
        files.set(target, body);
        return true;
      },
      readJson: async <Value>(target: string, fallback: Value): Promise<Value> =>
        files.has(target) ? (JSON.parse(files.get(target)!) as Value) : fallback,
    } as unknown as ProjectStoreAccess;
    const soon = vi.mocked(persistSessionSoon);
    const now = vi.mocked(persistSessionNow);
    soon.mockImplementation(actual.persistSessionSoon);
    now.mockImplementation(actual.persistSessionNow);
    try {
      useEditor.setState({ projectId, store });
      loadSess.mockResolvedValueOnce({ requests: [], providerSnapshot: null });
      const chat = getChatStore(projectId);
      await chat.getState().load(projectId);
      runnerStart.mockImplementationOnce(async () => {
        emit("error", { error: "The server could not complete this request." });
      });
      await chat.getState().send("KEEP THE BRIEF WITHOUT ANOTHER MESSAGE");
      quiesceChatProject(projectId);
      expect(await saveProjectSessionNow(projectId)).toBe(false);
      expect(files.get(transcriptPath)).toBe(before);
      resumeChatProject(projectId);
      await actual._persistIdle(projectDir);
      expect(files.get(transcriptPath)).toBe(before);
      expect(chat.getState().turns[0].userText).toBe("KEEP THE BRIEF WITHOUT ANOTHER MESSAGE");
      expect(runnerStart).toHaveBeenCalledTimes(1);
      quiesceChatProject(projectId);
      expect(await saveProjectSessionNow(projectId)).toBe(false);
      writable = true;
      resumeChatProject(projectId);
      await actual._persistIdle(projectDir);
      const restored = await actual.loadSession(store);
      expect(restored.requests).toHaveLength(1);
      expect(restored.requests[0].message?.text).toBe("KEEP THE BRIEF WITHOUT ANOTHER MESSAGE");
      expect(restored.requests[0].response).toEqual([
        { kind: "error", error: "The server could not complete this request." },
      ]);
      expect(runnerStart).toHaveBeenCalledTimes(1);
    } finally {
      await actual._persistIdle(projectDir);
      disposeChatStore(projectId);
      soon.mockReset();
      now.mockReset().mockResolvedValue(true);
    }
  });

  it.each(["detached", "another-project"] as const)(
    "does not acknowledge an unsaved brief when its editor is %s after Keep Editing",
    async (boundary) => {
      const actual = await vi.importActual<typeof import("./transcriptFile")>("./transcriptFile");
      const projectId = `failed-save-${boundary}`;
      const projectDir = `C:/qa/${projectId}`;
      const transcriptPath = joinPath(projectDir, actual.SESSION_REL);
      const otherProjectDir = `C:/qa/${projectId}-other`;
      const otherTranscriptPath = joinPath(otherProjectDir, actual.SESSION_REL);
      const files = new Map<string, string>([
        [transcriptPath, JSON.stringify({ requests: [], provider_snapshot: null })],
        [otherTranscriptPath, JSON.stringify({ requests: [], provider_snapshot: null })],
      ]);
      const before = files.get(transcriptPath);
      const otherBefore = files.get(otherTranscriptPath);
      let writable = false;
      const store = {
        projectDir,
        sessionLive: () => true,
        writeProjectText: async (target: string, body: string, guard?: () => boolean) => {
          if (guard && !guard()) return false;
          if (!writable) throw new Error("QA transcript write denied");
          files.set(target, body);
          return true;
        },
        readJson: async <Value>(target: string, fallback: Value): Promise<Value> =>
          files.has(target) ? (JSON.parse(files.get(target)!) as Value) : fallback,
      } as unknown as ProjectStoreAccess;
      const otherStore = { ...store, projectDir: otherProjectDir } as ProjectStoreAccess;
      const soon = vi.mocked(persistSessionSoon);
      const now = vi.mocked(persistSessionNow);
      soon.mockImplementation(actual.persistSessionSoon);
      now.mockImplementation(actual.persistSessionNow);
      try {
        useEditor.setState({ projectId, store });
        loadSess.mockResolvedValueOnce({ requests: [], providerSnapshot: null });
        const chat = getChatStore(projectId);
        await chat.getState().load(projectId);
        runnerStart.mockImplementationOnce(async () => {
          emit("error", { error: "The server could not complete this request." });
        });
        await chat.getState().send("KEEP THE FAILED SAVE BRIEF");
        quiesceChatProject(projectId);
        expect(await saveProjectSessionNow(projectId)).toBe(false);
        expect(files.get(transcriptPath)).toBe(before);
        resumeChatProject(projectId);
        await actual._persistIdle(projectDir);
        expect(files.get(transcriptPath)).toBe(before);
        writable = true;
        useEditor.setState({
          projectId: boundary === "detached" ? null : "different-project",
          store: boundary === "detached" ? null : otherStore,
        });
        quiesceChatProject(projectId);
        expect(await saveProjectSessionNow(projectId)).toBe(false);
        expect(files.get(transcriptPath)).toBe(before);
        expect(files.get(otherTranscriptPath)).toBe(otherBefore);
        expect(chat.getState().turns[0].userText).toBe("KEEP THE FAILED SAVE BRIEF");
        resumeChatProject(projectId);
        await actual._persistIdle(projectDir);
        expect(files.get(transcriptPath)).toBe(before);
        expect(files.get(otherTranscriptPath)).toBe(otherBefore);
        useEditor.setState({ projectId, store });
        quiesceChatProject(projectId);
        expect(await saveProjectSessionNow(projectId)).toBe(true);
        const restored = await actual.loadSession(store);
        expect(restored.requests).toHaveLength(1);
        expect(restored.requests[0].message?.text).toBe("KEEP THE FAILED SAVE BRIEF");
        expect(restored.requests[0].response).toEqual([
          { kind: "error", error: "The server could not complete this request." },
        ]);
        expect(files.get(otherTranscriptPath)).toBe(otherBefore);
      } finally {
        await actual._persistIdle(projectDir);
        disposeChatStore(projectId);
        soon.mockReset();
        now.mockReset().mockResolvedValue(true);
      }
    },
  );
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

  // Each answer runs as its own action, and only the LAST one resumes the batch. When answers
  // overlap, the earliest to finish cleared `streaming` while the resumed turn was still running:
  // the Stop button vanished mid-turn, and the composer and the job wake both saw an idle chat
  // (QA 2026-10-07, four denials at once). The flag belongs to the turn, not to one answer.
  it("stays streaming until the answer that resumed the batch has finished, however answers overlap", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    await useChat.getState().send("look at these");
    const call = (id: string) => ({
      call_id: id,
      name: "video_ask",
      arguments: {},
      rationale: "",
      reasoning_summary: [],
    });
    emit("awaiting_approval", { calls: [call("c1"), call("c2")] });
    let resumeDone!: () => void;
    runnerDeny.mockImplementationOnce(async () => {}); // c1: not the last answer, returns at once
    runnerDeny.mockImplementationOnce(() => new Promise<void>((r) => (resumeDone = r))); // c2 drives

    const first = useChat.getState().deny("no", "c1");
    const second = useChat.getState().deny("no", "c2");
    await first;
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(useChat.getState().streaming).toBe(true);

    resumeDone();
    await second;
    expect(useChat.getState().streaming).toBe(false);
  });

  // The opposite ordering: the resuming answer ends first while an earlier one is still running.
  it("stays streaming while any answer of the turn is still running, in either order", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    await useChat.getState().send("look at these");
    emit("awaiting_approval", {
      calls: ["c1", "c2"].map((id) => ({
        call_id: id,
        name: "video_ask",
        arguments: {},
        rationale: "",
        reasoning_summary: [],
      })),
    });
    let slowDone!: () => void;
    runnerApprove.mockImplementationOnce(() => new Promise<void>((r) => (slowDone = r)));
    runnerApprove.mockImplementationOnce(async () => {});

    const slow = useChat.getState().approve("c1");
    const quick = useChat.getState().approve("c2");
    await quick;
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(useChat.getState().streaming).toBe(true);

    slowDone();
    await slow;
    expect(useChat.getState().streaming).toBe(false);
  });

  it("Stop still ends the turn at once while answers are in flight", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    await useChat.getState().send("look");
    emit("awaiting_approval", {
      calls: [
        { call_id: "c1", name: "video_ask", arguments: {}, rationale: "", reasoning_summary: [] },
      ],
    });
    let driveDone!: () => void;
    runnerApprove.mockImplementationOnce(() => new Promise<void>((r) => (driveDone = r)));
    const answered = useChat.getState().approve("c1");
    await Promise.resolve();
    expect(useChat.getState().streaming).toBe(true);

    await useChat.getState().stop();
    expect(useChat.getState().streaming).toBe(false);
    driveDone();
    await answered;
    expect(useChat.getState().streaming).toBe(false);
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

  it("quiesce NORMALIZES the aborted turn (marked cut short + provider reset) (finding #4)", () => {
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
    // Leaving the project cut the reply short; it must not read as a finished turn with no answer.
    expect(useChat.getState().turns[0].status).toBe("interrupted"); // and no spinner
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

describe("useChat sends client-owned history (Phase 1, option A)", () => {
  beforeEach(() => resetHistoryModeSupport());

  const ECHO = {
    kind: "text",
    final_text: "ok",
    usage: {},
    provider_snapshot: {},
    history_mode: "client",
  };
  const legacyFrames = [{ kind: "image", b64: "AA==" }];

  it("asks for history mode with the whole transcript, each message as the MODEL saw it", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1", model: "gpt-5.4" });
    await useChat
      .getState()
      .send("trim the intro", [
        { path: "library/media_1.mp4", kind: "video", caption: "intro.mp4" } as Any,
      ]);
    (inferRoundStreaming as Any).mockResolvedValue(ECHO);
    await lastDeps.infer({ user_text: "x" }, legacyFrames);
    const body = (inferRoundStreaming as Any).mock.calls.at(-1)[0];
    expect(body.history_mode).toBe("client");
    const req = body.transcript.requests.at(-1);
    // The composed text (with the attachment note) is what the model got on the first round.
    expect(req.message.text).toContain("trim the intro");
    expect(req.message.text).toContain("Attached file(s)");
    expect(req.checkpoint).toBeUndefined(); // the model never reads timeline checkpoints
    // Not known yet whether the server rebuilds history: this round's frames, as a chained
    // server needs them; the history's frames ride their own field, which such a server ignores.
    // So the first round after a restart already shows the frames the history saw.
    expect(body.attachments).toEqual(legacyFrames);
    expect(body.history_frames).toEqual(HISTORY_FRAMES);
  });

  it("once the server has rebuilt the history, keeps no chain and re-sends history frames instead", async () => {
    setDesktop("p1");
    useChat.setState({
      projectId: "p1",
      model: "gpt-5.4",
      providerSnapshot: { previous_response_id: "OLD" },
    });
    await useChat.getState().send("hi");
    // Even a stray chain id beside the echo must not be kept: the history is the transcript.
    (inferRoundStreaming as Any).mockResolvedValue({
      ...ECHO,
      provider_snapshot: { previous_response_id: "STRAY" },
    });
    await lastDeps.infer({ user_text: "hi" }, legacyFrames);
    expect(useChat.getState().providerSnapshot).toEqual({});
    await lastDeps.infer({ tool_results: [] }, legacyFrames);
    const body = (inferRoundStreaming as Any).mock.calls.at(-1)[0];
    expect(body.history_mode).toBe("client");
    // Every frame once: in the history's field, none repeated as this round's.
    expect(body.attachments).toEqual([]);
    expect(body.history_frames).toEqual(HISTORY_FRAMES);
  });

  it("a server or model without the mode keeps its chain, and the next round is a plain chained one", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1", model: "gemini-3.1-pro-preview" });
    await useChat.getState().send("hi");
    (inferRoundStreaming as Any).mockResolvedValue({
      kind: "text",
      final_text: "ok",
      usage: {},
      provider_snapshot: { previous_response_id: "R" },
    });
    await lastDeps.infer({ user_text: "hi" }, legacyFrames);
    expect(useChat.getState().providerSnapshot).toEqual({ previous_response_id: "R" });
    await lastDeps.infer({ tool_results: [] }, legacyFrames);
    const body = (inferRoundStreaming as Any).mock.calls.at(-1)[0];
    expect(body.history_mode).toBeUndefined();
    expect(body.provider_snapshot).toEqual({ previous_response_id: "R" });
    expect(body.attachments).toEqual(legacyFrames);
    expect(body.history_frames).toBeUndefined();
  });

  it("an error round does not demote the model to the chain", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1", model: "gpt-5.4" });
    await useChat.getState().send("hi");
    (inferRoundStreaming as Any).mockResolvedValueOnce({
      kind: "error",
      error: "boom",
      usage: {},
      provider_snapshot: {},
    });
    await lastDeps.infer({ user_text: "hi" }, []);
    (inferRoundStreaming as Any).mockResolvedValueOnce(ECHO);
    await lastDeps.infer({ user_text: "hi" }, []);
    expect((inferRoundStreaming as Any).mock.calls.at(-1)[0].history_mode).toBe("client");
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

  it("a new message hands the previous turn's unsent results to the next turn (UJ-008)", async () => {
    // `send()` retired the old runner BEFORE asking it for its debt, so the debt was always
    // empty and the chained provider refused the next request.
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    await useChat.getState().send("first");
    runnerUnsent.push({ call_id: "c7", name: "set_transition", result: { ok: true } });
    useChat.setState({ streaming: false });
    await useChat.getState().send("second");
    expect(runnerCarried.mock.calls.at(-1)?.[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ call_id: "c7" })]),
    );
  });

  it("runTool returns ok:false for an unknown client tool", async () => {
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    await useChat.getState().send("hi");
    expect(await lastDeps.runTool("nope", {})).toEqual({ ok: false, error: "unknown tool: nope" });
  });

  it("keeps tool events attached to their original chat when another driver changes the global context", async () => {
    const previous = agentEventContext();
    const transcriptId = useChat.getState().transcriptId;
    try {
      setDesktop("p1");
      useChat.setState({ projectId: "p1", transcriptId: "chat-a", model: "gpt-5.6-luna" });
      await useChat.getState().send("work in this project");
      const original = lastDeps.eventContext();
      expect(original).toMatchObject({
        surface: "app",
        project_id: "p1",
        transcript_id: "chat-a",
        model: "gpt-5.6-luna",
      });
      setAgentContext({
        surface: "mcp",
        project_id: "p2",
        transcript_id: "chat-b",
        model: "other",
      });
      expect(lastDeps.eventContext()).toEqual(original);
    } finally {
      setAgentContext({
        surface: previous.surface,
        project_id: previous.project_id,
        transcript_id: previous.transcript_id,
        model: previous.model,
      });
      useChat.setState({ transcriptId });
    }
  });

  it("Stop reaches a running tool through the current host API and preserves its trace", async () => {
    const run = vi.fn(
      async (_name: string, _args: Record<string, unknown>, options: ToolRunOptions) =>
        new Promise<unknown>((resolve) => {
          if (!options.signal) return resolve({ ok: false, error: "missing Stop signal" });
          options.signal.addEventListener("abort", () => resolve({ ok: false, error: "stopped" }), {
            once: true,
          });
        }),
    );
    vi.mocked(openToolHost).mockImplementationOnce(
      (id: string) =>
        ({
          projectId: id,
          ready: Promise.resolve(),
          has: (n: string) => n === "get_timeline",
          run,
          store: () => null,
        }) as Any,
    );
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    await useChat.getState().send("inspect the timeline");
    const trace = createToolTrace("get_timeline", {}, lastDeps.eventContext(), "tool-1");
    const pending = lastDeps.runTool("get_timeline", {}, trace);
    expect(run.mock.calls[0][2].trace).toBe(trace);
    expect(run.mock.calls[0][2].origin?.executionId).toBe(useChat.getState().execToken);
    await useChat.getState().stop();
    expect(await pending).toEqual({ ok: false, error: "stopped" });
  });

  it("a tool that only looks is stopped at its bound, and the model is told in words it can use", async () => {
    let told: AbortSignal | undefined;
    const run = vi.fn(
      async (_name: string, _args: Record<string, unknown>, options: ToolRunOptions) =>
        new Promise<unknown>(() => {
          told = options.signal; // ignores the stop: the worst case
        }),
    );
    vi.mocked(openToolHost).mockImplementationOnce(
      (id: string) =>
        ({
          projectId: id,
          ready: Promise.resolve(),
          has: (n: string) => n === "video_find_moment",
          run,
          store: () => null,
        }) as Any,
    );
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    await useChat.getState().send("find the moment");
    vi.useFakeTimers();
    try {
      let answer: unknown = "pending";
      void lastDeps.runTool("video_find_moment", {}).then((a: unknown) => (answer = a));
      await vi.advanceTimersByTimeAsync(READ_BOUND_MS - 1);
      expect(told?.aborted).toBe(false);
      expect(answer).toBe("pending");
      await vi.advanceTimersByTimeAsync(1 + ABORT_GRACE_MS);
      expect(told?.aborted).toBe(true);
      expect(answer).toEqual(timedOutResult("video_find_moment", READ_BOUND_MS));
    } finally {
      vi.useRealTimers();
    }
  });

  it("a tool that makes something is never cut off, however long it takes", async () => {
    let told: AbortSignal | undefined;
    const run = vi.fn(
      async (_name: string, _args: Record<string, unknown>, options: ToolRunOptions) =>
        new Promise<unknown>((resolve) => {
          told = options.signal;
          setTimeout(() => resolve({ ok: true, imported: 1 }), 45 * 60_000);
        }),
    );
    vi.mocked(openToolHost).mockImplementationOnce(
      (id: string) =>
        ({
          projectId: id,
          ready: Promise.resolve(),
          has: (n: string) => n === "import_media",
          run,
          store: () => null,
        }) as Any,
    );
    setDesktop("p1");
    useChat.setState({ projectId: "p1" });
    await useChat.getState().send("import it");
    vi.useFakeTimers();
    try {
      let answer: unknown = "pending";
      void lastDeps.runTool("import_media", {}).then((a: unknown) => (answer = a));
      await vi.advanceTimersByTimeAsync(44 * 60_000);
      expect(answer).toBe("pending");
      expect(told?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(answer).toEqual({ ok: true, imported: 1 });
    } finally {
      vi.useRealTimers();
    }
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
          response?: Array<{ kind: string; error?: string; code?: string }>;
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

    it.each([
      { label: "unexpected failure", failure: new Error("private transport diagnostic") },
      { label: "network failure", failure: new TypeError("Failed to fetch") },
    ])(
      "keeps the safe $label reply and failed status after reload without retrying",
      async ({ failure }) => {
        setDesktop("p1");
        useChat.setState({ projectId: "p1" });
        runnerStart.mockRejectedValueOnce(failure);
        await useChat.getState().send("do a thing");
        expect(useChat.getState().turns[0].status).toBe("error");
        const message = useChat.getState().error;
        expect(message).toBeTruthy();
        expect(message).not.toContain(failure.message);
        const saved = lastPersisted();
        expect(saved.requests[0].response?.filter((part) => part.kind === "error")).toEqual([
          { kind: "error", error: message },
        ]);
        loadSess.mockResolvedValueOnce({
          requests: saved.requests,
          providerSnapshot: null,
          session: null,
        });
        await useChat.getState().load("p1");
        const restored = useChat.getState().turns[0];
        expect(restored.userText).toBe("do a thing");
        expect(restored.status).toBe("error");
        expect(restored.parts.filter((part) => part.kind === "error")).toEqual([
          { kind: "error", error: message },
        ]);
        expect(runnerStart).toHaveBeenCalledTimes(1);
      },
    );

    it.each(["transport", "terminal event", "host startup"] as const)(
      "keeps a %s failure through the real session writer and loader",
      async (failurePath) => {
        const actual = await vi.importActual<typeof import("./transcriptFile")>("./transcriptFile");
        const files: Record<string, string> = {};
        const store = {
          projectDir: "C:/proj/failed-chat-roundtrip",
          sessionLive: () => true,
          writeProjectText: async (path: string, content: string, guard?: () => boolean) => {
            if (guard && !guard()) return false;
            files[path] = content;
            return true;
          },
          readJson: async <Value>(path: string, fallback: Value): Promise<Value> =>
            path in files ? (JSON.parse(files[path]) as Value) : fallback,
        } as unknown as ProjectStoreAccess;
        const soon = vi.mocked(persistSessionSoon);
        soon.mockImplementation(actual.persistSessionSoon);
        try {
          setDesktop("p1");
          useEditor.setState({ store });
          useChat.setState({ projectId: "p1" });
          if (failurePath === "transport") {
            runnerStart.mockRejectedValueOnce(new TypeError("Failed to fetch"));
          } else if (failurePath === "terminal event") {
            runnerStart.mockImplementationOnce(async () => {
              emit("reasoning", { text: "Checking the source footage." });
              emit("error", { error: "The server could not complete this request." });
            });
          } else {
            vi.mocked(openToolHost).mockImplementationOnce(
              () =>
                ({
                  projectId: "p1",
                  ready: Promise.reject(new Error("private host startup diagnostic")),
                  has: () => false,
                  run: vi.fn(),
                  store: () => null,
                }) as Any,
            );
          }
          await useChat.getState().send("keep my original edit brief");
          const message = useChat.getState().error;
          expect(message).toBeTruthy();
          await actual._persistIdle(store.projectDir);
          const saved = JSON.parse(files[joinPath(store.projectDir, actual.SESSION_REL)]);
          expect(
            saved.requests[0].response.filter((part: { kind: string }) => part.kind === "error"),
          ).toEqual([{ kind: "error", error: message }]);
          loadSess.mockResolvedValueOnce(await actual.loadSession(store));
          await useChat.getState().load("p1");
          const restored = useChat.getState().turns[0];
          expect(restored).toMatchObject({
            userText: "keep my original edit brief",
            status: "error",
          });
          expect(restored.parts).toEqual(saved.requests[0].response);
          if (failurePath === "terminal event") {
            expect(restored.parts[0]).toEqual({
              kind: "reasoning",
              text: "Checking the source footage.",
            });
          }
          expect(runnerStart).toHaveBeenCalledTimes(failurePath === "host startup" ? 0 : 1);
        } finally {
          await actual._persistIdle(store.projectDir);
          soon.mockReset();
        }
      },
    );

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

  // UJ-072: a report used to be a note and a transcript. It now says which build, machine class and model it came
  // from, the credit state, and the last failures' codes and request ids, so the failure can be found.
  it.each(["report", "up", "down"] as const)(
    "a %s carries the app's technical context and the failures it just met",
    async (kind) => {
      clearRecentFailures();
      noteFailure({
        where: "turn",
        code: "content_policy",
        requestId: "failed-call-1",
        at: 1793000000,
      });
      setDesktop("p1");
      useChat.setState({ projectId: "p1", transcriptId: "tx1", model: "gpt-5.6-luna" });
      const f = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
      vi.stubGlobal("fetch", f);

      await useChat.getState().sendFeedback(kind, { note: "it broke" });

      const body = JSON.parse(((f.mock.calls[0] as unknown[])[1] as RequestInit).body as string);
      expect(body).toMatchObject({
        kind,
        note: "it broke",
        transcript_id: "tx1",
        project_id: "p1",
      });
      expect(body.context).toMatchObject({
        app_version: __ARTDADDY_RELEASE__,
        model: "gpt-5.6-luna",
        surface: "app",
        failures: [
          { where: "turn", code: "content_policy", request_id: "failed-call-1", at: 1793000000 },
        ],
      });
      expect(body.context.credit).toEqual(
        expect.objectContaining({ metered: expect.any(Boolean) }),
      );
      clearRecentFailures();
    },
  );

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

// UJ-028: the agent read the timeline once, the user placed four clips by hand, and the agent
// answered "90 seconds" from memory. The open document counts edits the agent did not make; the
// chat turns that count (or, on a new session, the timeline itself) into a line the model gets.
describe("useChat tells the model when the timeline changed outside the chat (UJ-028)", () => {
  let outside = 0;
  let live: Timeline;
  const trackWithClips = (n: number): Timeline => {
    const t = emptyTimeline();
    t.tracks.push({
      id: "v1",
      kind: "video",
      z: 0,
      clips: Array.from({ length: n }, (_, i) => ({
        id: `c${i}`,
        media_ref: "media_a",
        timeline_in: i * 2700,
        timeline_out: (i + 1) * 2700,
      })),
    });
    return t;
  };
  const lastStart = () => String(runnerStart.mock.calls.at(-1)?.[0] ?? "");
  const finish = () => emit("turn_done", snap());
  const NOTE = { timeline_note: TIMELINE_CHANGED_NOTE };

  beforeEach(() => {
    outside = 0;
    live = trackWithClips(1);
    setOpenDocumentResolver((id) =>
      id === "p1"
        ? ({
            sessionId: "s1",
            externalTimelineEdits: () => outside,
            timeline: { current: () => live },
          } as Any)
        : undefined,
    );
    useEditor.setState({
      projectId: "p1",
      store: { projectDir: "C:/p1", writeProjectText: vi.fn() } as Any,
      timeline: live,
    });
    useChat.setState({ projectId: "p1", turns: [] });
  });
  afterEach(() => setOpenDocumentResolver(() => undefined));

  it("tells the next message once after an edit in the editor, and keeps it on the saved turn", async () => {
    await useChat.getState().send("how long is my timeline?");
    expect(lastStart()).not.toContain(TIMELINE_CHANGED_NOTE);
    finish();
    outside++; // four more copies placed by hand
    await useChat.getState().send("how long is my timeline now?");
    expect(lastStart()).toContain(TIMELINE_CHANGED_NOTE);
    expect(useChat.getState().turns.at(-1)?.timelineChanged).toBe(true);
    const saved = (persistSessionSoon as Any).mock.calls.at(-1)[1].requests.at(-1);
    expect(saved.message.timeline_changed).toBe(true);
    finish();
    await useChat.getState().send("and how many clips?");
    expect(lastStart()).not.toContain(TIMELINE_CHANGED_NOTE);
  });

  it("tells the next tool round about an edit made while the turn ran, once", async () => {
    await useChat.getState().send("build it");
    expect(lastDeps.noteForRound()).toBeNull();
    outside++;
    expect(lastDeps.noteForRound()).toEqual(NOTE);
    expect(lastDeps.noteForRound()).toBeNull();
  });

  it("a whole-timeline read after the edit covers it; a windowed read does not", async () => {
    (openToolHost as Any).mockImplementationOnce((id: string) => ({
      projectId: id,
      ready: Promise.resolve(),
      has: () => true,
      run: vi.fn(async () => ({ ok: true })),
      store: () => null,
    }));
    await useChat.getState().send("build it");
    outside++;
    await lastDeps.runTool("get_timeline", { start_frame: 0, end_frame: 30 });
    expect(lastDeps.noteForRound()).toEqual(NOTE);
    outside++;
    await lastDeps.runTool("get_timeline", { start_frame: null, end_frame: null });
    expect(lastDeps.noteForRound()).toBeNull();
  });

  it("on a new session compares the timeline with the one the last turn ended on", async () => {
    const saved = (after: Timeline) => ({
      requests: [
        {
          id: "old",
          message: { text: "hi" },
          response: [{ kind: "text", text: "Your timeline is 90 seconds long." }],
          checkpoint: { timeline_after: JSON.parse(JSON.stringify(after)) },
        },
      ],
      providerSnapshot: null,
    });
    loadSess.mockResolvedValueOnce(saved(live));
    await useChat.getState().load("p1");
    await useChat.getState().send("same as before?");
    expect(lastStart()).not.toContain(TIMELINE_CHANGED_NOTE);
    finish();

    loadSess.mockResolvedValueOnce(saved(live));
    await useChat.getState().load("p1");
    live = trackWithClips(5); // edited while the app was closed, or before the first message
    await useChat.getState().send("how long is it?");
    expect(lastStart()).toContain(TIMELINE_CHANGED_NOTE);
  });

  it("a chat undo is not news: the next message compares with the turn it went back to", async () => {
    await useChat.getState().send("first"); // ends on `live`
    finish();
    useEditor.setState({ timeline: null }); // no checkpoint, so the undo below restores nothing
    await useChat.getState().send("second");
    finish();
    useEditor.setState({ timeline: live });
    outside++; // the restore a chat undo commits is counted like any edit the agent did not make
    await useChat.getState().undo();
    expect(useChat.getState().turns.at(-1)?.undone).toBe(true);
    await useChat.getState().send("third");
    expect(lastStart()).not.toContain(TIMELINE_CHANGED_NOTE);
  });
});

// The model's first round used to be a read of the project (21 of 22 first turns in the field, a median 9-14 s).
// The app reads it now and sends it with the message. What the model is shown must be what the project holds,
// given once per look, and shown again byte for byte on every later round of the turn and after a reload.
describe("useChat hands the model the project state with its message (S1f)", () => {
  let outside = 0;
  let live: Timeline;
  let reads: string[];
  let readOptions: ToolRunOptions[];
  let readOutcome: (name: string) => unknown;
  const trackWithClips = (n: number): Timeline => {
    const t = emptyTimeline();
    t.tracks.push({
      id: "v1",
      kind: "video",
      z: 0,
      clips: Array.from({ length: n }, (_, i) => ({
        id: `c${i}`,
        media_ref: "media_a",
        timeline_in: i * 90,
        timeline_out: (i + 1) * 90,
      })),
    });
    return t;
  };
  const answers = (name: string): unknown =>
    name === "get_timeline"
      ? { ok: true, timeline: JSON.parse(JSON.stringify(live)) }
      : {
          ok: true,
          project_id: "p1",
          name: "Reel",
          library: [{ media_ref: "media_a", filename: "a.mp4", kind: "video", folder: null }],
          library_count: 1,
        };
  const lastStart = () => String(runnerStart.mock.calls.at(-1)?.[0] ?? "");
  const finish = () => emit("turn_done", snap());
  const ECHO = {
    kind: "text",
    final_text: "ok",
    usage: {},
    provider_snapshot: {},
    history_mode: "client",
  };
  const savedRequest = () => (persistSessionSoon as Any).mock.calls.at(-1)[1].requests.at(-1);

  beforeEach(() => {
    resetHistoryModeSupport();
    outside = 0;
    live = trackWithClips(2);
    reads = [];
    readOptions = [];
    readOutcome = answers;
    (openToolHost as Any).mockImplementation((id: string) => ({
      projectId: id,
      ready: Promise.resolve(),
      has: (n: string) => n === "get_timeline" || n === "get_project_state",
      run: vi.fn(async (name: string, _args: unknown, options: ToolRunOptions) => {
        reads.push(name);
        readOptions.push(options);
        return readOutcome(name);
      }),
      store: () => null,
    }));
    setOpenDocumentResolver((id) =>
      id === "p1"
        ? ({
            sessionId: "s1",
            externalTimelineEdits: () => outside,
            timeline: { current: () => live },
          } as Any)
        : undefined,
    );
    useEditor.setState({
      projectId: "p1",
      store: { projectDir: "C:/p1", writeProjectText: vi.fn() } as Any,
      timeline: live,
    });
    useChat.setState({ projectId: "p1", turns: [], model: "gpt-5.4" });
  });
  afterEach(() => {
    setOpenDocumentResolver(() => undefined);
    (openToolHost as Any).mockImplementation((id: string) => ({
      projectId: id,
      ready: Promise.resolve(),
      has: () => false,
      run: vi.fn(async () => ({})),
      store: () => null,
    }));
  });

  it("reads the project before the first round, silently, and sends what it found with the message", async () => {
    await useChat.getState().send("make it punchy");
    expect(reads).toEqual(["get_project_state", "get_timeline"]);
    expect(readOptions.every((o) => o.surface === "app" && o.trace !== undefined)).toBe(true);
    const host = (openToolHost as Any).mock.results.at(-1).value;
    expect(Math.max(...host.run.mock.invocationCallOrder)).toBeLessThan(
      runnerStart.mock.invocationCallOrder[0],
    );
    const text = lastStart();
    expect(text.startsWith("make it punchy")).toBe(true);
    expect(text).toContain(STATE_BLOCK_MARK);
    expect(text).toContain('"id":"c1"'); // a clip the model would otherwise have had to ask for
    const turn = useChat.getState().turns.at(-1)!;
    expect(turn.stateBlock).toBeTruthy();
    expect(text.endsWith(turn.stateBlock!)).toBe(true);
    expect(savedRequest().message.state_block).toBe(turn.stateBlock);
  });

  it("shows the model the same words on every later round, even after the project moved on", async () => {
    await useChat.getState().send("make it punchy");
    const first = lastStart();
    (inferRoundStreaming as Any).mockResolvedValue(ECHO);
    live = trackWithClips(5);
    outside++; // the project changes while the turn runs
    await lastDeps.infer({ tool_results: [] }, []);
    const body = (inferRoundStreaming as Any).mock.calls.at(-1)[0];
    expect(body.history_mode).toBe("client");
    expect(body.transcript.requests.at(-1).message.text).toBe(first);
  });

  it("does not read again for the next message when nothing changed outside the chat", async () => {
    await useChat.getState().send("first");
    finish();
    reads.length = 0;
    await useChat.getState().send("second");
    expect(reads).toEqual([]);
    expect(lastStart()).toBe("second");
    expect(useChat.getState().turns.at(-1)?.stateBlock).toBeUndefined();
  });

  it("reads again after something else changed the timeline, and that read replaces the changed-note", async () => {
    await useChat.getState().send("first");
    finish();
    reads.length = 0;
    live = trackWithClips(4); // two clips placed by hand
    outside++;
    await useChat.getState().send("how long is it now?");
    expect(reads).toEqual(["get_project_state", "get_timeline"]);
    expect(lastStart()).toContain('"id":"c3"');
    expect(lastStart()).not.toContain(TIMELINE_CHANGED_NOTE);
    const turn = useChat.getState().turns.at(-1)!;
    expect(turn.timelineChanged).toBe(true);
    expect(savedRequest().message.timeline_changed).toBe(true);
    expect(savedRequest().message.state_block).toBe(turn.stateBlock);
  });

  it("reads again for a conversation whose only turn was undone: the model no longer remembers it", async () => {
    useChat.setState({
      turns: [
        {
          id: "old",
          userText: "hi",
          attachments: [],
          parts: [],
          status: "done",
          undone: true,
        } as Any,
      ],
    });
    await useChat.getState().send("again");
    expect(reads).toEqual(["get_project_state", "get_timeline"]);
    expect(lastStart()).toContain(STATE_BLOCK_MARK);
  });

  it("does not read for the app's own turns (a finished job waking the chat)", async () => {
    await useChat
      .getState()
      .send("Background work you started earlier has finished:\n- Voiceover is ready", [], {
        system: true,
      });
    expect(reads).toEqual([]);
    expect(useChat.getState().turns.at(-1)?.stateBlock).toBeUndefined();
  });

  it("goes on without a block when a read fails, and a failed read does not lose the changed-note", async () => {
    readOutcome = (name) =>
      name === "get_timeline" ? { ok: false, error: "timeline.json not found" } : answers(name);
    await useChat.getState().send("make it punchy");
    expect(lastStart()).toBe("make it punchy");
    expect(useChat.getState().turns.at(-1)?.stateBlock).toBeUndefined();
    expect(runnerStart).toHaveBeenCalledTimes(1);
    finish();
    outside++;
    await useChat.getState().send("again");
    expect(lastStart()).toContain(TIMELINE_CHANGED_NOTE);
    expect(lastStart()).not.toContain(STATE_BLOCK_MARK);
  });

  it("keeps telling the model about an edit made after the read, once", async () => {
    await useChat.getState().send("build it");
    expect(lastDeps.noteForRound()).toBeNull(); // the read already showed everything so far
    outside++;
    expect(lastDeps.noteForRound()).toEqual({ timeline_note: TIMELINE_CHANGED_NOTE });
    expect(lastDeps.noteForRound()).toBeNull();
  });

  it("still reports an edit that landed while the project was being read: the block may not show it", async () => {
    readOutcome = (name) => {
      if (name === "get_timeline") outside++;
      return answers(name);
    };
    await useChat.getState().send("build it");
    expect(lastDeps.noteForRound()).toEqual({ timeline_note: TIMELINE_CHANGED_NOTE });
  });

  it("does not report as news an edit made before the read began: the block already shows it", async () => {
    let looks = 0;
    // The turn's start sees no outside edit; the very next look at the document (the read's start) sees one.
    setOpenDocumentResolver((id) =>
      id === "p1"
        ? ({
            sessionId: "s1",
            externalTimelineEdits: () => (++looks >= 2 ? 1 : 0),
            timeline: { current: () => live },
          } as Any)
        : undefined,
    );
    await useChat.getState().send("build it");
    expect(lastStart()).toContain(STATE_BLOCK_MARK);
    expect(lastDeps.noteForRound()).toBeNull();
  });
});

// What the person is shown a running turn is waiting on comes from three places in this store: the
// events a turn emits (a tool call, a question), the model round it makes, and every way a turn ends.
describe("useChat tells the status line what the turn is waiting on", () => {
  const live = () => useLiveWait.getState();
  const nothing = () => ({
    round: live().round,
    calls: live().calls,
    approval: live().approvalSince,
  });
  const NOTHING = { round: null, calls: [], approval: null };
  const ANSWER = {
    kind: "text",
    final_text: "ok",
    usage: {},
    provider_snapshot: {},
    history_mode: "client",
  };

  beforeEach(() => {
    resetLiveWait();
    resetHistoryModeSupport();
  });
  afterEach(() => resetLiveWait());

  async function startTurn(): Promise<void> {
    setDesktop("p1");
    useChat.setState({ projectId: "p1", transcriptId: "tx1" });
    await useChat.getState().send("hi");
  }

  it("has a tool call running from its call to its result, and only that one", async () => {
    await startTurn();
    emit("tool_call", { call_id: "c1", name: "video_ask", args: {} });
    emit("tool_call", { call_id: "c2", name: "inspect_media", args: {} });
    expect(live().calls.map((c) => c.name)).toEqual(["video_ask", "inspect_media"]);
    emit("tool_result", { call_id: "c1", name: "video_ask", ok: true });
    expect(live().calls.map((c) => c.name)).toEqual(["inspect_media"]);
  });

  it("is waiting on the person when the turn stops to ask, with nothing running", async () => {
    await startTurn();
    emit("awaiting_approval", { calls: [{ call_id: "c1", name: "add_clips", arguments: {} }] });
    emit("turn_paused", snap());
    expect(live().approvalSince).not.toBeNull();
    expect(live().calls).toEqual([]);
    expect(live().round).toBeNull();
  });

  it("follows a model round: building the request, waiting for the first word, writing, then nothing", async () => {
    await startTurn();
    const seen: Array<string | undefined> = [];
    (inferRoundStreaming as Any).mockImplementationOnce(
      async (_body: Any, onDelta: (d: Any) => void) => {
        seen.push(live().round?.phase);
        onDelta({ kind: "text", text: "hel" });
        seen.push(live().round?.phase);
        return ANSWER;
      },
    );
    const done = lastDeps.infer({ user_text: "hi" }, []);
    expect(live().round?.phase).toBe("preparing");
    await done;
    expect(seen).toEqual(["waiting", "writing"]);
    expect(live().round).toBeNull();
  });

  it("is not waiting on a round that failed", async () => {
    await startTurn();
    (inferRoundStreaming as Any).mockRejectedValueOnce(new Error("boom"));
    await expect(lastDeps.infer({ user_text: "hi" }, [])).rejects.toThrow("boom");
    expect(live().round).toBeNull();
  });

  it("says what the round's request is waiting on while it is, and stops saying so", async () => {
    await startTurn();
    const seen: Array<string | undefined> = [];
    (inferRoundStreaming as Any).mockImplementationOnce(
      async (
        _body: Any,
        _onDelta: unknown,
        _signal: unknown,
        observer: { wait: (wait: string | null) => void },
      ) => {
        observer.wait("reconnecting");
        seen.push(live().round?.note);
        observer.wait("busy");
        seen.push(live().round?.note);
        observer.wait(null);
        seen.push(live().round?.note);
        return ANSWER;
      },
    );
    await lastDeps.infer({ user_text: "hi" }, []);
    expect(seen).toEqual(["reconnecting", "busy", undefined]);
  });

  it("does not let a retired turn's reconnect paint the round of the turn that replaced it", async () => {
    await startTurn();
    const first = lastDeps;
    let wait!: (note: string | null) => void;
    let finishFirst!: (v: unknown) => void;
    (inferRoundStreaming as Any).mockImplementationOnce(
      (
        _body: Any,
        _onDelta: unknown,
        _signal: unknown,
        observer: { wait: (note: string | null) => void },
      ) => {
        wait = observer.wait;
        return new Promise((resolve) => (finishFirst = resolve));
      },
    );
    const firstRound = first.infer({ user_text: "hi" }, []);
    await useChat.getState().send("second message"); // retires the first turn
    (inferRoundStreaming as Any).mockImplementationOnce(() => new Promise(() => undefined));
    void lastDeps.infer({ user_text: "second" }, []);
    wait("reconnecting");
    expect(live().round?.note).toBeUndefined();
    finishFirst(ANSWER);
    await firstRound;
  });

  it("does not let a retired turn's round ending wipe the round of the turn that replaced it", async () => {
    await startTurn();
    const first = lastDeps;
    let finishFirst!: (v: unknown) => void;
    (inferRoundStreaming as Any).mockImplementationOnce(
      () => new Promise((resolve) => (finishFirst = resolve)),
    );
    const firstRound = first.infer({ user_text: "hi" }, []);
    await useChat.getState().send("second message"); // retires the first turn
    (inferRoundStreaming as Any).mockImplementationOnce(() => new Promise(() => undefined));
    void lastDeps.infer({ user_text: "second" }, []);
    expect(live().round?.phase).toBe("preparing");

    finishFirst(ANSWER);
    await firstRound;
    expect(live().round).not.toBeNull();
  });

  it.each(["turn_done", "error"])(
    "shows nothing once the turn has ended with %s",
    async (event) => {
      await startTurn();
      live().roundStarted();
      emit("tool_call", { call_id: "c1", name: "video_ask", args: {} });
      emit(event, event === "error" ? { error: "boom" } : snap());
      expect(nothing()).toEqual(NOTHING);
    },
  );

  // Stop must end every kind of wait at once, whatever the turn was waiting on.
  it.each([
    [
      "a model round",
      async () => {
        (inferRoundStreaming as Any).mockImplementationOnce(() => new Promise(() => undefined));
        void lastDeps.infer({ user_text: "hi" }, []);
        expect(live().round).not.toBeNull();
      },
    ],
    [
      "a tool call",
      async () => {
        emit("tool_call", { call_id: "c1", name: "video_ask", args: {} });
        expect(live().calls).toHaveLength(1);
      },
    ],
    [
      "an approval",
      async () => {
        emit("awaiting_approval", { calls: [{ call_id: "c1", name: "add_clips", arguments: {} }] });
        emit("turn_paused", snap());
        expect(live().approvalSince).not.toBeNull();
      },
    ],
  ])("Stop ends a wait on %s at once and leaves nothing showing", async (_name, arrange) => {
    await startTurn();
    await arrange();
    await useChat.getState().stop();
    expect(useChat.getState().streaming).toBe(false);
    expect(useChat.getState().turns.at(-1)?.status).toBe("done");
    expect(nothing()).toEqual(NOTHING);
  });

  it.each([
    ["a new message", () => useChat.getState().send("try again")],
    ["Continue", () => useChat.getState().continueRun()],
  ])(
    "starts the next run (%s) from nothing waiting, even if the last run abandoned a call that ignored Stop",
    async (_name, next) => {
      await startTurn();
      emit("tool_call", { call_id: "stuck", name: "video_ask", args: {} });
      await useChat.getState().stop();
      emit("tool_call", { call_id: "late", name: "video_ask", args: {} }); // arrives after Stop
      expect(live().calls).toHaveLength(1);
      await next();
      expect(nothing()).toEqual(NOTHING);
    },
  );
});

// Each turn reports when it started and ended, how, where its time went, and the person's answers. The
// parts of a turn's time add up to its wall time; nothing the person typed is in any event.
describe("useChat records each turn (T-11, T-12)", () => {
  const events = () => __bufferedAgentEvents();
  const kinds = () => events().map((e) => e.kind);
  const ofKind = (kind: string) => events().filter((e) => e.kind === kind);
  const ANSWER = {
    kind: "text",
    final_text: "ok",
    usage: {},
    provider_snapshot: {},
    history_mode: "client",
  };
  const T0 = 20_000_000;
  const at = (ms: number) => vi.setSystemTime(T0 + ms);

  beforeEach(() => {
    __resetAgentEvents();
    resetLiveWait();
    resetHistoryModeSupport();
    useAuth.setState({ status: "unlocked", profile: null, hasStoredSession: true });
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetAgentEvents();
    resetLiveWait();
  });

  async function startTurn(text = "hi", opts?: { system?: boolean }): Promise<void> {
    setDesktop("p1");
    useChat.setState({
      projectId: "p1",
      transcriptId: "tx1",
      model: "gpt-5.6-luna",
      effort: "high",
    });
    await useChat.getState().send(text, [], opts);
  }

  // The report says how the project reached the model, so a read that quietly fails is visible in the field.
  describe("how the project reached the model", () => {
    const track = (id: string, clips: number) => ({
      id,
      kind: "video",
      z: 0,
      clips: Array.from({ length: clips }, (_, i) => ({
        id: `${id}_${i}`,
        media_ref: "media_a",
        timeline_in: i * 90,
        timeline_out: (i + 1) * 90,
      })),
    });
    const readingHost = (reply: (name: string) => unknown) =>
      (openToolHost as Any).mockImplementation((id: string) => ({
        projectId: id,
        ready: Promise.resolve(),
        has: (n: string) => n === "get_timeline" || n === "get_project_state",
        run: vi.fn(async (name: string) => reply(name)),
        store: () => null,
      }));
    const project = { ok: true, project_id: "p1", name: "Reel", library: [], library_count: 0 };
    const listing = (tracks: unknown[]) => (name: string) =>
      name === "get_timeline" ? { ok: true, timeline: { units: "frames", tracks } } : project;
    afterEach(() => {
      (openToolHost as Any).mockImplementation((id: string) => ({
        projectId: id,
        ready: Promise.resolve(),
        has: () => false,
        run: vi.fn(async () => ({})),
        store: () => null,
      }));
    });

    it("reports a whole listing on the turn that was given one, and nothing on a later turn that was not", async () => {
      readingHost(listing([track("v1", 2)]));
      await startTurn("make it punchy");
      emit("turn_done", snap());
      await useChat.getState().send("and again");
      emit("turn_done", snap());
      const [first, second] = ofKind("turn_end");
      expect(first).toMatchObject({ outcome: "done", state: "full" });
      expect(second).toMatchObject({ outcome: "done" });
      expect(second).not.toHaveProperty("state");
    });

    it("reports an outline when the project was too big to list", async () => {
      readingHost(listing(Array.from({ length: 12 }, (_, i) => track(`t${i}`, 300))));
      await startTurn("make it punchy");
      emit("turn_done", snap());
      expect(ofKind("turn_end")[0]).toMatchObject({ state: "summary" });
    });

    it("reports a read that failed, so it cannot go unnoticed", async () => {
      readingHost((name) =>
        name === "get_timeline" ? { ok: false, error: "timeline.json not found" } : project,
      );
      await startTurn("make it punchy");
      emit("turn_done", snap());
      expect(ofKind("turn_end")[0]).toMatchObject({ outcome: "done", state: "failed" });
    });

    it("says nothing for the app's own turns, which never ask for a read", async () => {
      readingHost(listing([track("v1", 2)]));
      await startTurn("Background work you started earlier has finished:", { system: true });
      emit("turn_done", snap());
      expect(ofKind("turn_end")[0]).not.toHaveProperty("state");
    });

    it("says nothing when the host cannot make the reads (nothing was attempted, so nothing failed)", async () => {
      await startTurn("make it punchy"); // the default host here claims to run no tool
      emit("turn_done", snap());
      expect(ofKind("turn_end")[0]).not.toHaveProperty("state");
    });
  });

  // The server says, round by round, where ITS time went; the turn adds those up (the server's timing frame, round_timing.py).
  describe("where the server's time went", () => {
    const round = (n: number) => ({
      intake_ms: 100 * n,
      line_ms: 0,
      admit_ms: 1_000 + n,
      vendor_ms: 10_000 + n,
      settle_ms: 400 + n,
    });
    const reportingRound = (timing: unknown) =>
      (inferRoundStreaming as Any).mockImplementationOnce(
        async (
          _body: Any,
          _delta: unknown,
          _signal: unknown,
          observer: { timing: (t: unknown) => void },
        ) => {
          observer.timing(timing);
          return ANSWER;
        },
      );

    it("adds up the rounds that reported it and stores the sums with the turn's end, naming how many reported", async () => {
      await startTurn();
      reportingRound(round(1));
      await lastDeps.infer({ user_text: "hi" }, []);
      reportingRound(round(2));
      await lastDeps.infer({ user_text: "again" }, []);
      emit("turn_done", snap());
      expect(ofKind("turn_end")[0]).toMatchObject({
        srv_rounds: 2,
        srv_intake_ms: 300,
        srv_line_ms: 0,
        srv_admit_ms: 2_003,
        srv_vendor_ms: 20_003,
        srv_settle_ms: 803,
      });
    });

    it("says nothing at all when no round reported (a server that has not sent one): not zeros", async () => {
      await startTurn();
      (inferRoundStreaming as Any).mockResolvedValueOnce(ANSWER);
      await lastDeps.infer({ user_text: "hi" }, []);
      emit("turn_done", snap());
      const [end] = ofKind("turn_end");
      for (const key of [
        "srv_rounds",
        "srv_intake_ms",
        "srv_admit_ms",
        "srv_vendor_ms",
        "srv_settle_ms",
      ])
        expect(end).not.toHaveProperty(key);
    });

    it("counts only the frames that are what they say: parts missing, negative or not an object are not rounds", async () => {
      await startTurn();
      reportingRound({ intake_ms: 5, vendor_ms: 5 }); // parts missing
      await lastDeps.infer({ user_text: "a" }, []);
      reportingRound({ ...round(1), vendor_ms: -1 });
      await lastDeps.infer({ user_text: "b" }, []);
      reportingRound("fast");
      await lastDeps.infer({ user_text: "c" }, []);
      reportingRound(round(3));
      await lastDeps.infer({ user_text: "d" }, []);
      emit("turn_done", snap());
      expect(ofKind("turn_end")[0]).toMatchObject({ srv_rounds: 1, srv_vendor_ms: 10_003 });
    });
  });

  it("a turn whose waits were injected (3 s admission, 5 s on its way, 10 s thinking, 2 s writing, a 20 s tool) is stored with parts that add up to its wall time", async () => {
    await startTurn();
    (inferRoundStreaming as Any).mockImplementationOnce(
      async (
        _body: Any,
        onDelta: (d: Any) => void,
        _signal: unknown,
        observer: { wait: (w: string | null) => void; sent: (n: number) => void; head: () => void },
      ) => {
        observer.sent(1_900_000);
        observer.wait("busy");
        at(3_000);
        observer.wait(null);
        at(8_000);
        observer.head();
        at(18_000);
        onDelta({ kind: "text", text: "hi" });
        at(20_000);
        return ANSWER;
      },
    );
    await lastDeps.infer({ user_text: "hi" }, []);
    emit("tool_call", { call_id: "c1", name: "video_ask", args: {} });
    at(40_000);
    emit("tool_result", { call_id: "c1", name: "video_ask", ok: true });
    emit("turn_done", snap());

    expect(kinds()).toEqual(["turn_start", "turn_end"]);
    const [start, end] = events();
    expect(start).toMatchObject({
      turn_id: useChat.getState().turns.at(-1)?.id,
      trigger: "user",
      mode: "default",
      effort: "high",
      attachments: 0,
    });
    expect(end).toMatchObject({
      turn_id: start.turn_id,
      outcome: "done",
      wall_ms: 40_000,
      wait_ms: 3_000,
      request_ms: 5_000,
      think_ms: 10_000,
      stream_ms: 2_000,
      tool_ms: 20_000,
      prep_ms: 0,
      approval_ms: 0,
      other_ms: 0,
      rounds: 1,
      tools: 1,
      busy_waits: 1,
      reconnects: 0,
      frames: 1,
      bytes_up: 1_900_000,
    });
    const parts = [
      "prep_ms",
      "request_ms",
      "think_ms",
      "stream_ms",
      "tool_ms",
      "wait_ms",
      "approval_ms",
      "other_ms",
    ] as const;
    expect(parts.reduce((sum, key) => sum + (end[key] ?? 0), 0)).toBe(end.wall_ms);
  });

  it("every event of a turn names the same turn", async () => {
    await startTurn();
    emit("awaiting_approval", { calls: [{ call_id: "c1", name: "export", arguments: {} }] });
    emit("turn_paused", snap());
    await useChat.getState().approve("c1");
    emit("turn_done", snap());
    expect(kinds()).toEqual(["turn_start", "approval_requested", "approval_decided", "turn_end"]);
    const ids = new Set(events().map((e) => e.turn_id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBe(useChat.getState().turns.at(-1)?.id);
  });

  it("nothing the person typed is in any event", async () => {
    await startTurn("my secret brief about the wedding");
    emit("awaiting_approval", {
      calls: [{ call_id: "c1", name: "export", arguments: { path: "C:/Users/me/secret.mp4" } }],
    });
    emit("turn_paused", snap());
    await useChat.getState().approve("c1");
    emit("turn_done", snap());
    const text = JSON.stringify(events());
    expect(text).not.toMatch(/secret|wedding|brief|C:\/Users/);
  });

  it("a Stop ends the turn as stopped, once, however many paths report it", async () => {
    await startTurn();
    at(7_000);
    await useChat.getState().stop();
    await useChat.getState().stop();
    emit("turn_done", snap()); // a late event from the stopped runner
    const ends = ofKind("turn_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ outcome: "stopped", wall_ms: 7_000 });
  });

  it("an error ends the turn as error with the server's code", async () => {
    await startTurn();
    emit("error", { error: "boom", error_code: "provider_timeout" });
    expect(ofKind("turn_end")[0]).toMatchObject({ outcome: "error", code: "provider_timeout" });
  });

  it("a runner that throws ends the turn as error with its own code", async () => {
    runnerStart.mockRejectedValueOnce(new Error("kaboom"));
    await startTurn();
    const [end] = ofKind("turn_end");
    expect(end).toMatchObject({ outcome: "error" });
    expect(typeof end.code).toBe("string");
  });

  it("a tool host that cannot start ends the turn as error host_unavailable, with its start recorded", async () => {
    vi.mocked(openToolHost).mockImplementationOnce(
      () =>
        ({
          projectId: "p1",
          ready: Promise.reject(new Error("no fs")),
          has: () => false,
          run: vi.fn(),
          store: () => null,
        }) as never,
    );
    await startTurn();
    expect(kinds()).toEqual(["turn_start", "turn_end"]);
    expect(ofKind("turn_end")[0]).toMatchObject({ outcome: "error", code: "host_unavailable" });
  });

  it("a wake from a finished background job is a system turn", async () => {
    await startTurn("a job finished", { system: true });
    expect(ofKind("turn_start")[0]).toMatchObject({ trigger: "system" });
  });

  it("the person's answers are recorded one by one with how long they took, and their wait is the turn's approval time", async () => {
    await startTurn();
    emit("awaiting_approval", {
      calls: [
        { call_id: "c1", name: "export", arguments: {} },
        { call_id: "c2", name: "add_clips", arguments: {} },
      ],
    });
    emit("turn_paused", snap());
    at(12_000);
    await useChat.getState().approve("c1");
    at(20_000);
    await useChat.getState().deny("no thanks", "c2");
    emit("turn_done", snap());

    expect(ofKind("approval_requested")[0]).toMatchObject({ name: "export,add_clips", tools: 2 });
    expect(ofKind("approval_decided").map((e) => [e.call_id, e.decision, e.approval_ms])).toEqual([
      ["c1", "approved", 12_000],
      ["c2", "declined", 20_000],
    ]);
    expect(ofKind("turn_end")[0]).toMatchObject({
      outcome: "done",
      approval_ms: 20_000,
      approvals: 2,
      wall_ms: 20_000,
    });
  });

  it("a Stop while the person has not answered answers for them: stopped", async () => {
    await startTurn();
    emit("awaiting_approval", { calls: [{ call_id: "c1", name: "export", arguments: {} }] });
    emit("turn_paused", snap());
    at(9_000);
    await useChat.getState().stop();
    expect(ofKind("approval_decided").map((e) => [e.call_id, e.decision, e.approval_ms])).toEqual([
      ["c1", "stopped", 9_000],
    ]);
    expect(ofKind("turn_end")[0]).toMatchObject({ outcome: "stopped", approval_ms: 9_000 });
  });

  it("a new message while the person has not answered leaves the turn behind: abandoned, and the question with it", async () => {
    await startTurn("first");
    emit("awaiting_approval", { calls: [{ call_id: "c1", name: "export", arguments: {} }] });
    emit("turn_paused", snap());
    at(30_000);
    await useChat.getState().send("second");
    expect(ofKind("approval_decided")[0]).toMatchObject({
      decision: "abandoned",
      approval_ms: 30_000,
    });
    expect(ofKind("turn_end")[0]).toMatchObject({ outcome: "abandoned", approval_ms: 30_000 });
    // The new turn starts its own record.
    expect(ofKind("turn_start")).toHaveLength(2);
    expect(ofKind("turn_start")[1].turn_id).not.toBe(ofKind("turn_start")[0].turn_id);
  });

  it("switching project leaves the turn behind the same way, once", async () => {
    await startTurn();
    loadSess.mockResolvedValue({ requests: [], providerSnapshot: null, session: snap() });
    await useChat.getState().load("p2");
    expect(ofKind("turn_end")).toHaveLength(1);
    expect(ofKind("turn_end")[0]).toMatchObject({ outcome: "abandoned" });
  });

  it("a turn paused at its cap is waiting for the person too, until they press Continue", async () => {
    await startTurn();
    emit("turn_paused", snap({ can_continue: true }));
    at(15_000);
    await useChat.getState().continueRun();
    at(16_000);
    emit("turn_done", snap());
    expect(ofKind("approval_requested")).toHaveLength(0);
    expect(ofKind("turn_end")[0]).toMatchObject({
      approval_ms: 15_000,
      approvals: 0,
      wall_ms: 16_000,
    });
  });

  it("is silent when signed out: no event of the turn is kept", async () => {
    useAuth.setState({ status: "locked", profile: null, hasStoredSession: false });
    await startTurn();
    emit("turn_done", snap());
    expect(events()).toEqual([]);
  });

  it("draws the person's eye when the turn stops to ask them, or to wait for Continue, and for nothing else", async () => {
    await startTurn();
    emit("tool_call", { call_id: "c0", name: "inspect_media", args: {} });
    emit("tool_result", { call_id: "c0", name: "inspect_media", ok: true });
    emit("text", { text: "working" });
    expect(askForAttention).not.toHaveBeenCalled();

    emit("awaiting_approval", { calls: [{ call_id: "c1", name: "export", arguments: {} }] });
    emit("turn_paused", snap()); // the same stop: one hint, not two
    expect(askForAttention).toHaveBeenCalledTimes(1);

    await useChat.getState().approve("c1");
    emit("turn_paused", snap({ can_continue: true }));
    expect(askForAttention).toHaveBeenCalledTimes(2);

    await useChat.getState().continueRun();
    emit("turn_done", snap());
    expect(askForAttention).toHaveBeenCalledTimes(2);
  });
});
