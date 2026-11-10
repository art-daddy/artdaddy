// Chats of a project: put one away and start another, open an old one, delete one, and go back (restore)
// over work made outside a chat. These drive the real store and the real chat files over an in-memory disk,
// and assert what is on the disk and on screen afterwards, not which calls were made.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  runnerStart: vi.fn(async (_t: string) => {}),
  runnerContinue: vi.fn(async () => {}),
  runnerRetry: vi.fn(async () => {}),
  runnerCarried: vi.fn((_carried: unknown) => {}),
  runnerUnsent: [] as unknown[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deps: { current: null as any },
}));

vi.mock("../agent/loop", () => ({
  ClientTurnRunner: class {
    pending: unknown = null;
    canRetry = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(deps: any) {
      h.deps.current = deps;
    }
    start = (t: string, carried?: unknown) => {
      h.runnerCarried(carried);
      return h.runnerStart(t);
    };
    takeUnsentResults = () => h.runnerUnsent.splice(0);
    approve = async () => {};
    deny = async () => {};
    continueRun = () => h.runnerContinue();
    retry = () => h.runnerRetry();
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
vi.mock("../lib/desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/desktop")>()),
  storeForProject: vi.fn(),
}));
// A restore swaps the document's timeline; with no open document here, the swap is what the mirror shows.
vi.mock("../timeline/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../timeline/engine")>()),
  replaceTimeline: vi.fn(),
}));

import { inferRoundStreaming } from "../agent/api";
import { storeForProject } from "../lib/desktop";
import { replaceTimeline } from "../timeline/engine";
import { chatDisk, CHAT_DIR } from "../test/chatDisk";
import { joinPath } from "../tools/store";
import { resetHistoryModeSupport, useChat } from "./chat";
import { chatFilePath } from "./chatFiles";
import { useEditor } from "./editor";
import { __resetJobNotes, notifyJobSettled, pendingJobNotes } from "./jobNotes";
import { flushPendingSession, SESSION_REL } from "./transcriptFile";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const OPEN = joinPath(CHAT_DIR, SESSION_REL);

let disk: ReturnType<typeof chatDisk>;

const tl = (label: string): Any => ({
  fps: 30,
  tracks: [{ id: "v1", clips: [{ id: label, media_ref: `library/media_${label}.mp4` }] }],
});
const liveTimeline = (): Any => useEditor.getState().timeline;
const chatState = () => useChat.getState();
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const flush = () => flushPendingSession(CHAT_DIR);
/** What the server answers when it rebuilds the model's input from the transcript the app sends. */
const ECHO = {
  kind: "text",
  final_text: "ok",
  usage: {},
  provider_snapshot: {},
  history_mode: "client",
};
/** The body of the last model request the app made, after one round on the current runner. */
async function lastRequestBody(userText: string): Promise<Any> {
  (inferRoundStreaming as Any).mockResolvedValue(ECHO);
  await h.deps.current.infer({ user_text: userText }, []);
  return (inferRoundStreaming as Any).mock.calls.at(-1)[0];
}
const openFile = (): Any => disk.fs.json(OPEN);
const putAwayFile = (id: string): Any => disk.fs.json(chatFilePath(CHAT_DIR, id));
const emit = (event: string, data: unknown) => h.deps.current.emit(event, data);
const sessionState = (over: Record<string, unknown> = {}) => ({
  cost_usd: 0,
  input_tokens: 0,
  output_tokens: 0,
  reasoning_tokens: 0,
  approval_mode: "default",
  finished: true,
  pending: false,
  ...over,
});

/** Open a project whose editor shows `tl("t0")`, with the chat loaded from its (empty) disk. */
async function openProject(): Promise<void> {
  disk = chatDisk();
  (storeForProject as Any).mockResolvedValue(disk.store);
  useEditor.setState({
    projectId: "p1",
    store: disk.store as Any,
    timeline: tl("t0"),
    reload: vi.fn(async () => {}) as Any,
  });
  await chatState().load("p1");
}

/** One whole turn: the message is sent, the turn's tools leave the editor on `edit`, the turn ends. */
async function say(text: string, edit?: Any): Promise<void> {
  await chatState().send(text);
  if (edit) useEditor.setState({ timeline: edit });
  emit("text", { text: `answer to ${text}` });
  emit("turn_done", sessionState({ context_tokens: 1234 }));
  await flush();
}

