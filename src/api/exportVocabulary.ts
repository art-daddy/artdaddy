// WHAT HAPPENED to an export, as a report carries it: an ordered list of states (`trace`) and a few
// run facts. Every list here is the server's (`export_trace.py`), word for word; a server test reads
// this file and fails when they differ, so a code added on one side cannot go missing on the other.
// The server is TOLERANT of this part (a malformed piece is dropped, the report is stored), which is
// why the lists are pinned by a test and not by a refusal.
//
// No imports on purpose: the recorder that builds a trace (timeline/exportTrace.ts) and the report that
// sends it (exportEvents.ts) both use this file, and neither should pull the other's dependencies in.
export const EXPORT_TRACE_EVENTS = [
  "requested",
  "queued",
  "dequeued",
  "plan_chosen",
  "chip_test",
  "mode_shown",
  "mode_selected",
  "dialog_shown",
  "dialog_choice",
  "answer_ignored",
  "stage",
  "heartbeat_gap",
  "guard_tripped",
  "stall_detected",
  "retry",
  "chip_failed",
  "verify_failed",
  "cancelled",
  "outcome",
  "interrupted_found",
] as const;
export const EXPORT_TRACE_VALUES = [
  "menu",
  "chat",
  "mcp",
  "other",
  "confirm",
  "b1",
  "b2",
  "b3",
  "c1",
  "c2",
  "c3",
  "c4",
  "c5",
  "c6",
  "c7",
  "a3",
  "continue",
  "start_anyway",
  "cancel",
  "browse",
  "try_again",
  "report",
  "relink",
  "dismiss",
  "export_again",
  "timeout",
  "queued",
  "preparing",
  "rendering",
  "encoding",
  "checking",
  "saving",
  "frozen",
  "spinning",
  "slow_start",
  "resident",
  "commit",
  "scratch",
  "clock",
  "ceiling",
  "pc_floor",
  "os_refusal",
  "person_dialog",
  "person_card",
  "person_queue",
  "assistant",
  "app",
  "done",
  "failed",
  "cancelled",
  "blocked",
  "declined",
  "normal",
  "gentle",
  "gentlest",
  "chip",
  "ok",
  "refused",
] as const;
export const EXPORT_ENGINES = ["one_pass", "streamed"] as const;
export const EXPORT_LIMITS = ["resident", "commit", "scratch", "clock", "os", "other"] as const;
export const EXPORT_STARTERS = ["chat", "elsewhere"] as const;
/** The run facts and the largest value the server keeps of each (memory in MiB or GiB, time in s). */
export const EXPORT_FACT_LIMITS = {
  peak_resident_mib: 1_048_576,
  peak_commit_mib: 1_048_576,
  resident_limit_mib: 1_048_576,
  commit_limit_mib: 1_048_576,
  ram_total_gib: 4_096,
  ram_free_gib: 4_096,
  longest_gap_s: 86_400,
} as const;
/** The most events one report carries (the server keeps the first this many). */
export const EXPORT_TRACE_MAX_EVENTS = 30;
export type ExportTraceEvent = (typeof EXPORT_TRACE_EVENTS)[number];
export type ExportTraceValue = (typeof EXPORT_TRACE_VALUES)[number];
export type ExportEngine = (typeof EXPORT_ENGINES)[number];
export type ExportLimit = (typeof EXPORT_LIMITS)[number];
export type ExportStarter = (typeof EXPORT_STARTERS)[number];
export type ExportFact = keyof typeof EXPORT_FACT_LIMITS;

/** One state an export went through: what (`e`), when in ms since the request (`t`), and at most one
 *  code (`v`) and two small numbers (`n`, `m`) saying which and how much. Never a name or a path. */
export interface TraceEvent {
  e: ExportTraceEvent;
  t: number;
  v: ExportTraceValue | "";
  n: number;
  m: number;
}

const TRACE_TIME_MAX = 7 * 86_400_000;
const TRACE_FACT_MAX = 2_147_483_647;
/** Where a trace is kept while a report waits in the outbox (flat bodies only): a compact text,
 *  `e:t:v:n:m` joined by `;`. Its own bound, because it is the one value larger than an ordinary field. */
export const MAX_TRACE_TEXT = 2_400;

function wholeNumber(value: unknown, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
  return Math.max(0, Math.min(n, max));
}

/** The well-formed events of `value`, in order, at most EXPORT_TRACE_MAX_EVENTS: the same cleaning the
 *  server applies, so what is sent is what will be kept. */
export function cleanTrace(value: unknown): TraceEvent[] {
  if (!Array.isArray(value)) return [];
  const out: TraceEvent[] = [];
  for (const item of value.slice(0, EXPORT_TRACE_MAX_EVENTS * 2)) {
    if (typeof item !== "object" || item === null) continue;
    const raw = item as Record<string, unknown>;
    if (!(EXPORT_TRACE_EVENTS as readonly unknown[]).includes(raw.e)) continue;
    const v = (EXPORT_TRACE_VALUES as readonly unknown[]).includes(raw.v)
      ? (raw.v as ExportTraceValue)
      : "";
    out.push({
      e: raw.e as ExportTraceEvent,
      t: wholeNumber(raw.t, TRACE_TIME_MAX),
      v,
      n: wholeNumber(raw.n, TRACE_FACT_MAX),
      m: wholeNumber(raw.m, TRACE_FACT_MAX),
    });
    if (out.length >= EXPORT_TRACE_MAX_EVENTS) break;
  }
  return out;
}

export function encodeTrace(events: readonly TraceEvent[]): string {
  return cleanTrace(events)
    .map((ev) => `${ev.e}:${ev.t}:${ev.v}:${ev.n}:${ev.m}`)
    .join(";");
}

/** The inverse of {@link encodeTrace}, tolerant of anything: text that is not a trace gives none. */
export function decodeTrace(text: unknown): TraceEvent[] {
  if (typeof text !== "string" || !text || text.length > MAX_TRACE_TEXT) return [];
  return cleanTrace(
    text
      .split(";")
      .slice(0, EXPORT_TRACE_MAX_EVENTS * 2)
      .map((part) => {
        const [e, t, v, n, m] = part.split(":");
        return { e, t: Number(t), v, n: Number(n), m: Number(m) };
      }),
  );
}
