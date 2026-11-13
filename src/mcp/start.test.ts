// Starting the MCP server: the socket must never open unless the bridge behind it is wired.
//
// Rust blocks a connection thread waiting for the webview to answer each request, so a bound
// port with no listeners is worse than a refused connection — every tools/call an agent makes
// hangs until the call timeout instead of failing. These drive the real `startMcpServer`, faking
// only Tauri's two IPC surfaces, so the ordering rule is what is actually under test.
import { beforeEach, describe, expect, it, vi } from "vitest";

type ListenBehaviour = "ok" | "throw" | "hang";
let listenBehaviour: ListenBehaviour = "ok";
let listens = 0;
const commands: string[] = [];
const handlers = new Map<string, (event: { payload: unknown }) => void>();
const reported: Array<[string, unknown]> = [];

vi.mock("../platform", () => ({
  platform: { name: "tauri", capabilities: { localTools: true, fileSystem: true }, apiBaseUrl: "" },
}));

vi.mock("../observability/sentry", () => ({ captureError: () => undefined }));

vi.mock("../api/appEvents", () => ({
  reportMcpEvent: (event: string, detail: unknown) => void reported.push([event, detail]),
}));

vi.mock("./instructions", () => ({ mcpInstructions: async () => "instructions" }));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    listens += 1;
    if (listenBehaviour === "throw") throw new Error("event system unavailable");
    if (listenBehaviour === "hang") return new Promise<never>(() => {});
    handlers.set(name, handler);
    return () => undefined;
  },
}));

const replies: Array<{ id: number; payload: unknown }> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: { id?: number; payload?: unknown }) => {
    commands.push(cmd);
    if (cmd === "mcp_reply") replies.push({ id: Number(args?.id), payload: args?.payload });
    return { running: true, port: 19787 };
  },
}));

/** Resolves to "pending" if `p` has not settled — a hang has no other observable signature. */
async function settledWithin(
  p: Promise<unknown>,
  ms = 25,
): Promise<"resolved" | "rejected" | "pending"> {
  return Promise.race([
    p.then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    new Promise<"pending">((r) => setTimeout(() => r("pending"), ms)),
  ]);
}

beforeEach(() => {
  vi.resetModules(); // the bridge memoises its wiring for the life of the module
  vi.doUnmock("../store/auth");
  vi.doUnmock("../update/compatibility");
  listenBehaviour = "ok";
  listens = 0;
  commands.length = 0;
  replies.length = 0;
  handlers.clear();
  reported.length = 0;
});

describe("startMcpServer — the socket follows the bridge, never leads it", () => {
  it("binds once the bridge is wired", async () => {
    const { startMcpServer } = await import("./service");
    await expect(startMcpServer()).resolves.toEqual({ running: true, port: 19787 });
    expect(commands).toContain("mcp_start");
  });

  it("does NOT bind when the bridge cannot be wired", async () => {
    listenBehaviour = "throw";
    const { startMcpServer } = await import("./service");

    await expect(startMcpServer()).rejects.toThrow(/event system unavailable/);
    expect(commands).not.toContain("mcp_start");
  });

  it("does NOT bind while the subscription is still pending, however many callers ask", async () => {
    // The regression: wiring used to be guarded by a boolean set BEFORE its awaits, so a `listen`
    // that never settled left the module reading as "wired" with zero listeners registered. The
    // second caller sailed past it and bound the port — an agent could connect and then hang on
    // every single call, with the UI reporting the server as healthy.
    listenBehaviour = "hang";
    const { startMcpServer } = await import("./service");

    const first = startMcpServer();
    const second = startMcpServer();

    expect(await settledWithin(first)).toBe("pending");
    expect(await settledWithin(second)).toBe("pending");
    expect(commands).not.toContain("mcp_start");

    // Nothing is left unhandled when the test tears the module down.
    first.catch(() => undefined);
    second.catch(() => undefined);
  });

  it("retries the wiring after a failure instead of latching it off", async () => {
    listenBehaviour = "throw";
    const { startMcpServer } = await import("./service");
    await expect(startMcpServer()).rejects.toThrow();
    const attempted = listens;

    listenBehaviour = "ok";
    await expect(startMcpServer()).resolves.toEqual({ running: true, port: 19787 });
    expect(listens).toBeGreaterThan(attempted); // it really re-subscribed, not just re-bound
    expect(commands).toContain("mcp_start");
  });
});

