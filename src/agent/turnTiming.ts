// Where a turn's wall time went. Pure: marks in, a summary out.
//
// 12 to 15% of a turn's time was unattributed and 17 to 18% was client gaps (frames, upload, admission), so
// every fix to the agent's speed was argued by feel. The turn is split here into the things it can be
// waiting on, and EVERY instant is exactly one of them, so the parts add up to the wall time by construction
// (not within some tolerance): when two things overlap, the first of the list below owns that instant, and an
// instant nothing owns is `other`.
//
//   approval  the person's answer (nothing else is the reason while the turn waits on a person)
//   tool      a tool is running (parallel tools count once)
//   wait      the request is waiting: the connection being re-made, or the server's last request finishing
//   stream    the model is writing (first word to the end of the round)
//   think     the model has the request and has not written yet (response head to first word)
//   request   the request is on its way and the server has not answered yet (sent to response head)
//   prep      the app is building the request (frames, history, project settings)
//
// It says nothing about what was asked or answered: only times and counts.
import { MAX_BYTES_UP, MAX_TURN_COUNT, MAX_TURN_MS } from "../api/agentEvents";

export type SpanKind = "approval" | "tool" | "wait" | "stream" | "think" | "request" | "prep";
/** Highest priority first. */
export const SPAN_PRIORITY: readonly SpanKind[] = [
  "approval",
  "tool",
  "wait",
  "stream",
  "think",
  "request",
  "prep",
];

export interface Span {
  kind: SpanKind;
  start: number;
  end: number;
}

export interface TurnCounts {
  rounds: number;
  tools: number;
  approvals: number;
  reconnects: number;
  busy_waits: number;
  frames: number;
  bytes_up: number;
}

export interface TurnSummary extends TurnCounts {
  wall_ms: number;
  prep_ms: number;
  request_ms: number;
  think_ms: number;
  stream_ms: number;
  tool_ms: number;
  wait_ms: number;
  approval_ms: number;
  other_ms: number;
}

type Owner = SpanKind | "other";

/** How long each kind of wait owned the instants between `start` and `end`. Spans outside the window are
 *  clipped, empty and backwards ones are ignored. The result always adds up to `end - start`. */
export function sweepSpans(
  spans: readonly Span[],
  start: number,
  end: number,
): Record<Owner, number> {
  const totals: Record<Owner, number> = {
    approval: 0,
    tool: 0,
    wait: 0,
    stream: 0,
    think: 0,
    request: 0,
    prep: 0,
    other: 0,
  };
  if (!(end > start)) return totals;
  const edges: Array<{ at: number; kind: SpanKind; delta: 1 | -1 }> = [];
  for (const s of spans) {
    const from = Math.max(start, s.start);
    const to = Math.min(end, s.end);
    if (!(to > from)) continue;
    edges.push({ at: from, kind: s.kind, delta: 1 }, { at: to, kind: s.kind, delta: -1 });
  }
  edges.sort((a, b) => a.at - b.at);
  const open: Record<SpanKind, number> = {
    approval: 0,
    tool: 0,
    wait: 0,
    stream: 0,
    think: 0,
    request: 0,
    prep: 0,
  };
  let cursor = start;
  const owner = (): Owner => SPAN_PRIORITY.find((kind) => open[kind] > 0) ?? "other";
  for (const edge of edges) {
    if (edge.at > cursor) {
      totals[owner()] += edge.at - cursor;
      cursor = edge.at;
    }
    open[edge.kind] += edge.delta;
  }
  if (end > cursor) totals[owner()] += end - cursor;
  return totals;
}

const clamp = (n: number, max: number): number =>
  Number.isFinite(n) ? Math.max(0, Math.min(max, Math.round(n))) : 0;

export type RequestWait = "reconnecting" | "busy";

/** Collects the marks of ONE turn and turns them into a summary. The clock is injected; it is read through a
 *  monotone filter, so a system clock that jumps back can make a wait look short but never negative. Once
 *  `finish` has summed the turn it is final: a late mark (a tool that ignored Stop) changes nothing. */
export class TurnTimer {
  readonly startedAt: number;
  private last: number;
  private readonly spans: Span[] = [];
  private phase: { kind: "prep" | "request" | "think" | "stream"; since: number } | null = null;
  private note: { kind: RequestWait; since: number } | null = null;
  private readonly tools = new Map<string, number>();
  private approvalSince: number | null = null;
  private summary: TurnSummary | null = null;
  private counts: TurnCounts = {
    rounds: 0,
    tools: 0,
    approvals: 0,
    reconnects: 0,
    busy_waits: 0,
    frames: 0,
    bytes_up: 0,
  };

  constructor(private readonly clock: () => number = Date.now) {
    this.last = Math.round(clock());
    this.startedAt = this.last;
  }

  get finished(): boolean {
    return this.summary !== null;
  }

  private now(): number {
    const t = Math.round(this.clock());
    if (Number.isFinite(t) && t > this.last) this.last = t;
    return this.last;
  }

