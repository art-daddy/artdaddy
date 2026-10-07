// UJ-028: what the model has seen of the timeline, and when to tell it that picture is stale.
//
// The document counts the timeline changes the in-app agent did not make (ProjectDocument.
// externalTimelineEdits). Within one document session that count is exact; across sessions (a
// reopen, an app restart) it starts again from zero, so the first message of a session compares
// content instead: the timeline now against the one the last kept turn ended on.
import type { Timeline } from "../timeline/model";

/** One reading of the open document: its session, and its outside-edit count at that moment. */
export interface DocReading {
  docSession: string;
  epoch: number;
}

export class TimelineAwareness {
  /** The outside edits the model's input already accounts for, in one document session. */
  private seen: DocReading | null = null;
  /** The count when a whole-timeline read began in the current round: it showed everything before. */
  private readFrom: number | null = null;

  /** Forget the in-session baseline, so the next message compares content: a project opened, or
   *  the chat rewrote the model's history (undo, redo, restore). */
  reset(): void {
    this.seen = null;
    this.readFrom = null;
  }

  /** A new message is about to be sent. `changedSinceLastTurn` is asked only when this session has
   *  no baseline yet; it compares the timeline now with the one the last kept turn ended on. */
  async atTurnStart(
    doc: DocReading | null,
    changedSinceLastTurn: () => Promise<boolean>,
  ): Promise<boolean> {
    if (!doc) return false;
    const inSession = this.seen !== null && this.seen.docSession === doc.docSession;
    const changed = inSession ? doc.epoch > this.seen!.epoch : await changedSinceLastTurn();
    this.seen = doc;
    this.readFrom = null;
    return changed;
  }

  /** The agent read the whole timeline, and the read began at `doc`. */
  sawWholeTimeline(doc: DocReading): void {
    if (this.seen?.docSession !== doc.docSession) return;
    this.readFrom = Math.max(this.readFrom ?? doc.epoch, doc.epoch);
  }

  /** A round returning tool outputs is about to be sent (also after a Continue or approval pause). */
  atToolRound(doc: DocReading | null): boolean {
    if (!doc) return false;
    const seen = this.seen;
    const readFrom = this.readFrom;
    this.seen = doc;
    this.readFrom = null;
    if (!seen || seen.docSession !== doc.docSession) return false;
    return doc.epoch > seen.epoch && !(readFrom !== null && readFrom >= doc.epoch);
  }
}

/** True when two timelines hold the same edit. Key order and the defaults every load fills in
 *  (`units`, track `z` by position) do not count as differences. */
export function sameTimeline(
  a: Timeline | null | undefined,
  b: Timeline | null | undefined,
): boolean {
  if (!a || !b) return false;
  return canonicalJson(withDefaults(a)) === canonicalJson(withDefaults(b));
}

function withDefaults(t: Timeline): Timeline {
  const c = JSON.parse(JSON.stringify(t)) as Timeline;
  if (c.units === undefined) c.units = "frames";
  (c.tracks ?? []).forEach((track, i) => {
    if (track && typeof track === "object" && track.z === undefined) track.z = i;
  });
  return c;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([x], [y]) =>
            x < y ? -1 : x > y ? 1 : 0,
          ),
        )
      : v,
  );
}