const turnIds = () => chatState().turns.map((t) => t.id);
const snapshotFiles = () => new Map(disk.fs.files);

beforeEach(async () => {
  vi.clearAllMocks();
  resetHistoryModeSupport();
  h.runnerUnsent.length = 0;
  h.deps.current = null;
  vi.mocked(replaceTimeline).mockImplementation(async (_store, timeline) => {
    useEditor.setState({ timeline });
    return true;
  });
  __resetJobNotes();
  await openProject();
});

afterEach(() => {
  vi.useRealTimers();
  __resetJobNotes();
});

describe("New chat", () => {
  it("puts the chat away whole and opens an empty one in the same project", async () => {
    await say("make a reel", tl("t1"));
    await say("add captions", tl("t2"));
    const oldId = chatState().transcriptId!;
    const open = openFile();

    expect(await chatState().newChat()).toBe(true);

    const s = chatState();
    expect(s.turns).toEqual([]);
    expect(s.transcriptId).not.toBe(oldId);
    expect(s.session).toMatchObject({ context_tokens: 0, cost_usd: 0 });
    expect(s.providerSnapshot).toBeNull();
    // The old chat is on disk as it was, every checkpoint included.
    const kept = putAwayFile(oldId);
    expect(kept.requests).toEqual(open.requests);
    expect(kept.requests[0].checkpoint.timeline).toEqual(tl("t0"));
    expect(kept.requests[1].checkpoint.timeline_after).toEqual(tl("t2"));
    // The open file now holds the empty chat under its new id.
    expect(openFile()).toMatchObject({ id: s.transcriptId, requests: [] });
    expect(await chatState().listChats()).toEqual([
      { id: oldId, title: "make a reel", updatedAt: expect.any(String) },
    ]);
    // The project is not touched.
    expect(liveTimeline()).toEqual(tl("t2"));
    expect(replaceTimeline).not.toHaveBeenCalled();
  });

  it("keeps the model, effort, mode and what is staged for the next message", async () => {
    await say("first");
    useChat.setState({ model: "gpt-6.1-sol", effort: "low", mode: "autopilot" });
    useChat.setState({ pendingMentions: [{ kind: "playhead", frame: 12 }] as Any });
    await chatState().newChat();
    expect(chatState()).toMatchObject({ model: "gpt-6.1-sol", effort: "low", mode: "autopilot" });
    expect(chatState().pendingMentions).toHaveLength(1);
  });

  it("starts a chat the model knows nothing about: no old results owed, nothing from the old transcript", async () => {
    await chatState().send("generate a clip");
    emit("tool_call", { call_id: "c1", name: "generate_video", arguments: {} }); // never answered
    emit("turn_done", sessionState());
    await flush();
    h.runnerCarried.mockClear();

    await chatState().newChat();
    await chatState().send("hello again");

    // A new conversation has no call outstanding: owing the provider an answer to the old chat's call
    // would be refused ("No tool call found for function call output").
    expect(h.runnerCarried).toHaveBeenLastCalledWith([]);
    const body = await lastRequestBody("hello again");
    expect(body.transcript.requests).toHaveLength(1);
    expect(body.transcript.requests[0].message.text).toContain("hello again");
    expect(JSON.stringify(body)).not.toContain("generate a clip");
  });

  it("the new chat is a chat of its own: what it says is saved apart from the old one", async () => {
    await say("old topic", tl("t1"));
    const oldId = chatState().transcriptId!;
    await chatState().newChat();
    await say("new topic", tl("t2"));
    expect(openFile().requests.map((r: Any) => r.message.text)).toEqual(["new topic"]);
    expect(putAwayFile(oldId).requests.map((r: Any) => r.message.text)).toEqual(["old topic"]);
    expect(openFile().id).not.toBe(oldId);
  });

  it.each([
    ["while the assistant is working", { streaming: true }],
    ["with a tool call waiting for approval", { pending: [{ call_id: "c" }] }],
    ["while the project is closing", { closing: true }],
    ["while another chat is being swapped in", { switching: true }],
  ])("is refused %s, and nothing is written or cleared", async (_name, patch) => {
    await say("keep me");
    const files = snapshotFiles();
    useChat.setState(patch as Any);
    expect(await chatState().newChat()).toBe(false);
    expect(disk.fs.files).toEqual(files);
    expect(chatState().turns).toHaveLength(1);
  });

  it("does nothing in a chat that is already empty", async () => {
    const files = snapshotFiles();
    expect(await chatState().newChat()).toBe(false);
    expect(disk.fs.files).toEqual(files);
    expect(await chatState().listChats()).toEqual([]);
  });

  it("is refused when the editor is not on this project (the chat would be saved into another folder)", async () => {
    await say("hi");
    useEditor.setState({ projectId: "other" });
    expect(await chatState().newChat()).toBe(false);
    expect(chatState().turns).toHaveLength(1);
  });

  it("leaves the chat exactly as it was when the old chat cannot be saved", async () => {
    await say("keep me");
    const id = chatState().transcriptId;
    const files = snapshotFiles();
    disk.fs.failWrite = (p) => p.includes("/chat/sessions/");

    expect(await chatState().newChat()).toBe(false);

    expect(chatState().transcriptId).toBe(id);
    expect(chatState().turns).toHaveLength(1);
    expect(chatState().error).toMatch(/could not be saved/);
    expect(chatState().switching).toBe(false);
    expect(disk.fs.files).toEqual(files);
    // ...and the person can simply carry on.
    disk.fs.failWrite = null;
    await chatState().send("still here");
    expect(h.runnerStart).toHaveBeenLastCalledWith("still here");
  });

  it("loses nothing when the open file cannot be rewritten after the old chat was saved", async () => {
    await say("first", tl("t1"));
    await say("second", tl("t2"));
    const id = chatState().transcriptId!;
    // Fails only AFTER the old chat reached its put-away file: the opposite ordering.
    disk.fs.failWrite = (p) =>
      /\/internals\/transcript(\.tmp-[a-z0-9]+)?\.json$/.test(p) &&
      disk.fs.writes.some((w) => w.includes("/chat/sessions/"));

    expect(await chatState().newChat()).toBe(true); // the screen shows the new chat...

    disk.fs.failWrite = null;
    await chatState().load("p1"); // ...and a restart finds the old one, whole
    expect(chatState().transcriptId).toBe(id);
    expect(chatState().turns).toHaveLength(2);
    expect(putAwayFile(id).requests).toHaveLength(2); // nothing lost either way
    expect(await chatState().listChats()).toEqual([]); // and no duplicate row for the open chat
  });

  describe("while the old chat is being written", () => {
    let release: () => void;
    beforeEach(async () => {
      await say("keep me", tl("t1"));
      const gate = new Promise<void>((r) => (release = r));
      disk.fs.holdWrite = (p) => (p.includes("/chat/sessions/") ? gate : null);
    });

    it("a send is refused rather than landing in the chat on its way out", async () => {
      h.runnerStart.mockClear();
      const pending = chatState().newChat();
      await tick();
      expect(chatState().switching).toBe(true);
      await chatState().send("too early");
      expect(h.runnerStart).not.toHaveBeenCalled();
      expect(chatState().turns).toHaveLength(1); // not appended to the old chat
      release();
      expect(await pending).toBe(true);
      expect(chatState().switching).toBe(false);
      await chatState().send("now");
      expect(h.runnerStart).toHaveBeenLastCalledWith("now");
      expect(chatState().turns.map((t) => t.userText)).toEqual(["now"]);
    });

    it("Continue and Try again are refused too: a turn resumed now would be orphaned by the swap", async () => {
      useChat.setState({ canContinue: true, canRetry: true });
      const pending = chatState().newChat();
      await tick();
      h.runnerContinue.mockClear();
      h.runnerRetry.mockClear();
      await chatState().continueRun();
      await chatState().retry();
      expect(h.runnerContinue).not.toHaveBeenCalled();
      expect(h.runnerRetry).not.toHaveBeenCalled();
      expect(chatState().streaming).toBe(false);
      release();
      expect(await pending).toBe(true);
      expect(chatState().streaming).toBe(false); // not left stuck on
      expect(chatState().canContinue).toBe(false);
    });

    it("a rewind is refused too", async () => {
      const pending = chatState().newChat();
      await tick();
      expect(await chatState().restoreTo(turnIds()[0])).toBeNull();
      await chatState().undo();
      expect(replaceTimeline).not.toHaveBeenCalled();
      release();
      await pending;
    });

    it("a project close that lands meanwhile leaves the chat as it was", async () => {
      const id = chatState().transcriptId;
      const pending = chatState().newChat();
      await tick();
      chatState().quiesce(); // the close begins
      const settled = chatState().whenQuiescent(); // the close's save waits for in-flight ops
      release();
      expect(await pending).toBe(false);
      await settled;
      expect(chatState().transcriptId).toBe(id);
      expect(chatState().turns).toHaveLength(1);
      expect(chatState().closing).toBe(true);
    });

    it("the project being loaded again meanwhile abandons the swap", async () => {
      const id = chatState().transcriptId;
      const pending = chatState().newChat();
      await tick();
      disk.fs.holdWrite = null;
      await chatState().load("p1"); // reads the open file: the old chat
      release();
      expect(await pending).toBe(false);
      expect(chatState().transcriptId).toBe(id);
      expect(chatState().turns).toHaveLength(1);
    });

    it("a finished background job waits for the swap, then is delivered, never lost", async () => {
      vi.useFakeTimers();
      h.runnerStart.mockClear();
      const pending = chatState().newChat();
      await vi.advanceTimersByTimeAsync(0);
      notifyJobSettled(CHAT_DIR, {
        id: "j1",
        tool: "generate_image",
        label: "a still",
        status: "done",
        startedBy: "chat",
        media_refs: ["media_gen_1"],
      });
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.runnerStart).not.toHaveBeenCalled(); // not into a chat mid-swap
      expect(pendingJobNotes(CHAT_DIR)).toHaveLength(1); // and not dropped
      release();
      await vi.advanceTimersByTimeAsync(0);
      await pending;
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.runnerStart).toHaveBeenCalledTimes(1);
      expect(h.runnerStart.mock.calls[0][0]).toContain("media_gen_1");
    });
  });
});