  private close(kind: SpanKind, since: number, at: number): void {
    if (at > since) this.spans.push({ kind, start: since, end: at });
  }

  private enter(kind: "prep" | "request" | "think" | "stream" | null): void {
    const at = this.now();
    if (this.phase) this.close(this.phase.kind, this.phase.since, at);
    this.phase = kind ? { kind, since: at } : null;
  }

  /** A model round begins: the app starts building its request. */
  roundStarted(): void {
    if (this.summary) return;
    this.counts.rounds += 1;
    this.enter("prep");
  }

  /** The request is built and goes out, carrying `frames` pictures. */
  roundSent(frames: number): void {
    if (this.summary) return;
    this.counts.frames += Number.isFinite(frames) ? Math.max(0, Math.round(frames)) : 0;
    this.enter("request");
  }

  /** The request body is `bytes` long (known only where it is serialised). */
  bytesSent(bytes: number): void {
    if (this.summary) return;
    this.counts.bytes_up += Number.isFinite(bytes) ? Math.max(0, Math.round(bytes)) : 0;
  }

  /** The server has answered (the response head): from here the model is working. */
  roundHead(): void {
    if (this.summary) return;
    if (this.phase?.kind === "request") this.enter("think");
  }

  /** The first word arrived. Only the first of a round counts. */
  roundDelta(): void {
    if (this.summary) return;
    if (this.phase && this.phase.kind !== "stream") this.enter("stream");
  }

  /** The round is over, whatever way. */
  roundEnded(): void {
    if (this.summary) return;
    this.enter(null);
    this.noteWait(null);
  }

  /** The request is waiting on something other than the model (or has stopped waiting: null). */
  noteWait(next: RequestWait | null): void {
    if (this.summary) return;
    const at = this.now();
    if (this.note) this.close("wait", this.note.since, at);
    this.note = next ? { kind: next, since: at } : null;
    if (next === "reconnecting") this.counts.reconnects += 1;
    if (next === "busy") this.counts.busy_waits += 1;
  }

  toolStarted(id: string): void {
    if (this.summary || this.tools.has(id)) return;
    this.tools.set(id, this.now());
    this.counts.tools += 1;
  }

  toolEnded(id: string): void {
    if (this.summary) return;
    const since = this.tools.get(id);
    if (since === undefined) return;
    this.tools.delete(id);
    this.close("tool", since, this.now());
  }

  /** The turn stops to ask the person about `calls` calls. */
  approvalAsked(calls: number): void {
    if (this.summary) return;
    this.counts.approvals += Number.isFinite(calls) ? Math.max(0, Math.round(calls)) : 0;
    if (this.approvalSince === null) this.approvalSince = this.now();
  }

  /** Nothing is waiting on the person any more. How long the wait was is returned (0 if none was open). */
  approvalAnswered(): number {
    if (this.summary || this.approvalSince === null) return 0;
    const at = this.now();
    const waited = at - this.approvalSince;
    this.close("approval", this.approvalSince, at);
    this.approvalSince = null;
    return waited;
  }

  /** How long the person has been asked so far, 0 when no question is open. */
  approvalWaitedMs(): number {
    return this.summary || this.approvalSince === null ? 0 : this.now() - this.approvalSince;
  }

  /** Everything still open ends now, and the turn is summed. The same answer however often it is asked. */
  finish(): TurnSummary {
    if (this.summary) return this.summary;
    const at = this.now();
    this.enter(null);
    this.noteWait(null);
    for (const id of [...this.tools.keys()]) this.toolEnded(id);
    this.approvalAnswered();
    const t = sweepSpans(this.spans, this.startedAt, at);
    this.summary = {
      wall_ms: clamp(at - this.startedAt, MAX_TURN_MS),
      prep_ms: clamp(t.prep, MAX_TURN_MS),
      request_ms: clamp(t.request, MAX_TURN_MS),
      think_ms: clamp(t.think, MAX_TURN_MS),
      stream_ms: clamp(t.stream, MAX_TURN_MS),
      tool_ms: clamp(t.tool, MAX_TURN_MS),
      wait_ms: clamp(t.wait, MAX_TURN_MS),
      approval_ms: clamp(t.approval, MAX_TURN_MS),
      other_ms: clamp(t.other, MAX_TURN_MS),
      rounds: clamp(this.counts.rounds, MAX_TURN_COUNT),
      tools: clamp(this.counts.tools, MAX_TURN_COUNT),
      approvals: clamp(this.counts.approvals, MAX_TURN_COUNT),
      reconnects: clamp(this.counts.reconnects, MAX_TURN_COUNT),
      busy_waits: clamp(this.counts.busy_waits, MAX_TURN_COUNT),
      frames: clamp(this.counts.frames, MAX_TURN_COUNT),
      bytes_up: clamp(this.counts.bytes_up, MAX_BYTES_UP),
    };
    return this.summary;
  }
}
