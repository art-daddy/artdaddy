// Cost accounting + the $ budget guard. The server computes `usage.cost_usd` per
// round (llm_metrics.estimate_cost_usd); we accumulate it and stop the run before
// it blows the cap. The pricing table is a FALLBACK for when a round omits cost_usd
// (mirrors the server's llm_metrics._PRICING for the two eval models).
import type { Usage } from "../agent/types";

/** USD per 1M tokens (fallback only; server-provided cost_usd wins). */
export const PRICING: Record<string, { inPerM: number; outPerM: number }> = {
  "gpt-5.4-pro": { inPerM: 15.0, outPerM: 60.0 },
  "gpt-5.4": { inPerM: 5.0, outPerM: 20.0 },
  "gpt-5.4-mini": { inPerM: 0.25, outPerM: 2.0 },
  "gpt-5.4-nano": { inPerM: 0.05, outPerM: 0.4 },
};

function rates(model: string): { inPerM: number; outPerM: number } | null {
  if (PRICING[model]) return PRICING[model];
  const prefix = Object.keys(PRICING).find((k) => model.startsWith(k));
  return prefix ? PRICING[prefix] : null;
}

/** Cost of one round: prefer the server's `cost_usd`, else estimate from tokens. */
export function costFromUsage(model: string, usage: Usage | undefined): number {
  if (!usage) return 0;
  if (typeof usage.cost_usd === "number" && usage.cost_usd > 0) return usage.cost_usd;
  const r = rates(model);
  if (!r) return 0;
  const inTok = usage.input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  return (inTok / 1_000_000) * r.inPerM + (outTok / 1_000_000) * r.outPerM;
}

/** A running spend tracker with a hard cap. The runner checks `exceeded()` before
 *  each scenario and stops (skips the rest) so a run can't overshoot the budget. */
export class Budget {
  private spent = 0;
  constructor(readonly capUsd: number) {}

  add(usd: number): void {
    if (Number.isFinite(usd) && usd > 0) this.spent += usd;
  }
  get total(): number {
    return this.spent;
  }
  get remaining(): number {
    return Math.max(0, this.capUsd - this.spent);
  }
  exceeded(): boolean {
    return this.spent >= this.capUsd;
  }
}
