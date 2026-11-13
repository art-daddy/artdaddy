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
  /** Everything it has asked for, answered or refused. */
  requests: number;
  /** The replies to its `tools/list` that really carried tools (a refusal is a text error with none). */
  lists: number;
  /** When the first such reply went out. */
  listedAt: number | null;
  /** The tool calls that got past the door and reached a tool (the tool itself may still have failed). */
  calls: number;
  lastCallAt: number | null;
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
        lists: 0,
        listedAt: null,
        calls: 0,
        lastCallAt: null,
      };
  return [program, ...programs.filter((p) => p.key !== key)].slice(0, MAX_CONNECTED_PROGRAMS);
}

/** What a program was ANSWERED with: a tool list that carried tools, or a tool call that got past the door. */
export type McpAnswer = "list" | "call";

/** The list after a program was answered. A program that is not listed (it fell off the cap meanwhile) is not brought back by an answer. */
function answeredTo(
  programs: readonly ConnectedProgram[],
  info: unknown,
  answer: McpAnswer,
  now: number,
): ConnectedProgram[] {
  const key = keyOf(mcpClientFacts(info));
  return programs.map((p) =>
    p.key !== key
      ? p
      : answer === "list"
        ? { ...p, lists: p.lists + 1, listedAt: p.listedAt ?? now }
        : { ...p, calls: p.calls + 1, lastCallAt: now },
  );
}

interface ConnectionsState {
  programs: ConnectedProgram[];
  /** The kinds of program heard from at any time in this run. Unlike `programs` it survives a switch-off, so "nothing from X has connected" is never said of an app that did. */
  seen: Partial<Record<McpClient, true>>;
  /** A program announced itself (`initialize`). */
  connected: (info: unknown, now?: number) => void;
  /** A program asked for something; the announcement rides along on each request. */
  asked: (info: unknown, now?: number) => void;
  /** A program was answered: it got a tool list with tools in it, or a tool call reached a tool. */
  answered: (info: unknown, answer: McpAnswer, now?: number) => void;
  /** The server was switched off: nobody is connected to it any more (the kinds seen in this run are kept). */
  clear: () => void;
  /** Forget everything, the kinds seen included (tests: a new run starts empty anyway). */
  reset: () => void;
}

const seenWith = (seen: ConnectionsState["seen"], info: unknown): ConnectionsState["seen"] => {
  const { client } = mcpClientFacts(info);
  return seen[client] ? seen : { ...seen, [client]: true };
};

export const useMcpConnections = create<ConnectionsState>((set) => ({
  programs: [],
  seen: {},
  connected: (info, now = Date.now()) =>
    set((s) => ({
      programs: heardFrom(s.programs, info, now, false),
      seen: seenWith(s.seen, info),
    })),
  asked: (info, now = Date.now()) =>
    set((s) => ({
      programs: heardFrom(s.programs, info, now, true),
      seen: seenWith(s.seen, info),
    })),
  answered: (info, answer, now = Date.now()) =>
    set((s) => ({ programs: answeredTo(s.programs, info, answer, now) })),
  clear: () => set({ programs: [] }),
  reset: () => set({ programs: [], seen: {} }),
}));

/** How long a program may hold the tool list without a completed tool call before the panel says so. */
export const LISTED_WARNING_AFTER_MS = 3 * 60_000;

/** A program that was given the tool list at least three minutes ago, is still being heard from, and has used no tool. */
export const holdsToolListTooLong = (p: ConnectedProgram, now: number): boolean =>
  programState(p) === "listed" &&
  p.listedAt !== null &&
  now - p.listedAt >= LISTED_WARNING_AFTER_MS &&
  isActive(p, now);

/** What a program has been seen to do, and nothing more: it said hello, it was given the tool list, it used a tool. The one place a state word comes from. */
export type ProgramState = "connected" | "listed" | "used";

export const programState = (p: Pick<ConnectedProgram, "lists" | "calls">): ProgramState =>
  p.calls > 0 ? "used" : p.lists > 0 ? "listed" : "connected";

const STATE_RANK: Record<ProgramState, number> = { connected: 0, listed: 1, used: 2 };

/** The program a one-line summary speaks about: the one that got furthest, and among equals the one heard from last. */
export function leadProgram<P extends ConnectedProgram>(programs: readonly P[]): P | undefined {
  let lead: P | undefined;
  for (const p of programs) {
    if (!lead) lead = p;
    else {
      const [a, b] = [STATE_RANK[programState(p)], STATE_RANK[programState(lead)]];
      if (a > b || (a === b && p.lastActiveAt > lead.lastActiveAt)) lead = p;
    }
  }
  return lead;
}

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
