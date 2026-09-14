// The oracle — scores a finished scenario. Tier 0 = the RESULT is safe/valid
// (validates, compiles to a render plan + preview scene without NaN, no tool
// errored); Tier 1 = the model actually did the specific thing the prompt asked
// (the scenario's expected geometry). Task success = Tier 0 AND Tier 1.
import { buildScene } from "../preview/scene";
import { timelineInvariantViolations } from "../timeline/invariants";
import { buildRenderCommand } from "../timeline/render";
import type { Timeline } from "../timeline/model";
import { validateTimeline } from "../timeline/validate";
import { HARNESS_UNAVAILABLE, type Scenario, type TierResult, type Trace } from "./types";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Deep check: no NaN/Infinity leaked into any number of a value. */
function allFinite(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(allFinite);
  if (v && typeof v === "object")
    return Object.values(v as Record<string, unknown>).every(allFinite);
  return true;
}

function clipEndFrames(tl: Timeline): number {
  const ends: number[] = [];
  const tracks = Array.isArray(tl?.tracks) ? tl.tracks : [];
  for (const t of tracks) {
    const clips = Array.isArray(t?.clips) ? t.clips : [];
    for (const c of clips) ends.push(Number((c as Record<string, unknown>)?.timeline_out) || 0);
  }
  return ends.length ? Math.max(0, ...ends) : 0;
}

/** Tier 0 — result safety/validity (drives `passed` alongside Tier 1). */
export function evalTier0(final: Timeline, trace: Trace, maxToolErrors = 0): TierResult {
  const violations: string[] = [];

  for (const e of validateTimeline(final)) violations.push(`validate: ${e}`);

  try {
    const plan = buildRenderCommand(final, "out.mp4");
    if (!Number.isFinite(plan.duration)) violations.push("render: non-finite plan.duration");
    if (
      /NaN|Infinity/.test(
        `${plan.filterComplex} ${plan.args.join(" ")} ${plan.assFiles.map((f) => f.content).join(" ")}`,
      )
    ) {
      violations.push("render: NaN/Infinity in the ffmpeg command");
    }
  } catch (e) {
    violations.push(`render: buildRenderCommand threw — ${msg(e)}`);
  }

  try {
    const fps = Number(final.canvas?.fps) || 30;
    const endF = clipEndFrames(final);
    for (const f of new Set([0, Math.floor(endF / 2), Math.max(0, endF - 1)])) {
      if (!allFinite(buildScene(final, f / fps, new Map()))) {
        violations.push("scene: non-finite coordinate in the preview scene");
        break;
      }
    }
  } catch (e) {
    violations.push(`scene: buildScene threw — ${msg(e)}`);
  }

  // Deep invariants (shared with invariants.property.test.ts): a linked-A/V desync
  // (t008), overlap, out-of-bounds knob, etc. that still PASSES validateTimeline is
  // silent corruption — this is what makes every eval scenario a corruption detector.
  for (const v of timelineInvariantViolations(final)) violations.push(`invariant: ${v}`);

  // Harness-unavailable calls (non-timeline tools the model reached for) are NOT
  // real failures — don't let them fail Tier 0 or fake a silent-corruption signal.
  // A tool error is a failure by DEFAULT, but not every error is the model's fault:
  // a scenario that exists to test RECOVERY from a deliberate refusal must be able
  // to allow the refusal it provokes. That is what maxToolErrors buys, and it is the
  // ONLY knob — an implicit floor here plus a second budget elsewhere is two rules
  // for one thing, and it made the refusal scenario unpassable by construction.
  const failed = trace.toolCalls.filter((c) => !c.ok && c.error !== HARNESS_UNAVAILABLE).length;
  if (failed > maxToolErrors)
    violations.push(`invariant: ${failed} tool call(s) errored (budget ${maxToolErrors})`);

  return { passed: violations.length === 0, violations };
}

/** Tier 1 — did the model do the specific thing? Runs the scenario's assertion.
 *  A workflow scenario may ALSO assert on the trace (sequencing / deliverable). */
export function evalTier1(scenario: Scenario, final: Timeline, trace?: Trace): TierResult {
  const violations: string[] = [];
  if (scenario.expect) {
    try {
      scenario.expect(final);
    } catch (e) {
      violations.push(`tier1: ${msg(e)}`);
    }
  }
  if (scenario.expectTrace && trace) {
    try {
      scenario.expectTrace(trace);
    } catch (e) {
      violations.push(`tier1(trace): ${msg(e)}`);
    }
  }
  return { passed: violations.length === 0, violations };
}
