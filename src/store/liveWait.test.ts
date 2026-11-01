import { beforeEach, describe, expect, it } from "vitest";

import { resetLiveWait, useLiveWait } from "./liveWait";

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
