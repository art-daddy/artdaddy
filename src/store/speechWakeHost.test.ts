// The wake for words, end to end below the chat: the registry, the host with its guards, and the completion queue that
// delivers (jobNotes). What is asserted is what the person and the assistant would see: which wakes were delivered, to
// whom, when, naming what; what the card says; and what is left on this PC. Only the clock, the credit balance and the
// chat's own state (a sink that is always idle) are replaced.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const usage = vi.hoisted(() => ({ over: false, listeners: new Set<() => void>() }));
vi.mock("../api/usage", () => ({
  getUsage: () => ({ metered: true, used: 0, limit: 0, remaining: 0, over: usage.over }),
  subscribeUsage: (fn: () => void) => {
    usage.listeners.add(fn);
    return () => usage.listeners.delete(fn);
  },
}));

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { clearFacts, readFacts, WAKE_FACT_EVENTS } from "../lib/localFacts";
import type { ClientToolContext } from "../tools/context";
import { SpeechCancelledError, TranscriptionFailure } from "../tools/speechFailure";
import { __resetComposer, useComposer } from "./composer";
import {
  __resetJobNotes,
  pendingJobNotes,
  registerJobSink,
  SETTLE_WINDOW_MS,
  unregisterJobSink,
  type SettledJob,
} from "./jobNotes";
import {
  __resetWakeHost,
  admitWordsWake,
  dismissWakeNote,
  NOTE_SHOWN_MS,
  noteWordsFetched,
  registerCachedWords,
  registerPendingWords,
  wakeBeginTurn,
  wakeDropChat,
  wakeEndTurn,
  wakeTargetOf,
  wakeViewOf,
  WAKE_CAP_PER_HOUR,
  WAKE_COOL_DOWN_MS,
  type Settled,
} from "./speechWakeHost";

const DIR = "C:/projects/a";
const SESSION = "chat-1";
const CHAT = { dir: DIR, session: SESSION };
const MIN = 60_000;
const START = 1_700_000_000_000;
const HOUR_PAST_THE_FIRST = 70 * MIN;

const ctxOf = (
  exec: number,
  over: Record<string, unknown> = {},
  session: string = SESSION,
): ClientToolContext =>
  ({
    store: { projectDir: DIR },
    runner: {},
    origin: { chatSessionId: session, branchId: 0, executionId: exec },
    ...over,
  }) as unknown as ClientToolContext;

/** One run of the speech engine that the test ends when it wants. */
function run() {
  let resolve!: (s: Settled) => void;
  const promise = new Promise<Settled>((r) => (resolve = r));
  return {
    promise,
    land: () => resolve({ ok: true }),
    fail: (error: unknown) => resolve({ ok: false, error }),
  };
}
type Run = ReturnType<typeof run>;

/** A chat that is always idle and asks the host, as chat.ts does, before it takes a wake. */
function chatSink(session: string | null = SESSION) {
  const deliveries: SettledJob[][] = [];
  const sink = {
    isIdle: () => true,
    deliver: (jobs: SettledJob[]) => deliveries.push(jobs),
    admit: (job: SettledJob) => admitWordsWake(DIR, session, job),
    deliveries,
    words: () => deliveries.flat().filter((j) => j.kind === "words"),
  };
  return sink;
}

/** A turn in which the assistant looked at `names` and was told "not ready", and then handed back. */
function turn(
  exec: number,
  names: string[],
  how: "done" | "stopped" | "error" | "abandoned" = "done",
  session: string = SESSION,
) {
  const chat = { dir: DIR, session };
  wakeBeginTurn(chat, exec, false);
  const runs = new Map<string, Run>();
  for (const name of names) {
    const r = run();
    runs.set(name, r);
    const target = wakeTargetOf(ctxOf(exec, {}, session), `src-${name}`, name);
    if (!target) throw new Error("no wake target: the switch is off or the caller cannot be woken");
    registerPendingWords(target, `${exec}-${name}`, 30, r.promise);
  }
  wakeEndTurn(chat, exec, how);
  return runs;
}

