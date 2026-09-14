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

vi.mock("../platform", () => ({
  platform: { name: "tauri", capabilities: { localTools: true, fileSystem: true }, apiBaseUrl: "" },
}));

vi.mock("../observability/sentry", () => ({ captureError: () => undefined }));

vi.mock("./instructions", () => ({ mcpInstructions: async () => "instructions" }));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => {
    listens += 1;
    if (listenBehaviour === "throw") throw new Error("event system unavailable");
    if (listenBehaviour === "hang") return new Promise<never>(() => {});
    return () => undefined;
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    commands.push(cmd);
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
  listenBehaviour = "ok";
  listens = 0;
  commands.length = 0;
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
  });
});
