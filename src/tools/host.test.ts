import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectJobScope } from "../project/ProjectJobScope";
import { setOpenDocumentResolver } from "../project/openDocuments";
import { asProjectId } from "../project/types";

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

vi.mock("./dataRoot", () => ({
  boundProjectId: () => "",
  projectDirFor: (id: string) => projectDirFor(id),
}));
vi.mock("./tauri", () => ({ makeTauriContext: (d: string) => makeTauriContext(d) }));
vi.mock("./transcribe", () => ({ warmWhisperModel: vi.fn(async () => undefined) }));
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
});
