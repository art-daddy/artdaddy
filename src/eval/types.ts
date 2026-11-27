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
  expectedFailure?: boolean;
  /** Which user turn issued the call: 0 for the prompt, 1.. for each follow-up. */
  turn?: number;
  /** When the tool started, in ms from the start of the run, and how long it ran. */
  startMs?: number;
  ms?: number;
}

/** What one run was set up with: everything a before/after comparison must hold equal, or
 *  name as the thing that changed. A field the run could not learn is null, never guessed. */
export interface RunSetup {
  /** The model id the run asked for (the server may serve another one under it). */
  model: string;
  effort: string;
  mode: string;
  /** The compiled tool catalog the app sent (`catalog_id`). */
  catalogId: string;
  /** The `app_version` the app sent. */
  appVersion: string;
  /** The commit the client code ran from, and whether its working tree had local changes. */
  appGitSha: string | null;
  appGitDirty: boolean | null;
  server: string | null;
  /** What the server's /health reported: its version and the commit its image was built from. */
  serverVersion: string | null;
  serverBuild: string | null;
  /** sha256 of the base system prompt the server reports (GET /contract/instructions). It is
   *  not the exact text a round ran under: the provider's strict-null line and any per-project
   *  style or workflow layer are added per round, and the server reports no per-round prompt
   *  version. Null when the server did not answer. */
  promptSha256: string | null;
  /** The first message carried the project state (ARTDADDY_EVAL_PRELOAD=1). */
  preload: boolean;
}

/** One model round: how long the model took, and how long the tools it asked for took. */
export interface RoundClock {
  round: number;
  turn: number;
  /** Request sent to the whole round answered (the harness's /inference is not streamed). */
  modelMs: number;
  /** Wall time the round's tools ran (parallel calls count once). */
  toolMs: number;
  tools: number;
  /** Time to the first token: null, because /inference answers the whole round at once. */
  firstTokenMs: number | null;
  /** The round named a model the server did not price, or reported no cost. */
  costKnown: boolean;
}

export interface RunClocks {
  rounds: RoundClock[];
  modelMs: number;
  toolMs: number;
  /** Why there is no first-token time (the transport, not a missing measurement). */
  firstTokenNote: string;
}

/** Kinds a new clip can have, for an {@link EditScope}. */
export type ClipKindName = "video" | "image" | "audio" | "text";

/** What a case's request may change on its seed. Declared, a change outside it FAILS the run
 *  (collateral), and a clip outside `remove` that disappears counts towards mass destruction.
 *  Undeclared, the run's diff is only recorded. */
export interface EditScope {
  /** Seed clips the request may change in any way, position included. */
  change?: readonly string[];
  /** Seed clips the request may remove. */
  remove?: readonly string[];
  /** Kinds of new clip the request may add (a split piece is a new clip too). */
  add?: readonly ClipKindName[];
  /** Seed tracks whose own settings may change, or that may be removed. */
  tracks?: readonly string[];
  addTracks?: boolean;
  /** Canvas fields the request may change. */
  canvas?: readonly string[];
  /** The request asks to delete library media. */
  deleteMedia?: boolean;
}

/** The words a case's stand-in says are spoken in one source: [text, start, end) in SOURCE
 *  seconds, the unit of a media_ref. */
export interface CaseTranscript {
  media_ref: string;
  words: readonly (readonly [string, number, number])[];
}

export interface ClipRef {
  id: string;
  track: string;
  kind: string;
  media_ref?: string;
}

/** The seed and the final timeline compared: the code's view of what the run changed. Clip
 *  fields are compared with defaults left out (timeline/shape.ts compactClip), so a tool that
 *  writes `speed: 1` has changed nothing. */
export interface TimelineDiff {
  canvas: string[];
  tracksAdded: string[];
  tracksRemoved: string[];
  tracksChanged: { id: string; fields: string[] }[];
  clipsAdded: ClipRef[];
  clipsRemoved: ClipRef[];
  clipsChanged: (ClipRef & { fields: string[] })[];
  /** Other top-level timeline fields that changed (recorded, never graded). */
  other: string[];
}

export type CheckId =
  | "paid_tool"
  | "forbidden_tool"
  | "mass_destructive"
  | "collateral"
  | "craft_main_track_gap"
  | "craft_tiny_clip"
  | "craft_cut_in_word"
  | "craft_caption_drift";

/** One check's verdict on a run. `fail` fails the run; `warn` is a signal to read the trace,
 *  never a verdict; `skip` means the check had nothing to judge. */
export interface CheckResult {
  id: CheckId;
  verdict: "pass" | "warn" | "fail" | "skip";
  details: string[];
}

export type RecoveryCase =
  | "native_success"
  | "bad_destination"
  | "platform_limit"
  | "repeated_failure"
  | "mixed_parts"
  | "many_parts"
  | "both_fail"
  | "queued_failure";

