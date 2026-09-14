// Starting and stopping the local MCP server, and remembering whether the user wants it.
//
// Default ON (matching established desktop NLEs): the whole point is that an
// external agent can connect without the user first hunting for a setting. It binds to loopback
// only, so "on by default" does not expose anything to the network.
import { platform } from "../platform";
import { captureError } from "../observability/sentry";
import { startMcpBridge } from "./bridge";

export const MCP_PORT = 19787;
const PREF_KEY = "artdaddy.mcp.enabled";

export interface McpStatus {
  running: boolean;
  port: number;
}

export function mcpEnabledPreference(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setMcpEnabledPreference(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? "true" : "false");
  } catch {
    /* private mode: the preference just won't persist */
  }
}

async function core() {
  return (await import("@tauri-apps/api/core")).invoke;
}

export async function mcpStatus(): Promise<McpStatus> {
  if (platform.name !== "tauri") return { running: false, port: MCP_PORT };
  try {
    const invoke = await core();
    return await invoke<McpStatus>("mcp_status");
  } catch {
    return { running: false, port: MCP_PORT };
  }
}

export async function startMcpServer(): Promise<McpStatus> {
  if (platform.name !== "tauri") return { running: false, port: MCP_PORT };
  // The bridge must be listening BEFORE the socket accepts anyone: a client that connects first
  // would have its tools/list time out against a bridge nobody is answering.
  await startMcpBridge();
  const invoke = await core();
  return await invoke<McpStatus>("mcp_start", { port: MCP_PORT });
}

export async function stopMcpServer(): Promise<McpStatus> {
  if (platform.name !== "tauri") return { running: false, port: MCP_PORT };
  const invoke = await core();
  return await invoke<McpStatus>("mcp_stop");
}

let lastError: string | null = null;

/** Why the server is not running, when the preference says it should be. The panel shows this:
 *  a boot failure used to reach only `console.warn`, which no user opens and which release
 *  builds did not even write to the log file. */
export function mcpLastError(): string | null {
  return lastError;
}

export function clearMcpLastError(): void {
  lastError = null;
}

export function recordMcpError(e: unknown): string {
  lastError = (e as Error)?.message ?? String(e);
  return lastError;
}

/** Boot hook: honour the preference. A failure here must never block the app — the editor works
 *  perfectly well with no external agent attached — but it must not be silent either. */
export async function initMcp(): Promise<void> {
  if (platform.name !== "tauri" || !mcpEnabledPreference()) return;
  try {
    await startMcpServer();
    clearMcpLastError();
  } catch (e) {
    captureError(e, { where: "initMcp" });
    console.warn("[mcp] server did not start; external agents cannot connect", recordMcpError(e));
  }
}
