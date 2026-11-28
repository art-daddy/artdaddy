// A case's correct run, replayed with no model (ruling 22 of the agent-evals decision): the real
// harness, agent loop, tools, stand-ins and oracle, with every model round answered from a script.
// A reference that passes proves the task can be done with the tools the case offers and that the
// case's checks accept the right result; scenarios.reference.test.ts holds every case to it, and
// scenarios.conformance.test.ts holds every case to failing a run that does nothing.
//
// Nothing here sends anything: the scripted model answers in-process. The tests that drive it also
// replace fetch with a spy that throws, so a tool that reached for the network would fail loudly.
import type { PendingCall, RoundResultDTO, Usage } from "../agent/types";
import { DEFAULT_MODEL } from "../store/chatControls";
import { driveScenario, type InferenceRequest } from "./harness";
import { Budget } from "./pricing";
import type { CampaignSetup } from "./setup";
import type { Scenario, ScenarioResult } from "./types";

/** The tool calls of one round, in order: [tool name, arguments]. */
export type ReferenceCalls = [string, Record<string, unknown>][];

/** One model round of a scripted run. A text step is the model's reply and ends the turn. A calls
 *  step asks for tools: a fixed list, or one computed from the request the model got, for an id an
 *  earlier tool minted (the request's `round_input.tool_results` carries the previous round's
 *  replies). `usage` overrides what the round reports it used. */
export type ReferenceStep =
  | { text: string; usage?: Usage }
  | { calls: ReferenceCalls | ((req: InferenceRequest) => ReferenceCalls); usage?: Usage };

/** What a scripted round reports it used unless its step says otherwise: a priced round, so the
 *  harness's budget guard accepts it (a round with tokens and no cost stops the campaign). */
export const SCRIPTED_USAGE: Usage & { cached_tokens: number } = {
  input_tokens: 1000,
  output_tokens: 50,
  cost_usd: 0.0002,
  cached_tokens: 800,
};

/** A model that answers from a script, one step per round, after `delayMs` of "thinking". A round
 *  past the end of the script gets an empty reply, which ends its turn; `requests` keeps every round
 *  the model was sent, so a caller can tell a script that ran short or long. */
export function scripted(steps: readonly ReferenceStep[], delayMs = 0) {
  let i = 0;
  const requests: InferenceRequest[] = [];
  const send = async (req: InferenceRequest): Promise<RoundResultDTO> => {
    requests.push(req);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const step = steps[i++] ?? { text: "" };
    const usage = step.usage ?? SCRIPTED_USAGE;
    if ("text" in step)
      return {
        kind: "text",
        pending_calls: [],
        final_text: step.text,
        error: "",
        finish_reason: "stop",
        usage,
        provider_snapshot: {},
      };
    const calls = typeof step.calls === "function" ? step.calls(req) : step.calls;
    const pending: PendingCall[] = calls.map(([name, args], k) => ({
      call_id: `c${i}_${k}`,
      name,
      arguments: args,
    }));
    return {
      kind: "tool_calls",
      pending_calls: pending,
      final_text: "",
      error: "",
      finish_reason: "tool_calls",
      usage,
      provider_snapshot: {},
    };
  };
  return { send, requests };
}

/** Where no server is: a scripted run never sends a round, and anything else that tried to reach
 *  this address could not resolve it. */
export const OFFLINE_SERVER = "http://offline.invalid";

export interface ScriptedDriveOpts {
  /** Where each run's throwaway project folder is made. */
  workDir: string;
  /** The spend cap the harness checks before each round (scripted rounds cost $0.0002). */
  budget?: Budget;
  /** Wait this long in each round, to give the clocks something to measure. */
  delayMs?: number;
  /** Recorded on the run as what it ran against. */
  setup?: CampaignSetup;
  /** The model id the run is recorded under (default: the app's default model). */
  model?: string;
}

/** Drive one case through the real harness with its model rounds answered from `steps`, offline.
 *  Returns the graded result and every request the scripted model was sent. A recovery case is
 *  refused: its harness asks a server for the tool list before the first round. */
export async function driveScripted(
  scenario: Scenario,
  steps: readonly ReferenceStep[],
  opts: ScriptedDriveOpts,
): Promise<{ result: ScenarioResult; requests: InferenceRequest[] }> {
  if (scenario.surface === "recovery")
    throw new Error(`${scenario.id}: a recovery case runs only in its own lane, with a server`);
  const { send, requests } = scripted(steps, opts.delayMs ?? 0);
  const result = await driveScenario(scenario, opts.model ?? DEFAULT_MODEL, {
    server: OFFLINE_SERVER,
    budget: opts.budget ?? new Budget(2),
    send,
    setup: opts.setup,
    workDir: opts.workDir,
  });
  return { result, requests };
}

/** Drive a case's own reference (its known-right run) through the real harness, offline. */
export async function driveReference(
  scenario: Scenario,
  opts: ScriptedDriveOpts,
): Promise<{ result: ScenarioResult; requests: InferenceRequest[] }> {
  if (!scenario.reference?.length) throw new Error(`${scenario.id} has no reference run`);
  return driveScripted(scenario, scenario.reference, opts);
}
