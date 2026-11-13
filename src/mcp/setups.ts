// Which apps the person has written a setup for, and when, so the panel can say when a setup has produced no connection.
//
// Eight of the eleven people who set up Claude Desktop, Cursor, VS Code or Claude Code never connected, and nothing on screen said
// so. Kept in memory for this run only: a nudge for a few minutes is not worth a file on the person's PC, and it names an app, never
// the person.
import { create } from "zustand";

import { agoLabel } from "./connections";
import type { McpClient } from "./clientName";

/** How long a setup may produce nothing before the panel says so. */
export const SETUP_HINT_AFTER_MS = 3 * 60_000;

interface SetupsState {
  written: Partial<Record<McpClient, number>>;
  /** A setup was copied or installed for this kind of app (a later one replaces the time). */
  wrote: (client: McpClient, now?: number) => void;
  clear: () => void;
}

export const useMcpSetups = create<SetupsState>((set) => ({
  written: {},
  wrote: (client, now = Date.now()) => set((s) => ({ written: { ...s.written, [client]: now } })),
  clear: () => set({ written: {} }),
}));

/** The next step for an app whose setup is not finished by pasting it: the owner's sheet, except Antigravity's, which was read from its install. */
export const NEXT_STEP: Partial<Record<McpClient, string>> = {
  claude_desktop: "Open Settings → Extensions, install artdaddy.mcpb, then restart Claude Desktop.",
  vscode:
    "Confirm VS Code's “Install MCP server” prompt, then start the server from the Chat tools list.",
  cursor: "Accept Cursor's install prompt, then switch artdaddy on under Settings → MCP.",
  claude_code: "Run the command in a terminal, then start a new Claude Code session.",
  codex: "Run the command in a terminal, then start a new Codex session.",
  antigravity: "Add the snippet to ~/.gemini/config/mcp_config.json, then restart Antigravity.",
};

/** What to tell the person about a setup that has produced nothing: null while it is too young, while the server is off (the panel already says to turn it on), for an app with no
 *  setup written, and once any program of that kind has connected at any time in this run (`seen` survives a switch-off). The three minutes are counted from the later of the
 *  setup and the server coming up: an app cannot connect to a server that is down. */
export function setupHint(
  client: McpClient,
  writtenAt: number | undefined,
  serverOnSince: number | null,
  seen: Partial<Record<McpClient, true>>,
  now: number,
  running: boolean,
): { ago: string; next: string } | null {
  if (!running || writtenAt === undefined) return null;
  if (now - Math.max(writtenAt, serverOnSince ?? writtenAt) < SETUP_HINT_AFTER_MS) return null;
  if (seen[client]) return null;
  const next = NEXT_STEP[client];
  return next ? { ago: agoLabel(now - writtenAt), next } : null;
}
