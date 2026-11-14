// The one place the route decision, the Export dialog and the chat question get the honest estimates of every way an export could run. The estimate side (the
// estimator, this PC's measured pace, the pace log, the project's cost shape) registers a provider once at start-up; nothing here imports it, so the route code
// and the estimate code are built and tested apart. No provider, a throwing one or a garbled answer means "no estimate for that way": the export is never held up
// by an estimate.
import {
  ESTIMATE_BASES,
  type EncoderFamily,
  type HonestEstimate,
  type RouteEstimates,
  type RouteEstimatesRequest,
} from "./exportTypes3c";

export type RouteEstimatesProvider = (
  request: RouteEstimatesRequest,
) => Partial<Record<keyof RouteEstimates, unknown>> | null | undefined;

const FAMILIES: readonly EncoderFamily[] = ["processor", "chip"];
const NONE: RouteEstimates = Object.freeze({
  standard: null,
  quick: null,
  chip: null,
  faster: null,
});

let provider: RouteEstimatesProvider | null = null;

/** The estimate side registers itself here once; `null` removes it. */
export function setRouteEstimatesProvider(next: RouteEstimatesProvider | null): void {
  provider = next;
}

const wholeSeconds = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 10 * 365 * 86_400;

/** One estimate, or null when anything about it is not what the estimator promises (whole seconds, `low <= seconds <= high`, a known basis and family). */
function sane(value: unknown): HonestEstimate | null {
  if (!value || typeof value !== "object") return null;
  const e = value as Partial<HonestEstimate>;
  if (!wholeSeconds(e.seconds) || !wholeSeconds(e.low) || !wholeSeconds(e.high)) return null;
  if (e.low > e.seconds || e.seconds > e.high) return null;
  if (!ESTIMATE_BASES.includes(e.basis as never) || !FAMILIES.includes(e.family as never))
    return null;
  if (typeof e.muchLonger !== "boolean") return null;
  if (
    e.bytes !== null &&
    !(typeof e.bytes === "number" && Number.isFinite(e.bytes) && e.bytes >= 0)
  )
    return null;
  return {
    seconds: e.seconds,
    low: e.low,
    high: e.high,
    basis: e.basis!,
    bytes: e.bytes ?? null,
    muchLonger: e.muchLonger,
    family: e.family!,
  };
}

/** The honest estimate of each way, never throwing. Each way is judged on its own: one garbled estimate does not take the others with it. */
export function routeEstimatesNow(request: RouteEstimatesRequest): RouteEstimates {
  if (!provider) return NONE;
  try {
    const got = provider(request);
    if (!got || typeof got !== "object") return NONE;
    return {
      standard: sane(got.standard),
      quick: sane(got.quick),
      chip: sane(got.chip),
      faster: sane(got.faster),
    };
  } catch {
    return NONE;
  }
}

export function __resetRouteEstimatesProvider(): void {
  provider = null;
}
