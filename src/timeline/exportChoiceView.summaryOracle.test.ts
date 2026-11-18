// The line under the door against an oracle written only from the decision text (each clause only where it is true of the SHOWN values), over a table of projects and every pick the lists offer, for
// both choices. Nothing here calls `quickSettings`, `quickDefaultSize` or `summaryWords`: the rungs, the presets' short sides and the whole-number rate the render works at are written out.
import { describe, expect, it } from "vitest";

import {
  projectFacts,
  rateEntriesFor,
  resolveChoice,
  sizeOptions,
  summaryFor,
  type Choice,
  type Overrides,
} from "./exportChoiceView";

const RUNGS = [2160, 1080, 720, 480];
const PRESET_SHORT: Record<string, number> = {
  "2160p": 2160,
  "1440p": 1440,
  "1080p": 1080,
  "720p": 720,
  "480p": 480,
};
const WORD = { high: "High", medium: "Medium", low: "Low" } as const;

/** The decision text, as code: every clause only where it is true of the values that will be sent. */
function oracle(
  project: { w: number; h: number; fps: number },
  shown: { resolution: string; fps: number | null; quality: "high" | "medium" | "low" },
): string {
  const short = Math.min(project.w, project.h);
  const below = Math.max(0, ...RUNGS.filter((rung) => rung < short));
  const shownShort = shown.resolution === "source" ? short : PRESET_SHORT[shown.resolution];
  // The render cuts the project's rate to a whole number; a shown rate is delivered as it is.
  const delivered = shown.fps ?? Math.trunc(project.fps);
  const clauses: string[] = [];
  if (shown.resolution === "source" && shown.fps === null)
    clauses.push("Project size and frame rate");
  if (below > 0 && shown.resolution !== "source" && shownShort === below)
    clauses.push("One size smaller");
  if (project.fps > 30 && delivered <= 30) clauses.push("up to 30 frames a second");
  clauses.push(`${WORD[shown.quality]} quality`);
  const line = clauses.join(", ");
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}.`;
}

const SIZES: [number, number][] = [
  [1920, 1080],
  [1080, 1920],
  [3840, 2160],
  [4096, 2160],
  [2560, 1440],
  [1280, 720],
  [854, 480],
  [640, 360],
  [7680, 4320],
  [1366, 768],
  [800, 450],
  [1920, 1088],
];
const RATES = [
  12, 18, 23.976, 24, 25, 29.97, 30, 30.5, 31, 32, 48, 50, 59.94, 60, 64, 72, 90, 100, 120, 144,
];
const QUALITIES = ["high", "medium", "low"] as const;

describe("the line under the door against an oracle from the decision text", () => {
  it("agrees for every project and every pick the lists offer, for both choices", () => {
    let compared = 0;
    const misses: string[] = [];
    for (const [w, h] of SIZES)
      for (const fps of RATES) {
        const facts = projectFacts({ width: w, height: h, fps }, 120);
        expect(facts).not.toBeNull();
        const sizes = sizeOptions(facts);
        const rates = rateEntriesFor(facts, true).map((entry) => entry.value);
        for (const choice of ["quality", "fast"] as Choice[]) {
          const picks: Overrides[] = [{}];
          for (const resolution of sizes)
            for (const rate of rates)
              for (const quality of QUALITIES) picks.push({ resolution, fps: rate, quality });
          // single-lever picks too: the other two stay the choice's own
          for (const resolution of sizes) picks.push({ resolution });
          for (const rate of rates) picks.push({ fps: rate });
          for (const quality of QUALITIES) picks.push({ quality });
          for (const overrides of picks) {
            const { shown } = resolveChoice(choice, overrides, facts);
            const expected = oracle({ w, h, fps }, shown);
            const got = summaryFor(shown, facts);
            compared += 1;
            if (got !== expected && misses.length < 15)
              misses.push(
                `${w}x${h}@${fps} ${choice} ${JSON.stringify(overrides)} shown=${JSON.stringify(shown)} got="${got}" want="${expected}"`,
              );
          }
        }
      }
    // the table is big enough that "compared" cannot be zero by accident
    expect(compared).toBeGreaterThan(20000);
    expect(misses).toEqual([]);
  });
});