describe("Chat history", () => {
  async function twoChats() {
    await say("first topic", tl("t1"));
    const first = chatState().transcriptId!;
    await chatState().newChat();
    await say("second topic", tl("t2"));
    return { first, second: chatState().transcriptId! };
  }

  it("opens a put-away chat, and puts the one on screen away: neither is lost", async () => {
    const { first, second } = await twoChats();
    const firstRequests = putAwayFile(first).requests;
    const secondRequests = openFile().requests;

    expect(await chatState().openChat(first)).toBe(true);

    expect(chatState().transcriptId).toBe(first);
    expect(chatState().turns.map((t) => t.userText)).toEqual(["first topic"]);
    expect(chatState().turns[0].checkpoint).toEqual(tl("t0")); // its checkpoints came with it
    expect(openFile()).toMatchObject({ id: first });
    expect(openFile().requests).toEqual(firstRequests);
    expect(putAwayFile(second).requests).toEqual(secondRequests);
    // The opened chat is not also listed as put away; the other one is.
    expect((await chatState().listChats()).map((c) => c.id)).toEqual([second]);
    expect(disk.fs.files.has(chatFilePath(CHAT_DIR, first))).toBe(false);

    // And back again: byte-for-byte the same conversations.
    expect(await chatState().openChat(second)).toBe(true);
    expect(openFile().requests).toEqual(secondRequests);
    expect(putAwayFile(first).requests).toEqual(firstRequests);
  });

  it("continues an opened chat where it stopped: its model context is rebuilt, not a stale chain", async () => {
    const { first } = await twoChats();
    await chatState().openChat(first);
    expect(chatState().providerSnapshot).toBeNull();
    await say("one more thing", tl("t3"));
    const body = await lastRequestBody("one more thing");
    const texts = body.transcript.requests.map((r: Any) => r.message.text);
    expect(texts[0]).toContain("first topic");
    expect(texts.at(-1)).toContain("one more thing");
    expect(texts.join("\n")).not.toContain("second topic");
  });

  it("an empty chat on screen is dropped, not put away as an empty entry", async () => {
    // Chats are told apart by the millisecond they were put away. The order asserted below must come from
    // a clock that moves, not from how fast this machine is: two chats put away in the same millisecond
    // would tie and fall back to their random ids.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T10:00:00.000Z"));
    const { first } = await twoChats(); // `first` is put away at 10:00
    vi.setSystemTime(new Date("2026-11-10T11:00:00.000Z"));
    await chatState().newChat(); // `second` is put away at 11:00; an empty chat is now open
    expect((await chatState().listChats()).map((c) => c.title)).toEqual([
      "second topic",
      "first topic",
    ]);
    await chatState().openChat(first);
    expect((await chatState().listChats()).map((c) => c.title)).toEqual(["second topic"]);
  });

  it("a chat that does not read changes nothing", async () => {
    const { first, second } = await twoChats();
    disk.fs.files.set(chatFilePath(CHAT_DIR, first), "{torn");
    const open = disk.fs.files.get(OPEN);

    expect(await chatState().openChat(first)).toBe(false);

    expect(chatState().transcriptId).toBe(second);
    expect(chatState().turns).toHaveLength(1);
    expect(chatState().error).toMatch(/could not be opened/);
    expect(disk.fs.files.get(OPEN)).toBe(open);
    expect(chatState().switching).toBe(false);
  });

  it("opens nothing when the chat on screen cannot be put away first", async () => {
    const { first, second } = await twoChats();
    const files = snapshotFiles();
    disk.fs.failWrite = (p) => p.includes(`/chat/sessions/${second}`);

    expect(await chatState().openChat(first)).toBe(false);

    expect(chatState().transcriptId).toBe(second);
    expect(chatState().turns.map((t) => t.userText)).toEqual(["second topic"]);
    expect(disk.fs.files).toEqual(files); // the put-away chat is still put away
  });

  it("keeps the put-away copy when the open file could not take the chat (no chat is lost)", async () => {
    const { first, second } = await twoChats();
    disk.fs.failWrite = (p) =>
      /\/internals\/transcript(\.tmp-[a-z0-9]+)?\.json$/.test(p) &&
      disk.fs.writes.some((w) => w.includes(`/chat/sessions/${second}`));

    expect(await chatState().openChat(first)).toBe(true);

    expect(disk.fs.files.has(chatFilePath(CHAT_DIR, first))).toBe(true); // not deleted
    disk.fs.failWrite = null;
    await chatState().load("p1"); // a restart: the open file still holds `second`
    expect(chatState().transcriptId).toBe(second);
    expect((await chatState().listChats()).map((c) => c.id)).toEqual([first]);
  });

  it.each([
    ["the open chat itself", () => chatState().transcriptId!],
    ["an id that is a path", () => "../transcript"],
    ["an id nothing was saved under", () => "99999999-9999-4999-8999-999999999999"],
  ])("refuses %s", async (_name, pick) => {
    await twoChats();
    const files = snapshotFiles();
    expect(await chatState().openChat(pick())).toBe(false);
    expect(disk.fs.files.size).toBeGreaterThanOrEqual(files.size); // nothing removed
    expect(chatState().turns).toHaveLength(1);
  });

  it.each([
    ["while the assistant is working", { streaming: true }],
    ["with a tool call waiting", { pending: [{ call_id: "c" }] }],
    ["while the project is closing", { closing: true }],
    ["while another chat is being swapped in", { switching: true }],
  ])("is refused %s", async (_name, patch) => {
    const { first, second } = await twoChats();
    useChat.setState(patch as Any);
    expect(await chatState().openChat(first)).toBe(false);
    expect(chatState().transcriptId).toBe(second);
    expect(disk.fs.files.has(chatFilePath(CHAT_DIR, first))).toBe(true);
  });

  it("deletes a put-away chat, and never the open one or anything else in the project", async () => {
    const { first, second } = await twoChats();
    disk.fs.files.set(joinPath(CHAT_DIR, "internals/timeline.json"), "{}");

    expect(await chatState().deleteChat(second)).toBe(false); // the open chat
    expect(await chatState().deleteChat("../transcript")).toBe(false);
    expect(await chatState().deleteChat("..")).toBe(false);
    expect(openFile().requests).toHaveLength(1);

    expect(await chatState().deleteChat(first)).toBe(true);
    expect(await chatState().listChats()).toEqual([]);
    expect(disk.fs.files.has(joinPath(CHAT_DIR, "internals/timeline.json"))).toBe(true);
    expect(chatState().turns).toHaveLength(1); // the chat on screen is untouched
  });

  it("does not delete while the project is closing or another chat is being swapped in", async () => {
    const { first } = await twoChats();
    useChat.setState({ closing: true });
    expect(await chatState().deleteChat(first)).toBe(false);
    useChat.setState({ closing: false, switching: true });
    expect(await chatState().deleteChat(first)).toBe(false);
    expect(disk.fs.files.has(chatFilePath(CHAT_DIR, first))).toBe(true);
  });

  // The chat's turns are captured when an undo, redo or restore begins and written back when it ends.
  // A swap that began in between would hand those turns to the chat that replaced them.
  describe.each<[string, () => Promise<boolean>]>([
    ["New chat", () => chatState().newChat()],
    ["opening a chat", () => chatState().openChat(putAwayId)],
  ])("%s while a restore is mid-way", (_name, swap) => {
    it("is refused, and the restore lands in the chat it began in", async () => {
      await say("an older topic", tl("a1"));
      putAwayId = chatState().transcriptId!;
      await chatState().newChat();
      await say("one", tl("t1"));
      await say("two", tl("t2"));
      const current = chatState().transcriptId!;
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      vi.mocked(replaceTimeline).mockImplementationOnce(async (_store, timeline) => {
        await held; // the timeline swap has been asked for and has not answered
        useEditor.setState({ timeline });
        return true;
      });
      const restoring = chatState().restoreTo(turnIds()[0]);
      await tick();
      const files = snapshotFiles();

      expect(await swap()).toBe(false);

      expect(chatState().switching).toBe(false);
      expect(disk.fs.files).toEqual(files); // the refused swap wrote nothing
      release();
      expect(await restoring).toMatchObject({ text: "one" });
      // Its work is on the chat that was open when it began: under that id, on screen and on disk.
      expect(chatState().transcriptId).toBe(current);
      expect(chatState().turns.map((t) => Boolean(t.undone))).toEqual([true, true]);
      expect(openFile()).toMatchObject({ id: current });
      expect(openFile().requests.map((r: Any) => r.undone)).toEqual([true, true]);
      // Once it is done the swap goes ahead.
      expect(await swap()).toBe(true);
      expect(chatState().transcriptId).not.toBe(current);
    });
  });
});

