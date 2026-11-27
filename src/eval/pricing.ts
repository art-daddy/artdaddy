// Cost accounting + the $ budget guard. The server prices every round itself (`usage.cost_usd`,
// from its own rate card) and that receipt is the only price this rig uses. It keeps no copy of
// vendor prices: a copy drifts (the one that lived here knew none of the models the picker offers
// today, so it priced every one of their rounds at zero), and vendor prices do not belong in this
// public repository. A round that used tokens and carries no cost is UNKNOWN, not free: the budget
// cannot bound what it cannot count, so the run stops on it.
import type { Usage } from "../agent/types";

/** A campaign's spend cap, in USD, when nothing sets one. */
export const DEFAULT_CAP_USD = 2;

/** Cost of one round from the server's receipt. Null when the round used tokens but reported no
 *  cost, which the caller must treat as a reason to stop, never as zero. */
export function costFromUsage(usage: Usage | undefined): number | null {
  if (!usage) return 0;
  const cost = usage.cost_usd;
  if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) return cost;
  const used = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
  return used > 0 ? null : 0;
}

/** A running spend tracker with a hard cap. The runner checks `exceeded()` before
 *  each scenario and stops (skips the rest) so a run can't overshoot the budget. */
export class Budget {
  private spent = 0;
  private stopReason: string | null = null;
  constructor(readonly capUsd: number) {}

  startRound(): void {
    if (this.stopReason) throw new Error(`eval stopped before a model round: ${this.stopReason}`);
    if (this.exceeded()) throw new Error("eval budget exhausted before model round");
  }

  add(usd: number): void {
    if (Number.isFinite(usd) && usd > 0) this.spent += usd;
  }

  /** Stop the campaign for good: something was spent that the budget cannot count. */
  stop(reason: string): void {
    this.stopReason ??= reason;
  }

  get stopped(): string | null {
    return this.stopReason;
  }
  get total(): number {
    return this.spent;
  }
  get remaining(): number {
    return Math.max(0, this.capUsd - this.spent);
  }
  exceeded(): boolean {
    return this.stopReason !== null || this.spent >= this.capUsd;
  }
}
