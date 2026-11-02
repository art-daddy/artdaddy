import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { MAX_TURN_MS } from "../api/agentEvents";
import { SPAN_PRIORITY, sweepSpans, TurnTimer, type Span, type TurnSummary } from "./turnTiming";

/** A clock the test moves by hand. */
function rig(start = 1_000_000) {
  let t = start;
  const timer = new TurnTimer(() => t);
  return {
    timer,
    advance: (ms: number) => void (t += ms),
    set: (to: number) => void (t = to),
  };
}

const PARTS = [
  "prep_ms",
  "request_ms",
  "think_ms",
  "stream_ms",
  "tool_ms",
  "wait_ms",
  "approval_ms",
  "other_ms",
] as const;
const sumOfParts = (s: TurnSummary): number => PARTS.reduce((acc, key) => acc + s[key], 0);

describe("sweepSpans: every instant is exactly one thing", () => {
  const kind = fc.constantFrom(...SPAN_PRIORITY);
  const span = fc
    .tuple(kind, fc.integer({ min: -50, max: 500 }), fc.integer({ min: -50, max: 500 }))
    .map(([k, a, b]): Span => ({ kind: k, start: a, end: b }));

  it("adds up to the window for ANY spans, including empty, backwards and outside ones", () => {
    fc.assert(
      fc.property(fc.array(span, { maxLength: 40 }), (spans) => {
        const totals = sweepSpans(spans, 0, 300);
        const sum = Object.values(totals).reduce((a, b) => a + b, 0);
        expect(sum).toBe(300);
        for (const v of Object.values(totals)) expect(v).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it("does not depend on the order the spans arrive in", () => {
    fc.assert(
      fc.property(
        fc.array(span, { maxLength: 30 }),
        fc.infiniteStream(fc.nat()),
        (spans, rolls) => {
          const shuffled = [...spans];
          const take = rolls[Symbol.iterator]();
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = (take.next().value as number) % (i + 1);
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
          }
          expect(sweepSpans(shuffled, 0, 300)).toEqual(sweepSpans(spans, 0, 300));
        },
      ),
    );
  });

  it("gives an instant to the first of the priority list that covers it", () => {
    // Every pair of kinds, over the same stretch: the higher one owns all of it.
    for (let i = 0; i < SPAN_PRIORITY.length; i++)
      for (let j = i + 1; j < SPAN_PRIORITY.length; j++) {
        const totals = sweepSpans(
          [
            { kind: SPAN_PRIORITY[j], start: 0, end: 100 },
            { kind: SPAN_PRIORITY[i], start: 0, end: 100 },
          ],
          0,
          100,
        );
        expect(totals[SPAN_PRIORITY[i]], `${SPAN_PRIORITY[i]} over ${SPAN_PRIORITY[j]}`).toBe(100);
        expect(totals[SPAN_PRIORITY[j]]).toBe(0);
        expect(totals.other).toBe(0);
      }
  });

  it("never lets a lower kind take time from a higher one", () => {
    fc.assert(
      fc.property(fc.array(span, { maxLength: 30 }), (spans) => {
        const totals = sweepSpans(spans, 0, 300);
        // The top kind owns every instant it covers, so its total is the length of the union of its spans.
        const top = spans
          .filter((s) => s.kind === "approval")
          .map((s) => [Math.max(0, s.start), Math.min(300, s.end)] as const)
          .filter(([a, b]) => b > a)
          .sort((x, y) => x[0] - y[0]);
        let covered = 0;
        let edge = -Infinity;
        for (const [a, b] of top) {
          if (b > edge) {
            covered += b - Math.max(a, edge);
            edge = b;
          }
        }
        expect(totals.approval).toBe(covered);
      }),
    );
  });

  it("is nothing for an empty or backwards window", () => {
    const totals = sweepSpans([{ kind: "tool", start: 0, end: 10 }], 5, 5);
    expect(Object.values(totals).every((v) => v === 0)).toBe(true);
    expect(Object.values(sweepSpans([], 9, 3)).every((v) => v === 0)).toBe(true);
  });
});

describe("a turn's parts add up to its wall time", () => {
  type Op =
    | { op: "advance"; ms: number }
    | { op: "roundStarted" }
    | { op: "roundSent"; frames: number }
    | { op: "bytes"; n: number }
    | { op: "head" }
    | { op: "delta" }
    | { op: "roundEnded" }
    | { op: "note"; note: "reconnecting" | "busy" | null }
    | { op: "toolStarted"; id: string }
    | { op: "toolEnded"; id: string }
    | { op: "asked"; n: number }
    | { op: "answered" };
  const id = fc.constantFrom("a", "b", "c");
  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ op: fc.constant("advance" as const), ms: fc.integer({ min: 0, max: 20_000 }) }),
    fc.constant({ op: "roundStarted" } as const),
    fc.record({ op: fc.constant("roundSent" as const), frames: fc.integer({ min: 0, max: 12 }) }),
    fc.record({ op: fc.constant("bytes" as const), n: fc.integer({ min: 0, max: 3_000_000 }) }),
    fc.constant({ op: "head" } as const),
    fc.constant({ op: "delta" } as const),
    fc.constant({ op: "roundEnded" } as const),
    fc.record({
      op: fc.constant("note" as const),
      note: fc.constantFrom("reconnecting", "busy", null),
    }),
    fc.record({ op: fc.constant("toolStarted" as const), id }),
    fc.record({ op: fc.constant("toolEnded" as const), id }),
    fc.record({ op: fc.constant("asked" as const), n: fc.integer({ min: 0, max: 5 }) }),
    fc.constant({ op: "answered" } as const),
  );

  function play(ops: Op[]) {
    const r = rig();
    let waited = 0;
    for (const o of ops) {
      switch (o.op) {
        case "advance":
          r.advance(o.ms);
          break;
        case "roundStarted":
          r.timer.roundStarted();
          break;
        case "roundSent":
          r.timer.roundSent(o.frames);
          break;
        case "bytes":
          r.timer.bytesSent(o.n);
          break;
        case "head":
          r.timer.roundHead();
          break;
        case "delta":
          r.timer.roundDelta();
          break;
        case "roundEnded":
          r.timer.roundEnded();
          break;
        case "note":
          r.timer.noteWait(o.note);
          break;
        case "toolStarted":
          r.timer.toolStarted(o.id);
          break;
        case "toolEnded":
          r.timer.toolEnded(o.id);
          break;
        case "asked":
          r.timer.approvalAsked(o.n);
          break;
        case "answered":
          waited += r.timer.approvalAnswered();
          break;
      }
    }
    const openAtEnd = r.timer.approvalWaitedMs();
    return { summary: r.timer.finish(), waited, openAtEnd };
  }

  it("for ANY order of marks, exactly: no part is negative and nothing is lost or counted twice", () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 80 }), (ops) => {
        const { summary } = play(ops);
        expect(sumOfParts(summary)).toBe(summary.wall_ms);
        for (const key of PARTS) {
          expect(Number.isInteger(summary[key]), key).toBe(true);
          expect(summary[key], key).toBeGreaterThanOrEqual(0);
        }
        expect(summary.wall_ms).toBe(
          ops.reduce((acc, o) => acc + (o.op === "advance" ? o.ms : 0), 0),
        );
      }),
      { numRuns: 300 },
    );
  });

  it("counts what happened: rounds, distinct tools, approvals asked, pictures and bytes", () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 80 }), (ops) => {
        const { summary } = play(ops);
        expect(summary.rounds).toBe(ops.filter((o) => o.op === "roundStarted").length);
        // A tool counts once however often it is announced, and a tool that was ended can start again.
        const open = new Set<string>();
        let tools = 0;
        for (const o of ops) {
          if (o.op === "toolStarted" && !open.has(o.id)) {
            open.add(o.id);
            tools += 1;
          }
          if (o.op === "toolEnded") open.delete(o.id);
        }
        expect(summary.tools).toBe(tools);
        expect(summary.approvals).toBe(
          ops.reduce((acc, o) => acc + (o.op === "asked" ? o.n : 0), 0),
        );
        expect(summary.frames).toBe(
          ops.reduce((acc, o) => acc + (o.op === "roundSent" ? o.frames : 0), 0),
        );
        expect(summary.bytes_up).toBe(
          ops.reduce((acc, o) => acc + (o.op === "bytes" ? o.n : 0), 0),
        );
      }),
      { numRuns: 200 },
    );
  });

  it("the person's wait is exactly the time a question was open: nothing outranks it, so nothing takes from it", () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 80 }), (ops) => {
        const { summary, waited, openAtEnd } = play(ops);
        expect(summary.approval_ms).toBe(waited + openAtEnd);
      }),
      { numRuns: 300 },
    );
  });
});