let putAwayId = "";

// ── Going back over work made outside the chat ────────────────────────────────────────────────
// A restore, an undo and a redo all replace the timeline with a snapshot this chat took, so all of
// them must ask before replacing work the chat did not make. One conformance table, every member.
type Rewind = "restore" | "undo" | "redo" | "undo_restore";

/** A chat with one turn (t0 -> t1), arranged so `kind` can run, and what it does when it does. */
async function arrange(kind: Rewind) {
  await say("first edit", tl("t1")); // checkpoint t0, ends on t1
  const turnId = turnIds()[0];
  if (kind === "redo") await chatState().undo(); // the screen is back on t0
  if (kind === "undo_restore") await chatState().restoreTo(turnId); // the screen is on t0, one click from t1
  vi.mocked(replaceTimeline).mockClear();
  const act = (opts?: { confirmed?: boolean }): Promise<unknown> => {
    switch (kind) {
      case "restore":
        return chatState().restoreTo(turnId, opts);
      case "undo":
        return chatState().undo(opts);
      case "redo":
        return chatState().redo(opts);
      default:
        return chatState().undoRestore(opts);
    }
  };
  // What it replaces the timeline with.
  const target = { restore: tl("t0"), undo: tl("t0"), redo: tl("t1"), undo_restore: tl("t1") }[
    kind
  ];
  return { act, turnId, target };
}

