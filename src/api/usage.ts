// Client-side mirror of the caller's credit balance, for the readout + the
// "limit reached" UX. Metering is a server concern; this just reflects what the
// backend reports (via GET /usage) and any 402 it returns. A tiny external
// store (useSyncExternalStore-friendly) so the meter re-renders on change.
import { authHeaders } from "./auth";
import { apiBase } from "./config";
import { ArtDaddyError } from "../lib/errors";

export interface UsageState {
  metered: boolean;
  used: number;
  limit: number;
  remaining: number;
  over: boolean;
}

let state: UsageState = { metered: false, used: 0, limit: 0, remaining: 0, over: false };
const listeners = new Set<() => void>();

export function getUsage(): UsageState {
  return state;
}

export function subscribeUsage(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function set(next: Partial<UsageState>): void {
  const merged = { ...state, ...next };
  // Keep object identity stable when nothing changed (avoids useSyncExternalStore churn).
  if (
    merged.metered === state.metered &&
    merged.used === state.used &&
    merged.limit === state.limit &&
    merged.remaining === state.remaining &&
    merged.over === state.over
  ) {
    return;
  }
  state = merged;
  for (const fn of [...listeners]) fn();
}

/** Fetch the caller's credit balance. No-op visual when unmetered/unreachable. */
export async function refreshUsage(): Promise<void> {
  try {
    const res = await fetch(`${apiBase()}/usage`, { headers: await authHeaders() });
    if (!res.ok) return;
    const j = (await res.json()) as Partial<UsageState>;
    if (!j.metered) {
      set({ metered: false, over: false });
      return;
    }
    const limit = Number(j.limit ?? 0);
    const remaining = Number(j.remaining ?? 0);
    set({
      metered: true,
      used: Number(j.used ?? 0),
      limit,
      remaining,
      over: limit > 0 && remaining <= 0,
    });
  } catch {
    /* offline / unreachable — leave the last known balance */
  }
}

/** Reflect a 402 immediately, before the next refresh lands. */
export function markOverLimit(detail: unknown): void {
  const d = (detail && typeof detail === "object" ? detail : {}) as {
    used?: number;
    limit?: number;
    scope?: string;
  };
  set({
    metered: true,
    over: true,
    used: Number(d.used ?? state.used),
    limit: Number(d.limit ?? state.limit),
    remaining: 0,
  });
  // Reported HERE rather than at the three 402 call sites: ai.ts and both agent round senders
  // all funnel through this, so one of them growing a fourth caller cannot miss it. A hard stop
  // mid-project is indistinguishable from churn in the funnel otherwise -- the ledger knows, the
  // event stream did not.
  void import("./appEvents")
    .then((m) =>
      m.reportCreditsExhausted(
        `${d.scope ?? "user"} limit: ${Number(d.used ?? state.used)}/${Number(d.limit ?? state.limit)}`,
      ),
    )
    .catch(() => undefined);
}

/** Drop the balance when the identity goes away — a signed-out or revoked session
 *  must never keep showing the previous account's credits. */
export function clearUsage(): void {
  set({ metered: false, used: 0, limit: 0, remaining: 0, over: false });
  // A new identity gets a fresh wall; without this, the next account's first 402 is silent.
  void import("./appEvents").then((m) => m.resetCreditsExhausted()).catch(() => undefined);
}

/** Thrown by the request wrappers on an HTTP 402 (credit limit reached). */
export class CreditLimitError extends ArtDaddyError {
  readonly code = "credit_limit";
  readonly expected = true;
  detail: unknown;
  constructor(detail: unknown) {
    // `message` is what a tool result carries to the MODEL, so it has to say STOP. Without that
    // a model reads "limit reached" as this call failing and tries the next paid tool, which
    // cannot succeed either -- the same mistake the 401 path already paid for.
    super(
      "the credit limit is reached, so no paid call can succeed right now. Do NOT retry this or " +
        "any other paid tool — tell the user their credits are exhausted and stop.",
    );
    this.name = "CreditLimitError";
    this.detail = detail;
  }

  /** What a person sees; `message` is aimed at the model. */
  get userMessage(): string {
    return "You've reached your credit limit. It resets at the start of your next window.";
  }
}
