import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { unansweredCalls, type Turn } from "./chatTranscript";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// Shape rules for unansweredCalls that hold whatever the recovery policy is. Deliberately NOT
// here: "a call with a recorded output is never owed" and "nothing before the last recorded
// output is owed". Those restate the implementation's assumption that a result on disk was
// delivered, which is false — the runner sends a batch's outputs only once the whole batch has
// run. Whether recovery satisfies the PROVIDER is judged in chatDebt.integration.test.ts,
// against a simulated provider, driving the real store and runner.

interface TurnSpec {
  calls: boolean[]; // true = the call's result was recorded
  text: boolean;
}

const turnSpec: fc.Arbitrary<TurnSpec> = fc.record({
  calls: fc.array(fc.boolean(), { maxLength: 4 }),
  text: fc.boolean(),
});

function build(specs: TurnSpec[]): { turns: Turn[]; order: string[] } {
  let n = 0;
  const order: string[] = [];
  const turns = specs.map((s, ti) => {
    const parts: Any[] = [];
    for (const answered of s.calls) {
      const id = `c${++n}`;
      order.push(id);
      parts.push({ kind: "tool_call", call_id: id, name: "tool" });
      if (answered) parts.push({ kind: "tool_result", call_id: id, ok: true });
    }
    if (s.text) parts.push({ kind: "text", text: "..." });
    return { id: `t${ti}`, userText: "", attachments: [], parts, status: "done" } as Turn;
  });
  return { turns, order };
}

const transcripts = fc.array(turnSpec, { maxLength: 7 }).map(build);

describe("unansweredCalls: shape rules", () => {
  it("keeps transcript order and never owes the same call twice", () => {
    fc.assert(
      fc.property(transcripts, ({ turns, order }) => {
        const got = unansweredCalls(turns).map((o) => o.call_id);
        expect(new Set(got).size).toBe(got.length);
        const positions = got.map((id) => order.indexOf(id));
        expect(positions.every((p) => p >= 0)).toBe(true); // only calls that exist
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
      }),
      { numRuns: 400 },
    );
  });

  // A recorded payment must clear the debt, or every message after a recovery carries the same
  // payment again and is refused.
  it("owes nothing once a turn records the payment", () => {
    fc.assert(
      fc.property(transcripts, ({ turns }) => {
        const owed = unansweredCalls(turns);
        fc.pre(owed.length > 0);
        const paid: Turn = {
          id: "paid",
          userText: "",
          attachments: [],
          status: "done",
          parts: owed.map((o) => ({ kind: "tool_result", call_id: o.call_id, ok: false })) as Any,
        };
        expect(unansweredCalls([...turns, paid])).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it("every owed output is a truthful failure, never a fabricated success", () => {
    fc.assert(
      fc.property(transcripts, ({ turns }) => {
        for (const o of unansweredCalls(turns)) {
          expect((o.result as { ok?: unknown }).ok).toBe(false);
          expect(String((o.result as { error?: unknown }).error)).toMatch(/not run/);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("is total: never throws on malformed parts", () => {
    const part = fc.record(
      {
        kind: fc.constantFrom("tool_call", "tool_result", "text", "error", "weird"),
        call_id: fc.option(fc.oneof(fc.string(), fc.integer()), { nil: undefined }),
        name: fc.option(fc.string(), { nil: undefined }),
      },
      { requiredKeys: ["kind"] },
    );
    fc.assert(
      fc.property(fc.array(fc.array(part, { maxLength: 6 }), { maxLength: 6 }), (raw) => {
        const turns = raw.map(
          (parts, i) =>
            ({ id: `t${i}`, userText: "", attachments: [], parts, status: "done" }) as Any,
        );
        expect(() => unansweredCalls(turns)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });
});
