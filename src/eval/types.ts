// Shared types for the model-eval harness. A "scenario" is a seeded project + a
// natural-language prompt + an expected outcome; the harness drives it through the
// REAL agent loop + REAL model, then scores it (oracle) and mines friction signals
// from the full trace. See src/eval/README-less note in docs/ARCHITECTURE.md §14.
import type { Timeline } from "../timeline/model";

/** Marker error for a tool the timeline-only harness didn't execute (the model
 *  reached beyond the timeline surface) — NOT a real tool failure or capability gap. */
export const HARNESS_UNAVAILABLE = "(eval) not available in the timeline-only harness";

/** One captured tool call in a scenario's trace. */
export interface ToolCall {
  round: number;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
  /** The tool's own reply, truncated. Without it a reader (or an LLM judge) can only
   *  see that a call succeeded, never WHAT it produced — so it cannot check the
   *  model's claims against the actual outcome. */
  result?: string;
  /** Serialized size of the FULL reply, before the truncation above. This is the only
   *  record of what a tool actually put back into the context — `usage.inputTokens` cannot
   *  answer it (a cached round bills differently), so without this the cost of a fat
   *  payload is invisible and payload shaping can only be guessed at. */
  resultChars?: number;
}

/** The full trace of one driven scenario (what the model did + what it cost). */
export interface Trace {
  toolCalls: ToolCall[];
  /** Reasoning snippets the model emitted across rounds (workaround detection). */
  reasoning: string[];
  rounds: number;
  finalText: string;
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number; costUsd: number };
  /** What the tools put back into the context across the whole scenario: total serialized
   *  characters, and the single fattest reply. Sizes payload shaping directly. */
  payload?: { resultChars: number; maxResultChars: number; maxResultTool: string };
}

/** Friction signals mined from the trace — fire EVEN when the task passes. */
export interface Signals {
  /** Every `{ ok:false }` / onToolError (tool, error, args). */
  toolErrors: { name: string; error: string; args: Record<string, unknown> }[];
  /** Same tool retried after a rejection (the t009 thrash pattern). */
  retryLoops: { name: string; attempts: number }[];
  /** Params the model TRIED that the contract doesn't declare (missing-feature
   *  backlog) — parsed from `unknown param(s) X. Allowed: ...` rejections. */
  expectedButUndeclared: { name: string; params: string[] }[];
  /** HEURISTIC (prose regex): reasoning snippets that smell like a workaround
   *  ("no tool for…", "manually"). Advisory only — read the trace. */
  workaroundSuspected: string[];
  /** Escape-hatch tools (scenario.flagTools) the model resorted to. */
  escapeHatchUsed: string[];
  /** Intent mismatch: expected tools never appeared (e.g. t006 `loop` vs `duration`). */
  wrongToolForIntent?: { expected: string[]; used: string[] };
  /** Invariant broken despite NO tool error — the nastiest class (t008 desync). */
  silentCorruption: string[];
  /** Took more rounds than the scenario budgets for a task this size. */
  inefficiency?: { rounds: number; maxRounds: number };
  /** HEURISTIC (prose regex — expect misses and false hits): the model told the user
   *  it made an edit, but no mutating tool call succeeded. A green-looking turn that
   *  changed nothing — worse than a loud failure, because the user only finds out
   *  when they look at the timeline. Read the trace before believing it. */
  claimedSuccessWithoutEdit?: { claim: string };
  /** Tools the model called that the timeline-only harness didn't execute (info,
   *  not a real error — the model reached beyond the timeline surface). */
  notRunInHarness: string[];
}

/** A tier's verdict. */
export interface TierResult {
  passed: boolean;
  violations: string[];
}

/** Everything one (scenario × model) run produced. */
export interface ScenarioResult {
  scenarioId: string;
  title: string;
  /** The natural-language order the model was given (for post-hoc grading). */
  prompt: string;
  tags: string[];
  model: string;
  /** Task success = Tier 0 (safety/validity) AND Tier 1 (did the thing). */
  passed: boolean;
  tier0: TierResult;
  tier1: TierResult;
  signals: Signals;
  trace: Trace;
  wallMs: number;
  /** Set only on a HARNESS failure (server unreachable, crash) — not a model miss. */
  harnessError?: string;
  /** True if skipped because the $ budget was exhausted. */
  skipped?: boolean;
}

/** A single eval scenario. */
export interface Scenario {
  /** Stable id (also the report key). */
  id: string;
  title: string;
  /** e.g. ["ripple", "regression:t008"]. */
  tags?: string[];
  /** The starting timeline (a fresh copy per run). */
  seed: () => Timeline;
  /** The natural-language order (NO tool/jargon hints — test what the model decides). */
  prompt: string;
  /** Tier 1: assert the expected geometry on the final timeline; throw on mismatch
   *  (use vitest `expect`). Omit for open-ended prompts (Tier 0 only). */
  expect?: (final: Timeline) => void;
  /** Intent: tools that SHOULD appear (absence ⇒ wrongToolForIntent signal). */
  expectTools?: string[];
  /** Intent: escape-hatch tools whose use signals a capability gap. */
  flagTools?: string[];
  /** Multi-turn: extra user messages sent SEQUENTIALLY after the first prompt
   *  completes, on the SAME session (timeline + provider continuity carry over).
   *  The grader runs on the FINAL timeline after all turns. */
  followUps?: string[];
  /** Which tool surface the harness registers. "timeline" (default) is the
   *  zero-spend timeline-only surface. "journey" additionally registers
   *  deterministic stand-ins for import / transcript / export so a multi-step
   *  WORKFLOW can be driven with no network, ffmpeg, or paid calls. "studio"
   *  widens that to the WHOLE non-timeline catalog (research, vision, generation,
   *  project lifecycle, library, inspection) under the same no-spend rule. */
  surface?: "timeline" | "journey" | "studio";
  /** Tier 1 for a workflow: assert on what the model DID — sequencing, the
   *  deliverable, no duplicated work — not just the final geometry. Throw on
   *  mismatch. Runs in addition to `expect`. */
  expectTrace?: (trace: Trace) => void;
  /** Inefficiency threshold (rounds). Default derived if omitted. */
  maxRounds?: number;
  /** Tool errors allowed before Tier 0 fails. DEFAULT 0 — a wasted call is itself a
   *  regression, since a model that guesses a value it cannot know still reaches the
   *  right end state and a final-state-only grader would score the bug green. Raise
   *  it only for a scenario that provokes an error ON PURPOSE (e.g. testing recovery
   *  from a deliberate refusal), which otherwise could never pass. */
  maxToolErrors?: number;
}
