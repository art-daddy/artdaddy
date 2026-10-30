import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemFs } from "../test/timelineKit";
import { ProjectStoreAccess, joinPath } from "../tools/store";
import { __resetProjectJobs, openProjectJobs } from "../tools/genJobs";
import { notifyJobSettled, pendingJobNotes, __resetJobNotes } from "../store/jobNotes";
import { cancelWriteRecovery, rearmTimelinePersist } from "../timeline/engine";

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
const recoverMedia = vi.fn(async (_store: ProjectStoreAccess) => [] as string[]);
let editorState: { projectId?: string; store?: unknown } = {};

vi.mock("../store/editor", () => ({
  activateEditorProject: (id: string) => activateEditor(id),
  deactivateEditorProject: (id: string | null) => deactivateEditor(id),
  useEditor: { getState: () => editorState },
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
  cancelWriteRecovery: vi.fn(),
}));
vi.mock("../tools/host", () => ({
  openToolHost: (id: string) => openHost(id),
  closeToolHost: (id: string) => closeHost(id),
}));
vi.mock("../store/transcriptFile", () => ({
  flushPendingSession: (dir: string) => flushSession(dir),
}));
vi.mock("../tools/dataRoot", async (orig) => ({
  ...(await orig<typeof import("../tools/dataRoot")>()),
  projectDirFor: async (id: string) => `/root/projects/${id}`,
}));
vi.mock("../observability/sentry", () => ({
  captureError: (...args: unknown[]) => captureErr(...args),
}));
vi.mock("../tools/import", async (orig) => ({
  ...(await orig<typeof import("../tools/import")>()),
  reconcilePendingMedia: (store: ProjectStoreAccess) => recoverMedia(store),
}));

import { makeProjectChildren, projectDocuments } from "./documentRegistry";
import { asProjectId, newSessionId } from "./types";
import { setClerkTokenProvider } from "../api/auth";
import { toB64 } from "../api/ai";
import { __resetOrderPolling, orderPolling } from "../api/orders";
import { FakeOrderServer } from "../test/orderServer";

const id = asProjectId("p1");
const ctx = () => ({ id, sessionId: newSessionId() });

beforeEach(() => {
  vi.clearAllMocks();
  recoverMedia.mockReset().mockResolvedValue([]);
  saveSession.mockResolvedValue(true);
  editorState = {};
});
afterEach(() => {
  __resetProjectJobs();
  __resetJobNotes();
});

