import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { evalTier0, evalTier1 } from "./oracle";
import { HARNESS_UNAVAILABLE, type Scenario, type Trace } from "./types";
import type { Timeline } from "../timeline/model";
import { recoverySeed } from "./recovery";

const tl = {} as Timeline;
const base: Scenario = { id: "s", title: "t", seed: () => tl, prompt: "p" };

describe("evalTier1", () => {
  it("scores round exhaustion as a model failure even when ordinary assertions would pass", () => {
    const trace: Trace = {
      toolCalls: [],
      reasoning: [],
      rounds: 16,
      stopReason: "round_limit",
      finalText: "",
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 },
    };
    const result = evalTier1(base, tl, trace);
    expect(result.passed).toBe(false);
    expect(result.violations).toContain(
      "tier1: model exhausted the scenario round limit before completing the task",
    );
  });
  it("passes when there is no assertion", () => {
    expect(evalTier1(base, tl)).toEqual({ passed: true, violations: [] });
  });

  it("passes when the assertion holds", () => {
    expect(evalTier1({ ...base, expect: () => undefined }, tl).passed).toBe(true);
  });

  it("fails with the thrown message when the assertion breaks", () => {
    const r = evalTier1(
      {
        ...base,
        expect: () => {
          throw new Error("outro not at 60");
        },
      },
      tl,
    );
    expect(r.passed).toBe(false);
    expect(r.violations).toEqual(["tier1: outro not at 60"]);
  });
});

describe("recovery failure accounting", () => {
  it("exempts only injected failures and never hides malformed model calls", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            ok: fc.boolean(),
            unavailable: fc.boolean(),
            expectedFailure: fc.boolean(),
          }),
          { maxLength: 20 },
        ),
        fc.integer({ min: 0, max: 3 }),
        (outcomes, budget) => {
          const trace: Trace = {
            toolCalls: outcomes.map(({ ok, unavailable, expectedFailure }, index) => ({
              round: index,
              name: "run_ffmpeg",
              args: {},
              ok,
              error: unavailable ? HARNESS_UNAVAILABLE : "test failure",
              expectedFailure,
            })),
            reasoning: [],
            rounds: 1,
            finalText: "",
            usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 },
            recovery: {
              timelineUnchanged: true,
              inputFilesUnchanged: true,
              artifacts: [],
              sources: [],
              expectedFailures: 0,
              unexpectedFailures: 0,
              violations: [],
            },
          };
          const failures = outcomes.filter(
            (outcome) => !outcome.ok && !outcome.unavailable && !outcome.expectedFailure,
          ).length;
          const result = evalTier0(recoverySeed("platform_limit"), trace, budget);
          expect(result.passed).toBe(failures <= budget);
          if (failures > budget)
            expect(
              result.violations.some(
                (violation) =>
                  violation.includes("tool call") && violation.includes(String(failures)),
              ),
            ).toBe(true);
          const ordinaryFailures = outcomes.filter(
            (outcome) => !outcome.ok && !outcome.unavailable,
          ).length;
          const ordinary = evalTier0(
            recoverySeed("platform_limit"),
            { ...trace, recovery: undefined },
            budget,
          );
          expect(ordinary.passed).toBe(ordinaryFailures <= budget);
        },
      ),
      { numRuns: 100 },
    );
  });
});
