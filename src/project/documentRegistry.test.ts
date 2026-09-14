import { beforeEach, describe, expect, it, vi } from "vitest";

const activateEditor = vi.fn();
const activateChat = vi.fn();
const deactivateEditor = vi.fn();
const deactivateChat = vi.fn();
const quiesceChat = vi.fn();
const resumeChat = vi.fn();
const whenQuiescent = vi.fn(async (_id: string) => undefined);
const openHost = vi.fn((_id: string) => ({ ready: Promise.resolve() }));
const closeHost = vi.fn();
const flushSession = vi.fn(async (_dir: string) => undefined);
const saveSession = vi.fn(async (_id: string) => true);
const captureErr = vi.fn();

vi.mock("../store/editor", () => ({
  activateEditorProject: (id: string) => activateEditor(id),
  deactivateEditorProject: (id: string | null) => deactivateEditor(id),
  useEditor: { getState: () => ({ store: undefined, projectId: undefined }) },
}));
vi.mock("../store/chat", () => ({
  activateChatProject: (id: string) => activateChat(id),
  deactivateChatProject: (id: string | null) => deactivateChat(id),
  quiesceChatProject: (id: string) => quiesceChat(id),
  resumeChatProject: (id: string) => resumeChat(id),
  whenChatQuiescent: (id: string) => whenQuiescent(id),
  isChatExecutionCurrent: () => true,
  saveProjectSessionNow: (id: string) => saveSession(id),
}));
vi.mock("../timeline/engine", () => ({
  rearmTimelinePersist: vi.fn(),
}));
vi.mock("../tools/host", () => ({
  openToolHost: (id: string) => openHost(id),
  closeToolHost: (id: string) => closeHost(id),
}));
vi.mock("../store/transcriptFile", () => ({
  flushPendingSession: (dir: string) => flushSession(dir),
}));
vi.mock("../tools/dataRoot", () => ({
  boundProjectId: () => "",
  projectDirFor: async (id: string) => `/root/projects/${id}`,
}));
vi.mock("../observability/sentry", () => ({
  captureError: (...args: unknown[]) => captureErr(...args),
}));

import { makeProjectChildren } from "./documentRegistry";
import { asProjectId, newSessionId } from "./types";

const id = asProjectId("p1");
const ctx = () => ({ id, sessionId: newSessionId() });

beforeEach(() => vi.clearAllMocks());

describe("makeProjectChildren", () => {
  it("open activates chat + editor and warms the host on a loaded editor", async () => {
    activateChat.mockResolvedValue(undefined);
    activateEditor.mockResolvedValue("loaded");
    const outcome = await makeProjectChildren(id).open(ctx());
    expect(outcome).toBe("loaded");
    expect(activateChat).toHaveBeenCalledWith(id);
    expect(activateEditor).toHaveBeenCalledWith(id);
    expect(openHost).toHaveBeenCalledWith(id);
  });

  it("open returns 'failed' when the editor load fails, and does NOT warm the host", async () => {
    activateChat.mockResolvedValue(undefined);
    activateEditor.mockResolvedValue("failed");
    expect(await makeProjectChildren(id).open(ctx())).toBe("failed");
    expect(openHost).not.toHaveBeenCalled();
  });

  it("open maps a superseded editor load to 'failed'", async () => {
    activateChat.mockResolvedValue(undefined);
    activateEditor.mockResolvedValue("superseded");
    expect(await makeProjectChildren(id).open(ctx())).toBe("failed");
    expect(openHost).not.toHaveBeenCalled();
  });

  it("open tolerates a chat load failure — the editor gates the reveal", async () => {
    activateChat.mockRejectedValue(new Error("chat boom"));
    activateEditor.mockResolvedValue("loaded");
    expect(await makeProjectChildren(id).open(ctx())).toBe("loaded");
    expect(openHost).toHaveBeenCalledWith(id);
  });

  it("open returns 'failed' when editor activation throws", async () => {
    activateChat.mockResolvedValue(undefined);
    activateEditor.mockRejectedValue(new Error("editor boom"));
    expect(await makeProjectChildren(id).open(ctx())).toBe("failed");
    expect(openHost).not.toHaveBeenCalled();
  });

  it("saveTranscript AWAITS in-flight chat ops (whenChatQuiescent) BEFORE persisting, and reports its result", async () => {
    saveSession.mockResolvedValue(true);
    expect(await makeProjectChildren(id).saveTranscript!(ctx())).toBe(true);
    expect(whenQuiescent).toHaveBeenCalledWith(id);
    expect(saveSession).toHaveBeenCalledWith(id);
    // Finding #2: an already-admitted undo/redo/restore is awaited IN FULL before the final snapshot,
    // so a half-applied write can't land after it (producers were already fenced at close START).
    expect(whenQuiescent.mock.invocationCallOrder[0]).toBeLessThan(
      saveSession.mock.invocationCallOrder[0],
    );
    saveSession.mockResolvedValue(false);
    expect(await makeProjectChildren(id).saveTranscript!(ctx())).toBe(false); // a transcript failure fails the close save
  });

  it("dispose invalidates the session (deactivateEditor) even when the transcript drain THROWS (finding #3)", async () => {
    flushSession.mockRejectedValueOnce(new Error("flush boom"));
    await makeProjectChildren(id).dispose(ctx()); // must NOT reject — every step attempts independently
    // The editor deactivation (session invalidation) is GUARANTEED via finally, so no late writer can
    // touch the folder after close even though the flush failed.
    expect(deactivateEditor).toHaveBeenCalledWith(id);
    expect(closeHost).toHaveBeenCalledWith(id);
    expect(captureErr).toHaveBeenCalled();
  });

  it("dispose retires the chat turn, drains the transcript, disposes the editor, and evicts the host", async () => {
    await makeProjectChildren(id).dispose(ctx());
    expect(deactivateEditor).toHaveBeenCalledWith(id);
    expect(deactivateChat).toHaveBeenCalledWith(id);
    expect(closeHost).toHaveBeenCalledWith(id);
    expect(flushSession).toHaveBeenCalledWith("/root/projects/p1");
    // The chat store is disposed BEFORE the final transcript drain, which runs BEFORE the editor dispose
    // (which bumps the session generation).
    expect(deactivateChat.mock.invocationCallOrder[0]).toBeLessThan(
      flushSession.mock.invocationCallOrder[0],
    );
    expect(flushSession.mock.invocationCallOrder[0]).toBeLessThan(
      deactivateEditor.mock.invocationCallOrder[0],
    );
  });
});