describe("makeProjectChildren", () => {
  it("rechecks completed media when the user keeps editing after a failed close", async () => {
    const projectId = asProjectId("recovery-cancel-close");
    editorState = { projectId, store: { projectDir: `/root/projects/${projectId}` } };
    activateChat.mockResolvedValue(undefined);
    activateEditor.mockResolvedValue("loaded");
    const doc = await projectDocuments.open(projectId);
    recoverMedia.mockClear();
    saveSession.mockResolvedValue(false);
    expect(await projectDocuments.close(projectId)).toMatchObject({ ok: false });
    expect(cancelWriteRecovery).toHaveBeenCalledWith(`/root/projects/${projectId}`);
    doc.cancelClose();
    expect(resumeChat).toHaveBeenCalledWith(projectId);
    expect(rearmTimelinePersist).toHaveBeenCalledWith(editorState.store, doc);
    expect(recoverMedia).toHaveBeenCalledTimes(1);
    saveSession.mockResolvedValue(true);
    await projectDocuments.close(projectId);
  });

  it("closing waits for admitted media recovery and permits no later catalog write", async () => {
    const actual = await vi.importActual<typeof import("../tools/import")>("../tools/import");
    recoverMedia.mockImplementation(actual.reconcilePendingMedia);
    const projectId = asProjectId("recovery-close-order");
    const dir = `/root/projects/${projectId}`;
    const fs = new MemFs();
    const store = new ProjectStoreAccess(dir, fs);
    const pending = await actual.registerPendingClip(store, {
      id: "media_gen_close",
      filename: "close.png",
      kind: "image",
    });
    const path = joinPath(dir, pending.path);
    fs.files.set(path, "completed-output");
    let entered!: () => void;
    let release!: () => void;
    const checking = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const exists = fs.exists.bind(fs);
    vi.spyOn(fs, "exists").mockImplementation(async (target) => {
      if (target === path) {
        entered();
        await gate;
      }
      return exists(target);
    });
    editorState = { projectId, store };
    activateChat.mockResolvedValue(undefined);
    activateEditor.mockResolvedValue("loaded");
    const doc = await projectDocuments.open(projectId);
    await checking;
    const closing = projectDocuments.close(projectId);
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(saveSession).not.toHaveBeenCalled();
      expect(cancelWriteRecovery).toHaveBeenCalledWith(dir);
      expect(doc.phase()).toBe("closing");
    } finally {
      release();
      await closing;
    }
    const catalog = joinPath(dir, "internals/library.json");
    const closed = fs.files.get(catalog);
    await Promise.allSettled(recoverMedia.mock.results.map((result) => result.value));
    expect(doc.phase()).toBe("closed");
    expect(fs.files.get(catalog)).toBe(closed);
    expect(fs.files.get(path)).toBe("completed-output");
  });

  it("leaves a completed file pending when its catalog save fails, then retries on reopen", async () => {
    const actual = await vi.importActual<typeof import("../tools/import")>("../tools/import");
    recoverMedia.mockImplementation(actual.reconcilePendingMedia);
    const projectId = asProjectId("recovery-save-failure");
    const dir = `/root/projects/${projectId}`;
    const fs = new MemFs();
    const store = new ProjectStoreAccess(dir, fs);
    const pending = await actual.registerPendingClip(store, {
      id: "media_gen_saved",
      filename: "saved.png",
      kind: "image",
    });
    const path = joinPath(dir, pending.path);
    fs.files.set(path, "completed-output");
    const catalog = joinPath(dir, "internals/library.json");
    const before = fs.files.get(catalog);
    const write = fs.writeTextFile.bind(fs);
    const fault = vi.spyOn(fs, "writeTextFile").mockImplementation(async (target, text) => {
      if (target === catalog) throw new Error("local catalog write failure");
      await write(target, text);
    });
    editorState = { projectId, store };
    activateChat.mockResolvedValue(undefined);
    activateEditor.mockResolvedValue("loaded");
    await projectDocuments.open(projectId);
    await vi.waitFor(() =>
      expect(captureErr).toHaveBeenCalledWith(expect.any(Error), {
        scope: "project.open.generated-media",
      }),
    );
    expect(fs.files.get(catalog)).toBe(before);
    expect(fs.files.get(path)).toBe("completed-output");
    fault.mockRestore();
    await projectDocuments.close(projectId);
    await projectDocuments.open(projectId);
    await vi.waitFor(async () => expect((await store.listClips())[0].status).toBeUndefined());
    expect(await store.resolveRef("media_gen_saved")).toBe(path);
    await projectDocuments.close(projectId);
  });

  it("does not recover another project's completion into the project currently open", async () => {
    const projectId = asProjectId("recovery-current-project");
    editorState = { projectId, store: { projectDir: `/root/projects/${projectId}` } };
    activateChat.mockResolvedValue(undefined);
    activateEditor.mockResolvedValue("loaded");
    await projectDocuments.open(projectId);
    recoverMedia.mockClear();
    notifyJobSettled("/root/projects/another-project", {
      id: "other-job",
      tool: "generate_image",
      label: "image",
      status: "done",
      startedBy: "elsewhere",
      media_refs: ["media_gen_other"],
    });
    expect(recoverMedia).not.toHaveBeenCalled();
    expect(pendingJobNotes("/root/projects/another-project")).toEqual([]);
    await projectDocuments.close(projectId);
  });

  it("attaches a file finishing after reopen without waking a chat for external work", async () => {
    const actual = await vi.importActual<typeof import("../tools/import")>("../tools/import");
    recoverMedia.mockImplementation(actual.reconcilePendingMedia);
    const projectId = asProjectId("late-generated-output");
    const dir = `/root/projects/${projectId}`;
    const fs = new MemFs();
    const store = new ProjectStoreAccess(dir, fs);
    const mediaId = "media_gen_late";
    const pending = await actual.registerPendingClip(store, {
      id: mediaId,
      filename: "voice.wav",
      kind: "audio",
    });
    editorState = { projectId, store };
    activateChat.mockResolvedValue(undefined);
    activateEditor.mockResolvedValue("loaded");
    await projectDocuments.open(projectId);
    expect((await store.listClips())[0].status).toBe("generating");
    const path = joinPath(dir, pending.path);
    fs.files.set(path, "already-complete-output");
    notifyJobSettled(dir, {
      id: "late-job",
      tool: "generate_voiceover",
      label: "voiceover",
      status: "done",
      startedBy: "elsewhere",
      media_refs: [mediaId],
    });
    await vi.waitFor(async () => expect((await store.listClips())[0].status).toBeUndefined());
    expect(await store.resolveRef(mediaId)).toBe(path);
    expect(pendingJobNotes(dir)).toEqual([]);
    expect(activateChat).toHaveBeenCalledTimes(1);
    await projectDocuments.close(projectId);
  });

  it.each(
    ["image", "video", "music", "voiceover"].flatMap((kind) => [
      { kind, cache: "reused" },
      { kind, cache: "fresh" },
    ]),
  )(
    "reopening makes completed $kind media usable with a $cache job cache",
    async ({ kind, cache }) => {
      const actual = await vi.importActual<typeof import("../tools/import")>("../tools/import");
      recoverMedia.mockImplementation(actual.reconcilePendingMedia);
      const projectId = asProjectId(`recovery-artifact-${kind}-${cache}`);
      const dir = `/root/projects/${projectId}`;
      const fs = new MemFs();
      const store = new ProjectStoreAccess(dir, fs);
      const cached = await openProjectJobs(store);
      const mediaId = `media_gen_${kind}`;
      const pending = await actual.registerPendingClip(store, {
        id: mediaId,
        filename: "generated-media",
        kind: kind === "music" || kind === "voiceover" ? "audio" : kind,
      });
      const jobId = await cached.begin({
        kind: "generation",
        tool: `generate_${kind}`,
        label: "generated media",
        media_refs: [mediaId],
      });
      editorState = { projectId, store };
      activateChat.mockResolvedValue(undefined);
      activateEditor.mockResolvedValue("loaded");
      await projectDocuments.open(projectId);
      await vi.waitFor(async () =>
        expect((await store.listClips())[0]).toMatchObject({ id: mediaId, status: "generating" }),
      );
      await projectDocuments.close(projectId);
      const path = joinPath(dir, pending.path);
      const complete = "already-complete-local-output";
      fs.files.set(path, complete);
      await cached.settle(jobId, { status: "done", media_refs: [mediaId] });
      const savedJobs = fs.files.get(joinPath(dir, "internals/jobs.json"));
      if (cache === "fresh") __resetProjectJobs();
      await projectDocuments.open(projectId);
      await vi.waitFor(async () => {
        const row = (await store.listClips())[0];
        expect(row?.id).toBe(mediaId);
        expect(row.status).toBeUndefined();
      });
      const saved = JSON.parse(await fs.readTextFile(joinPath(dir, "internals/library.json")));
      expect(saved.clips).toHaveLength(1);
      expect(saved.clips[0].id).toBe(mediaId);
      expect(saved.clips[0].status).toBeUndefined();
      expect(fs.files.get(path)).toBe(complete);
      expect(await store.resolveRef(mediaId)).toBe(path);
      const reopened = await openProjectJobs(store);
      if (cache === "reused") expect(reopened).toBe(cached);
      else expect(reopened).not.toBe(cached);
      expect(fs.files.get(joinPath(dir, "internals/jobs.json"))).toBe(savedJobs);
      expect(activateChat).toHaveBeenCalledTimes(2);
      await projectDocuments.close(projectId);
    },
  );

  describe("a generation the app was closed on", () => {
    class BytesFs extends MemFs {
      bytes = new Map<string, Uint8Array>();
      override async exists(p: string): Promise<boolean> {
        return (await super.exists(p)) || this.bytes.has(joinPath(p));
      }
      async readBytes(p: string): Promise<Uint8Array> {
        const v = this.bytes.get(joinPath(p));
        if (!v) throw new Error(`ENOENT ${p}`);
        return v;
      }
      async writeBytes(p: string, b: Uint8Array): Promise<void> {
        this.bytes.set(joinPath(p), b);
      }
      async remove(p: string): Promise<void> {
        this.files.delete(joinPath(p));
        this.bytes.delete(joinPath(p));
      }
    }
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
    ]);
    const orderId = "0123456789abcdef0123456789abcdef";

    /** A project whose last launch was closed in the middle of a generation the server holds as an order in ``state``. */
    async function closedOnAnOrder(name: string, state: "ready" | "running") {
      const server = new FakeOrderServer();
      server.behaviour.pollsUntilDone = 1_000_000;
      server.seed(orderId, "generate_image", state, {
        result: { ok: true, count: 1 },
        media: [{ b64: toB64(png), ext: ".png", kind: "image" }],
      });
      vi.stubGlobal("fetch", server.fetch);
      setClerkTokenProvider(async () => "tok");
      orderPolling.sleep = async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      };
      const actual = await vi.importActual<typeof import("../tools/import")>("../tools/import");
      recoverMedia.mockImplementation(actual.reconcilePendingMedia);
      const projectId = asProjectId(name);
      const dir = `/root/projects/${projectId}`;
      const fs = new BytesFs();
      const store = new ProjectStoreAccess(dir, fs);
      await actual.registerPendingClip(store, { id: "media_gen_old", filename: "old.png", kind: "image" });
      fs.files.set(
        joinPath(dir, "internals/jobs.json"),
        JSON.stringify({
          version: 1,
          jobs: [
            {
              id: "old",
              kind: "generation",
              tool: "generate_image",
              label: "an image",
              status: "running",
              media_refs: ["media_gen_old"],
              order_id: orderId,
              started_by: "chat",
              started_at: 1,
              session: "a-previous-launch",
            },
          ],
        }),
      );
      editorState = { projectId, store };
      activateChat.mockResolvedValue(undefined);
      activateEditor.mockResolvedValue("loaded");
      return { server, fs, store, dir, projectId };
    }
    const cleanUp = async (projectId: ReturnType<typeof asProjectId>) => {
      await projectDocuments.close(projectId);
      vi.unstubAllGlobals();
      setClerkTokenProvider(null);
      __resetOrderPolling();
    };

    it("is collected when the project is opened, without waiting for anything to be generated", async () => {
      const { server, fs, store, dir, projectId } = await closedOnAnOrder("order-on-open", "ready");
      try {
        await projectDocuments.open(projectId);
        await vi.waitFor(async () => expect((await store.listClips())[0].status).toBeUndefined());
        expect(await fs.readBytes(joinPath(dir, "library/media_gen_old.png"))).toEqual(png);
        await vi.waitFor(() => expect(server.orders.get(orderId)?.state).toBe("collected"));
        expect(pendingJobNotes(dir).map((n) => [n.id, n.status])).toEqual([["old", "done"]]);
      } finally {
        await cleanUp(projectId);
      }
    });

    it("is asked about at open, and opening looks for finished placeholders once, as it always did", async () => {
      const { server, store, projectId } = await closedOnAnOrder("order-still-running", "running");
      try {
        await projectDocuments.open(projectId);
        await vi.waitFor(() => expect(server.calls.filter((c) => c.startsWith("GET /orders/")).length).toBeGreaterThan(1));
        // The server is still making it: nothing landed, so nothing but the open itself asked the library to look again.
        expect((await store.listClips())[0].status).toBe("generating");
        expect(recoverMedia).toHaveBeenCalledTimes(1);
        expect(pendingJobNotes(`/root/projects/${projectId}`)).toEqual([]);
      } finally {
        await cleanUp(projectId);
      }
    });

    it("that cannot be looked into is reported, and never left as an unhandled failure", async () => {
      const projectId = asProjectId("order-unreadable");
      const store = {
        projectDir: `/root/projects/${projectId}`,
        readJson: async () => {
          throw new Error("the disk went away");
        },
      };
      editorState = { projectId, store };
      activateChat.mockResolvedValue(undefined);
      activateEditor.mockResolvedValue("loaded");
      try {
        await projectDocuments.open(projectId);
        await vi.waitFor(() =>
          expect(captureErr).toHaveBeenCalledWith(expect.objectContaining({ message: "the disk went away" }), {
            scope: "project.open.generation-orders",
          }),
        );
      } finally {
        await projectDocuments.close(projectId);
      }
    });
  });

  it("rechecks completed generated media on each successful project reopen", async () => {
    const projectId = asProjectId("generated-media-reopen");
    const store = { projectDir: "/root/projects/generated-media-reopen" };
    editorState = { projectId, store };
    activateChat.mockResolvedValue(undefined);
    activateEditor.mockResolvedValue("loaded");
    for (let open = 0; open < 2; open += 1) {
      await projectDocuments.open(projectId);
      expect(recoverMedia).toHaveBeenCalledTimes(open + 1);
      expect(recoverMedia).toHaveBeenLastCalledWith(store);
      await projectDocuments.close(projectId);
    }
  });

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
    expect(recoverMedia).not.toHaveBeenCalled();
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
