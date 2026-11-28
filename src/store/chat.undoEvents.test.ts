// The chat's Undo, Redo, Restore and "Undo restore" of a turn tell the undo rate which of the agent's edits they took back,
// or brought back (timeline/agentUndo.ts). Driven through the real chat store, a real open document and the real engine,
// with the agent's edits committed the way its tool calls commit them; what is asserted is the body that leaves for
// /telemetry/agent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent/loop", () => ({
  ClientTurnRunner: class {
    pending: unknown = null;
    start = async () => {};
    takeUnsentResults = () => [];
    approve = async () => {};
    deny = async () => {};
    continueRun = async () => {};
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
vi.mock("../agent/historyFrames", () => ({ historyAttachments: vi.fn(async () => []) }));
vi.mock("./transcriptFile", () => ({
  loadClientSession: vi.fn(),
  persistSession: vi.fn(),
  persistSessionSoon: vi.fn(),
  persistSessionNow: vi.fn(async () => true),
}));
vi.mock("../api/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/config")>()),
  apiBase: () => "https://example.invalid",
}));
vi.mock("../api/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/auth")>()),
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

import {
  __resetAgentEvents,
  __setUndoEventsShipped,
  agentEventContext,
  flushAgentEvents,
} from "../api/agentEvents";
import { ProjectDocument } from "../project/ProjectDocument";
import { setOpenDocumentResolver } from "../project/openDocuments";
import { asProjectId } from "../project/types";
import { __resetAgentUndo } from "../timeline/agentUndo";
import { applyOp, ctxApplyOp, doUndo, ensureTimeline, loadTimeline } from "../timeline/engine";
import type { Clip, Timeline } from "../timeline/model";
import { agentToolContext } from "../tools/agentStore";
import type { ClientToolContext } from "../tools/context";
import { ProjectStoreAccess, joinPath, type FsLike } from "../tools/store";
import { useAuth } from "./auth";
import { useChat } from "./chat";
import type { Turn } from "./chatTranscript";
import { useEditor } from "./editor";

class MemFs implements FsLike {
  files = new Map<string, string>();
  async exists(p: string): Promise<boolean> {
    return this.files.has(joinPath(p));
  }
  async readTextFile(p: string): Promise<string> {
    const v = this.files.get(joinPath(p));
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  }
  async writeTextFile(p: string, c: string): Promise<void> {
    this.files.set(joinPath(p), c);
  }
  async mkdir(): Promise<void> {}
}

let doc: ProjectDocument;
let store: ProjectStoreAccess;
const posted: Record<string, unknown>[] = [];

const clip = (id: string, at: number): Clip => ({
  id,
  kind: "video",
  media_ref: `library/media_${id}.mp4`,
  timeline_in: at,
  timeline_out: at + 30,
  source_in: 0,
  source_out: 30,
});
const startOf = (t: Timeline, id: string) =>
  t.tracks.flatMap((track) => track.clips ?? []).find((c) => c.id === id)?.timeline_in;
const moveTo = (id: string, at: number) => (t: Timeline) => {
  const c = t.tracks.flatMap((track) => track.clips ?? []).find((x) => x.id === id)!;
  c.timeline_in = at;
  c.timeline_out = at + 30;
};

/** One of the agent's tool calls committing an edit, through the context its tool host gives it. */
async function agentEdit(
  tool: string,
  callId: string,
  mutate: (t: Timeline) => void,
): Promise<void> {
  const call = {
    tool,
    callId,
    labels: { ...agentEventContext(), model: "gpt-6-luna", project_id: "p1", transcript_id: "t1" },
  };
  const ctx = agentToolContext(
    { store } as unknown as ClientToolContext,
    new AbortController().signal,
    { chatSessionId: "t1", branchId: 0, executionId: 1 },
    call,
  );
  expect((await ctxApplyOp(ctx, tool, mutate)).ok).toBe(true);
}

/** A finished turn whose tools were `calls`, with the timeline before and after it. */
const turn = (
  id: string,
  calls: string[],
  checkpoint: Timeline | null,
  after: Timeline | null,
): Turn => ({
  id,
  userText: `turn ${id}`,
  attachments: [],
  parts: calls.flatMap((c) => [
    { kind: "tool_call", call_id: c, name: "move_clips", args: {} },
    { kind: "tool_result", call_id: c, name: "move_clips", ok: true },
  ]),
  status: "done",
  undone: false,
  checkpoint,
  timelineAfter: after,
});

const session = {
  cost_usd: 0,
  input_tokens: 0,
  output_tokens: 0,
  reasoning_tokens: 0,
  approval_mode: "default",
  finished: true,
  pending: false,
};

async function sent(): Promise<Record<string, unknown>[]> {
  await flushAgentEvents();
  return posted.flatMap((body) =>
    (body.events as Record<string, unknown>[])
      .filter((e) => e.kind === "edit_undone" || e.kind === "edit_redone")
      .map((e) => ({ kind: e.kind, call_id: e.call_id, via: e.via, model: body.model })),
  );
}