const settle = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};
/** All the words of a turn land; the settling window closes. */
async function landAll(runs: Map<string, Run>): Promise<void> {
  for (const r of runs.values()) r.land();
  await settle(SETTLE_WINDOW_MS + 10);
}
const facts = (): string[] => readFacts("speech_wake").map((f) => f.event);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  localStorage.clear();
  usage.over = false;
  usage.listeners.clear();
  __resetWakeHost();
  __resetJobNotes();
  __resetExportFlags();
  __resetComposer();
});
afterEach(() => {
  __resetWakeHost();
  __resetJobNotes();
  vi.useRealTimers();
  clearFacts();
});

describe("a wake for the words of files the assistant was told were not ready", () => {
  it("comes once, after the LAST file landed, and names the files that landed", async () => {
    const sink = chatSink();
    registerJobSink(DIR, sink);
    const runs = turn(1, ["m_1", "m_2", "m_3"]);
    runs.get("m_1")!.land();
    runs.get("m_2")!.land();
    await settle(SETTLE_WINDOW_MS + 10);
    expect(sink.words(), "two of three: nothing yet").toEqual([]);

    runs.get("m_3")!.land();
    await settle(SETTLE_WINDOW_MS + 10);
    expect(sink.words()).toHaveLength(1);
    expect(sink.words()[0]).toMatchObject({
      kind: "words",
      startedBy: "chat",
      status: "done",
      label: "the words of 3 files",
      media_refs: ["m_1", "m_2", "m_3"],
    });
    await settle(10 * MIN);
    expect(sink.words(), "never a second one").toHaveLength(1);
    expect(facts()).toEqual(["registered", "released", "landed", "woke"]);
  });

  it("names one file in the singular, and never a path", async () => {
    const sink = chatSink();
    registerJobSink(DIR, sink);
    wakeBeginTurn(CHAT, 1, false);
    const a = run();
    const b = run();
    registerPendingWords(wakeTargetOf(ctxOf(1), "src-a", "C:/Users/me/a.wav")!, "a", 30, a.promise);
    registerPendingWords(wakeTargetOf(ctxOf(1), "src-b", "m_2")!, "b", 30, b.promise);
    wakeEndTurn(CHAT, 1, "done");
    a.land();
    b.land();
    await settle(SETTLE_WINDOW_MS + 10);
    expect(sink.words()[0].label).toBe("the words of 2 files");
    expect(sink.words()[0].media_refs, "a filesystem path is no way to name a file").toEqual([
      "m_2",
    ]);
  });

  it("is not sent while the turn that asked is still running", async () => {
    const sink = chatSink();
    registerJobSink(DIR, sink);
    wakeBeginTurn(CHAT, 1, false);
    const a = run();
    registerPendingWords(wakeTargetOf(ctxOf(1), "src-a", "m_1")!, "a", 30, a.promise);
    a.land();
    await settle(SETTLE_WINDOW_MS + 10);
    expect(sink.words()).toEqual([]);
    wakeEndTurn(CHAT, 1, "done");
    await settle(SETTLE_WINDOW_MS + 10);
    expect(sink.words()).toHaveLength(1);
  });

  it.each(["stopped", "error", "abandoned"] as const)(
    "is never sent for a turn that ended by %s: the person took over, and the run's end changes nothing",
    async (how) => {
      const sink = chatSink();
      registerJobSink(DIR, sink);
      const runs = turn(1, ["m_1", "m_2"], how);
      await landAll(runs);
      await settle(40 * MIN);
      expect(sink.words()).toEqual([]);
      expect(pendingJobNotes(DIR)).toEqual([]);
      expect(wakeViewOf(CHAT).ready).toBeNull();
    },
  );

  it("is not asked for by an answer of a turn that is no longer the live one", async () => {
    const sink = chatSink();
    registerJobSink(DIR, sink);
    wakeBeginTurn(CHAT, 1, false);
    wakeBeginTurn(CHAT, 2, false); // the person sent another message: turn 1 was left behind
    const late = run();
    registerPendingWords(wakeTargetOf(ctxOf(1), "src-a", "m_1")!, "a", 30, late.promise);
    wakeEndTurn(CHAT, 2, "done");
    late.land();
    await settle(SETTLE_WINDOW_MS + 10);
    expect(sink.words()).toEqual([]);
    expect(wakeViewOf(CHAT).total).toBe(0);
  });

  it("does not come for words the assistant has read since: the person asked, or a later look found them", async () => {
    const sink = chatSink();
    registerJobSink(DIR, sink);
    const runs = turn(1, ["m_1", "m_2", "m_3"]);
    runs.get("m_1")!.land();
    runs.get("m_2")!.land();
    // The person said "continue" and the assistant read two of them from the cache.
    noteWordsFetched(ctxOf(2), "src-m_1");
    noteWordsFetched(ctxOf(2), "src-m_2");
    runs.get("m_3")!.land();
    await settle(SETTLE_WINDOW_MS + 10);
    expect(sink.words()).toHaveLength(1);
    expect(sink.words()[0]).toMatchObject({ label: "the words of 1 file", media_refs: ["m_3"] });

    const second = turn(5, ["m_4"]);
    noteWordsFetched(ctxOf(6), "src-m_4"); // read before it landed on the wake's own account
    second.get("m_4")!.land();
    await settle(SETTLE_WINDOW_MS + 10);
    expect(sink.words(), "nothing was left to say").toHaveLength(1);
  });

  it("is dropped at the moment of delivery when the person read the words in the meantime", async () => {
    const sink = chatSink();
    registerJobSink(DIR, sink);
    usage.over = true; // held for credits, so that the reading can come after the release
    const runs = turn(1, ["m_1"]);
    await landAll(runs);
    expect(pendingJobNotes(DIR)).toHaveLength(1);
    noteWordsFetched(ctxOf(2), "src-m_1");
    usage.over = false;
    usage.listeners.forEach((fn) => fn());
    expect(sink.words()).toEqual([]);
    expect(pendingJobNotes(DIR)).toEqual([]);
    expect(facts()).toContain("skipped_fetched");
  });

  it("does not count a read of another stretch of the same file: the clip that had its words says nothing of the others", async () => {
    const sink = chatSink();
    registerJobSink(DIR, sink);
    wakeBeginTurn(CHAT, 1, false);
    const later = run();
    registerPendingWords(
      wakeTargetOf(ctxOf(1), "talk.mp4", "c2", { start: 600, end: 612 })!,
      "c2",
      12,
      later.promise,
    );
    wakeEndTurn(CHAT, 1, "done");
    noteWordsFetched(ctxOf(1), "talk.mp4", { start: 59, end: 76 }); // c1's words, in the same call
    later.land();
    await settle(SETTLE_WINDOW_MS + 10);
    expect(sink.words()).toHaveLength(1);
    expect(sink.words()[0].media_refs).toEqual(["c2"]);

    // Whereas the whole file read covers it.
    const second = turn(5, ["m_5"]);
    noteWordsFetched(ctxOf(6), "src-m_5"); // no stretch: the whole file
    second.get("m_5")!.land();
    await settle(SETTLE_WINDOW_MS + 10);
    expect(sink.words()).toHaveLength(1);
  });

  it("does not count an outside agent's read of a file as the assistant's: only the chat's own reads count", async () => {
    const sink = chatSink();
    registerJobSink(DIR, sink);
    const runs = turn(1, ["m_1"]);
    noteWordsFetched({ store: { projectDir: DIR } } as unknown as ClientToolContext, "src-m_1"); // no origin: MCP
    await landAll(runs);
    expect(sink.words()).toHaveLength(1);
  });
});

