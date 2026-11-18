// The Export dialog's pick of Quality or Fast travels to the `export` tool in the tool's context, as the Mode row's pick does (host.test.ts): to the tool that runs now and to the
// work it hands off (the detached context a Try again and the app's own restart run on), never retained on the host between runs, never leaking from one run into an overlapping one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setOpenDocumentResolver } from "../project/openDocuments";
import { ClientToolRegistry } from "./registry";
import { __resetAgentEvents } from "../api/agentEvents";
import { useAuth } from "../store/auth";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const projectDirFor = vi.fn(async (id: string) => `/root/${id}`);
const makeTauriContext = vi.fn(async (_dir: string) => ({
  store: {} as never,
  runner: {} as never,
}));
let toolGate: Promise<Any> = Promise.resolve({ ok: true });
let toolCtx: Any = null;

vi.mock("./dataRoot", async (orig) => ({
  ...(await orig<typeof import("./dataRoot")>()),
  projectDirFor: (id: string) => projectDirFor(id),
}));
vi.mock("./tauri", () => ({ makeTauriContext: (d: string) => makeTauriContext(d) }));
vi.mock("../timeline/engine", () => ({ ensureTimeline: vi.fn(async () => undefined) }));
vi.mock("../api/auth", () => ({
  hasSession: async () => true,
  authedFetch: (
    url: string,
    init: RequestInit = {},
    send: (url: string, init: RequestInit) => Promise<Response> = (target, request) =>
      fetch(target, request),
  ) => send(url, init),
}));
vi.mock(".", () => ({
  createToolRegistry: (getCtx: () => Any) => {
    const registry = new ClientToolRegistry();
    registry.register("export", async () => {
      toolCtx = getCtx();
      return toolGate;
    });
    return registry;
  },
}));

import { closeToolHost, openToolHost } from "./host";

const FAST = { route: "quick", explicit: { size: false, fps: true, quality: false } } as const;
const QUALITY = { route: "standard" } as const;

beforeEach(() => {
  __resetAgentEvents();
  useAuth.setState({ status: "unlocked", profile: null, hasStoredSession: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 200 })),
  );
  toolGate = Promise.resolve({ ok: true });
  toolCtx = null;
});
afterEach(() => {
  __resetAgentEvents();
  vi.unstubAllGlobals();
  closeToolHost();
  setOpenDocumentResolver(() => undefined);
  vi.clearAllMocks();
});

describe("the route the person chose in the Export dialog reaches the export tool", () => {
  it.each([FAST, QUALITY])(
    "forwards %j into the active and the detached tool context",
    async (exportRoute) => {
      const host = openToolHost("route-project");
      await host.run(
        "export",
        {},
        { surface: "app", signal: new AbortController().signal, exportRoute },
      );
      expect(toolCtx.exportRoute).toEqual(exportRoute);
      expect(toolCtx.detach().exportRoute).toEqual(exportRoute);
    },
  );

  it("gives each overlapping run its own route, and leaves an export that was not given one without", async () => {
    const host = openToolHost("route-project");
    await host.ready;
    let release!: (value: unknown) => void;
    toolGate = new Promise((resolve) => {
      release = resolve;
    });
    const fast = host.run(
      "export",
      {},
      { surface: "app", signal: new AbortController().signal, exportRoute: FAST },
    );
    await vi.waitFor(() => expect(toolCtx).not.toBeNull());
    const fastContext = toolCtx;
    toolCtx = null;
    const plain = host.run("export", {}, { surface: "mcp", signal: new AbortController().signal });
    await vi.waitFor(() => expect(toolCtx).not.toBeNull());
    const plainContext = toolCtx;
    release({ ok: true });
    await Promise.all([fast, plain]);
    expect(fastContext.exportRoute).toEqual(FAST);
    expect(plainContext.exportRoute).toBeUndefined();
    expect(plainContext.detach().exportRoute).toBeUndefined();
  });

  it("does not retain a route after a failed tool, or put it on the cached base context", async () => {
    const host = openToolHost("route-failed-project");
    await host.ready;
    const base = await makeTauriContext.mock.results.at(-1)!.value;
    let fail!: (reason: Error) => void;
    toolGate = new Promise((_, reject) => {
      fail = reject;
    });
    const pending = host.run(
      "export",
      {},
      { surface: "app", signal: new AbortController().signal, exportRoute: FAST },
    );
    await vi.waitFor(() => expect(toolCtx?.exportRoute).toEqual(FAST));
    fail(new Error("controlled export failure"));
    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(base).not.toHaveProperty("exportRoute");
    toolGate = Promise.resolve({ ok: true });
    await host.run("export", {}, { surface: "mcp" });
    expect(toolCtx.exportRoute).toBeUndefined();
  });
});
