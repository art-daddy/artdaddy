// What a generation may cost, asked of the server before the user approves it (UJ-047). The server answers with the credits
// the same call would hold (POST /ai/{name}/quote: no ledger access, no vendor call) and the approval bar shows it as
// "Up to N credits".
//
// A quote is advice beside the Allow button, so it never throws and never blocks: anything but a clear price is "no price".
// It is not a paid call (paidCallWhere ignores it), so a failed quote never reaches a problem report.
import type { HoldInputs } from "../tools/holdInputs";
import { authedFetch } from "./auth";
import { apiBase } from "./config";

export interface GenerationQuote {
  credits: number;
}

export async function quoteHold(
  inputs: HoldInputs,
  signal?: AbortSignal,
): Promise<GenerationQuote | null> {
  try {
    const res = await authedFetch(`${apiBase()}/ai/${inputs.proxy}/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: inputs.args }),
      signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { priced?: unknown; credits?: unknown } | null;
    const credits = body?.credits;
    return body?.priced === true &&
      typeof credits === "number" &&
      Number.isFinite(credits) &&
      credits > 0
      ? { credits }
      : null;
  } catch {
    return null;
  }
}
