import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectJobScope } from "../project/ProjectJobScope";
import { setOpenDocumentResolver } from "../project/openDocuments";
import { asProjectId } from "../project/types";
import { ProjectStoreAccess, type FsLike } from "./store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// The tool host builds its context by lazy-importing the Tauri fs/path seams and
// the tool registry. Mock them all so the host builds (or fails) WITHOUT loading
// any Tauri plugin, letting us drive warm-up success/failure deterministically.
const projectDirFor = vi.fn(async (id: string) => `/root/${id}`);
const makeTauriContext = vi.fn(async (_dir: string) => ({
  store: {} as never,
  runner: {} as never,
}));
// The mocked registry's run captures the ctx the host threaded (so a test can inspect the combined
// abort signal) and returns `toolGate` (a deferred lets a test hold a tool "in flight").
let toolGate: Promise<Any> = Promise.resolve({ ok: true });
let toolCtx: Any = null;

vi.mock("./dataRoot", async (orig) => ({
  ...(await orig<typeof import("./dataRoot")>()),
  projectDirFor: (id: string) => projectDirFor(id),
}));
vi.mock("./tauri", () => ({ makeTauriContext: (d: string) => makeTauriContext(d) }));
vi.mock("../timeline/engine", () => ({ ensureTimeline: vi.fn(async () => undefined) }));
vi.mock(".", () => ({
  createToolRegistry: (getCtx: () => Any) => ({
    has: () => true,
    run: async () => {
      toolCtx = getCtx();
      return toolGate;
    },
  }),
}));

import { closeToolHost, openToolHost } from "./host";

beforeEach(() => {
  toolGate = Promise.resolve({ ok: true });
  toolCtx = null;
});
afterEach(() => {
  closeToolHost();
  setOpenDocumentResolver(() => undefined);
  vi.clearAllMocks();
});

describe("openToolHost", () => {
  it("reuses the cached host for the same project", async () => {
    const a = openToolHost("p1");
    expect(openToolHost("p1")).toBe(a); // same instance -> one built context per project
    await a.ready;
  });

  it("evicts a host whose warm-up REJECTS so the next open rebuilds it (RF8)", async () => {
    projectDirFor.mockRejectedValueOnce(new Error("no dir")); // the first host's warm-up fails
    const broken = openToolHost("p1");
    await expect(broken.ready).rejects.toThrow("no dir");
    // The auto-evict .catch has run: a fresh open builds a NEW host instead of
    // handing back the permanently-rejected one (which would brick this chat).
    const rebuilt = openToolHost("p1");
    expect(rebuilt).not.toBe(broken);
    await expect(rebuilt.ready).resolves.toBeUndefined(); // healthy now
  });

  it("evicts a single project's host by id, leaving others (R11 f/u #2)", () => {
    // Synchronous: openToolHost caches + returns the host immediately (ready warms async).
    // We only assert the CACHE eviction here; each host's ready is .catch-guarded by openToolHost.
    const a = openToolHost("p1");
    const b = openToolHost("p2");
    closeToolHost("p1"); // project close -> evict just p1's host
    expect(openToolHost("p1")).not.toBe(a); // p1 rebuilt lazily
    expect(openToolHost("p2")).toBe(b); // p2 untouched (still cached)
  });
});

