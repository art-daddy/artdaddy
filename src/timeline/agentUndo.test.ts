// The undo rate's events, driven through the real producers on a real open document: the agent's edit committed through
// its own view of the store, the editor's Undo and Redo, an edit made by hand, and the chat's Undo and Redo of a turn.
// What is asserted is the body that leaves for /telemetry/agent, never which function was called.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/config")>()),
  apiBase: () => "https://example.invalid",
}));
vi.mock("../api/auth", () => ({
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
  __resetAgentEvents,
  __setUndoEventsShipped,
  agentEventContext,
  flushAgentEvents,
  setAgentContext,
  type AgentEditCall,
} from "../api/agentEvents";
import type { MutationOrigin } from "../project/MutationGate";
import { ProjectDocument } from "../project/ProjectDocument";
import { setOpenDocumentResolver } from "../project/openDocuments";
import { asProjectId } from "../project/types";
import { useAuth } from "../store/auth";
import { agentToolContext } from "../tools/agentStore";
import type { ClientToolContext } from "../tools/context";
import { ProjectStoreAccess, joinPath, type FsLike } from "../tools/store";
import {
  __resetAgentUndo,
  AGENT_EDIT_WINDOW_MS,
  agentEditsOfCalls,
  noteChatRedo,
  noteChatUndo,
  toolCallIds,
} from "./agentUndo";
import {
  applyOp,
  ctxApplyOp,
  doRedo,
  doUndo,
  ensureTimeline,
  loadTimeline,
  replaceTimeline,
  runGesture,
} from "./engine";
import type { Clip, Timeline } from "./model";
import { redoTool, undoTool } from "./ops";

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

const DIR = "C:/proj";
const ORIGIN: MutationOrigin = { chatSessionId: "t1", branchId: 0, executionId: 1 };
const T0 = Date.parse("2026-11-28T10:00:00Z");

let doc: ProjectDocument;
let store: ProjectStoreAccess;
const posted: Record<string, unknown>[] = [];

/** The agent's call, with the labels its own trace would carry. */
function call(tool: string, callId: string, labels: Record<string, unknown> = {}): AgentEditCall {
  return {
    tool,
    callId,
    labels: {
      ...agentEventContext(),
      surface: "app",
      model: "gpt-6-luna",
      project_id: "proj",
      transcript_id: "t1",
      ...labels,
    },
  };
}
/** The context a tool call of the agent runs with (tools/host.ts builds it the same way). */
const agentCtx = (c?: AgentEditCall, origin: MutationOrigin | undefined = ORIGIN) =>
  agentToolContext(
    { store } as unknown as ClientToolContext,
    new AbortController().signal,
    origin,
    c,
  );

const clip = (id: string, at: number, length = 30): Clip => ({
  id,
  kind: "video",
  media_ref: `library/media_${id}.mp4`,
  timeline_in: at,
  timeline_out: at + length,
  source_in: 0,
  source_out: length,
});
const clipOf = (t: Timeline, id: string) =>
  t.tracks.flatMap((track) => track.clips ?? []).find((c) => c.id === id);
/** Move clip `id` so it starts at `at`. */
const moveTo = (id: string, at: number) => (t: Timeline) => {
  const c = clipOf(t, id)!;
  const length = c.timeline_out - c.timeline_in;
  c.timeline_in = at;
  c.timeline_out = at + length;
};
const removeClip = (id: string) => (t: Timeline) => {
  for (const track of t.tracks) track.clips = (track.clips ?? []).filter((c) => c.id !== id);
};
const addClip = (c: Clip) => (t: Timeline) => void t.tracks[0].clips!.push(c);

/** Every undo event that left, with the labels of the batch it left in. */
async function sent(): Promise<Record<string, unknown>[]> {
  await flushAgentEvents();
  return posted.flatMap((body) =>
    (body.events as Record<string, unknown>[])
      .filter((e) => e.kind === "edit_undone" || e.kind === "edit_redone")
      .map((e) => ({
        kind: e.kind,
        name: e.name,
        call_id: e.call_id,
        via: e.via,
        ms: e.ms,
        model: body.model,
        surface: body.surface,
      })),
  );
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  __resetAgentEvents();
  __resetAgentUndo();
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
  store = new ProjectStoreAccess(DIR, new MemFs());
  await ensureTimeline(store);
  // The project the person starts from, made by hand: one clip on one video track.
  const seeded = await applyOp(store, "seed", (t) => {
    t.tracks.push({ id: "v1", kind: "video", z: 0, clips: [clip("a", 0)] });
  });
  expect(seeded.ok).toBe(true);
});

afterEach(async () => {
  await doc.autosave.flush();
  setOpenDocumentResolver(() => undefined);
  __resetAgentEvents();
  __resetAgentUndo();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("in the build as shipped", () => {
  // This test pins the state the build ships in. It fails when UNDO_EVENTS_SHIPPED is turned on, which needs the owner's
  // yes and both privacy documents (the app's PRIVACY.txt and the website's privacy page) changed in the same commit; that
  // commit changes this test to say the lit state. Every other test turns the events on through the setter.
  it("sends nothing when the person undoes, redoes or puts back the agent's edit, by any door", async () => {
    await ctxApplyOp(agentCtx(call("move_clips", "c1")), "move_clips", moveTo("a", 90));
    vi.setSystemTime(T0 + 60_000);
    expect((await doUndo(store)).ok).toBe(true);
    expect((await doRedo(store)).ok).toBe(true);
    await applyOp(store, "move_clips", moveTo("a", 0)); // put back by hand
    const takenBack = agentEditsOfCalls(DIR, new Set(["c1"]));
    expect(takenBack).toEqual([]); // nothing is even read while it is dark
    noteChatUndo(takenBack);
    noteChatRedo(new Set(["c1"]));
    expect(await sent()).toEqual([]);
    expect(posted).toEqual([]);
  });
});

describe("once a build sends them", () => {
  beforeEach(() => __setUndoEventsShipped(true));

  it("tells the person's Undo of the agent's edit: the tool, how long after, and the model that made it", async () => {
    await ctxApplyOp(agentCtx(call("move_clips", "c1")), "move_clips", moveTo("a", 90));
    // The person switches model before undoing: the event still names the model that made the edit.
    setAgentContext({ model: "gpt-6.1-sol" });
    vi.setSystemTime(T0 + 90_000);
    expect((await doUndo(store)).ok).toBe(true);
    expect(clipOf(await loadTimeline(store), "a")?.timeline_in).toBe(0);
    expect(await sent()).toEqual([
      {
        kind: "edit_undone",
        name: "move_clips",
        call_id: "c1",
        via: "editor",
        ms: 90_000,
        model: "gpt-6-luna",
        surface: "app",
      },
    ]);
  });

  it("carries no content: only the kind, the time, the tool's name, the call's id, how long after and where", async () => {
    await ctxApplyOp(agentCtx(call("add_clips", "c9")), "add_clips", (t) => {
      t.tracks[0].clips!.push({ ...clip("bday", 200), media_ref: "library/Asha birthday.mp4" });
    });
    await doUndo(store);
    await flushAgentEvents();
    const events = posted.flatMap((b) => b.events as Record<string, unknown>[]);
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]).sort()).toEqual(["at", "call_id", "kind", "ms", "name", "via"]);
    expect(JSON.stringify(posted)).not.toMatch(/Asha|birthday|bday/);
  });

  it("does not take the agent's own undo, or an outside agent's over MCP, for the person's", async () => {
    await ctxApplyOp(agentCtx(call("move_clips", "c1")), "move_clips", moveTo("a", 90));
    expect((await undoTool({}, agentCtx(call("undo", "c2")))).ok).toBe(true);
    expect((await redoTool({}, agentCtx(call("redo", "c3")))).ok).toBe(true);
    const mcp = call("undo", "41", { surface: "mcp", model: "", transcript_id: "" });
    expect((await undoTool({}, agentCtx(mcp, undefined))).ok).toBe(true);
    // An agent view whose call is not known is still an agent's: its undo is not the person's either.
    expect((await redoTool({}, agentCtx(undefined))).ok).toBe(true);
    expect((await undoTool({}, agentCtx(undefined))).ok).toBe(true);
    expect(await sent()).toEqual([]);
  });

  it("does not tell an Undo of the person's own edit", async () => {
    await applyOp(store, "move_clips", moveTo("a", 300));
    await runGesture(store, "nudge_clips", (apply) => apply("nudge", moveTo("a", 301)));
    expect((await doUndo(store)).ok).toBe(true);
    expect((await doUndo(store)).ok).toBe(true);
    expect(await sent()).toEqual([]);
  });

  it("tells an Undo up to half an hour after the agent's edit, and not one a moment later", async () => {
    await ctxApplyOp(agentCtx(call("move_clips", "late")), "move_clips", moveTo("a", 90));
    vi.setSystemTime(T0 + AGENT_EDIT_WINDOW_MS + 1);
    expect((await doUndo(store)).ok).toBe(true);
    expect(await sent()).toEqual([]);

    vi.setSystemTime(T0);
    await ctxApplyOp(agentCtx(call("move_clips", "soon")), "move_clips", moveTo("a", 90));
    vi.setSystemTime(T0 + AGENT_EDIT_WINDOW_MS);
    expect((await doUndo(store)).ok).toBe(true);
    expect((await sent()).map((e) => e.call_id)).toEqual(["soon"]);
  });

  it("tells a Redo that brings the edit back after a told Undo, and not one whose Undo was not told", async () => {
    await ctxApplyOp(agentCtx(call("split_clips", "c1")), "split_clips", moveTo("a", 90));
    vi.setSystemTime(T0 + 5_000);
    await doUndo(store);
    vi.setSystemTime(T0 + 7_000);
    await doRedo(store);
    expect(await sent()).toEqual([
      expect.objectContaining({ kind: "edit_undone", call_id: "c1", via: "editor", ms: 5_000 }),
      expect.objectContaining({ kind: "edit_redone", call_id: "c1", via: "editor", ms: 7_000 }),
    ]);

    posted.length = 0;
    await ctxApplyOp(agentCtx(call("move_clips", "old")), "move_clips", moveTo("a", 150));
    vi.setSystemTime(T0 + 7_000 + AGENT_EDIT_WINDOW_MS + 1);
    await doUndo(store); // too late to be told
    await doRedo(store);
    expect(await sent()).toEqual([]);
  });

  it("tells a clip the agent moved and the person put back by hand, once", async () => {
    await ctxApplyOp(agentCtx(call("move_clips", "c1")), "move_clips", moveTo("a", 90));
    vi.setSystemTime(T0 + 20_000);
    await runGesture(store, "move_clips", (apply) => apply("move", moveTo("a", 0)));
    // Touched again and put back again: still the one answer to the one edit.
    await applyOp(store, "move_clips", moveTo("a", 5));
    await applyOp(store, "move_clips", moveTo("a", 0));
    expect(await sent()).toEqual([
      expect.objectContaining({ kind: "edit_undone", call_id: "c1", via: "hand", ms: 20_000 }),
    ]);
  });

  it("does not take an ordinary edit of the same clip for putting it back", async () => {
    await ctxApplyOp(agentCtx(call("move_clips", "c1")), "move_clips", moveTo("a", 90));
    await applyOp(store, "move_clips", moveTo("a", 120)); // moved on, not back
    await applyOp(store, "trim", (t) => void (clipOf(t, "a")!.timeline_out = 140)); // trimmed where the agent left it
    await applyOp(store, "add", addClip(clip("b", 400))); // another clip entirely
    expect(await sent()).toEqual([]);
  });

  it("tells a clip the agent made and the person deleted by hand", async () => {
    await ctxApplyOp(agentCtx(call("add_clips", "c1")), "add_clips", addClip(clip("n", 200)));
    vi.setSystemTime(T0 + 3_000);
    await applyOp(store, "remove_clips", removeClip("n"));
    expect(await sent()).toEqual([
      expect.objectContaining({
        kind: "edit_undone",
        name: "add_clips",
        call_id: "c1",
        via: "hand",
        ms: 3_000,
      }),
    ]);
  });

  it("does not tell a hand edit long after the agent's edit, even one that puts it back", async () => {
    await ctxApplyOp(agentCtx(call("move_clips", "c1")), "move_clips", moveTo("a", 90));
    vi.setSystemTime(T0 + AGENT_EDIT_WINDOW_MS + 1);
    await applyOp(store, "move_clips", moveTo("a", 0));
    expect(await sent()).toEqual([]);
  });

  it("files an edit made under another account with that account: a sign-in in between drops it", async () => {
    await ctxApplyOp(agentCtx(call("move_clips", "c1")), "move_clips", moveTo("a", 90));
    useAuth.setState({
      status: "unlocked",
      profile: { user_id: "user_a" } as never,
      hasStoredSession: true,
    });
    useAuth.setState({
      status: "unlocked",
      profile: { user_id: "user_b" } as never,
      hasStoredSession: true,
    });
    await doUndo(store);
    expect(await sent()).toEqual([]);
  });

  it("tells the chat's Undo of a turn once per call of that turn, and its Redo after it", async () => {
    const before = await loadTimeline(store);
    // One turn: c1 committed twice, c2 once. Another turn's c3 is not taken back.
    await ctxApplyOp(agentCtx(call("move_clips", "c1")), "move_clips", moveTo("a", 90));
    await ctxApplyOp(agentCtx(call("move_clips", "c1")), "move_clips", moveTo("a", 100));
    await ctxApplyOp(agentCtx(call("add_clips", "c2")), "add_clips", addClip(clip("n", 300)));
    await ctxApplyOp(
      agentCtx(call("set_track", "c3")),
      "set_track",
      (t) => void (t.tracks[0].mute = true),
    );
    const turn = {
      parts: [
        { kind: "tool_call", call_id: "c1", name: "move_clips" },
        { kind: "tool_result", call_id: "c1", name: "move_clips", ok: true },
        { kind: "tool_call", call_id: "c2", name: "add_clips" },
        { kind: "text", text: "Moved it and added one." },
      ],
    };
    vi.setSystemTime(T0 + 45_000);
    const takenBack = agentEditsOfCalls(DIR, toolCallIds([turn]));
    expect(await replaceTimeline(store, before)).toBe(true);
    noteChatUndo(takenBack);
    vi.setSystemTime(T0 + 50_000);
    noteChatRedo(toolCallIds([turn]));
    expect(await sent()).toEqual([
      expect.objectContaining({ kind: "edit_undone", call_id: "c1", via: "chat", ms: 45_000 }),
      expect.objectContaining({
        kind: "edit_undone",
        call_id: "c2",
        name: "add_clips",
        via: "chat",
      }),
      expect.objectContaining({ kind: "edit_redone", call_id: "c1", via: "chat", ms: 50_000 }),
      expect.objectContaining({ kind: "edit_redone", call_id: "c2", via: "chat" }),
    ]);
  });

  it("reads nothing for the chat once the restore has started the history over", async () => {
    await ctxApplyOp(agentCtx(call("move_clips", "c1")), "move_clips", moveTo("a", 90));
    const turn = { parts: [{ kind: "tool_call", call_id: "c1" }] };
    const before = (await loadTimeline(store)) as Timeline;
    expect(await replaceTimeline(store, { ...before })).toBe(true);
    expect(agentEditsOfCalls(DIR, toolCallIds([turn]))).toEqual([]);
  });
});
