// The telemetry of ONE turn: when it started and ended, how, where its time went, and the person's answers.
//
// Everything here is an identifier, a word from a closed list, a count or a time: never what was typed, asked or
// answered. The chat store keeps one of these per turn and tells it what happens; this decides what is reported,
// exactly once, however the turn ends (done, Stop, an error, or left behind for a new message).
import {
  parseServerTiming,
  recordApprovalDecided,
  recordApprovalRequested,
  recordTurnEnd,
  recordTurnStart,
  type AgentEventContext,
  type ApprovalDecision,
  type ServerTimingSums,
  type TurnOutcome,
  type TurnStateRead,
  type TurnTrigger,
} from "../api/agentEvents";
import { TurnTimer } from "../agent/turnTiming";

/** Where the events go: the real recorders, or a test's. */
export interface TurnTelemetrySink {
  turnStart: typeof recordTurnStart;
  turnEnd: typeof recordTurnEnd;
  approvalRequested: typeof recordApprovalRequested;
  approvalDecided: typeof recordApprovalDecided;
}

const REAL_SINK: TurnTelemetrySink = {
  turnStart: recordTurnStart,
  turnEnd: recordTurnEnd,
  approvalRequested: recordApprovalRequested,
  approvalDecided: recordApprovalDecided,
};

export interface TurnStartInfo {
  trigger: TurnTrigger;
  mode: string;
  effort: string;
  attachments: number;
}

export class TurnTelemetry {
  readonly timer: TurnTimer;
  private ended = false;
  private started = false;
  /** How the project reached the model on this turn's first message; said with the turn's end. */
  private stateRead: TurnStateRead | undefined;
  /** Where the server's time went, summed over the rounds that reported it (their `timing` frames); said with the turn's end. */
  private server: ServerTimingSums | undefined;
  /** Tool calls the person has been asked about and has not answered, by call id. */
  private readonly asked = new Map<string, string>();

  constructor(
    readonly turnId: string,
    private readonly labels: AgentEventContext,
    private readonly sink: TurnTelemetrySink = REAL_SINK,
    clock?: () => number,
  ) {
    this.timer = new TurnTimer(clock);
  }

  get finished(): boolean {
    return this.ended;
  }

  /** The turn began. Said once, and never after it ended. */
  start(info: TurnStartInfo): void {
    if (this.started || this.ended) return;
    this.started = true;
    this.sink.turnStart({ turn_id: this.turnId, ...info }, this.labels);
  }

  /** How the project reached the model on this turn's first message: the whole listing, an outline, or a read that
   *  did not finish. Reported once, with the turn's end; a turn that asked for no read never calls this. */
  noteStateRead(word: TurnStateRead): void {
    if (!this.ended) this.stateRead = word;
  }

  /** A round's `timing` frame arrived: where the server's time went on it. Outside data, so anything that is not the five
   *  whole, finite, non-negative numbers is ignored. Added to the turn's sums, reported once with the turn's end. */
  noteServerTiming(timing: unknown): void {
    if (this.ended) return;
    const t = parseServerTiming(timing);
    if (!t) return;
    const sums = (this.server ??= {
      rounds: 0,
      intake_ms: 0,
      line_ms: 0,
      admit_ms: 0,
      vendor_ms: 0,
      settle_ms: 0,
    });
    sums.rounds += 1;
    sums.intake_ms += t.intake_ms;
    sums.line_ms += t.line_ms;
    sums.admit_ms += t.admit_ms;
    sums.vendor_ms += t.vendor_ms;
    sums.settle_ms += t.settle_ms;
  }

  /** The turn stopped to ask the person about these calls. */
  approvalRequested(calls: ReadonlyArray<{ call_id: string; name: string }>): void {
    if (this.ended || calls.length === 0) return;
    for (const call of calls) this.asked.set(call.call_id, call.name);
    this.timer.approvalAsked(calls.length);
    this.sink.approvalRequested(
      { turn_id: this.turnId, names: calls.map((call) => call.name) },
      this.labels,
    );
  }

  /** The person answered one call. An answer to a call that was not asked about, or already answered, says nothing. */
  approvalDecided(callId: string, decision: ApprovalDecision): void {
    if (this.ended) return;
    const name = this.asked.get(callId);
    if (name === undefined) return;
    this.asked.delete(callId);
    this.sink.approvalDecided(
      {
        turn_id: this.turnId,
        call_id: callId,
        name,
        decision,
        waited_ms: this.timer.approvalWaitedMs(),
      },
      this.labels,
    );
    if (this.asked.size === 0) this.timer.approvalAnswered();
  }

  /** The turn stopped at its cap and waits for the person to press Continue: their wait, with nothing to approve. */
  pausedForContinue(): void {
    if (!this.ended) this.timer.approvalAsked(0);
  }

  /** The person pressed Continue. */
  resumed(): void {
    if (!this.ended && this.asked.size === 0) this.timer.approvalAnswered();
  }

  /** The turn ended. Reported once; a question still open is answered by the end itself. */
  end(outcome: TurnOutcome, code?: string): void {
    if (this.ended) return;
    const decision: ApprovalDecision = outcome === "stopped" ? "stopped" : "abandoned";
    const waited = this.timer.approvalWaitedMs();
    for (const [callId, name] of this.asked)
      this.sink.approvalDecided(
        { turn_id: this.turnId, call_id: callId, name, decision, waited_ms: waited },
        this.labels,
      );
    this.asked.clear();
    this.ended = true;
    this.sink.turnEnd(
      {
        turn_id: this.turnId,
        outcome,
        ...(code ? { code } : {}),
        ...(this.stateRead ? { state: this.stateRead } : {}),
        ...(this.server ? { server: this.server } : {}),
        summary: this.timer.finish(),
      },
      this.labels,
    );
  }
}
