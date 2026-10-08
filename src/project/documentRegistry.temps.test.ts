// When a project's temps are swept (4j): at open, after the project is claimed and only when no other
// machine held it; and at close, with the GC. Neither can fail the open or the close.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sweepTemps = vi.fn(async (_store: unknown) => ({ removed: [] as string[] }));
const sweepOwned = vi.fn(async (_store: unknown) => ({ removed: [] as string[] }));
const sweepCache = vi.fn(async (_store: unknown) => ({ removed: [] as string[] }));
const foreignLock = vi.fn(async (): Promise<{ instance: string; at: number } | null> => null);
const claimLock = vi.fn(async () => undefined);
const releaseLock = vi.fn(async () => undefined);
const notify = vi.fn();
const captureErr = vi.fn();
const store = { projectDir: "/root/projects/p1", fsForProjectRegistry: () => ({}) };
const storeFor = vi.fn(async (): Promise<typeof store | null> => store);

vi.mock("../store/editor", () => ({
  activateEditorProject: async () => "loaded",
  deactivateEditorProject: () => undefined,
  useEditor: { getState: () => ({ store: undefined, projectId: undefined }) },
}));
vi.mock("../store/chat", () => ({
  activateChatProject: async () => undefined,
  deactivateChatProject: () => undefined,
  quiesceChatProject: () => undefined,
  resumeChatProject: () => undefined,
  whenChatQuiescent: async () => undefined,
  isChatExecutionCurrent: () => true,
  saveProjectSessionNow: async () => true,
}));
vi.mock("../timeline/engine", () => ({
  rearmTimelinePersist: () => undefined,
  cancelWriteRecovery: () => undefined,
}));
vi.mock("../tools/host", () => ({
  openToolHost: () => ({ ready: Promise.resolve() }),
  closeToolHost: () => undefined,
}));
vi.mock("../store/transcriptFile", () => ({ flushPendingSession: async () => undefined }));
vi.mock("../tools/dataRoot", async (orig) => ({
  ...(await orig<typeof import("../tools/dataRoot")>()),
  projectDirFor: async (id: string) => `/root/projects/${id}`,
}));
vi.mock("../lib/desktop", () => ({ storeForProject: () => storeFor() }));
vi.mock("../tools/projectLock", () => ({
  foreignProjectLock: () => foreignLock(),
  claimProjectLock: () => claimLock(),
  releaseProjectLock: () => releaseLock(),
}));
vi.mock("../tools/mediaGc", () => ({
  sweepOwnedMedia: (s: unknown) => sweepOwned(s),
  sweepArtifactCache: (s: unknown) => sweepCache(s),
}));
vi.mock("../tools/projectTemps", () => ({ sweepProjectTemps: (s: unknown) => sweepTemps(s) }));
vi.mock("../store/projectNotice", () => ({ useProjectNotice: { getState: () => ({ notify }) } }));
vi.mock("../observability/sentry", () => ({
  captureError: (...args: unknown[]) => captureErr(...args),
}));

import { makeProjectChildren } from "./documentRegistry";
import { asProjectId, newSessionId } from "./types";

const id = asProjectId("p1");
const ctx = () => ({ id, sessionId: newSessionId() });
const background = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => vi.clearAllMocks());

describe("a project's temps are swept", () => {
  it("when it opens, after it is claimed", async () => {
    expect(await makeProjectChildren(id).open(ctx())).toBe("loaded");
    await vi.waitFor(() => expect(sweepTemps).toHaveBeenCalledWith(store));
    expect(claimLock.mock.invocationCallOrder[0]).toBeLessThan(
      sweepTemps.mock.invocationCallOrder[0],
    );
    expect(notify).not.toHaveBeenCalled(); // nobody else had it
    expect(captureErr).not.toHaveBeenCalled();
  });

  it("never where there is no project folder to sweep (the web build)", async () => {
    storeFor.mockResolvedValueOnce(null);
    expect(await makeProjectChildren(id).open(ctx())).toBe("loaded");
    await background();
    expect(claimLock).not.toHaveBeenCalled();
    expect(sweepTemps).not.toHaveBeenCalled();
    expect(captureErr).not.toHaveBeenCalled();
  });

  it("never when another machine had it open: its writers are invisible from here", async () => {
    foreignLock.mockResolvedValueOnce({ instance: "another-machine", at: Date.now() });
    expect(await makeProjectChildren(id).open(ctx())).toBe("loaded");
    await vi.waitFor(() => expect(claimLock).toHaveBeenCalled());
    await background();
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/already open somewhere else/));
    expect(sweepTemps).not.toHaveBeenCalled();
  });

  it("at open even when the claim fails, since nobody else held it", async () => {
    claimLock.mockRejectedValueOnce(new Error("read-only volume"));
    await makeProjectChildren(id).open(ctx());
    await vi.waitFor(() => expect(sweepTemps).toHaveBeenCalledWith(store));
    expect(captureErr).toHaveBeenCalledWith(expect.any(Error), { scope: "project.open.lock" });
  });

  it("when it closes, with the GC", async () => {
    await makeProjectChildren(id).dispose(ctx());
    expect(sweepOwned).toHaveBeenCalledWith(store);
    expect(sweepCache).toHaveBeenCalledWith(store);
    expect(sweepTemps).toHaveBeenCalledWith(store);
  });

  it("and a sweep that fails never fails the open or the close", async () => {
    sweepTemps.mockRejectedValue(new Error("disk went away"));
    expect(await makeProjectChildren(id).open(ctx())).toBe("loaded");
    await vi.waitFor(() =>
      expect(captureErr).toHaveBeenCalledWith(expect.any(Error), { scope: "project.open.temps" }),
    );
    await expect(makeProjectChildren(id).dispose(ctx())).resolves.toBeUndefined();
    sweepTemps.mockReset();
  });
});
