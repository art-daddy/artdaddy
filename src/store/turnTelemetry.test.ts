import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import type { ApprovalDecision } from "../api/agentEvents";
import { TurnTelemetry, type TurnTelemetrySink } from "./turnTelemetry";

const LABELS = { surface: "app", model: "m", project_id: "p", transcript_id: "t", generation: 0 };

function rig() {
  let now = 5_000_000;
  const sink = {
    turnStart: vi.fn(),
    turnEnd: vi.fn(),
    approvalRequested: vi.fn(),
    approvalDecided: vi.fn(),
  } satisfies Record<keyof TurnTelemetrySink, unknown>;
  const telemetry = new TurnTelemetry(
    "turn-1",
    LABELS,
    sink as unknown as TurnTelemetrySink,
    () => now,
  );
  const decided = () =>
    sink.approvalDecided.mock.calls.map(([e]) => ({
      call: e.call_id,
      name: e.name,
      decision: e.decision as ApprovalDecision,
      waited: e.waited_ms,
    }));
  return { telemetry, sink, advance: (ms: number) => void (now += ms), decided };
}

describe("a turn is said to start once, and to end once", () => {
  it("reports the start with how it was set up, and never again", () => {
    const { telemetry, sink } = rig();
    const info = { trigger: "user", mode: "default", effort: "high", attachments: 2 } as const;
    telemetry.start(info);
    telemetry.start(info);
    expect(sink.turnStart).toHaveBeenCalledTimes(1);
    expect(sink.turnStart.mock.calls[0][0]).toEqual({ turn_id: "turn-1", ...info });
  });

  it("reports the end once, with how it ended and where the time went", () => {
    const { telemetry, sink, advance } = rig();
    telemetry.timer.roundStarted();
    advance(700);
    telemetry.timer.roundSent(1);
    advance(300);
    telemetry.end("done");
    telemetry.end("error", "late");
    telemetry.end("abandoned");
    expect(sink.turnEnd).toHaveBeenCalledTimes(1);
    const [event] = sink.turnEnd.mock.calls[0];
    expect(event).toMatchObject({ turn_id: "turn-1", outcome: "done" });
    expect(event).not.toHaveProperty("code");
    expect(event.summary).toMatchObject({
      wall_ms: 1_000,
      prep_ms: 700,
      request_ms: 300,
      rounds: 1,
    });
  });

  it("carries the code of a failure", () => {
    const { telemetry, sink } = rig();
    telemetry.end("error", "provider_timeout");
    expect(sink.turnEnd.mock.calls[0][0]).toMatchObject({
      outcome: "error",
      code: "provider_timeout",
    });
  });

  it("says nothing more once the turn has ended", () => {
    const { telemetry, sink } = rig();
    telemetry.end("stopped");
    telemetry.start({ trigger: "user", mode: "default", effort: "high", attachments: 0 });
    telemetry.approvalRequested([{ call_id: "c1", name: "export" }]);
    telemetry.approvalDecided("c1", "approved");
    expect(sink.turnStart).not.toHaveBeenCalled();
    expect(sink.approvalRequested).not.toHaveBeenCalled();
    expect(sink.approvalDecided).not.toHaveBeenCalled();
    expect(telemetry.finished).toBe(true);
  });
});

describe("the person's answers", () => {
  it("records the question once, and each answer with how long the person took", () => {
    const { telemetry, sink, advance, decided } = rig();
    telemetry.approvalRequested([
      { call_id: "c1", name: "export" },
      { call_id: "c2", name: "add_clips" },
    ]);
    expect(sink.approvalRequested.mock.calls[0][0]).toEqual({
      turn_id: "turn-1",
      names: ["export", "add_clips"],
    });
    advance(12_000);
    telemetry.approvalDecided("c1", "approved");
    advance(8_000);
    telemetry.approvalDecided("c2", "declined");
    expect(decided()).toEqual([
      { call: "c1", name: "export", decision: "approved", waited: 12_000 },
      { call: "c2", name: "add_clips", decision: "declined", waited: 20_000 },
    ]);
    telemetry.end("done");
    // The person's wait is the whole time a question was open: from the ask to the LAST answer.
    expect(sink.turnEnd.mock.calls[0][0].summary).toMatchObject({
      approval_ms: 20_000,
      approvals: 2,
      wall_ms: 20_000,
    });
  });

  it("an answer to a call nobody asked about, or answered already, says nothing", () => {
    const { telemetry, sink } = rig();
    telemetry.approvalDecided("ghost", "approved");
    telemetry.approvalRequested([{ call_id: "c1", name: "export" }]);
    telemetry.approvalDecided("c1", "approved");
    telemetry.approvalDecided("c1", "declined");
    expect(sink.approvalDecided).toHaveBeenCalledTimes(1);
  });

  it("an empty question is no question", () => {
    const { telemetry, sink } = rig();
    telemetry.approvalRequested([]);
    expect(sink.approvalRequested).not.toHaveBeenCalled();
  });

  it("a turn that ends while a question is open answers it: Stop is 'stopped', anything else 'abandoned'", () => {
    for (const [outcome, expected] of [
      ["stopped", "stopped"],
      ["abandoned", "abandoned"],
      ["error", "abandoned"],
    ] as const) {
      const { telemetry, advance, decided } = rig();
      telemetry.approvalRequested([
        { call_id: "c1", name: "export" },
        { call_id: "c2", name: "remove_clips" },
      ]);
      telemetry.approvalDecided("c1", "approved");
      advance(30_000);
      telemetry.end(outcome);
      expect(
        decided().map((d) => [d.call, d.decision]),
        outcome,
      ).toEqual([
        ["c1", "approved"],
        ["c2", expected],
      ]);
      expect(decided()[1].waited).toBe(30_000);
    }
  });

  it("a pause for Continue is the person's wait too, with nothing to approve", () => {
    const { telemetry, sink, advance } = rig();
    advance(1_000);
    telemetry.pausedForContinue();
    advance(9_000);
    telemetry.resumed();
    advance(500);
    telemetry.end("done");
    expect(sink.approvalRequested).not.toHaveBeenCalled();
    expect(sink.turnEnd.mock.calls[0][0].summary).toMatchObject({
      approval_ms: 9_000,
      approvals: 0,
      other_ms: 1_500,
      wall_ms: 10_500,
    });
  });

  it("answering one call of several does not end the wait, and Continue does not end an open question", () => {
    const { telemetry, advance } = rig();
    telemetry.approvalRequested([
      { call_id: "c1", name: "a" },
      { call_id: "c2", name: "b" },
    ]);
    advance(1_000);
    telemetry.approvalDecided("c1", "approved");
    advance(1_000);
    telemetry.resumed(); // a stray Continue while calls are still waiting
    advance(1_000);
    telemetry.approvalDecided("c2", "approved");
    telemetry.end("done");
    expect(telemetry.timer.finish()).toMatchObject({ approval_ms: 3_000, wall_ms: 3_000 });
  });
});