describe("initMcp — a boot failure is recorded, not swallowed", () => {
  it("keeps the app running but leaves the reason retrievable", async () => {
    listenBehaviour = "throw";
    const { initMcp, mcpLastError } = await import("./service");

    await expect(initMcp()).resolves.toBeUndefined(); // never blocks boot
    expect(mcpLastError()).toMatch(/event system unavailable/);
  });

  it("reports no error once the server is up", async () => {
    const { initMcp, mcpLastError } = await import("./service");
    await initMcp();
    expect(mcpLastError()).toBeNull();
    expect(reported).toEqual([]);
  });

  it("says a taken port is a taken port, and anything else is 'other', without the raw message", async () => {
    const { mcpBindFailureReason } = await import("./service");
    expect(mcpBindFailureReason(new Error("could not bind: os error 10048"), "boot")).toBe(
      "port_in_use:boot",
    );
    expect(mcpBindFailureReason("Address already in use (EADDRINUSE)", "toggle")).toBe(
      "port_in_use:toggle",
    );
    expect(mcpBindFailureReason(new Error("access denied for C:\\Users\\ada"), "boot")).toBe(
      "other:boot",
    );
    expect(mcpBindFailureReason(undefined, "toggle")).toBe("other:toggle");
  });

  it("tells the telemetry once when the boot could not start the server, with a closed reason", async () => {
    listenBehaviour = "throw";
    const { initMcp } = await import("./service");
    await initMcp();
    expect(reported).toEqual([["mcp_bind_failed", { reason: "other:boot" }]]);
    expect(JSON.stringify(reported)).not.toMatch(/event system unavailable/);
  });
});

describe("a program connecting is recorded by what it announced", () => {
  async function connect(payload: unknown) {
    const { startMcpServer } = await import("./service");
    await startMcpServer();
    const handler = handlers.get("artdaddy://mcp-session");
    expect(handler, "the bridge listens for connecting programs").toBeDefined();
    handler!({ payload });
  }

  it("reports its label, its own name and its version", async () => {
    await connect({ session: "artdaddy-1", client: { name: "claude-code", version: "2.1.0" } });
    expect(reported).toEqual([
      ["mcp_connected", { client: "claude_code", reason: "claude-code 2.1.0" }],
    ]);
  });

  it("reports a program it does not know as 'other', under its own name, so it can be found", async () => {
    await connect({ session: "s", client: { name: "Brand New Agent", version: "0.1" } });
    expect(reported).toEqual([
      ["mcp_connected", { client: "other", reason: "Brand_New_Agent 0.1" }],
    ]);
  });

  it("reports a program that said nothing as unknown, and a payload that is not an object without failing", async () => {
    await connect({ session: "s" });
    await connect(undefined);
    await connect("garbage");
    expect(
      reported.map(([event, detail]) => [event, (detail as { client: string }).client]),
    ).toEqual([
      ["mcp_connected", "unknown"],
      ["mcp_connected", "unknown"],
      ["mcp_connected", "unknown"],
    ]);
  });
});