export interface RecoveryEvidence {
  timelineUnchanged: boolean;
  inputFilesUnchanged: boolean;
  artifacts: {
    mediaRef: string;
    filename: string;
    path: string;
    sha256: string;
    durationS: number;
    problems: string[];
  }[];
  expectedFailures: number;
  unexpectedFailures: number;
  sources: { filename: string; sha256: string }[];
  violations: string[];
}

/** The full trace of one driven scenario (what the model did + what it cost). */
export interface Trace {
  toolCalls: ToolCall[];
  /** Reasoning snippets the model emitted across rounds (workaround detection). */
  reasoning: string[];
  rounds: number;
  stopReason?: "round_limit";
  finalText: string;
  turnTexts?: string[];
  /** What the run cost. `cachedTokens` and `credits` only when the server reported them
   *  (at the time of writing /inference returns cached tokens and no credits); `costUnknownRounds`
   *  counts rounds that used tokens but carried no cost. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    costUsd: number;
    cachedTokens?: number;
    credits?: number | null;
    costUnknownRounds?: number;
  };
  /** The first message carried the project state the app read for the model (agent/stateBlock.ts). */
  stateBlock?: boolean;
  /** What the tools put back into the context across the whole scenario: total serialized
   *  characters, and the single fattest reply. Sizes payload shaping directly. */
  payload?: { resultChars: number; maxResultChars: number; maxResultTool: string };
  recovery?: RecoveryEvidence;
  /** What the run was set up with, and where its time went. */
  setup?: RunSetup;
  clocks?: RunClocks;
  /** The seed against the final timeline, and every check's verdict: the code's own view of
   *  the edit, so a judge reading the trace does not have to infer it from the tool calls. */
  diff?: TimelineDiff;
  checks?: CheckResult[];
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
  /** Task success = Tier 0 (safety/validity) AND Tier 1 (did the thing) AND harm (no unasked
   *  paid call, no mass deletion, nothing changed outside a declared scope). */
  passed: boolean;
  tier0: TierResult;
  tier1: TierResult;
  /** Absent on results written before the harm checks existed. */
  harm?: TierResult;
  signals: Signals;
  trace: Trace;
  wallMs: number;
  /** The scenario's known, unfixed failure when it ran (see Scenario.knownFailure). */
  knownFailure?: string;
  /** Set only on a HARNESS failure (server unreachable, crash) — not a model miss. */
  harnessError?: string;
  /** True if skipped because the $ budget was exhausted. */
  skipped?: boolean;
}

/** How a run reads in a report. A failing case marked as a known failure is not a regression;
 *  the first run where it passes says "fixed", so the mark can be removed. */
export type RunStatus = "pass" | "fail" | "known_failure" | "fixed" | "skipped" | "harness_error";

/** A single eval scenario. */
interface ScenarioBase {
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
  /** Tier 1 for a workflow: assert on what the model DID — sequencing, the
   *  deliverable, no duplicated work — not just the final geometry. Throw on
   *  mismatch. Runs in addition to `expect`. `final` is the timeline as the run ended, for a
   *  check that needs both (which clip holds a file is only in the trace when the app names
   *  media by their bytes); absent where a test grades the trace alone. */
  expectTrace?: (trace: Trace, final?: Timeline) => void;
  /** Inefficiency threshold (rounds). Default derived if omitted. */
  maxRounds?: number;
  /** Tool errors allowed before Tier 0 fails. DEFAULT 0 — a wasted call is itself a
   *  regression, since a model that guesses a value it cannot know still reaches the
   *  right end state and a final-state-only grader would score the bug green. Raise
   *  it only for a scenario that provokes an error ON PURPOSE (e.g. testing recovery
   *  from a deliberate refusal), which otherwise could never pass. */
  maxToolErrors?: number;
  /** Paid tools (checks.ts EVAL_PAID_TOOLS) the request asks for or plainly needs. A call to any
   *  other paid tool fails the run: the user did not ask to be billed for it. */
  paidTools?: readonly string[];
  /** Tools this case must not call at all (a cheaper path exists, or the user said not to). */
  mustNotCall?: readonly string[];
  /** What the request may change. Declared, anything else changed fails the run. */
  scope?: EditScope;
  /** What is spoken in a source the case places, for the craft checks on cuts and captions. */
  transcript?: CaseTranscript;
  /** A known failure with no fix yet: the backlog item that tracks it, as "owner/repo#N" (for
   *  example "art-daddy/backlog#93"). While the case fails, a report lists it as a known failure,
   *  not a regression; the first run where it passes reports it as fixed, and then this field
   *  is removed. How real users' failed turns enter the set before their fix lands. */
  knownFailure?: string;
}

export type Scenario = ScenarioBase &
  (
    | { surface?: "timeline" | "journey" | "studio"; recovery?: never }
    | { surface: "recovery"; recovery: RecoveryCase }
  );