describe("who can be promised a wake", () => {
  it("is the chat that asked, and nobody else", () => {
    expect(wakeTargetOf(ctxOf(3), "src", "m_1")).toEqual({
      dir: DIR,
      session: SESSION,
      exec: 3,
      source: "src",
      ref: "m_1",
      window: null,
    });
    expect(wakeTargetOf(ctxOf(3), "src", "m_1", { start: 5, end: 9 })?.window).toEqual({
      start: 5,
      end: 9,
    });
    expect(wakeTargetOf(ctxOf(3, { surface: "mcp" }), "src", "m_1"), "an outside agent").toBeNull();
    expect(wakeTargetOf(ctxOf(3, { background: true }), "src", "m_1"), "the indexer").toBeNull();
    expect(wakeTargetOf(ctxOf(3, { origin: undefined }), "src", "m_1"), "no chat").toBeNull();
    expect(
      wakeTargetOf(
        ctxOf(3, { origin: { chatSessionId: "", branchId: 0, executionId: 3 } }),
        "src",
        "m_1",
      ),
    ).toBeNull();
  });

  it("is nobody while the switch is off, and a wake released before it was turned off is dropped", async () => {
    __setExportFlag("speech_wake", false);
    expect(wakeTargetOf(ctxOf(3), "src", "m_1")).toBeNull();

    __setExportFlag("speech_wake", true);
    const sink = chatSink();
    registerJobSink(DIR, sink);
    const runs = turn(1, ["m_1"]);
    usage.over = true;
    await landAll(runs);
    __setExportFlag("speech_wake", false);
    usage.over = false;
    usage.listeners.forEach((fn) => fn());
    expect(sink.words()).toEqual([]);
    expect(pendingJobNotes(DIR)).toEqual([]);
    expect(facts()).toContain("flag_off");
  });

  it("names a file by a safe reference only", () => {
    expect(wakeTargetOf(ctxOf(1), "src", "C:/Users/me/a.wav")?.ref).toBeNull();
    expect(wakeTargetOf(ctxOf(1), "src", "../up.wav")?.ref).toBeNull();
    expect(wakeTargetOf(ctxOf(1), "src", "  ")?.ref).toBeNull();
    expect(wakeTargetOf(ctxOf(1), "src", null)?.ref).toBeNull();
    expect(wakeTargetOf(ctxOf(1), "src", " m_9 ")?.ref).toBe("m_9");
  });
});