beforeEach(async () => {
  __resetAgentEvents();
  __resetAgentUndo();
  __setUndoEventsShipped(true);
  useAuth.setState({ status: "unlocked", profile: null, hasStoredSession: true });
  posted.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      posted.push(JSON.parse(init.body));
      return { ok: true } as Response;
    }),
  );
  doc = new ProjectDocument(asProjectId("proj"), {
    open: async () => "loaded",
    dispose: async () => {},
  });
  setOpenDocumentResolver((id) => (id === asProjectId("proj") ? doc : undefined));
  store = new ProjectStoreAccess("C:/proj", new MemFs());
  await ensureTimeline(store);
  await applyOp(store, "seed", (t) => {
    t.tracks.push({ id: "v1", kind: "video", z: 0, clips: [clip("a", 0), clip("b", 100)] });
  });
  useEditor.setState({
    projectId: "p1",
    store: store as never,
    timeline: null,
    reload: vi.fn(async () => {}) as never,
  });
});

afterEach(async () => {
  await doc.autosave.flush();
  setOpenDocumentResolver(() => undefined);
  useChat.setState({ projectId: null, turns: [], session: null, restored: null, rewind: null });
  useEditor.setState({ projectId: null, store: null, timeline: null });
  __resetAgentEvents();
  __resetAgentUndo();
  vi.unstubAllGlobals();
});

describe("the chat's Undo and Redo of a turn", () => {
  it("tells each edit of the turn it took back, and brings them back on Redo", async () => {
    const before = await loadTimeline(store);
    await agentEdit("move_clips", "c1", moveTo("a", 300));
    await agentEdit("move_clips", "c2", moveTo("b", 400));
    const after = await loadTimeline(store);
    useChat.setState({
      projectId: "p1",
      session,
      turns: [turn("t1", ["c1", "c2"], before, after)],
    });

    await useChat.getState().undo({ confirmed: true });
    expect(startOf(await loadTimeline(store), "a")).toBe(0);
    await useChat.getState().redo({ confirmed: true });
    expect(startOf(await loadTimeline(store), "a")).toBe(300);
    expect(await sent()).toEqual([
      { kind: "edit_undone", call_id: "c1", via: "chat", model: "gpt-6-luna" },
      { kind: "edit_undone", call_id: "c2", via: "chat", model: "gpt-6-luna" },
      { kind: "edit_redone", call_id: "c1", via: "chat", model: "gpt-6-luna" },
      { kind: "edit_redone", call_id: "c2", via: "chat", model: "gpt-6-luna" },
    ]);
  });

  it("takes back only the turn it undoes: an earlier turn's edit is not told", async () => {
    const t0 = await loadTimeline(store);
    await agentEdit("move_clips", "early", moveTo("a", 300));
    const t1 = await loadTimeline(store);
    await agentEdit("move_clips", "late", moveTo("b", 400));
    const t2 = await loadTimeline(store);
    useChat.setState({
      projectId: "p1",
      session,
      turns: [turn("t1", ["early"], t0, t1), turn("t2", ["late"], t1, t2)],
    });
    await useChat.getState().undo({ confirmed: true });
    expect(await sent()).toEqual([
      { kind: "edit_undone", call_id: "late", via: "chat", model: "gpt-6-luna" },
    ]);
  });

  it("does not tell again what the person already undid in the editor", async () => {
    const before = await loadTimeline(store);
    await agentEdit("move_clips", "c1", moveTo("a", 300));
    const after = await loadTimeline(store);
    useChat.setState({ projectId: "p1", session, turns: [turn("t1", ["c1"], before, after)] });
    await doUndo(store); // the editor's Undo, by the person
    await useChat.getState().undo({ confirmed: true });
    expect(await sent()).toEqual([
      { kind: "edit_undone", call_id: "c1", via: "editor", model: "gpt-6-luna" },
    ]);
  });

  it("tells nothing for a turn with no checkpoint: nothing was taken back", async () => {
    await agentEdit("move_clips", "c1", moveTo("a", 300));
    useChat.setState({ projectId: "p1", session, turns: [turn("t1", ["c1"], null, null)] });
    await useChat.getState().undo({ confirmed: true });
    expect(useChat.getState().turns[0].undone).toBe(true);
    expect(startOf(await loadTimeline(store), "a")).toBe(300);
    expect(await sent()).toEqual([]);
  });
});

describe("the chat's Restore checkpoint and its Undo restore", () => {
  it("tells every edit of the turns it goes back over, and brings them back on Undo restore", async () => {
    const t0 = await loadTimeline(store);
    await agentEdit("move_clips", "c1", moveTo("a", 300));
    const t1 = await loadTimeline(store);
    await agentEdit("move_clips", "c2", moveTo("b", 400));
    const t2 = await loadTimeline(store);
    useChat.setState({
      projectId: "p1",
      session,
      turns: [turn("t1", ["c1"], t0, t1), turn("t2", ["c2"], t1, t2)],
    });
    useEditor.setState({ timeline: t2 });

    expect(await useChat.getState().restoreTo("t1", { confirmed: true })).toMatchObject({
      text: "turn t1",
    });
    expect(startOf(await loadTimeline(store), "b")).toBe(100);
    expect(await useChat.getState().undoRestore({ confirmed: true })).toBe(true);
    expect(startOf(await loadTimeline(store), "b")).toBe(400);
    expect(await sent()).toEqual([
      { kind: "edit_undone", call_id: "c1", via: "chat", model: "gpt-6-luna" },
      { kind: "edit_undone", call_id: "c2", via: "chat", model: "gpt-6-luna" },
      { kind: "edit_redone", call_id: "c1", via: "chat", model: "gpt-6-luna" },
      { kind: "edit_redone", call_id: "c2", via: "chat", model: "gpt-6-luna" },
    ]);
  });
});