describe("whatever happens, the record is consistent", () => {
  type Op =
    | { op: "ask"; ids: string[] }
    | { op: "decide"; id: string; decision: ApprovalDecision }
    | { op: "pause" }
    | { op: "resume" }
    | { op: "advance"; ms: number }
    | { op: "end"; outcome: "done" | "stopped" | "error" | "abandoned" };
  const id = fc.constantFrom("a", "b", "c", "d");
  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ op: fc.constant("ask" as const), ids: fc.array(id, { maxLength: 3 }) }),
    fc.record({
      op: fc.constant("decide" as const),
      id,
      decision: fc.constantFrom("approved", "declined", "stopped", "abandoned"),
    }),
    fc.constant({ op: "pause" } as const),
    fc.constant({ op: "resume" } as const),
    fc.record({ op: fc.constant("advance" as const), ms: fc.integer({ min: 0, max: 60_000 }) }),
    fc.record({
      op: fc.constant("end" as const),
      outcome: fc.constantFrom("done", "stopped", "error", "abandoned"),
    }),
  );

  it("one end at most; no event after it; every question the turn asked is answered exactly once by the time it ends", () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 40 }), (ops) => {
        const { telemetry, sink, advance } = rig();
        const asked = new Map<string, number>();
        let endedAfter: number | null = null;
        const seenAfterEnd = () =>
          sink.approvalRequested.mock.calls.length + sink.approvalDecided.mock.calls.length;
        let callsAtEnd = -1;
        for (const o of ops) {
          switch (o.op) {
            case "ask":
              if (!telemetry.finished) for (const i of o.ids) asked.set(i, 1);
              telemetry.approvalRequested(o.ids.map((i) => ({ call_id: i, name: `tool_${i}` })));
              break;
            case "decide":
              telemetry.approvalDecided(o.id, o.decision);
              break;
            case "pause":
              telemetry.pausedForContinue();
              break;
            case "resume":
              telemetry.resumed();
              break;
            case "advance":
              advance(o.ms);
              break;
            case "end":
              telemetry.end(o.outcome);
              if (endedAfter === null) {
                endedAfter = sink.turnEnd.mock.calls.length;
                callsAtEnd = seenAfterEnd();
              }
              break;
          }
        }
        expect(sink.turnEnd.mock.calls.length).toBeLessThanOrEqual(1);
        if (endedAfter !== null) expect(seenAfterEnd()).toBe(callsAtEnd);
        // A call is answered at most once.
        const answers = sink.approvalDecided.mock.calls.map(([e]) => e.call_id as string);
        // ids can be asked again after an answer (a later batch), so compare per ask/answer pairs:
        const perCall = new Map<string, number>();
        for (const call of answers) perCall.set(call, (perCall.get(call) ?? 0) + 1);
        for (const [call, count] of perCall) {
          const times = sink.approvalRequested.mock.calls.filter(([e]) =>
            (e.names as string[]).some((n) => n === `tool_${call}`),
          ).length;
          expect(count, call).toBeLessThanOrEqual(Math.max(1, times));
        }
        // And what the turn asked and nobody answered is answered by its end.
        if (endedAfter !== null) {
          const unanswered = [...asked.keys()].filter((call) => !perCall.has(call));
          expect(unanswered).toEqual([]);
        }
      }),
      { numRuns: 300 },
    );
  });
});
