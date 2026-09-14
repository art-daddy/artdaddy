import { describe, expect, it } from "vitest";

import { buildReport } from "./report";
import type { ScenarioResult, Signals } from "./types";

const emptySignals = (): Signals => ({
  toolErrors: [],
  retryLoops: [],
  expectedButUndeclared: [],
  workaroundSuspected: [],
  escapeHatchUsed: [],
  silentCorruption: [],
  notRunInHarness: [],
});

function mk(extra: Partial<ScenarioResult>): ScenarioResult {
  return {
    scenarioId: "s",
    title: "t",
    prompt: "p",
    tags: [],
    model: "gpt-5.4",
    passed: true,
    tier0: { passed: true, violations: [] },
    tier1: { passed: true, violations: [] },
    signals: emptySignals(),
    trace: {
      toolCalls: [],
      reasoning: [],
      rounds: 2,
      finalText: "",
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0.1 },
    },
    wallMs: 10,
    ...extra,
  };
}

describe("buildReport", () => {
  // Payload shaping is only worth doing where the payload IS. A guess here costs a redesign
  // of the wrong tool, so the report has to rank the real sizes.
  it("ranks tools by what their replies put back into the context", () => {
    const r = mk({
      trace: {
        toolCalls: [
          { round: 1, name: "get_timeline", args: {}, ok: true, resultChars: 9000 },
          { round: 2, name: "get_timeline", args: {}, ok: true, resultChars: 1000 },
          { round: 2, name: "add_clips", args: {}, ok: true, resultChars: 300 },
        ],
        reasoning: [],
        rounds: 2,
        finalText: "",
        usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 },
      },
    });
    const { markdown } = buildReport([r], {
      spentUsd: 0,
      capUsd: 5,
      models: ["gpt-5.4"],
    });

    expect(markdown).toContain("Tool payload");
    expect(markdown).toContain("10.3k chars"); // 9000 + 1000 + 300
    const timelineRow = markdown.split("\n").find((l) => l.includes("`get_timeline`"))!;
    expect(timelineRow).toContain("10,000"); // total for that tool
    expect(timelineRow).toContain("9,000"); // the single fattest reply
    // Ranked, so the biggest offender is the one you read first.
    expect(markdown.indexOf("`get_timeline`")).toBeLessThan(markdown.indexOf("`add_clips`"));
  });

  it("summarizes per model and surfaces the missing-feature backlog", () => {
    const results = [
      mk({ scenarioId: "a", passed: true }),
      mk({
        scenarioId: "b",
        passed: false,
        tier1: { passed: false, violations: ["tier1: nope"] },
        signals: {
          ...emptySignals(),
          expectedButUndeclared: [{ name: "set_clip_properties", params: ["rounding"] }],
        },
      }),
    ];
    const { json, markdown } = buildReport(results, {
      models: ["gpt-5.4"],
      capUsd: 10,
      spentUsd: 1.23,
    });

    expect(markdown).toContain("## Summary");
    expect(markdown).toContain("`gpt-5.4`");
    expect(markdown).toContain("1/2"); // one of two passed
    expect(markdown).toContain("set_clip_properties.rounding");
    const summary = (json as { summary: unknown[] }).summary;
    expect(summary.length).toBe(1);
  });

  it("marks budget-skipped scenarios", () => {
    const { markdown } = buildReport([mk({ scenarioId: "z", skipped: true })], {
      models: ["gpt-5.4"],
      capUsd: 10,
      spentUsd: 10,
    });
    expect(markdown).toContain("budget");
  });
});
