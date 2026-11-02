import { beforeEach, describe, expect, it } from "vitest";

import { resetLiveWait, trackSpeechWait, useLiveWait } from "./liveWait";

const live = () => useLiveWait.getState();

beforeEach(() => {
  resetLiveWait();
});

describe("the live record of what a turn is waiting on", () => {
  it("starts empty", () => {
    expect(live().round).toBeNull();
    expect(live().calls).toEqual([]);
    expect(live().approvalSince).toBeNull();
  });

  it("follows a model round from building the request to the end", () => {
    live().roundStarted(100);
    expect(live().round).toEqual({ phase: "preparing", startedAt: 100 });
    live().roundSent();
    expect(live().round).toEqual({ phase: "waiting", startedAt: 100 });
    live().roundWriting();
    expect(live().round).toEqual({ phase: "writing", startedAt: 100 });
    live().roundEnded();
    expect(live().round).toBeNull();
  });

  it("keeps the round's start when its phase changes, so the clock does not restart", () => {
    live().roundStarted(100);
    live().roundSent();
    live().roundWriting();
    live().roundWriting();
    expect(live().round?.startedAt).toBe(100);
  });

  it("does not move a round backwards or invent one", () => {
    live().roundSent();
    live().roundWriting();
    expect(live().round).toBeNull();
    live().roundStarted(1);
    live().roundWriting();
    live().roundSent(); // already past 'preparing': stays writing
    expect(live().round?.phase).toBe("writing");
  });

  it("lists the tool calls that are running, once each, in the order they began", () => {
    live().callStarted("a", "inspect_media", 1);
    live().callStarted("b", "video_ask", 2);
    live().callStarted("a", "inspect_media", 3); // the same call announced again
    expect(live().calls.map((c) => c.id)).toEqual(["b", "a"]);
    live().callEnded("b");
    expect(live().calls.map((c) => c.id)).toEqual(["a"]);
  });

  it("ignores the end of a call it never saw, without telling anyone something changed", () => {
    live().callStarted("a", "inspect_media", 1);
    const before = live().calls;
    live().callEnded("nobody");
    expect(live().calls).toBe(before);
  });

  it("is not fooled by a call id that an object would inherit", () => {
    live().callStarted("constructor", "inspect_media", 1);
    live().callStarted("__proto__", "video_ask", 2);
    expect(live().calls.map((c) => c.id)).toEqual(["constructor", "__proto__"]);
    live().callEnded("constructor");
    expect(live().calls.map((c) => c.id)).toEqual(["__proto__"]);
  });

  it("is waiting on the person from the question until something else starts", () => {
    live().approvalAsked(50);
    expect(live().approvalSince).toBe(50);
    live().callStarted("a", "add_clips", 60);
    expect(live().approvalSince).toBeNull();
    live().approvalAsked(70);
    live().roundStarted(80);
    expect(live().approvalSince).toBeNull();
  });

  it("when the turn pauses for the person, nothing is running but the question is still open", () => {
    live().roundStarted(1);
    live().callStarted("a", "add_clips", 2);
    live().approvalAsked(3);
    live().pausedForInput();
    expect(live().round).toBeNull();
    expect(live().calls).toEqual([]);
    expect(live().approvalSince).toBe(3);
  });

  it("clear leaves nothing behind", () => {
    live().roundStarted(1);
    live().callStarted("a", "add_clips", 2);
    live().approvalAsked(3);
    live().clear();
    expect(live().round).toBeNull();
    expect(live().calls).toEqual([]);
    expect(live().approvalSince).toBeNull();
  });

  it("gives each clear its own empty list, so one turn's calls can never leak into the next", () => {
    live().clear();
    const first = live().calls;
    live().callStarted("a", "add_clips", 1);
    live().clear();
    expect(live().calls).toEqual([]);
    expect(first).toEqual([]);
  });
});

