// Builders for a case's correct run (Scenario.reference, replayed by ../reference.ts): one step per
// model round, a text step ending each turn. Imports are type-only, so a scenario file that uses
// these loads nothing of the harness.
import type { InferenceRequest } from "../harness";
import type { ReferenceCalls, ReferenceStep } from "../reference";

/** A round that asks for one tool. */
export const call = (name: string, args: Record<string, unknown> = {}): ReferenceStep => ({
  calls: [[name, args]],
});

/** A round that asks for several tools at once (reads run together, edits one after another). */
export const calls = (...list: ReferenceCalls): ReferenceStep => ({ calls: list });

/** The reply that ends a turn. */
export const say = (text: string): ReferenceStep => ({ text });

/** Read the timeline: how a model learns the clip ids, positions and frame rate it acts on. */
export const READ_TIMELINE: ReferenceStep = call("get_timeline");

/** The replies this round carries back from the tool named `name`, in call order. */
export function repliesTo(req: InferenceRequest, name: string): Record<string, unknown>[] {
  return (req.round_input.tool_results ?? [])
    .filter((r) => r.name === name)
    .map((r) => (r.result ?? {}) as Record<string, unknown>);
}

/** The clips a get_timeline reply in this round lists, each with its track's id. */
export function timelineClipsIn(
  req: InferenceRequest,
): { id: string; track: string; kind?: string; media_ref?: string }[] {
  return repliesTo(req, "get_timeline").flatMap((r) => {
    const tracks = ((r.timeline as { tracks?: unknown[] } | undefined)?.tracks ?? []) as {
      id: string;
      clips?: { id: string; kind?: string; media_ref?: string }[];
    }[];
    return tracks.flatMap((t) => (t.clips ?? []).map((c) => ({ ...c, track: t.id })));
  });
}