describe.each<Rewind>(["restore", "undo", "redo", "undo_restore"])(
  "%s over work made outside the chat",
  (kind) => {
    it("goes straight ahead when nothing outside the chat changed the project", async () => {
      const { act, target } = await arrange(kind);
      await act();
      expect(chatState().rewind).toBeNull();
      expect(replaceTimeline).toHaveBeenCalledTimes(1);
      expect(liveTimeline()).toEqual(target);
    });

    it("asks first when the project was changed by hand, and changes nothing until told to", async () => {
      const { act, target } = await arrange(kind);
      const turns = JSON.stringify(chatState().turns);
      useEditor.setState({ timeline: tl("hand-edit") });

      await act();

      expect(chatState().rewind).toMatchObject({ action: kind });
      expect(replaceTimeline).not.toHaveBeenCalled();
      expect(liveTimeline()).toEqual(tl("hand-edit")); // the hand edit is still there
      expect(JSON.stringify(chatState().turns)).toBe(turns);

      await chatState().confirmRewind();

      expect(chatState().rewind).toBeNull();
      expect(replaceTimeline).toHaveBeenCalledTimes(1);
      expect(liveTimeline()).toEqual(target);
    });

    it("keeps the work when the person says no", async () => {
      const { act } = await arrange(kind);
      useEditor.setState({ timeline: tl("hand-edit") });
      await act();
      chatState().cancelRewind();
      expect(chatState().rewind).toBeNull();
      expect(replaceTimeline).not.toHaveBeenCalled();
      expect(liveTimeline()).toEqual(tl("hand-edit"));
    });
  },
);