describe("the person is typing", () => {
  it("holds the wake while there is a draft, and sends it once, when the draft is sent or cleared", async () => {
    const sink = chatSink();
    registerJobSink(DIR, sink);
    useComposer.getState().setDraft(true);
    await landAll(turn(1, ["m_1", "m_2"]));
    expect(sink.words()).toEqual([]);
    expect(pendingJobNotes(DIR), "kept, not dropped").toHaveLength(1);
    expect(wakeViewOf(CHAT).ready).toEqual({ files: 2, held: "typing" });

    await settle(10 * MIN);
    expect(sink.words(), "a draft that stays holds it as long as it stays").toEqual([]);

    useComposer.getState().setDraft(false);
    expect(sink.words()).toHaveLength(1);
    expect(wakeViewOf(CHAT).ready, "delivered: nothing left to say on the card").toBeNull();
    expect(facts().filter((f) => f === "held_typing")).toEqual(["held_typing"]);
  });

  it("drops it instead when the draft was sent and the assistant read the words in that turn", async () => {
    const sink = chatSink();
    registerJobSink(DIR, sink);
    useComposer.getState().setDraft(true);
    await landAll(turn(1, ["m_1"]));
    noteWordsFetched(ctxOf(2), "src-m_1"); // the person's message made the assistant look
    useComposer.getState().setDraft(false);
    expect(sink.words()).toEqual([]);
    expect(pendingJobNotes(DIR)).toEqual([]);
  });
});

