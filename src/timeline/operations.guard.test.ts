// Drift guard: a timeline RULE may only live in operations.ts.
//
// The trim divergence this phase fixed was two modules each owning a copy of one rule. Tests could
// not catch it because each copy passed its own tests; only a comparison would have. This asserts
// the structural property instead — the mutating helpers are reachable from ONE module, so a second
// copy of a rule cannot be written without this failing.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(process.cwd(), "src", "timeline");

/** Helpers that RESTRUCTURE the timeline. Anything calling these is expressing a rule. */
const MUTATORS = [
  "appendMediaClip",
  "clearRegion",
  "dragLinkPartners",
  "insertClipClone",
  "rippleDeleteRange",
  "rippleOpenGap",
  "splitClipAt",
];

/** Modules allowed to hold a rule: `operations.ts` is the vocabulary, `helpers.ts` defines the
 *  mutators themselves. Nothing else — the migration is complete, so this list is EMPTY and must
 *  stay that way. An entry here is a decision to write a rule outside the one place rules live. */
const NOT_YET_MIGRATED: string[] = [];

const sourceFiles = (): string[] =>
  readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.includes(".test."));

/** Source with comments removed — a mutator NAMED in prose is not a rule. */
const codeOf = (file: string): string =>
  readFileSync(join(DIR, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("operations.ts owns every timeline rule", () => {
  it("no tool module calls a timeline mutator directly", () => {
    const allowed = new Set(["operations.ts", "helpers.ts", ...NOT_YET_MIGRATED]);
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (allowed.has(file)) continue;
      const src = codeOf(file);
      const hits = MUTATORS.filter((m) => new RegExp(`\\b${m}\\s*\\(`).test(src));
      if (hits.length) offenders.push(`${file}: ${hits.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the exemption list is empty and stays empty", () => {
    // Every timeline rule now lives in operations.ts. Re-adding a name here would license a second
    // copy of a rule — the exact defect this phase removed.
    expect(NOT_YET_MIGRATED).toEqual([]);
  });

  it("operations.ts stays pure: no tool context, no await, no lock", () => {
    // Comments stripped: the file's own header names these words to forbid them.
    const src = readFileSync(join(DIR, "operations.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    // An await here would hold the mutation lease across I/O and stall every other edit; a tool
    // context would let a rule reach the network or disk from inside the commit.
    expect(src).not.toMatch(/\bawait\b/);
    expect(src).not.toMatch(/ClientToolContext/);
    expect(src).not.toMatch(/ctxApplyOp|runGesture|applyOp/);
  });
});