// A person who has just pasted the setup into an agent should be able to SEE that it worked: the panel and the chat chip
// read this list, which is fed from the same two events the telemetry above is.
describe("the list of connected programs follows what connects", () => {
  const SESSION = "artdaddy://mcp-session";
  const REQUEST = "artdaddy://mcp-request";
  const claude = { name: "claude-code", version: "2.1.0" };

  async function wired() {
    const service = await import("./service");
    const { useMcpConnections } = await import("./connections");
    await service.startMcpServer();
    return { ...service, useMcpConnections };
  }

  it("lists a program the moment it connects, and counts what it then asks for, whatever becomes of the request", async () => {
    const { useMcpConnections } = await wired();

    handlers.get(SESSION)!({ payload: { session: "s1", client: claude } });
    expect(useMcpConnections.getState().programs).toMatchObject([
      { client: "claude_code", version: "2.1.0", requests: 0 },
    ]);

    // The request is counted as it arrives, before anything decides whether it can be answered.
    handlers.get(REQUEST)!({
      payload: { id: 1, method: "tools/list", params: {}, client: claude },
    });
    handlers.get(REQUEST)!({
      payload: { id: 2, method: "tools/call", params: { name: "no_such_tool" }, client: claude },
    });
    expect(useMcpConnections.getState().programs).toMatchObject([
      { client: "claude_code", requests: 2 },
    ]);
  });

  it("lists a program that asks through a restarted app, which never saw it connect", async () => {
    const { useMcpConnections } = await wired();
    handlers.get(REQUEST)!({ payload: { id: 7, method: "tools/list", params: {} } });
    expect(useMcpConnections.getState().programs).toMatchObject([
      { client: "unknown", requests: 1 },
    ]);
  });

  it("empties the list when the server is switched off, so nobody is shown as connected to a server that is down", async () => {
    const { stopMcpServer, useMcpConnections } = await wired();
    handlers.get(SESSION)!({ payload: { session: "s1", client: claude } });
    expect(useMcpConnections.getState().programs).toHaveLength(1);

    await stopMcpServer();

    expect(useMcpConnections.getState().programs).toEqual([]);
  });

  it("does not list anything when the server was never reached by a program", async () => {
    const { useMcpConnections } = await wired();
    expect(useMcpConnections.getState().programs).toEqual([]);
  });

  // UJ-085: what a program was ANSWERED with is read from the payload the bridge hands back to Rust, in the real request handler, so deleting the
  // recording there fails these (the pure functions are tested elsewhere).
  // The tauri platform this file fakes has its own gates; open them (or close the sign-in one) on purpose, so a refusal is the one a test asked for.
  const gates = (signedOut: boolean) => {
    vi.doMock("../store/auth", () => ({
      isSignedOutGate: () => signedOut,
      useAuth: {
        getState: () => ({
          status: signedOut ? "locked" : "unlocked",
          hasStoredSession: !signedOut,
        }),
        subscribe: () => () => undefined,
      },
    }));
    vi.doMock("../update/compatibility", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../update/compatibility")>()),
      compatibilityAllowsWork: () => true,
    }));
  };

  it("records a tool list that carried tools from the very payload it sends back, and sends it unchanged", async () => {
    gates(false);
    const { useMcpConnections } = await wired();
    handlers.get(REQUEST)!({
      payload: { id: 41, method: "tools/list", params: {}, client: claude },
    });
    await vi.waitFor(() => expect(replies.map((r) => r.id)).toEqual([41]));
    expect(Object.keys(replies[0].payload as object)).toEqual(["tools"]);
    expect(useMcpConnections.getState().programs[0]).toMatchObject({
      requests: 1,
      lists: 1,
      calls: 0,
    });
  });

  it("does not count a reply that says nothing ran: a tool list refused because the app is signed out stays an asked-for request", async () => {
    gates(true);
    const { useMcpConnections } = await wired();
    handlers.get(REQUEST)!({
      payload: { id: 42, method: "tools/list", params: {}, client: claude },
    });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(Object.keys(replies[0].payload as object).sort()).toEqual(["content", "isError"]);
    expect(useMcpConnections.getState().programs[0]).toMatchObject({ requests: 1, lists: 0 });
  });

  it("a recorder that throws can never stall or alter the reply the program is waiting for", async () => {
    gates(false);
    const { useMcpConnections } = await wired();
    useMcpConnections.setState({
      answered: () => {
        throw new Error("boom");
      },
    });
    handlers.get(REQUEST)!({
      payload: { id: 43, method: "tools/list", params: {}, client: claude },
    });
    await vi.waitFor(() => expect(replies.map((r) => r.id)).toEqual([43]));
    expect(Object.keys(replies[0].payload as object)).toEqual(["tools"]);
  });
});
