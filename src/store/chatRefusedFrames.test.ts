// UJ-046: the provider refused a picture and the server named it. The store writes the mark in the transcript, tells the person once,
// and the NEXT request, the one that used to fail the same way again, no longer carries the picture. Driven through the store's own
// events and its real request builder and picture reader (only the network and the disk are faked), so what is checked is what the
// next request really contains, not that a function was called.
import { beforeEach, describe, expect, it, vi } from "vitest";

import fixture from "../api/__fixtures__/refusedFrames.json";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lastDeps: any = null;
vi.mock("../agent/loop", () => ({
  ClientTurnRunner: class {
    pending: unknown = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(deps: any) {
      lastDeps = deps;
    }
    start = async () => {};
    takeUnsentResults = () => [];
    approve = async () => {};
    deny = async () => {};
    continueRun = async () => {};
  },
}));
const held = vi.hoisted(() => ({ store: null as unknown }));
vi.mock("../tools/host", () => ({
  openToolHost: vi.fn((id: string) => ({
    projectId: id,
    ready: Promise.resolve(),
    has: () => false,
    run: vi.fn(async () => ({})),
    store: () => held.store,
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

import { inferRoundStreaming } from "../agent/api";
import { historyFrameRefs } from "../agent/historyFrames";
import { refusedNotice } from "../agent/refusedFrames";
import { ProjectStoreAccess, joinPath, type FsLike } from "../tools/store";
import { resetHistoryModeSupport, useChat } from "./chat";
import { buildRequests, mapRequests, type Turn } from "./chatTranscript";
import { useEditor } from "./editor";
import { persistSessionSoon } from "./transcriptFile";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const emit = (event: string, data: unknown) => lastDeps.emit(event, data);

class MemFs implements FsLike {
  bytes = new Map<string, Uint8Array>();
  async exists(p: string): Promise<boolean> {
    return this.bytes.has(joinPath(p));
  }
  async readTextFile(): Promise<string> {
    throw new Error("ENOENT");
  }
  async writeTextFile(): Promise<void> {}
  async readBytes(p: string): Promise<Uint8Array> {
    const v = this.bytes.get(joinPath(p));
    if (!v) throw new Error("ENOENT");
    return v;
  }
  async mkdir(): Promise<void> {}
}

// The smallest bytes the app's own header check accepts as a picture.
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03,
]);
const DIR = "C:/proj";

function shownBy(callId: string, n: number): Turn["parts"][number] {
  return {
    kind: "tool_result",
    call_id: callId,
    name: "inspect_media",
    model_result: { ok: true },
    frame_refs: Array.from({ length: n }, (_, i) => ({
      path: `f/${callId}_${i}.jpg`,
      caption: `@${i}s`,
    })),
  };
}

function earlier(id: string, parts: Turn["parts"]): Turn {
  return { id, userText: `earlier ${id}`, attachments: [], parts, status: "done" };
}

const ECHO = {
  kind: "text",
  final_text: "ok",
  usage: {},
  provider_snapshot: {},
  history_mode: "client",
};

/** A conversation with two earlier turns that each showed pictures, and a turn that is running now. */
async function conversation() {
  const fs = new MemFs();
  for (const [call, n] of [
    ["a", 3],
    ["b", 2],
  ] as const)
    for (let i = 0; i < n; i++) fs.bytes.set(joinPath(DIR, `f/${call}_${i}.jpg`), JPEG);
  held.store = new ProjectStoreAccess(DIR, fs);
  useEditor.setState({
    projectId: "p1",
    store: { projectDir: DIR, writeProjectText: vi.fn() } as Any,
    timeline: null,
  });
  useChat.setState({ projectId: "p1" });
  await useChat.getState().send("go");
  useChat.setState((s) => ({
    turns: [earlier("t1", [shownBy("a", 3)]), earlier("t2", [shownBy("b", 2)]), ...s.turns],
  }));
  (persistSessionSoon as Any).mockClear(); // what the setup itself saved is not what is being checked
}

/** What the next request carries: the pictures it re-sends and the transcript it states. */
async function nextRequest() {
  (inferRoundStreaming as Any).mockResolvedValue(ECHO);
  await lastDeps.infer({ user_text: "x" }, []);
  const body = (inferRoundStreaming as Any).mock.calls.at(-1)[0];
  return {
    sent: (body.history_frames as Array<{ call_id: string; index: number }>).map(
      (f) => `${f.call_id}#${f.index}`,
    ),
    refs: (callId: string) =>
      (body.transcript.requests.flatMap((r: Any) => r.response) as Any[]).find(
        (p) => p.kind === "tool_result" && p.call_id === callId,
      ).frame_refs as Array<Record<string, unknown>>,
    parts: body.transcript.requests.flatMap((r: Any) => r.response) as Array<
      Record<string, unknown>
    >,
  };
}

const noticesOf = () =>
  useChat
    .getState()
    .turns.flatMap((t) => t.parts)
    .filter((p) => p.kind === "notice");

beforeEach(() => {
  vi.clearAllMocks();
  lastDeps = null;
  held.store = null;
  resetHistoryModeSupport();
  useChat.setState({
    projectId: null,
    turns: [],
    session: null,
    providerSnapshot: null,
    streaming: false,
    pending: null,
    closing: false,
    error: null,
    model: "gpt-5.4",
    effort: "high",
    mode: "default",
  });
  useEditor.setState({ projectId: null, store: null, timeline: null });
});

describe("pictures the provider refused", () => {
  it("are marked in an OLDER turn, and the next request no longer carries them", async () => {
    await conversation();
    const before = await nextRequest();
    expect(before.sent).toEqual(["a#0", "a#1", "a#2", "b#0", "b#1"]);

    emit("frames_refused", { frames: [{ call_id: "a", index: 1 }] });
    const after = await nextRequest();

    // the artifact, before and after: the same request, minus exactly the refused picture
    expect(after.sent).toEqual(["a#0", "a#2", "b#0", "b#1"]);
    // and the transcript the server rebuilds the history from says which one it was, so the model is told it was left out
    expect(after.refs("a").map((r) => r.refused === true)).toEqual([false, true, false]);
    expect(after.refs("a")[1]).toEqual({ path: "f/a_1.jpg", caption: "@1s", refused: true });
    expect(after.refs("b").some((r) => "refused" in r)).toBe(false);
  });

  it("are told to the person once, in plain words, on the turn that is running", async () => {
    await conversation();
    emit("frames_refused", { frames: [{ call_id: "a", index: 1 }] });
    expect(noticesOf()).toEqual([
      { kind: "notice", code: "frames_refused", text: refusedNotice(1) },
    ]);
    const last = useChat.getState().turns.at(-1)!;
    expect(last.parts.at(-1)).toMatchObject({ kind: "notice" });
    expect(
      useChat
        .getState()
        .turns.slice(0, -1)
        .flatMap((t) => t.parts)
        .some((p) => p.kind === "notice"),
    ).toBe(false);
  });

  it("are counted by what was marked now: two pictures from two turns are one notice that says two", async () => {
    await conversation();
    emit("frames_refused", {
      frames: [
        { call_id: "a", index: 0 },
        { call_id: "b", index: 1 },
      ],
    });
    expect(noticesOf().map((n) => n.text)).toEqual([refusedNotice(2)]);
    expect((await nextRequest()).sent).toEqual(["a#1", "a#2", "b#0"]);
  });

  it("naming them again says nothing more and changes nothing", async () => {
    await conversation();
    emit("frames_refused", { frames: [{ call_id: "a", index: 1 }] });
    const turnsAfterOne = useChat.getState().turns;
    emit("frames_refused", { frames: [{ call_id: "a", index: 1 }] });
    expect(noticesOf()).toHaveLength(1);
    expect(useChat.getState().turns).toBe(turnsAfterOne);
  });

  it("naming one more later adds a notice for that one only", async () => {
    await conversation();
    emit("frames_refused", { frames: [{ call_id: "a", index: 1 }] });
    emit("frames_refused", {
      frames: [
        { call_id: "a", index: 1 },
        { call_id: "b", index: 0 },
      ],
    });
    expect(noticesOf().map((n) => n.text)).toEqual([refusedNotice(1), refusedNotice(1)]);
    expect((await nextRequest()).sent).toEqual(["a#0", "a#2", "b#1"]);
  });

  it.each([
    ["a call that is not in the conversation", [{ call_id: "zzz", index: 0 }]],
    ["a place past the frames of that call", [{ call_id: "a", index: 9 }]],
    ["nothing at all", []],
    ["something that is not a list", "a#1"],
    ["names that are not names", [{ call_id: 4, index: "x" }, null]],
  ])("naming %s changes nothing and says nothing", async (_what, frames) => {
    await conversation();
    const turns = useChat.getState().turns;
    emit("frames_refused", { frames });
    expect(useChat.getState().turns).toBe(turns);
    expect(persistSessionSoon).not.toHaveBeenCalled();
    expect((await nextRequest()).sent).toEqual(["a#0", "a#1", "a#2", "b#0", "b#1"]);
  });

  it("are saved with the conversation, so they stay out after a restart", async () => {
    await conversation();
    emit("frames_refused", { frames: [{ call_id: "a", index: 1 }] });
    const saved = (persistSessionSoon as Any).mock.calls.at(-1)[1].requests;
    expect(saved[0].response[0].frame_refs[1]).toMatchObject({ refused: true });

    // what a restart reads back from that file is the same conversation, and still leaves the picture out
    const reloaded = mapRequests(JSON.parse(JSON.stringify(saved)));
    expect(historyFrameRefs(reloaded).map((r) => `${r.call_id}#${r.index}`)).toEqual([
      "a#0",
      "a#2",
      "b#0",
      "b#1",
    ]);
  });

  it("do not change how a failed turn ends: it is still an error, also after a restart", async () => {
    await conversation();
    emit("frames_refused", { frames: [{ call_id: "a", index: 1 }] });
    emit("error", { error: "Our own sentence.", error_code: "content_policy" });
    const failed = useChat.getState().turns.at(-1)!;
    expect(failed.status).toBe("error");
    expect(failed.parts.at(-1)).toMatchObject({ kind: "error" });
    // the notice comes before the error, so the error is still the turn's last part when the file is read back
    expect(mapRequests(buildRequests([failed]))[0].status).toBe("error");
  });

  it("do not change how an answered turn ends: it is still done", async () => {
    await conversation();
    emit("frames_refused", { frames: [{ call_id: "a", index: 1 }] });
    emit("text", { text: "Here you go." });
    emit("turn_done", { cost_usd: 0 });
    expect(useChat.getState().turns.at(-1)!.status).toBe("done");
  });

  it("are not written by a turn that was retired: a stale turn cannot change the conversation", async () => {
    await conversation();
    const stale = lastDeps;
    useChat.setState({ streaming: false });
    await useChat.getState().send("another message"); // retires the turn the first deps belong to
    expect(lastDeps).not.toBe(stale);
    const turns = useChat.getState().turns;
    stale.emit("frames_refused", { frames: [{ call_id: "a", index: 1 }] });
    expect(useChat.getState().turns).toBe(turns);
    expect(noticesOf()).toEqual([]);
  });
});

describe("the shared fixture (held to the server's own tests)", () => {
  it("marks the conversation the fixture describes exactly as the fixture says, and the notice follows", async () => {
    await conversation();
    useChat.setState((s) => ({
      turns: [
        earlier("t0", [structuredClone(fixture.transcript_before) as Turn["parts"][number]]),
        ...s.turns,
      ],
    }));
    emit("frames_refused", { frames: fixture.round_result.refused_frames });
    expect(useChat.getState().turns[0].parts[0]).toEqual(fixture.transcript_after);
    expect(noticesOf()).toHaveLength(1);
  });
});
