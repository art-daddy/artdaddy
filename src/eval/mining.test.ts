import { describe, expect, it } from "vitest";

import { mineReport, mineSession, transcriptToTrace, type RawTranscript } from "./mining";

const fixture: RawTranscript = {
  requests: [
    {
      message: { text: "remove silences, tighten pacing" },
      response: [
        { kind: "reasoning", text: "planning the cut" },
        {
          kind: "tool_call",
          call_id: "c1",
          name: "ripple_delete",
          args: { track_id: "v1", clip_id: "x" },
        },
        {
          kind: "tool_result",
          call_id: "c1",
          name: "ripple_delete",
          ok: false,
          error: "pass track_id OR clip_id, not both",
        },
        { kind: "tool_call", call_id: "c2", name: "ripple_delete", args: { clip_id: "x" } },
        { kind: "tool_result", call_id: "c2", name: "ripple_delete", ok: true },
        { kind: "tool_call", call_id: "c3", name: "run_ffmpeg", args: {} },
        { kind: "tool_result", call_id: "c3", name: "run_ffmpeg", ok: true },
      ],
    },
  ],
};

describe("transcriptToTrace", () => {
  it("matches results to calls by call_id and captures prompts + reasoning", () => {
    const { trace, prompts } = transcriptToTrace(fixture);
    expect(prompts).toEqual(["remove silences, tighten pacing"]);
    expect(trace.reasoning).toEqual(["planning the cut"]);
    expect(trace.toolCalls.map((c) => [c.name, c.ok])).toEqual([
      ["ripple_delete", false],
      ["ripple_delete", true],
      ["run_ffmpeg", true],
    ]);
    expect(trace.toolCalls[0].error).toContain("not both");
  });
});

describe("mineSession + mineReport", () => {
  it("surfaces the recurring error, retry thrash, and escape-hatch use", () => {
    const s = mineSession("t008", fixture);
    expect(s.signals.toolErrors.length).toBe(1);
    expect(s.signals.retryLoops).toEqual([{ name: "ripple_delete", attempts: 2 }]);
    expect(s.signals.escapeHatchUsed).toContain("run_ffmpeg");

    const md = mineReport([s]);
    expect(md).toContain("Recurring tool errors");
    expect(md).toContain("ripple_delete");
    expect(md).toContain("t008");
  });
});
