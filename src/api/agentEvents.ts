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
// somebody else's paid request. Unsent batches can still be lost on an outage or forced exit.
//
// Carries NO identity: the server takes that from the authenticated request.
import { apiBase } from "./config";
import { reportExport } from "./exportEvents";
import { authedFetch, hasSession } from "./auth";
import { hostInfo } from "../platform/host";
import { useAuth } from "../store/auth";

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

export interface AgentEventContext {
  surface: string;
  model: string;
  project_id: string;
  transcript_id: string;
  readonly generation: number;
}

let context: Omit<AgentEventContext, "generation"> = {
  surface: "app",
  model: "",
  project_id: "",
  transcript_id: "",
};
let buffer: { event: AgentEvent; context: AgentEventContext }[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;
let offAuth: (() => void) | null = null;
const deliveries = new Set<AbortController>();
const inFlight = new Set<Promise<void>>();

function discardSessionEvents(): void {
  generation += 1;
  buffer = [];
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  for (const controller of deliveries) controller.abort();
}

function watchSession(): void {
  if (offAuth) return;
  const initial = useAuth.getState();
  let owner = initial.profile?.user_id ?? "";
  let stored = initial.hasStoredSession;
  offAuth = useAuth.subscribe((state) => {
    const user = state.profile?.user_id ?? "";
    const signedOut =
      state.status === "locked" || (state.status === "offline" && !state.hasStoredSession);
    if (signedOut || (user && owner && user !== owner) || (stored && !state.hasStoredSession)) {
      discardSessionEvents();
    }
    if (signedOut) owner = "";
    else if (user) owner = user;
    stored = state.hasStoredSession;
  });
}

export function agentEventContext(): AgentEventContext {
  watchSession();
  return { ...context, generation };
}

export function setAgentContext(next: Partial<typeof context>): void {
  context = { ...context, ...next };
}

export interface ExportRefusalFacts {
  readonly status: "blocked" | "declined" | "cancelled";
  readonly width?: number;
  readonly height?: number;
  readonly visual_layers?: number;
}

export interface ToolTrace {
  readonly context: Readonly<AgentEventContext>;
  result: (value: unknown) => void;
  error: (error: unknown) => void;
}

export function createToolTrace(
  name: string,
  args: unknown,
  labels: AgentEventContext,
  callId = "",
): ToolTrace {
  const captured = Object.freeze({ ...labels });
  const submittedArgs = preview(args, MAX_ARGS);
  const started = Date.now();
  let recorded = false;
  const result = (value: unknown): void => {
    if (recorded) return;
    recorded = true;
    const object =
      value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
    const failed = object?.ok === false || object?.isError === true;
    if (name === "export" && failed) {
      const request = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
      const lists = [request.media_refs, request.clip_ids];
      const valid = lists.every((list) => list === undefined || Array.isArray(list) && list.every((item) => typeof item === "string" && item.trim()));
      const operations: ("render" | "copy" | "unknown")[] = valid ? lists.flatMap((list, index) =>
        Array.isArray(list) ? Array.from(new Set(list.map((item: string) => item.trim())), () => index === 0 ? "copy" as const : "render" as const) : []) : ["unknown"];
      if (!operations.length) operations.push("render");
      const requested = Math.min(50, operations.length);
      const admitted = Array.isArray(object?.exports)
        ? new Set(object.exports.filter((item) => item && typeof item.job_id === "string").map((item) => item.job_id)).size : 0;
      const facts = object?.export_refusal as ExportRefusalFacts | undefined;
      for (let index = admitted; index < requested; index++) {
        try {
          void reportExport({ status: facts?.status ?? "blocked", elapsed_ms: Date.now() - started,
            operation: operations[index],
            error: String(object?.error ?? ""), readiness: "unknown", width: facts?.width, height: facts?.height,
            visual_layers: facts?.visual_layers }).catch(() => undefined);
        } catch {}
      }
    }
    recordToolCall(
      {
        name,
        call_id: callId,
        ok: !failed,
        ms: Date.now() - started,
        args: submittedArgs,
        result: value,
        error: failed ? preview(object?.error ?? value, 500) : "",
      },
      captured,
    );
  };
  return {
    context: captured,
    result,
    error: (error) =>
      result({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  };
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

function push(ev: AgentEvent, labels: AgentEventContext): void {
  const session = useAuth.getState();
  if (session.status === "locked" || (session.status === "offline" && !session.hasStoredSession))
    return;
  if (labels.generation !== generation) return;
  buffer.push({ event: ev, context: { ...labels } });
  if (buffer.length >= FLUSH_AT) void flushAgentEvents();
  else if (!flushTimer) {
    flushTimer = setTimeout(() => void flushAgentEvents(), 5_000);
    (flushTimer as { unref?: () => void }).unref?.();
  }
}

export function recordToolCall(
  ev: {
    name: string;
    call_id?: string;
    ok: boolean;
    ms: number;
    args?: unknown;
    result?: unknown;
    error?: string;
  },
  labels: AgentEventContext = agentEventContext(),
): void {
  push(
    {
      kind: "tool_call",
      at: Date.now() / 1000,
      name: ev.name,
      call_id: ev.call_id ?? "",
      ok: ev.ok,
      ms: Math.max(0, Math.round(ev.ms)),
      args: preview(ev.args, MAX_ARGS),
      result: preview(ev.result, MAX_RESULT),
      error: (ev.error ?? "").slice(0, 500),
    },
    labels,
  );
}

export function recordToolDenied(
  name: string,
  callId: string,
  reason = "",
  labels: AgentEventContext = agentEventContext(),
): void {
  push(
    {
      kind: "tool_denied",
      at: Date.now() / 1000,
      name,
      call_id: callId,
      ok: false,
      ms: 0,
      error: reason.slice(0, 500),
    },
    labels,
  );
}

export function recordAgentOutput(
  text: string,
  labels: AgentEventContext = agentEventContext(),
): void {
  if (!text) return;
  push({ kind: "agent_output", at: Date.now() / 1000, text: text.slice(0, MAX_TEXT) }, labels);
}

/** Send whatever is buffered. Never throws and never blocks a turn. */
export async function flushAgentEvents(): Promise<void> {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (buffer.length === 0) return;
  // Taken BEFORE the await so events recorded during the request join the next batch
  // instead of being dropped by a concurrent flush.
  const pending = buffer;
  buffer = [];
  const groups: { context: AgentEventContext; events: AgentEvent[] }[] = [];
  for (const item of pending) {
    const previous = groups.at(-1);
    if (
      previous &&
      JSON.stringify(previous.context) === JSON.stringify(item.context) &&
      previous.events.length < FLUSH_AT
    )
      previous.events.push(item.event);
    else groups.push({ context: item.context, events: [item.event] });
  }
  const delivery = deliverAgentEvents(groups);
  inFlight.add(delivery);
  try {
    await delivery;
  } finally {
    inFlight.delete(delivery);
  }
}

async function deliverAgentEvents(
  groups: { context: AgentEventContext; events: AgentEvent[] }[],
): Promise<void> {
  const controller = new AbortController();
  deliveries.add(controller);
  const timeout = setTimeout(() => controller.abort(), 10_000);
  (timeout as { unref?: () => void }).unref?.();
  try {
    // Nobody to attribute it to: the server takes identity from the request, so an
    // unauthenticated flush is a guaranteed 401 carrying data we could not file anyway.
    if (!(await hasSession()) || controller.signal.aborted) return;
    const { os, arch } = hostInfo();
    for (const group of groups)
      await authedFetch(
        `${apiBase()}/telemetry/agent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            events: group.events,
            surface: group.context.surface,
            model: group.context.model,
            project_id: group.context.project_id,
            transcript_id: group.context.transcript_id,
            os,
            arch,
            app_version: __ARTDADDY_RELEASE__,
          }),
          signal: controller.signal,
        },
        (url, init) => {
          if (controller.signal.aborted || group.context.generation !== generation) {
            throw new Error("trace session ended before delivery");
          }
          const body = JSON.parse(init.body as string) as Record<string, unknown>;
          return fetch(url, {
            ...init,
            body: JSON.stringify({ ...body, sent_at: Date.now() / 1000 }),
          });
        },
      );
  } catch {
    // Offline, signed out, server down. A trace is never worth a visible failure, and
    // retrying would grow unboundedly in exactly the conditions that caused the failure.
  } finally {
    clearTimeout(timeout);
    deliveries.delete(controller);
  }
}

export async function flushAgentEventsForExit(): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const drain = async () => {
    await flushAgentEvents();
    while (inFlight.size) {
      await Promise.all([...inFlight]);
      await flushAgentEvents();
    }
  };
  try {
    await Promise.race([
      drain(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          for (const controller of deliveries) controller.abort();
          resolve();
        }, 2_000);
        (timeout as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

/** Tests only. */
export function __resetAgentEvents(): void {
  offAuth?.();
  offAuth = null;
  discardSessionEvents();
  inFlight.clear();
  context = { surface: "app", model: "", project_id: "", transcript_id: "" };
}

/** Tests only. */
export function __bufferedAgentEvents(): AgentEvent[] {
  return buffer.map((item) => ({ ...item.event }));
}