describe("Restore Checkpoint in a chat that is not the one that last edited the project", () => {
  it("asks before it throws away what another chat did, then restores this chat's own state", async () => {
    await say("trim the intro", tl("a1")); // chat A: t0 -> a1
    const a = chatState().transcriptId!;
    const aTurn = turnIds()[0];
    await chatState().newChat();
    await say("add a title", tl("b1")); // chat B: edits the project on, a1 -> b1

    await chatState().openChat(a);
    const prompt = await chatState().restoreTo(aTurn);

    expect(prompt).toBeNull(); // not yet
    expect(chatState().rewind).toEqual({ action: "restore", turnId: aTurn });
    expect(liveTimeline()).toEqual(tl("b1")); // chat B's work is still on screen

    const handed = await chatState().confirmRewind();

    expect(handed).toEqual({ text: "trim the intro", attachments: [] });
    expect(liveTimeline()).toEqual(tl("t0")); // before chat A's turn
    expect(chatState().turns[0].undone).toBe(true);
    expect(chatState().restored).toMatchObject({ turnId: aTurn, before: tl("b1") });
  });

  it("does not ask a chat that has not been left: its own state is on screen", async () => {
    await say("one", tl("t1"));
    await say("two", tl("t2"));
    expect(await chatState().restoreTo(turnIds()[1])).toEqual({ text: "two", attachments: [] });
    expect(chatState().rewind).toBeNull();
    expect(liveTimeline()).toEqual(tl("t1"));
  });

  it("does not ask when there is no snapshot to compare with (a chat from before checkpoints)", async () => {
    await chatState().send("old chat message");
    emit("turn_done", sessionState());
    useChat.setState({
      turns: chatState().turns.map((t) => ({ ...t, checkpoint: null, timelineAfter: null })),
    });
    expect(await chatState().restoreTo(turnIds()[0])).toMatchObject({ text: "old chat message" });
    expect(chatState().rewind).toBeNull();
  });
});

