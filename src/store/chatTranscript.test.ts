import { describe, expect, it } from "vitest";

import {
  buildRequests,
  mapRequests,
  transcriptForRound,
  unansweredCalls,
  type Turn,
} from "./chatTranscript";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function turn(over: Partial<Turn> = {}): Turn {
  return { id: "t1", userText: "hi", attachments: [], parts: [], status: "done", ...over };
}

describe("mapRequests <-> buildRequests", () => {
  it("round-trips id / text / attachments / undone", () => {
    const turns = [
      turn({ id: "a", userText: "one", undone: true }),
      turn({
        id: "b",
        userText: "two",
        attachments: [{ path: "m.mp4", kind: "video", caption: "clip" }],
      }),
    ];
    const round = mapRequests(buildRequests(turns));
    expect(round.map((t) => t.id)).toEqual(["a", "b"]);
    expect(round[0].undone).toBe(true);
    expect(round[1].attachments[0]).toEqual({ path: "m.mp4", kind: "video", caption: "clip" });
  });

  it("defaults a missing message to empty + done", () => {
    const [t] = mapRequests([{ id: "x" }] as Any);
    expect(t.userText).toBe("");
    expect(t.status).toBe("done");
    expect(t.attachments).toEqual([]);
  });

  it("never writes a streamed fragment into the transcript", () => {
    // Deltas are live presentation. A partial that outlives its round (a tool-call round
    // streams prose that never becomes a `text` part) would otherwise be persisted AND
    // re-sent to the model as history it never produced.
    const t = turn({
      parts: [
        { kind: "reasoning", text: "settled" },
        { kind: "text", text: "half a sen", partial: true },
        { kind: "tool_call", name: "add_clips" },
      ],
    });

    const [req] = buildRequests([t]);

    expect(req.response).toEqual([
      { kind: "reasoning", text: "settled" },
      { kind: "tool_call", name: "add_clips" },
    ]);
  });

  it("keeps the finished part when a partial of the same kind sits beside it", () => {
    const t = turn({
      parts: [
        { kind: "text", text: "stale stream", partial: true },
        { kind: "text", text: "the real answer" },
      ],
    });

    expect(buildRequests([t])[0].response).toEqual([{ kind: "text", text: "the real answer" }]);
  });
});

describe("transcriptForRound", () => {
  it("returns the base transcript unchanged on a fresh user round", () => {
    const base = { requests: [{ id: "r0" }] };
    expect(transcriptForRound(base, { user_text: "hi" } as Any, [])).toBe(base);
  });

  it("drops THIS round's tool_result from the last turn on a follow-up round", () => {
    const turns = [
      turn({ id: "a", parts: [{ kind: "text", text: "x" }] as Any }),
      turn({
        id: "b",
        parts: [
          { kind: "tool_result", call_id: "c1" },
          { kind: "tool_result", call_id: "c2" },
          { kind: "text", text: "done" },
        ] as Any,
      }),
    ];
    const out = transcriptForRound(
      { requests: [] },
      { tool_results: [{ call_id: "c1" }] } as Any,
      turns,
    );
    const last = out.requests[out.requests.length - 1] as Any;
    // c1 (this round's result) removed; c2 + text kept; the earlier turn is intact.
    expect(last.response.map((p: Any) => p.call_id ?? p.kind)).toEqual(["c2", "text"]);
    expect((out.requests[0] as Any).id).toBe("a");
  });
});

// A session killed mid-tool loses its in-memory debt with the process, and the provider
// refuses every later request until each call it issued has an output. The transcript
// outlives the crash, so the debt is recovered from it.
describe("unansweredCalls", () => {
  it("owes an output for a call the crash left unanswered", () => {
    const turns = [
      turn({ id: "a", parts: [{ kind: "tool_call", call_id: "old", name: "x" }] as Any }),
      turn({
        id: "b",
        parts: [
          { kind: "tool_call", call_id: "c1", name: "get_timeline" },
          { kind: "tool_result", call_id: "c1" },
          { kind: "tool_call", call_id: "c2", name: "add_track" },
        ] as Any,
      }),
    ];
    const owed = unansweredCalls(turns);
    // c1 was answered; c2 was not. `old` is in a COMPLETED turn — answering a call the
    // provider has long forgotten would be a new error, not a repair.
    expect(owed.map((o) => o.call_id)).toEqual(["c2"]);
    expect(owed[0].name).toBe("add_track");
    expect((owed[0].result as { ok?: boolean }).ok).toBe(false);
  });

  // The failure direction: a healthy transcript must owe nothing, or every message would
  // carry phantom results.
  it("owes nothing when every call was answered", () => {
    const turns = [
      turn({
        id: "b",
        parts: [
          { kind: "tool_call", call_id: "c1", name: "get_timeline" },
          { kind: "tool_result", call_id: "c1" },
          { kind: "text", text: "done" },
        ] as Any,
      }),
    ];
    expect(unansweredCalls(turns)).toEqual([]);
    expect(unansweredCalls([])).toEqual([]);
  });
});