describe("the injected-delay turn: 3 s of admission, 5 s of request, 10 s of model, then a 20 s tool", () => {
  it("attributes each wait to what it was, and the parts add up to the wall time", () => {
    const r = rig();
    r.advance(400); // the app builds the request
    r.timer.roundStarted();
    r.advance(600);
    r.timer.roundSent(4);
    r.timer.bytesSent(1_900_000);
    r.timer.noteWait("busy"); // the server is finishing the last request
    r.advance(3_000);
    r.timer.noteWait(null);
    r.advance(5_000); // on its way, no answer yet
    r.timer.roundHead();
    r.advance(6_000); // the model thinks
    r.timer.roundDelta();
    r.advance(4_000); // and writes
    r.timer.roundEnded();
    r.advance(250); // the app reads the answer and starts the tool
    r.timer.toolStarted("c1");
    r.advance(20_000);
    r.timer.toolEnded("c1");
    r.advance(150);
    const s = r.timer.finish();

    expect(s).toMatchObject({
      wall_ms: 400 + 600 + 3_000 + 5_000 + 6_000 + 4_000 + 250 + 20_000 + 150,
      prep_ms: 600,
      wait_ms: 3_000,
      request_ms: 5_000,
      think_ms: 6_000,
      stream_ms: 4_000,
      tool_ms: 20_000,
      approval_ms: 0,
      other_ms: 400 + 250 + 150,
      rounds: 1,
      tools: 1,
      busy_waits: 1,
      reconnects: 0,
      frames: 4,
      bytes_up: 1_900_000,
    });
    expect(sumOfParts(s)).toBe(s.wall_ms);
  });

  it("puts a wait for the person above a tool that is still running, and below nothing", () => {
    const r = rig();
    r.timer.toolStarted("slow");
    r.advance(1_000);
    r.timer.approvalAsked(1); // asked while the tool still runs
    r.advance(4_000);
    r.timer.toolEnded("slow");
    r.advance(2_000);
    expect(r.timer.approvalAnswered()).toBe(6_000);
    r.advance(500);
    const s = r.timer.finish();
    expect(s).toMatchObject({ tool_ms: 1_000, approval_ms: 6_000, other_ms: 500 });
    expect(sumOfParts(s)).toBe(s.wall_ms);
  });

  it("counts parallel tools once", () => {
    const r = rig();
    r.timer.toolStarted("a");
    r.advance(1_000);
    r.timer.toolStarted("b");
    r.advance(2_000);
    r.timer.toolEnded("a");
    r.advance(1_000);
    r.timer.toolEnded("b");
    expect(r.timer.finish()).toMatchObject({ tool_ms: 4_000, tools: 2, wall_ms: 4_000 });
  });

  it("counts a reconnect and a busy wait each time, and a note replaced by another ends the first", () => {
    const r = rig();
    r.timer.roundStarted();
    r.timer.roundSent(0);
    r.timer.noteWait("reconnecting");
    r.advance(1_000);
    r.timer.noteWait("busy"); // replaces it
    r.advance(2_000);
    r.timer.noteWait(null);
    r.timer.roundEnded();
    const s = r.timer.finish();
    expect(s).toMatchObject({ reconnects: 1, busy_waits: 1, wait_ms: 3_000 });
  });
});