// ── Undo restore ─────────────────────────────────────────────────────────────────────────────────
describe("Undo restore", () => {
  /** Three turns on t1, t2, t3; the person restores to before the second. */
  async function restored() {
    await say("one", tl("t1"));
    await say("two", tl("t2"));
    await say("three", tl("t3"));
    const ids = turnIds();
    await chatState().restoreTo(ids[1]);
    return ids;
  }

  it("keeps what was on screen and the turns the restore hid, and saves them with the chat", async () => {
    const ids = await restored();
    expect(liveTimeline()).toEqual(tl("t1"));
    expect(chatState().restored).toEqual({
      turnId: ids[1],
      before: tl("t3"),
      hid: [ids[1], ids[2]],
    });
    expect(openFile().restore).toEqual({ turnId: ids[1], before: tl("t3"), hid: [ids[1], ids[2]] });
  });

  it("brings the timeline and the turns back in one step", async () => {
    const ids = await restored();
    expect(await chatState().undoRestore()).toBe(true);
    expect(liveTimeline()).toEqual(tl("t3"));
    expect(chatState().turns.map((t) => Boolean(t.undone))).toEqual([false, false, false]);
    expect(chatState().turns.map((t) => t.id)).toEqual(ids);
    expect(chatState().restored).toBeNull();
    expect(openFile().restore).toBeUndefined();
    expect(openFile().requests.map((r: Any) => r.undone)).toEqual([false, false, false]);
    expect(chatState().session).toMatchObject({ can_undo: true, can_redo: false });
  });

  it("is gone once the next message is sent: the hidden turns are then gone for good", async () => {
    await restored();
    await say("something else", tl("t9"));
    expect(chatState().restored).toBeNull();
    expect(openFile().restore).toBeUndefined();
    expect(await chatState().undoRestore()).toBe(false);
  });

  it.each([
    ["an undo", () => chatState().undo()],
    ["a redo", () => chatState().redo()],
  ])("is gone after %s: the hidden turns no longer line up", async (_name, act) => {
    await restored();
    await act();
    expect(chatState().restored).toBeNull();
    expect(openFile().restore).toBeUndefined();
  });

  it("a second restore replaces it, and undoing that one returns to where the second began", async () => {
    const ids = await restored(); // timeline t1, turns two+three hidden
    await chatState().restoreTo(ids[0]); // further back: timeline t0
    expect(chatState().restored).toEqual({ turnId: ids[0], before: tl("t1"), hid: [ids[0]] });
    await chatState().undoRestore();
    expect(liveTimeline()).toEqual(tl("t1"));
    expect(chatState().turns.map((t) => Boolean(t.undone))).toEqual([false, true, true]);
  });

  it("survives closing and reopening the project", async () => {
    const ids = await restored();
    await chatState().load("p1");
    expect(chatState().restored).toEqual({
      turnId: ids[1],
      before: tl("t3"),
      hid: [ids[1], ids[2]],
    });
    expect(await chatState().undoRestore()).toBe(true);
    expect(liveTimeline()).toEqual(tl("t3"));
  });

  it("travels with the chat when it is put away and opened again", async () => {
    const ids = await restored();
    const id = chatState().transcriptId!;
    await chatState().newChat();
    expect(chatState().restored).toBeNull(); // the new chat has none
    await chatState().openChat(id);
    expect(chatState().restored).toEqual({
      turnId: ids[1],
      before: tl("t3"),
      hid: [ids[1], ids[2]],
    });
    expect(await chatState().undoRestore()).toBe(true);
    expect(liveTimeline()).toEqual(tl("t3"));
  });

  it("is not trusted when the file no longer matches: its turn is not hidden", async () => {
    const ids = await restored();
    const file = openFile();
    file.requests[1].undone = false; // an edit by hand, or another build
    disk.fs.files.set(OPEN, JSON.stringify(file));
    await chatState().load("p1");
    expect(ids).toHaveLength(3);
    expect(chatState().restored).toBeNull();
  });

  it("is not offered when a timeline was replaced but what it replaced is unknown", async () => {
    await say("one", tl("t1"));
    useEditor.setState({ timeline: null });
    await chatState().restoreTo(turnIds()[0]);
    expect(chatState().turns[0].undone).toBe(true);
    expect(chatState().restored).toBeNull(); // nothing could bring the timeline back
  });

  it("never rides along to the model", async () => {
    await restored();
    const body = JSON.stringify(await lastRequestBody("x"));
    expect(body).not.toContain('"restore"');
    expect(body).not.toContain("media_t3"); // the snapshot it holds
  });

  it("is refused while the assistant is working or a chat is being swapped", async () => {
    await restored();
    useChat.setState({ streaming: true });
    expect(await chatState().undoRestore()).toBe(false);
    useChat.setState({ streaming: false, switching: true });
    expect(await chatState().undoRestore()).toBe(false);
    expect(chatState().restored).not.toBeNull();
  });
});

describe("the open chat's file after every operation", () => {
  it("always holds the whole chat: its id, its totals and its turns (an undo used to drop the id)", async () => {
    await say("one", tl("t1"));
    await say("two", tl("t2"));
    const id = chatState().transcriptId!;
    for (const op of [
      () => chatState().undo(),
      () => chatState().redo(),
      () => chatState().restoreTo(turnIds()[1]),
      () => chatState().undoRestore(),
    ]) {
      await op();
      expect(openFile().id).toBe(id);
      expect(openFile().session).toMatchObject({ context_tokens: 1234 });
      expect(openFile().requests).toHaveLength(2);
    }
  });
});
