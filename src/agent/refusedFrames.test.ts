// Pictures the AI provider refused (UJ-046): what the server names, and what the app writes in its transcript so they are never sent again.
//
// The server cannot be trusted with the transcript, so what it names is checked before anything is written; the mark is the one key
// `refused: true` on the frame's own entry, and nothing else about the conversation changes; marking twice is marking once, so the
// person is told once.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import fixture from "../api/__fixtures__/refusedFrames.json";
import type { Turn } from "../store/chatTranscript";
import { historyFrameRefs } from "./historyFrames";
import { markRefusedFrames, refusedFramesOf, refusedNotice } from "./refusedFrames";

type Part = Turn["parts"][number];

function result(callId: string, n: number, marked: number[] = []): Part {
  return {
    kind: "tool_result",
    call_id: callId,
    name: "inspect_media",
    model_result: { ok: true },
    frame_refs: Array.from({ length: n }, (_, i) => ({
      path: `f/${callId}_${i}.jpg`,
      caption: `@${i}s`,
      ...(marked.includes(i) ? { refused: true } : {}),
    })),
  };
}

function turn(id: string, parts: Part[]): Turn {
  return { id, userText: id, attachments: [], parts, status: "done" };
}

/** Freeze a value all the way down: a function that writes into what it was given throws instead of passing quietly. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const refsOf = (t: Turn, callId: string) =>
  (
    t.parts.find((p) => p.kind === "tool_result" && p.call_id === callId) as unknown as {
      frame_refs: Record<string, unknown>[];
    }
  ).frame_refs;

describe("refusedFramesOf: what the server names, as far as it can be trusted", () => {
  it("keeps well-formed names, in the order given", () => {
    expect(
      refusedFramesOf([
        { call_id: "b", index: 2 },
        { call_id: "a", index: 0 },
      ]),
    ).toEqual([
      { call_id: "b", index: 2 },
      { call_id: "a", index: 0 },
    ]);
  });

  it.each([
    ["nothing", undefined],
    ["null", null],
    ["text", "call_9"],
    ["a number", 3],
    ["an object", { call_id: "a", index: 0 }],
    ["an empty list", []],
  ])("reads %s as no names", (_what, raw) => {
    expect(refusedFramesOf(raw)).toEqual([]);
  });

  it("drops an entry that does not say which frame of which call", () => {
    const names = refusedFramesOf([
      null,
      "a",
      { call_id: "", index: 0 },
      { call_id: 7, index: 0 },
      { call_id: "a" },
      { call_id: "a", index: "1" },
      { call_id: "a", index: -1 },
      { call_id: "a", index: 1.5 },
      { call_id: "a", index: Number.NaN },
      { call_id: "a", index: Number.POSITIVE_INFINITY },
      { call_id: "ok", index: 0 },
    ]);
    expect(names).toEqual([{ call_id: "ok", index: 0 }]);
  });

  it("names each frame once, and keeps only the two fields it needs", () => {
    expect(
      refusedFramesOf([
        { call_id: "a", index: 1, extra: "x" },
        { call_id: "a", index: 1 },
        { call_id: "a", index: 0 },
      ]),
    ).toEqual([
      { call_id: "a", index: 1 },
      { call_id: "a", index: 0 },
    ]);
  });

  it("never names more frames than a request can carry: fifty", () => {
    const many = Array.from({ length: 70 }, (_, i) => ({ call_id: `c${i}`, index: 0 }));
    const names = refusedFramesOf(many);
    expect(names).toHaveLength(50);
    expect(names).toEqual(many.slice(0, 50)); // the first fifty, in order
    expect(refusedFramesOf(many.slice(0, 50))).toHaveLength(50); // exactly fifty is all kept
  });

  it("does not take two different frames for one: a call id that ends in digits is not another call's index", () => {
    // "a1" frame 1 and "a" frame 11 write the same if the two are joined without a separator
    expect(
      refusedFramesOf([
        { call_id: "a1", index: 1 },
        { call_id: "a", index: 11 },
        { call_id: "a", index: 1 },
        { call_id: "a11", index: 0 },
        { call_id: "a1", index: 10 },
        { call_id: "a", index: 110 },
      ]),
    ).toHaveLength(6);
  });

  it("holds over any input, both ways: nothing unusable survives and nothing usable is dropped, up to the limit", () => {
    // The oracle keys by call id THEN index (nested), so it cannot share a mistake with a joined-string key.
    const usable = (x: unknown): x is { call_id: string; index: number } =>
      !!x &&
      typeof x === "object" &&
      typeof (x as { call_id?: unknown }).call_id === "string" &&
      (x as { call_id: string }).call_id !== "" &&
      typeof (x as { index?: unknown }).index === "number" &&
      Number.isInteger((x as { index: number }).index) &&
      (x as { index: number }).index >= 0;
    const name = fc.record({
      call_id: fc.oneof(fc.constantFrom("a", "a1", "a11", "b"), fc.string()),
      index: fc.oneof(fc.nat(12), fc.constantFrom(1.5, -1, Number.NaN, Number.POSITIVE_INFINITY)),
      extra: fc.option(fc.anything(), { nil: undefined }),
    });
    fc.assert(
      fc.property(fc.array(fc.oneof(name, fc.anything()), { maxLength: 120 }), (raw) => {
        const seen = new Map<string, Set<number>>();
        const expected: { call_id: string; index: number }[] = [];
        for (const x of raw) {
          if (!usable(x)) continue;
          const set = seen.get(x.call_id) ?? new Set<number>();
          if (set.has(x.index)) continue;
          set.add(x.index);
          seen.set(x.call_id, set);
          expected.push({ call_id: x.call_id, index: x.index });
        }
        expect(refusedFramesOf(raw)).toEqual(expected.slice(0, 50));
      }),
      { numRuns: 300 },
    );
  });
});

describe("markRefusedFrames", () => {
  it("writes the mark on the named frame of an OLDER turn, and on nothing else", () => {
    const turns = [turn("t1", [result("a", 3), result("b", 2)]), turn("t2", [result("c", 2)])];
    const out = markRefusedFrames(turns, [{ call_id: "a", index: 1 }]);
    expect(out.marked).toBe(1);
    expect(refsOf(out.turns[0], "a")).toEqual([
      { path: "f/a_0.jpg", caption: "@0s" },
      { path: "f/a_1.jpg", caption: "@1s", refused: true },
      { path: "f/a_2.jpg", caption: "@2s" },
    ]);
    expect(out.turns[0].parts[1]).toBe(turns[0].parts[1]); // an untouched part is the same object
    expect(out.turns[1]).toBe(turns[1]); // an untouched turn is the same object
  });

  it("changes nothing else about the part: its result, call and name stay exactly as they were", () => {
    const turns = [turn("t1", [result("a", 2)])];
    const before = JSON.stringify(turns);
    const out = markRefusedFrames(turns, [{ call_id: "a", index: 0 }]);
    expect(JSON.stringify(turns)).toBe(before); // the input was not written into
    const { frame_refs: _f, ...rest } = out.turns[0].parts[0] as Record<string, unknown>;
    const { frame_refs: _g, ...original } = turns[0].parts[0] as Record<string, unknown>;
    expect(rest).toEqual(original);
  });

  it("is idempotent: naming a frame that is already marked marks nothing, so the person is told once", () => {
    const first = markRefusedFrames([turn("t1", [result("a", 2)])], [{ call_id: "a", index: 1 }]);
    const again = markRefusedFrames(first.turns, [{ call_id: "a", index: 1 }]);
    expect(first.marked).toBe(1);
    expect(again.marked).toBe(0);
    expect(again.turns).toBe(first.turns);
  });

  it("counts only the frames that were marked now", () => {
    const turns = [turn("t1", [result("a", 4, [0])])];
    expect(
      markRefusedFrames(turns, [
        { call_id: "a", index: 0 },
        { call_id: "a", index: 2 },
        { call_id: "a", index: 3 },
      ]).marked,
    ).toBe(2);
  });

  it("a part whose frames were all marked already is left as it is, even in a turn that changed", () => {
    const turns = [turn("t1", [result("a", 2, [0]), result("b", 2)])];
    const out = markRefusedFrames(turns, [
      { call_id: "a", index: 0 },
      { call_id: "b", index: 1 },
    ]);
    expect(out.marked).toBe(1);
    expect(out.turns[0].parts[0]).toBe(turns[0].parts[0]); // already marked: the same object, not a copy
    expect(out.turns[0].parts[1]).not.toBe(turns[0].parts[1]);
  });

  it("marks a frame whose mark is anything but true", () => {
    for (const mark of [false, "true", 1, null]) {
      const part = {
        kind: "tool_result",
        call_id: "a",
        frame_refs: [{ path: "f/a_0.jpg", refused: mark }],
      };
      const out = markRefusedFrames([turn("t1", [part])], [{ call_id: "a", index: 0 }]);
      expect(out.marked, `refused: ${JSON.stringify(mark)}`).toBe(1);
      expect(refsOf(out.turns[0], "a")[0].refused).toBe(true);
    }
  });

  it.each([
    ["a call that is not in the conversation", { call_id: "zzz", index: 0 }],
    ["a place past the frames of that call", { call_id: "a", index: 2 }],
  ])("ignores %s", (_what, name) => {
    const turns = [turn("t1", [result("a", 2)])];
    const out = markRefusedFrames(turns, [name]);
    expect(out.marked).toBe(0);
    expect(out.turns).toBe(turns);
  });

  it("looks only at a tool RESULT, never at a call or text that happens to carry the same id or a list", () => {
    const turns = [
      turn("t1", [
        { kind: "tool_call", call_id: "a", frame_refs: [{ path: "x.jpg" }] },
        { kind: "text", call_id: "a", frame_refs: [{ path: "y.jpg" }] },
      ]),
    ];
    expect(markRefusedFrames(turns, [{ call_id: "a", index: 0 }]).marked).toBe(0);
  });

  it("skips an entry that is not an object, and a part whose frame_refs is not a list", () => {
    const turns = [
      turn("t1", [
        { kind: "tool_result", call_id: "a", frame_refs: [null, "x", { path: "ok.jpg" }] },
        { kind: "tool_result", call_id: "b", frame_refs: "nope" },
      ]),
    ];
    const out = markRefusedFrames(turns, [
      { call_id: "a", index: 0 },
      { call_id: "a", index: 1 },
      { call_id: "a", index: 2 },
      { call_id: "b", index: 0 },
    ]);
    expect(out.marked).toBe(1);
    expect(refsOf(out.turns[0], "a")[2]).toEqual({ path: "ok.jpg", refused: true });
  });

  it("does not write into what it was given", () => {
    const turns = deepFreeze([turn("t1", [result("a", 2)]), turn("t2", [result("b", 1)])]);
    expect(() =>
      markRefusedFrames(turns, [
        { call_id: "a", index: 0 },
        { call_id: "b", index: 0 },
      ]),
    ).not.toThrow();
  });

  it("marks a frame in an undone turn too: it is refused whether or not that turn is redone", () => {
    const undone = { ...turn("t1", [result("a", 1)]), undone: true };
    expect(markRefusedFrames([undone], [{ call_id: "a", index: 0 }]).marked).toBe(1);
  });

  it("the marked frame is no longer one the app re-sends, and the others keep the place the server knows them by", () => {
    const out = markRefusedFrames([turn("t1", [result("a", 3)])], [{ call_id: "a", index: 1 }]);
    expect(historyFrameRefs(out.turns).map((r) => [r.call_id, r.index])).toEqual([
      ["a", 0],
      ["a", 2],
    ]);
  });

  it("holds over any conversation: only the named, existing, unmarked frames change, by exactly the mark; twice is once", () => {
    const names = fc.array(
      fc.record({ call_id: fc.constantFrom("a", "b", "z"), index: fc.integer({ min: 0, max: 5 }) }),
      { maxLength: 12 },
    );
    const frames = fc.array(
      fc
        .integer({ min: 0, max: 5 })
        .chain((n) =>
          fc.subarray(Array.from({ length: n }, (_, i) => i)).map((marked) => ({ n, marked })),
        ),
      { minLength: 2, maxLength: 2 },
    );
    fc.assert(
      fc.property(frames, names, ([a, b], raw) => {
        const turns = [
          turn("t1", [result("a", a.n, a.marked)]),
          turn("t2", [result("b", b.n, b.marked)]),
        ];
        const named = refusedFramesOf(raw);
        const once = markRefusedFrames(turns, named);
        const key = (c: string, i: number) => `${c}|${i}`;
        const should = new Set(
          named
            .filter((x) =>
              x.call_id === "a"
                ? x.index < a.n && !a.marked.includes(x.index)
                : x.call_id === "b"
                  ? x.index < b.n && !b.marked.includes(x.index)
                  : false,
            )
            .map((x) => key(x.call_id, x.index)),
        );
        expect(once.marked).toBe(should.size);
        for (const [t, id, spec] of [
          [0, "a", a],
          [1, "b", b],
        ] as const) {
          refsOf(once.turns[t], id).forEach((ref, i) => {
            const expected = spec.marked.includes(i) || should.has(key(id, i));
            expect(ref.refused === true).toBe(expected);
            expect(ref.path).toBe(`f/${id}_${i}.jpg`);
          });
        }
        expect(markRefusedFrames(once.turns, named).marked).toBe(0);
      }),
    );
  });
});

describe("the notice", () => {
  it("says it once, in plain words, for one picture and for several", () => {
    expect(refusedNotice(1)).toBe(
      "The AI provider refused 1 picture from this conversation, so it is left out of every message from now on.",
    );
    expect(refusedNotice(3)).toBe(
      "The AI provider refused 3 pictures from this conversation, so they are left out of every message from now on.",
    );
  });

  it("names no vendor and no policy", () => {
    for (const n of [1, 2, 7])
      expect(refusedNotice(n)).not.toMatch(/azure|openai|content policy|violation|gpt/i);
  });
});

describe("the shared fixture (held to the server's own tests)", () => {
  it("what the server says is read as the names the fixture lists", () => {
    expect(refusedFramesOf(fixture.round_result.refused_frames)).toEqual(
      fixture.round_result.refused_frames,
    );
  });

  it("marking the fixture's frames turns the fixture's transcript before into its transcript after, and nothing else", () => {
    const before = turn("t1", [structuredClone(fixture.transcript_before) as Part]);
    const out = markRefusedFrames([before], refusedFramesOf(fixture.round_result.refused_frames));
    expect(out.marked).toBe(1); // call_11 is not in this conversation
    expect(out.turns[0].parts[0]).toEqual(fixture.transcript_after);
  });
});