describe("the account is out of credits", () => {
  it("holds the wake, says so, and sends it when credits are back", async () => {
    const sink = chatSink();
    registerJobSink(DIR, sink);
    usage.over = true;
    await landAll(turn(1, ["m_1"]));
    await settle(10 * MIN);
    expect(sink.words()).toEqual([]);
    expect(wakeViewOf(CHAT).ready).toEqual({ files: 1, held: "credits" });

    usage.over = false;
    usage.listeners.forEach((fn) => fn());
    expect(sink.words()).toHaveLength(1);
    expect(facts().filter((f) => f === "no_credits")).toHaveLength(1);
  });
});

describe("a chat that is not the one that was told", () => {
  it("is not woken in its place: a new chat, or another chat of the project, gets nothing", async () => {
    const other = chatSink("chat-2");
    registerJobSink(DIR, other);
    await landAll(turn(1, ["m_1"]));
    expect(other.words()).toEqual([]);
    expect(pendingJobNotes(DIR)).toEqual([]);
    expect(facts()).toContain("dropped");
  });

  it("survives a project that was closed while the words were made: the wake comes when it is open again", async () => {
    const closed = chatSink();
    registerJobSink(DIR, closed);
    const runs = turn(1, ["m_1"]);
    unregisterJobSink(DIR); // the person closed the project
    await landAll(runs);
    expect(closed.words()).toEqual([]);
    expect(pendingJobNotes(DIR)).toHaveLength(1);

    const reopened = chatSink();
    registerJobSink(DIR, reopened); // the same chat, loaded again
    expect(reopened.words()).toHaveLength(1);
  });

  it("is forgotten when its chat is put away", async () => {
    const sink = chatSink();
    registerJobSink(DIR, sink);
    const runs = turn(1, ["m_1", "m_2"]);
    wakeDropChat(DIR, SESSION);
    await landAll(runs);
    expect(sink.words()).toEqual([]);
    expect(wakeViewOf(CHAT)).toMatchObject({ total: 0, ready: null });
  });
});

describe("how often", () => {
  it("waits a minute after a wake before the next, and then sends it without being asked again", async () => {
    const sink = chatSink();
    registerJobSink(DIR, sink);
    await landAll(turn(1, ["m_1"]));
    expect(sink.words()).toHaveLength(1);

    await settle(10_000);
    await landAll(turn(2, ["m_2"]));
    expect(sink.words(), "10 s after the last: held").toHaveLength(1);
    expect(wakeViewOf(CHAT).ready).toEqual({ files: 1, held: null });

    await settle(WAKE_COOL_DOWN_MS);
    expect(sink.words(), "a minute after the first").toHaveLength(2);
  });

  it(`sends at most ${WAKE_CAP_PER_HOUR} an hour to one chat, tells the person, and starts nothing past that`, async () => {
    const sink = chatSink();
    registerJobSink(DIR, sink);
    for (let i = 1; i <= WAKE_CAP_PER_HOUR; i++) {
      await landAll(turn(i, [`m_${i}`]));
      await settle(WAKE_COOL_DOWN_MS);
    }
    expect(sink.words()).toHaveLength(WAKE_CAP_PER_HOUR);

    const over = turn(50, ["m_over"]);
    await landAll(over);
    await settle(10 * MIN);
    expect(sink.words(), "the sixth is not sent").toHaveLength(WAKE_CAP_PER_HOUR);
    expect(pendingJobNotes(DIR), "and not kept to be sent later").toEqual([]);
    expect(wakeViewOf(CHAT).ready).toEqual({ files: 1, held: "capped" });
    expect(facts()).toContain("capped");

    // The assistant speaks again (the person asked it to carry on): that note is done with.
    wakeBeginTurn(CHAT, 60, false);
    wakeEndTurn(CHAT, 60, "done");
    expect(wakeViewOf(CHAT).ready).toBeNull();

    await settle(HOUR_PAST_THE_FIRST);
    await landAll(turn(70, ["m_later"]));
    expect(sink.words(), "an hour on, the cap has room").toHaveLength(WAKE_CAP_PER_HOUR + 1);
  });

  it("counts the cap per chat: a second chat of the project has a cap of its own", async () => {
    const first = chatSink();
    registerJobSink(DIR, first);
    for (let i = 1; i <= WAKE_CAP_PER_HOUR; i++) {
      await landAll(turn(i, [`m_${i}`]));
      await settle(WAKE_COOL_DOWN_MS);
    }
    expect(first.words()).toHaveLength(WAKE_CAP_PER_HOUR);

    // The person opened another chat of the project: its sink is the one attached now.
    const second = chatSink("chat-2");
    registerJobSink(DIR, second);
    await landAll(turn(70, ["m_x"], "done", "chat-2"));
    expect(second.words()).toHaveLength(1);
  });
});