describe("ProjectToolHost.run effect routing (Step 4)", () => {
  const withScope = (scope: ProjectJobScope) =>
    setOpenDocumentResolver((id) =>
      id === asProjectId("p1") ? ({ jobs: scope } as Any) : undefined,
    );

  it("routes a project-job tool through the document's job scope; close cancels its signal (finding #2)", async () => {
    const scope = new ProjectJobScope();
    withScope(scope);
    const host = openToolHost("p1");
    await host.ready;
    let release!: (v: Any) => void;
    toolGate = new Promise((r) => (release = r)); // hold the tool in flight
    const runP = host.run("download_video", {});
    await Promise.resolve();
    expect(toolCtx.signal).toBeInstanceOf(AbortSignal); // ran with a (job) cancellation signal
    expect(toolCtx.signal.aborted).toBe(false);
    const closeP = scope.beginClose(); // close drains jobs -> the in-flight tool's signal aborts
    expect(toolCtx.signal.aborted).toBe(true);
    release({ ok: true });
    await runP;
    await closeP; // close settles only once the drained job returned (deterministic teardown)
  });

  it("runs a read WITHOUT a job lease — the turn owns its cancellation", async () => {
    const scope = new ProjectJobScope();
    const runSpy = vi.spyOn(scope, "run");
    withScope(scope);
    const host = openToolHost("p1");
    await host.ready;
    await host.run("get_timeline", {});
    expect(runSpy).not.toHaveBeenCalled(); // a read is not wrapped in the job scope
  });

  it("combines the turn's Stop with the job signal (a job tool aborts on either)", async () => {
    const scope = new ProjectJobScope();
    withScope(scope);
    const host = openToolHost("p1");
    await host.ready;
    const ac = new AbortController();
    let release!: (v: Any) => void;
    toolGate = new Promise((r) => (release = r));
    const runP = host.run("download_video", {}, ac.signal);
    await Promise.resolve();
    expect(toolCtx.signal.aborted).toBe(false);
    ac.abort(); // Stop the turn (not a close)
    expect(toolCtx.signal.aborted).toBe(true); // the combined signal reflects the turn Stop too
    release({ ok: true });
    await runP;
  });

  it("reports a clean failure when a job tool starts after the scope began closing", async () => {
    const scope = new ProjectJobScope();
    await scope.beginClose(); // the project is already closing
    withScope(scope);
    const host = openToolHost("p1");
    await host.ready;
    const r = (await host.run("download_video", {})) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("closing");
  });

  it("runs a job tool DIRECTLY when no document is open (bare store / pre-publish window)", async () => {
    // No resolver -> openDocumentById returns undefined -> no job scope -> the tool still runs.
    const host = openToolHost("p1");
    await host.ready;
    expect(await host.run("download_video", {})).toEqual({ ok: true });
  });

  // The origin is how a timeline change is told apart from an outside one (UJ-028), and it lives
  // in a field of the shared host. It stays per call only because nothing awaits between setting
  // it and the tool reading it; an MCP call landing during an agent call must not take its origin.
  it("keeps each concurrent call's origin its own (an MCP call during an agent call)", async () => {
    const host = openToolHost("p1");
    await host.ready;
    const ticks = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    let release!: (v: Any) => void;
    toolGate = new Promise((r) => (release = r));
    const origin = { chatSessionId: "t", branchId: 0, executionId: 7 };
    const agent = host.run("add_clips", {}, new AbortController().signal, origin);
    await ticks();
    const agentCtx = toolCtx;
    const mcp = host.run("add_clips", {}); // the MCP shape: no signal, no origin
    await ticks();
    const mcpCtx = toolCtx;
    expect(agentCtx).not.toBe(mcpCtx);
    expect(agentCtx.origin).toEqual(origin);
    expect(mcpCtx.origin).toBeUndefined();
    release({ ok: true });
    await Promise.all([agent, mcp]);
  });
});

describe("the store every agent tool call sees", () => {
  // In-app turns pass a Stop signal; MCP calls arrive without one. Both go through host.run, and
  // both must get the agent's view, where a path the project does not know resolves to nothing.
  it("limits refs to what the project knows, with or without a turn signal", async () => {
    const secret = "C:/Users/u/Documents/secret.mp4";
    const disk: FsLike = {
      exists: async (p) => p.toLowerCase() === secret.toLowerCase(),
      readTextFile: async () => {
        throw new Error("ENOENT");
      },
      writeTextFile: async () => undefined,
      mkdir: async () => undefined,
    };
    const store = new ProjectStoreAccess("C:/root/p9", disk);
    makeTauriContext.mockResolvedValueOnce({ store: store as never, runner: {} as never });
    const host = openToolHost("p9");
    await host.ready;
    expect(await store.resolveRef(secret)).toBe(secret); // the trusted resolver would hand it over

    await host.run("library_op", {}); // the MCP shape: no signal
    expect(await toolCtx.store.resolveRef(secret)).toBeNull();

    await host.run("library_op", {}, new AbortController().signal); // an in-app turn
    expect(await toolCtx.store.resolveRef(secret)).toBeNull();
    expect(toolCtx.store.projectDir).toBe("C:/root/p9");
  });
});