describe("the clock and the turn's end", () => {
  it("a clock that jumps back makes a wait look short, never negative, and the parts still add up", () => {
    const r = rig();
    r.timer.roundStarted();
    r.advance(5_000);
    r.timer.noteWait(null); // a mark: the clock is only read at marks
    r.set(1_000_000 - 3_600_000); // an hour back
    r.timer.roundSent(0);
    r.advance(2_000);
    const s = r.timer.finish();
    for (const key of PARTS) expect(s[key], key).toBeGreaterThanOrEqual(0);
    expect(sumOfParts(s)).toBe(s.wall_ms);
    // What happened before the jump is kept whole; the time after it counts once the clock is past it again.
    expect(s).toMatchObject({ wall_ms: 5_000, prep_ms: 5_000 });
  });

  it("a turn that ends with things still open counts them up to the end", () => {
    const r = rig();
    r.timer.roundStarted();
    r.timer.roundSent(1);
    r.timer.roundHead();
    r.timer.toolStarted("never-ended");
    r.timer.approvalAsked(2);
    r.advance(7_000);
    const s = r.timer.finish();
    expect(s.approval_ms).toBe(7_000); // the person's wait outranks everything else running
    expect(sumOfParts(s)).toBe(7_000);
  });

  it("is final: the same answer however often it is asked, and a late mark changes nothing", () => {
    const r = rig();
    r.timer.roundStarted();
    r.advance(1_000);
    const first = r.timer.finish();
    r.advance(9_000);
    r.timer.toolStarted("late");
    r.timer.roundStarted();
    r.timer.approvalAsked(3);
    r.timer.noteWait("busy");
    expect(r.timer.finish()).toBe(first);
    expect(r.timer.finished).toBe(true);
    expect(first).toMatchObject({
      wall_ms: 1_000,
      tools: 0,
      rounds: 1,
      approvals: 0,
      busy_waits: 0,
    });
  });

  it("ignores the end of a tool it never saw, and a second end of one it did", () => {
    const r = rig();
    r.timer.toolEnded("ghost");
    r.timer.toolStarted("a");
    r.advance(1_000);
    r.timer.toolEnded("a");
    r.advance(1_000);
    r.timer.toolEnded("a");
    expect(r.timer.finish()).toMatchObject({ tool_ms: 1_000, wall_ms: 2_000, tools: 1 });
  });

  it("keeps every number inside what the server accepts, however long the turn sat", () => {
    const r = rig();
    r.timer.roundStarted();
    r.timer.approvalAsked(1);
    r.advance(MAX_TURN_MS * 3);
    const s = r.timer.finish();
    expect(s.wall_ms).toBe(MAX_TURN_MS);
    expect(s.approval_ms).toBe(MAX_TURN_MS);
  });

  it("is an empty turn when nothing happened, and says nothing it cannot know", () => {
    const s = rig().timer.finish();
    expect(s).toMatchObject({ wall_ms: 0, other_ms: 0, rounds: 0, tools: 0, bytes_up: 0 });
  });
});