describe("what cannot be made", () => {
  it("is a plain note, never a wake, and a person's own Cancel is not even a note", async () => {
    const sink = chatSink();
    registerJobSink(DIR, sink);
    const runs = turn(1, ["m_1", "m_2", "m_3", "m_4"]);
    runs.get("m_1")!.fail(new TranscriptionFailure("engine_failed", "whisper boom"));
    runs.get("m_2")!.fail(new TranscriptionFailure("engine_failed", "whisper boom"));
    runs.get("m_3")!.fail(new SpeechCancelledError());
    runs.get("m_4")!.fail(new TranscriptionFailure("model_unavailable", "no model"));
    await settle(SETTLE_WINDOW_MS + 10);
    expect(sink.words()).toEqual([]);
    expect(wakeViewOf(CHAT).notes.map(({ kind, count }) => ({ kind, count }))).toEqual([
      { kind: "engine_failed", count: 2 },
    ]);
  });

  it("wakes for the files that did land, and puts the plain note beside it", async () => {
    const sink = chatSink();
    registerJobSink(DIR, sink);
    const runs = turn(1, ["m_1", "m_2"]);
    runs.get("m_1")!.land();
    runs.get("m_2")!.fail(new TranscriptionFailure("audio_extraction_failed", "unreadable"));
    await settle(SETTLE_WINDOW_MS + 10);
    expect(sink.words()).toHaveLength(1);
    expect(sink.words()[0].media_refs).toEqual(["m_1"]);
    expect(wakeViewOf(CHAT).notes[0]).toMatchObject({ kind: "audio_extraction_failed", count: 1 });
  });

  it("gives up on a file that never settles after 30 minutes without new words, and wakes for the rest", async () => {
    const sink = chatSink();
    registerJobSink(DIR, sink);
    const runs = turn(1, ["m_1", "m_2"]);
    runs.get("m_1")!.land();
    await settle(29 * MIN);
    expect(sink.words()).toEqual([]);
    await settle(2 * MIN + SETTLE_WINDOW_MS);
    expect(sink.words()).toHaveLength(1);
    expect(sink.words()[0].media_refs).toEqual(["m_1"]);
    expect(wakeViewOf(CHAT).notes.map((n) => n.kind)).toEqual(["expired"]);
    expect(facts()).toContain("expired");
  });
});

