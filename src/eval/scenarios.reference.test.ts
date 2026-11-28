// Every case has a correct run (ruling 22 of the agent-evals decision). A case's `reference`, the
// known-right calls with one step per model round across every turn, is replayed through the real
// harness, agent loop, tools, stand-ins and oracle with no model and no network, and must pass:
// tier 0, tier 1 and harm all clean, every step used and no round asked for past the end. A
// reference that passes proves the task can be done with the tools the case offers and that its
// checks accept the right result ("a reference solution ... proves that the task is solvable and
// verifies graders are correctly configured", Anthropic's eval guide). The other half, that a run
// doing nothing fails, is in scenarios.conformance.test.ts.
//
// The recovery lane and the disabled cases are not in ALL_SCENARIOS, so not in scope here.
import { promises as fsp } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { driveReference, type ReferenceStep } from "./reference";
import { ALL_SCENARIOS } from "./scenarios";
import type { Scenario } from "./types";

/** Why each case still without a reference has none. Remove a case when its reference lands; never
 *  add one, because a new case carries its reference. */
const REPAIRING =
  "the eval-fix worker is repairing this case (28 Nov); its reference comes with the repair";
const NO_REFERENCE_YET: Readonly<Record<string, string>> = {
  make_it_pop: REPAIRING,
  color_warm: REPAIRING,
  insert_between: REPAIRING,
  boost_contrast: REPAIRING,
  export_redo_with_new_settings: REPAIRING,
  search_then_fetch: REPAIRING,
  generate_voiceover_and_place: REPAIRING,
  project_list_and_open: REPAIRING,
  library_tag_broll: REPAIRING,
};
const noReferenceYet = (id: string): boolean => Object.hasOwn(NO_REFERENCE_YET, id);

const WORK = path.resolve("reports", "eval", `reference-${process.pid}`);

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => {
    throw new Error("network blocked in the reference eval test");
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  expect(fetchSpy, "a reference run reached the network").not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
afterAll(() => fsp.rm(WORK, { recursive: true, force: true }));

/** Everything wrong with a case's reference when it is replayed; empty for a correct run. */
async function replayProblems(s: Scenario): Promise<string[]> {
  const steps = s.reference ?? [];
  if (steps.length === 0) return ["it has no reference"];
  const { result, requests } = await driveReference(s, { workDir: WORK });
  const problems = [
    ...(result.harnessError ? [`harness error: ${result.harnessError}`] : []),
    ...result.tier0.violations,
    ...result.tier1.violations,
    ...(result.harm?.violations ?? []),
  ];
  // Name the calls behind a tool-error violation, so the reference can be fixed from the report.
  if (result.tier0.violations.some((v) => /tool call\(s\) errored/.test(v)))
    for (const c of result.trace.toolCalls.filter((c) => !c.ok))
      problems.push(`${c.name} (round ${c.round}) failed: ${c.error ?? "no error text"}`);
  if (!result.passed && problems.length === 0) problems.push("the run did not pass");
  if (requests.length > steps.length)
    problems.push(
      `the run asked for ${requests.length} rounds and the reference has ${steps.length} steps: ` +
        "a turn did not end with a text step",
    );
  if (requests.length < steps.length)
    problems.push(
      `the reference has ${steps.length} steps and the run used ${requests.length}: ` +
        "a text step ended a turn early, or steps were left over",
    );
  return problems;
}

/** Why a case's inAppOnly reason is not one, or null when it is a sentence saying why. */
function inAppOnlyProblem(reason: unknown): string | null {
  if (reason === undefined) return null;
  if (typeof reason !== "string") return "inAppOnly is a reason, a sentence";
  if (reason.trim().split(/\s+/).filter(Boolean).length < 3)
    return `inAppOnly "${reason}" is not a sentence saying why the Copilot lane cannot run the case`;
  return null;
}

describe("every case has its correct run", () => {
  it("NO_REFERENCE_YET names only cases that exist and still have no reference", () => {
    const ids = new Set(ALL_SCENARIOS.map((s) => s.id));
    const gone = Object.keys(NO_REFERENCE_YET).filter((id) => !ids.has(id));
    expect(gone, "not a case any more: remove it from NO_REFERENCE_YET").toEqual([]);
    for (const [id, why] of Object.entries(NO_REFERENCE_YET))
      expect(why.trim().split(/\s+/).length, `${id}: give the reason it has none`).toBeGreaterThan(
        2,
      );
    const done = ALL_SCENARIOS.filter((s) => noReferenceYet(s.id) && s.reference);
    expect(
      done.map((s) => s.id),
      "has a reference now: remove it from NO_REFERENCE_YET",
    ).toEqual([]);
  });

  it("every other case has a reference", () => {
    const missing = ALL_SCENARIOS.filter((s) => !noReferenceYet(s.id) && !s.reference?.length).map(
      (s) => s.id,
    );
    expect(missing, "a case needs its correct run (ruling 22)").toEqual([]);
  });

  it("an inAppOnly reason is a sentence saying why", () => {
    const bad = ALL_SCENARIOS.flatMap((s) => {
      const problem = inAppOnlyProblem(s.inAppOnly);
      return problem ? [`${s.id}: ${problem}`] : [];
    });
    expect(bad).toEqual([]);
  });
});

describe("each case's correct run passes the real harness, offline", () => {
  for (const s of ALL_SCENARIOS) {
    if (noReferenceYet(s.id)) {
      it.todo(`${s.id}: no reference yet, ${NO_REFERENCE_YET[s.id]}`);
      continue;
    }
    it(s.id, async () => {
      expect(await replayProblems(s)).toEqual([]);
    });
  }
});

// The checks above must be able to fail: each is shown failing on a broken reference or reason.
describe("the replay and the reason checks can fail", () => {
  const base = ALL_SCENARIOS.find((s) => s.id === "remove_last")!;
  const remove: ReferenceStep = { calls: [["remove_clips", { clip_ids: ["c"] }]] };
  const withRef = (reference: ReferenceStep[]): Scenario => ({ ...base, reference });

  it("passes the known-right run", async () => {
    expect(await replayProblems(withRef([remove, { text: "Removed the last clip." }]))).toEqual([]);
  });

  it("fails a run that does nothing", async () => {
    expect((await replayProblems(withRef([{ text: "Done." }]))).join("\n")).toMatch(/^tier1/m);
  });

  it("fails a run that removes the wrong clip", async () => {
    const wrong: ReferenceStep = { calls: [["remove_clips", { clip_ids: ["a"] }]] };
    const problems = await replayProblems(withRef([wrong, { text: "Removed it." }]));
    expect(problems.join("\n")).toMatch(/^tier1/m);
  });

  it("fails a reference whose turn does not end with a reply", async () => {
    expect((await replayProblems(withRef([remove]))).join("\n")).toMatch(
      /did not end with a text step/,
    );
  });

  it("fails a reference with steps left over", async () => {
    const extra = [remove, { text: "Removed." }, { text: "Anything else?" }];
    expect((await replayProblems(withRef(extra))).join("\n")).toMatch(/left over/);
  });

  it("refuses an inAppOnly reason that is empty or not a sentence", () => {
    for (const reason of ["", "   ", "yes", "copilot lane", 1])
      expect(inAppOnlyProblem(reason), String(reason)).not.toBeNull();
    expect(inAppOnlyProblem("The Copilot lane cannot stop a turn half-way.")).toBeNull();
    expect(inAppOnlyProblem(undefined)).toBeNull();
  });
});
