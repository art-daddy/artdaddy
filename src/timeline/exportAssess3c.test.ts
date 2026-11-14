// The hard warning and the soft notices, with the honest estimate behind them. A pessimistic estimate must not stop an export that 0.27.0 let through: the warning that an export cannot finish inside the PC's execution limit
// reads the LOW end of the range the estimate stands behind, while the notices ("a long export", "slower than the video") read its central value.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  assessExport,
  type ExportBudgets,
  type ExportEstimates,
  type ExportPreflightReason,
} from "./exportOptions";
import type { RenderWorkload } from "./renderPlan";
import type { ExportResources } from "../platform/host";

const HOUR = 3600;
const LIMIT = 8 * HOUR;
const budgets: ExportBudgets = {
  memoryBytes: 8e9,
  temporaryBytes: 18e9,
  executionSeconds: LIMIT,
};
const resources: ExportResources = {
  total_memory_bytes: 16e9,
  available_memory_bytes: 12e9,
  scratch_free_bytes: 500e9,
  destination_free_bytes: 500e9,
  budgets,
};
const workload = (durationSeconds: number): RenderWorkload => ({
  width: 1920,
  height: 1080,
  fps: 30,
  durationSeconds,
  visualClips: 12,
  captionClips: 0,
  audioClips: 1,
  peakVisualLayers: 2,
  peakMediaLayers: 2,
});
const estimates = (over: Partial<ExportEstimates> = {}): ExportEstimates => ({
  memoryBytes: 1e9,
  temporaryBytes: 1e8,
  finalBytes: 5e8,
  seconds: 600,
  ...over,
});
const reasonsOf = (
  seconds: number | null,
  over: Partial<ExportEstimates> = {},
  duration = HOUR,
): readonly ExportPreflightReason[] =>
  assessExport(workload(duration), resources, estimates({ seconds, ...over }), budgets).reasons;

describe("the hard warning reads the low end of the estimate", () => {
  it("an export whose central time is over the limit but whose low end is not is not blocked: it is only a long export", () => {
    const reasons = reasonsOf(10 * HOUR, { secondsLow: 5 * HOUR });
    expect(reasons).not.toContain("execution_limit");
    expect(reasons).toContain("long");
    const assessed = assessExport(
      workload(HOUR),
      resources,
      estimates({ seconds: 10 * HOUR, secondsLow: 5 * HOUR }),
      budgets,
    );
    expect(assessed.severity).toBe("notice");
  });

  it("an export whose low end is over the limit is a known problem, whatever else is said", () => {
    const assessed = assessExport(
      workload(HOUR),
      resources,
      estimates({ seconds: 12 * HOUR, secondsLow: LIMIT + 1 }),
      budgets,
    );
    expect(assessed.reasons).toContain("execution_limit");
    expect(assessed.severity).toBe("warning");
  });

  it("with no low end it is 0.27.0's rule: the central time decides", () => {
    expect(reasonsOf(10 * HOUR)).toContain("execution_limit");
    expect(reasonsOf(LIMIT)).not.toContain("execution_limit");
    expect(reasonsOf(LIMIT + 1)).toContain("execution_limit");
    expect(reasonsOf(10 * HOUR, { secondsLow: null })).toContain("execution_limit");
  });

  it("a low end that is not a time, or is above the central time, is not believed: the central time decides", () => {
    for (const secondsLow of [Number.NaN, -5, Number.POSITIVE_INFINITY, 11 * HOUR, undefined])
      expect(reasonsOf(10 * HOUR, { secondsLow }), String(secondsLow)).toContain("execution_limit");
    // and one that is a time at or under the central one is believed
    expect(reasonsOf(10 * HOUR, { secondsLow: 10 * HOUR })).toContain("execution_limit");
    expect(reasonsOf(10 * HOUR, { secondsLow: 7 * HOUR })).not.toContain("execution_limit");
  });

  it("the notices read the central value, not the low end", () => {
    // long: a central time of twenty minutes or more, even where the low end is a few minutes
    expect(reasonsOf(25 * 60, { secondsLow: 4 * 60 })).toContain("long");
    expect(reasonsOf(10 * 60, { secondsLow: 4 * 60 })).not.toContain("long");
    // slow: over twice the video, said only for a time that was measured (not guessed), from the central value
    expect(reasonsOf(900, { secondsLow: 100 }, 60)).toContain("slow");
    expect(reasonsOf(900, { secondsLow: 100, secondsGuessed: true }, 60)).not.toContain("slow");
  });

  it("no estimate is still 'the time is unknown', as before, and the low end cannot make one", () => {
    expect(reasonsOf(null)).toContain("time_unknown");
    expect(reasonsOf(null, { secondsLow: 5 })).toContain("time_unknown");
    expect(reasonsOf(null)).not.toContain("execution_limit");
  });

  it("execution_limit is raised exactly when the low end is over the limit, whatever the central time is (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40 * HOUR }),
        fc.integer({ min: 1, max: 40 * HOUR }),
        (a, b) => {
          const secondsLow = Math.min(a, b);
          const seconds = Math.max(a, b);
          const reasons = reasonsOf(seconds, { secondsLow });
          expect(reasons.includes("execution_limit")).toBe(secondsLow > LIMIT);
          // the warning can only be raised from a low end that is itself over the limit, so it never blocks more than 0.27.0's rule did
          if (reasons.includes("execution_limit")) expect(seconds > LIMIT).toBe(true);
        },
      ),
      { numRuns: 400 },
    );
  });
});