describe("the card's view", () => {
  it("counts the files still waited for and the ones that landed, and forgets them once released", async () => {
    const sink = chatSink();
    registerJobSink(DIR, sink);
    usage.over = true; // so that the release stays on the card
    const runs = turn(1, ["m_1", "m_2", "m_3"]);
    expect(wakeViewOf(CHAT)).toMatchObject({ total: 3, done: 0, ready: null });
    expect(wakeViewOf(CHAT).pending.map((e) => e.ref)).toEqual(["m_1", "m_2", "m_3"]);
    runs.get("m_1")!.land();
    await settle(0);
    expect(wakeViewOf(CHAT)).toMatchObject({ total: 3, done: 1 });
    runs.get("m_2")!.land();
    runs.get("m_3")!.land();
    await settle(0);
    expect(wakeViewOf(CHAT)).toMatchObject({ total: 0, ready: { files: 3, held: "credits" } });
  });

  it("is one chat's: another chat of the project sees nothing of it", async () => {
    registerJobSink(DIR, chatSink());
    turn(1, ["m_1"]);
    expect(wakeViewOf({ dir: DIR, session: "chat-2" })).toMatchObject({ total: 0, ready: null });
    expect(
      wakeViewOf({ dir: "C:\\projects\\a", session: SESSION }).total,
      "one folder, two spellings",
    ).toBe(1);
  });

  it("keeps a plain note until it is dismissed, the person's next message, or ten minutes", async () => {
    registerJobSink(DIR, chatSink());
    const fail = () => new TranscriptionFailure("engine_failed", "boom");
    const note = async (exec: number) => {
      const runs = turn(exec, [`m_${exec}`]);
      runs.get(`m_${exec}`)!.fail(fail());
      await settle(0);
    };
    await note(1);
    const [first] = wakeViewOf(CHAT).notes;
    expect(first).toMatchObject({ kind: "engine_failed", count: 1 });
    dismissWakeNote(CHAT, first.id);
    expect(wakeViewOf(CHAT).notes).toEqual([]);

    await note(2);
    wakeBeginTurn(CHAT, 3, true); // the app's own turn: the note stays
    expect(wakeViewOf(CHAT).notes).toHaveLength(1);
    wakeBeginTurn(CHAT, 4, false); // the person's message
    expect(wakeViewOf(CHAT).notes).toEqual([]);

    await note(5);
    await settle(NOTE_SHOWN_MS + 1);
    expect(wakeViewOf(CHAT).notes).toEqual([]);
  });
});

describe("words that come from the project's own queue, with no run to wait for", () => {
  it("land when the cache says so, and stop being looked for when nobody waits for them", async () => {
    const sink = chatSink();
    registerJobSink(DIR, sink);
    wakeBeginTurn(CHAT, 1, false);
    let cached = false;
    const probe = vi.fn(async () => cached);
    registerCachedWords(wakeTargetOf(ctxOf(1), "src-q", "m_q")!, "q", 30, probe, 5_000);
    wakeEndTurn(CHAT, 1, "done");
    await settle(20_000);
    expect(sink.words()).toEqual([]);
    expect(probe).toHaveBeenCalledTimes(4);
    cached = true;
    await settle(5_000 + SETTLE_WINDOW_MS + 10);
    expect(sink.words()).toHaveLength(1);
    const calls = probe.mock.calls.length;
    await settle(60_000);
    expect(probe.mock.calls.length, "no more looking once it landed").toBe(calls);

    // A file the person read meanwhile is no longer waited for, so nothing keeps looking at the cache for it.
    wakeBeginTurn(CHAT, 2, false);
    const other = vi.fn(async () => false);
    registerCachedWords(wakeTargetOf(ctxOf(2), "src-r", "m_r")!, "r", 30, other, 5_000);
    wakeEndTurn(CHAT, 2, "done");
    noteWordsFetched(ctxOf(3), "src-r");
    await settle(30_000);
    expect(other.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe("what is kept about it on this PC", () => {
  it("is closed words and a band, and no name, no path and no reference", async () => {
    const sink = chatSink();
    registerJobSink(DIR, sink);
    await landAll(turn(1, ["secret-name-m_1", "m_2"]));
    const stored = localStorage.getItem("artdaddy.local_facts.v1") ?? "";
    expect(stored).not.toContain("secret-name");
    expect(stored).not.toContain("src-");
    expect(stored).not.toContain("C:/");
    for (const fact of readFacts("speech_wake")) {
      expect(WAKE_FACT_EVENTS).toContain(fact.event);
      if (fact.files !== undefined) expect(["1", "2_4", "5_9", "10_plus"]).toContain(fact.files);
    }
  });
});