describe("the tools waiting for speech", () => {
  const tools = (): string[] => live().speechWaits.map((w) => w.tool);

  it("lists a wait from its start to its end, once each, and ignores an end it never saw", () => {
    live().speechWaitStarted(1, "add_captions");
    live().speechWaitStarted(1, "add_captions"); // the same wait announced again
    expect(tools()).toEqual(["add_captions"]);
    const before = live().speechWaits;
    live().speechWaitEnded(99);
    expect(live().speechWaits).toBe(before);
    live().speechWaitEnded(1);
    expect(tools()).toEqual([]);
  });

  it("holds the waits of one tool apart: two waits of one tool are two entries", () => {
    live().speechWaitStarted(1, "inspect_media");
    live().speechWaitStarted(2, "inspect_media");
    live().speechWaitEnded(1);
    expect(live().speechWaits).toEqual([{ id: 2, tool: "inspect_media" }]);
  });

  it("trackSpeechWait marks the tool until the wait is over, whatever the wait's result", async () => {
    let finish!: (v: string) => void;
    let fail!: (e: unknown) => void;
    const ok = trackSpeechWait("get_transcript", new Promise<string>((r) => (finish = r)));
    const bad = trackSpeechWait(
      "add_captions",
      new Promise<string>((_, reject) => (fail = reject)),
    );
    expect(tools().sort()).toEqual(["add_captions", "get_transcript"]);
    finish("words");
    await expect(ok).resolves.toBe("words"); // handed back as it came
    expect(tools()).toEqual(["add_captions"]);
    fail(new Error("boom"));
    await expect(bad).rejects.toThrow("boom"); // a failure still reaches the caller
    expect(tools()).toEqual([]);
  });

  it("a wait cleared with its turn cannot end a later one", async () => {
    let finishOld!: () => void;
    void trackSpeechWait("add_captions", new Promise<void>((r) => (finishOld = r)));
    live().clear();
    expect(tools()).toEqual([]);
    let finishNew!: () => void;
    void trackSpeechWait("inspect_media", new Promise<void>((r) => (finishNew = r)));
    finishOld();
    await Promise.resolve();
    expect(tools()).toEqual(["inspect_media"]);
    finishNew();
    await Promise.resolve();
    expect(tools()).toEqual([]);
  });

  it("clear forgets every wait, and the turn pausing for the person does not touch them", () => {
    live().speechWaitStarted(1, "add_captions");
    live().pausedForInput();
    expect(tools()).toEqual(["add_captions"]);
    live().clear();
    expect(tools()).toEqual([]);
  });
});

describe("a round whose request is waiting", () => {
  it("carries the note while the request waits, and not a trace of it after", () => {
    live().roundStarted(100);
    live().roundSent();
    live().roundNoted("reconnecting");
    expect(live().round).toEqual({ phase: "waiting", startedAt: 100, note: "reconnecting" });
    live().roundNoted("busy");
    expect(live().round?.note).toBe("busy");
    live().roundNoted(null);
    expect(live().round).toEqual({ phase: "waiting", startedAt: 100 });
    expect("note" in (live().round ?? {})).toBe(false);
  });

  it("is nothing without a round, and announces no change that is none", () => {
    live().roundNoted("busy");
    expect(live().round).toBeNull();
    live().roundStarted(1);
    live().roundNoted("busy");
    const noted = live().round;
    live().roundNoted("busy");
    expect(live().round).toBe(noted);
    live().roundNoted(null);
    const cleared = live().round;
    live().roundNoted(null);
    expect(live().round).toBe(cleared);
  });

  it("is gone once words arrive, when the round ends, and when another begins", () => {
    live().roundStarted(1);
    live().roundSent();
    live().roundNoted("reconnecting");
    live().roundWriting();
    expect(live().round).toEqual({ phase: "writing", startedAt: 1 });

    live().roundNoted("busy");
    live().roundEnded();
    expect(live().round).toBeNull();

    live().roundStarted(2);
    live().roundNoted("busy");
    live().roundStarted(3);
    expect(live().round).toEqual({ phase: "preparing", startedAt: 3 });
  });
});
