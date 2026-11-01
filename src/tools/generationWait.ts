// How long a generation in flight has left, for a caller that will not be told when it lands.
//
// An outside agent (MCP) cannot be woken: nothing resumes a turn that has ended. Told only "it is
// still generating", one session asked again every three seconds, 243 times. So the answer carries
// what a caller can act on: about how long is left, and the soonest it is worth asking again.
//
// The figures are what generations took in the field (voice-over and music 40 to 85 s, video one
// to fifteen minutes) and are a guide, not a promise: a job past its usual time is reported as
// slow, with a wider gap before the next check, rather than given a smaller and smaller number.

export interface PendingGeneration {
  /** The library kind: "image", "audio" or "video". Anything else is treated as unknown. */
  kind?: string;
  /** When the job was registered, in epoch SECONDS (the catalog's `added_at`). */
  added_at?: number;
}

export interface GenerationWait {
  /** About how many seconds are left. */
  eta_s: number;
  /** The soonest it is worth asking again. */
  retry_after_s: number;
  /** True once the job has run past its usual time. */
  slow: boolean;
}

/** Usual seconds from request to landed file, by kind. A Map, not an object: a kind such as
 *  "constructor" must not find a property every object has. */
const TYPICAL_S: ReadonlyMap<string, number> = new Map([
  ["image", 20],
  ["audio", 60],
  ["video", 180],
]);
const UNKNOWN_KIND_S = 90;

export const MIN_ETA_S = 10;
export const MIN_RETRY_S = 10;
export const MAX_RETRY_S = 60;
/** What a slow job is promised: at least this long, whatever its kind. */
const SLOW_ETA_S = 60;

function roundTo5(n: number): number {
  return Math.round(n / 5) * 5;
}

export function generationWait(g: PendingGeneration, nowMs: number): GenerationWait {
  const typical = TYPICAL_S.get(String(g.kind ?? "")) ?? UNKNOWN_KIND_S;
  const added = Number(g.added_at);
  const elapsed =
    Number.isFinite(added) && added > 0 && Number.isFinite(nowMs)
      ? Math.max(0, nowMs / 1000 - added)
      : 0;
  const slow = elapsed > typical;
  const eta = slow
    ? Math.max(SLOW_ETA_S, Math.round(typical / 2))
    : Math.max(MIN_ETA_S, typical - elapsed);
  const etaRounded = Math.max(MIN_ETA_S, roundTo5(eta));
  const retry = Math.min(MAX_RETRY_S, Math.max(MIN_RETRY_S, roundTo5(etaRounded / 2)));
  return { eta_s: etaRounded, retry_after_s: retry, slow };
}
