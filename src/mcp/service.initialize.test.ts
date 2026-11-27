// What an agent is told when it connects. Rust answers `initialize` itself, with the last instruction text the webview handed
// it (`mcp_set_instructions`) and, before that, with its own short fallback (FALLBACK_INSTRUCTIONS in src-tauri/src/mcp.rs; the
// Rust test `instructions_come_from_the_webview_once_it_supplies_them` holds that rule). An MCP client reads the instructions
// once, when it connects, so whatever a session is handed then is what it works under for its whole life.
//
// These drive the real start (`startMcpServer`: the bridge is wired, then the port is bound) and the real instructions,
// faking only Tauri's two IPC surfaces, the server's reply and the Rust side's one rule above.
import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { unmetConsent } from "../test/mcpConsent";

/** The fallback text exactly as the Rust source spells it (a `\` at a line's end continues the string without the newline
 *  and the next line's indentation). */
function rustFallback(): string {
  const source = readFileSync(path.resolve(__dirname, "../../src-tauri/src/mcp.rs"), "utf8");
  const found = /const FALLBACK_INSTRUCTIONS: &str = "((?:[^"\\]|\\[\s\S])*)";/.exec(source);
  if (!found) throw new Error("FALLBACK_INSTRUCTIONS was not found in src-tauri/src/mcp.rs");
  return found[1].replace(/\\\r?\n[ \t]*/g, "").replace(/\\(["\\])/g, "$1");
}

const rust = vi.hoisted(() => ({
  /** What `mcp_set_instructions` last handed over: what `initialize` is answered with once it is set. */
  held: null as string | null,
  /** What an agent connecting at the moment the port opened was handed. */
  atBind: null as string | null,
  commands: [] as string[],
}));
const server = vi.hoisted(() => ({
  release: null as ((text: string) => void) | null,
}));

vi.mock("../platform", () => ({
  platform: { name: "tauri", capabilities: { localTools: true, fileSystem: true }, apiBaseUrl: "" },
}));
vi.mock("../observability/sentry", () => ({ captureError: () => undefined }));
vi.mock("../api/appEvents", () => ({ reportMcpEvent: () => undefined }));
vi.mock("../api/auth", () => ({ hasSession: async () => true }));
// The server's shared prompt is on its way: a real round trip, which can take seconds on a slow or cold service.
vi.mock("../api/client", () => ({
  api: {
    instructions: () =>
      new Promise<{ instructions: string }>((resolve) => {
        server.release = (text) => resolve({ instructions: text });
      }),
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => undefined }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: { text?: string }) => {
    rust.commands.push(cmd);
    if (cmd === "mcp_set_instructions") rust.held = String(args?.text ?? "");
    if (cmd === "mcp_start") rust.atBind = rust.held ?? rustFallback();
    return { running: true, port: 19787 };
  },
}));

beforeEach(() => {
  vi.resetModules();
  rust.held = null;
  rust.atBind = null;
  rust.commands.length = 0;
  server.release = null;
});

describe("the instructions an agent is handed when it connects", () => {
  it("name every call to confirm first once the app has its prompt", async () => {
    const { startMcpServer } = await import("./service");
    await startMcpServer();
    await vi.waitFor(() => expect(server.release).not.toBeNull());
    server.release!("SHARED PROMPT");
    await vi.waitFor(() => expect(rust.held).toContain("SHARED PROMPT"));
    expect(unmetConsent(rust.held!)).toEqual([]);
    // And the two other things an outside session must hear in words: how to open a project, and that nothing will wake it.
    expect(rust.held).toMatch(/manage_project with action='list'/);
    expect(rust.held).toMatch(/NOTHING will tell you when one lands/);
  });

  it("the fallback is read from the Rust source, not invented here", () => {
    const fallback = rustFallback();
    // The one thing it does say: how to open a project. Proves the parse found the real text.
    expect(fallback).toMatch(/manage_project with action='list'/);
    expect(fallback).not.toMatch(/\\\s/);
  });

  // KNOWN BUG, kept as an expected failure. The port is bound as soon as the bridge is wired, but the instruction text is
  // only handed to Rust once the server's shared prompt has arrived (`refreshInstructions` in bridge.ts is not awaited). In
  // that gap Rust answers `initialize` with FALLBACK_INSTRUCTIONS, which names no paid tool, so an agent that connects then
  // (a client reconnecting the moment the app restarts after an update, say) is never told to ask before spending the
  // person's credits, for the whole of its session. When this passes, remove `.fails`.
  it.fails(
    "tell an agent that connects the moment the port opens which calls to confirm first",
    async () => {
      const { startMcpServer } = await import("./service");
      await startMcpServer();
      expect(rust.commands).toContain("mcp_start");
      expect(rust.atBind).not.toBeNull();
      expect(unmetConsent(rust.atBind!), "calls that agent is never told to confirm").toEqual([]);
    },
  );
});
