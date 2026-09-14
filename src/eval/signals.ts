// Trace analyzer — mines "friction signals" from a scenario's trace. These fire
// EVEN WHEN THE TASK PASSES, so a green scenario can still surface a capability gap
// (a failed call the model recovered from, a param the model expected but the
// contract doesn't declare, a workaround, or silent timeline corruption).
//
// Two tiers of confidence, and they are NOT interchangeable:
//   STRUCTURAL (toolErrors, retryLoops, expectedButUndeclared, escapeHatchUsed,
//     wrongToolForIntent, silentCorruption, inefficiency) — derived from what the
//     trace factually contains. Trust these.
//   HEURISTIC (workaroundSuspected, claimedSuccessWithoutEdit) — regexes over prose
//     the model wrote. They MISS phrasings nobody anticipated and FIRE on innocent
//     ones. Treat a hit as "go read this trace", never as a verdict, and don't gate
//     anything on them. `utils/eval_judge.py` in the backend repo grades the same two
//     questions with a model, which is more capable and equally fallible.
import { isMutationEffect, toolEffect } from "../contract/effects";
import {
  HARNESS_UNAVAILABLE as HARNESS_MARK,
  type Scenario,
  type Signals,
  type Trace,
} from "./types";

/** Low-level escape hatches whose use for an edit task hints at a missing tool. */
const DEFAULT_ESCAPE_HATCHES = ["run_ffmpeg", "run_ffprobe"];

/** Reasoning phrases that specifically smell like routing around a capability gap
 *  (tightened to avoid benign "there's no selected clip" / "can't tell" chatter). */
const WORKAROUND_RE =
  /\bno (dedicated |built-in )?tool\b|\bwithout a tool\b|\bthere('?s| is) no (tool|way|option|param|parameter|method|api)\b|\bmanually\b|\bwork ?around\b|\bfall ?back\b|\bdoesn('?t| not)? (support|expose|allow|have)\b|\bnot supported\b|\bhad to\b/i;

/** Pull the param list out of a `unknown param(s) a, b. Allowed: ...` rejection. */
function parseUnknownParams(error: string): string[] {
  const m = /unknown param\(s\)\s+(.+?)\.\s*Allowed:/i.exec(error);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Past-tense assertions that an edit LANDED. Deliberately narrow: a plan ("I will
 *  trim") or a question is not a claim. */
const SUCCESS_CLAIM_RE =
  /\b(done|i(?:'ve| have)\s+\w+|(?:added|removed|deleted|trimmed|split|moved|changed|set|applied|updated|resized|renamed|muted|adjusted|created|placed|inserted|cut|graded|exported)\b)/i;

/** Phrases that make a past-tense verb NOT a success claim: a refusal, or a
 *  correct report that nothing needed doing. */
const NON_CLAIM_RE =
  /\b(could ?n('?t| ot)|can ?not|can't|unable|failed|no changes? (were |was )?(needed|required|made)|already (set|at|is)|nothing to (change|do)|would you like|should i|do you want)\b/i;

const isMutatingTool = (name: string): boolean => {
  const effect = toolEffect(name);
  return effect !== undefined && isMutationEffect(effect);
};

/** Analyze a completed trace against a scenario's intent + the Tier-0 verdict. */
export function analyzeTrace(scenario: Scenario, trace: Trace, tier0Violations: string[]): Signals {
  const calls = trace.toolCalls;
  const used = new Set(calls.map((c) => c.name));

  // Tools the harness couldn't run (timeline-only surface) are info, not errors.
  const notRunInHarness = [
    ...new Set(calls.filter((c) => c.error === HARNESS_MARK).map((c) => c.name)),
  ];

  const toolErrors = calls
    .filter((c) => !c.ok && c.error !== HARNESS_MARK)
    .map((c) => ({ name: c.name, error: c.error ?? "", args: c.args }));

  // Retry loops: a tool called ≥2× with at least one failure among the attempts.
  const byName = new Map<string, { total: number; fails: number }>();
  for (const c of calls) {
    if (c.error === HARNESS_MARK) continue;
    const e = byName.get(c.name) ?? { total: 0, fails: 0 };
    e.total += 1;
    if (!c.ok) e.fails += 1;
    byName.set(c.name, e);
  }
  const retryLoops = [...byName.entries()]
    .filter(([, e]) => e.total >= 2 && e.fails >= 1)
    .map(([name, e]) => ({ name, attempts: e.total }));

  // Missing-feature backlog: params the model tried that the contract rejected.
  const undeclared = new Map<string, Set<string>>();
  for (const te of toolErrors) {
    const params = parseUnknownParams(te.error);
    if (!params.length) continue;
    const set = undeclared.get(te.name) ?? new Set<string>();
    for (const p of params) set.add(p);
    undeclared.set(te.name, set);
  }
  const expectedButUndeclared = [...undeclared.entries()].map(([name, ps]) => ({
    name,
    params: [...ps],
  }));

  // Workaround smells in the reasoning.
  const workaroundSuspected = [
    ...new Set(
      trace.reasoning.filter((r) => WORKAROUND_RE.test(r)).map((r) => r.trim().slice(0, 240)),
    ),
  ].slice(0, 8);

  // Escape-hatch tools used (scenario-declared ∪ defaults).
  const hatches = new Set([...(scenario.flagTools ?? []), ...DEFAULT_ESCAPE_HATCHES]);
  const escapeHatchUsed = [...used].filter((n) => hatches.has(n));

  // Wrong tool for intent: none of the expected tools appeared.
  let wrongToolForIntent: Signals["wrongToolForIntent"];
  if (scenario.expectTools?.length) {
    const hit = scenario.expectTools.some((t) => used.has(t));
    if (!hit) wrongToolForIntent = { expected: scenario.expectTools, used: [...used] };
  }

  // Silent corruption: an invariant broke although NO tool reported an error.
  const silentCorruption =
    toolErrors.length === 0
      ? tier0Violations.filter((v) => /^(validate|render|scene|invariant):/i.test(v))
      : [];

  // Inefficiency: more rounds than budgeted for a task this size.
  const maxRounds = scenario.maxRounds ?? 12;
  const inefficiency = trace.rounds > maxRounds ? { rounds: trace.rounds, maxRounds } : undefined;

  // Claimed an edit it never landed. Only fires when the model asserts a COMPLETED
  // change in the past tense; "nothing to change" / "I couldn't" are not claims.
  const editLanded = calls.some((c) => c.ok && isMutatingTool(c.name));
  const claim = (trace.finalText ?? "").trim();
  const claimedSuccessWithoutEdit =
    !editLanded && SUCCESS_CLAIM_RE.test(claim) && !NON_CLAIM_RE.test(claim)
      ? { claim: claim.slice(0, 240) }
      : undefined;

  return {
    toolErrors,
    retryLoops,
    expectedButUndeclared,
    workaroundSuspected,
    escapeHatchUsed,
    wrongToolForIntent,
    silentCorruption,
    inefficiency,
    claimedSuccessWithoutEdit,
    notRunInHarness,
  };
}

/** True if the trace carries ANY friction worth a human's attention. */
export function hasFriction(s: Signals): boolean {
  return Boolean(
    s.toolErrors.length ||
    s.retryLoops.length ||
    s.expectedButUndeclared.length ||
    s.workaroundSuspected.length ||
    s.escapeHatchUsed.length ||
    s.wrongToolForIntent ||
    s.silentCorruption.length ||
    s.inefficiency ||
    s.claimedSuccessWithoutEdit,
  );
}
