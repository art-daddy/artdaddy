// Which programs have connected to the MCP server during this run, and when each last asked for something.
//
// A person who adds the server to Claude Code, Cursor or Codex has no way to tell whether it worked: over HTTP a
// connection is a handful of short requests, nothing the app can show as "plugged in". Nine people set one up from the
// panel and only two were ever seen connecting. So the app says what it knows: which program announced itself, when it
// last asked for anything and how many times, and says plainly when nobody has yet.
//
// Kept in memory only, and about PROGRAMS, never the person: a label from the closed list, the name and version the
// program announced (cut to the name alphabet), a count and two times.
import { create } from "zustand";

import {
  MCP_CLIENT_TITLES,
  mcpClientFacts,
  type McpClient,
  type McpClientFacts,
} from "./clientName";

/** The most programs listed at once. A name is whatever a local program announces, so the list must not grow without bound. */
export const MAX_CONNECTED_PROGRAMS = 8;

/** A program that asked for something within this long is shown as connected; an older one as seen earlier. A connection
 *  here is a few short requests, so "connected" can only mean "has been asking lately". */
export const ACTIVE_WINDOW_MS = 10 * 60_000;

export interface ConnectedProgram {
  /** One program, as it announced itself: `name|version`. */
  key: string;
  client: McpClient;
  name: string;
  version: string;
  connectedAt: number;
  lastActiveAt: number;
  /** The tool lists and tool calls it has asked for. */
  requests: number;
}

const keyOf = (facts: McpClientFacts): string =>
  facts.client === "unknown" ? "unknown" : `${facts.name}|${facts.version}`;

/** The list after a program was heard from, most recently active first. Past the cap the least recent one goes. */
function heardFrom(
  programs: readonly ConnectedProgram[],
  info: unknown,
  now: number,
  asked: boolean,
): ConnectedProgram[] {
  const facts = mcpClientFacts(info);
  const key = keyOf(facts);
  const before = programs.find((p) => p.key === key);
  const program: ConnectedProgram = before
    ? { ...before, lastActiveAt: now, requests: before.requests + (asked ? 1 : 0) }
    : {
        key,
        client: facts.client,
        name: facts.name,
        version: facts.version,
        connectedAt: now,
        lastActiveAt: now,
        requests: asked ? 1 : 0,
      };
  return [program, ...programs.filter((p) => p.key !== key)].slice(0, MAX_CONNECTED_PROGRAMS);
}

interface ConnectionsState {
  programs: ConnectedProgram[];
  /** A program announced itself (`initialize`). */
  connected: (info: unknown, now?: number) => void;
  /** A program asked for something; the announcement rides along on each request. */
  asked: (info: unknown, now?: number) => void;
  /** The server was switched off: nobody is connected to it any more. */
  clear: () => void;
}

export const useMcpConnections = create<ConnectionsState>((set) => ({
  programs: [],
  connected: (info, now = Date.now()) =>
    set((s) => ({ programs: heardFrom(s.programs, info, now, false) })),
  asked: (info, now = Date.now()) =>
    set((s) => ({ programs: heardFrom(s.programs, info, now, true) })),
  clear: () => set({ programs: [] }),
}));

/** What the panel calls a program: its own name when it has no label of its own. */
export function programTitle(program: Pick<ConnectedProgram, "client" | "name">): string {
  return program.client === "other" && program.name
    ? program.name
    : MCP_CLIENT_TITLES[program.client];
}

export const isActive = (program: ConnectedProgram, now: number): boolean =>
  now - program.lastActiveAt <= ACTIVE_WINDOW_MS;

/** How long ago, in words a person reads at a glance. Never throws, never empty: a clock that moved backwards is "just now". */
export function agoLabel(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.floor(Math.max(0, elapsedMs) / 1000) : 0;
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}
