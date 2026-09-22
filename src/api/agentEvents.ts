// What the agent actually DID: every tool call it made, every one the user refused, and the
// answer it finally gave.
//
// The agent loop runs here, not on the server, so a tool call that failed, was denied, or
// returned nothing leaves no trace anywhere. The spend ledger records that a round happened
// and nothing about whether it worked -- which is why a user could burn credits, produce no
// video, and leave behind a row indistinguishable from a successful session.
//
// Batched, not per-event: the analytics container shares the credit ledger's single 1000 RU/s
// pool and that ledger fails CLOSED, so a write per tool call would let a busy turn deny
// somebody else's paid request. Every event still survives; they just travel together.
//
// Carries NO identity: the server takes that from the authenticated request.
import { apiBase } from "./config";
import { authHeaders } from "./auth";
import { hostInfo } from "../platform/host";

export type AgentEventKind = "tool_call" | "tool_denied" | "agent_output";

export interface AgentEvent {
  kind: AgentEventKind;
  at: number;
  name?: string;
  call_id?: string;
  ok?: boolean;
  ms?: number;
  args?: string;
  result?: string;
  error?: string;
  text?: string;
}

/** Matches AgentEventItem on the server. Truncating HERE as well keeps a pathological
 *  tool result from sitting in memory until the flush. */
const MAX_ARGS = 2_000;
const MAX_RESULT = 2_000;
const MAX_TEXT = 20_000;
/** Server caps a batch at 50; flushing at that size means a batch is never silently dropped. */
const FLUSH_AT = 50;

let buffer: AgentEvent[] = [];
let context = { surface: "app", model: "", project_id: "", transcript_id: "" };

export function setAgentContext(next: Partial<typeof context>): void {
  context = { ...context, ...next };
}

/** Serialise a tool payload for storage. Unstringifiable input is recorded as such rather
 *  than thrown away: "the model sent something circular" is itself the finding. */
export function preview(value: unknown, cap: number): string {
  if (value === undefined) return "";
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return (text ?? "").slice(0, cap);
  } catch {
    return "[unserialisable]";
  }
}

function push(ev: AgentEvent): void {
  buffer.push(ev);
  if (buffer.length >= FLUSH_AT) void flushAgentEvents();
}

export function recordToolCall(ev: {
  name: string;
  call_id?: string;
  ok: boolean;
  ms: number;
  args?: unknown;
  result?: unknown;
  error?: string;
}): void {
  push({
    kind: "tool_call",
    at: Date.now() / 1000,
    name: ev.name,
    call_id: ev.call_id ?? "",
    ok: ev.ok,
    ms: Math.max(0, Math.round(ev.ms)),
    args: preview(ev.args, MAX_ARGS),
    result: preview(ev.result, MAX_RESULT),
    error: (ev.error ?? "").slice(0, 500),
  });
}

export function recordToolDenied(name: string, callId: string, reason = ""): void {
  push({
    kind: "tool_denied",
    at: Date.now() / 1000,
    name,
    call_id: callId,
    ok: false,
    ms: 0,
    error: reason.slice(0, 500),
  });
}

export function recordAgentOutput(text: string): void {
  if (!text) return;
  push({ kind: "agent_output", at: Date.now() / 1000, text: text.slice(0, MAX_TEXT) });
}

/** Send whatever is buffered. Never throws and never blocks a turn. */
export async function flushAgentEvents(): Promise<void> {
  if (buffer.length === 0) return;
  // Taken BEFORE the await so events recorded during the request join the next batch
  // instead of being dropped by a concurrent flush.
  const events = buffer;
  buffer = [];
  try {
    const auth = await authHeaders();
    // Nobody to attribute it to: the server takes identity from the request, so an
    // unauthenticated flush is a guaranteed 401 carrying data we could not file anyway.
    if (!auth.Authorization) return;
    const { os, arch } = hostInfo();
    await fetch(`${apiBase()}/telemetry/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        events,
        surface: context.surface,
        model: context.model,
        project_id: context.project_id,
        transcript_id: context.transcript_id,
        os,
        arch,
        app_version: __ARTDADDY_RELEASE__,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Offline, signed out, server down. A trace is never worth a visible failure, and
    // retrying would grow unboundedly in exactly the conditions that caused the failure.
  }
}

/** Tests only. */
export function __resetAgentEvents(): void {
  buffer = [];
  context = { surface: "app", model: "", project_id: "", transcript_id: "" };
}

/** Tests only. */
export function __bufferedAgentEvents(): AgentEvent[] {
  return [...buffer];
}
