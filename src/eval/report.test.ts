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

  // A failing case with a backlog item on record is not a regression, and the run that first
  // passes it must say so loudly enough that the mark gets removed.
  it("reports a marked case as a known failure while it fails, and as fixed once it passes", () => {
    const ref = "art-daddy/backlog#93";
    const results = [
      mk({ scenarioId: "old_bug", passed: false, knownFailure: ref }),
      mk({ scenarioId: "now_fixed", passed: true, knownFailure: ref }),
      mk({ scenarioId: "regressed", passed: false }),
      mk({ scenarioId: "fine", passed: true }),
    ];
    const { json, markdown } = buildReport(results, {
      models: ["gpt-5.4"],
      capUsd: 2,
      spentUsd: 0,
    });
    const row = (id: string) => markdown.split("\n").find((l) => l.startsWith(`| ${id} |`))!;
    expect(row("old_bug")).toContain("known failure");
    expect(row("now_fixed")).toContain("FIXED");
    expect(row("regressed")).toContain("✗ fail");
    expect(row("fine")).toContain("✓ pass");
    expect(markdown).toContain(`[\`gpt-5.4\` / now_fixed] **FIXED** (remove the mark) — ${ref}`);
    expect(markdown).toContain(`[\`gpt-5.4\` / old_bug] still failing — ${ref}`);
    const summary = (json as { summary: Record<string, number>[] }).summary[0];
    expect([summary.failed, summary.knownFailures, summary.fixed, summary.passed]).toEqual([
      1, 1, 1, 2,
    ]);
    const statuses = (json as { results: { scenarioId: string; status: string }[] }).results;
    expect(statuses.map((r) => r.status)).toEqual(["known_failure", "fixed", "fail", "pass"]);
  });

  it("shows the setup, the harm column and the checks that failed or warned", () => {
    const r = mk({
      scenarioId: "spent",
      model: "gpt-6-luna",
      passed: false,
      harm: { passed: false, violations: ["harm(paid_tool): generate_video called 1x"] },
      trace: {
        toolCalls: [],
        reasoning: [],
        rounds: 2,
        finalText: "",
        usage: {
          inputTokens: 1000,
          outputTokens: 0,
          reasoningTokens: 0,
          costUsd: 0.1,
          cachedTokens: 800,
        },
        setup: {
          model: "gpt-6-luna",
          effort: "medium",
          mode: "autopilot",
          catalogId: "cat_1",
          appVersion: "0.24.0",
          appGitSha: "a".repeat(40),
          appGitDirty: true,
          server: "http://s",
          serverVersion: "9",
          serverBuild: "b1",
          promptSha256: "c".repeat(64),
          preload: false,
        },
        clocks: { rounds: [], modelMs: 1500, toolMs: 500, firstTokenNote: "n/a" },
        checks: [
          { id: "paid_tool", verdict: "fail", details: ["generate_video called 1x"] },
          {
            id: "craft_tiny_clip",
            verdict: "warn",
            details: ["clip f is 2 frames long (under 5)"],
          },
          { id: "collateral", verdict: "warn", details: ["clip a changed: opacity"] },
        ],
      },
    });
    const { markdown } = buildReport([r], {
      models: ["gpt-6-luna"],
      capUsd: 2,
      spentUsd: 0.1,
      effort: "medium",
      setup: {
        appGitSha: "a".repeat(40),
        appGitDirty: true,
        server: "http://s",
        serverVersion: "9",
        serverBuild: "b1",
        promptSha256: "c".repeat(64),
      },
    });
    expect(markdown).toContain("Effort: medium");
    expect(markdown).toContain(`Client commit: ${"a".repeat(40)} (with local changes)`);
    expect(markdown).toContain("version 9 · build b1");
    expect(markdown).toContain(`Base prompt sha256: ${"c".repeat(64)}`);
    expect(markdown).toContain("Tool catalog: cat_1");
    expect(markdown).toMatch(/\| `paid_tool` \| 1 \| 0 \|/);
    expect(markdown).toMatch(/\| `craft_tiny_clip` \| 0 \| 1 \|/);
    const row = markdown.split("\n").find((l) => l.startsWith("| spent |"))!;
    expect(row).toContain("| ✗ |"); // harm
    expect(row).toContain("tiny_clip"); // a craft warning, by name
    expect(row).not.toContain("collateral"); // an unscoped diff is a record, not a warning
    const summaryRow = markdown.split("\n").find((l) => l.startsWith("| `gpt-6-luna` |"))!;
    expect(summaryRow).toContain("| 80% | 1.5s | 0.5s |"); // cached share, model time, tool time
  });
});
